/**
 * Golden tests for the benchmark's effect-chain compiler.
 *
 * `runEffectChainTest` is exercised directly for the real `A+A` chain across all
 * four tiers through the engine registry. The mocked backend registry constructs
 * the fake library classes, so the recorded class/dimension sequences are an
 * exact regression golden for the registry dispatch path (the former legacy half
 * of the legacy-vs-registry parity comparison was removed with the legacy path).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installGPUMock, removeGPUMock, createMockGPUTexture } from '@/test/webgpu-mock';
import type { MockGPUObjects } from '@/test/webgpu-mock';
import * as Anime4KModule from 'anime4k-webgpu-async';
import { resolveEffectChain } from '@utils/effect-chain-templates';
import type { EnhancementEffect } from '@/types';

// ─── Fake library classes + construction recorder ───
// Shared with the renderer suite via the test helper; the mocked registry
// constructs the same classes and records the same order.
vi.mock('anime4k-webgpu-async', async () => {
  const { libraryClasses } = await import('./__test-helpers__/fake-backend.js');
  return { ...libraryClasses };
});

vi.mock('@core/engines/registry.js', async () => {
  const {
    createFakeAnime4kBackend,
    libraryClasses,
    state,
  } = await import('./__test-helpers__/fake-backend.js');

  const anime4kBackend = createFakeAnime4kBackend({
    displayName: 'Anime4K (benchmark golden fake)',
    missingCtorPrefix: '[benchmark-golden-fake]',
    ceilScaledDimensions: true,
  });

  const coreBackend = {
    backendId: 'core',
    displayName: 'core (benchmark golden fake)',
    listEffects: () => [],
    async compileEffect(ref: any, ctx: any) {
      const Ctor = libraryClasses[ref.key];
      if (!Ctor) throw new Error(`[benchmark-golden-fake] no constructor for core "${ref.key}"`);
      state.backendCompiles += 1;

      const pipeline = new Ctor({
        device: ctx.device,
        inputTexture: ctx.inputTexture,
        nativeDimensions: ctx.currentDimensions,
        targetDimensions: ctx.targetDimensions,
      });

      // Extension-owned core effects (ColorAdjust) are dimension-preserving.
      return {
        pipeline,
        outputTexture: pipeline.getOutputTexture(),
        outputDimensions: ctx.currentDimensions,
        profileLabel: ref.key,
      };
    },
  };

  const registry = {
    register: vi.fn(),
    getBackend: (backendId: string) =>
      backendId === 'anime4k' ? anime4kBackend : backendId === 'core' ? coreBackend : undefined,
    getBackendAsync: async (backendId: string) => {
      if (backendId === 'anime4k') return anime4kBackend;
      if (backendId === 'core') return coreBackend;
      throw new Error(`[benchmark-golden-fake] backend "${backendId}" is not registered`);
    },
    listEffects: () => [],
    getDescriptorById: () => undefined,
    getDescriptorByBackendKey: () => undefined,
  };

  return { getBackendRegistry: () => registry };
});

// ─── Import AFTER mocks ───
import { runEffectChainTest } from './gpu-benchmark';
import { constructed, normalizeStep, state } from './__test-helpers__/fake-backend';

// ─── Helpers ───

/** Build one expected normalized constructor record. */
function makeStep(
  effectName: string,
  nativeDimensions: { width: number; height: number } | null,
  targetDimensions: { width: number; height: number } | null,
  inputTexture: { width: number; height: number } | null,
) {
  return { effectName, nativeDimensions, targetDimensions, inputTexture };
}

const HD = { width: 1920, height: 1080 };
const UHD = { width: 3840, height: 2160 };

/**
 * Exact recorded registry sequences for the `A+A` chain per tier. Captured from
 * the registry path (the previous legacy-vs-registry parity golden) so these
 * remain a byte-exact regression guard now that legacy dispatch is gone.
 */
const A_A_GOLDEN = {
  performance: {
    classSequence: ['ClampHighlights', 'CNNM', 'CNNx2M', 'Downscale', 'CNNM', 'CNNx2M', 'ClampHighlightsApply'],
    constructors: [
      makeStep('ClampHighlights', HD, UHD, HD),
      makeStep('CNNM', HD, UHD, HD),
      makeStep('CNNx2M', HD, UHD, HD),
      makeStep('Downscale', null, HD, HD),
      makeStep('CNNM', HD, UHD, HD),
      makeStep('CNNx2M', HD, UHD, HD),
      makeStep('ClampHighlightsApply', null, null, HD),
    ],
    paramUpdates: [[], [], [], [], [], [], []],
  },
  balanced: {
    classSequence: ['ClampHighlights', 'CNNVL', 'CNNx2VL', 'Downscale', 'CNNVL', 'CNNx2M', 'ClampHighlightsApply'],
    constructors: [
      makeStep('ClampHighlights', HD, UHD, HD),
      makeStep('CNNVL', HD, UHD, HD),
      makeStep('CNNx2VL', HD, UHD, HD),
      makeStep('Downscale', null, HD, HD),
      makeStep('CNNVL', HD, UHD, HD),
      makeStep('CNNx2M', HD, UHD, HD),
      makeStep('ClampHighlightsApply', null, null, HD),
    ],
    paramUpdates: [[], [], [], [], [], [], []],
  },
  quality: {
    classSequence: ['ClampHighlights', 'CNNUL', 'CNNx2UL', 'Downscale', 'CNNUL', 'CNNx2VL', 'ClampHighlightsApply'],
    constructors: [
      makeStep('ClampHighlights', HD, UHD, HD),
      makeStep('CNNUL', HD, UHD, HD),
      makeStep('CNNx2UL', HD, UHD, HD),
      makeStep('Downscale', null, HD, HD),
      makeStep('CNNUL', HD, UHD, HD),
      makeStep('CNNx2VL', HD, UHD, HD),
      makeStep('ClampHighlightsApply', null, null, HD),
    ],
    paramUpdates: [[], [], [], [], [], [], []],
  },
  ultra: {
    classSequence: ['ClampHighlights', 'CNNUL', 'CNNx2UL', 'CNNUL', 'CNNUL', 'ClampHighlightsApply'],
    constructors: [
      makeStep('ClampHighlights', HD, UHD, HD),
      makeStep('CNNUL', HD, UHD, HD),
      makeStep('CNNx2UL', HD, UHD, HD),
      makeStep('CNNUL', UHD, UHD, HD),
      makeStep('CNNUL', UHD, UHD, HD),
      makeStep('ClampHighlightsApply', null, null, HD),
    ],
    paramUpdates: [[], [], [], [], [], []],
  },
};

describe('runEffectChainTest golden (engine registry)', () => {
  let mock: MockGPUObjects;

  beforeEach(() => {
    mock = installGPUMock();
    constructed.length = 0;
    state.backendCompiles = 0;
  });

  afterEach(() => {
    removeGPUMock();
  });

  async function run(
    effects: EnhancementEffect[],
    sourceDimensions: { width: number; height: number } = { width: 1920, height: 1080 },
  ) {
    constructed.length = 0;
    state.backendCompiles = 0;
    const device = mock.device as unknown as GPUDevice;
    const inputTexture = createMockGPUTexture(
      sourceDimensions.width,
      sourceDimensions.height,
    ) as unknown as GPUTexture;

    await runEffectChainTest(
      device,
      inputTexture,
      effects,
      Anime4KModule as unknown as typeof import('anime4k-webgpu-async'),
      sourceDimensions,
    );

    return {
      classSequence: constructed.map((record) => record.effectName),
      constructors: constructed.map(normalizeStep),
      paramUpdates: constructed.map((record) =>
        record.paramUpdates.map(([key, value]) => [key, value]),
      ),
      backendCompiles: state.backendCompiles,
    };
  }

  const tiers = ['performance', 'balanced', 'quality', 'ultra'] as const;

  for (const tier of tiers) {
    it(`records the registry pipeline sequence for A+A / ${tier}`, async () => {
      const effects = resolveEffectChain('A+A', tier);

      const registry = await run(effects);

      // Every retained effect is compiled through the backend; Downscale and the
      // deferred apply node are built directly, not via the backend.
      const effectCount = registry.classSequence
        .filter((name) => name !== 'Downscale' && name !== 'ClampHighlightsApply').length;
      expect(registry.backendCompiles).toBe(effectCount);

      const { backendCompiles: _compiles, ...snapshot } = registry;
      expect(snapshot).toEqual(A_A_GOLDEN[tier]);
    });
  }

  it('suppresses the over-limit 8K upscaler and appends the target Downscale', async () => {
    const effects: EnhancementEffect[] = [
      { id: 'anime4k/Upscale/CNNx2M', name: 'Upscale CNN x2 (M)', className: 'CNNx2M', upscaleFactor: 2 },
    ];
    const source = { width: 7680, height: 4320 };

    const registry = await run(effects, source);

    // 8K * 2x would emit a 15360-wide intermediate; the guard suppresses the
    // upscaler and emits only the Downscale from the pre-upscale 8K texture.
    expect(registry.classSequence).toEqual(['Downscale']);
    expect(registry.backendCompiles).toBe(0);
  });

  it('threads device.limits.maxTextureDimension2D into the benchmark geometry', async () => {
    const effects = resolveEffectChain('A+A', 'performance');

    // Default mock ceiling (8192): the 1080p->4K A+A chain keeps its upscalers.
    const wide = await run(effects);
    expect(wide.classSequence).toContain('CNNx2M');

    // A tighter adapter ceiling suppresses the over-limit upscalers.
    mock.device.limits.maxTextureDimension2D = 2048;
    const narrow = await run(effects);
    expect(narrow.classSequence).not.toContain('CNNx2M');
    expect(narrow.classSequence.length).toBeLessThan(wide.classSequence.length);
  });

  it('orders color-category effects after the deferred epilogue (renderer parity)', async () => {
    // A `category: 'color'` effect (ColorAdjust, resolved to the `core`
    // backend) must be flagged as post-epilogue exactly as the renderer's
    // pipeline builder derives it, so it runs AFTER ClampHighlightsApply rather
    // than being compiled in the main loop and clamped afterwards.
    const effects: EnhancementEffect[] = [
      { id: 'anime4k/ClampHighlights', name: 'Clamp Highlights', className: 'ClampHighlights', upscaleFactor: 1 },
      { id: 'anime4k/ColorGrading/ColorAdjust', name: 'Color Grading', className: 'ColorAdjust', upscaleFactor: 1 },
    ];

    const registry = await run(effects);

    expect(registry.classSequence).toEqual([
      'ClampHighlights',
      'ClampHighlightsApply',
      'ColorAdjust',
    ]);
  });
});
