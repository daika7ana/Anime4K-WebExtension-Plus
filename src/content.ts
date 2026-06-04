/**
 * Content script main entry point
 * Responsible for adding enhancement buttons to page video elements and managing enhancer instances
 */
import { initializeOnPage, deinitializeOnPage, handleSettingsUpdate } from './core/video-manager';
import { isUrlWhitelisted, getWhitelistRules } from './utils/whitelist';

// Exit early in sub-frames without video to avoid unnecessary storage reads and initialization
if (window !== window.top && !document.querySelector('video')) {
  // Silent exit — no cleanup needed
} else {

let isCurrentlyActive = false; // Track enhancement state for the current page

// Check if the current page is on the whitelist
async function shouldInitialize(): Promise<boolean> {
  const settings = await chrome.storage.sync.get(['whitelistEnabled']);
  if (!settings.whitelistEnabled) return true; // Always initialize when whitelist is disabled
  
  const rules = await getWhitelistRules();
  return isUrlWhitelisted(window.location.href, rules);
}

// Evaluate and apply changes based on whitelist state
async function evaluateAndApplyWhitelistState() {
  const shouldBeActive = await shouldInitialize();

  if (shouldBeActive && !isCurrentlyActive) {
    // Case: needs activation (e.g. navigated from non-whitelisted to whitelisted page)
    console.log('[Anime4KWebExt] Whitelist match found. Initializing features...');
    initializeOnPage();
    isCurrentlyActive = true;
  } else if (!shouldBeActive && isCurrentlyActive) {
    // Case: needs deactivation (e.g. navigated from whitelisted to non-whitelisted page)
    console.log('[Anime4KWebExt] No longer on a whitelisted page. De-initializing features...');
    deinitializeOnPage();
    isCurrentlyActive = false;
  } else {
    // Case: state unchanged
    console.log(`[Anime4KWebExt] Whitelist state unchanged (shouldBeActive: ${shouldBeActive}, isCurrentlyActive: ${isCurrentlyActive}). No action needed.`);
  }
}

// Initialize the page
evaluateAndApplyWhitelistState();

// Listen for settings update messages from the background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'SETTINGS_UPDATED') {
    handleSettingsUpdate(request.settings, sendResponse);
    return true; // Indicates async response
  } else if (request.type === 'URL_UPDATED') {
    // Re-check whitelist when URL changes
    console.log('[Anime4KWebExt] URL changed, re-evaluating whitelist...');
    evaluateAndApplyWhitelistState();
  }
  return false;
});

} // end early-exit guard