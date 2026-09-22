/**
 * Configuration migration module
 * Handles migration from v1 → v2 → v3 → v4 config formats.
 *
 * Migrations run as an ordered, idempotent chain in `ensureLatestConfig`:
 * each step only runs when the stored `_configVersion` is below the version it
 * produces, and re-running the whole chain once the config is current performs
 * no writes.
 */

import type { CustomMode, EnhancementEffect, PerformanceTier } from '../types';
import { AVAILABLE_EFFECTS } from './effects-map';
import { DEFAULT_COLOR_GRADING } from './validation';

// v1 mode definitions (legacy format). Stored data is untrusted, so every
// field is treated as optional/unknown until validated at runtime.
interface V1EnhancementMode {
    id?: unknown;
    name?: unknown;
    isBuiltIn?: unknown;
    effects?: unknown;
}

/**
 * Map a single stored v1 effect onto its catalog entry.
 *
 * Malformed entries (null, missing/non-string id, or an id not present in the
 * catalog) are dropped rather than throwing. When the catalog effect declares
 * default params, the stored user params are merged over them so customized
 * values win and are not silently lost.
 */
function syncV1Effect(raw: unknown): EnhancementEffect | undefined {
    if (!raw || typeof raw !== 'object') return undefined;

    const effect = raw as { id?: unknown; params?: unknown };
    if (typeof effect.id !== 'string') return undefined;

    const catalogEffect = AVAILABLE_EFFECTS.find(ae => ae.id === effect.id);
    if (!catalogEffect) return undefined;

    const merged: EnhancementEffect = { ...catalogEffect };
    const storedParams = effect.params;
    if (storedParams && typeof storedParams === 'object' && !Array.isArray(storedParams)) {
        merged.params = {
            ...(catalogEffect.params ?? {}),
            ...(storedParams as Record<string, number>),
        };
    }
    return merged;
}

// Config version
const CURRENT_CONFIG_VERSION = 4;
const CONFIG_VERSION_3 = 3;
const CONFIG_VERSION_2 = 2;

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

    const oldModes = syncData.enhancementModes as unknown;

    // Extract user custom modes (preserve full effect chains). A corrupt or
    // non-array value is treated as "no legacy modes" instead of throwing.
    const customModes: CustomMode[] = [];
    if (Array.isArray(oldModes)) {
        for (const rawMode of oldModes) {
            if (!rawMode || typeof rawMode !== 'object') continue;

            const mode = rawMode as V1EnhancementMode;
            if (mode.isBuiltIn) continue;

            // Skip malformed modes: a stable string id and an effects array are
            // required to build a valid CustomMode.
            if (typeof mode.id !== 'string' || !Array.isArray(mode.effects)) continue;

            const syncedEffects = mode.effects
                .map(e => syncV1Effect(e))
                .filter((e): e is EnhancementEffect => !!e);

            customModes.push({
                id: mode.id,
                name: typeof mode.name === 'string' ? mode.name : mode.id,
                isBuiltIn: false,
                effects: syncedEffects,
            });
        }
    }

    // Determine the selected mode ID. Legacy built-in ids are already the
    // current ids, so no remapping is required.
    const selectedModeId = syncData.selectedModeId || 'builtin-mode-a';

    // Save migrated data. This step only produces a v2 config; the v2 → v3
    // backfill is applied afterwards by the migration chain.
    await chrome.storage.sync.set({
        customModes,
        selectedModeId,
        targetResolutionSetting: syncData.targetResolutionSetting || 'x2',
        whitelistEnabled: syncData.whitelistEnabled ?? false,
        whitelist: syncData.whitelist || [],
        enableCrossOriginFix: syncData.enableCrossOriginFix ?? false,
        _configVersion: CONFIG_VERSION_2,
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
 * Execute migration from v2 to v3.
 *
 * v3 introduced the synced fields `autoEnableOnWhitelist`, `autoEnableSettleMs`,
 * `enableHotkey` and `colorGrading`, plus the local fields `showDiagnostics`,
 * `diagnosticsDetail` and `preserveDetail`. Only fields that are absent are
 * backfilled with defaults; existing values are never overwritten.
 */
async function migrateV2ToV3(): Promise<void> {
    console.log('[Migration] Starting v2 to v3 migration...');

    const syncData = await chrome.storage.sync.get([
        'autoEnableOnWhitelist',
        'autoEnableSettleMs',
        'enableHotkey',
        'colorGrading',
    ]);

    const syncBackfill: Record<string, unknown> = {
        _configVersion: CONFIG_VERSION_3,
    };
    if (syncData.autoEnableOnWhitelist === undefined) {
        syncBackfill.autoEnableOnWhitelist = false;
    }
    if (syncData.autoEnableSettleMs === undefined) {
        syncBackfill.autoEnableSettleMs = 300;
    }
    if (syncData.enableHotkey === undefined) {
        syncBackfill.enableHotkey = true;
    }
    if (syncData.colorGrading === undefined) {
        syncBackfill.colorGrading = { ...DEFAULT_COLOR_GRADING };
    }

    await chrome.storage.sync.set(syncBackfill);

    const localData = await chrome.storage.local.get([
        'showDiagnostics',
        'diagnosticsDetail',
        'preserveDetail',
    ]);
    const localBackfill: Record<string, unknown> = {};
    if (localData.showDiagnostics === undefined) {
        localBackfill.showDiagnostics = false;
    }
    if (localData.diagnosticsDetail === undefined) {
        localBackfill.diagnosticsDetail = 'auto';
    }
    if (localData.preserveDetail === undefined) {
        localBackfill.preserveDetail = true;
    }
    if (Object.keys(localBackfill).length > 0) {
        await chrome.storage.local.set(localBackfill);
    }

    console.log('[Migration] v2 to v3 migration completed');
}

/**
 * Execute migration from v3 to v4.
 *
 * v4 replaces the local boolean `preserveDetail` with the four-value
 * `restorePolicy` enum. The legacy boolean is mapped so existing behavior is
 * preserved: `true → 'trailing'`, `false → 'off'`, and an absent flag → `'off'`
 * (the conservative opt-out for a pre-v4 config). The old key is removed. An
 * already-present `restorePolicy` is never overwritten. Only the fresh-install
 * default (`initializeDefaultConfig`) uses the new `'gate'` default.
 */
async function migrateV3ToV4(): Promise<void> {
    console.log('[Migration] Starting v3 to v4 migration...');

    await chrome.storage.sync.set({ _configVersion: CURRENT_CONFIG_VERSION });

    const localData = await chrome.storage.local.get(['preserveDetail', 'restorePolicy']);
    if (localData.restorePolicy === undefined) {
        const preserveDetail = localData.preserveDetail;
        const mappedPolicy = preserveDetail === true
            ? 'trailing'
            : preserveDetail === false
                ? 'off'
                : 'off';
        await chrome.storage.local.set({ restorePolicy: mappedPolicy });
    }
    await chrome.storage.local.remove('preserveDetail');

    console.log('[Migration] v3 to v4 migration completed');
}

/**
 * Initialize a fresh install directly on the latest config version.
 */
async function initializeDefaultConfig(): Promise<void> {
    await chrome.storage.sync.set({
        customModes: [],
        selectedModeId: 'builtin-mode-a',
        targetResolutionSetting: 'x2',
        whitelistEnabled: false,
        whitelist: [],
        enableCrossOriginFix: false,
        autoEnableOnWhitelist: false,
        autoEnableSettleMs: 300,
        enableHotkey: true,
        colorGrading: { ...DEFAULT_COLOR_GRADING },
        _configVersion: CURRENT_CONFIG_VERSION,
    });

    await chrome.storage.local.set({
        performanceTier: 'balanced' as PerformanceTier,
        gpuBenchmarkResult: null,
        gpuAdapterInfo: null,
        hasCompletedOnboarding: false,
        showDiagnostics: false,
        diagnosticsDetail: 'auto',
        restorePolicy: 'gate',
    });

    console.log('[Migration] Initialized new config with defaults');
}

/**
 * Ensure the config is on the latest version by running the ordered migration
 * chain. Safe to call repeatedly: once the config is current this is a no-op.
 */
export async function ensureLatestConfig(): Promise<void> {
    const syncData = await chrome.storage.sync.get(['_configVersion', 'enhancementModes']);
    const storedVersion = typeof syncData._configVersion === 'number'
        ? syncData._configVersion
        : 0;

    // Fresh install: no version marker and no legacy data to migrate.
    if (storedVersion === 0 && !syncData.enhancementModes) {
        await initializeDefaultConfig();
        return;
    }

    let version = storedVersion;

    // v1 → v2. Legacy v1 data without enhancementModes is simply bumped to v2
    // and then handled by the v2 → v3 backfill below.
    if (version < 2) {
        if (syncData.enhancementModes) {
            await migrateV1ToV2();
        }
        version = 2;
    }

    // v2 → v3
    if (version < 3) {
        await migrateV2ToV3();
        version = 3;
    }

    // v3 → v4
    if (version < 4) {
        await migrateV3ToV4();
    }
}
