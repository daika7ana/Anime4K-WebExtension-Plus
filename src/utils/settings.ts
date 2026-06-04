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
  BaseMode,
} from '../types';
import { AVAILABLE_EFFECTS } from './effects-map';
import { resolveEffectChain } from './effect-chain-templates';

// ===== Settings Cache =====
let cachedSettings: Anime4KWebExtSettings | null = null;
let cacheTimestamp = 0;
const SETTINGS_CACHE_TTL = 2000; // 2-second TTL

// Automatically invalidate cache when storage changes
chrome.storage.onChanged.addListener(() => {
  cachedSettings = null;
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
  warmupBatchSize: 3,
};

const DEFAULT_LOCAL_SETTINGS: LocalSettings = {
  performanceTier: 'balanced',
  gpuBenchmarkResult: null,
  hasCompletedOnboarding: false,
};

/**
 * Ensure effects in custom modes stay in sync with AVAILABLE_EFFECTS
 */
export function synchronizeEffectsForCustomModes(modes: CustomMode[]): CustomMode[] {
  const availableEffectsMap = new Map(
    AVAILABLE_EFFECTS.map(e => [e.id, e])
  );

  return modes.map(mode => {
    const synchronizedEffects = mode.effects
      .map(effectInMode => availableEffectsMap.get(effectInMode.id))
      .filter((effect): effect is EnhancementEffect => !!effect);

    return { ...mode, effects: synchronizedEffects };
  });
}

/**
 * Get synced settings (storage.sync)
 */
export async function getSyncedSettings(): Promise<SyncedSettings> {
  return new Promise(resolve => {
    chrome.storage.sync.get([
      'selectedModeId',
      'targetResolutionSetting',
      'whitelistEnabled',
      'whitelist',
      'customModes',
      'enableCrossOriginFix',
      'warmupBatchSize',
    ], (data) => {
      resolve({
        selectedModeId: data.selectedModeId ?? DEFAULT_SYNCED_SETTINGS.selectedModeId,
        targetResolutionSetting: data.targetResolutionSetting ?? DEFAULT_SYNCED_SETTINGS.targetResolutionSetting,
        whitelistEnabled: data.whitelistEnabled ?? DEFAULT_SYNCED_SETTINGS.whitelistEnabled,
        whitelist: data.whitelist ?? DEFAULT_SYNCED_SETTINGS.whitelist,
        customModes: data.customModes ?? DEFAULT_SYNCED_SETTINGS.customModes,
        enableCrossOriginFix: data.enableCrossOriginFix ?? DEFAULT_SYNCED_SETTINGS.enableCrossOriginFix,
        warmupBatchSize: data.warmupBatchSize ?? DEFAULT_SYNCED_SETTINGS.warmupBatchSize,
      });
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
    ], (data) => {
      resolve({
        performanceTier: data.performanceTier ?? DEFAULT_LOCAL_SETTINGS.performanceTier,
        gpuBenchmarkResult: data.gpuBenchmarkResult ?? DEFAULT_LOCAL_SETTINGS.gpuBenchmarkResult,
        hasCompletedOnboarding: data.hasCompletedOnboarding ?? DEFAULT_LOCAL_SETTINGS.hasCompletedOnboarding,
      });
    });
  });
}

/**
 * Get full settings (merged sync and local)
 * Built-in modes dynamically resolve effect chains based on the current tier
 * Uses a TTL cache to avoid redundant chrome.storage IPC calls
 */
export async function getSettings(): Promise<Anime4KWebExtSettings> {
  if (cachedSettings && (Date.now() - cacheTimestamp) < SETTINGS_CACHE_TTL) {
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
  return result;
}

/**
 * Save synced settings
 */
export async function saveSyncedSettings(settings: Partial<SyncedSettings>): Promise<void> {
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
    'warmupBatchSize',
  ];

  const localKeys: (keyof LocalSettings)[] = [
    'performanceTier',
    'gpuBenchmarkResult',
    'hasCompletedOnboarding',
  ];

  const syncSettings: Partial<SyncedSettings> = {};
  const localSettings: Partial<LocalSettings> = {};

  for (const key of syncKeys) {
    if (key in settings) {
      (syncSettings as any)[key] = (settings as any)[key];
    }
  }

  for (const key of localKeys) {
    if (key in settings) {
      (localSettings as any)[key] = (settings as any)[key];
    }
  }

  const promises: Promise<void>[] = [];
  if (Object.keys(syncSettings).length > 0) {
    promises.push(saveSyncedSettings(syncSettings));
  }
  if (Object.keys(localSettings).length > 0) {
    promises.push(saveLocalSettings(localSettings));
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

/**
 * Find a mode by its ID
 */
export function findModeById(
  modes: EnhancementMode[],
  modeId: string
): EnhancementMode | undefined {
  return modes.find(m => m.id === modeId);
}