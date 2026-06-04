// popup.ts
import './popup.css';
import '../common-vars.css';
import { getSettings, saveSettings, getLocalSettings, saveLocalSettings, BUILTIN_MODES } from '../../utils/settings';
import { addWhitelistRule, setDefaultWhitelist } from '../../utils/whitelist';
import { themeManager } from '../theme-manager';
import type { PerformanceTier, EnhancementMode, CustomMode } from '../../types';

// Current tier state
let currentTier: PerformanceTier = 'balanced';

document.addEventListener('DOMContentLoaded', async () => {
  // Initialize theme
  themeManager.getTheme(); // This will automatically apply the saved theme

  // Set document language
  document.documentElement.setAttribute('lang', chrome.i18n.getMessage('@@ui_locale') || 'en');

  // Set version info
  const versionInfo = document.getElementById('version-info');
  if (versionInfo) {
    const manifest = chrome.runtime.getManifest();
    versionInfo.textContent = manifest.version;
  }

  // Apply internationalization
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach(element => {
    const key = element.getAttribute('data-i18n');
    if (key) {
      const message = chrome.i18n.getMessage(key);
      if (message) {
        element.textContent = message;
      }
    }
  });

  // Apply title internationalization
  document.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach(element => {
    const key = element.getAttribute('data-i18n-title');
    if (key) {
      const message = chrome.i18n.getMessage(key);
      if (message) {
        element.setAttribute('title', message);
      }
    }
  });

  // Get DOM elements
  const tierButtons = document.querySelectorAll<HTMLButtonElement>('.tier-btn');
  const modeSelect = document.getElementById('mode-select') as HTMLSelectElement;
  const resolutionSelect = document.getElementById('resolution-select') as HTMLSelectElement;
  const saveButton = document.getElementById('save-settings') as HTMLButtonElement;
  const whitelistToggle = document.getElementById('whitelist-toggle') as HTMLInputElement;
  const addCurrentPageBtn = document.getElementById('add-current-page') as HTMLButtonElement;
  const addCurrentDomainBtn = document.getElementById('add-current-domain') as HTMLButtonElement;
  const addParentPathBtn = document.getElementById('add-parent-path') as HTMLButtonElement;
  const openSettingsBtn = document.getElementById('open-settings') as HTMLButtonElement;
  const statusBadge = document.getElementById('status-badge') as HTMLSpanElement;

  if (!modeSelect || !resolutionSelect || !saveButton || !whitelistToggle ||
    !addCurrentPageBtn || !addCurrentDomainBtn || !addParentPathBtn || !openSettingsBtn) {
    console.error('Required elements not found');
    return;
  }

  // Render mode dropdown
  const renderModeSelect = (settings: { enhancementModes: EnhancementMode[], customModes: CustomMode[], selectedModeId: string }) => {
    modeSelect.innerHTML = '';

    // Built-in modes group
    const builtInGroup = document.createElement('optgroup');
    builtInGroup.label = chrome.i18n.getMessage('builtInModes') || 'Built-in Modes';
    BUILTIN_MODES.forEach(mode => {
      const option = document.createElement('option');
      option.value = mode.id;
      option.textContent = mode.name;
      builtInGroup.appendChild(option);
    });
    modeSelect.appendChild(builtInGroup);

    // Custom modes group (if any)
    if (settings.customModes && settings.customModes.length > 0) {
      const customGroup = document.createElement('optgroup');
      customGroup.label = chrome.i18n.getMessage('customModes') || 'Custom Modes';
      settings.customModes.forEach(mode => {
        const option = document.createElement('option');
        option.value = mode.id;
        option.textContent = mode.name;
        customGroup.appendChild(option);
      });
      modeSelect.appendChild(customGroup);
    }

    modeSelect.value = settings.selectedModeId;
  };

  // Update status badge
  const updateStatusBadge = (text: string, active = false) => {
    if (statusBadge) {
      statusBadge.textContent = text;
      statusBadge.classList.toggle('active', active);
    }
  };

  // Update tier button states
  const updateTierButtons = (tier: PerformanceTier) => {
    tierButtons.forEach(btn => {
      const btnTier = btn.getAttribute('data-tier') as PerformanceTier;
      btn.classList.toggle('active', btnTier === tier);
    });
  };

  // Update tier button disabled state (disabled for custom modes)
  const updateTierButtonsDisabled = (isCustomMode: boolean) => {
    tierButtons.forEach(btn => {
      btn.disabled = isCustomMode;
      btn.classList.toggle('disabled', isCustomMode);
    });
  };

  // Load settings
  let currentSettings;
  let localSettings;
  try {
    [currentSettings, localSettings] = await Promise.all([
      getSettings(),
      getLocalSettings(),
    ]);

    currentTier = localSettings.performanceTier;
    updateTierButtons(currentTier);
    renderModeSelect(currentSettings);
    resolutionSelect.value = currentSettings.targetResolutionSetting;
    whitelistToggle.checked = currentSettings.whitelistEnabled;
    updateStatusBadge('Ready');

    // Check if a custom mode is selected
    const isCustomMode = currentSettings.selectedModeId.startsWith('custom-');
    updateTierButtonsDisabled(isCustomMode);

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

  // Tier button click handler (only updates UI state, saving happens on save button click)
  tierButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const tier = btn.getAttribute('data-tier') as PerformanceTier;
      if (tier && tier !== currentTier) {
        currentTier = tier;
        updateTierButtons(tier);
        console.log('Performance tier selected:', tier);
      }
    });
  });

  // Update tier button state when mode selection changes
  modeSelect.addEventListener('change', () => {
    const isCustomMode = modeSelect.value.startsWith('custom-');
    updateTierButtonsDisabled(isCustomMode);
  });

  // "Save" button click handler
  saveButton.addEventListener('click', async () => {
    const selectedModeId = modeSelect.value;
    const selectedResolution = resolutionSelect.value;

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

      // Show save success status message
      const status = document.createElement('div');
      status.className = 'save-status';
      status.textContent = chrome.i18n.getMessage('settingsSaved') || 'Settings saved!';
      saveButton.parentElement?.appendChild(status);

      // Notify content script in the active tab that settings have been updated
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          chrome.tabs.sendMessage(tabs[0].id, {
            type: 'SETTINGS_UPDATED',
            settings: {
              selectedModeId,
              targetResolution: selectedResolution,
              performanceTier: currentTier,
            }
          }, (response) => {
            if (chrome.runtime.lastError) {
              console.warn('Message send error:', chrome.runtime.lastError.message);
            } else {
              console.log('Content script response:', response);
            }
          });
        }
      });

      // Close popup after status message is shown
      setTimeout(() => {
        status.remove();
        window.close();
      }, 1500);

    } catch (error) {
      console.error('Error saving settings:', error);
      alert('Failed to save settings');
    }
  });

  // Whitelist enable/disable toggle change handler
  whitelistToggle.addEventListener('change', async () => {
    try {
      await saveSettings({ whitelistEnabled: whitelistToggle.checked });
      console.log('Whitelist enabled:', whitelistToggle.checked);
    } catch (error) {
      console.error('Error saving whitelist toggle:', error);
    }
  });

  // "Add to whitelist" button event handlers
  addCurrentPageBtn.addEventListener('click', async () => {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs.length > 0 && tabs[0].url) {
        const url = new URL(tabs[0].url);
        const cleanUrl = url.hostname + url.pathname;
        await addWhitelistRule(cleanUrl);
        alert(chrome.i18n.getMessage('pageAdded') || 'URL added to whitelist');
      }
    } catch (error) {
      console.error('Error adding current URL:', error);
      alert('Failed to add URL to whitelist');
    }
  });

  addCurrentDomainBtn.addEventListener('click', async () => {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs.length > 0 && tabs[0].url) {
        const url = new URL(tabs[0].url);
        await addWhitelistRule(`${url.hostname}/*`);
        alert(chrome.i18n.getMessage('domainAdded') || 'Domain added to whitelist');
      }
    } catch (error) {
      console.error('Error adding current domain:', error);
      alert('Failed to add domain to whitelist');
    }
  });

  addParentPathBtn.addEventListener('click', async () => {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs.length > 0 && tabs[0].url) {
        const url = new URL(tabs[0].url);
        const pathParts = url.pathname.split('/').filter(p => p);
        const parentPath = pathParts.length > 1 ? pathParts.slice(0, -1).join('/') : '';
        await addWhitelistRule(`${url.hostname}/${parentPath}/*`);
        alert(chrome.i18n.getMessage('parentPathAdded') || 'Parent path added to whitelist');
      }
    } catch (error) {
      console.error('Error adding parent path:', error);
      alert('Failed to add parent path to whitelist');
    }
  });

  openSettingsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
});