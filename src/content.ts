/**
 * Content script main entry point
 * Responsible for adding enhancement buttons to page video elements and managing enhancer instances
 */
import { initializeOnPage, deinitializeOnPage, handleSettingsUpdate } from '@core/video/video-manager';
import { isUrlWhitelisted, getWhitelistRules } from '@utils/whitelist';

// Exit early in sub-frames without video to avoid unnecessary storage reads and initialization
if (window !== window.top && !document.querySelector('video')) {
  // Silent exit — no cleanup needed
} else {

let isCurrentlyActive = false; // Track enhancement state for the current page

// Check if the current page is on the whitelist
async function shouldInitialize(): Promise<boolean> {
  try {
    const settings = await chrome.storage.sync.get(['whitelistEnabled']);
    if (!settings.whitelistEnabled) return true; // Always initialize when whitelist is disabled

    const rules = await getWhitelistRules();

    // Check current frame's URL first
    if (isUrlWhitelisted(window.location.href, rules)) return true;

    // If we're in an iframe, also check the top-level frame's URL.
    // This handles the common case where a user whitelists the parent page
    // but the video is embedded in an iframe from a different domain.
    if (window !== window.top) {
      try {
        // Same-origin: can access top frame's location directly
        if (isUrlWhitelisted(window.top!.location.href, rules)) return true;
      } catch {
        // Cross-origin: fall back to document.referrer (the URL that loaded this iframe)
        if (document.referrer && isUrlWhitelisted(document.referrer, rules)) return true;
      }
    }

    return false;
  } catch {
    // Extension context may be invalidated (e.g. extension update).
    // Default to allowing initialization.
    return true;
  }
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
    handleSettingsUpdate(request.settings ?? {}, sendResponse);
    return true; // Indicates async response
  } else if (request.type === 'URL_UPDATED') {
    // Re-check whitelist when URL changes
    console.log('[Anime4KWebExt] URL changed, re-evaluating whitelist...');
    evaluateAndApplyWhitelistState();
  }
  return false;
});

} // end early-exit guard