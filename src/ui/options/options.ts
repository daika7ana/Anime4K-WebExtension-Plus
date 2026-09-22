import './options.css';
import '../common-vars.css';
import '../common/toast.css';
import { getSettings, getLocalSettings } from '@utils/settings';
import type { Anime4KWebExtSettings, PerformanceTier } from '@/types';
import { themeManager } from '../theme-manager';
import { Sidebar } from './Sidebar';
import { sendMessage, onMessage } from '@utils/messaging';
import { applyI18n, TIER_DISPLAY } from '@utils/i18n';
import { initModesPanel } from './modes-panel';
import { initWhitelistPanel } from './whitelist-panel';
import { initBenchmarkPanel } from './benchmark-panel';
import { initGeneralPanel } from './general-panel';
import type { AppContext } from './modes-panel';

// --- Global State ---
let settingsState: Anime4KWebExtSettings;
let currentTier: PerformanceTier = 'balanced';

// --- UI Elements ---
const modesContainer = document.getElementById('modes-container') as HTMLElement;
const addModeBtn = document.getElementById('add-mode-btn') as HTMLButtonElement;
const importModesBtn = document.getElementById('import-modes-btn') as HTMLButtonElement;
const exportModesBtn = document.getElementById('export-modes-btn') as HTMLButtonElement;
const rulesContainer = document.getElementById('rules-container') as HTMLElement;
const addRuleBtn = document.getElementById('add-rule') as HTMLButtonElement;
const importBtn = document.getElementById('import-btn') as HTMLButtonElement;
const exportBtn = document.getElementById('export-btn') as HTMLButtonElement;
const crossOriginFixToggle = document.getElementById('cross-origin-fix-toggle') as HTMLInputElement;
const autoEnableToggle = document.getElementById('auto-enable-toggle') as HTMLInputElement;
const autoEnableSettleInput = document.getElementById('auto-enable-settle-ms') as HTMLInputElement;
const whitelistEnabledToggle = document.getElementById('whitelist-enabled-toggle') as HTMLInputElement;
const colorGradingToggle = document.getElementById('color-grading-toggle') as HTMLInputElement;
const colorGradingSliders = document.getElementById('color-grading-sliders') as HTMLElement;
const themeSelect = document.getElementById('theme-select') as HTMLSelectElement;
const versionNumberSpan = document.getElementById('version-number') as HTMLSpanElement;

// --- Smart Features UI Elements ---
const runBenchmarkBtn = document.getElementById('run-benchmark-btn') as HTMLButtonElement;
const tierSelect = document.getElementById('tier-select') as HTMLSelectElement;
const enableHotkeyToggle = document.getElementById('enable-hotkey-toggle') as HTMLInputElement;
const diagnosticsToggle = document.getElementById('diagnostics-toggle') as HTMLInputElement;
const diagnosticsDetailSelect = document.getElementById('diagnostics-detail-select') as HTMLSelectElement | null;
const restorePolicySelect = document.getElementById('restore-policy-select') as HTMLSelectElement;

// --- AppContext: shared state + callbacks for all panels ---
const ctx: AppContext = {
  getState: () => settingsState,
  getTier: () => currentTier,
  setTier: (tier: PerformanceTier) => { currentTier = tier; },
  notifyUpdate: (modifiedModeId?: string) => {
    sendMessage({ type: 'SETTINGS_UPDATED', modifiedModeId });
  },
};

// --- I18n Setup ---
const setupInternationalization = () => {
  applyI18n();

  // Add icons to tier select options
  document.querySelectorAll<HTMLOptionElement>('#tier-select option').forEach(option => {
    const display = TIER_DISPLAY[option.value as PerformanceTier];
    if (display && option.textContent && !option.textContent.startsWith(display.icon)) {
      option.textContent = `${display.icon} ${option.textContent}`;
    }
  });
};

// --- Initialize panels (bind DOM + events; returns render handles) ---
const modesPanel = initModesPanel(ctx, modesContainer, addModeBtn, exportModesBtn, importModesBtn);
const whitelistPanel = initWhitelistPanel(ctx, rulesContainer, addRuleBtn, exportBtn, importBtn, autoEnableToggle, autoEnableSettleInput, whitelistEnabledToggle);

// onTierChanged is called when the tier changes (manual select or benchmark apply).
// It syncs the tier-select display AND re-renders mode chains (which depend on tier).
const onTierChanged = () => {
  // Sync the tier-select display. Fire-and-forget to match the previous
  // unawaited renderGeneralSettings() ordering (modes re-render runs first).
  void getLocalSettings().then((localSettings) => {
    if (tierSelect) tierSelect.value = localSettings.performanceTier;
  });
  modesPanel.render();
};
initBenchmarkPanel(ctx, runBenchmarkBtn, tierSelect, onTierChanged);

const generalPanel = initGeneralPanel(
  ctx,
  crossOriginFixToggle,
  themeSelect,
  tierSelect,
  colorGradingToggle,
  colorGradingSliders,
  versionNumberSpan,
  enableHotkeyToggle,
  diagnosticsToggle,
  restorePolicySelect,
  diagnosticsDetailSelect,
);

// --- Cross-context message listener ---
onMessage(async (message) => {
  switch (message.type) {
    case 'WHITELIST_UPDATED':
      // Re-fetch settings to get the latest whitelist from other parts of the extension
      settingsState = await getSettings();
      whitelistPanel.render();
      return;
    case 'SETTINGS_UPDATED': {
      // Re-fetch settings and local settings to update tier and effect chain display
      settingsState = await getSettings();
      const localSettings = await getLocalSettings();
      currentTier = localSettings.performanceTier;
      modesPanel.render();
      console.log('[Options] Settings updated, tier:', currentTier);
      return;
    }
  }
});

// --- Main Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
  themeManager.initTheme();
  setupInternationalization();

  // Initialize sidebar
  try {
    const sidebar = new Sidebar();
    sidebar.initialize();
  } catch (error) {
    console.error('Failed to initialize sidebar:', error);
  }

  if (!modesContainer || !addModeBtn || !importModesBtn || !exportModesBtn || !rulesContainer || !addRuleBtn || !importBtn || !exportBtn) {
    console.error('Required UI elements not found. Aborting initialization.');
    return;
  }

  // Load initial state from storage
  settingsState = await getSettings();

  // Read local settings to get current tier
  const localSettings = await getLocalSettings();
  currentTier = localSettings.performanceTier;

  // Initial UI rendering from state
  modesPanel.render();
  whitelistPanel.render();
  await generalPanel.render();
});
