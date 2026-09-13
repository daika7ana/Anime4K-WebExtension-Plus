/**
 * Content script main entry point
 * Responsible for adding enhancement buttons to page video elements and managing enhancer instances
 */
import { initializeOnPage, deinitializeOnPage, handleSettingsUpdate, disableAllAutoEnabled } from '@core/video/video-manager';
import { getAllManagedVideos, getEnhancer } from '@core/video/enhancer-map';
import { isUrlWhitelisted, getWhitelistRules } from '@utils/whitelist';
import { onMessage } from '@utils/messaging';

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
        const topUrl = window.top?.location.href;
        if (topUrl && isUrlWhitelisted(topUrl, rules)) return true;
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

/**
 * Find the largest visible managed video in the current viewport.
 * Returns null if no managed video is visible.
 */
function findPrimaryVideo(): HTMLVideoElement | null {
  const videos = getAllManagedVideos();
  if (videos.length === 0) return null;

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  let bestVideo: HTMLVideoElement | null = null;
  let bestArea = 0;

  for (const video of videos) {
    const rect = video.getBoundingClientRect();
    // Check if video is visible (has dimensions and intersects viewport)
    if (rect.width === 0 || rect.height === 0) continue;
    if (rect.bottom < 0 || rect.top > viewportHeight || rect.right < 0 || rect.left > viewportWidth) continue;

    // Calculate visible area
    const visibleWidth = Math.min(rect.width, viewportWidth - Math.max(0, rect.left));
    const visibleHeight = Math.min(rect.height, viewportHeight - Math.max(0, rect.top));
    const area = visibleWidth * visibleHeight;

    if (area > bestArea) {
      bestArea = area;
      bestVideo = video;
    }
  }

  return bestVideo;
}

// Listen for settings update messages from the background script
onMessage((message, _sender, sendResponse) => {
  switch (message.type) {
    case 'SETTINGS_UPDATED':
      handleSettingsUpdate(message.modifiedModeId, sendResponse);
      return true; // Indicates async response
    case 'URL_UPDATED':
      console.log('[Anime4KWebExt] URL changed, re-evaluating whitelist...');
      evaluateAndApplyWhitelistState();
      return false;
    case 'TOGGLE_ENHANCEMENT':
      {
        // The hotkey/popup acts as a page-level switch: stop every renderer that
        // was auto-enabled before falling back to the primary-video toggle.
        if (disableAllAutoEnabled() > 0) return false;
        const video = findPrimaryVideo();
        if (video) {
          const enhancer = getEnhancer(video);
          if (enhancer) {
            // Fire-and-forget: don't block the message channel
            enhancer.toggleEnhancement();
          }
        }
      }
      return false;
  }
});
