import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installGPUMock, removeGPUMock, createMockGPUBuffer, type MockGPUObjects } from '@/test/webgpu-mock';
import type { Dimensions, EnhancementEffect, RendererOptions, RestorePolicy } from '@/types';
import type { ProfilerSnapshot } from '@core/gpu/gpu-timestamp-profiler';
import type { GpuDeviceLease } from '@core/gpu/gpu-device-manager';
import { RendererInitializationError } from '@core/errors';

const {
  mockAcquireGPUDevice,
  mockInvalidatePreWarm,
  mockGetPreWarmer,
  mockBuildEffectPipelines,
  mockParamsEqual,
} = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    mockAcquireGPUDevice: fn(),
    mockInvalidatePreWarm: fn(),
    mockGetPreWarmer: fn(),
    mockBuildEffectPipelines: fn(),
    mockParamsEqual: fn(),
  };
});

vi.mock('@core/gpu/gpu-device-manager', () => ({
  preWarmGPU: vi.fn(),
  acquireGPUDevice: mockAcquireGPUDevice,
  invalidatePreWarm: mockInvalidatePreWarm,
  getPreWarmer: mockGetPreWarmer,
}));

vi.mock('@core/gpu/pipeline-builder', () => ({
  buildEffectPipelines: mockBuildEffectPipelines,
  paramsEqual: mockParamsEqual,
}));

vi.mock('@core/utils/yield-utils', () => ({
  yieldToMain: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@utils/i18n', () => ({
  t: vi.fn((_key: string, fallback?: string) => fallback ?? _key),
}));

vi.mock('@shaders/fullscreen-textured-quad.wgsl', () => ({ default: '// mock' }));
vi.mock('@shaders/sample-external-texture.wgsl', () => ({ default: '// mock' }));

import { Renderer } from '@core/renderer';

const HAVE_ENOUGH_DATA = 4;
const HAVE_METADATA = 1;

const DEFAULT_EFFECTS: EnhancementEffect[] = [
  { id: 'test/effect', name: 'Test Effect', className: 'TestEffect', params: { strength: 1.0 } },
];

const DEFAULT_DIMENSIONS: Dimensions = { width: 1920, height: 1080 };

function createMockVideo(opts: { readyState?: number; videoWidth?: number; videoHeight?: number } = {}) {
  const video = document.createElement('video');
  Object.defineProperty(video, 'readyState', { value: opts.readyState ?? HAVE_ENOUGH_DATA, configurable: true, writable: true });
  Object.defineProperty(video, 'videoWidth', { value: opts.videoWidth ?? 1920, configurable: true });
  Object.defineProperty(video, 'videoHeight', { value: opts.videoHeight ?? 1080, configurable: true });
  // jsdom doesn't always define HTMLMediaElement constants — polyfill them
  Object.defineProperty(video, 'HAVE_NOTHING', { value: 0, configurable: true });
  Object.defineProperty(video, 'HAVE_METADATA', { value: 1, configurable: true });
  Object.defineProperty(video, 'HAVE_CURRENT_DATA', { value: 2, configurable: true });
  Object.defineProperty(video, 'HAVE_FUTURE_DATA', { value: 3, configurable: true });
  Object.defineProperty(video, 'HAVE_ENOUGH_DATA', { value: 4, configurable: true });
  Object.defineProperty(video, 'requestVideoFrameCallback', { value: vi.fn(() => 1), configurable: true });
  Object.defineProperty(video, 'cancelVideoFrameCallback', { value: vi.fn(), configurable: true });
  return video;
}

function createMockPipeline() {
  return {
    pass: vi.fn().mockResolvedValue(undefined),
    getOutputTexture: vi.fn().mockReturnValue({
      createView: vi.fn(() => ({ label: 'output-view' })),
      width: 1920,
      height: 1080,
      destroy: vi.fn(),
    }),
    destroy: vi.fn(),
    updateParam: vi.fn(),
  };
}

interface CreateMockLeaseOptions {
  onRelease?: () => void;
}

/**
 * Build a lease backed by `device` that mirrors the real manager's loss/ref
 * behavior closely enough to drive the renderer. `release` is a spy so tests can
 * assert the renderer released rather than destroyed the device directly.
 */
function createMockLease(
  device: unknown,
  adapter: unknown,
  options: CreateMockLeaseOptions = {},
): GpuDeviceLease & { release: ReturnType<typeof vi.fn> } {
  let lost = false;
  const callbacks = new Set<(info: GPUDeviceLostInfo) => void>();
  (device as { lost: Promise<{ reason: string; message: string }> }).lost.then((info) => {
    lost = true;
    const pending = Array.from(callbacks);
    callbacks.clear();
    for (const callback of pending) callback(info as unknown as GPUDeviceLostInfo);
  });
  return {
    device: device as GPUDevice,
    adapter: adapter as GPUAdapter,
    get lost(): boolean {
      return lost;
    },
    release: vi.fn(() => {
      options.onRelease?.();
    }),
    onLost(callback: (info: GPUDeviceLostInfo) => void): () => void {
      if (lost) {
        callback({ reason: 'unknown', message: 'lost' } as unknown as GPUDeviceLostInfo);
        return () => { /* already lost */ };
      }
      callbacks.add(callback);
      return () => {
        callbacks.delete(callback);
      };
    },
  };
}

describe('Renderer', () => {
  let mock: MockGPUObjects;
  let video: HTMLVideoElement;
  let canvas: HTMLCanvasElement;
  /** Lease returned by the default acquireGPUDevice mock for each test. */
  let defaultLease: ReturnType<typeof createMockLease>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = installGPUMock();
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 1920, height: 1080 }));
    vi.stubGlobal('OffscreenCanvas', class {
      width: number; height: number;
      constructor(w: number, h: number) { this.width = w; this.height = h; }
      getContext(_t: string) {
        return { fillRect: vi.fn(), drawImage: vi.fn(), getImageData: vi.fn(() => ({ data: new Uint8ClampedArray([100, 100, 100, 255]) })) };
      }
    });
    vi.stubGlobal('VideoFrame', class {
      constructor(_src: unknown, _init?: unknown) {}
      close = vi.fn();
    });

    defaultLease = createMockLease(mock.device, mock.adapter);
    mockAcquireGPUDevice.mockResolvedValue(defaultLease);
    mockInvalidatePreWarm.mockImplementation(() => {});
    mockGetPreWarmer.mockReturnValue({ warm: vi.fn().mockResolvedValue(undefined) });
    mockParamsEqual.mockReturnValue(false);
    mockBuildEffectPipelines.mockResolvedValue([createMockPipeline()]);

    video = createMockVideo();
    canvas = document.createElement('canvas');
  });

  afterEach(() => {
    removeGPUMock();
  });

  /**
   * Force `canvas.getContext('webgpu')` to return null so initialization fails
   * after the device lease has already been acquired.
   */
  function failWebGpuContext(): void {
    const orig = HTMLCanvasElement.prototype.getContext;
    (HTMLCanvasElement.prototype as any).getContext = function (ctxId: string, ...args: unknown[]) {
      if (ctxId === 'webgpu') return null;
      return (orig as any).apply(this, [ctxId, ...args]);
    };
  }

  async function createRenderer(overrides: Record<string, unknown> = {}): Promise<Renderer> {
    const r = await Renderer.create({
      video: (overrides.video as HTMLVideoElement) ?? video,
      canvas: (overrides.canvas as HTMLCanvasElement) ?? canvas,
      effects: (overrides.effects as EnhancementEffect[]) ?? DEFAULT_EFFECTS,
      targetDimensions: (overrides.targetDimensions as Dimensions) ?? DEFAULT_DIMENSIONS,
      onError: overrides.onError as RendererOptions['onError'],
      onFirstFrameRendered: overrides.onFirstFrameRendered as (() => void) | undefined,
      onFrameRendered: overrides.onFrameRendered as RendererOptions['onFrameRendered'],
      onProgress: overrides.onProgress as ((stage: string | null, current?: number, total?: number) => void) | undefined,
      enableGpuTimings: overrides.enableGpuTimings as boolean | undefined,
      restorePolicy: overrides.restorePolicy as RestorePolicy | undefined,
    });
    await Promise.resolve();
    return r;
  }

  describe('create()', () => {
    it('acquires a shared GPU device lease', async () => {
      const r = await createRenderer();
      expect(mockAcquireGPUDevice).toHaveBeenCalledTimes(1);
      r.destroy();
    });

    it('initializes without waiting for loadeddata once metadata is available', async () => {
      const metadataVideo = createMockVideo({ readyState: HAVE_METADATA });
      const onFirstFrameRendered = vi.fn();

      const r = await createRenderer({ video: metadataVideo, onFirstFrameRendered });

      expect(mockAcquireGPUDevice).toHaveBeenCalled();
      const rvfc = (metadataVideo as unknown as { requestVideoFrameCallback: ReturnType<typeof vi.fn> }).requestVideoFrameCallback;
      expect(rvfc).toHaveBeenCalled();
      expect(onFirstFrameRendered).not.toHaveBeenCalled();
      r.destroy();
    });

    it('rejects with a no-video-track error without waiting when dimensions are zero', async () => {
      const noTrackVideo = createMockVideo({ readyState: HAVE_METADATA, videoWidth: 0, videoHeight: 0 });

      await expect(Renderer.create({
        video: noTrackVideo,
        canvas,
        effects: DEFAULT_EFFECTS,
        targetDimensions: DEFAULT_DIMENSIONS,
      })).rejects.toThrow('Video has no video track.');

      expect(mockAcquireGPUDevice).not.toHaveBeenCalled();
    });

    it('gets WebGPU context from canvas', async () => {
      const getContextSpy = vi.spyOn(canvas, 'getContext');
      const r = await createRenderer();
      expect(getContextSpy).toHaveBeenCalledWith('webgpu');
      r.destroy();
    });

    it('configures WebGPU context', async () => {
      const r = await createRenderer();
      expect(mock.context.configure).toHaveBeenCalled();
      const cfgCall = (mock.context.configure as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(cfgCall.device).toBeDefined();
      expect(cfgCall.format).toBe('bgra8unorm');
      expect(cfgCall.alphaMode).toBe('premultiplied');
      r.destroy();
    });

    it('throws RendererInitializationError when WebGPU context unavailable', async () => {
      failWebGpuContext();
      await expect(createRenderer()).rejects.toThrow(RendererInitializationError);
    });

    it('releases the acquired lease when the WebGPU context is unavailable', async () => {
      failWebGpuContext();

      await expect(createRenderer()).rejects.toThrow(RendererInitializationError);

      // Without the lease release the shared device's refCount would leak for
      // the life of the page (the renderer instance is never returned).
      expect(defaultLease.release).toHaveBeenCalledTimes(1);
      expect(mockInvalidatePreWarm).toHaveBeenCalled();
    });

    it('returns the shared device refCount to its pre-acquire value when init fails', async () => {
      let refCount = 0;
      const sharedDevice = mock.device;
      const lease = createMockLease(sharedDevice, mock.adapter, {
        onRelease: () => {
          refCount -= 1;
          if (refCount === 0) (sharedDevice.destroy as unknown as () => void)();
        },
      });
      refCount = 1; // this renderer's lease
      mockAcquireGPUDevice.mockResolvedValueOnce(lease);
      failWebGpuContext();

      await expect(createRenderer()).rejects.toThrow(RendererInitializationError);

      expect(refCount).toBe(0);
      // The last holder releasing destroyed the device exactly once.
      expect(sharedDevice.destroy).toHaveBeenCalledTimes(1);
    });

    it('tears down partial GPU state when a post-acquire build step fails', async () => {
      mockBuildEffectPipelines.mockRejectedValueOnce(new Error('pipeline build failed'));

      await expect(createRenderer()).rejects.toThrow(RendererInitializationError);

      expect(defaultLease.release).toHaveBeenCalledTimes(1);
      expect(mock.context.unconfigure).toHaveBeenCalled();
      expect(mockInvalidatePreWarm).toHaveBeenCalled();

      // The frame texture created before the failing step must be destroyed.
      const textures = mock.device.createTexture.mock.results.map((result) => result.value);
      const frameTexture = textures.find((t) => t.width === 1920 && t.height === 1080);
      expect(frameTexture).toBeDefined();
      expect(frameTexture!.destroy).toHaveBeenCalled();
    });

    it('throws RendererInitializationError when acquireGPUDevice fails', async () => {
      mockAcquireGPUDevice.mockRejectedValue(new Error('WebGPU not supported'));
      await expect(createRenderer()).rejects.toThrow(RendererInitializationError);
    });

    it('calls onProgress during initialization', async () => {
      const onProgress = vi.fn();
      const r = await createRenderer({ onProgress });
      expect(onProgress).toHaveBeenCalled();
      r.destroy();
    });

    it('calls onFirstFrameRendered after first frame', async () => {
      const onFirstFrameRendered = vi.fn();
      const r = await createRenderer({ onFirstFrameRendered });
      expect(onFirstFrameRendered).toHaveBeenCalled();
      r.destroy();
    });

    it('starts render loop via requestVideoFrameCallback', async () => {
      const r = await createRenderer();
      const rvfc = (video as unknown as { requestVideoFrameCallback: ReturnType<typeof vi.fn> }).requestVideoFrameCallback;
      expect(rvfc).toHaveBeenCalled();
      r.destroy();
    });
  });

  describe('destroy()', () => {
    it('stops render loop by calling cancelVideoFrameCallback', async () => {
      const r = await createRenderer();
      r.destroy();
      const cvfc = (video as unknown as { cancelVideoFrameCallback: ReturnType<typeof vi.fn> }).cancelVideoFrameCallback;
      expect(cvfc).toHaveBeenCalled();
    });

    it('destroys all effect pipelines', async () => {
      const mockPipeline = createMockPipeline();
      mockBuildEffectPipelines.mockResolvedValue([mockPipeline]);
      const r = await createRenderer();
      r.destroy();
      expect(mockPipeline.destroy).toHaveBeenCalled();
    });

    it('unconfigures the WebGPU context', async () => {
      const r = await createRenderer();
      r.destroy();
      expect(mock.context.unconfigure).toHaveBeenCalled();
    });

    it('calls invalidatePreWarm', async () => {
      const r = await createRenderer();
      r.destroy();
      expect(mockInvalidatePreWarm).toHaveBeenCalled();
    });

    it('releases the device lease instead of destroying the device directly', async () => {
      const r = await createRenderer();
      r.destroy();
      expect(defaultLease.release).toHaveBeenCalled();
      const dev = mock.device as unknown as { destroy: ReturnType<typeof vi.fn> };
      expect(dev.destroy).not.toHaveBeenCalled();
    });

    it('releasing the lease does not destroy a device another lease still holds', async () => {
      let refCount = 0;
      const sharedDevice = mock.device;
      const makeSharedLease = () => {
        refCount += 1;
        return createMockLease(sharedDevice, mock.adapter, {
          onRelease: () => {
            refCount -= 1;
            if (refCount === 0) (sharedDevice.destroy as unknown as () => void)();
          },
        });
      };

      const rendererLease = makeSharedLease(); // renderer's lease (refCount 1)
      mockAcquireGPUDevice.mockResolvedValueOnce(rendererLease);
      const r = await createRenderer();
      const otherLease = makeSharedLease(); // another consumer (refCount 2)

      r.destroy();

      expect(rendererLease.release).toHaveBeenCalled();
      expect(sharedDevice.destroy).not.toHaveBeenCalled();

      otherLease.release();
      expect(sharedDevice.destroy).toHaveBeenCalledTimes(1);
    });

    it('is idempotent', async () => {
      const r = await createRenderer();
      r.destroy();
      expect(() => r.destroy()).not.toThrow();
    });
  });

  describe('device loss recovery', () => {
    it('recovers when device.lost reason !== "destroyed"', async () => {
      const r = await createRenderer();
      mockAcquireGPUDevice.mockClear();
      mock.deviceLostDeferred.resolve({ reason: 'unknown', message: 'lost' });
      await Promise.resolve(); await Promise.resolve();
      expect(mockAcquireGPUDevice).toHaveBeenCalled();
      r.destroy();
    });

    it('releases the old lease and acquires a fresh one during recovery', async () => {
      const r = await createRenderer();
      const oldLease = defaultLease;
      const newLease = createMockLease(mock.device, mock.adapter, {});
      mockAcquireGPUDevice.mockResolvedValueOnce(newLease);

      mock.deviceLostDeferred.resolve({ reason: 'unknown', message: 'lost' });
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

      expect(oldLease.release).toHaveBeenCalled();
      expect(mockAcquireGPUDevice).toHaveBeenCalledTimes(2);
      r.destroy();
    });

    it('does NOT recover when reason is "destroyed"', async () => {
      const r = await createRenderer();
      mockAcquireGPUDevice.mockClear();
      mock.deviceLostDeferred.resolve({ reason: 'destroyed', message: 'destroyed' });
      await Promise.resolve(); await Promise.resolve();
      expect(mockAcquireGPUDevice).not.toHaveBeenCalled();
      r.destroy();
    });

    it('does not recover after an intentional destroy', async () => {
      const r = await createRenderer();
      mockAcquireGPUDevice.mockClear();
      r.destroy();
      mock.deviceLostDeferred.resolve({ reason: 'destroyed', message: 'destroyed by release' });
      await Promise.resolve(); await Promise.resolve();
      expect(mockAcquireGPUDevice).not.toHaveBeenCalled();
      expect(defaultLease.release).toHaveBeenCalled();
    });

    it('prevents overlapping recovery', async () => {
      let resolveReq!: (v: GpuDeviceLease) => void;
      const hangingReq = new Promise<GpuDeviceLease>((res) => { resolveReq = res; });

      const r = await createRenderer();
      mockAcquireGPUDevice.mockClear();
      mockAcquireGPUDevice.mockReturnValue(hangingReq);

      mock.deviceLostDeferred.resolve({ reason: 'unknown', message: 'first' });
      await Promise.resolve();
      mock.deviceLostDeferred.resolve({ reason: 'unknown', message: 'second' });
      await Promise.resolve();

      expect(mockAcquireGPUDevice).toHaveBeenCalledTimes(1);

      resolveReq(createMockLease(mock.device, mock.adapter, {}));
      await Promise.resolve(); await Promise.resolve();
      r.destroy();
    });

    it('releases a lease acquired after destroy() while recovery was suspended', async () => {
      let resolveAcquire!: (lease: GpuDeviceLease) => void;
      const hangingAcquire = new Promise<GpuDeviceLease>((res) => { resolveAcquire = res; });

      const r = await createRenderer();
      mockAcquireGPUDevice.mockClear();
      mockAcquireGPUDevice.mockReturnValue(hangingAcquire);

      // Start recovery; it suspends awaiting the replacement device.
      mock.deviceLostDeferred.resolve({ reason: 'unknown', message: 'lost' });
      await Promise.resolve();

      // destroy() runs here while this.lease is still null, so it cannot release
      // the lease recovery is about to acquire. Without the post-await guard the
      // shared device's refCount would leak permanently.
      r.destroy();

      const replacement = createMockLease(mock.device, mock.adapter, {});
      resolveAcquire(replacement);
      for (let i = 0; i < 5; i++) await Promise.resolve();

      const internal = r as unknown as { isRecovering: boolean; lease: GpuDeviceLease | null };
      expect(replacement.release).toHaveBeenCalledTimes(1);
      expect(internal.lease).toBeNull();
      expect(internal.isRecovering).toBe(false);
    });

    it('tears down resources rebuilt after destroy() lands mid-recovery', async () => {
      let resolveBuild!: (pipelines: unknown[]) => void;
      const hangingBuild = new Promise<unknown[]>((res) => { resolveBuild = res; });

      const replacement = createMockLease(mock.device, mock.adapter, {});
      mockAcquireGPUDevice.mockResolvedValueOnce(replacement);

      const r = await createRenderer();
      mockBuildEffectPipelines.mockClear();
      mockBuildEffectPipelines.mockReturnValueOnce(hangingBuild as never);

      mock.deviceLostDeferred.resolve({ reason: 'unknown', message: 'lost' });
      // Drain microtasks until recovery is suspended inside buildPipelines().
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(mockBuildEffectPipelines).toHaveBeenCalledTimes(1);

      r.destroy();

      // Settling the build after destroy() makes recovery assign fresh pipelines
      // post-teardown; the abort path must destroy them and release the lease.
      const rebuiltPipeline = createMockPipeline();
      resolveBuild([rebuiltPipeline]);
      for (let i = 0; i < 8; i++) await Promise.resolve();

      const internal = r as unknown as { isRecovering: boolean; lease: GpuDeviceLease | null };
      expect(rebuiltPipeline.destroy).toHaveBeenCalled();
      expect(replacement.release).toHaveBeenCalledTimes(1);
      expect(internal.lease).toBeNull();
      expect(internal.isRecovering).toBe(false);
    });
  });

  describe('updateConfiguration()', () => {
    it('no change → no rebuild', async () => {
      mockParamsEqual.mockReturnValue(true);
      const r = await createRenderer();
      mockBuildEffectPipelines.mockClear();
      await r.updateConfiguration({ effects: DEFAULT_EFFECTS, targetDimensions: DEFAULT_DIMENSIONS });
      expect(mockBuildEffectPipelines).not.toHaveBeenCalled();
      r.destroy();
    });

    it('effects change → rebuild', async () => {
      const newEffects: EnhancementEffect[] = [{ id: 't/new', name: 'N', className: 'N', params: {} }];
      const r = await createRenderer();
      mockBuildEffectPipelines.mockClear();
      await r.updateConfiguration({ effects: newEffects, targetDimensions: DEFAULT_DIMENSIONS });
      expect(mockBuildEffectPipelines).toHaveBeenCalled();
      r.destroy();
    });

    it('dimensions change → rebuild', async () => {
      const r = await createRenderer();
      mockBuildEffectPipelines.mockClear();
      await r.updateConfiguration({ effects: DEFAULT_EFFECTS, targetDimensions: { width: 3840, height: 2160 } });
      expect(mockBuildEffectPipelines).toHaveBeenCalled();
      r.destroy();
    });

    it('restorePolicy change alone → rebuild', async () => {
      // Effects and dimensions are unchanged, so only the restore policy
      // differs; the policy must still rebuild or it would be a no-op.
      mockParamsEqual.mockReturnValue(true);
      const r = await createRenderer({ restorePolicy: 'off' });
      mockBuildEffectPipelines.mockClear();
      await r.updateConfiguration({
        effects: DEFAULT_EFFECTS,
        targetDimensions: DEFAULT_DIMENSIONS,
        restorePolicy: 'trailing',
      });
      expect(mockBuildEffectPipelines).toHaveBeenCalled();
      r.destroy();
    });

    it('unchanged restorePolicy → no rebuild', async () => {
      mockParamsEqual.mockReturnValue(true);
      const r = await createRenderer({ restorePolicy: 'trailing' });
      mockBuildEffectPipelines.mockClear();
      await r.updateConfiguration({
        effects: DEFAULT_EFFECTS,
        targetDimensions: DEFAULT_DIMENSIONS,
        restorePolicy: 'trailing',
      });
      expect(mockBuildEffectPipelines).not.toHaveBeenCalled();
      r.destroy();
    });

    it('does nothing when destroyed', async () => {
      const r = await createRenderer();
      r.destroy();
      mockBuildEffectPipelines.mockClear();
      await r.updateConfiguration({ effects: [], targetDimensions: DEFAULT_DIMENSIONS });
      expect(mockBuildEffectPipelines).not.toHaveBeenCalled();
    });
  });

  describe('buildPipelines generation guard', () => {
    const EFFECTS_A: EnhancementEffect[] = [{ id: 't/a', name: 'A', className: 'A', params: {} }];
    const EFFECTS_B: EnhancementEffect[] = [{ id: 't/b', name: 'B', className: 'B', params: {} }];

    it('does not let a superseded build clear the busy flag or overwrite the winner', async () => {
      const r = await createRenderer();
      mockBuildEffectPipelines.mockClear();

      let resolveLoser!: (pipelines: unknown[]) => void;
      let resolveWinner!: (pipelines: unknown[]) => void;
      mockBuildEffectPipelines
        .mockReturnValueOnce(new Promise<unknown[]>((res) => { resolveLoser = res; }))
        .mockReturnValueOnce(new Promise<unknown[]>((res) => { resolveWinner = res; }));

      const loserPipeline = createMockPipeline();
      const winnerPipeline = createMockPipeline();

      // Start two overlapping rebuilds; the second increments the generation and
      // therefore supersedes the first.
      const first = r.updateConfiguration({ effects: EFFECTS_A, targetDimensions: DEFAULT_DIMENSIONS });
      const second = r.updateConfiguration({ effects: EFFECTS_B, targetDimensions: DEFAULT_DIMENSIONS });

      const internal = r as unknown as { rebuilding: boolean; pipelines: unknown[] };

      // Both builds are in flight: the render loop must stay gated.
      expect(internal.rebuilding).toBe(true);

      // The losing (first) build settles while the winner is still running.
      resolveLoser([loserPipeline]);
      await first;

      // The loser must neither clear the flag nor apply its pipelines; its
      // result must be destroyed instead of dropped.
      expect(internal.rebuilding).toBe(true);
      expect(internal.pipelines).not.toContain(loserPipeline);
      expect(loserPipeline.destroy).toHaveBeenCalledTimes(1);

      // The winner settles, applies, and clears the flag.
      resolveWinner([winnerPipeline]);
      await second;

      expect(internal.rebuilding).toBe(false);
      expect(internal.pipelines).toContain(winnerPipeline);
      expect(winnerPipeline.destroy).not.toHaveBeenCalled();

      r.destroy();
    });

    it('applies a normal (non-superseded) build and clears the busy flag', async () => {
      const r = await createRenderer();
      mockBuildEffectPipelines.mockClear();

      const pipeline = createMockPipeline();
      mockBuildEffectPipelines.mockResolvedValueOnce([pipeline]);

      await r.updateConfiguration({ effects: EFFECTS_A, targetDimensions: DEFAULT_DIMENSIONS });

      const internal = r as unknown as { rebuilding: boolean; pipelines: unknown[] };
      expect(internal.rebuilding).toBe(false);
      expect(internal.pipelines).toContain(pipeline);

      r.destroy();
    });
  });

  describe('updateVideoSource()', () => {
    it('cancels the pending callback on the old video and arms one on the new video', async () => {
      const r = await createRenderer();
      const oldRvfc = video.requestVideoFrameCallback as ReturnType<typeof vi.fn>;
      const oldCvfc = video.cancelVideoFrameCallback as ReturnType<typeof vi.fn>;
      // Ensure the render loop has armed a pending callback on the old element.
      await vi.waitFor(() => expect(oldRvfc).toHaveBeenCalled());

      const videoB = createMockVideo();
      const newRvfc = videoB.requestVideoFrameCallback as ReturnType<typeof vi.fn>;
      oldCvfc.mockClear();

      await r.updateVideoSource(videoB);

      expect(oldCvfc).toHaveBeenCalled();
      await vi.waitFor(() => expect(newRvfc).toHaveBeenCalled());
      r.destroy();
    });

    it('is a no-op when the new source is the same video element', async () => {
      const r = await createRenderer();
      const oldRvfc = video.requestVideoFrameCallback as ReturnType<typeof vi.fn>;
      const oldCvfc = video.cancelVideoFrameCallback as ReturnType<typeof vi.fn>;
      await vi.waitFor(() => expect(oldRvfc).toHaveBeenCalled());

      oldRvfc.mockClear();
      oldCvfc.mockClear();

      await r.updateVideoSource(video);

      expect(oldCvfc).not.toHaveBeenCalled();
      expect(oldRvfc).not.toHaveBeenCalled();
      r.destroy();
    });

    it('does not re-arm a second loop while a frame is in flight', async () => {
      const r = await createRenderer();
      const oldRvfc = video.requestVideoFrameCallback as ReturnType<typeof vi.fn>;
      const oldCvfc = video.cancelVideoFrameCallback as ReturnType<typeof vi.fn>;
      await vi.waitFor(() => expect(oldRvfc).toHaveBeenCalled());

      const renderLoop = oldRvfc.mock.calls.at(-1)![0] as () => Promise<void>;
      oldRvfc.mockClear();
      oldCvfc.mockClear();

      const videoB = createMockVideo();
      const newRvfc = videoB.requestVideoFrameCallback as ReturnType<typeof vi.fn>;

      // Start a frame without awaiting it so frameInFlight stays true while
      // updateVideoSource runs.
      void renderLoop();

      await r.updateVideoSource(videoB);

      // Only the in-flight loop reschedules on the new element; the source
      // switch must not start a parallel loop.
      await vi.waitFor(() => expect(newRvfc).toHaveBeenCalled());
      expect(oldCvfc).not.toHaveBeenCalled();
      expect(newRvfc).toHaveBeenCalledTimes(1);
      r.destroy();
    });

    it('fires onFirstFrameRendered again after switching to a new element', async () => {
      const onFirstFrameRendered = vi.fn();
      const r = await createRenderer({ onFirstFrameRendered });
      await vi.waitFor(() => expect(onFirstFrameRendered).toHaveBeenCalledTimes(1));

      onFirstFrameRendered.mockClear();
      const videoB = createMockVideo();

      await r.updateVideoSource(videoB);

      await vi.waitFor(() => expect(onFirstFrameRendered).toHaveBeenCalledTimes(1));
      r.destroy();
    });
  });

  describe('destroy while a frame is in flight', () => {
    it('does not call onError or log a frame failure when destroyed mid-frame', async () => {
      // A pipeline pass that never resolves until the test releases it, so the
      // first frame is guaranteed to still be in flight when destroy() runs.
      let rejectPass!: (error: unknown) => void;
      const hangingPass = new Promise<void>((_resolve, reject) => {
        rejectPass = reject;
      });
      const pipeline = createMockPipeline();
      pipeline.pass.mockReturnValue(hangingPass);
      mockBuildEffectPipelines.mockResolvedValue([pipeline]);

      const onError = vi.fn();
      const errorSpy = vi.spyOn(console, 'error');
      const r = await createRenderer({ onError });

      // Tear down while processFrame() is awaiting the pipeline pass.
      r.destroy();

      // The in-flight frame now fails; the teardown artifact must be swallowed.
      rejectPass(new Error('context is not configured'));
      for (let i = 0; i < 5; i++) await Promise.resolve();

      expect(onError).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalledWith(
        '[Anime4KWebExt] Frame processing failed:',
        expect.anything(),
      );
      errorSpy.mockRestore();
    });
  });

  describe('visibility pause', () => {
    beforeEach(() => {
      // Ensure visibilityState starts as 'visible' before each test
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true, writable: true });
    });

    afterEach(() => {
      // Restore visibilityState to 'visible' after each test
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true, writable: true });
    });

    it('does not submit GPU commands when tab is hidden', async () => {
      // Set hidden before creating renderer so first frame is also skipped
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true, writable: true });
      const r = await createRenderer();
      const submitSpy = mock.device.queue.submit as ReturnType<typeof vi.fn>;
      expect(submitSpy).not.toHaveBeenCalled();
      r.destroy();
    });

    it('resumes rendering when tab becomes visible', async () => {
      // Start hidden — no GPU commands
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true, writable: true });
      const r = await createRenderer();
      const submitSpy = mock.device.queue.submit as ReturnType<typeof vi.fn>;
      expect(submitSpy).not.toHaveBeenCalled();

      const rvfc = video.requestVideoFrameCallback as ReturnType<typeof vi.fn>;
      rvfc.mockClear();

      // Simulate tab becoming visible
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true, writable: true });
      document.dispatchEvent(new Event('visibilitychange'));

      // The visibilitychange handler should cancel the pending callback and request an immediate one
      const cvfc = video.cancelVideoFrameCallback as ReturnType<typeof vi.fn>;
      expect(cvfc).toHaveBeenCalled();
      expect(rvfc).toHaveBeenCalled();
      r.destroy();
    });

    it('removes visibilitychange listener on destroy', async () => {
      const r = await createRenderer();
      r.destroy();

      // After destroy, dispatching visibilitychange should not throw or cause errors
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true, writable: true });
      expect(() => document.dispatchEvent(new Event('visibilitychange'))).not.toThrow();
    });
  });

  describe('onFrameRendered callback', () => {
    it('calls onFrameRendered after successful frame with frame time', async () => {
      const onFrameRendered = vi.fn();
      const r = await createRenderer({ onFrameRendered });

      expect(onFrameRendered).toHaveBeenCalledTimes(1);
      const frameTime = onFrameRendered.mock.calls[0][0];
      expect(typeof frameTime).toBe('number');
      expect(frameTime).toBeGreaterThanOrEqual(0);

      r.destroy();
    });

    it('passes the number of built pipelines (excluding the blit) as the third argument', async () => {
      const onFrameRendered = vi.fn();
      // Simulate a chain that builds N effect pipelines (one label each). The
      // final blit is timed separately and must not be represented here.
      mockBuildEffectPipelines.mockImplementation(async (params: { labels?: string[] }) => {
        params.labels?.push('ClampHighlights', 'DenoiseCNNx2VL', 'Downscale', 'CNNUL', 'ClampHighlightsApply');
        return [
          createMockPipeline(),
          createMockPipeline(),
          createMockPipeline(),
          createMockPipeline(),
          createMockPipeline(),
        ];
      });

      const r = await createRenderer({ onFrameRendered });

      // Drain the fire-and-forget first-frame render (one await per pipeline).
      for (let i = 0; i < 10; i++) await Promise.resolve();

      expect(onFrameRendered).toHaveBeenCalledTimes(1);
      expect(onFrameRendered.mock.calls[0][2]).toBe(5);

      r.destroy();
    });

    it('does not call onFrameRendered when frame is skipped (visibility hidden)', async () => {
      const onFrameRendered = vi.fn();
      // Set visibilityState to hidden so processFrame() skips rendering
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true, writable: true });

      const r = await Renderer.create({
        video: createMockVideo({ readyState: HAVE_ENOUGH_DATA }),
        canvas,
        effects: DEFAULT_EFFECTS,
        targetDimensions: DEFAULT_DIMENSIONS,
        onFrameRendered,
      });
      await Promise.resolve();

      // The first frame should be skipped because visibilityState is hidden
      expect(onFrameRendered).not.toHaveBeenCalled();

      // Restore visibility
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true, writable: true });
      r.destroy();
    });

    it('onFrameRendered is optional — no error when not provided', async () => {
      const r = await createRenderer(); // no onFrameRendered
      // Should not throw
      expect(() => r.destroy()).not.toThrow();
    });
  });

  describe('GPU timestamp profiling', () => {
    interface CapturedEncoder {
      beginRenderPass: ReturnType<typeof vi.fn>;
      resolveQuerySet: ReturnType<typeof vi.fn>;
      finish: ReturnType<typeof vi.fn>;
    }

    interface ProfilerAccess {
      profiler: { snapshot(): ProfilerSnapshot } | null;
    }

    /** Replace the mock's command encoder with a shared, inspectable one. */
    function captureCommandEncoder(): CapturedEncoder {
      const beginRenderPass = vi.fn(() => ({
        setPipeline: vi.fn(),
        setBindGroup: vi.fn(),
        draw: vi.fn(),
        end: vi.fn(),
      }));
      const resolveQuerySet = vi.fn();
      const finish = vi.fn(() => ({ label: 'command-buffer' }));
      mock.device.createCommandEncoder.mockImplementation(() => ({
        beginRenderPass,
        beginComputePass: vi.fn(() => ({
          setPipeline: vi.fn(),
          setBindGroup: vi.fn(),
          dispatchWorkgroups: vi.fn(),
          end: vi.fn(),
        })),
        resolveQuerySet,
        finish,
        copyTextureToTexture: vi.fn(),
        copyBufferToTexture: vi.fn(),
        copyBufferToBuffer: vi.fn(),
      }));
      return { beginRenderPass, resolveQuerySet, finish };
    }

    /**
     * Make profiler readback buffers settle deterministically so verification
     * and per-frame readback complete without manual pumping. `seed` fills the
     * staging buffer with ascending nanosecond timestamps; `reject` makes
     * verification fail.
     */
    function configureReadback(opts: { seed?: boolean; reject?: boolean } = {}): void {
      mock.device.createBuffer.mockImplementation((descriptor?: Record<string, unknown>) => {
        const usage = Number(descriptor?.usage ?? 0);
        const buffer = createMockGPUBuffer(Number(descriptor?.size ?? 0), usage);
        if ((usage & GPUBufferUsage.MAP_READ) !== 0) {
          buffer.mapAsync.mockImplementation(() => {
            if (opts.reject) return Promise.reject(new Error('readback map failed'));
            if (opts.seed) {
              for (let i = 0; i < buffer.data.length; i++) {
                buffer.data[i] = BigInt((i + 1) * 1_000_000);
              }
            }
            return Promise.resolve();
          });
        }
        return buffer;
      });
    }

    it('creates an active profiler and emits timestamped marker passes when enabled', async () => {
      mock.device.features.add('timestamp-query');
      configureReadback();
      const { beginRenderPass } = captureCommandEncoder();
      const onFrameRendered = vi.fn();

      const r = await createRenderer({ enableGpuTimings: true, onFrameRendered });

      expect(mock.device.createQuerySet).toHaveBeenCalled();

      // Baseline marker + one marker per pipeline + the timestamped final blit.
      const timestamped = beginRenderPass.mock.calls.filter(
        (call) => call[0]?.timestampWrites !== undefined,
      );
      expect(timestamped.length).toBeGreaterThanOrEqual(3);

      expect(onFrameRendered).toHaveBeenCalledTimes(1);
      const snapshot = onFrameRendered.mock.calls[0][1];
      expect(snapshot).not.toBeNull();
      expect(snapshot.status).toBe('active');

      r.destroy();
    });

    it('samples the first pipeline label in the happy path', async () => {
      mock.device.features.add('timestamp-query');
      configureReadback({ seed: true });

      const r = await createRenderer({ enableGpuTimings: true });

      await vi.waitFor(() => {
        const profiler = (r as unknown as ProfilerAccess).profiler;
        expect(profiler).not.toBeNull();
        expect(profiler!.snapshot().framesSampled).toBeGreaterThan(0);
      });

      const passes = (r as unknown as ProfilerAccess).profiler!.snapshot().passes;
      const first = passes.find((pass) => pass.gpuP50 !== undefined);
      expect(first?.label).toBe('pass 1');
      expect(first?.gpuP50).toBeGreaterThan(0);

      r.destroy();
    });

    it('disambiguates repeated pipeline labels so every pass gets its own row', async () => {
      mock.device.features.add('timestamp-query');
      configureReadback({ seed: true });
      captureCommandEncoder();
      // A+A/ultra with "Fast mode" off runs CNNUL three times. The profiler keys
      // stats by label, so without disambiguation all three collapse into one row
      // even though the chain genuinely has three passes.
      mockBuildEffectPipelines.mockImplementation(async (params: { labels?: string[] }) => {
        params.labels?.push(
          'ClampHighlights', 'CNNUL', 'CNNx2UL', 'Downscale', 'CNNUL', 'CNNUL', 'ClampHighlightsApply',
        );
        return Array.from({ length: 7 }, () => createMockPipeline());
      });

      const r = await createRenderer({ enableGpuTimings: true });

      const profiler = (r as unknown as ProfilerAccess).profiler!;
      await vi.waitFor(() => {
        expect(profiler.snapshot().framesSampled).toBeGreaterThan(0);
      });

      // The presentation blit is timed separately; assert only the chain rows.
      expect(
        profiler.snapshot().passes
          .map((pass) => pass.label)
          .filter((label) => label !== 'blit'),
      ).toEqual([
        'ClampHighlights',
        'CNNUL',
        'CNNx2UL',
        'Downscale',
        'CNNUL #2',
        'CNNUL #3',
        'ClampHighlightsApply',
      ]);

      r.destroy();
    });

    it('still presents and calls back when verification fails', async () => {
      mock.device.features.add('timestamp-query');
      configureReadback({ reject: true });
      const { beginRenderPass, finish } = captureCommandEncoder();
      const onFrameRendered = vi.fn();

      const r = await createRenderer({ enableGpuTimings: true, onFrameRendered });

      // The failed profiler is discarded; the presentation path still runs and
      // the final (blit) pass carries no timestamp writes.
      expect(mock.context.getCurrentTexture).toHaveBeenCalled();
      const lastPass = beginRenderPass.mock.calls.at(-1)?.[0];
      expect(lastPass?.timestampWrites).toBeUndefined();

      // The presentation blit is still encoded and submitted.
      expect(finish).toHaveBeenCalled();
      expect(mock.device.queue.submit).toHaveBeenCalled();
      expect(onFrameRendered).toHaveBeenCalledTimes(1);
      expect(onFrameRendered.mock.calls[0][1]).toBeNull();

      r.destroy();
    });

    it('does not enable the profiler when enableGpuTimings is false', async () => {
      mock.device.features.add('timestamp-query');
      configureReadback();
      const { beginRenderPass } = captureCommandEncoder();
      const onFrameRendered = vi.fn();

      const r = await createRenderer({ enableGpuTimings: false, onFrameRendered });

      expect(mock.device.createQuerySet).not.toHaveBeenCalled();
      const timestamped = beginRenderPass.mock.calls.filter(
        (call) => call[0]?.timestampWrites !== undefined,
      );
      expect(timestamped).toHaveLength(0);
      expect(onFrameRendered).toHaveBeenCalledTimes(1);
      expect(onFrameRendered.mock.calls[0][1]).toBeNull();

      r.destroy();
    });

    it('stays inert when the timestamp-query feature is absent', async () => {
      // The feature is intentionally not added to the mock device.
      const { beginRenderPass } = captureCommandEncoder();
      const onFrameRendered = vi.fn();

      const r = await createRenderer({ enableGpuTimings: true, onFrameRendered });

      expect(mock.device.createQuerySet).not.toHaveBeenCalled();
      const timestamped = beginRenderPass.mock.calls.filter(
        (call) => call[0]?.timestampWrites !== undefined,
      );
      expect(timestamped).toHaveLength(0);
      expect(onFrameRendered).toHaveBeenCalledTimes(1);
      expect(onFrameRendered.mock.calls[0][1]).toBeNull();

      r.destroy();
    });

    it('destroys the profiler on renderer destroy', async () => {
      mock.device.features.add('timestamp-query');
      configureReadback();
      const r = await createRenderer({ enableGpuTimings: true });

      const querySet = mock.device.createQuerySet.mock.results[0]?.value as
        | { destroy: ReturnType<typeof vi.fn> }
        | undefined;
      expect(querySet).toBeDefined();

      r.destroy();

      expect(querySet!.destroy).toHaveBeenCalled();
    });
  });

  describe('DRM/EME canvas-2D fallback (differentiator)', () => {
    // A recording OffscreenCanvas so tests can assert the 2D intermediary path was used
    // and control whether frame validation sees black / tainted pixels.
    let imageData: Uint8ClampedArray;
    let imageDataError: Error | null;
    let recordingCanvases: RecordingOffscreenCanvas[];
    let queueCopy: ReturnType<typeof vi.fn>;

    class RecordingOffscreenCanvas {
      width: number;
      height: number;
      ctx: {
        fillRect: ReturnType<typeof vi.fn>;
        drawImage: ReturnType<typeof vi.fn>;
        getImageData: ReturnType<typeof vi.fn>;
      };
      constructor(w: number, h: number) {
        this.width = w;
        this.height = h;
        this.ctx = {
          fillRect: vi.fn(),
          drawImage: vi.fn(),
          getImageData: vi.fn(() => {
            if (imageDataError) throw imageDataError;
            return { data: imageData };
          }),
        };
        recordingCanvases.push(this);
      }
      getContext(_type: string) {
        return this.ctx;
      }
    }

    beforeEach(() => {
      imageData = new Uint8ClampedArray([100, 100, 100, 255]);
      imageDataError = null;
      recordingCanvases = [];
      vi.stubGlobal('OffscreenCanvas', RecordingOffscreenCanvas);
      queueCopy = mock.device.queue.copyExternalImageToTexture as ReturnType<typeof vi.fn>;
    });

    function throwBackResourceFor(match: (source: unknown) => boolean): void {
      queueCopy.mockImplementation((src: { source?: unknown }) => {
        if (match(src?.source)) {
          const err = new Error("Source texture doesn't have back resource");
          err.name = 'OperationError';
          throw err;
        }
      });
    }

    async function retryFirstFrame(video: HTMLVideoElement): Promise<() => Promise<void>> {
      const rvfc = video.requestVideoFrameCallback as ReturnType<typeof vi.fn>;
      await vi.waitFor(() => expect(rvfc).toHaveBeenCalled());
      return rvfc.mock.calls.at(-1)![0] as () => Promise<void>;
    }

    it('switches to a canvas-2D intermediary when direct copy reports no back resource', async () => {
      const drmVideo = createMockVideo();
      throwBackResourceFor((source) => source === drmVideo);

      const onError = vi.fn();
      const r = await createRenderer({ video: drmVideo, onError });

      const retry = await retryFirstFrame(drmVideo);
      await retry();

      const drmCanvas = recordingCanvases.find((c) => c.width === 1920 && c.height === 1080);
      expect(drmCanvas).toBeDefined();
      expect(drmCanvas!.ctx.drawImage).toHaveBeenCalledWith(drmVideo, 0, 0);
      expect(queueCopy).toHaveBeenCalledWith(
        expect.objectContaining({ source: drmCanvas }),
        expect.anything(),
        expect.anything(),
      );
      expect(onError).not.toHaveBeenCalled();

      r.destroy();
    });

    it('rejects an all-black DRM canvas frame (hardware DRM / Widevine L1)', async () => {
      imageData = new Uint8ClampedArray([0, 0, 0, 255]);
      const drmVideo = createMockVideo();
      throwBackResourceFor((source) => source === drmVideo);

      const onError = vi.fn();
      const r = await createRenderer({ video: drmVideo, onError });

      const retry = await retryFirstFrame(drmVideo);
      await retry();

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0][0].message).toMatch(/DRM|copy protection/);

      r.destroy();
    });

    it('rejects a tainted DRM canvas whose getImageData throws', async () => {
      imageDataError = Object.assign(new Error('Tainted canvas'), { name: 'SecurityError' });
      const drmVideo = createMockVideo();
      throwBackResourceFor((source) => source === drmVideo);

      const onError = vi.fn();
      const r = await createRenderer({ video: drmVideo, onError });

      const retry = await retryFirstFrame(drmVideo);
      await retry();

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0][0].message).toMatch(/DRM|copy protection/);

      r.destroy();
    });

    it('reports an unrecoverable error when the canvas-2D fallback also fails', async () => {
      const drmVideo = createMockVideo();
      throwBackResourceFor(
        (source) => source === drmVideo || source instanceof RecordingOffscreenCanvas,
      );

      const onError = vi.fn();
      const r = await createRenderer({ video: drmVideo, onError });

      const retry = await retryFirstFrame(drmVideo);
      await retry();

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0][0].message).toContain('Canvas 2D fallback failed');

      r.destroy();
    });
  });
});
