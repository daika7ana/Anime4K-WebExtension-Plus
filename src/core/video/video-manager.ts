import { VideoEnhancer } from './video-enhancer';
import { ANIME4K_APPLIED_ATTR } from '@/constants';
import { getSettings } from '@utils/settings';
import { stashEnhancer, findAndUnstashEnhancer, clearAllStash } from './enhancer-stash';
import * as EnhancerMap from './enhancer-map';


// Use a Set to track processed documents or ShadowRoots so listeners can be removed
const processedDocs = new Set<Document | ShadowRoot>();
// Define the core media events to watch for optimal performance
const mediaEventsToWatch: ReadonlyArray<string> = ['loadedmetadata', 'play', 'playing'];

let domObserver: MutationObserver | null = null;

/**
 * Cleans up the enhancer resources for a video element
 * @param video The video element
 */
function cleanupVideoEnhancer(video: HTMLVideoElement): void {
  const enhancer = EnhancerMap.getEnhancer(video);
  if (enhancer) {
    if (video.hasAttribute(ANIME4K_APPLIED_ATTR)) {
      stashEnhancer(enhancer);
    } else {
      enhancer.destroy();
    }
    EnhancerMap.dissociateEnhancer(video);
    console.log('[Anime4KWebExt] Cleaned up or stashed enhancer for video:', video);
  }
}

/**
 * Processes a single video element by adding an enhancer.
 * This is the final processing entry point for all video discovery paths (events, DOM changes).
 * @param videoEl The video element to process
 */
export function processVideoElement(videoEl: HTMLVideoElement, source: string): void {
  console.log(`[Anime4KWebExt] processVideoElement called from: ${source}`);
  // 1. State check (critical for preventing race conditions)
  if (EnhancerMap.hasEnhancer(videoEl)) {
    console.log(`[Anime4KWebExt] Enhancer already exists for this video. Skipping. Source: ${source}`);
    return;
  }

  // 2. Check if the video is in the DOM (prerequisite for UI attachment)
  if (!videoEl.parentElement) {
    console.log('[Anime4KWebExt] Video is not in the DOM, skipping enhancer creation for now.', videoEl);
    return;
  }

  // 3. Prefer restoring from stash
  const stashedEnhancer = findAndUnstashEnhancer(videoEl);
  if (stashedEnhancer) {
    console.log('[Anime4KWebExt] Re-attaching stashed enhancer.');
    EnhancerMap.associateEnhancer(videoEl, stashedEnhancer);
    stashedEnhancer.reattach(videoEl).catch(err => {
      console.error('[Anime4KWebExt] Failed to re-attach stashed enhancer:', err);
      EnhancerMap.dissociateEnhancer(videoEl);
      stashedEnhancer.destroy();
    });
    return;
  }

  // 4. Create a new Enhancer instance (synchronous)
  console.log('[Anime4KWebExt] Creating new enhancer for video:', videoEl);
  try {
    const enhancer = VideoEnhancer.create(videoEl);
    // Register in the Map immediately to establish a "lock"
    EnhancerMap.associateEnhancer(videoEl, enhancer);
    console.log('[Anime4KWebExt] Associated new enhancer to video:', videoEl);
  } catch (error) {
    console.error('Failed to create enhancer for video:', videoEl, error);
  }
}

/**
 * Unified callback handler for media events.
 * Uses event delegation pattern to capture events at the root node.
 * @param event The media event
 */
function handleMediaEvent(event: Event): void {
  const target = event.target;
  // Confirm the event source is a video element
  if (target instanceof HTMLVideoElement) {
    processVideoElement(target, `handleMediaEvent:${event.type}`);
  }
}

/**
 * Adds media event listeners to a specified document or ShadowRoot node.
 * This is the key to monitoring videos inside Shadow DOM.
 * @param doc Document or ShadowRoot
 */
function processDoc(doc: Document | ShadowRoot): void {
  if (processedDocs.has(doc)) {
    return; // Avoid duplicate processing
  }

  console.log('[Anime4KWebExt] Processing document/shadowRoot for media events:', doc);
  for (const eventName of mediaEventsToWatch) {
    // Use capture mode to detect videos early
    doc.addEventListener(eventName, handleMediaEvent, { capture: true, passive: true });
  }
  processedDocs.add(doc);
}

/**
 * Initialize the page, set up event listeners and DOM observer
 */
export function initializeOnPage(): void {
  if (domObserver) {
    console.warn('[Anime4KWebExt] initializeOnPage called while already initialized. Ignoring.');
    return;
  }
  // 1. Process the main document for media event delegation
  processDoc(document);
  
  // 2. Initial scan of existing videos
  const existingVideos = document.querySelectorAll('video');
  existingVideos.forEach(video => processVideoElement(video, 'initial-scan'));

  // 3. Set up DOM observer — use full observer if videos exist, lightweight detection otherwise
  if (existingVideos.length > 0 || document.querySelector('video')) {
    domObserver = setupDOMObserver();
  } else {
    domObserver = setupLightweightVideoDetection();
  }
}

/**
 * Set up DOM observer to watch for newly added video elements and Shadow DOM creation
 */
export function setupDOMObserver(): MutationObserver {
  let pendingAddedNodes: Node[] = [];
  let mutationDebounceTimer: number | null = null;

  const processBatchedMutations = () => {
    const nodes = pendingAddedNodes;
    pendingAddedNodes = [];
    mutationDebounceTimer = null;

    for (const node of nodes) {
      // Quick check: skip nodes that cannot contain videos
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const element = node as Element;
      const tagName = element.tagName;

      // Fast path: the node itself is a video
      if (tagName === 'VIDEO') {
        processVideoElement(element as HTMLVideoElement, 'mutation-observer:added-video-node');
        continue;
      }

      // Quickly skip common tags known to not contain videos
      if (tagName === 'SCRIPT' || tagName === 'STYLE' || tagName === 'LINK' ||
          tagName === 'META' || tagName === 'BR' || tagName === 'HR') continue;

      // Handle Shadow DOM
      if (element.shadowRoot) {
        processDoc(element.shadowRoot);
        element.shadowRoot.querySelectorAll('video').forEach(video => processVideoElement(video, 'mutation-observer:shadow-dom-scan'));
      }

      // Deep scan: find all nested videos
      const videos = element.querySelectorAll('video');
      if (videos.length > 0) {
        videos.forEach(video => processVideoElement(video, 'mutation-observer:subtree-scan'));
      }
    }
  };

  const handleMutations = (mutationsList: MutationRecord[]) => {
    for (const mutation of mutationsList) {
      // A. Collect added nodes (batch processing to reduce querySelectorAll calls)
      mutation.addedNodes.forEach(node => {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        pendingAddedNodes.push(node);
      });

      // B. Immediately process removed nodes (cannot delay, otherwise resource leak)
      mutation.removedNodes.forEach(node => {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const element = node as Element;
        if (element.tagName === 'VIDEO') {
          cleanupVideoEnhancer(element as HTMLVideoElement);
        } else {
          element.querySelectorAll('video').forEach(cleanupVideoEnhancer);
        }
      });
    }

    // Batch process added nodes (debounce: merge multiple DOM changes within the same event loop)
    if (mutationDebounceTimer !== null) {
      clearTimeout(mutationDebounceTimer);
    }
    mutationDebounceTimer = window.setTimeout(processBatchedMutations, 100);
  };

  const observer = new MutationObserver(handleMutations);
  observer.observe(document.body, { childList: true, subtree: true });
  
  // Add global cleanup on page unload to prevent memory leaks
  window.addEventListener('beforeunload', () => {
    document.querySelectorAll('video').forEach(cleanupVideoEnhancer);
  });
  
  return observer;
}

/**
 * Lightweight observer for pages without video. Watches for video elements
 * to appear, then promotes to the full DOM observer.
 */
function setupLightweightVideoDetection(): MutationObserver {
  let debounceTimer: number | null = null;
  let pendingNodes: Node[] = [];

  const checkForVideo = () => {
    const nodes = pendingNodes;
    pendingNodes = [];
    debounceTimer = null;

    for (const node of nodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const el = node as Element;
      if (el.tagName === 'VIDEO' || el.querySelector('video')) {
        // Video found! Promote to full observer
        console.log('[Anime4KWebExt] Video detected on page, activating full observer.');
        observer.disconnect();
        // Process any videos that now exist
        document.querySelectorAll('video').forEach(v => processVideoElement(v, 'lazy-detection'));
        domObserver = setupDOMObserver();
        return;
      }
    }
  };

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach(node => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          pendingNodes.push(node);
        }
      });
    }
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(checkForVideo, 100);
  });

  // Use a try-catch in case document.body doesn't exist yet
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  }

  return observer;
}

/**
 * Handle settings update event
 * @param settings The new settings
 * @param sendResponse The response callback function
 */
export async function handleSettingsUpdate(
  message: { type: string, modifiedModeId?: string },
  sendResponse: (response?: any) => void
): Promise<void> {
  console.log('Received settings update:', message);

  const newSettings = await getSettings();
  const videos = EnhancerMap.getAllManagedVideos();

  // Update all video settings in parallel instead of waiting one by one
  let updatedCount = 0;
  const updatePromises: Promise<void>[] = [];

  for (const videoElement of videos) {
    const enhancer = EnhancerMap.getEnhancer(videoElement);
    if (enhancer && videoElement.getAttribute(ANIME4K_APPLIED_ATTR) === 'true') {
      if (message.modifiedModeId) {
        // Options page edit: only update videos using the modified mode (hot-swap)
        if (enhancer.getCurrentModeId() === message.modifiedModeId) {
          updatePromises.push(
            enhancer.updateSettings(newSettings).then(() => { updatedCount++; })
          );
        }
      } else {
        // Popup save: full reapply to ensure old filters are removed and new ones applied
        updatePromises.push(
          enhancer.reapply().then(() => { updatedCount++; })
        );
      }
    }
  }

  await Promise.allSettled(updatePromises);

  if (updatedCount > 0) {
    sendResponse({ status: 'SUCCESS', message: `Updated ${updatedCount} videos.` });
  } else {
    sendResponse({ status: 'NO_ACTION', message: 'No active instances needed an update.' });
  }
}

/**
 * De-initialize the page, thoroughly clean up all resources
 */
export function deinitializeOnPage(): void {
  // 1. Disconnect and clear the DOM observer
  if (domObserver) {
    domObserver.disconnect();
    domObserver = null;
    console.log('[Anime4KWebExt] DOM Observer disconnected.');
  }

  // 2. Remove all media event listeners
  processedDocs.forEach(doc => {
    for (const eventName of mediaEventsToWatch) {
      doc.removeEventListener(eventName, handleMediaEvent, { capture: true });
    }
  });
  processedDocs.clear();
  console.log('[Anime4KWebExt] All media event listeners removed.');

  // 3. Destroy all enhancer instances
  const videos = EnhancerMap.getAllManagedVideos();
  console.log(`[Anime4KWebExt] De-initializing and cleaning up ${videos.length} videos.`);
  videos.forEach(video => {
    const enhancer = EnhancerMap.getEnhancer(video);
    if (enhancer) {
      enhancer.destroy();
      EnhancerMap.dissociateEnhancer(video);
    }
  });

  // Bulk cleanup module-level singletons to prevent stale references
  EnhancerMap.clearAll();
  clearAllStash();
}
