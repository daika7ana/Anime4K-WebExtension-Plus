// popup.ts — Thin orchestrator: wires up control modules and coordinates save
import './popup.css';
import '../common-vars.css';
import '../common/toast.css';
import { showToast } from '../common/toast';
import { getSettings, saveSettings, getLocalSettings, saveLocalSettings } from '../../utils/settings';
import { setDefaultWhitelist } from '../../utils/whitelist';
import { themeManager } from '../theme-manager';
import { sendTabMessage } from '@utils/messaging';
import { t, applyI18n } from '@utils/i18n';
import type { PerformanceTier } from '../../types';
import { initTierControls } from './tier-controls';
import { initModeControls } from './mode-controls';
import { initModeGuidance } from './mode-guidance';
import { initWhitelistActions } from './whitelist-actions';

// Current tier state
let currentTier: PerformanceTier = 'balanced';

document.addEventListener('DOMContentLoaded', async () => {
  // Initialize theme
  themeManager.getTheme(); // This will automatically apply the saved theme

  // Set document language
  document.documentElement.setAttribute('lang', t('@@ui_locale', 'en'));

  // Set version info
  const versionInfo = document.getElementById('version-info');
  if (versionInfo) {
    const manifest = chrome.runtime.getManifest();
    versionInfo.textContent = manifest.version;
  }

  // Apply internationalization
  applyI18n();

  // Get DOM elements
  const tierButtons = document.querySelectorAll<HTMLButtonElement>('.tier-btn');
  const modeSelect = document.getElementById('mode-select') as HTMLSelectElement;
  const resolutionSelect = document.getElementById('resolution-select') as HTMLSelectElement;
  const modeDescription = document.getElementById('mode-description');
  const saveButton = document.getElementById('save-settings') as HTMLButtonElement;
  const whitelistToggle = document.getElementById('whitelist-toggle') as HTMLInputElement;
  const addCurrentPageBtn = document.getElementById('add-current-page') as HTMLButtonElement;
  const addCurrentDomainBtn = document.getElementById('add-current-domain') as HTMLButtonElement;
  const addParentPathBtn = document.getElementById('add-parent-path') as HTMLButtonElement;
  const removeFromWhitelistBtn = document.getElementById('remove-from-whitelist') as HTMLButtonElement;
  const whitelistButtons = document.querySelector<HTMLElement>('.whitelist-buttons');
  const openSettingsBtn = document.getElementById('open-settings') as HTMLButtonElement;
  const statusBadge = document.getElementById('status-badge') as HTMLSpanElement;
  const colorGradingToggle = document.getElementById('color-grading-toggle') as HTMLInputElement;

  if (!modeSelect || !resolutionSelect || !saveButton || !whitelistToggle ||
    !addCurrentPageBtn || !addCurrentDomainBtn || !addParentPathBtn ||
    !removeFromWhitelistBtn || !whitelistButtons || !openSettingsBtn) {
    console.error('Required elements not found');
    return;
  }

  // Update status badge
  const updateStatusBadge = (text: string, active = false) => {
    if (statusBadge) {
      statusBadge.textContent = text;
      statusBadge.classList.toggle('active', active);
    }
  };

  // Dirty state tracking
  let initialModeId: string;
  let initialResolution: string;
  let initialTier: PerformanceTier;

  const updateSaveButtonState = () => {
    const isDirty = modeSelect.value !== initialModeId ||
                    resolutionSelect.value !== initialResolution ||
                    currentTier !== initialTier;
    saveButton.disabled = !isDirty;
  };

  // Initialize tier controls
  const tierControls = initTierControls({
    tierButtons,
    getTier: () => currentTier,
    setTier: (tier) => { currentTier = tier; },
    onTierChanged: () => updateSaveButtonState(),
  });

  // Initialize mode controls
  const modeControls = initModeControls({
    modeSelect,
    onModeChanged: () => {
      const isCustomMode = modeSelect.value.startsWith('custom-');
      tierControls.setDisabled(isCustomMode);
      updateSaveButtonState();
    },
  });

  // Source-type description for the selected mode (hidden for custom modes).
  const modeGuidance = initModeGuidance({
    modeSelect,
    descriptionEl: modeDescription,
  });

  // Initialize whitelist actions
  const whitelistActions = initWhitelistActions({
    whitelistToggle,
    addCurrentPageBtn,
    addCurrentDomainBtn,
    addParentPathBtn,
    removeFromWhitelistBtn,
    whitelistButtons,
  });

  // Load settings
  let currentSettings;
  let localSettings;
  try {
    [currentSettings, localSettings] = await Promise.all([
      getSettings(),
      getLocalSettings(),
    ]);

    currentTier = localSettings.performanceTier;
    initialModeId = currentSettings.selectedModeId;
    initialResolution = currentSettings.targetResolutionSetting;
    initialTier = localSettings.performanceTier;

    tierControls.updateActiveTier(currentTier);
    modeControls.render(currentSettings);
    resolutionSelect.value = currentSettings.targetResolutionSetting;
    modeGuidance.update();
    whitelistToggle.checked = currentSettings.whitelistEnabled;
    colorGradingToggle.checked = currentSettings.colorGrading?.enabled ?? false;
    updateStatusBadge('Ready');
    updateSaveButtonState();

    // Check if a custom mode is selected
    const isCustomMode = currentSettings.selectedModeId.startsWith('custom-');
    tierControls.setDisabled(isCustomMode);

    // If whitelist is empty, set default rules
    if (currentSettings.whitelist.length === 0) {
      await setDefaultWhitelist();
      currentSettings = await getSettings();
    }
  } catch (error) {
    console.error('Error loading settings:', error);
    modeSelect.value = 'builtin-mode-a';
    resolutionSelect.value = 'x2';
    whitelistToggle.checked = false;
  }

  // If the active page is already whitelisted, replace the three add buttons
  // with the single remove button. Restricted/invalid tab URLs simply leave the
  // add buttons in place.
  if (currentSettings) {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabUrl = tabs[0]?.url;
      if (tabUrl) {
        whitelistActions.renderWhitelistControls(tabUrl, currentSettings.whitelist);
      }
    } catch (error) {
      console.error('Error checking whitelist state for active tab:', error);
    }
  }

  // Update save button when resolution changes
  resolutionSelect.addEventListener('change', () => {
    updateSaveButtonState();
  });

  // "Save" button click handler
  saveButton.addEventListener('click', async () => {
    const selectedModeId = modeSelect.value;
    const selectedResolution = resolutionSelect.value;

    // Disable button during save to prevent spamming
    saveButton.disabled = true;

    try {
      const updatedSettings = {
        selectedModeId,
        targetResolutionSetting: selectedResolution,
      };
      await saveSettings(updatedSettings);

      // Save tier
      await saveLocalSettings({ performanceTier: currentTier });

      console.log('Settings saved:', { ...updatedSettings, performanceTier: currentTier });

      // Remove existing status message (to avoid stacking)
      const existingStatus = document.querySelector('.save-status');
      if (existingStatus) {
        existingStatus.remove();
      }

      // Update status badge
      updateStatusBadge('Applied', true);

      // Update initial values so dirty tracking reflects the new baseline
      initialModeId = selectedModeId;
      initialResolution = selectedResolution;
      initialTier = currentTier;

      // Show save success status message
      const status = document.createElement('div');
      status.className = 'save-status';
      status.textContent = t('settingsSaved', 'Settings saved!');
      saveButton.parentElement?.appendChild(status);

      // Notify content script in the active tab that settings have been updated
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          sendTabMessage(tabs[0].id, {
            type: 'SETTINGS_UPDATED',
            settings: {
              selectedModeId,
              targetResolutionSetting: selectedResolution,
              performanceTier: currentTier,
            }
          }).then((response) => {
            console.log('Content script response:', response);
          }).catch((error: Error) => {
            if (!error.message.includes('Receiving end does not exist')) {
              console.warn('Message send error:', error.message);
            }
          });
        }
      });

      // Re-enable button after save completes (disabled state tracks dirty state)
      updateSaveButtonState();

    } catch (error) {
      console.error('Error saving settings:', error);
      showToast('Failed to save settings', 'error');
      // Re-enable button on error so user can retry
      updateSaveButtonState();
    }
  });

  // Color Grading toggle change handler
  colorGradingToggle.addEventListener('change', async () => {
    try {
      const settings = await getSettings();
      const colorGrading = { ...settings.colorGrading, enabled: colorGradingToggle.checked };
      await saveSettings({ colorGrading });
      console.log('Color grading enabled:', colorGradingToggle.checked);

      // Notify content script
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          sendTabMessage(tabs[0].id, { type: 'SETTINGS_UPDATED' })
            .catch((error: Error) => {
              if (!error.message.includes('Receiving end does not exist')) {
    console.warn('Message send error:', error.message);
            }
          });
        }
      });
    } catch (error) {
      console.error('Error saving color grading toggle:', error);
    }
  });

  openSettingsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
});
