import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ensureLatestConfig } from './migration';
import { AVAILABLE_EFFECTS } from './effects-map';
import { DEFAULT_COLOR_GRADING } from './validation';
import type { CustomMode } from '../types';

/**
 * In-memory storage backends used by the mocked chrome.storage APIs.
 * Reset before each test.
 */
let syncStore: Record<string, unknown>;
let localStore: Record<string, unknown>;

function mockStorageApi(): void {
  syncStore = {};
  localStore = {};

  // Promise-returning variants to match how migration.ts consumes them (await, no callback)
  (chrome.storage.sync.get as any).mockImplementation(
    (_keys: string | string[] | Record<string, unknown>): Promise<Record<string, unknown>> => {
      const out: Record<string, unknown> = {};
      if (Array.isArray(_keys)) {
        for (const k of _keys) {
          if (k in syncStore) out[k] = syncStore[k];
        }
      } else if (typeof _keys === 'object') {
        for (const k of Object.keys(_keys)) {
          if (k in syncStore) out[k] = syncStore[k];
        }
      }
      return Promise.resolve(out);
    },
  );

  vi.mocked(chrome.storage.sync.set).mockImplementation(
    (items: Record<string, unknown>): Promise<void> => {
      Object.assign(syncStore, items);
      return Promise.resolve();
    },
  );

  // remove is not stubbed by test-setup — register it
  if (!(chrome.storage.sync as any).remove) {
    (chrome.storage.sync as any).remove = vi.fn();
  }
  vi.mocked((chrome.storage.sync as any).remove).mockImplementation(
    (keys: string | string[]): Promise<void> => {
      const keyList = Array.isArray(keys) ? keys : [keys];
      for (const k of keyList) delete syncStore[k];
      return Promise.resolve();
    },
  );

  (chrome.storage.local.get as any).mockImplementation(
    (_keys: string | string[] | Record<string, unknown>): Promise<Record<string, unknown>> => {
      const out: Record<string, unknown> = {};
      if (Array.isArray(_keys)) {
        for (const k of _keys) {
          if (k in localStore) out[k] = localStore[k];
        }
      } else if (typeof _keys === 'object') {
        for (const k of Object.keys(_keys)) {
          if (k in localStore) out[k] = localStore[k];
        }
      }
      return Promise.resolve(out);
    },
  );

  vi.mocked(chrome.storage.local.set).mockImplementation(
    (items: Record<string, unknown>): Promise<void> => {
      Object.assign(localStore, items);
      return Promise.resolve();
    },
  );
}

/** Assert that every v3 synced field is present with the expected defaults. */
function expectV3SyncedDefaults(): void {
  expect(syncStore['_configVersion']).toBe(3);
  expect(syncStore['selectedModeId']).toBe('builtin-mode-a');
  expect(syncStore['targetResolutionSetting']).toBe('x2');
  expect(syncStore['whitelistEnabled']).toBe(false);
  expect(syncStore['whitelist']).toEqual([]);
  expect(syncStore['customModes']).toEqual([]);
  expect(syncStore['enableCrossOriginFix']).toBe(false);
  expect(syncStore['autoEnableOnWhitelist']).toBe(false);
  expect(syncStore['autoEnableSettleMs']).toBe(300);
  expect(syncStore['enableHotkey']).toBe(true);
  expect(syncStore['colorGrading']).toEqual(DEFAULT_COLOR_GRADING);
}

describe('ensureLatestConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStorageApi();
  });

  // ── No migration needed (already latest) ─────────────────────
  it('is a no-op when _configVersion is already 3', async () => {
    syncStore['_configVersion'] = 3;
    syncStore['customModes'] = [];
    syncStore['selectedModeId'] = 'builtin-mode-a';

    await ensureLatestConfig();

    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect((chrome.storage.sync as any).remove).not.toHaveBeenCalled();
  });

  it('is a no-op when _configVersion is > 3 (future version)', async () => {
    syncStore['_configVersion'] = 4;
    syncStore['customModes'] = [];

    await ensureLatestConfig();

    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  // ── v2 → v3 ──────────────────────────────────────────────────
  it('backfills v3 fields when upgrading from v2 without overwriting existing values', async () => {
    syncStore['_configVersion'] = 2;
    syncStore['enableHotkey'] = false; // existing value must be preserved
    const existingGrading = {
      enabled: true,
      brightness: 0.5,
      gamma: 1.2,
      contrast: 1,
      saturation: 1,
      vibrance: 0,
      exposure: 0,
    };
    syncStore['colorGrading'] = existingGrading;
    localStore['performanceTier'] = 'quality'; // existing local value preserved

    await ensureLatestConfig();

    expect(syncStore['_configVersion']).toBe(3);
    // Missing fields are backfilled with defaults (synced bucket)
    expect(syncStore['autoEnableOnWhitelist']).toBe(false);
    expect(syncStore['autoEnableSettleMs']).toBe(300);
    // Existing values are untouched
    expect(syncStore['enableHotkey']).toBe(false);
    expect(syncStore['colorGrading']).toEqual(existingGrading);
    // Local backfill (local bucket)
    expect(localStore['showDiagnostics']).toBe(false);
    expect(localStore['diagnosticsDetail']).toBe('auto');
    expect(localStore['preserveDetail']).toBe(true);
    expect(localStore['performanceTier']).toBe('quality');
  });

  it('does not overwrite existing v3 fields during v2 → v3', async () => {
    syncStore['_configVersion'] = 2;
    syncStore['autoEnableSettleMs'] = 750;
    localStore['diagnosticsDetail'] = 'expanded';
    localStore['preserveDetail'] = false;

    await ensureLatestConfig();

    expect(syncStore['_configVersion']).toBe(3);
    // Existing synced values preserved
    expect(syncStore['autoEnableSettleMs']).toBe(750);
    // Existing local values preserved
    expect(localStore['diagnosticsDetail']).toBe('expanded');
    expect(localStore['preserveDetail']).toBe(false);
  });

  it('does not overwrite an existing showDiagnostics during v2 → v3', async () => {
    syncStore['_configVersion'] = 2;
    localStore['showDiagnostics'] = true;

    await ensureLatestConfig();

    expect(syncStore['_configVersion']).toBe(3);
    expect(localStore['showDiagnostics']).toBe(true);
  });

  // ── v1 → v3 ──────────────────────────────────────────────────
  it('migrates v1 all the way to v3', async () => {
    syncStore['enhancementModes'] = [
      {
        id: 'my-custom',
        name: 'My Custom Mode',
        isBuiltIn: false,
        effects: [
          { id: 'anime4k/Sharpen/CAS', name: 'CAS', className: 'CAS', params: { sharpness: 0.8 } },
        ],
      },
    ];
    syncStore['selectedModeId'] = 'builtin-mode-b';
    syncStore['targetResolutionSetting'] = 'x4';
    syncStore['whitelistEnabled'] = true;

    await ensureLatestConfig();

    expect(syncStore['_configVersion']).toBe(3);
    expect(syncStore['customModes']).toHaveLength(1);
    expect((syncStore['customModes'] as CustomMode[])[0].id).toBe('my-custom');
    expect(syncStore['selectedModeId']).toBe('builtin-mode-b');
    expect(syncStore['targetResolutionSetting']).toBe('x4');
    expect(syncStore['whitelistEnabled']).toBe(true);
    // Old key removed
    expect(syncStore['enhancementModes']).toBeUndefined();
    // v3 backfill applied by the second migration step
    expect(syncStore['autoEnableOnWhitelist']).toBe(false);
    expect(syncStore['enableHotkey']).toBe(true);
    expect(syncStore['colorGrading']).toEqual(DEFAULT_COLOR_GRADING);
    // Local defaults set
    expect(localStore['performanceTier']).toBe('balanced');
    expect(localStore['showDiagnostics']).toBe(false);
  });

  it('migrates when _configVersion < 2 and enhancementModes exists', async () => {
    syncStore['_configVersion'] = 1;
    syncStore['enhancementModes'] = [
      {
        id: 'my-custom',
        name: 'Custom',
        isBuiltIn: false,
        effects: [{ id: 'anime4k/Deblur/DoG', name: 'DoG', className: 'DoG', params: { strength: 4 } }],
      },
    ];

    await ensureLatestConfig();

    expect(syncStore['_configVersion']).toBe(3);
    expect(syncStore['customModes']).toHaveLength(1);
    expect(syncStore['enhancementModes']).toBeUndefined();
  });

  it('advances a v1 config without enhancementModes to v3', async () => {
    syncStore['_configVersion'] = 1;

    await ensureLatestConfig();

    expect(syncStore['_configVersion']).toBe(3);
    expect(syncStore['autoEnableOnWhitelist']).toBe(false);
    expect(syncStore['enableHotkey']).toBe(true);
    expect(localStore['showDiagnostics']).toBe(false);
  });

  // ── Filtering built-in modes during migration ────────────────
  it('filters out built-in modes during migration (only custom modes preserved)', async () => {
    syncStore['enhancementModes'] = [
      { id: 'builtin-mode-a', name: 'Mode A', isBuiltIn: true, effects: [] },
      { id: 'my-custom', name: 'Custom', isBuiltIn: false, effects: [] },
      { id: 'builtin-mode-b', name: 'Mode B', isBuiltIn: true, effects: [] },
    ];

    await ensureLatestConfig();

    const customModes = syncStore['customModes'] as CustomMode[];
    expect(customModes).toHaveLength(1);
    expect(customModes[0].id).toBe('my-custom');
  });

  // ── Effect syncing during migration ──────────────────────────
  it('preserves effects that exist in AVAILABLE_EFFECTS catalog', async () => {
    syncStore['enhancementModes'] = [
      {
        id: 'my-custom',
        name: 'Custom',
        isBuiltIn: false,
        effects: [
          { id: 'anime4k/Sharpen/CAS', name: 'CAS', className: 'CAS' },
          { id: 'anime4k/Deblur/DoG', name: 'DoG', className: 'DoG' },
        ],
      },
    ];

    await ensureLatestConfig();

    const customModes = syncStore['customModes'] as CustomMode[];
    expect(customModes[0].effects).toHaveLength(2);
    expect(customModes[0].effects[0].id).toBe('anime4k/Sharpen/CAS');
    expect(customModes[0].effects[1].id).toBe('anime4k/Deblur/DoG');
  });

  it('filters out effects not in AVAILABLE_EFFECTS catalog', async () => {
    syncStore['enhancementModes'] = [
      {
        id: 'my-custom',
        name: 'Custom',
        isBuiltIn: false,
        effects: [
          { id: 'anime4k/Sharpen/CAS', name: 'CAS', className: 'CAS' },
          { id: 'anime4k/Removed/Effect', name: 'Gone', className: 'Gone' },
        ],
      },
    ];

    await ensureLatestConfig();

    const customModes = syncStore['customModes'] as CustomMode[];
    expect(customModes[0].effects).toHaveLength(1);
    expect(customModes[0].effects[0].id).toBe('anime4k/Sharpen/CAS');
  });

  // ── Built-in mode ID mapping ─────────────────────────────────
  it('maps old built-in mode IDs to new IDs correctly', async () => {
    const ids = [
      'builtin-mode-a',
      'builtin-mode-b',
      'builtin-mode-c',
      'builtin-mode-aa',
      'builtin-mode-bb',
      'builtin-mode-ca',
    ];

    for (const id of ids) {
      syncStore = {};
      localStore = {};
      syncStore['enhancementModes'] = [];
      syncStore['selectedModeId'] = id;
      await ensureLatestConfig();
      expect(syncStore['selectedModeId']).toBe(id);
    }
  });

  // ── Preserving other sync settings ───────────────────────────
  it('preserves whitelist settings', async () => {
    const whitelist = [{ pattern: 'example.com', enabled: true }];
    syncStore['enhancementModes'] = [];
    syncStore['whitelistEnabled'] = true;
    syncStore['whitelist'] = whitelist;

    await ensureLatestConfig();

    expect(syncStore['whitelistEnabled']).toBe(true);
    expect(syncStore['whitelist']).toEqual(whitelist);
  });

  it('preserves enableCrossOriginFix', async () => {
    syncStore['enhancementModes'] = [];
    syncStore['enableCrossOriginFix'] = true;

    await ensureLatestConfig();

    expect(syncStore['enableCrossOriginFix']).toBe(true);
  });

  // ── Fresh install ────────────────────────────────────────────
  it('initializes default config at v3 for a fresh install', async () => {
    await ensureLatestConfig();

    expectV3SyncedDefaults();
    expect(localStore['performanceTier']).toBe('balanced');
    expect(localStore['gpuBenchmarkResult']).toBeNull();
    expect(localStore['gpuAdapterInfo']).toBeNull();
    expect(localStore['hasCompletedOnboarding']).toBe(false);
    expect(localStore['showDiagnostics']).toBe(false);
    expect(localStore['diagnosticsDetail']).toBe('auto');
    expect(localStore['preserveDetail']).toBe(true);
  });

  // ── Local defaults when performanceTier already set ──────────
  it('does not overwrite existing performanceTier during migration', async () => {
    syncStore['enhancementModes'] = [];
    localStore['performanceTier'] = 'quality';

    await ensureLatestConfig();

    expect(localStore['performanceTier']).toBe('quality');
  });

  // ── Idempotency ──────────────────────────────────────────────
  it('is idempotent: a second run after a fresh install performs no writes', async () => {
    await ensureLatestConfig();
    expect(syncStore['_configVersion']).toBe(3);

    vi.clearAllMocks();

    await ensureLatestConfig();

    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(syncStore['_configVersion']).toBe(3);
  });

  it('is idempotent: a second run after a v1 migration performs no writes', async () => {
    syncStore['_configVersion'] = 1;
    syncStore['enhancementModes'] = [];

    await ensureLatestConfig();
    expect(syncStore['_configVersion']).toBe(3);

    vi.clearAllMocks();

    await ensureLatestConfig();

    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  // ── Robustness against corrupt stored config ─────────────────
  it('treats a non-array string enhancementModes as empty without throwing', async () => {
    syncStore['enhancementModes'] = 'corrupt-not-an-array';

    await expect(ensureLatestConfig()).resolves.toBeUndefined();

    expect(syncStore['_configVersion']).toBe(3);
    expect(syncStore['customModes']).toEqual([]);
    expect(syncStore['enhancementModes']).toBeUndefined();
  });

  it('treats a non-array object enhancementModes as empty without throwing', async () => {
    syncStore['enhancementModes'] = { bogus: true };

    await expect(ensureLatestConfig()).resolves.toBeUndefined();

    expect(syncStore['_configVersion']).toBe(3);
    expect(syncStore['customModes']).toEqual([]);
  });

  it('skips null/non-object mode entries without throwing', async () => {
    syncStore['enhancementModes'] = [
      null,
      undefined,
      'not-a-mode',
      42,
      { id: 'my-custom', name: 'Custom', isBuiltIn: false, effects: [] },
    ];

    await expect(ensureLatestConfig()).resolves.toBeUndefined();

    const customModes = syncStore['customModes'] as CustomMode[];
    expect(syncStore['_configVersion']).toBe(3);
    expect(customModes).toHaveLength(1);
    expect(customModes[0].id).toBe('my-custom');
  });

  it('skips a custom mode whose effects array is missing or malformed', async () => {
    syncStore['enhancementModes'] = [
      { id: 'no-effects', name: 'No Effects', isBuiltIn: false },
      { id: 'string-effects', name: 'String Effects', isBuiltIn: false, effects: 'nope' },
      { id: 'valid', name: 'Valid', isBuiltIn: false, effects: [] },
    ];

    await expect(ensureLatestConfig()).resolves.toBeUndefined();

    const customModes = syncStore['customModes'] as CustomMode[];
    expect(syncStore['_configVersion']).toBe(3);
    expect(customModes).toHaveLength(1);
    expect(customModes[0].id).toBe('valid');
    expect(customModes[0].effects).toEqual([]);
  });

  it('keeps a valid mode while dropping malformed effect entries', async () => {
    syncStore['enhancementModes'] = [
      {
        id: 'my-custom',
        name: 'Custom',
        isBuiltIn: false,
        effects: [
          null,
          { name: 'missing id' },
          { id: 'anime4k/Removed/Effect', name: 'Gone', className: 'Gone' },
          { id: 'anime4k/Sharpen/CAS', name: 'CAS', className: 'CAS' },
        ],
      },
    ];

    await expect(ensureLatestConfig()).resolves.toBeUndefined();

    const customModes = syncStore['customModes'] as CustomMode[];
    expect(customModes).toHaveLength(1);
    expect(customModes[0].effects).toHaveLength(1);
    expect(customModes[0].effects[0].id).toBe('anime4k/Sharpen/CAS');
  });

  it('merges customized v1 effect params over catalog defaults', async () => {
    const dogCatalog = AVAILABLE_EFFECTS.find(e => e.id === 'anime4k/Deblur/DoG')!;
    const bilateralCatalog = AVAILABLE_EFFECTS.find(
      e => e.id === 'anime4k/Denoise/BilateralMean',
    )!;

    syncStore['enhancementModes'] = [
      {
        id: 'my-custom',
        name: 'Custom',
        isBuiltIn: false,
        effects: [
          { id: 'anime4k/Deblur/DoG', name: 'DoG', className: 'DoG', params: { strength: 9 } },
          {
            id: 'anime4k/Denoise/BilateralMean',
            name: 'BilateralMean',
            className: 'BilateralMean',
            params: { strength: 0.9 },
          },
        ],
      },
    ];

    await ensureLatestConfig();

    const customModes = syncStore['customModes'] as CustomMode[];
    const dog = customModes[0].effects.find(e => e.id === 'anime4k/Deblur/DoG')!;
    const bilateral = customModes[0].effects.find(
      e => e.id === 'anime4k/Denoise/BilateralMean',
    )!;

    // Stored user value wins over the catalog default…
    expect(dog.params?.strength).toBe(9);
    expect(dog.params).toEqual({ ...(dogCatalog.params ?? {}), strength: 9 });
    expect(bilateral.params?.strength).toBe(0.9);
    // …while unmodified catalog defaults are preserved.
    expect(bilateral.params).toEqual({ ...(bilateralCatalog.params ?? {}), strength: 0.9 });
    expect(bilateral.params).toHaveProperty('strength2', bilateralCatalog.params?.strength2);
  });

  it('keeps catalog defaults when a v1 effect has no params', async () => {
    const dogCatalog = AVAILABLE_EFFECTS.find(e => e.id === 'anime4k/Deblur/DoG')!;
    if (!dogCatalog.params) return; // no defaults to assert against

    syncStore['enhancementModes'] = [
      {
        id: 'my-custom',
        name: 'Custom',
        isBuiltIn: false,
        effects: [{ id: 'anime4k/Deblur/DoG', name: 'DoG', className: 'DoG' }],
      },
    ];

    await ensureLatestConfig();

    const customModes = syncStore['customModes'] as CustomMode[];
    expect(customModes[0].effects[0].params).toEqual(dogCatalog.params);
  });
});
