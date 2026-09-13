import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  synchronizeEffectsForCustomModes,
  getEffectsForMode,
  getSettings,
  getLocalSettings,
  normalizeSyncedSettings,
  normalizeLocalSettings,
  BUILTIN_MODES,
} from './settings';

// Capture the storage-change listener registered by settings.ts at import time.
// Restoring mocks between tests can clear `mock.calls`, so hold the reference now.
const capturedOnChanged = (
  chrome.storage.onChanged.addListener as unknown as { mock: { calls: unknown[][] } }
).mock.calls[0]?.[0] as (() => void) | undefined;
import {
  getSnapshot,
  invalidate,
  isStale,
  setSnapshot,
} from './settings-snapshot';
import { AVAILABLE_EFFECTS } from './effects-map';
import { resolveEffectChain } from './effect-chain-templates';
import type { CustomMode, BuiltInMode, EnhancementEffect, PerformanceTier } from '../types';

describe('BUILTIN_MODES', () => {
  it('contains exactly 6 modes', () => {
    expect(BUILTIN_MODES).toHaveLength(6);
  });

  it('each mode has required fields', () => {
    for (const mode of BUILTIN_MODES) {
      expect(mode).toHaveProperty('id');
      expect(mode).toHaveProperty('baseMode');
      expect(mode).toHaveProperty('name');
      expect(mode.isBuiltIn).toBe(true);
    }
  });

  it('covers all base modes', () => {
    const baseModes = BUILTIN_MODES.map(m => m.baseMode);
    expect(baseModes).toContain('A');
    expect(baseModes).toContain('B');
    expect(baseModes).toContain('C');
    expect(baseModes).toContain('A+A');
    expect(baseModes).toContain('B+B');
    expect(baseModes).toContain('C+A');
  });
});

describe('synchronizeEffectsForCustomModes', () => {
  it('returns empty array for empty input', () => {
    expect(synchronizeEffectsForCustomModes([])).toEqual([]);
  });

  it('preserves mode structure', () => {
    const modes: CustomMode[] = [
      { id: 'custom-1', name: 'My Mode', isBuiltIn: false, effects: [] },
    ];
    const result = synchronizeEffectsForCustomModes(modes);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('custom-1');
    expect(result[0].name).toBe('My Mode');
    expect(result[0].isBuiltIn).toBe(false);
  });

  it('resolves effect IDs to catalog effects', () => {
    const casEffect = AVAILABLE_EFFECTS.find(e => e.className === 'CAS')!;
    const modes: CustomMode[] = [
      {
        id: 'custom-1',
        name: 'Test',
        isBuiltIn: false,
        effects: [{ id: casEffect.id, name: 'Old Name', className: 'CAS' }],
      },
    ];
    const result = synchronizeEffectsForCustomModes(modes);
    expect(result[0].effects[0].name).toBe(casEffect.name);
  });

  it('preserves user-customized params over catalog defaults', () => {
    const casEffect = AVAILABLE_EFFECTS.find(e => e.className === 'CAS')!;
    const modes: CustomMode[] = [
      {
        id: 'custom-1',
        name: 'Test',
        isBuiltIn: false,
        effects: [{ ...casEffect, params: { sharpness: 0.9 } }],
      },
    ];
    const result = synchronizeEffectsForCustomModes(modes);
    expect(result[0].effects[0].params).toEqual({ sharpness: 0.9 });
  });

  it('drops effects whose IDs are not in the catalog', () => {
    const modes: CustomMode[] = [
      {
        id: 'custom-1',
        name: 'Test',
        isBuiltIn: false,
        effects: [
          { id: 'nonexistent/effect', name: 'Ghost', className: 'Ghost' },
        ],
      },
    ];
    const result = synchronizeEffectsForCustomModes(modes);
    expect(result[0].effects).toHaveLength(0);
  });

  it('handles multiple modes independently', () => {
    const casEffect = AVAILABLE_EFFECTS.find(e => e.className === 'CAS')!;
    const modes: CustomMode[] = [
      { id: 'c1', name: 'Mode 1', isBuiltIn: false, effects: [casEffect] },
      { id: 'c2', name: 'Mode 2', isBuiltIn: false, effects: [] },
    ];
    const result = synchronizeEffectsForCustomModes(modes);
    expect(result).toHaveLength(2);
    expect(result[0].effects).toHaveLength(1);
    expect(result[1].effects).toHaveLength(0);
  });

  it('canonicalizes a resolved anime4k effect through the seam', () => {
    const modes: CustomMode[] = [
      {
        id: 'custom-1',
        name: 'Test',
        isBuiltIn: false,
        effects: [{ id: 'anime4k/Restore/CNNVL', name: 'Old Name', className: 'CNNVL' }],
      },
    ];
    const result = synchronizeEffectsForCustomModes(modes);
    expect(result[0].effects[0]).toEqual({
      id: 'anime4k/Restore/CNNVL',
      name: 'Restore CNN (VL)',
      className: 'CNNVL',
      backendId: 'anime4k',
      key: 'CNNVL',
    });
  });

  it('resolves core effects (CAS/Debanding) through the seam with default params', () => {
    const modes: CustomMode[] = [
      {
        id: 'custom-1',
        name: 'Test',
        isBuiltIn: false,
        effects: [
          { id: 'anime4k/Sharpen/CAS', name: 'Old CAS', className: 'CAS' },
          { id: 'anime4k/Debanding/Debanding', name: 'Old DB', className: 'Debanding' },
        ],
      },
    ];
    const result = synchronizeEffectsForCustomModes(modes);
    expect(result[0].effects[0]).toEqual({
      id: 'anime4k/Sharpen/CAS',
      name: 'Contrast Adaptive Sharpening (CAS)',
      className: 'CAS',
      backendId: 'core',
      key: 'CAS',
      params: { sharpness: 0.5 },
    });
    expect(result[0].effects[1]).toEqual({
      id: 'anime4k/Debanding/Debanding',
      name: 'Debanding',
      className: 'Debanding',
      backendId: 'core',
      key: 'Debanding',
      params: { strength: 0.5, bandThreshold: 0.08 },
    });
  });

  it('preserves a well-formed new-style unknown reference verbatim', () => {
    const newStyle: EnhancementEffect = {
      id: 'artcnn/ArtCNN/C4F16',
      name: 'ArtCNN C4F16',
      className: 'C4F16',
      backendId: 'artcnn',
      key: 'C4F16',
      params: { variant: 1 },
    };
    const modes: CustomMode[] = [
      { id: 'custom-1', name: 'Test', isBuiltIn: false, effects: [newStyle] },
    ];
    const result = synchronizeEffectsForCustomModes(modes);
    expect(result[0].effects).toHaveLength(1);
    expect(result[0].effects[0]).toEqual(newStyle);
  });

  it('drops a legacy unknown effect (unknown id and className)', () => {
    const modes: CustomMode[] = [
      {
        id: 'custom-1',
        name: 'Test',
        isBuiltIn: false,
        effects: [{ id: 'legacy/unknown', name: 'Ghost', className: 'Ghost' }],
      },
    ];
    const result = synchronizeEffectsForCustomModes(modes);
    expect(result[0].effects).toHaveLength(0);
  });

  it('merges user params over catalog defaults, keeping defaults for omitted keys', () => {
    const modes: CustomMode[] = [
      {
        id: 'custom-1',
        name: 'Test',
        isBuiltIn: false,
        effects: [
          {
            id: 'anime4k/Debanding/Debanding',
            name: 'Debanding',
            className: 'Debanding',
            params: { strength: 0.2 },
          },
        ],
      },
    ];
    const result = synchronizeEffectsForCustomModes(modes);
    expect(result[0].effects[0].params).toEqual({ strength: 0.2, bandThreshold: 0.08 });
  });
});

describe('getEffectsForMode', () => {
  it('resolves built-in mode effects based on tier', () => {
    const mode: BuiltInMode = { id: 'builtin-mode-a', baseMode: 'A', name: 'Mode A', isBuiltIn: true };
    const effects = getEffectsForMode(mode, 'balanced');
    // Should match resolveEffectChain('A', 'balanced')
    const expected = resolveEffectChain('A', 'balanced');
    expect(effects).toEqual(expected);
  });

  it('returns different effects for different tiers', () => {
    const mode: BuiltInMode = { id: 'builtin-mode-a', baseMode: 'A', name: 'Mode A', isBuiltIn: true };
    const perfEffects = getEffectsForMode(mode, 'performance');
    const qualityEffects = getEffectsForMode(mode, 'quality');
    // Performance and quality should have different effect chains
    expect(perfEffects.map(e => e.className)).not.toEqual(qualityEffects.map(e => e.className));
  });

  it('returns custom mode effects directly without tier resolution', () => {
    const casEffect = AVAILABLE_EFFECTS.find(e => e.className === 'CAS')!;
    const mode: CustomMode = {
      id: 'custom-1',
      name: 'My Custom',
      isBuiltIn: false,
      effects: [casEffect],
    };
    const effects = getEffectsForMode(mode, 'performance');
    expect(effects).toEqual([casEffect]);
  });

  it('custom mode ignores tier parameter', () => {
    const casEffect = AVAILABLE_EFFECTS.find(e => e.className === 'CAS')!;
    const mode: CustomMode = {
      id: 'custom-1',
      name: 'My Custom',
      isBuiltIn: false,
      effects: [casEffect],
    };
    expect(getEffectsForMode(mode, 'performance')).toEqual(getEffectsForMode(mode, 'ultra'));
  });

  it('each built-in base mode resolves to non-empty effects for each tier', () => {
    const tiers: PerformanceTier[] = ['performance', 'balanced', 'quality', 'ultra'];
    for (const builtin of BUILTIN_MODES) {
      for (const tier of tiers) {
        const effects = getEffectsForMode(builtin, tier);
        expect(effects.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('normalizeSyncedSettings', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to defaults for every corrupt field', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = normalizeSyncedSettings({
      selectedModeId: 123,
      targetResolutionSetting: 'bogus',
      whitelistEnabled: 'yes',
      whitelist: 'nope',
      customModes: 'nope',
      enableCrossOriginFix: null,
      autoEnableOnWhitelist: 'x',
      enableHotkey: 1,
      colorGrading: { enabled: 'yes', brightness: 5, gamma: 99 },
    });

    expect(result.selectedModeId).toBe('builtin-mode-a');
    expect(result.targetResolutionSetting).toBe('x2');
    expect(result.whitelistEnabled).toBe(false);
    expect(result.whitelist).toEqual([]);
    expect(result.customModes).toEqual([]);
    expect(result.enableCrossOriginFix).toBe(false);
    expect(result.autoEnableOnWhitelist).toBe(false);
    // enableHotkey defaults to true
    expect(result.enableHotkey).toBe(true);
    expect(result.colorGrading).toEqual({
      enabled: false,
      brightness: 0,
      gamma: 1,
      contrast: 1,
      saturation: 1,
      vibrance: 0,
      exposure: 0,
    });
    expect(warn).toHaveBeenCalled();
  });

  it('preserves valid custom modes and settings', () => {
    const result = normalizeSyncedSettings({
      selectedModeId: 'custom-1',
      targetResolutionSetting: 'native',
      whitelistEnabled: true,
      whitelist: [{ pattern: 'example.com', enabled: true }],
      customModes: [
        {
          id: 'custom-1',
          name: 'Mine',
          isBuiltIn: false,
          effects: [{ id: 'anime4k/Sharpen/CAS', params: { sharpness: 0.9 } }],
        },
      ],
      enableCrossOriginFix: true,
      autoEnableOnWhitelist: true,
      enableHotkey: false,
      colorGrading: { enabled: true, brightness: 0.2, gamma: 1.5, contrast: 1, saturation: 1, vibrance: 0, exposure: 0 },
    });

    expect(result.selectedModeId).toBe('custom-1');
    expect(result.targetResolutionSetting).toBe('native');
    expect(result.whitelistEnabled).toBe(true);
    expect(result.customModes).toHaveLength(1);
    expect(result.customModes[0].effects[0].params).toEqual({ sharpness: 0.9 });
    expect(result.enableHotkey).toBe(false);
    expect(result.colorGrading.enabled).toBe(true);
    expect(result.colorGrading.brightness).toBe(0.2);
  });

  it('treats missing fields as defaults without warning', () => {
    const result = normalizeSyncedSettings({});
    expect(result.selectedModeId).toBe('builtin-mode-a');
    expect(result.targetResolutionSetting).toBe('x2');
    expect(result.customModes).toEqual([]);
  });

  it('rounds a valid autoEnableSettleMs number', () => {
    expect(normalizeSyncedSettings({ autoEnableSettleMs: 123.6 }).autoEnableSettleMs).toBe(124);
  });

  it('clamps a negative autoEnableSettleMs to 0', () => {
    expect(normalizeSyncedSettings({ autoEnableSettleMs: -5 }).autoEnableSettleMs).toBe(0);
  });

  it('clamps an out-of-range autoEnableSettleMs to 10000', () => {
    expect(normalizeSyncedSettings({ autoEnableSettleMs: 99999 }).autoEnableSettleMs).toBe(10000);
  });

  it('falls back to 300 for a non-number autoEnableSettleMs and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(normalizeSyncedSettings({ autoEnableSettleMs: 'abc' }).autoEnableSettleMs).toBe(300);
    expect(normalizeSyncedSettings({ autoEnableSettleMs: Number.NaN }).autoEnableSettleMs).toBe(300);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('autoEnableSettleMs'),
    );
  });

  it('falls back to 300 when autoEnableSettleMs is missing', () => {
    expect(normalizeSyncedSettings({}).autoEnableSettleMs).toBe(300);
  });
});

describe('normalizeLocalSettings', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to defaults for corrupt fields', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = normalizeLocalSettings({
      performanceTier: 'turbo',
      gpuBenchmarkResult: { tier: 'nope' },
      hasCompletedOnboarding: 'no',
      showDiagnostics: 1,
      restorePolicy: 'yes',
    });

    expect(result.performanceTier).toBe('balanced');
    expect(result.gpuBenchmarkResult).toBeNull();
    expect(result.hasCompletedOnboarding).toBe(false);
    expect(result.showDiagnostics).toBe(false);
    // A corrupt value falls back to the default (`gate`).
    expect(result.restorePolicy).toBe('gate');
  });

  it('defaults restorePolicy to gate when absent', () => {
    const result = normalizeLocalSettings({});
    expect(result.restorePolicy).toBe('gate');
  });

  it('accepts each valid restorePolicy value', () => {
    for (const policy of ['off', 'gate', 'trailing', 'leading'] as const) {
      expect(normalizeLocalSettings({ restorePolicy: policy }).restorePolicy).toBe(policy);
    }
  });

  it('maps a legacy preserveDetail boolean when restorePolicy is absent', () => {
    expect(normalizeLocalSettings({ preserveDetail: true }).restorePolicy).toBe('trailing');
    expect(normalizeLocalSettings({ preserveDetail: false }).restorePolicy).toBe('off');
    // The new key wins when both are present.
    expect(
      normalizeLocalSettings({ restorePolicy: 'leading', preserveDetail: true }).restorePolicy,
    ).toBe('leading');
  });

  it('ignores a stale legacy maxDetail key (no migration; defaults to gate)', () => {
    // The renamed setting must not read the old key: an absent `restorePolicy`
    // normalizes to the default `gate` even when `maxDetail` is present.
    const result = normalizeLocalSettings({ maxDetail: false });
    expect(result.restorePolicy).toBe('gate');
    expect('maxDetail' in result).toBe(false);
  });

  it('defaults diagnosticsDetail to auto and accepts valid modes', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(normalizeLocalSettings({}).diagnosticsDetail).toBe('auto');
    expect(normalizeLocalSettings({ diagnosticsDetail: 'compact' }).diagnosticsDetail).toBe('compact');
    expect(normalizeLocalSettings({ diagnosticsDetail: 'expanded' }).diagnosticsDetail).toBe('expanded');
    expect(normalizeLocalSettings({ diagnosticsDetail: 'nope' }).diagnosticsDetail).toBe('auto');
  });

  it('preserves valid values', () => {
    const result = normalizeLocalSettings({
      performanceTier: 'quality',
      gpuBenchmarkResult: {
        tier: 'quality',
        scores: { performance: 1, balanced: 2, quality: 3, ultra: 4 },
        maxScores: { performance: 1, balanced: 2, quality: 3, ultra: 4 },
        timestamp: 1,
        adapterInfo: 'mock',
      },
      hasCompletedOnboarding: true,
      showDiagnostics: true,
      restorePolicy: 'gate',
    });

    expect(result.performanceTier).toBe('quality');
    expect(result.gpuBenchmarkResult?.tier).toBe('quality');
    expect(result.hasCompletedOnboarding).toBe(true);
    expect(result.showDiagnostics).toBe(true);
    expect(result.restorePolicy).toBe('gate');
  });
});

describe('getSettings storage read path', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns defaults when stored settings are corrupt and does not throw', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    (chrome.storage.sync.get as any).mockImplementation((_keys: any, cb: any) =>
      cb({ customModes: 'corrupt', selectedModeId: 42, colorGrading: 'bad' }),
    );
    (chrome.storage.local.get as any).mockImplementation((_keys: any, cb: any) =>
      cb({ performanceTier: 'turbo', showDiagnostics: 'yes', gpuBenchmarkResult: { bad: true } }),
    );

    // Invalidate the module-level TTL cache so the corrupt values are re-read.
    capturedOnChanged?.();

    const [settings, local] = await Promise.all([getSettings(), getLocalSettings()]);

    expect(settings.customModes).toEqual([]);
    expect(settings.selectedModeId).toBe('builtin-mode-a');
    expect(settings.performanceTier).toBe('balanced');
    expect(local.showDiagnostics).toBe(false);
    expect(local.gpuBenchmarkResult).toBeNull();
    // Built-ins are always present even with no stored custom modes
    expect(settings.enhancementModes).toHaveLength(BUILTIN_MODES.length);
  });
});

describe('settings snapshot store', () => {
  beforeEach(() => {
    // Deterministic storage reads that resolve through the callback API used by
    // getSettings, regardless of implementations left behind by other tests.
    (chrome.storage.sync.get as any).mockImplementation((_keys: any, cb: any) => cb?.({}));
    (chrome.storage.local.get as any).mockImplementation((_keys: any, cb: any) => cb?.({}));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Invoke every registered chrome.storage.onChanged listener for an area. */
  function fireStorageChanged(areaName: string): void {
    const calls = (
      chrome.storage.onChanged.addListener as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls;
    for (const [listener] of calls) {
      (listener as (changes: unknown, area: string) => void)({}, areaName);
    }
  }

  it('publishes a snapshot with an increasing revision on each read', async () => {
    await getSettings();
    const first = getSnapshot();
    expect(first).not.toBeNull();
    expect(first!.revision).toBeGreaterThan(0);

    invalidate();
    await getSettings();
    const second = getSnapshot();
    expect(second!.revision).toBeGreaterThan(first!.revision);
  });

  it('invalidates on a sync/local storage change and re-reads immediately', async () => {
    let storedMode = 'builtin-mode-a';
    (chrome.storage.sync.get as any).mockImplementation((_keys: any, cb: any) =>
      cb?.({ selectedModeId: storedMode }),
    );

    await getSettings();
    const first = getSnapshot()!;
    expect(first.value.selectedModeId).toBe('builtin-mode-a');
    expect(isStale()).toBe(false);

    // Within the TTL the cached value is still returned (fallback behavior).
    storedMode = 'builtin-mode-c';
    expect((await getSettings()).selectedModeId).toBe('builtin-mode-a');

    // A storage change invalidates the snapshot -> the next read re-fetches.
    fireStorageChanged('sync');
    expect(isStale()).toBe(true);

    const refreshed = await getSettings();
    expect(refreshed.selectedModeId).toBe('builtin-mode-c');
    const second = getSnapshot()!;
    expect(second.revision).toBeGreaterThan(first.revision);
    expect(isStale()).toBe(false);
  });

  it('ignores onChanged events for unrelated storage areas', async () => {
    await getSettings();
    expect(isStale()).toBe(false);

    // Only exercise the snapshot store's own listener; settings.ts keeps a
    // legacy unguarded cache-clearing listener that is not under test here.
    const calls = (
      chrome.storage.onChanged.addListener as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls;
    for (const [listener] of calls) {
      if (listener === capturedOnChanged) continue;
      (listener as (changes: unknown, area: string) => void)({}, 'managed');
    }

    expect(isStale()).toBe(false);
  });

  it('never throws when chrome.storage.onChanged is unavailable', () => {
    const original = (chrome.storage as any).onChanged;
    try {
      delete (chrome.storage as any).onChanged;
      expect(() => setSnapshot({} as any)).not.toThrow();
    } finally {
      (chrome.storage as any).onChanged = original;
    }
  });
});
