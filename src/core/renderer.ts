import type { Anime4KPipeline } from 'anime4k-webgpu';
import type { Dimensions, EnhancementEffect, CustomEffectDescriptor } from '../types';
import { RendererInitializationError, RendererRuntimeError } from './errors';
import { CAS } from './cas';
import { Debanding } from './debanding';
import { yieldToMain } from './yield-utils';
import { PipelinePreWarmer } from './pipeline-prewarmer';

/**
 * Registry of custom (non-anime4k-webgpu) effects.
 *
 * Maps an effect's `className` to its constructor and a descriptor builder. Adding a
 * new custom effect is a one-entry change here — no edits to the pipeline build loop
 * or prewarmer. The descriptor builder receives the live effect params so per-effect
 * values (e.g. strength, threshold) flow through uniformly.
 */

const CUSTOM_EFFECTS: Record<string, CustomEffectDescriptor> = {
  CAS: {
    EffectClass: CAS,
    getDescriptor: (device, inputTexture, params) => ({
      device,
      inputTexture,
      sharpness: params?.sharpness ?? 0.5,
    }),
  },
  Debanding: {
    EffectClass: Debanding,
    getDescriptor: (device, inputTexture, params) => ({
      device,
      inputTexture,
      strength: params?.strength ?? 0.5,
      bandThreshold: params?.bandThreshold ?? 0.08,
    }),
  },
};

/**
 * Full-screen textured quad vertex shader
 * Defines vertex positions and UV coordinates for rendering a full-screen texture
 */
const fullscreenTexturedQuadWGSL = `
struct VertexOutput {
  @builtin(position) Position : vec4<f32>,
  @location(0) fragUV : vec2<f32>,
}

@vertex
fn vert_main(@builtin(vertex_index) VertexIndex : u32) -> VertexOutput {
  const pos = array(
    vec2( 1.0,  1.0),  // Top-right
    vec2( 1.0, -1.0),  // Bottom-right
    vec2(-1.0, -1.0),  // Bottom-left
    vec2( 1.0,  1.0),  // Top-right (duplicate)
    vec2(-1.0, -1.0),  // Bottom-left (duplicate)
    vec2(-1.0,  1.0),  // Top-left
  );

  const uv = array(
    vec2(1.0, 0.0),  // Top-right UV
    vec2(1.0, 1.0),  // Bottom-right UV
    vec2(0.0, 1.0),  // Bottom-left UV
    vec2(1.0, 0.0),  // Top-right UV (duplicate)
    vec2(0.0, 1.0),  // Bottom-left UV (duplicate)
    vec2(0.0, 0.0),  // Top-left UV
  );

  var output : VertexOutput;
  output.Position = vec4(pos[VertexIndex], 0.0, 1.0);
  output.fragUV = uv[VertexIndex];
  return output;
}
`;

/**
 * Texture sampling fragment shader
 * Samples color values from a texture and outputs them to the screen
 */
const sampleExternalTextureWGSL = `
@group(0) @binding(1) var mySampler: sampler;
@group(0) @binding(2) var myTexture: texture_2d<f32>;

@fragment
fn main(@location(0) fragUV : vec2f) -> @location(0) vec4f {
  // Sample texture with base edge clamping
  return textureSampleBaseClampToEdge(myTexture, mySampler, fragUV);
}
`;

/**
 * RendererOptions defines the configuration required to create a Renderer instance
 */
export interface RendererOptions {
  /** Video player element */
  video: HTMLVideoElement;
  /** Canvas element used for rendering */
  canvas: HTMLCanvasElement;
  /** Array of enhancement effects to apply */
  effects: EnhancementEffect[];
  /** Target resolution for rendering */
  targetDimensions: Dimensions;
  /** Callback function invoked when a runtime error occurs */
  onError?: (error: Error) => void;
  /** Callback function invoked when the first frame is successfully rendered */
  onFirstFrameRendered?: () => void;
  /** Initialization progress callback function */
  onProgress?: (stage: string | null, current?: number, total?: number) => void;
}

/**
 * The Renderer class encapsulates all WebGPU-related rendering logic.
 * It manages the GPU device, context, rendering pipelines, textures, and the render loop.
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

  // --- WebGPU objects ---
  private device!: GPUDevice;
  private context!: GPUCanvasContext;
  private presentationFormat!: GPUTextureFormat;
  /** Intermediate texture used to copy image data from video frames */
  private videoFrameTexture!: GPUTexture;
  /** Effect processing pipeline chain */
  private pipelines: Anime4KPipeline[] = [];
  /** Generation counter to prevent concurrent buildPipelines() calls from clobbering each other */
  private buildGeneration = 0;

  // --- Objects for the final rendering stage ---
  private renderBindGroupLayout!: GPUBindGroupLayout;
  private renderPipeline!: GPURenderPipeline;
  private sampler!: GPUSampler;
  private renderBindGroup!: GPUBindGroup;

  // --- Static properties ---
  /** Cached anime4k-webgpu module (avoids repeated dynamic imports) */
  private static cachedAnime4KModule: typeof import('anime4k-webgpu') | null = null;

  // --- Static GPU pre-warm state ---
  private static prewarmedAdapter: GPUAdapter | null = null;
  private static prewarmedDevice: GPUDevice | null = null;
  private static prewarmPromise: Promise<void> | null = null;
  private static preWarmer = new PipelinePreWarmer();

  /**
   * Pre-request GPU adapter and device so they're ready when the user clicks Enhance.
   * This warms the GPU driver and saves 50-100ms during initialization.
   * Safe to call multiple times — only the first call does work.
   */
  public static preWarmGPU(): void {
    if (Renderer.prewarmPromise) return;
    Renderer.prewarmPromise = (async () => {
      try {
        if (!navigator.gpu) return;
        const adapterOptions: GPURequestAdapterOptions = {};
        if (!navigator.platform.startsWith('Win')) {
          adapterOptions.powerPreference = 'high-performance';
        }
        const adapter = await navigator.gpu.requestAdapter(adapterOptions);
        if (!adapter) return;
        Renderer.prewarmedAdapter = adapter;
        const adapterLimits = adapter.limits;
        Renderer.prewarmedDevice = await adapter.requestDevice({
          requiredLimits: {
            maxBufferSize: adapterLimits.maxBufferSize,
            maxStorageBufferBindingSize: adapterLimits.maxStorageBufferBindingSize,
          },
        });
      } catch {
        // Pre-warm is best-effort; errors are non-fatal
      }
    })();
  }

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

      if (Renderer.prewarmedDevice) {
        this.device = Renderer.prewarmedDevice;
        // Clear the cached device so each renderer gets its own.
        // Sharing a single device across renderers would cause use-after-destroy
        // when one renderer's destroy() kills the shared device.
        Renderer.prewarmedDevice = null;
        Renderer.prewarmedAdapter = null;
      } else {
        const adapterOptions: GPURequestAdapterOptions = {};
        // Setting powerPreference on Windows produces a warning, so only use it on other platforms
        if (!navigator.platform.startsWith('Win')) {
          adapterOptions.powerPreference = 'high-performance';
        }
        const adapter = await navigator.gpu.requestAdapter(adapterOptions);
        if (!adapter) {
          throw new RendererInitializationError('WebGPU not supported: No adapter found.');
        }

        // Request GPU device and configure Canvas context
        // Request higher maxBufferSize based on adapter-supported limits for high-resolution video processing
        const adapterLimits = adapter.limits;
        this.device = await adapter.requestDevice({
          requiredLimits: {
            maxBufferSize: adapterLimits.maxBufferSize,
            maxStorageBufferBindingSize: adapterLimits.maxStorageBufferBindingSize,
          },
        });
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
   * This method destroys old pipelines and creates new ones.
   */
  private async buildPipelines(): Promise<void> {
    const generation = ++this.buildGeneration;

    // Wait for the GPU queue to finish before destroying old pipelines to avoid resource contention
    try {
      await this.device.queue.onSubmittedWorkDone();
    } catch {
      // Ignore error; the device may have been lost
    }
    if (this.buildGeneration !== generation) return; // Superseded

    // Safely destroy old pipelines
    for (const p of this.pipelines) {
      try {
        (p as any).destroy?.();
      } catch {
        // Ignore individual pipeline destruction errors
      }
    }

    const pipelines: Anime4KPipeline[] = [];
    let currentTexture = this.videoFrameTexture;
    let curWidth = this.video.videoWidth;
    let curHeight = this.video.videoHeight;

    // Use the cached module to avoid repeated dynamic imports
    if (!Renderer.cachedAnime4KModule) {
      Renderer.cachedAnime4KModule = await import('anime4k-webgpu');
    }
    const anime4kModule = Renderer.cachedAnime4KModule;

    // --- Phase 0: Speculative shader pre-warming ---
    // Construct dummy 1×1 pipelines to trigger driver-level shader compilation and caching.
    // The real pipeline construction in Phase 1 will then hit the cache (~1-3ms instead of ~25ms).
    // On subsequent calls (same effect chain), the pre-warmer skips via in-memory deduplication,
    // and the driver cache makes Phase 1 fast regardless.
    this.onProgress?.(chrome.i18n.getMessage('warmupShadersProgress') || '⏳ Compiling shaders...');
    try {
      await Renderer.preWarmer.warm(this.device, this.effects, (className, dev, tex) => {
        const custom = CUSTOM_EFFECTS[className];
        if (!custom) return null;
        // Prewarm uses default params; the real build supplies effect.params.
        return {
          EffectClass: custom.EffectClass,
          descriptor: custom.getDescriptor(dev, tex),
        };
      });
    } catch (e) {
      console.warn('[Anime4KWebExt] Phase 0 pre-warm failed (non-fatal):', e);
    }
    if (this.buildGeneration !== generation) return; // Superseded

    // If needed, get the Downscale class
    const needsDownscaling = this.effects.some((effect, i) => {
      const remainingFactor = this.effects.slice(i + 1).reduce((acc, val) => acc * (val.upscaleFactor ?? 1), 1);
      return (effect.upscaleFactor ?? 1) > 1 && remainingFactor > 1;
    });
    const DownscaleClass = needsDownscaling ? anime4kModule.Downscale : null;

    const upscaleFactors = this.effects.map(e => e.upscaleFactor ?? 1);
    const remainingUpscaleFactors = upscaleFactors.map((_, i) =>
      upscaleFactors.slice(i + 1).reduce((acc, val) => acc * val, 1)
    );

    // --- Phase 1: Create all pipeline instances (no GPU submission) ---
    // Each pipeline constructor may trigger synchronous GPU shader compilation (200-500ms on first run),
    // so we yield the main thread after each pipeline creation to keep the UI responsive.
    for (let i = 0; i < this.effects.length; i++) {
      // Report progress
      const loadingMsg = chrome.i18n.getMessage('loadingEffect', [String(i + 1), String(this.effects.length)])
        || `⏳ Loading effect ${i + 1}/${this.effects.length}...`;
      this.onProgress?.(loadingMsg, i + 1, this.effects.length);

      const effect = this.effects[i];
      let pipeline: Anime4KPipeline | null = null;

      // Check for custom effects first (not from anime4k-webgpu library)
      const custom = CUSTOM_EFFECTS[effect.className];
      if (custom) {
        pipeline = new custom.EffectClass(
          custom.getDescriptor(this.device, currentTexture, effect.params),
        ) as unknown as Anime4KPipeline;
      } else {
        const EffectClass = (anime4kModule as Record<string, any>)[effect.className];

        if (EffectClass) {
          pipeline = new EffectClass({
            device: this.device,
            inputTexture: currentTexture,
            nativeDimensions: { width: curWidth, height: curHeight },
            targetDimensions: this.targetDimensions,
          });
          // Apply effect params (e.g. DoG strength) after construction
          if (effect.params && pipeline) {
            for (const [key, value] of Object.entries(effect.params)) {
              (pipeline as any).updateParam?.(key, value);
            }
          }
        } else {
          console.warn(`[Anime4KWebExt] Effect class "${effect.className}" not found in anime4k-webgpu module.`);
        }
      }

      if (pipeline) {
        pipelines.push(pipeline);
        currentTexture = pipeline.getOutputTexture();

        if (effect.upscaleFactor) {
          curWidth *= effect.upscaleFactor;
          curHeight *= effect.upscaleFactor;

          const remainingFactor = remainingUpscaleFactors[i];
          if (DownscaleClass && remainingFactor > 1) {
            const idealIntermediateWidth = this.targetDimensions.width / remainingFactor;
            const idealIntermediateHeight = this.targetDimensions.height / remainingFactor;

            if (curWidth > idealIntermediateWidth * 1.1) {
              const intermediateDownscale = new DownscaleClass({
                device: this.device,
                inputTexture: currentTexture,
                targetDimensions: {
                  width: Math.ceil(idealIntermediateWidth),
                  height: Math.ceil(idealIntermediateHeight),
                },
              });
              pipelines.push(intermediateDownscale);

              currentTexture = intermediateDownscale.getOutputTexture();
              curWidth = Math.ceil(idealIntermediateWidth);
              curHeight = Math.ceil(idealIntermediateHeight);
            }
          }
        }
      }

      // Yield to let the browser process input events between synchronous GPU operations.
      // Uses scheduler.yield() (Chrome 115+) or MessageChannel fallback for faster
      // yielding than requestAnimationFrame, which waits for the next frame boundary.
      await yieldToMain();
    }
    if (this.buildGeneration !== generation) return; // Superseded

    // --- Phase 2: Fire-and-forget warmup ---
    // Submit all shader compilations as a single batch without waiting for GPU completion.
    // Shader compilation happens at createComputePipeline() time (Phase 1), not at execution
    // time. The warmup pass validates the pipeline can execute and triggers minor GPU-side
    // optimizations. By NOT waiting for onSubmittedWorkDone(), we eliminate 400-800ms of
    // UI freeze. The first real render frame will naturally wait for this to complete
    // because GPUQueue.submit() maintains ordering.
    if (pipelines.length > 1) { // Skip dummy pipeline case
      try {
        const warmupEncoder = this.device.createCommandEncoder();
        for (const pipeline of pipelines) {
          pipeline.pass(warmupEncoder);
        }
        this.device.queue.submit([warmupEncoder.finish()]);
        // NO onSubmittedWorkDone() — let the GPU process this asynchronously.
        // The first real render frame will naturally wait for this to complete.
      } catch (e) {
        console.warn('[Anime4KWebExt] Warmup submission failed, shaders will compile on first frame:', e);
      }
    }

    if (pipelines.length === 0) {
      // If no effects are applied, create a dummy pipeline
      pipelines.push({
        pass: () => { },
        getOutputTexture: () => this.videoFrameTexture,
        updateParam: () => { },
      } as unknown as Anime4KPipeline);
    }
    this.pipelines = pipelines;

    // Notify that warmup is complete
    this.onProgress?.(null);

    console.log(`[Anime4KWebExt] Built ${pipelines.length} pipelines with warmup complete.`);
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
   * @returns {boolean} Returns true if a frame was successfully rendered, false otherwise.
   */
  private async processFrame(): Promise<boolean> {
    if (this.destroyed) return false;

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
   */
  public async handleSourceResize(): Promise<void> {
    if (this.destroyed) return;
    console.log('[Anime4KWebExt] Resizing renderer due to video source dimension change...');
    this.createResources();
    await this.buildPipelines();
    this.createRenderBindGroup();
    console.log('[Anime4KWebExt] Renderer resized for source.');
  }

  /**
   * Updates the renderer configuration based on user settings (effects or target resolution).
   * @param options Object containing new effects and target dimensions
   */
  public async updateConfiguration(options: { effects: EnhancementEffect[], targetDimensions: Dimensions }): Promise<void> {
    if (this.destroyed) return;

    const { effects, targetDimensions } = options;

    // Detect substantive changes in the effect array. ID-only comparison is insufficient:
    // a slider tweak (e.g. Debanding strength) keeps the same ID but must trigger a rebuild.
    const effectsChanged = this.effects.length !== effects.length ||
      this.effects.some((e, i) =>
        e.id !== effects[i].id ||
        JSON.stringify(e.params) !== JSON.stringify(effects[i].params)
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

      // Re-request GPU adapter and device
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        throw new Error('Failed to get GPU adapter during recovery');
      }

      const adapterLimits = adapter.limits;
      this.device = await adapter.requestDevice({
        requiredLimits: {
          maxBufferSize: adapterLimits.maxBufferSize,
          maxStorageBufferBindingSize: adapterLimits.maxStorageBufferBindingSize,
        },
      });

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
      Renderer.preWarmer.invalidate();
      Renderer.prewarmPromise = null;

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
        if (typeof (pipeline as any).destroy === 'function') {
          (pipeline as any).destroy();
        }
      });
      this.pendingBitmap?.close();
      this.pendingBitmap = null;
      this.videoFrameTexture?.destroy();
      // Disassociate the canvas from the GPU device — critical for subsequent reinitialization
      this.context?.unconfigure();
      // Invalidate shader pre-warm cache since the device is being destroyed
      Renderer.preWarmer.invalidate();
      Renderer.prewarmPromise = null;
      // Proactively destroy the device, which will trigger the device.lost Promise
      this.device?.destroy();
      console.log('[Anime4KWebExt] Renderer destroyed.');
    } catch (error) {
      console.error('[Anime4KWebExt] Error during renderer destruction:', error);
    }
  }
}
