/**
 * General Settings panel for the options page.
 *
 * Handles cross-origin fix toggle, theme selection, tier select value sync,
 * color grading toggle + slider delegation, and the About section version number.
 */
import { saveSettings, getLocalSettings, saveLocalSettings } from '@utils/settings';
import { themeManager } from '../theme-manager';
import { renderColorGradingSliders, setColorGradingSlidersEnabled } from './color-grading-panel';

import type { AppContext } from './modes-panel';

export function initGeneralPanel(
  ctx: AppContext,
  crossOriginFixToggle: HTMLInputElement,
  themeSelect: HTMLSelectElement,
  tierSelect: HTMLSelectElement,
  colorGradingToggle: HTMLInputElement,
  colorGradingSliders: HTMLElement,
  versionNumberSpan: HTMLSpanElement,
  enableHotkeyToggle: HTMLInputElement,
  diagnosticsToggle: HTMLInputElement,
  restorePolicySelect: HTMLSelectElement,
  diagnosticsDetailSelect: HTMLSelectElement | null,
): { render(): Promise<void>; renderGeneralSettings(): Promise<void> } {

  async function render() {
    const state = ctx.getState();
    crossOriginFixToggle.checked = state.enableCrossOriginFix;
    themeSelect.value = themeManager.getTheme();
    tierSelect.value = ctx.getTier();

    // Diagnostics + restore-policy controls read from local settings
    const localSettings = await getLocalSettings();
    diagnosticsToggle.checked = localSettings.showDiagnostics ?? false;
    restorePolicySelect.value = localSettings.restorePolicy ?? 'gate';
    if (diagnosticsDetailSelect) {
      diagnosticsDetailSelect.value = localSettings.diagnosticsDetail ?? 'auto';
    }

    // Hotkey toggle reads from synced settings
    enableHotkeyToggle.checked = state.enableHotkey ?? true;

    if (versionNumberSpan) {
      const manifest = chrome.runtime.getManifest();
      versionNumberSpan.textContent = manifest.version;
    }

    renderColorGradingUI();
  }

  async function renderGeneralSettings() {
    // Minimal update for tier/benchmark changes — syncs tierSelect value only.
    // The full render (crossOriginFix, theme, about, colorGrading) is handled
    // by the initial render() call in DOMContentLoaded.
    const localSettings = await getLocalSettings();
    if (tierSelect) {
      tierSelect.value = localSettings.performanceTier;
    }
  }

  function renderColorGradingUI() {
    const state = ctx.getState();
    colorGradingToggle.checked = state.colorGrading.enabled;
    renderColorGradingSliders(
      state.colorGrading,
      colorGradingSliders,
      state.colorGrading.enabled,
      async (updated) => {
        state.colorGrading = updated;
        await saveSettings({ colorGrading: updated });
        ctx.notifyUpdate();
      },
    );
  }

  // --- Cross-Origin Fix Toggle ---
  crossOriginFixToggle.addEventListener('change', async (e) => {
    const enabled = (e.target as HTMLInputElement).checked;
    ctx.getState().enableCrossOriginFix = enabled;
    await saveSettings({ enableCrossOriginFix: enabled });
    ctx.notifyUpdate();
  });

  // --- Theme Select ---
  themeSelect.addEventListener('change', (e) => {
    const selectedTheme = (e.target as HTMLSelectElement).value as 'light' | 'dark' | 'auto';
    themeManager.setTheme(selectedTheme);
  });

  // --- Hotkey Toggle ---
  enableHotkeyToggle.addEventListener('change', async (e) => {
    const enabled = (e.target as HTMLInputElement).checked;
    ctx.getState().enableHotkey = enabled;
    await saveSettings({ enableHotkey: enabled });
    ctx.notifyUpdate();
  });

  // --- Hotkey Settings Links ---
  const openChromeShortcuts = document.getElementById('open-chrome-shortcuts');
  const openFirefoxAddons = document.getElementById('open-firefox-addons');

  if (openChromeShortcuts) {
    openChromeShortcuts.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    });
  }
  if (openFirefoxAddons) {
    openFirefoxAddons.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: 'about:addons' });
    });
  }

  // --- Color Grading Toggle ---
  colorGradingToggle.addEventListener('change', async (e) => {
    const enabled = (e.target as HTMLInputElement).checked;
    ctx.getState().colorGrading.enabled = enabled;
    setColorGradingSlidersEnabled(colorGradingSliders, enabled);
    await saveSettings({ colorGrading: ctx.getState().colorGrading });
    ctx.notifyUpdate();
  });

  // --- Diagnostics Toggle ---
  diagnosticsToggle.addEventListener('change', async (e) => {
    const enabled = (e.target as HTMLInputElement).checked;
    await saveLocalSettings({ showDiagnostics: enabled });
    ctx.notifyUpdate();
  });

  // --- Diagnostics Detail Level (local) ---
  diagnosticsDetailSelect?.addEventListener('change', async (e) => {
    const value = (e.target as HTMLSelectElement).value;
    if (value !== 'auto' && value !== 'compact' && value !== 'expanded') return;
    await saveLocalSettings({ diagnosticsDetail: value });
    ctx.notifyUpdate();
  });

  // --- Restore policy (local) ---
  restorePolicySelect.addEventListener('change', async (e) => {
    const value = (e.target as HTMLSelectElement).value;
    if (value !== 'off' && value !== 'gate' && value !== 'trailing' && value !== 'leading') return;
    await saveLocalSettings({ restorePolicy: value });
    // The options page never receives its own cross-context update, so refresh
    // the modes panel here to update the restore-policy note immediately.
    ctx.refreshModesPanel?.();
    ctx.notifyUpdate();
  });

  return { render, renderGeneralSettings };
}
