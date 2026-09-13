/**
 * Settings management module
 * Handles read/write operations for storage.sync (cross-device sync) and storage.local (local storage)
 */

import type {
  Anime4KWebExtSettings,
  SyncedSettings,
  LocalSettings,
  EnhancementMode,
  BuiltInMode,
  CustomMode,
  EnhancementEffect,
  PerformanceTier,
  DiagnosticsDetailMode,
  RestorePolicy,
} from '../types';
import { descriptorToCatalogEffect } from './effects-map';
import { resolveEffectReference } from './effect-registry';
import { resolveEffectChain } from './effect-chain-templates';
import { getSnapshot, invalidate, isStale, setSnapshot } from './settings-snapshot';
import {
  DEFAULT_COLOR_GRADING,
  isPerformanceTier,
  isValidResolutionSetting,
  sanitizeColorGrading,
  sanitizeCustomModes,
  sanitizeWhitelist,
  validateGPUBenchmarkResult,
} from './validation';

// ===== Settings Cache =====
let cachedSettings: Anime4KWebExtSettings | null = null;
let cacheTimestamp = 0;
const SETTINGS_CACHE_TTL = 2000; // 2-second TTL

// Automatically invalidate cache when storage changes
chrome.storage.onChanged.addListener(() => {
  cachedSettings = null;
  // Also mark the revisioned snapshot stale so getSettings bypasses the TTL
  // immediately rather than waiting for it to expire.
  invalidate();
});

// ===== Built-in Mode Definitions =====
export const BUILTIN_MODES: BuiltInMode[] = [
  { id: 'builtin-mode-a', baseMode: 'A', name: 'Mode A', isBuiltIn: true },
  { id: 'builtin-mode-b', baseMode: 'B', name: 'Mode B', isBuiltIn: true },
  { id: 'builtin-mode-c', baseMode: 'C', name: 'Mode C', isBuiltIn: true },
  { id: 'builtin-mode-aa', baseMode: 'A+A', name: 'Mode A+A', isBuiltIn: true },
  { id: 'builtin-mode-bb', baseMode: 'B+B', name: 'Mode B+B', isBuiltIn: true },
  { id: 'builtin-mode-ca', baseMode: 'C+A', name: 'Mode C+A', isBuiltIn: true },
];

// ===== Default Settings =====
const DEFAULT_SYNCED_SETTINGS: SyncedSettings = {
  selectedModeId: 'builtin-mode-a',
  targetResolutionSetting: 'x2',
  whitelistEnabled: false,
  whitelist: [],
  customModes: [],
  enableCrossOriginFix: false,
  autoEnableOnWhitelist: false,
  autoEnableSettleMs: 300,
  enableHotkey: true,
  colorGrading: { ...DEFAULT_COLOR_GRADING },
};

const DEFAULT_LOCAL_SETTINGS: LocalSettings = {
  performanceTier: 'balanced',
  gpuBenchmarkResult: null,
  hasCompletedOnboarding: false,
  showDiagnostics: false,
  // 'auto' expands on normal videos and compacts on small ones.
  diagnosticsDetail: 'auto',
  // Fresh/normalized-missing default: `gate` (keep every restore, gate each one).
  // The v3→v4 migration maps the legacy `preserveDetail` boolean for existing
  // users, so their behavior is unchanged.
  restorePolicy: 'gate',
};

/**
 * Ensure effects in custom modes stay in sync with the effective catalog.
 *
 * Each persisted effect is resolved through the engine seam:
 * - resolved  → canonicalized to the descriptor's catalog shape, merging user
 *               params over catalog defaults (user values win);
 * - unresolved → a well-formed new-style reference for a backend this device
 *               does not have is preserved as-is (cross-device forward compat);
 * - unknown   → legacy entry with unknown id AND className, dropped.
 */
export function synchronizeEffectsForCustomModes(modes: CustomMode[]): CustomMode[] {
  return modes.map(mode => {
    const synchronizedEffects = mode.effects
      .map(effectInMode => {
        const resolution = resolveEffectReference(effectInMode);

        if (resolution.status === 'unresolved') return effectInMode;
        if (resolution.status === 'unknown') return null;

        const catalogEffect = descriptorToCatalogEffect(resolution.effect.descriptor);
        // Preserve user-customized params (e.g. CAS sharpness) over catalog defaults
        if (effectInMode.params && Object.keys(effectInMode.params).length > 0) {
          return { ...catalogEffect, params: { ...catalogEffect.params, ...effectInMode.params } };
        }
        return catalogEffect;
      })
      .filter((effect): effect is EnhancementEffect => !!effect);

    return { ...mode, effects: synchronizedEffects };
  });
}

function describeStoredType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function warnInvalidSetting(key: string, value: unknown): void {
  console.warn(
    `[Settings] Ignoring invalid stored value for "${key}" (${describeStoredType(value)}); using default.`,
  );
}

function coerceBoolean(key: string, value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  warnInvalidSetting(key, value);
  return fallback;
}

function coerceNonEmptyString(key: string, value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value === 'string' && value.trim() !== '') return value;
  warnInvalidSetting(key, value);
  return fallback;
}

function coerceResolutionSetting(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (isValidResolutionSetting(value)) return value;
  warnInvalidSetting('targetResolutionSetting', value);
  return fallback;
}

function coercePerformanceTier(value: unknown, fallback: PerformanceTier): PerformanceTier {
  if (value === undefined) return fallback;
  if (isPerformanceTier(value)) return value;
  warnInvalidSetting('performanceTier', value);
  return fallback;
}

function coerceDiagnosticsDetail(
  value: unknown,
  fallback: DiagnosticsDetailMode,
): DiagnosticsDetailMode {
  if (value === undefined) return fallback;
  if (value === 'auto' || value === 'compact' || value === 'expanded') return value;
  warnInvalidSetting('diagnosticsDetail', value);
  return fallback;
}

function coerceRestorePolicy(value: unknown, fallback: RestorePolicy): RestorePolicy {
  if (value === undefined) return fallback;
  if (
    value === 'off'
    || value === 'gate'
    || value === 'trailing'
    || value === 'leading'
  ) {
    return value;
  }
  warnInvalidSetting('restorePolicy', value);
  return fallback;
}

/**
 * Map the pre-v4 local `preserveDetail` boolean to the new policy enum, or
 * `undefined` when the stored value is absent/non-boolean. Used only as a
 * fallback when `restorePolicy` itself is absent (see {@link normalizeLocalSettings}).
 */
function legacyRestorePolicyFromPreserveDetail(value: unknown): RestorePolicy | undefined {
  if (typeof value !== 'boolean') return undefined;
  return value ? 'trailing' : 'off';
}

function coerceAutoEnableSettleMs(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(Math.min(Math.max(value, 0), 10000));
  }
  warnInvalidSetting('autoEnableSettleMs', value);
  return fallback;
}

/**
 * Normalize untrusted synced settings read from storage, falling back to
 * defaults for any field that is missing, the wrong type, or out of range.
 */
export function normalizeSyncedSettings(data: Record<string, unknown>): SyncedSettings {
  return {
    selectedModeId: coerceNonEmptyString(
      'selectedModeId',
      data.selectedModeId,
      DEFAULT_SYNCED_SETTINGS.selectedModeId,
    ),
    targetResolutionSetting: coerceResolutionSetting(
      data.targetResolutionSetting,
      DEFAULT_SYNCED_SETTINGS.targetResolutionSetting,
    ),
    whitelistEnabled: coerceBoolean(
      'whitelistEnabled',
      data.whitelistEnabled,
      DEFAULT_SYNCED_SETTINGS.whitelistEnabled,
    ),
    whitelist: sanitizeWhitelist(data.whitelist),
    customModes: sanitizeCustomModes(data.customModes),
    enableCrossOriginFix: coerceBoolean(
      'enableCrossOriginFix',
      data.enableCrossOriginFix,
      DEFAULT_SYNCED_SETTINGS.enableCrossOriginFix,
    ),
    autoEnableOnWhitelist: coerceBoolean(
      'autoEnableOnWhitelist',
      data.autoEnableOnWhitelist,
      DEFAULT_SYNCED_SETTINGS.autoEnableOnWhitelist,
    ),
    autoEnableSettleMs: coerceAutoEnableSettleMs(
      data.autoEnableSettleMs,
      DEFAULT_SYNCED_SETTINGS.autoEnableSettleMs,
    ),
    enableHotkey: coerceBoolean(
      'enableHotkey',
      data.enableHotkey,
      DEFAULT_SYNCED_SETTINGS.enableHotkey,
    ),
    colorGrading: sanitizeColorGrading(data.colorGrading),
  };
}

/**
 * Normalize untrusted local settings read from storage, falling back to
 * defaults for any field that is missing, the wrong type, or out of range.
 */
export function normalizeLocalSettings(data: Record<string, unknown>): LocalSettings {
  const benchmark = validateGPUBenchmarkResult(data.gpuBenchmarkResult);
  if (
    !benchmark.ok &&
    data.gpuBenchmarkResult !== undefined &&
    data.gpuBenchmarkResult !== null
  ) {
    console.warn('[Settings] Ignoring invalid stored gpuBenchmarkResult; using default.');
  }
  return {
    performanceTier: coercePerformanceTier(
      data.performanceTier,
      DEFAULT_LOCAL_SETTINGS.performanceTier,
    ),
    gpuBenchmarkResult: benchmark.ok
      ? benchmark.value
      : DEFAULT_LOCAL_SETTINGS.gpuBenchmarkResult,
    hasCompletedOnboarding: coerceBoolean(
      'hasCompletedOnboarding',
      data.hasCompletedOnboarding,
      DEFAULT_LOCAL_SETTINGS.hasCompletedOnboarding,
    ),
    showDiagnostics: coerceBoolean(
      'showDiagnostics',
      data.showDiagnostics,
      DEFAULT_LOCAL_SETTINGS.showDiagnostics,
    ),
    diagnosticsDetail: coerceDiagnosticsDetail(
      data.diagnosticsDetail,
      DEFAULT_LOCAL_SETTINGS.diagnosticsDetail ?? 'auto',
    ),
    // A stale legacy `maxDetail` key is deliberately not read (ignored/dropped).
    // `restorePolicy` is authoritative; a legacy `preserveDetail` boolean is
    // mapped only when the new key is absent (true → 'trailing', false → 'off').
    restorePolicy: coerceRestorePolicy(
      data.restorePolicy,
      legacyRestorePolicyFromPreserveDetail(data.preserveDetail)
        ?? DEFAULT_LOCAL_SETTINGS.restorePolicy
        ?? 'gate',
    ),
  };
}

/**
 * Get synced settings (storage.sync)
 */
async function getSyncedSettings(): Promise<SyncedSettings> {
  return new Promise(resolve => {
    chrome.storage.sync.get([
      'selectedModeId',
      'targetResolutionSetting',
      'whitelistEnabled',
      'whitelist',
      'customModes',
      'enableCrossOriginFix',
      'autoEnableOnWhitelist',
      'autoEnableSettleMs',
      'enableHotkey',
      'colorGrading',
    ], (data) => {
      resolve(normalizeSyncedSettings(data));
    });
  });
}

/**
 * Get local settings (storage.local)
 */
export async function getLocalSettings(): Promise<LocalSettings> {
  return new Promise(resolve => {
    chrome.storage.local.get([
      'performanceTier',
      'gpuBenchmarkResult',
      'gpuAdapterInfo',
      'hasCompletedOnboarding',
      'showDiagnostics',
      'diagnosticsDetail',
      'restorePolicy',
      'preserveDetail',
    ], (data) => {
      resolve(normalizeLocalSettings(data));
    });
  });
}

/**
 * Get full settings (merged sync and local)
 * Built-in modes dynamically resolve effect chains based on the current tier
 * Uses a TTL cache to avoid redundant chrome.storage IPC calls
 */
export async function getSettings(): Promise<Anime4KWebExtSettings> {
  // The snapshot becomes stale as soon as a relevant storage area changes
  // (see settings-snapshot.ts), which bypasses the TTL so changes are observed
  // immediately. When nothing has changed we keep the existing TTL behavior as a
  // fallback to avoid redundant chrome.storage IPC calls.
  const snapshot = getSnapshot();
  const snapshotUsable = snapshot !== null && !isStale();

  if (cachedSettings && snapshotUsable && (Date.now() - cacheTimestamp) < SETTINGS_CACHE_TTL) {
    return cachedSettings;
  }

  const [synced, local] = await Promise.all([
    getSyncedSettings(),
    getLocalSettings(),
  ]);

  // Sync effects for custom modes
  const syncedCustomModes = synchronizeEffectsForCustomModes(synced.customModes);

  // Merge built-in modes and custom modes
  const enhancementModes: EnhancementMode[] = [
    ...BUILTIN_MODES,
    ...syncedCustomModes,
  ];

  const result: Anime4KWebExtSettings = {
    ...synced,
    customModes: syncedCustomModes,
    performanceTier: local.performanceTier,
    enhancementModes,
  };

  cachedSettings = result;
  cacheTimestamp = Date.now();
  setSnapshot(result);
  return result;
}

/**
 * Save synced settings
 */
async function saveSyncedSettings(settings: Partial<SyncedSettings>): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.set(settings, () => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Save local settings
 */
export async function saveLocalSettings(settings: Partial<LocalSettings>): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(settings, () => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Save settings (legacy API compatible, automatically splits into sync and local)
 */
export async function saveSettings(settings: Partial<Anime4KWebExtSettings>): Promise<void> {
  const syncKeys: (keyof SyncedSettings)[] = [
    'selectedModeId',
    'targetResolutionSetting',
    'whitelistEnabled',
    'whitelist',
    'customModes',
    'enableCrossOriginFix',
    'autoEnableOnWhitelist',
    'autoEnableSettleMs',
    'enableHotkey',
    'colorGrading',
  ];

  const localKeys: (keyof LocalSettings)[] = [
    'performanceTier',
    'gpuBenchmarkResult',
    'hasCompletedOnboarding',
    'showDiagnostics',
    'diagnosticsDetail',
    'restorePolicy',
  ];

  const syncSettings: Partial<Record<keyof SyncedSettings, unknown>> = {};
  const localSettings: Partial<Record<keyof LocalSettings, unknown>> = {};

  // Cast to Record<string, unknown> so we can dynamically index on keys
  // that may exist at runtime but aren't part of the compile-time Partial<Anime4KWebExtSettings>
  // (e.g. gpuBenchmarkResult lives in LocalSettings but not in Anime4KWebExtSettings).
  const source = settings as Record<string, unknown>;

  for (const key of syncKeys) {
    if (key in settings) {
      syncSettings[key] = source[key];
    }
  }

  for (const key of localKeys) {
    if (key in settings) {
      localSettings[key] = source[key];
    }
  }

  const promises: Promise<void>[] = [];
  if (Object.keys(syncSettings).length > 0) {
    promises.push(saveSyncedSettings(syncSettings as Partial<SyncedSettings>));
  }
  if (Object.keys(localSettings).length > 0) {
    promises.push(saveLocalSettings(localSettings as Partial<LocalSettings>));
  }

  await Promise.all(promises);
}

/**
 * Get the actual effect chain for a given mode and tier
 */
export function getEffectsForMode(
  mode: EnhancementMode,
  tier: PerformanceTier
): EnhancementEffect[] {
  if (mode.isBuiltIn) {
    // Built-in mode: dynamically resolve based on tier
    return resolveEffectChain((mode as BuiltInMode).baseMode, tier);
  } else {
    // Custom mode: use the user-defined effect chain
    return (mode as CustomMode).effects;
  }
}

