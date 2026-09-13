import type { Dimensions, EnhancementEffect, RendererOptions, DestroyablePipeline, RestorePolicy } from '@/types';
import { RendererInitializationError, RendererRuntimeError } from '@core/errors';
import { t } from '@utils/i18n';

import * as GPUDeviceManager from '@core/gpu/gpu-device-manager';
import type { GpuDeviceLease } from '@core/gpu/gpu-device-manager';
import { gpuResourceCache } from '@core/gpu/gpu-resource-cache';
import { GpuTimestampProfiler, type ProfilerSnapshot } from '@core/gpu/gpu-timestamp-profiler';
import { buildEffectPipelines, paramsEqual } from '@core/gpu/pipeline-builder';
import { destroyPipelines } from '@core/gpu/effect-chain-compiler';
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
  private onFrameRendered?: (frameTime: number, profiler?: ProfilerSnapshot | null, pipelineCount?: number) => void;
  private onProgress?: (stage: string | null, current?: number, total?: number) => void;
  /** Whether GPU timestamp profiling should be enabled for this renderer */
  private enableGpuTimings = false;
  /** Restore-pass policy for the emitted chain (default `'gate'`). */
  private restorePolicy: RestorePolicy = 'gate';

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
  /** Whether to use a canvas 2D intermediary for DRM-protected video frames */
  private useDrmCanvasFallback = false;
  /** Intermediate canvas for drawing DRM-protected video frames */
  private drmCanvas: OffscreenCanvas | null = null;
  private drmCtx: OffscreenCanvasRenderingContext2D | null = null;
  /** Whether the DRM canvas fallback has produced a valid (non-black) frame */
  private drmFrameValidated = false;
  /** Visibility change listener to pause/resume rendering based on tab visibility */
  private onVisibilityChange: (() => void) | null = null;

  // --- WebGPU objects ---
  private device!: GPUDevice;
  /** Ref-counted lease on the shared GPU device backing this renderer. */
  private lease: GpuDeviceLease | null = null;
  /** Unsubscribe handle for the active lease's device-loss subscription. */
  private leaseLostUnsubscribe: (() => void) | null = null;
  private context!: GPUCanvasContext;
  private presentationFormat!: GPUTextureFormat;
  /** Intermediate texture used to copy image data from video frames */
  private videoFrameTexture!: GPUTexture;
  /** Effect processing pipeline chain */
  private pipelines: DestroyablePipeline[] = [];
  /** Labels for each built pipeline, in encode order (parallel to this.pipelines) */
  private pipelineLabels: string[] = [];
  /** Optional GPU timestamp profiler; null when timings are disabled or unsupported */
  private profiler: GpuTimestampProfiler | null = null;
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
    this.onFrameRendered = options.onFrameRendered;
    this.onProgress = options.onProgress;
    this.enableGpuTimings = options.enableGpuTimings ?? false;
    this.restorePolicy = options.restorePolicy ?? 'gate';
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
      this.onProgress?.(t('initGpu', '⏳ Initializing GPU...'));

      // Acquire a ref-counted lease on the shared GPU device. A pre-warmed
      // device is claimed here and concurrent renderers share one device.
      this.lease = await GPUDeviceManager.acquireGPUDevice();
      this.device = this.lease.device;

      // Create the optional GPU timestamp profiler on the acquired device.
      // GpuTimestampProfiler.create() returns null when the timestamp-query
      // feature is unavailable, and verification disables a broken profiler, so
      // this stays a no-op on unsupported hardware.
      await this.createProfiler();

      // Observe loss through the lease and attempt automatic recovery.
      this.watchDeviceLoss();

      // Detect whether direct texture copy from VideoFrame is supported (test on current device to avoid creating redundant devices)
      this.useImageBitmapFallback = !await this.detectVideoFrameSupport();
      if (this.useImageBitmapFallback) {
        console.log('[Anime4KWebExt] Renderer: Using ImageBitmap fallback for copying video frames.');
      }

      const context = this.canvas.getContext('webgpu');
      if (!context) {
        throw new RendererInitializationError('Failed to get WebGPU context from canvas.');
      }
      this.context = context;
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

      // Listen for visibility changes to pause/resume rendering based on tab visibility
      this.onVisibilityChange = () => {
        if (!this.destroyed && document.visibilityState === 'visible' && this.animationFrameId !== null) {
          // Cancel the pending callback and request an immediate one to resume faster
          this.video.cancelVideoFrameCallback(this.animationFrameId);
          this.animationFrameId = this.video.requestVideoFrameCallback(this.renderLoop);
        }
      };
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    } catch (error) {
      // Any failure after the lease was acquired must release it (and tear down
      // whatever was built on it) or the shared device's refCount leaks for the
      // lifetime of the page. Failures before acquisition have nothing to undo.
      if (this.lease) {
        this.cleanupAfterFailedInitialization();
      }
      if (error instanceof RendererInitializationError) {
        throw error;
      }
      throw new RendererInitializationError('An unexpected error occurred during renderer initialization.', { cause: error as Error });
    }
  }

  /**
   * Tears down every GPU resource acquired during a failed {@link initialize}
   * and releases the device lease. Mirrors the resource half of {@link destroy}
   * (cancelling a loop that may already have been armed, destroying the
   * profiler, pipelines and frame texture, and unconfiguring the canvas) and
   * additionally drops the per-device resource cache.
   *
   * Safe on a partially constructed renderer: every access is optional and
   * {@link releaseLease} plus {@link GpuDeviceLease.release} are idempotent, so
   * a device shared with other renderers is never destroyed out from under
   * them — it is only destroyed once the last lease is released.
   */
  private cleanupAfterFailedInitialization(): void {
    // Mark as destroyed first so any in-flight first-frame work (armed by
    // renderFirstFrameAndStartLoop before a late failure) stops and a loss
    // emitted by the final lease release cannot re-enter recovery.
    this.destroyed = true;
    const device = this.device;
    try {
      if (this.animationFrameId !== null) {
        this.video.cancelVideoFrameCallback(this.animationFrameId);
        this.animationFrameId = null;
      }
      if (this.onVisibilityChange) {
        document.removeEventListener('visibilitychange', this.onVisibilityChange);
        this.onVisibilityChange = null;
      }
      this.profiler?.destroy();
      this.profiler = null;
      this.pipelines.forEach((pipeline) => pipeline.destroy?.());
      this.pipelines = [];
      this.pipelineLabels = [];
      this.pendingBitmap?.close();
      this.pendingBitmap = null;
      this.videoFrameTexture?.destroy();
      // Disassociate the canvas from the partially configured device.
      this.context?.unconfigure();
      // The next device has a separate shader cache.
      GPUDeviceManager.invalidatePreWarm();
      if (device) gpuResourceCache.release(device);
    } catch (cleanupError) {
      console.error('[Anime4KWebExt] Error cleaning up after failed initialization:', cleanupError);
    } finally {
      // Release the lease last, once its device resources are gone. Other
      // holders keep the shared device alive.
      this.releaseLease();
    }
  }

  /**
   * Creates the optional GPU timestamp profiler for the current device.
   * Clears any previous profiler when timings are disabled. When the optional
   * `timestamp-query` feature is unavailable, `GpuTimestampProfiler.create()`
   * returns null and all profiling calls remain no-ops. An instance is only
   * activated after `verify()` proves its resources and probe command work, so a
   * broken profiler can never invalidate the presentation path.
   */
  private async createProfiler(): Promise<void> {
    if (!this.enableGpuTimings) {
      this.profiler = null;
      return;
    }
    const profiler = GpuTimestampProfiler.create(this.device, {});
    if (profiler && await profiler.verify()) {
      this.profiler = profiler;
    } else {
      profiler?.destroy();
      this.profiler = null;
    }
  }

  /**
   * Subscribes to device-loss notifications for the current lease and triggers
   * automatic recovery. Replaces any previous subscription. Loss is observed
   * through the lease so the manager can attach just one `device.lost` listener
   * per shared device.
   */
  private watchDeviceLoss(): void {
    this.leaseLostUnsubscribe?.();
    this.leaseLostUnsubscribe = null;
    const lease = this.lease;
    if (!lease) return;
    this.leaseLostUnsubscribe = lease.onLost((info) => {
      // If the renderer has already been destroyed, no action needed.
      if (this.destroyed) return;

      console.warn(`[Anime4KWebExt] GPU device lost: ${info.reason} - ${info.message}`);

      // Attempt automatic recovery (only when not intentionally destroyed).
      if (info.reason !== 'destroyed' && !this.isRecovering) {
        console.log('[Anime4KWebExt] Attempting to recover from device loss...');
        this.recoverFromDeviceLoss();
      }
    });
  }

  /**
   * Releases the current device lease and disconnects its loss subscription.
   * The shared device is destroyed only when no other lease remains.
   */
  private releaseLease(): void {
    this.leaseLostUnsubscribe?.();
    this.leaseLostUnsubscribe = null;
    this.lease?.release();
    this.lease = null;
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
   *
   * Builds are generation-guarded: a newer call supersedes any older in-flight
   * build. A superseded invocation destroys its own result and must not clear the
   * `rebuilding` flag or overwrite the winner's pipelines.
   *
   * @returns `true` when this invocation's result was applied, `false` when it
   *   was superseded (the caller must then skip any dependent resources such as
   *   the render bind group, which the winner's caller owns).
   */
  private async buildPipelines(): Promise<boolean> {
    const generation = ++this.buildGeneration;
    this.rebuilding = true; // Prevent render loop from processing frames during rebuild
    const oldPipelines = this.pipelines;
    this.pipelines = []; // Clear reference before builder destroys old pipelines
    try {
      const labels: string[] = [];
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
        restorePolicy: this.restorePolicy,
        labels, // Out-param filled with one label per built pipeline, in encode order
      });
      if (this.buildGeneration !== generation) {
        // Superseded: never apply the result, and destroy it (it owns output
        // textures). The winning invocation owns `this.pipelines` now.
        destroyPipelines(pipelines);
        return false;
      }
      this.pipelines = pipelines;
      this.pipelineLabels = labels;
      // The effect chain changed, so previously accumulated per-label timings
      // no longer map to the current pipelines.
      this.profiler?.reset();
      return true;
    } finally {
      // Only the current (winning) generation may clear the busy flag. A losing
      // invocation clearing it would let processFrame() run against
      // `this.pipelines = []` while the winner is still building.
      if (this.buildGeneration === generation) {
        this.rebuilding = false; // Allow render loop to resume
      }
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
   * Ensures the DRM intermediary canvas exists and matches the current video dimensions.
   * Returns the 2D rendering context for drawing.
   */
  private ensureDrmCanvas(): OffscreenCanvasRenderingContext2D {
    const w = this.video.videoWidth;
    const h = this.video.videoHeight;
    if (!this.drmCanvas || this.drmCanvas.width !== w || this.drmCanvas.height !== h) {
      this.drmCanvas = new OffscreenCanvas(w, h);
      const ctx = this.drmCanvas.getContext('2d');
      if (!ctx) {
        throw new RendererRuntimeError('Failed to get 2D context for DRM fallback canvas', { recoverable: false });
      }
      this.drmCtx = ctx;
    }
    if (!this.drmCtx) {
      throw new RendererRuntimeError('DRM canvas context not initialized', { recoverable: false });
    }
    return this.drmCtx;
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
    const lastPipeline = this.pipelines.at(-1);
    if (!lastPipeline) {
      throw new RendererInitializationError('No pipelines available for render bind group');
    }
    this.renderBindGroup = this.device.createBindGroup({
      layout: this.renderBindGroupLayout,
      entries: [
        { binding: 1, resource: this.sampler },
        // Get the output texture of the last pipeline in the effect chain as input for final rendering
        { binding: 2, resource: lastPipeline.getOutputTexture().createView() },
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
    // Defensive: a successfully applied build always ends with at least a
    // passthrough pipeline, so an empty chain means a rebuild is (or should be)
    // in progress. Never encode frames against an empty chain while the render
    // bind group may still reference destroyed textures.
    if (this.pipelines.length === 0) return false;
    if (document.visibilityState === 'hidden') return false; // Skip frames when tab is hidden

    try {
      const frameStartTime = performance.now();

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
      } else if (this.useDrmCanvasFallback) {
        // DRM canvas 2D intermediary: draw video to canvas, then copy canvas to GPU texture.
        // This bypasses the "back resource" restriction for software DRM (Widevine L3).
        const ctx = this.ensureDrmCanvas();
        ctx.drawImage(this.video, 0, 0);
        if (!this.drmCanvas) {
          throw new RendererRuntimeError('DRM canvas not initialized', { recoverable: false });
        }
        this.device.queue.copyExternalImageToTexture(
          { source: this.drmCanvas },
          { texture: this.videoFrameTexture },
          [this.video.videoWidth, this.video.videoHeight]
        );
      } else {
        this.device.queue.copyExternalImageToTexture(
          { source: this.video },
          { texture: this.videoFrameTexture },
          [this.video.videoWidth, this.video.videoHeight]
        );
      }

      // Validate DRM canvas fallback isn't producing black frames (hardware DRM / Widevine L1)
      if (this.useDrmCanvasFallback && !this.drmFrameValidated) {
        try {
          if (!this.drmCtx) return false;
          const ctx = this.drmCtx;
          const w = this.video.videoWidth;
          const h = this.video.videoHeight;
          const samples = [
            ctx.getImageData(w >> 2, h >> 2, 1, 1).data,
            ctx.getImageData(w >> 1, h >> 1, 1, 1).data,
            ctx.getImageData((w * 3) >> 2, (h * 3) >> 2, 1, 1).data,
          ];
          const allBlack = samples.every(d => d[0] === 0 && d[1] === 0 && d[2] === 0);
          if (allBlack) {
            console.warn('[Anime4KWebExt] DRM canvas produced all-black frames. Hardware DRM detected — enhancement not possible.');
            this.lastError = new RendererRuntimeError(
              'DRM detected. Video enhancement is not supported for this content due to copy protection.',
              { recoverable: false }
            );
            return false;
          }
          this.drmFrameValidated = true;
          console.log('[Anime4KWebExt] DRM canvas fallback validated — producing valid frames.');
        } catch {
          // getImageData throws SecurityError if canvas is tainted (software DRM)
          console.warn('[Anime4KWebExt] DRM canvas is tainted — enhancement not possible.');
          this.lastError = new RendererRuntimeError(
            'DRM detected. Video enhancement is not supported for this content due to copy protection.',
            { recoverable: false }
          );
          return false;
        }
      }



      const commandEncoder = this.device.createCommandEncoder();
      const rec = this.profiler?.beginFrame(commandEncoder) ?? null;
      // A chain may run the same effect several times (e.g. CNNUL appears three
      // times in A+A/ultra). The profiler aggregates CPU/GPU stats by label, so
      // identical labels would collapse every duplicate pass into a single HUD
      // row and hide the real chain. Disambiguate occurrences here so each pass
      // is measured and reported separately.
      const labelCounts = new Map<string, number>();
      for (let i = 0; i < this.pipelines.length; i++) {
        const baseLabel = this.pipelineLabels[i] ?? `pass ${i + 1}`;
        const occurrence = (labelCounts.get(baseLabel) ?? 0) + 1;
        labelCounts.set(baseLabel, occurrence);
        const label = occurrence === 1 ? baseLabel : `${baseLabel} #${occurrence}`;
        const t0 = performance.now();
        await this.pipelines[i].pass(commandEncoder);
        rec?.recordCpu(label, performance.now() - t0);
        rec?.mark(label);
      }
      const passEncoder = commandEncoder.beginRenderPass({
        colorAttachments: [{
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
        timestampWrites: rec?.writesFor('blit'),
      });
      passEncoder.setPipeline(this.renderPipeline);
      passEncoder.setBindGroup(0, this.renderBindGroup);
      passEncoder.draw(6);
      passEncoder.end();
      this.profiler?.endFrame(commandEncoder);
      this.device.queue.submit([commandEncoder.finish()]);
      this.profiler?.afterSubmit();

      const frameTime = performance.now() - frameStartTime;
      this.onFrameRendered?.(frameTime, this.profiler?.snapshot() ?? null, this.pipelineLabels.length);
      return true; // Successfully rendered

    } catch (error) {
      // The renderer was destroyed while this frame was in flight (e.g. the
      // video element was replaced during initialization). Swallow the error:
      // it is an artifact of teardown, not a real rendering failure.
      if (this.destroyed) return false;

      // Release any ring slot claimed between beginFrame() and endFrame() so an
      // aborted frame can never leak the profiler's readback ring.
      this.profiler?.abortFrame();
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
      } else if (error instanceof Error && error.name === 'OperationError' && error.message.includes("doesn't have back resource")) {
        if (!this.useDrmCanvasFallback) {
          // DRM-protected video detected — switch to canvas 2D intermediary (works for software DRM / Widevine L3)
          console.warn('[Anime4KWebExt] DRM-protected video detected. Attempting canvas 2D fallback...');
          this.useDrmCanvasFallback = true;
          this.drmFrameValidated = false;
          this.lastError = new RendererRuntimeError('DRM video detected, switching to canvas 2D fallback.', { cause: error, recoverable: true });
          // No handleSourceResize needed — resources are fine, just need a different copy path
        } else {
          // Canvas fallback also failed — unrecoverable
          this.lastError = new RendererRuntimeError(`Canvas 2D fallback failed for DRM video: ${error.message}`, { cause: error, recoverable: false });
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

    const rendered = await this.processFrame();
    // The renderer may have been destroyed while the frame was in flight (e.g.
    // the video element was replaced during initialization). Never surface
    // callbacks or errors, or schedule further work, after teardown.
    if (this.destroyed) return;

    if (rendered) {
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
      const rendered = await this.processFrame();
      // If the renderer was destroyed mid-frame, stop without surfacing errors
      // or scheduling another callback. The finally block still resets the guard.
      if (this.destroyed) return;

      if (rendered) {
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
      // Only rebuild the render bind group when this build actually applied; a
      // superseded resize must not bind against the winner's (or an empty)
      // pipeline list.
      if (await this.buildPipelines()) {
        this.createRenderBindGroup();
      }
      // Texture dimensions changed, so accumulated GPU samples are no longer
      // comparable to future frames.
      this.profiler?.reset();
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
  public async updateConfiguration(options: { effects: EnhancementEffect[], targetDimensions: Dimensions, restorePolicy?: RestorePolicy }): Promise<void> {
    if (this.destroyed) return;

    const { effects, targetDimensions } = options;

    // Detect substantive changes using shallow params comparison
    const effectsChanged = this.effects.length !== effects.length ||
      this.effects.some((e, i) =>
        e.id !== effects[i].id ||
        !paramsEqual(e.params, effects[i].params)
      );
    const dimensionsChanged = this.targetDimensions.width !== targetDimensions.width || this.targetDimensions.height !== targetDimensions.height;
    // Restore-policy changes do not alter the effect list, so they must be
    // detected explicitly or a policy change would be a no-op.
    const nextRestorePolicy = options.restorePolicy ?? this.restorePolicy;
    const policyChanged = nextRestorePolicy !== this.restorePolicy;

    if (!effectsChanged && !dimensionsChanged && !policyChanged) {
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

    if (policyChanged) {
      console.log(`[Anime4KWebExt] Updating restore policy (restorePolicy=${nextRestorePolicy}).`);
      this.restorePolicy = nextRestorePolicy;
    }

    console.log('[Anime4KWebExt] Rebuilding pipeline due to configuration update.');
    // A superseded update must not create a render bind group against the
    // winner's (or an empty) pipeline list; the winning call owns it.
    if (await this.buildPipelines()) {
      this.createRenderBindGroup();
    }
    console.log('[Anime4KWebExt] Renderer configuration updated.');
  }

  /**
   * Updates the video source used by the renderer.
   * @param newVideo - The new HTMLVideoElement
   */
  public async updateVideoSource(newVideo: HTMLVideoElement): Promise<void> {
    if (this.destroyed || this.video === newVideo) return;

    console.log('[Anime4KWebExt] Renderer video source updated.');

    // A pending requestVideoFrameCallback is bound to the OLD element's
    // presentation clock. If one is pending (and not currently executing),
    // cancel it on that element before switching, otherwise the loop would
    // stall when the old element stops presenting frames.
    const hadPendingCallback = this.animationFrameId !== null && !this.frameInFlight;
    if (hadPendingCallback && this.animationFrameId !== null) {
      this.video.cancelVideoFrameCallback(this.animationFrameId);
      this.animationFrameId = null;
    }

    // Update the video reference first to ensure subsequent resize operations use the correct video element
    this.video = newVideo;
    if (newVideo.videoWidth !== this.videoFrameTexture.width || newVideo.videoHeight !== this.videoFrameTexture.height) {
      console.log('[Anime4KWebExt] Video dimensions changed on reattach. Updating renderer.');
      await this.handleSourceResize();
    }

    // Re-arm the loop on the new element after cancelling the old callback. If a
    // frame was in flight, the running loop reschedules against the updated
    // this.video, so a second loop must not be started.
    if (hadPendingCallback && !this.destroyed && !this.isRecovering) {
      this.renderFirstFrameAndStartLoop();
    }
  }

  /**
   * Tears down state created by an in-flight {@link recoverFromDeviceLoss} when
   * the renderer was destroyed before recovery completed. Releases the
   * replacement lease (if one was acquired), destroys any profiler, pipelines
   * and frame texture rebuilt on it, unsubscribes the replacement loss
   * listener, and clears `isRecovering` so it can never stay stuck.
   *
   * Idempotent: `releaseLease` and `GpuDeviceLease.release` are no-ops once the
   * lease is gone, and `destroy` is guarded so this only ever runs for a
   * recovery that raced a real teardown.
   */
  private abortRecovery(): void {
    const device = this.device;
    try {
      this.profiler?.destroy();
      this.profiler = null;
      this.pipelines.forEach((pipeline) => pipeline.destroy?.());
      this.pipelines = [];
      this.pipelineLabels = [];
      this.videoFrameTexture?.destroy();
      // Disassociate the canvas from the replacement device.
      this.context?.unconfigure();
      GPUDeviceManager.invalidatePreWarm();
      if (device) gpuResourceCache.release(device);
    } catch (cleanupError) {
      console.error('[Anime4KWebExt] Error cleaning up after aborted device recovery:', cleanupError);
    } finally {
      // Unsubscribe the replacement loss listener and release its lease, then
      // always clear the flag so a later renderer state is not blocked.
      this.releaseLease();
      this.isRecovering = false;
    }
  }

  /**
   * Recovers from device loss.
   * Attempts to reinitialize GPU resources and resume rendering.
   * Uses GPUDeviceManager for device re-acquisition.
   *
   * Because this method awaits several GPU operations, `destroy()` may run
   * while it is suspended. `this.destroyed` is therefore re-checked after every
   * await; a destroyed renderer aborts recovery, releasing the lease it had
   * just acquired (otherwise it would leak the shared device's refCount with no
   * `destroy()` left to run again) and tearing down anything rebuilt.
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

      // Release the old lease (the shared device is destroyed only when no
      // other lease remains) and drop its per-device resource cache.
      const oldDevice = this.device;
      this.releaseLease();
      gpuResourceCache.release(oldDevice);

      // Acquire a lease on the replacement shared device.
      this.lease = await GPUDeviceManager.acquireGPUDevice();
      this.device = this.lease.device;
      if (this.destroyed) {
        this.abortRecovery();
        return;
      }

      // Set up device loss listener for the new lease/device
      this.watchDeviceLoss();

      // Re-create the profiler on the new device: the old device's profiler
      // resources were lost along with the device.
      this.profiler?.destroy();
      await this.createProfiler();
      if (this.destroyed) {
        this.abortRecovery();
        return;
      }

      // Reconfigure context (unconfigure then configure, as strictly required by the spec)
      this.context.unconfigure();
      this.context.configure({
        device: this.device,
        format: this.presentationFormat,
        alphaMode: 'premultiplied',
      });

      // Invalidate shader pre-warm cache — the new device has a separate shader cache
      GPUDeviceManager.invalidatePreWarm();

      // The replacement device may have different VideoFrame copy behavior.
      // Preserve an active DRM canvas fallback, which takes precedence.
      if (!this.useDrmCanvasFallback) {
        this.useImageBitmapFallback = !await this.detectVideoFrameSupport();
        if (this.destroyed) {
          this.abortRecovery();
          return;
        }
        if (this.useImageBitmapFallback) {
          console.log('[Anime4KWebExt] Renderer: Using ImageBitmap fallback for copying video frames.');
        }
      }

      // Rebuild resources and pipelines
      this.createResources();
      await this.buildPipelines();
      if (this.destroyed) {
        this.abortRecovery();
        return;
      }
      await this.createRenderPipeline();
      if (this.destroyed) {
        this.abortRecovery();
        return;
      }
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

    // Remove the visibility change listener
    if (this.onVisibilityChange) {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
      this.onVisibilityChange = null;
    }

    // Stop the render loop
    if (this.animationFrameId) {
      this.video.cancelVideoFrameCallback(this.animationFrameId);
      this.animationFrameId = null;
    }

    // Safely destroy all GPU resources
    try {
      this.profiler?.destroy();
      this.profiler = null;
      this.pipelines.forEach(pipeline => {
        pipeline.destroy?.();
      });
      this.pendingBitmap?.close();
      this.pendingBitmap = null;
      this.drmCanvas = null;
      this.drmCtx = null;
      this.videoFrameTexture?.destroy();
      // Disassociate the canvas from the GPU device — critical for subsequent reinitialization
      this.context?.unconfigure();
      // Invalidate the shader pre-warm cache; the next device has a separate cache.
      GPUDeviceManager.invalidatePreWarm();
      // Release our lease. The shared device is destroyed only once the last
      // holder releases it. `destroyed` is already set, so the loss this may
      // trigger does not re-enter the recovery path.
      this.releaseLease();
      console.log('[Anime4KWebExt] Renderer destroyed.');
    } catch (error) {
      console.error('[Anime4KWebExt] Error during renderer destruction:', error);
    }
  }
}
