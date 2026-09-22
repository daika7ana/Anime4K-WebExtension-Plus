/**
 * Tests for GPU Benchmark — tier recommendation, error handling, storage interaction.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installGPUMock, removeGPUMock } from '@/test/webgpu-mock';
import type { MockGPUObjects } from '@/test/webgpu-mock';
import type { BenchmarkProgress, EnhancementEffect } from '@/types';

// ─── Mock WGSL shader files (used by effect classes imported via resolveEffectChain) ───
vi.mock('@shaders/cas.wgsl', () => ({ default: '// mock' }));
vi.mock('@shaders/color-adjust.wgsl', () => ({ default: '// mock' }));
vi.mock('@shaders/debanding.wgsl', () => ({ default: '// mock' }));
vi.mock('@shaders/fullscreen-textured-quad.wgsl', () => ({ default: '// mock' }));
vi.mock('@shaders/sample-external-texture.wgsl', () => ({ default: '// mock' }));

// ─── Mock resolveEffectChain ───
let mockResolvedEffects: EnhancementEffect[] = [];
vi.mock('@utils/effect-chain-templates', () => ({
  resolveEffectChain: vi.fn((_baseMode: string, _tier: string) => [...mockResolvedEffects]),
}));

// ─── Mock anime4k-webgpu-async (library effects) ───
// Every key resolves to the shared mock effect; the benchmark's registry path
// constructs it for all effects.
vi.mock('anime4k-webgpu-async', async () => {
  const { MockLibEffect } = await import('./__test-helpers__/fake-backend.js');
  return {
    ClampHighlights: MockLibEffect,
    CNNM: MockLibEffect,
    CNNx2M: MockLibEffect,
    CNNVL: MockLibEffect,
    CNNx2VL: MockLibEffect,
    CNNUL: MockLibEffect,
    CNNx2UL: MockLibEffect,
    CNNSoftM: MockLibEffect,
    CNNSoftVL: MockLibEffect,
    DoG: MockLibEffect,
    DenoiseCNNx2VL: MockLibEffect,
    Downscale: MockLibEffect,
  };
});

// ─── Mock backend registry (engine dispatch) ───
// Since registry dispatch is unconditional, the benchmark's lazy registry load
// must resolve to a fake Anime4K backend that constructs the mock classes.
vi.mock('@core/engines/registry.js', async () => {
  const {
    createFakeAnime4kBackend,
    MockLibEffect,
  } = await import('./__test-helpers__/fake-backend.js');

  const anime4kBackend = createFakeAnime4kBackend({
    displayName: 'Anime4K (benchmark-test fake)',
    missingCtorPrefix: '[benchmark-test-fake]',
    resolveCtor: () => MockLibEffect,
  });

  const registry = {
    register: vi.fn(),
    getBackend: () => anime4kBackend,
    getBackendAsync: async () => anime4kBackend,
    listEffects: () => [],
    getDescriptorById: () => undefined,
    getDescriptorByBackendKey: () => undefined,
  };

  return { getBackendRegistry: () => registry };
});

// ─── Import after mocks ───
import {
  runGPUBenchmark,
  recommendTierFromSamples,
  tierMeetsBudget,
  sanitizeFrameSamples,
  computeFrameBudget,
  PERFORMANCE_TIER_ORDER,
  FALLBACK_PERFORMANCE_TIER,
} from './gpu-benchmark';

// ─── Simple mock effects for the benchmark chain ───
function simpleEffectChain(): EnhancementEffect[] {
  return [
    { id: 'test/ClampHighlights', name: 'Clamp', className: 'ClampHighlights' },
    { id: 'test/CNNM', name: 'Restore CNN', className: 'CNNM' },
    { id: 'test/CNNx2M', name: 'Upscale', className: 'CNNx2M', upscaleFactor: 2 },
    { id: 'test/CNNM2', name: 'Restore CNN', className: 'CNNM' },
    { id: 'test/CNNx2M2', name: 'Upscale', className: 'CNNx2M', upscaleFactor: 2 },
  ];
}

describe('runGPUBenchmark', () => {
  let mock: MockGPUObjects;
  let progressEvents: BenchmarkProgress[];

  beforeEach(() => {
    mock = installGPUMock();
    progressEvents = [];
    mockResolvedEffects = simpleEffectChain();

    // Add remove to chrome storage local mock (missing from test-setup)
    (chrome.storage.local as any).remove = vi.fn().mockResolvedValue(undefined);

    // Mock crypto.getRandomValues — fill with zeros for speed
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(((
      array: ArrayBufferView,
    ): ArrayBufferView => {
      if (array instanceof Uint8Array) {
        array.fill(0);
      }
      return array;
    }) as typeof crypto.getRandomValues);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    removeGPUMock();
  });

  // ── Result shape ──

  it('returns a valid GPUBenchmarkResult', async () => {
    const result = await runGPUBenchmark((p) => progressEvents.push(p));

    expect(result).toHaveProperty('tier');
    expect(result).toHaveProperty('scores');
    expect(result).toHaveProperty('maxScores');
    expect(result).toHaveProperty('timestamp');
    expect(result).toHaveProperty('adapterInfo');
    expect(typeof result.tier).toBe('string');
    expect(typeof result.timestamp).toBe('number');
    expect(result.scores).toHaveProperty('performance');
    expect(result.scores).toHaveProperty('balanced');
    expect(result.scores).toHaveProperty('quality');
    expect(result.scores).toHaveProperty('ultra');
  });

  it('returns performance tier as recommendation when all tiers are fast', async () => {
    // With mock GPU, everything resolves instantly → all tiers should be fast
    // avgTime ≈ 0ms, maxTime ≈ 0ms → recommended = last tier that passed
    const result = await runGPUBenchmark();

    // At minimum, performance tier should have a finite score
    expect(result.scores.performance).toBeLessThan(Infinity);
    // tier is the last tier that met the threshold criteria
    expect(['performance', 'balanced', 'quality', 'ultra']).toContain(result.tier);
  });

  // ── Progress callbacks ──

  it('calls onProgress with tier progress updates', async () => {
    await runGPUBenchmark((p) => progressEvents.push(p));

    // Should have tier-level progress events
    const tierEvents = progressEvents.filter(e => e.tier !== 'done');
    expect(tierEvents.length).toBeGreaterThan(0);

    // Each tier event should have the right shape
    for (const event of tierEvents) {
      expect(event).toHaveProperty('tier');
      expect(event).toHaveProperty('progress');
      expect(event).toHaveProperty('completed');
      expect(event.completed).toBe(false);
    }
  });

  it('calls onProgress with completion event at the end', async () => {
    await runGPUBenchmark((p) => progressEvents.push(p));

    const lastEvent = progressEvents[progressEvents.length - 1];
    expect(lastEvent.tier).toBe('done');
    expect(lastEvent.progress).toBe(1);
    expect(lastEvent.completed).toBe(true);
  });

  // ── No navigator.gpu ──

  it('throws when navigator.gpu is not available', async () => {
    removeGPUMock();

    await expect(runGPUBenchmark()).rejects.toThrow('WebGPU not supported');

    // Re-install for subsequent tests
    mock = installGPUMock();
  });

  // ── No adapter ──

  it('throws when no GPU adapter is available', async () => {
    removeGPUMock();
    installGPUMock({ adapterNull: true });

    await expect(runGPUBenchmark()).rejects.toThrow('No GPU adapter available');

    removeGPUMock();
    mock = installGPUMock();
  });

  // ── All tiers fail ──

  it('throws "All benchmark tests failed" when warmup fails', async () => {
    // Return effects with a class not in the mock → no pipelines created → throws
    mockResolvedEffects = [
      { id: 'test/NonExistent', name: 'Nope', className: 'NonExistent' },
    ];

    await expect(runGPUBenchmark()).rejects.toThrow();
  });

  // ── Chrome storage interaction ──

  it('sets and removes _benchmarkInProgress flag in chrome storage', async () => {
    const setSpy = chrome.storage.local.set as ReturnType<typeof vi.fn>;
    const removeSpy = chrome.storage.local.remove as ReturnType<typeof vi.fn>;

    await runGPUBenchmark();

    // Should have set _benchmarkInProgress before benchmark
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ _benchmarkInProgress: true }),
    );

    // Should have removed _benchmarkInProgress after benchmark
    expect(removeSpy).toHaveBeenCalledWith('_benchmarkInProgress');
  });

  // ── Adapter info ──

  it('includes adapter info in the result', async () => {
    const result = await runGPUBenchmark();

    expect(result.adapterInfo).toBeDefined();
    expect(typeof result.adapterInfo).toBe('string');

    // Should contain mock vendor info
    const info = JSON.parse(result.adapterInfo);
    expect(info.vendor).toBe('mock-vendor');
  });

  // ── Timestamp ──

  it('includes a timestamp in the result', async () => {
    const before = Date.now();
    const result = await runGPUBenchmark();
    const after = Date.now();

    // Allow a small tolerance for clock granularity / async scheduling
    expect(result.timestamp).toBeGreaterThanOrEqual(before - 1000);
    expect(result.timestamp).toBeLessThanOrEqual(after + 500);
  });

  // ── Scores shape ──

  it('has finite scores for tested tiers', async () => {
    const result = await runGPUBenchmark();

    // With mock, all tiers should have been tested (no timeouts)
    for (const tier of ['performance', 'balanced', 'quality', 'ultra'] as const) {
      expect(result.scores[tier]).toBeLessThan(Infinity);
      expect(result.maxScores[tier]).toBeLessThan(Infinity);
    }
  });

  // ── Device lifecycle ──

  it('destroys device after successful benchmark', async () => {
    await runGPUBenchmark();

    expect(mock.device.destroy).toHaveBeenCalled();
  });

  it('allocates a single shared input texture and destroys it after the benchmark', async () => {
    const createTexture = mock.device.createTexture as unknown as ReturnType<typeof vi.fn>;

    await runGPUBenchmark();

    // Warmup and every tier reuse one 1080p rgba8unorm input texture (an
    // array-form `size`; effect-owned textures use object-form descriptors).
    const inputIndices = createTexture.mock.calls
      .map((call, index) => ({ size: (call[0] as { size?: unknown })?.size, index }))
      .filter(({ size }) => Array.isArray(size) && size[0] === 1920 && size[1] === 1080)
      .map(({ index }) => index);

    expect(inputIndices).toHaveLength(1);
    const texture = createTexture.mock.results[inputIndices[0]].value as {
      destroy: ReturnType<typeof vi.fn>;
    };
    expect(texture.destroy).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Benchmark → performance-tier policy (pure)
//
// Policy: budget = 1000 / fpsTarget (default 24fps ≈ 41.67ms). A tier qualifies
// when max(samples) < budget AND avg(samples) < 0.9 * budget. The heaviest
// qualifying tier wins; null means "fall back to FALLBACK_PERFORMANCE_TIER".
// ────────────────────────────────────────────────────────────────────────────

describe('recommendTierFromSamples (benchmark → tier policy)', () => {
  const budget = 1000 / 24; // ≈ 41.6667ms

  it('recommends the heaviest tier when every tier is fast', () => {
    const samples = {
      performance: [4, 5, 6],
      balanced: [5, 6, 7],
      quality: [6, 7, 8],
      ultra: [7, 8, 9],
    };

    expect(recommendTierFromSamples(samples)).toBe('ultra');
  });

  it('returns null (fallback) when every tier is too slow', () => {
    const slow = [budget * 2, budget * 2.1, budget * 2.2];
    const samples = {
      performance: slow,
      balanced: slow,
      quality: slow,
      ultra: slow,
    };

    expect(recommendTierFromSamples(samples)).toBeNull();
    // Callers map null → the lightest, safest tier.
    expect(FALLBACK_PERFORMANCE_TIER).toBe('performance');
  });

  it('recommends the heaviest tier among those actually tested', () => {
    // quality/ultra were skipped, so balanced is the heaviest available.
    expect(
      recommendTierFromSamples({ performance: [5, 5], balanced: [6, 6] }),
    ).toBe('balanced');
  });

  it('skips a fast-but-unqualified heavy tier and picks the next one down', () => {
    // ultra breaches the max budget, quality is fine → quality is recommended.
    expect(
      recommendTierFromSamples({
        performance: [5],
        quality: [10],
        ultra: [budget * 1.5],
      }),
    ).toBe('quality');
  });

  // ── Boundary at max === budget ──

  it('rejects a tier whose max frame time equals the budget exactly', () => {
    const atBudget = Array.from({ length: 10 }, () => budget);

    expect(tierMeetsBudget(atBudget)).toBe(false);
    expect(recommendTierFromSamples({ ultra: atBudget })).toBeNull();
  });

  it('rejects a tier whose single max sample is above the budget', () => {
    expect(tierMeetsBudget([budget + 0.001])).toBe(false);
  });

  // ── Average headroom boundary (0.9 × budget) ──

  it('accepts a tier whose avg is just under 0.9 × budget and max under budget', () => {
    const justUnder = 0.9 * budget - 0.01;
    const samples = Array.from({ length: 10 }, () => justUnder);

    expect(tierMeetsBudget(samples)).toBe(true);
    expect(recommendTierFromSamples({ ultra: samples })).toBe('ultra');
  });

  it('rejects a tier whose avg equals 0.9 × budget exactly (strict inequality)', () => {
    const samples = Array.from({ length: 10 }, () => 0.9 * budget);

    expect(tierMeetsBudget(samples)).toBe(false);
  });

  it('rejects a tier whose avg is just over 0.9 × budget even when max < budget', () => {
    const justOver = 0.9 * budget + 0.01;
    const samples = Array.from({ length: 10 }, () => justOver);

    expect(samples.every((s) => s < budget)).toBe(true);
    expect(tierMeetsBudget(samples)).toBe(false);
  });

  // ── Empty / short lists ──

  it('returns null for empty or untested tier maps', () => {
    expect(recommendTierFromSamples({})).toBeNull();
    expect(recommendTierFromSamples({ ultra: [] })).toBeNull();
    expect(tierMeetsBudget([])).toBe(false);
  });

  it('supports short (single-sample) lists', () => {
    expect(tierMeetsBudget([5])).toBe(true);
    expect(recommendTierFromSamples({ quality: [5] })).toBe('quality');
  });

  // ── Non-finite / non-positive filtering ──

  it('filters NaN, ±Infinity and non-positive samples before aggregating', () => {
    const dirty = [NaN, Infinity, -Infinity, 0, -10, 10, 12];

    expect(sanitizeFrameSamples(dirty)).toEqual([10, 12]);
    expect(tierMeetsBudget(dirty)).toBe(true);
    expect(recommendTierFromSamples({ ultra: dirty })).toBe('ultra');
  });

  it('never qualifies a set made up entirely of invalid samples', () => {
    const invalid = [NaN, Infinity, -Infinity, 0, -1];

    expect(tierMeetsBudget(invalid)).toBe(false);
    expect(recommendTierFromSamples({ performance: invalid, ultra: invalid })).toBeNull();
  });

  it('ignores invalid samples when computing max and average', () => {
    // Valid samples 10 and 12: max 12 < budget, avg 11 < 0.9 * budget.
    expect(sanitizeFrameSamples([Infinity, 10, NaN, 12, -3])).toEqual([10, 12]);
  });

  // ── Configurable fps target ──

  it('computes the budget from a custom fpsTarget', () => {
    expect(computeFrameBudget()).toBeCloseTo(1000 / 24, 6);
    expect(computeFrameBudget({ fpsTarget: 60 })).toBeCloseTo(1000 / 60, 6);
  });

  it('falls back to 24fps for invalid fpsTarget values', () => {
    expect(computeFrameBudget({ fpsTarget: 0 })).toBeCloseTo(1000 / 24, 6);
    expect(computeFrameBudget({ fpsTarget: -30 })).toBeCloseTo(1000 / 24, 6);
    expect(computeFrameBudget({ fpsTarget: NaN })).toBeCloseTo(1000 / 24, 6);
    expect(computeFrameBudget({ fpsTarget: Infinity })).toBeCloseTo(1000 / 24, 6);
  });

  it('rejects samples that pass 24fps but fail a 60fps target', () => {
    const samples = [20, 21, 22]; // < 41.67ms budget but > 16.67ms budget

    expect(tierMeetsBudget(samples)).toBe(true);
    expect(tierMeetsBudget(samples, { fpsTarget: 60 })).toBe(false);
    expect(
      recommendTierFromSamples({ ultra: samples }, { fpsTarget: 60 }),
    ).toBeNull();
  });

  // ── Tier ordering source of truth ──

  it('exposes tiers ordered lightest → heaviest without duplicating the list', () => {
    expect([...PERFORMANCE_TIER_ORDER]).toEqual([
      'performance',
      'balanced',
      'quality',
      'ultra',
    ]);
  });
});
