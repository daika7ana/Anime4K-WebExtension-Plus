import type { Dimensions, EnhancementEffect, RendererOptions } from '@/types';
import { RendererInitializationError, RendererRuntimeError } from '@core/errors';
import { yieldToMain } from '@core/utils/yield-utils';
import * as GPUDeviceManager from '@core/gpu/gpu-device-manager';
import { buildEffectPipelines, paramsEqual, PipelineWithDestroy } from '@core/gpu/pipeline-builder';
import fullscreenTexturedQuadWGSL from '@shaders/fullscreen-textured-quad.wgsl';
import sampleExternalTextureWGSL from '@shaders/sample-external-texture.wgsl';

/**
 * The Renderer class encapsulates all WebGPU-related rendering logic.
 * It manages the GPU device, context, rendering pipelines, textures, and the render loop.
 *
 * GPU device lifecycle is delegated to GPUDeviceManager
 * and pipeline construction is delegated to PipelineBuilder.
 */
export class Renderer {
  // --- Core properties ---
  private video: HTMLVideoElement;
  private canvas: HTMLCanvasElement;
  private effects: EnhancementEffect[];
  private targetDimensions: Dimensions;
  private onError?: (error: Error) => void;
  private onFirstFrameRendered?: () => void;
  private onProgress?: (stage: string | null, current?: number, total?: number) => void;

  // --- State flags ---
  private destroyed = false;
  private animationFrameId: number | null = null;
  /** Whether to use ImageBitmap as a fallback for copying video frames */
  private useImageBitmapFallback = false;
  /** Whether a recovery attempt has already been made in the current render loop */
  private fixAttempted = false;
  private lastError: Error | null = null;
  /** Whether the device is currently recovering (auto-recovery after device loss) */
  private isRecovering = false;
  /** Prevents overlapping frame processing in the render loop */
  private frameInFlight = false;
  /** Pending bitmap from the previous frame in the ImageBitmap fallback (awaiting close) */
  private pendingBitmap: ImageBitmap | null = null;
  /** Whether pipeline rebuild is in progress (skip frames during rebuild) */
  private rebuilding = false;
  /** Whether a source resize is in progress (prevent concurrent resizes) */
  private resizing = false;

  // --- WebGPU objects ---
  private device!: GPUDevice;
  private context!: GPUCanvasContext;
  private presentationFormat!: GPUTextureFormat;
  /** Intermediate texture used to copy image data from video frames */
  private videoFrameTexture!: GPUTexture;
  /** Effect processing pipeline chain */
  private pipelines: PipelineWithDestroy[] = [];
  /** Generation counter to prevent concurrent buildPipelines() calls from clobbering each other */
  private buildGeneration = 0;

  // --- Objects for the final rendering stage ---
  private renderBindGroupLayout!: GPUBindGroupLayout;
  private renderPipeline!: GPURenderPipeline;
  private sampler!: GPUSampler;
  private renderBindGroup!: GPUBindGroup;

  // --- Static backward-compat alias (delegates to GPUDeviceManager) ---
  /** @deprecated Use GPUDeviceManager.preWarmGPU() directly. Kept for backward compatibility. */
  public static preWarmGPU = GPUDeviceManager.preWarmGPU;

  private constructor(options: RendererOptions) {
    this.video = options.video;
    this.canvas = options.canvas;
    this.effects = options.effects;
    this.targetDimensions = options.targetDimensions;
    this.onError = options.onError;
    this.onFirstFrameRendered = options.onFirstFrameRendered;
    this.onProgress = options.onProgress;
  }

  /**
   * Creates and asynchronously initializes a new Renderer instance.
   * This is the preferred method for instantiating a Renderer.
   * @param options - Configuration needed to initialize the renderer
   * @returns A Promise that resolves to a fully initialized Renderer instance
   */
  public static async create(options: RendererOptions): Promise<Renderer> {
    const renderer = new Renderer(options);
    await renderer.initialize();
    return renderer;
  }

  /**
   * Initializes the WebGPU device, context, and all necessary rendering resources.
   */
  private async initialize(): Promise<void> {
    try {
      // Wait for video data to finish loading
      if (this.video.readyState < this.video.HAVE_FUTURE_DATA) {
        await new Promise<void>((resolve) => {
          this.video.addEventListener('loadeddata', () => resolve(), { once: true });
        });
      }

      // Request GPU adapter and set power preference based on platform
      // Use pre-warmed adapter/device if available (pre-requested on content script load)
      this.onProgress?.(chrome.i18n.getMessage('initGpu') || '⏳ Initializing GPU...');

      const claimedDevice = GPUDeviceManager.claimPreWarmedDevice();
      if (claimedDevice) {
        this.device = claimedDevice;
      } else {
        const { device } = await GPUDeviceManager.requestGPUDevice();
        this.device = device;
      }

      // Listen for device loss events and attempt automatic recovery
      this.device.lost.then((info) => {
        // If the renderer has already been destroyed, no action needed
        if (this.destroyed) return;

        console.warn(`[Anime4KWebExt] GPU device lost: ${info.reason} - ${info.message}`);

        // Attempt automatic recovery (only when not intentionally destroyed)
        if (info.reason !== 'destroyed' && !this.isRecovering) {
          console.log('[Anime4KWebExt] Attempting to recover from device loss...');
          this.recoverFromDeviceLoss();
        }
      });

      // Detect whether direct texture copy from VideoFrame is supported (test on current device to avoid creating redundant devices)
      this.useImageBitmapFallback = !await this.detectVideoFrameSupport();
      if (this.useImageBitmapFallback) {
        console.log('[Anime4KWebExt] Renderer: Using ImageBitmap fallback for copying video frames.');
      }

      this.context = this.canvas.getContext('webgpu')!;
      if (!this.context) {
        throw new RendererInitializationError('Failed to get WebGPU context from canvas.');
      }
      this.presentationFormat = navigator.gpu.getPreferredCanvasFormat();
      this.context.configure({
        device: this.device,
        format: this.presentationFormat,
        alphaMode: 'premultiplied',
      });

      // Create initial resources
      this.createResources();
      await this.buildPipelines();
      await this.createRenderPipeline();
      this.createRenderBindGroup();

      // Start render loop: attempt to render the first frame and begin continuous rendering
      this.renderFirstFrameAndStartLoop();
    } catch (error) {
      if (error instanceof RendererInitializationError) {
        throw error;
      }
      throw new RendererInitializationError('An unexpected error occurred during renderer initialization.', { cause: error as Error });
    }
  }

  /**
   * Creates the GPU resources needed for processing, primarily the texture for receiving video frames.
   * This method is called to recreate the texture when the video source resolution changes.
   */
  private createResources(): void {
    this.videoFrameTexture?.destroy(); // Destroy old texture
    this.videoFrameTexture = this.device.createTexture({
      size: [this.video.videoWidth, this.video.videoHeight, 1],
      format: 'rgba8unorm', // 8-bit unnormalized format, matches video frame precision and saves bandwidth
      usage:
        GPUTextureUsage.TEXTURE_BINDING | // Can be used as shader input
        GPUTextureUsage.COPY_DST |        // Can be used as copy destination
        GPUTextureUsage.RENDER_ATTACHMENT, // Can be used as render target
    });
  }

  /**
   * Builds Anime4K processing pipelines based on the current effect chain (this.effects).
   * Delegates to PipelineBuilder for the actual construction.
   * Sets rebuilding flag to prevent processFrame() from using stale pipelines.
   */
  private async buildPipelines(): Promise<void> {
    const generation = ++this.buildGeneration;
    this.rebuilding = true; // Prevent render loop from processing frames during rebuild
    const oldPipelines = this.pipelines;
    this.pipelines = []; // Clear reference before builder destroys old pipelines
    try {
      const pipelines = await buildEffectPipelines({
        device: this.device,
        videoFrameTexture: this.videoFrameTexture,
        video: this.video,
        targetDimensions: this.targetDimensions,
        effects: this.effects,
        oldPipelines, // Pass captured reference, not this.pipelines
        preWarmer: GPUDeviceManager.getPreWarmer(),
        onProgress: this.onProgress,
        isStale: () => this.buildGeneration !== generation,
      });
      if (this.buildGeneration !== generation) return; // Superseded
      this.pipelines = pipelines;
    } finally {
      this.rebuilding = false; // Allow render loop to resume
    }
  }

  /**
   * Detects whether direct texture copy from VideoFrame is supported on the current GPU device.
   * Reuses the already-created device to avoid creating redundant GPU adapters/devices.
   */
  private async detectVideoFrameSupport(): Promise<boolean> {
    try {
      const offscreenCanvas = new OffscreenCanvas(1, 1);
      const ctx = offscreenCanvas.getContext('2d');
      if (!ctx) return false;
      ctx.fillRect(0, 0, 1, 1);
      const frame = new VideoFrame(offscreenCanvas, { timestamp: 0 });
      const testTexture = this.device.createTexture({
        size: [1, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.device.queue.copyExternalImageToTexture({ source: frame }, { texture: testTexture }, [1, 1]);
      frame.close();
      testTexture.destroy();
      console.log('[Anime4KWebExt] VideoFrame as texture source is SUPPORTED.');
      return true;
    } catch {
      console.log('[Anime4KWebExt] VideoFrame as texture source is NOT SUPPORTED, using ImageBitmap fallback.');
      return false;
    }
  }

  /**
   * Creates the final render pipeline, which is responsible for drawing the processed texture onto the Canvas.
   */
  private async createRenderPipeline(): Promise<void> {
    // Define bind group layout describing the resources required by the shader
    this.renderBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} }, // Sampler
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} }, // Input texture
      ],
    });

    // Create render pipeline asynchronously for better performance
    this.renderPipeline = await this.device.createRenderPipelineAsync({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.renderBindGroupLayout] }),
      vertex: {
        module: this.device.createShaderModule({ code: fullscreenTexturedQuadWGSL }),
        entryPoint: 'vert_main',
      },
      fragment: {
        module: this.device.createShaderModule({ code: sampleExternalTextureWGSL }),
        entryPoint: 'main',
        targets: [{ format: this.presentationFormat }],
      },
      primitive: { topology: 'triangle-list' },
    });

    this.sampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  }

  /**
   * Creates the render bind group, which binds actual resources (sampler and final texture) to the render pipeline.
   */
  private createRenderBindGroup(): void {
    this.renderBindGroup = this.device.createBindGroup({
      layout: this.renderBindGroupLayout,
      entries: [
        { binding: 1, resource: this.sampler },
        // Get the output texture of the last pipeline in the effect chain as input for final rendering
        { binding: 2, resource: this.pipelines.at(-1)!.getOutputTexture().createView() },
      ],
    });
  }

  /**
   * Core logic for processing a single frame.
   * Skips processing when pipeline rebuild or source resize is in progress.
   * @returns {boolean} Returns true if a frame was successfully rendered, false otherwise.
   */
  private async processFrame(): Promise<boolean> {
    if (this.destroyed) return false;
    if (this.isRecovering) return false;
    if (this.rebuilding) return false; // Skip frames during pipeline rebuild
    if (this.resizing) return false; // Skip frames during resize

    try {
      if (this.video.readyState < this.video.HAVE_CURRENT_DATA) {
        return false; // Video not ready, skip this frame
      }

      // Check if resolution has changed
      if (this.video.videoWidth !== this.videoFrameTexture.width || this.video.videoHeight !== this.videoFrameTexture.height) {
        console.log(`[Anime4KWebExt] Resolution changed: ${this.videoFrameTexture.width}x${this.videoFrameTexture.height} -> ${this.video.videoWidth}x${this.video.videoHeight}`);
        this.handleSourceResize();
        return false; // Resolution changed, skip rendering this frame and wait for the next
      }

      // Copy video frame to texture
      if (this.useImageBitmapFallback) {
        // Use ImageBitmap fallback (for compatibility with browsers like Firefox that don't support direct video copy)
        // Close the previous frame's bitmap (GPU copy for current frame is complete)
        if (this.pendingBitmap) {
          this.pendingBitmap.close();
          this.pendingBitmap = null;
        }
        this.pendingBitmap = await createImageBitmap(this.video);
        this.device.queue.copyExternalImageToTexture(
          { source: this.pendingBitmap },
          { texture: this.videoFrameTexture },
          [this.video.videoWidth, this.video.videoHeight]
        );
        // Don't close immediately — wait until the next frame to ensure the GPU has finished reading
      } else {
        this.device.queue.copyExternalImageToTexture(
          { source: this.video },
          { texture: this.videoFrameTexture },
          [this.video.videoWidth, this.video.videoHeight]
        );
      }



      const commandEncoder = this.device.createCommandEncoder();
      this.pipelines.forEach((pipeline) => pipeline.pass(commandEncoder));
      const passEncoder = commandEncoder.beginRenderPass({
        colorAttachments: [{
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
      });
      passEncoder.setPipeline(this.renderPipeline);
      passEncoder.setBindGroup(0, this.renderBindGroup);
      passEncoder.draw(6);
      passEncoder.end();
      this.device.queue.submit([commandEncoder.finish()]);

      return true; // Successfully rendered

    } catch (error) {
      console.error('[Anime4KWebExt] Frame processing failed:', error);

      // Check if this is a recoverable size mismatch error
      if (error instanceof Error && error.name === 'OperationError' && error.message.includes('out of bounds')) {
        // This is a potentially recoverable error
        this.lastError = new RendererRuntimeError('Texture copy failed due to size mismatch.', { cause: error, recoverable: true });
          // Only attempt recovery on the first try
        if (!this.fixAttempted) {
          console.warn('[Anime4KWebExt] Caught out-of-bounds error. Attempting to recover by resizing resources...');
          this.handleSourceResize();
        }
      } else {
        // For all other errors, treat as unrecoverable and include the original error message
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.lastError = new RendererRuntimeError(`Frame processing failed: ${errorMessage}`, { cause: error as Error });
      }
      // Return false to let the render loop decide the next action
      return false;
    }
  }

  /**
   * Attempts to render the first frame. On success, invokes the callback and switches to the regular render loop.
   * If unsuccessful (e.g., video is paused), reschedules itself.
   */
  private renderFirstFrameAndStartLoop = async (): Promise<void> => {
    if (this.destroyed) return;

    if (await this.processFrame()) {
      // First frame rendered successfully
      this.onFirstFrameRendered?.();
      this.fixAttempted = false;
      this.lastError = null;
      // Switch to the regular render loop
      this.animationFrameId = this.video.requestVideoFrameCallback(this.renderLoop);
    } else {
      // First frame rendering failed or was skipped
      const error = this.lastError;
      if (error) {
        // This is a real error
        if (error instanceof RendererRuntimeError && error.recoverable && !this.fixAttempted) {
          this.fixAttempted = true; // Mark that recovery has been attempted
          console.log('[Anime4KWebExt] Retrying first frame render after recovery attempt...');
        } else {
          console.error('[Anime4KWebExt] Unrecoverable error on first frame. Destroying renderer.');
          if (this.onError) this.onError(error);
          this.destroy();
          return; // Stop
        }
      } else {
        // If there's no error, it's a benign frame skip (e.g., resolution change); just retry
        console.log('[Anime4KWebExt] First frame skipped (e.g. resolution change), retrying...');
      }

      if (!this.destroyed) {
        this.animationFrameId = this.video.requestVideoFrameCallback(this.renderFirstFrameAndStartLoop);
      }
    }
  };

  /**
   * Regular render loop, handling all frames after the first.
   * Uses the frameInFlight guard to prevent overlapping frame processing and avoid cascading frame drops.
   */
  private renderLoop = async (): Promise<void> => {
    if (this.destroyed) return;

    // Prevent overlap: if the previous frame is still processing, skip the current frame
    if (this.frameInFlight) {
      this.animationFrameId = this.video.requestVideoFrameCallback(this.renderLoop);
      return;
    }

    this.frameInFlight = true;
    try {
      if (await this.processFrame()) {
        // Frame rendered successfully
        this.fixAttempted = false;
        this.lastError = null;
      } else {
        // Frame rendering failed or was skipped
        const error = this.lastError;
        if (error) {
          // This is a real error
          if (error instanceof RendererRuntimeError && error.recoverable && !this.fixAttempted) {
            this.fixAttempted = true; // Mark that recovery has been attempted; the next frame will be the second try
            console.log('[Anime4KWebExt] Retrying frame render after recovery attempt...');
          } else {
            console.error(`[Anime4KWebExt] Unrecoverable error in render loop. Destroying renderer. Error: ${error.message}`);
            if (this.onError) this.onError(error);
            this.destroy();
            return; // Stop the loop
          }
        }
        // If there's no error, it's a benign frame skip (e.g., resolution change); do nothing and wait for the next frame
      }
    } finally {
      this.frameInFlight = false;
    }

    // Continuously schedule itself
    if (!this.destroyed) {
      this.animationFrameId = this.video.requestVideoFrameCallback(this.renderLoop);
    }
  };

  /**
   * Called when the video source itself changes resolution (e.g., user switches quality in the video player).
   * This recreates resources based on the video's native dimensions.
   * Guarded against concurrent calls with a resizing flag.
   */
  public async handleSourceResize(): Promise<void> {
    if (this.destroyed || this.resizing) return; // Prevent concurrent resizes
    this.resizing = true;
    try {
      console.log('[Anime4KWebExt] Resizing renderer due to video source dimension change...');
      this.createResources();
      await this.buildPipelines();
      this.createRenderBindGroup();
      console.log('[Anime4KWebExt] Renderer resized for source.');
    } finally {
      this.resizing = false; // Always release the guard
    }
  }

  /**
   * Updates the renderer configuration based on user settings (effects or target resolution).
   * Uses shallow params comparison instead of JSON.stringify.
   * @param options Object containing new effects and target dimensions
   */
  public async updateConfiguration(options: { effects: EnhancementEffect[], targetDimensions: Dimensions }): Promise<void> {
    if (this.destroyed) return;

    const { effects, targetDimensions } = options;

    // Detect substantive changes using shallow params comparison
    const effectsChanged = this.effects.length !== effects.length ||
      this.effects.some((e, i) =>
        e.id !== effects[i].id ||
        !paramsEqual(e.params, effects[i].params)
      );
    const dimensionsChanged = this.targetDimensions.width !== targetDimensions.width || this.targetDimensions.height !== targetDimensions.height;

    if (!effectsChanged && !dimensionsChanged) {
      console.log('[Anime4KWebExt] Configuration unchanged, skipping pipeline rebuild.');
      return;
    }

    if (dimensionsChanged) {
      console.log(`[Anime4KWebExt] Updating target dimensions to ${targetDimensions.width}x${targetDimensions.height}.`);
      this.targetDimensions = targetDimensions;
    }

    if (effectsChanged) {
      console.log('[Anime4KWebExt] Updating effects.');
      this.effects = effects;
    }

    console.log('[Anime4KWebExt] Rebuilding pipeline due to configuration update.');
    await this.buildPipelines();
    this.createRenderBindGroup();
    console.log('[Anime4KWebExt] Renderer configuration updated.');
  }

  /**
   * Updates the video source used by the renderer.
   * @param newVideo - The new HTMLVideoElement
   */
  public async updateVideoSource(newVideo: HTMLVideoElement): Promise<void> {
    console.log('[Anime4KWebExt] Renderer video source updated.');
    // Update the video reference first to ensure subsequent resize operations use the correct video element
    this.video = newVideo;
    if (newVideo.videoWidth !== this.videoFrameTexture.width || newVideo.videoHeight !== this.videoFrameTexture.height) {
      console.log('[Anime4KWebExt] Video dimensions changed on reattach. Updating renderer.');
      await this.handleSourceResize();
    }
  }

  /**
   * Recovers from device loss.
   * Attempts to reinitialize GPU resources and resume rendering.
   * Uses GPUDeviceManager for device re-acquisition.
   */
  private async recoverFromDeviceLoss(): Promise<void> {
    if (this.destroyed || this.isRecovering) return;

    this.isRecovering = true;
    console.log('[Anime4KWebExt] Starting device recovery...');

    try {
      // Stop the current render loop
      if (this.animationFrameId) {
        this.video.cancelVideoFrameCallback(this.animationFrameId);
        this.animationFrameId = null;
      }

      // Re-request GPU adapter and device via GPUDeviceManager
      const { device } = await GPUDeviceManager.requestGPUDevice();
      this.device = device;

      // Set up device loss listener for the new device
      this.device.lost.then((info) => {
        if (this.destroyed) return;
        console.warn(`[Anime4KWebExt] GPU device lost: ${info.reason} - ${info.message}`);
        if (info.reason !== 'destroyed' && !this.isRecovering) {
          this.recoverFromDeviceLoss();
        }
      });

      // Reconfigure context (unconfigure then configure, as strictly required by the spec)
      this.context.unconfigure();
      this.context.configure({
        device: this.device,
        format: this.presentationFormat,
        alphaMode: 'premultiplied',
      });

      // Invalidate shader pre-warm cache — the new device has a separate shader cache
      GPUDeviceManager.invalidatePreWarm();

      // Rebuild resources and pipelines
      this.createResources();
      await this.buildPipelines();
      await this.createRenderPipeline();
      this.createRenderBindGroup();

      // Restart the render loop
      this.isRecovering = false;
      this.renderFirstFrameAndStartLoop();

      console.log('[Anime4KWebExt] Device recovery successful!');
    } catch (error) {
      this.isRecovering = false;
      console.error('[Anime4KWebExt] Device recovery failed:', error);
      if (this.onError) {
        this.onError(new RendererRuntimeError('Failed to recover from device loss', { cause: error as Error }));
      }
    }
  }

  /**
   * Destroys the renderer and releases all WebGPU resources.
   * This is a critical cleanup method to prevent memory and GPU resource leaks.
   * Uses GPUDeviceManager for pre-warm invalidation.
   */
  public destroy(): void {
    if (this.destroyed) return;
    // Immediately set the destroy flag to prevent any async operations (e.g., device.lost) from performing unnecessary actions during destruction
    this.destroyed = true;

    // Stop the render loop
    if (this.animationFrameId) {
      this.video.cancelVideoFrameCallback(this.animationFrameId);
      this.animationFrameId = null;
    }

    // Safely destroy all GPU resources
    try {
      this.pipelines.forEach(pipeline => {
        pipeline.destroy?.();
      });
      this.pendingBitmap?.close();
      this.pendingBitmap = null;
      this.videoFrameTexture?.destroy();
      // Disassociate the canvas from the GPU device — critical for subsequent reinitialization
      this.context?.unconfigure();
      // Invalidate shader pre-warm cache since the device is being destroyed
      GPUDeviceManager.invalidatePreWarm();
      // Proactively destroy the device, which will trigger the device.lost Promise
      this.device?.destroy();
      console.log('[Anime4KWebExt] Renderer destroyed.');
    } catch (error) {
      console.error('[Anime4KWebExt] Error during renderer destruction:', error);
    }
  }
}
