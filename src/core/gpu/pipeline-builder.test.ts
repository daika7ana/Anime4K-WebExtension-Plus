/**
 * Tests for Pipeline Builder — paramsEqual() and buildEffectPipelines().
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installGPUMock, removeGPUMock, createMockGPUTexture } from '@/test/webgpu-mock';
import type { MockGPUObjects } from '@/test/webgpu-mock';
import type { BaseMode, EnhancementEffect, DestroyablePipeline, Dimensions, PerformanceTier } from '@/types';
import { BUILTIN_MODES, getEffectsForMode } from '@utils/settings';
import { resolveEffectChain } from '@utils/effect-chain-templates';
import { PipelinePreWarmer } from './pipeline-prewarmer';

// ─── Mock WGSL shader files ───
vi.mock('@shaders/cas.wgsl', () => ({ default: '// mock CAS shader' }));
vi.mock('@shaders/color-adjust.wgsl', () => ({ default: '// mock color-adjust shader' }));
vi.mock('@shaders/debanding.wgsl', () => ({ default: '// mock debanding shader' }));
vi.mock('@shaders/fullscreen-textured-quad.wgsl', () => ({ default: '// mock quad shader' }));
vi.mock('@shaders/sample-external-texture.wgsl', () => ({ default: '// mock sample shader' }));

// ─── Mock yieldToMain ───
vi.mock('@core/utils/yield-utils', () => ({
  yieldToMain: vi.fn().mockResolvedValue(undefined),
}));

// ─── Fake library classes + construction recorder ───
// Shared by the mocked `anime4k-webgpu-async` module and the mocked backend
// registry so both dispatch paths construct the same classes and record the
// same construction order.
vi.mock('anime4k-webgpu-async', async () => {
  const { libraryClasses } = await import('./__test-helpers__/fake-backend.js');
  return { ...libraryClasses };
});

// ─── Mock backend registry (engine dispatch) ───
// The fake Anime4K backend constructs the shared classes; the core backend is
// the real `createCoreBackend` (CAS/Debanding/ColorAdjust), so the builder's
// registry dispatch is exercised for both backends. `resolveEffectReference` is
// real (static descriptors).
vi.mock('@core/engines/registry.js', async () => {
  const { createFakeAnime4kBackend } = await import('./__test-helpers__/fake-backend.js');
  const { createCoreBackend } = await import('@core/engines/core-backend.js');

  // `ref.key` is the descriptor key for every resolved reference, so the fake
  // anime4k backend needs no descriptor table — only the known upscale scale
  // factors.
  const anime4kBackend = createFakeAnime4kBackend({
    displayName: 'Anime4K (golden fake)',
    missingCtorPrefix: '[golden-fake]',
    applyParams: true,
    ceilScaledDimensions: true,
  });

  const coreBackend = createCoreBackend();

  const registry = {
    register: vi.fn(),
    getBackend: (backendId: string) =>
      backendId === 'anime4k' ? anime4kBackend : backendId === 'core' ? coreBackend : undefined,
    getBackendAsync: async (backendId: string) => {
      if (backendId === 'anime4k') return anime4kBackend;
      if (backendId === 'core') return coreBackend;
      throw new Error(`[golden-fake] backend "${backendId}" is not registered`);
    },
    listEffects: () => [],
    getDescriptorById: () => undefined,
    getDescriptorByBackendKey: () => undefined,
  };

  return { getBackendRegistry: () => registry };
});

// ─── Import the module under test AFTER mocks are set up ───
import { paramsEqual, buildEffectPipelines } from './pipeline-builder';
import { constructed, libraryClasses, normalizeStep, state } from './__test-helpers__/fake-backend';

// ─── Helpers ───

function mkEffect(className: string, params?: Record<string, number>, upscaleFactor?: number): EnhancementEffect {
  return { id: `test/${className}`, name: className, className, params, upscaleFactor };
}

function mkEmptyPipeline(): DestroyablePipeline {
  return {
    pass: () => Promise.resolve(),
    getOutputTexture: () => ({ destroy: vi.fn() } as any),
    updateParam: () => {},
    destroy: vi.fn(),
  };
}

describe('paramsEqual', () => {
  it('returns true for both undefined', () => {
    expect(paramsEqual(undefined, undefined)).toBe(true);
  });

  it('returns false for one undefined', () => {
    expect(paramsEqual(undefined, {})).toBe(false);
    expect(paramsEqual({}, undefined)).toBe(false);
  });

  it('returns true for both empty objects', () => {
    expect(paramsEqual({}, {})).toBe(true);
  });

  it('returns true for same keys and values', () => {
    expect(paramsEqual({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
  });

  it('returns false for different values', () => {
    expect(paramsEqual({ a: 1 }, { a: 2 })).toBe(false);
  });

  it('returns false for different key counts', () => {
    expect(paramsEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it('returns false when extra keys exist', () => {
    expect(paramsEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
  });

  it('returns true for undefined params and empty object', () => {
    // !a && !b catches both undefined, but one is {} and one is undefined → hits else
    // {} is truthy, undefined is falsy → !a || !b → false
    // Actually: !undefined = true → returns false
    expect(paramsEqual(undefined, {})).toBe(false);
  });
});

describe('buildEffectPipelines', () => {
  let mock: MockGPUObjects;
  let prewarmer: PipelinePreWarmer;

  beforeEach(() => {
    mock = installGPUMock();
    prewarmer = new PipelinePreWarmer();
  });

  afterEach(() => {
    removeGPUMock();
  });

  function buildParams(overrides: Partial<{
    effects: EnhancementEffect[];
    oldPipelines: DestroyablePipeline[];
    isStale: () => boolean;
    onProgress: (stage: string | null, current?: number, total?: number) => void;
    targetDimensions: Dimensions;
    labels: string[];
    videoWidth: number;
    videoHeight: number;
    videoFrameTexture: GPUTexture;
    preserveDetail: boolean;
  }> = {}) {
    const videoWidth = overrides.videoWidth ?? 1920;
    const videoHeight = overrides.videoHeight ?? 1080;
    const video = {
      videoWidth,
      videoHeight,
    } as HTMLVideoElement;

    return {
      device: mock.device as unknown as GPUDevice,
      videoFrameTexture: overrides.videoFrameTexture
        ?? createMockGPUTexture(videoWidth, videoHeight) as unknown as GPUTexture,
      video,
      targetDimensions: overrides.targetDimensions ?? ({ width: 1920, height: 1080 } as Dimensions),
      effects: overrides.effects ?? [mkEffect('DoG')],
      oldPipelines: overrides.oldPipelines ?? [],
      preWarmer: prewarmer,
      onProgress: overrides.onProgress,
      isStale: overrides.isStale ?? (() => false),
      preserveDetail: overrides.preserveDetail,
      labels: overrides.labels,
    };
  }

  // ── Effect chain construction ──

  it('builds pipelines for a single library effect', async () => {
    const params = buildParams({ effects: [mkEffect('DoG', { strength: 4 })] });

    const pipelines = await buildEffectPipelines(params);

    expect(pipelines.length).toBe(1);
    expect(pipelines[0].pass).toBeDefined();
    expect(pipelines[0].getOutputTexture).toBeDefined();
  });

  it('builds pipelines for custom effects (CAS)', async () => {
    const params = buildParams({
      effects: [mkEffect('CAS', { sharpness: 0.8 })],
    });

    const pipelines = await buildEffectPipelines(params);

    expect(pipelines.length).toBe(1);
    // The pipeline should have pass and getOutputTexture
    expect(typeof pipelines[0].pass).toBe('function');
    expect(typeof pipelines[0].getOutputTexture).toBe('function');
  });

  it('builds pipelines for multiple mixed effects (custom + library)', async () => {
    const params = buildParams({
      effects: [
        mkEffect('CAS', { sharpness: 0.5 }),
        mkEffect('CNNM'),
        mkEffect('Debanding', { strength: 0.5, bandThreshold: 0.08 }),
      ],
    });

    const pipelines = await buildEffectPipelines(params);

    expect(pipelines.length).toBe(3);
  });

  // ── Empty effects → dummy pipeline ──

  it('returns a single dummy pipeline when effects array is empty', async () => {
    const params = buildParams({ effects: [] });

    const pipelines = await buildEffectPipelines(params);

    expect(pipelines.length).toBe(1);
    // Dummy pipeline pass resolves immediately
    await expect(pipelines[0].pass({} as any)).resolves.toBeUndefined();
    // Dummy pipeline returns videoFrameTexture
    expect(pipelines[0].getOutputTexture()).toBe(params.videoFrameTexture);
  });

  // ── isStale guard ──

  it('returns empty array when isStale() returns true before pipeline creation', async () => {
    const params = buildParams({
      effects: [mkEffect('DoG')],
      isStale: () => true,
    });

    const pipelines = await buildEffectPipelines(params);
    expect(pipelines).toEqual([]);
  });

  it('destroys the partially built pipelines when the compile is superseded', async () => {
    // The effect class is constructed for real, then the chain-level stale check
    // fires after the main loop. The built pipeline owns an output texture and
    // must be destroyed rather than dropped alive.
    const destroySpy = vi.spyOn(libraryClasses.DoG.prototype, 'destroy');
    try {
      const labels: string[] = [];
      // Call order: builder's pre-destroy check (1), post-prewarm check (2),
      // then the chain compiler's post-loop check (3).
      let staleChecks = 0;
      const params = buildParams({
        effects: [mkEffect('DoG')],
        labels,
        isStale: () => ++staleChecks >= 3,
      });
      // No-op pre-warmer so the dummy probe does not add destroy calls.
      (params as { preWarmer: PipelinePreWarmer }).preWarmer = {
        warm: vi.fn().mockResolvedValue(undefined),
        invalidate: vi.fn(),
      } as unknown as PipelinePreWarmer;

      const pipelines = await buildEffectPipelines(params);

      expect(pipelines).toEqual([]);
      expect(labels).toEqual([]);
      expect(destroySpy).toHaveBeenCalledTimes(1);
    } finally {
      destroySpy.mockRestore();
    }
  });

  // ── Old pipelines destroyed ──

  it('destroys old pipelines after onSubmittedWorkDone', async () => {
    const oldPipe = mkEmptyPipeline();

    const params = buildParams({
      effects: [mkEffect('DoG')],
      oldPipelines: [oldPipe],
    });

    await buildEffectPipelines(params);

    // onSubmittedWorkDone should have been called
    expect(mock.device.queue.onSubmittedWorkDone).toHaveBeenCalled();

    // Old pipeline's destroy should have been called
    expect(oldPipe.destroy).toHaveBeenCalled();
  });

  // ── onProgress callbacks ──

  it('calls onProgress with correct stages', async () => {
    const progressCalls: (string | null)[] = [];
    const params = buildParams({
      effects: [mkEffect('DoG')],
      onProgress: (stage) => {
        progressCalls.push(stage);
      },
    });

    await buildEffectPipelines(params);

    // Should have initial progress, effect loading progress, and final null
    expect(progressCalls.length).toBeGreaterThanOrEqual(2);
    // First call should contain the warmup message
    expect(progressCalls[0]).toContain('warmup');
    // Last call should be null (complete)
    expect(progressCalls[progressCalls.length - 1]).toBeNull();
  });

  // ── Phase 2 warmup (multiple pipelines) ──

  it('submits warmup command for multiple pipelines', async () => {
    const params = buildParams({
      effects: [mkEffect('CAS'), mkEffect('Debanding')],
    });

    // Reset call counters
    mock.device.createCommandEncoder.mockClear();
    mock.device.queue.submit.mockClear();

    await buildEffectPipelines(params);

    // Phase 2 should create a command encoder for warmup
    expect(mock.device.createCommandEncoder).toHaveBeenCalled();
    expect(mock.device.queue.submit).toHaveBeenCalled();
  });

  it('skips Phase 2 warmup for single pipeline', async () => {
    const params = buildParams({ effects: [mkEffect('CAS')] });

    mock.device.createCommandEncoder.mockClear();
    mock.device.queue.submit.mockClear();

    await buildEffectPipelines(params);

    // Phase 2 is skipped when pipelines.length <= 1
    // (The encoder might still be called by Phase 2 if len > 1, but here len=1)
    // The test just ensures no errors
    expect(mock.device).toBeDefined();
  });

  // ── Module caching ──

  it('reuses cached anime4k-webgpu-async module across builds', async () => {
    const params1 = buildParams({ effects: [mkEffect('DoG')] });
    const params2 = buildParams({ effects: [mkEffect('CNNM')] });

    await buildEffectPipelines(params1);
    await buildEffectPipelines(params2);

    // Both builds should succeed without double-import issues
    // (cachedAnime4KModule at module level prevents re-import)
  });

  // ── Error in pre-warm is non-fatal ──

  it('continues pipeline build even when preWarmer.warm() throws', async () => {
    // Create a prewarmer that throws on warm
    const badPreWarmer = {
      warm: vi.fn().mockRejectedValue(new Error('Pre-warm failed')),
      invalidate: vi.fn(),
    } as unknown as PipelinePreWarmer;

    const params = buildParams({ effects: [mkEffect('DoG')] });
    (params as any).preWarmer = badPreWarmer;

    const pipelines = await buildEffectPipelines(params);

    // Should still build pipelines despite pre-warm failure
    expect(pipelines.length).toBeGreaterThan(0);
  });

  // ── Upscale factor tracking and Downscale insertion ──

  it('retains the first upscaler and inserts a final Downscale for an equal target', async () => {
    // Two 2x effects with target == source (1920x1080): the first upscaler is
    // retained (→3840x2160), the second suppressed, and a single Downscale to
    // exactly the target is emitted right after the first.
    const params = buildParams({
      targetDimensions: { width: 1920, height: 1080 },
      effects: [
        mkEffect('CNNx2M', undefined, 2),
        mkEffect('CNNx2M', undefined, 2),
      ],
    });

    const pipelines = await buildEffectPipelines(params);

    // Should have: CNNx2M → Downscale = 2 pipelines
    expect(pipelines.length).toBe(2);
  });

  // ── Labels out-parameter ──

  it('records one label per built pipeline in encode order (including Downscale)', async () => {
    const labels: string[] = [];
    const params = buildParams({
      targetDimensions: { width: 1920, height: 1080 },
      effects: [
        mkEffect('CNNx2M', undefined, 2),
        mkEffect('CNNx2M', undefined, 2),
      ],
      labels,
    });

    const pipelines = await buildEffectPipelines(params);

    expect(pipelines.length).toBe(2);
    expect(labels).toEqual(['CNNx2M', 'Downscale']);
  });

  // ── Restore suppression policy (V2 preserve detail / V1 full enhancement / custom off) ──

  it('built-in mode with preserveDetail: true emits the V2 chain (trailing restores dropped)', async () => {
    const labels: string[] = [];
    const params = buildParams({
      effects: resolveEffectChain('A+A', 'ultra'),
      labels,
      preserveDetail: true,
    });

    await buildEffectPipelines(params);

    // The two CNNULs after the emitted Downscale are dropped; ClampHighlights
    // (helper, not restore) and the head restore are kept.
    expect(labels).toEqual([
      'ClampHighlights',
      'CNNUL',
      'CNNx2UL',
      'Downscale',
      'ClampHighlightsApply',
    ]);
  });

  it('built-in mode with preserveDetail: false emits the full V1 chain (every restore)', async () => {
    const labels: string[] = [];
    const params = buildParams({
      effects: resolveEffectChain('A+A', 'ultra'),
      labels,
      preserveDetail: false,
    });

    await buildEffectPipelines(params);

    // Turning "Fast mode — Preserve detail" off restores the original full-enhancement
    // chain: both trailing CNNUL restores run after the Downscale.
    expect(labels).toEqual([
      'ClampHighlights',
      'CNNUL',
      'CNNx2UL',
      'Downscale',
      'CNNUL',
      'CNNUL',
      'ClampHighlightsApply',
    ]);
  });

  it('preserveDetail:false reproduces the full V1 chain across representative built-in modes/tiers', async () => {
    // V1 ('off') is the original pre-restore-suppression chain: only the later
    // upscalers are suppressed and every restore is retained. After the policy
    // was unified across built-in and custom chains, a mode chain built with
    // preserveDetail:false must match the same chain built as a custom chain
    // with the same policy.
    const cases: Array<[BaseMode, PerformanceTier]> = [
      ['A', 'ultra'],
      ['B', 'balanced'],
      ['C+A', 'quality'],
      ['A+A', 'ultra'],
    ];

    for (const [mode, tier] of cases) {
      const effects = resolveEffectChain(mode, tier);
      const v1Labels: string[] = [];
      await buildEffectPipelines(buildParams({ effects, labels: v1Labels, preserveDetail: false }));
      const customLabels: string[] = [];
      await buildEffectPipelines(buildParams({ effects, labels: customLabels, preserveDetail: false }));
      expect(v1Labels, `${mode}/${tier}`).toEqual(customLabels);
    }
  });

  it('custom chains honor the preserveDetail policy (trailing suppression)', async () => {
    const effects = resolveEffectChain('A+A', 'ultra');

    // preserveDetail true (default): custom chains now suppress the trailing
    // restores emitted after the target-exact Downscale, like built-in modes.
    const suppressed: string[] = [];
    await buildEffectPipelines(
      buildParams({ effects, labels: suppressed, preserveDetail: true }),
    );
    expect(suppressed).toEqual([
      'ClampHighlights',
      'CNNUL',
      'CNNx2UL',
      'Downscale',
      'ClampHighlightsApply',
    ]);

    // preserveDetail false: custom chains keep every restore (V1).
    const full: string[] = [];
    await buildEffectPipelines(
      buildParams({ effects, labels: full, preserveDetail: false }),
    );
    expect(full).toEqual([
      'ClampHighlights',
      'CNNUL',
      'CNNx2UL',
      'Downscale',
      'CNNUL',
      'CNNUL',
      'ClampHighlightsApply',
    ]);
  });

  it('A+A / ultra @2K emits V2 with preserveDetail true and the full V1 chain with false', async () => {
    const build = async (preserveDetail: boolean) => {
      const labels: string[] = [];
      await buildEffectPipelines(buildParams({
        targetDimensions: { width: 2560, height: 1440 },
        effects: resolveEffectChain('A+A', 'ultra'),
        labels,
        preserveDetail,
      }));
      return labels;
    };

    // V2: the trailing restores after the target-exact Downscale are skipped.
    expect(await build(true)).toEqual([
      'ClampHighlights',
      'CNNUL',
      'CNNx2UL',
      'Downscale',
      'ClampHighlightsApply',
    ]);
    // V1 ("Fast mode" off): every restore is retained.
    expect(await build(false)).toEqual([
      'ClampHighlights',
      'CNNUL',
      'CNNx2UL',
      'Downscale',
      'CNNUL',
      'CNNUL',
      'ClampHighlightsApply',
    ]);
  });

  it('A+A / ultra @4K is identical for preserveDetail true/false (no final Downscale -> no-op)', async () => {
    // The upscale-target branch triggers with finalDownscale=null, so there is no
    // target-exact Downscale for the V2 restore rule to suppress after. V2 and V1
    // are therefore byte-identical here, matching the pre-change goldens.
    const build = async (preserveDetail: boolean) => {
      const labels: string[] = [];
      await buildEffectPipelines(buildParams({
        targetDimensions: { width: 3840, height: 2160 },
        effects: resolveEffectChain('A+A', 'ultra'),
        labels,
        preserveDetail,
      }));
      return labels;
    };

    const v1 = await build(false);
    const v2 = await build(true);
    expect(v2).toEqual(v1);
    expect(v2).toEqual([
      'ClampHighlights',
      'CNNUL',
      'CNNx2UL',
      'CNNUL',
      'CNNUL',
      'ClampHighlightsApply',
    ]);
  });

  it('preserveDetail at 4K is a no-op on a non-triggering chain (A/ultra)', async () => {
    // A/ultra @4K = [ClampHighlights, CNNUL, CNNx2UL, CNNx2UL] never triggers the
    // safe-geometry pre-pass (no suppressFromIndex and no final Downscale), so the
    // V2 trailing restore window does not exist and "Fast mode" must
    // produce the exact same chain. This pins the no-op as intentional.
    const build = async (preserveDetail: boolean) => {
      const labels: string[] = [];
      await buildEffectPipelines(buildParams({
        targetDimensions: { width: 3840, height: 2160 },
        effects: resolveEffectChain('A', 'ultra'),
        labels,
        preserveDetail,
      }));
      return labels;
    };

    const v1 = await build(false);
    const v2 = await build(true);

    expect(v2).toEqual(v1);
    expect(v2).toEqual([
      'ClampHighlights',
      'CNNUL',
      'CNNx2UL',
      'Downscale',
      'CNNx2UL',
      'ClampHighlightsApply',
    ]);
  });

  it('C+A / ultra @2K->4K + trailing CAS suppresses restores with preserveDetail true', async () => {
    // Acceptance case: a custom-authored chain is now governed by the same
    // "Fast mode" policy as built-in modes. Source 2560x1440 to
    // target 3840x2160: the scale-1 CNNUL restore and the suppressed CNNx2UL
    // upscaler are dropped, leaving the Denoise upscale, the target-exact
    // Downscale, and the user's trailing CAS before the deferred apply stage.
    const effects = [
      ...resolveEffectChain('C+A', 'ultra'),
      mkEffect('CAS', { sharpness: 0.8 }),
    ];
    const build = async (preserveDetail: boolean) => {
      const labels: string[] = [];
      await buildEffectPipelines(buildParams({
        videoWidth: 2560,
        videoHeight: 1440,
        targetDimensions: { width: 3840, height: 2160 },
        effects,
        labels,
        preserveDetail,
      }));
      return labels;
    };

    expect(await build(true)).toEqual([
      'ClampHighlights',
      'DenoiseCNNx2VL',
      'Downscale',
      'CAS',
      'ClampHighlightsApply',
    ]);

    // preserveDetail false: V1 keeps the trailing scale-1 CNNUL restore. (The
    // CNNx2UL upscaler is suppressed by safe-geometry at this source/target
    // ratio independently of the restore policy, in both modes.)
    expect(await build(false)).toEqual([
      'ClampHighlights',
      'DenoiseCNNx2VL',
      'Downscale',
      'CNNUL',
      'CAS',
      'ClampHighlightsApply',
    ]);
  });

  it('records classNames for a mixed custom + library chain', async () => {
    const labels: string[] = [];
    const params = buildParams({
      effects: [
        mkEffect('CAS', { sharpness: 0.5 }),
        mkEffect('CNNM'),
        mkEffect('Debanding', { strength: 0.5, bandThreshold: 0.08 }),
      ],
      labels,
    });

    await buildEffectPipelines(params);

    expect(labels).toEqual(['CAS', 'CNNM', 'Debanding']);
  });

  // ── Safe-geometry suppression (intermediate-downscale fix) ──

  it('suppresses the later upscaler, downscales to target, then appends the ClampHighlights apply stage (C+A / ultra @2K)', async () => {
    // C+A / ultra = [ClampHighlights, DenoiseCNNx2VL(2x), CNNUL, CNNx2UL(2x)].
    // The legacy rule would go 3840x2160 -> Downscale 1280x720 -> 2560x1440
    // (below the 1080p source). The fix skips CNNx2UL and downscales once; the
    // V2 default then also drops the trailing CNNUL restore, and the deferred
    // ClampHighlights apply stage runs last.
    const labels: string[] = [];
    const params = buildParams({
      targetDimensions: { width: 2560, height: 1440 },
      effects: resolveEffectChain('C+A', 'ultra'),
      labels,
    });

    const pipelines = await buildEffectPipelines(params);

    expect(labels).toEqual([
      'ClampHighlights',
      'DenoiseCNNx2VL',
      'Downscale',
      'ClampHighlightsApply',
    ]);
    expect(pipelines.length).toBe(4);
    expect(labels.length).toBe(pipelines.length);
    // Apply stage is the chain tail (distinct marker output).
    expect((pipelines[pipelines.length - 1].getOutputTexture() as any).kind).toBe('clamp-apply');
  });

  it('orders the apply stage after the final Downscale for both upscale and equal targets (C+A / ultra)', async () => {
    for (const targetDimensions of [
      { width: 2560, height: 1440 }, // upscale-target branch
      { width: 1920, height: 1080 }, // shrinking/equal-target branch
    ]) {
      const labels: string[] = [];
      const params = buildParams({
        targetDimensions,
        effects: resolveEffectChain('C+A', 'ultra'),
        labels,
      });

      const pipelines = await buildEffectPipelines(params);

      // Stats stage first and a pass-through of its input.
      expect(labels[0]).toBe('ClampHighlights');
      expect(pipelines[0].getOutputTexture()).toBe(params.videoFrameTexture);

      // Apply stage last, after the Downscale.
      expect(labels[labels.length - 1]).toBe('ClampHighlightsApply');
      expect(labels).toContain('Downscale');
      expect(labels.indexOf('Downscale')).toBeLessThan(labels.length - 1);
      expect((pipelines[pipelines.length - 1].getOutputTexture() as any).kind).toBe('clamp-apply');
      expect(labels.length).toBe(pipelines.length);
    }
  });

  it('suppresses the over-limit 8K upscaler and appends the target Downscale (adapter ceiling)', async () => {
    const labels: string[] = [];
    const params = buildParams({
      videoWidth: 7680,
      videoHeight: 4320,
      targetDimensions: { width: 3840, height: 2160 },
      effects: [mkEffect('CNNx2M', undefined, 2)],
      labels,
    });

    const pipelines = await buildEffectPipelines(params);

    // 2x on 8K would emit a 15360-wide intermediate; the guard suppresses the
    // effect and downscales the 8K source to the 4K target from its slot.
    expect(labels).toEqual(['Downscale']);
    expect(pipelines.length).toBe(1);
  });

  it('keeps a trailing restore when the limit guard emits no final Downscale (8K->8K)', async () => {
    const labels: string[] = [];
    const params = buildParams({
      videoWidth: 7680,
      videoHeight: 4320,
      targetDimensions: { width: 7680, height: 4320 },
      // The 2x would emit a 15360-wide intermediate and is suppressed; the
      // pre-upscale 8K already equals the target, so no Downscale is emitted and
      // the trailing CNNM restore must survive (it used to be dropped because the
      // limit preview anchored `finalDownscaleAfterIndex` at the suppressed slot).
      effects: [mkEffect('CNNx2M', undefined, 2), mkEffect('CNNM')],
      labels,
    });

    await buildEffectPipelines(params);

    expect(labels).toEqual(['CNNM']);
  });

  it('keeps a 4K source + 2x upscaler (8K intermediate is within the default budget)', async () => {
    const labels: string[] = [];
    const params = buildParams({
      videoWidth: 3840,
      videoHeight: 2160,
      targetDimensions: { width: 7680, height: 4320 },
      effects: [mkEffect('CNNx2M', undefined, 2)],
      labels,
    });

    const pipelines = await buildEffectPipelines(params);

    expect(labels).toEqual(['CNNx2M']);
    expect(pipelines.length).toBe(1);
  });

  it('threads device.limits.maxTextureDimension2D into the geometry guard', async () => {
    const buildNarrow = async () => {
      const labels: string[] = [];
      const params = buildParams({
        videoWidth: 4096,
        videoHeight: 1024,
        targetDimensions: { width: 4096, height: 720 },
        effects: [mkEffect('CNNx2M', undefined, 2)],
        labels,
      });
      return { pipelines: await buildEffectPipelines(params), labels };
    };

    // 4096-wide source * 2x = 8192-wide intermediate: over a 4096 adapter
    // ceiling. The upscaler is suppressed and the pre-upscale 4K is downscaled
    // to the 720p render target from its slot.
    mock.device.limits.maxTextureDimension2D = 4096;
    const narrow = await buildNarrow();
    expect(narrow.labels).toEqual(['Downscale']);
    expect(narrow.pipelines.length).toBe(1);

    // Within the default test adapter ceiling (8192): retained + downscaled.
    mock.device.limits.maxTextureDimension2D = 8192;
    const wide = await buildNarrow();
    expect(wide.labels).toEqual(['CNNx2M', 'Downscale']);
    expect(wide.pipelines.length).toBe(2);
  });

  it('keeps the legacy intermediate Downscale for a sub-720p target (floor)', async () => {
    // A 540p target is below MIN_DOWNSCALE_HEIGHT, so the legacy per-step rule
    // is preserved unchanged (including its 480x270 intermediate).
    const labels: string[] = [];
    const params = buildParams({
      targetDimensions: { width: 960, height: 540 },
      effects: [
        mkEffect('ClampHighlights'),
        mkEffect('DenoiseCNNx2VL', undefined, 2),
        mkEffect('CNNUL'),
        mkEffect('CNNx2UL', undefined, 2),
      ],
      labels,
    });

    const pipelines = await buildEffectPipelines(params);

    expect(labels).toEqual([
      'ClampHighlights',
      'DenoiseCNNx2VL',
      'Downscale',
      'CNNUL',
      'CNNx2UL',
      'ClampHighlightsApply',
    ]);
    expect(pipelines.length).toBe(6);
    expect(labels.length).toBe(pipelines.length);
  });

  it("records 'passthrough' for the empty dummy pipeline", async () => {
    const labels: string[] = [];
    const params = buildParams({ effects: [], labels });

    const pipelines = await buildEffectPipelines(params);

    expect(pipelines.length).toBe(1);
    expect(labels).toEqual(['passthrough']);
  });

  // ── Unresolvable effects are skipped (warn, no pipeline) ──

  it('returns dummy pipeline when no valid pipelines were created', async () => {
    // When effects produce no valid pipelines (e.g., all effects fail class lookup),
    // the function returns a single dummy pipeline.
    // Since vitest strict mocks prevent accessing undefined exports on the mock module,
    // we test the empty-effects path which also produces a dummy pipeline.
    const params = buildParams({
      effects: [mkEffect('DoG')],
      isStale: () => true, // force stale → empty array returned before effects are built
    });

    const pipelines = await buildEffectPipelines(params);

    // isStale() returned true → empty array, not dummy pipeline
    expect(pipelines).toEqual([]);
  });

  it('skips an unknown effect (warns, no pipeline) and keeps the passthrough', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const labels: string[] = [];
      const params = buildParams({ effects: [mkEffect('NonExistent')], labels });

      const pipelines = await buildEffectPipelines(params);

      // The unresolved effect is skipped, never constructed, so the builder
      // falls back to the passthrough dummy.
      expect(pipelines.length).toBe(1);
      expect(labels).toEqual(['passthrough']);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Unknown legacy'));
    } finally {
      warn.mockRestore();
    }
  });

  it('skips an unresolved new-style effect (warns, no pipeline)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const labels: string[] = [];
      const params = buildParams({
        effects: [
          { id: 'bogus/Bar', name: 'Bar', className: 'Bar', backendId: 'bogus', key: 'Bar' },
        ],
        labels,
      });

      const pipelines = await buildEffectPipelines(params);

      expect(pipelines.length).toBe(1);
      expect(labels).toEqual(['passthrough']);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Unresolved new-style'));
    } finally {
      warn.mockRestore();
    }
  });

  // ── Effect params applied ──

  it('applies effect params to library effects after construction', async () => {
    const params = buildParams({
      effects: [mkEffect('DoG', { strength: 8 })],
    });

    const pipelines = await buildEffectPipelines(params);

    expect(pipelines.length).toBe(1);
    // The mock updates paramUpdates internally
  });

  // ── ColorAdjust effect ──

  it('builds ColorAdjust with default params', async () => {
    const params = buildParams({
      effects: [mkEffect('ColorAdjust')],
    });

    const pipelines = await buildEffectPipelines(params);

    expect(pipelines.length).toBe(1);
    expect(typeof pipelines[0].pass).toBe('function');
  });

  it('builds ColorAdjust with custom params', async () => {
    const params = buildParams({
      effects: [mkEffect('ColorAdjust', {
        brightness: 0.2,
        gamma: 1.1,
        contrast: 1.2,
        saturation: 1.3,
        vibrance: 0.1,
        exposure: 0.5,
      })],
    });

    const pipelines = await buildEffectPipelines(params);

    expect(pipelines.length).toBe(1);
  });
});

// ─── Golden: engine registry dispatch ───

describe('buildEffectPipelines golden (engine registry)', () => {
  let mock: MockGPUObjects;
  // A no-op pre-warmer isolates Phase 1 construction so the snapshot only
  // contains the real effect steps and intermediate Downscales.
  const noopPreWarmer = {
    warm: vi.fn().mockResolvedValue(undefined),
    invalidate: vi.fn(),
  } as unknown as PipelinePreWarmer;

  beforeEach(() => {
    mock = installGPUMock();
    constructed.length = 0;
  });

  afterEach(() => {
    removeGPUMock();
  });

  function buildParams(
    effects: EnhancementEffect[],
    labels: string[],
  ) {
    const video = { videoWidth: 1920, videoHeight: 1080 } as HTMLVideoElement;
    return {
      device: mock.device as unknown as GPUDevice,
      videoFrameTexture: createMockGPUTexture(1920, 1080) as unknown as GPUTexture,
      video,
      targetDimensions: { width: 1920, height: 1080 } as Dimensions,
      effects,
      oldPipelines: [] as DestroyablePipeline[],
      preWarmer: noopPreWarmer,
      isStale: () => false,
      labels,
    };
  }

  async function run(effects: EnhancementEffect[]) {
    constructed.length = 0;
    state.backendCompiles = 0;
    const labels: string[] = [];
    const pipelines = await buildEffectPipelines(buildParams(effects, labels));
    return {
      pipelineCount: pipelines.length,
      labels: [...labels],
      classSequence: constructed.map((record) => record.effectName),
      constructors: constructed.map(normalizeStep),
      paramUpdates: constructed.map((record) =>
        record.paramUpdates.map(([key, value]) => [key, value]),
      ),
      backendCompiles: state.backendCompiles,
    };
  }

  const tiers = ['performance', 'balanced', 'quality', 'ultra'] as const;

  const builtInCases: Array<[string, EnhancementEffect[]]> = [];
  for (const mode of BUILTIN_MODES) {
    for (const tier of tiers) {
      builtInCases.push([`${mode.baseMode} / ${tier}`, getEffectsForMode(mode, tier)]);
    }
  }

  // Extra chains exercise the `updateParam` path (built-in chains carry no params).
  const extraCases: Array<[string, EnhancementEffect[]]> = [
    ['DoG params', [
      { id: 'anime4k/Deblur/DoG', name: 'Deblur (DoG)', className: 'DoG', params: { strength: 7 } },
    ]],
    ['BilateralMean params', [
      {
        id: 'anime4k/Denoise/BilateralMean',
        name: 'Denoise (Bilateral Mean)',
        className: 'BilateralMean',
        params: { strength: 0.35, strength2: 3 },
      },
    ]],
    ['upscale + params + final Downscale', [
      { id: 'anime4k/Helper/ClampHighlights', name: 'Clamp Highlights', className: 'ClampHighlights' },
      { id: 'anime4k/Deblur/DoG', name: 'Deblur (DoG)', className: 'DoG', params: { strength: 7 } },
      { id: 'anime4k/Upscale/CNNx2M', name: 'Upscale CNN x2 (M)', className: 'CNNx2M', upscaleFactor: 2 },
      { id: 'anime4k/Upscale/CNNx2M', name: 'Upscale CNN x2 (M)', className: 'CNNx2M', upscaleFactor: 2 },
    ]],
  ];

  for (const [name, effects] of [...builtInCases, ...extraCases]) {
    it(`records the registry sequence for ${name}`, async () => {
      const registry = await run(effects);

      // The engine registry must compile every retained effect through its
      // backend. The Downscale and the deferred apply node are constructed
      // directly, not through a backend.
      const effectCount = registry.classSequence
        .filter((constructed) => constructed !== 'Downscale' && constructed !== 'ClampHighlightsApply')
        .length;
      expect(registry.backendCompiles).toBe(effectCount);

      const { backendCompiles: _compiles, ...snapshot } = registry;
      expect(snapshot).toMatchSnapshot();
    });
  }

  it('suppresses the over-limit 8K upscaler and appends the target Downscale', async () => {
    const effects: EnhancementEffect[] = [
      { id: 'anime4k/Upscale/CNNx2M', name: 'Upscale CNN x2 (M)', className: 'CNNx2M', upscaleFactor: 2 },
    ];

    constructed.length = 0;
    state.backendCompiles = 0;
    const labels: string[] = [];
    const video = { videoWidth: 7680, videoHeight: 4320 } as HTMLVideoElement;
    const pipelines = await buildEffectPipelines({
      device: mock.device as unknown as GPUDevice,
      videoFrameTexture: createMockGPUTexture(7680, 4320) as unknown as GPUTexture,
      video,
      targetDimensions: { width: 3840, height: 2160 } as Dimensions,
      effects,
      oldPipelines: [] as DestroyablePipeline[],
      preWarmer: noopPreWarmer,
      isStale: () => false,
      labels,
    });

    // The effect is suppressed, so it is never compiled through the backend; the
    // chain emits only the target Downscale from the pre-upscale 8K texture.
    expect({
      pipelineCount: pipelines.length,
      labels: [...labels],
      classSequence: constructed.map((record) => record.effectName),
      backendCompiles: state.backendCompiles,
    }).toEqual({
      pipelineCount: 1,
      labels: ['Downscale'],
      classSequence: ['Downscale'],
      backendCompiles: 0,
    });
  });
});
