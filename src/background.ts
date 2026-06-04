import { getSettings, getLocalSettings } from './utils/settings';
import { ensureLatestConfig } from './utils/migration';

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

  await checkBenchmarkCrash();
  await updateDNRuleset();
});

// Initialize on install or update
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[Background] Extension installed/updated:', details.reason);

  // Ensure config is on the latest version (handle migration)
  await ensureLatestConfig();

  await checkBenchmarkCrash();
  await updateDNRuleset();

  // Open onboarding page on fresh install or update if not completed
  if (details.reason === 'install' || details.reason === 'update') {
    await checkOnboarding();
  }
});

// Listen for tab updates
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    chrome.tabs.sendMessage(tabId, {
      type: 'URL_UPDATED',
      url: tab.url
    }).catch(error => {
      if (!error.message.includes('Receiving end does not exist')) {
        console.error(`[Background] Error sending URL_UPDATED message: ${error.message}`);
      }
    });
  }
});

// Listen for requests from content scripts/popup/options
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'SETTINGS_UPDATED') {
    console.log('[Background] Settings updated, checking DNR rules...');
    updateDNRuleset();
  } else if (request.type === 'OPEN_OPTIONS_PAGE') {
    chrome.runtime.openOptionsPage();
  } else if (request.type === 'OPEN_ONBOARDING') {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
  }
});