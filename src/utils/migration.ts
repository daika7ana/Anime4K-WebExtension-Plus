/**
 * Configuration migration module
 * Handles migration from v1 config format to v2 config format
 */

import type { CustomMode, EnhancementEffect, PerformanceTier } from '../types';
import { AVAILABLE_EFFECTS } from './effects-map';

// v1 mode definitions (legacy format)
interface V1EnhancementMode {
    id: string;
    name: string;
    isBuiltIn: boolean;
    effects: EnhancementEffect[];
}

// Config version
const CURRENT_CONFIG_VERSION = 2;

/**
 * Check if migration is needed
 */
async function needsMigration(): Promise<boolean> {
    const data = await chrome.storage.sync.get(['_configVersion', 'enhancementModes']);

    // If already on the new version, no migration needed
    if (data._configVersion >= CURRENT_CONFIG_VERSION) {
        return false;
    }

    // If old enhancementModes data exists, migration is needed
    if (data.enhancementModes) {
        return true;
    }

    return false;
}

/**
 * Execute migration from v1 to v2
 */
async function migrateV1ToV2(): Promise<void> {
    console.log('[Migration] Starting v1 to v2 migration...');

    const syncData = await chrome.storage.sync.get([
        'enhancementModes',
        'selectedModeId',
        'targetResolutionSetting',
        'whitelistEnabled',
        'whitelist',
        'enableCrossOriginFix',
    ]);

    const oldModes = syncData.enhancementModes as V1EnhancementMode[] | undefined;

    // Extract user custom modes (preserve full effect chains)
    const customModes: CustomMode[] = [];
    if (oldModes) {
        for (const mode of oldModes) {
            if (!mode.isBuiltIn) {
                // Sync effect definitions, removing effects that no longer exist
                const syncedEffects = mode.effects
                    .map(e => AVAILABLE_EFFECTS.find(ae => ae.id === e.id))
                    .filter((e): e is EnhancementEffect => !!e);

                customModes.push({
                    id: mode.id,
                    name: mode.name,
                    isBuiltIn: false,
                    effects: syncedEffects,
                });
            }
        }
    }

    // Determine the selected mode ID
    let selectedModeId = syncData.selectedModeId || 'builtin-mode-a';

    // If the selected mode is an old built-in mode, map to the new ID
    const builtInModeMap: Record<string, string> = {
        'builtin-mode-a': 'builtin-mode-a',
        'builtin-mode-b': 'builtin-mode-b',
        'builtin-mode-c': 'builtin-mode-c',
        'builtin-mode-aa': 'builtin-mode-aa',
        'builtin-mode-bb': 'builtin-mode-bb',
        'builtin-mode-ca': 'builtin-mode-ca',
    };

    if (builtInModeMap[selectedModeId]) {
        selectedModeId = builtInModeMap[selectedModeId];
    }

    // Save migrated data
    await chrome.storage.sync.set({
        customModes,
        selectedModeId,
        targetResolutionSetting: syncData.targetResolutionSetting || 'x2',
        whitelistEnabled: syncData.whitelistEnabled ?? false,
        whitelist: syncData.whitelist || [],
        enableCrossOriginFix: syncData.enableCrossOriginFix ?? false,
        _configVersion: CURRENT_CONFIG_VERSION,
    });

    // Clean up old data
    await chrome.storage.sync.remove('enhancementModes');

    // Set default local settings
    const localData = await chrome.storage.local.get(['performanceTier']);
    if (!localData.performanceTier) {
        await chrome.storage.local.set({
            performanceTier: 'balanced' as PerformanceTier,
            gpuBenchmarkResult: null,
            gpuAdapterInfo: null,
            hasCompletedOnboarding: false,
        });
    }

    console.log('[Migration] v1 to v2 migration completed');
    console.log(`[Migration] Migrated ${customModes.length} custom modes`);
}

/**
 * Ensure the config is on the latest version
 */
export async function ensureLatestConfig(): Promise<void> {
    const needs = await needsMigration();
    if (needs) {
        await migrateV1ToV2();
    } else {
        // Ensure new fields exist (for fresh installs)
        const syncData = await chrome.storage.sync.get(['_configVersion']);
        if (!syncData._configVersion) {
            await chrome.storage.sync.set({
                customModes: [],
                selectedModeId: 'builtin-mode-a',
                targetResolutionSetting: 'x2',
                whitelistEnabled: false,
                whitelist: [],
                enableCrossOriginFix: false,
                _configVersion: CURRENT_CONFIG_VERSION,
            });

            await chrome.storage.local.set({
                performanceTier: 'balanced' as PerformanceTier,
                gpuBenchmarkResult: null,
                gpuAdapterInfo: null,
                hasCompletedOnboarding: false,
            });

            console.log('[Migration] Initialized new config with defaults');
        }
    }
}
