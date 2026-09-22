import { getSettings, getLocalSettings } from '@utils/settings';
import { ensureLatestConfig } from '@utils/migration';
import { onMessage, sendTabMessage } from '@utils/messaging';

const RULESET_ID = 'ruleset_1';

/**
 * Update declarativeNetRequest ruleset based on current settings.
 */
async function updateDNRuleset() {
  const { enableCrossOriginFix } = await getSettings();
  if (enableCrossOriginFix) {
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds: [RULESET_ID]
    });
    console.log('[Background] Cross-origin DNR ruleset enabled.');
  } else {
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      disableRulesetIds: [RULESET_ID]
    });
    console.log('[Background] Cross-origin DNR ruleset disabled.');
  }
}

/**
 * Check if the onboarding page should be opened
 */
async function checkOnboarding(): Promise<boolean> {
  const local = await getLocalSettings();

  // If onboarding not completed, open onboarding page
  if (!local.hasCompletedOnboarding) {
    console.log('[Background] Opening onboarding page...');
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
    return true;
  }

  return false;
}

/**
 * Check if the previous benchmark crashed
 */
async function checkBenchmarkCrash(): Promise<void> {
  const local = await chrome.storage.local.get(['_benchmarkInProgress']);

  if (local._benchmarkInProgress) {
    console.warn('[Background] Previous benchmark may have crashed, using safe defaults');

    await chrome.storage.local.set({
      performanceTier: 'performance',
      hasCompletedOnboarding: true,
    });
    await chrome.storage.local.remove('_benchmarkInProgress');
  }
}

// Background service worker

// Check DNR rules on startup
chrome.runtime.onStartup.addListener(async () => {
  console.log('[Background] Browser startup');

  try {
    await checkBenchmarkCrash();
  } catch (error) {
    console.error('[Background] Benchmark crash check failed:', error);
  }

  try {
    await updateDNRuleset();
  } catch (error) {
    console.error('[Background] Failed to update DNR ruleset:', error);
  }
});

// Initialize on install or update
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[Background] Extension installed/updated:', details.reason);

  // Each startup step is failure-isolated so one failure cannot abort the rest.
  try {
    // Ensure config is on the latest version (handle migration)
    await ensureLatestConfig();
  } catch (error) {
    console.error('[Background] Config migration failed:', error);
  }

  try {
    await checkBenchmarkCrash();
  } catch (error) {
    console.error('[Background] Benchmark crash check failed:', error);
  }

  try {
    await updateDNRuleset();
  } catch (error) {
    console.error('[Background] Failed to update DNR ruleset:', error);
  }

  // Open onboarding page on fresh install or update if not completed
  if (details.reason === 'install' || details.reason === 'update') {
    try {
      await checkOnboarding();
    } catch (error) {
      console.error('[Background] Onboarding check failed:', error);
    }
  }
});

// Listen for tab updates
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    sendTabMessage(tabId, {
      type: 'URL_UPDATED',
      url: tab.url
    }).catch(error => {
      if (!error.message.includes('Receiving end does not exist')) {
        console.error(`[Background] Error sending URL_UPDATED message: ${error.message}`);
      }
    });
  }
});

// Listen for keyboard shortcut commands
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-enhancement') {
    // Check if hotkey is enabled in settings
    const settings = await getSettings();
    if (!settings.enableHotkey) return;

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs[0];
      if (activeTab?.id) {
        sendTabMessage(activeTab.id, { type: 'TOGGLE_ENHANCEMENT' }).catch(() => {
          // Tab may not have a content script — ignore silently
        });
      }
    });
  }
});

// Listen for requests from content scripts/popup/options
onMessage((message, _sender, _sendResponse) => {
  switch (message.type) {
    case 'SETTINGS_UPDATED':
      console.log('[Background] Settings updated, checking DNR rules...');
      updateDNRuleset();

      // Forward to all content scripts so active enhancers pick up the change.
      // The options page sends via chrome.runtime.sendMessage (reaches background),
      // but content scripts only listen on chrome.runtime.onMessage in their own context,
      // so we must relay via chrome.tabs.sendMessage to each tab.
      chrome.tabs.query({}, (tabs) => {
        for (const tab of tabs) {
          if (tab.id) {
            sendTabMessage(tab.id, message).catch(() => {
              // Tab may not have a content script — ignore silently
            });
          }
        }
      });
      break;
    case 'OPEN_OPTIONS_PAGE':
      chrome.runtime.openOptionsPage();
      break;
    case 'OPEN_ONBOARDING':
      chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
      break;
  }
});