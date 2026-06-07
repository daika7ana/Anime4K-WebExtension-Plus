import { VideoEnhancer } from './video-enhancer';

interface StashedEnhancer {
  enhancer: VideoEnhancer;
  cleanupTimer: number;
}

// Use Map instead of array for O(1) lookup instead of O(n) findIndex
const stash = new Map<string, StashedEnhancer>();
const STASH_TTL = 2000;

export function stashEnhancer(enhancer: VideoEnhancer): void {
  const video = enhancer.getVideoElement();
  // Use currentSrc (which resolves <source> children) with src as fallback
  const videoSrc = video.currentSrc || video.src;
  if (!videoSrc) return;

  console.log(`[Anime4KWebExt] Stashing enhancer for video src: ${videoSrc}`);
  enhancer.detach();

  const cleanupTimer = window.setTimeout(() => {
    console.log(`[Anime4KWebExt] Stash for ${videoSrc} expired. Cleaning up.`);
    clearStashEntry(videoSrc);
  }, STASH_TTL);

  stash.set(videoSrc, {
    enhancer,
    cleanupTimer,
  });
}

export function findAndUnstashEnhancer(video: HTMLVideoElement): VideoEnhancer | null {
  const videoSrc = video.currentSrc || video.src;
  if (!videoSrc) return null;

  const stashedItem = stash.get(videoSrc);
  if (!stashedItem) {
    return null;
  }

  console.log(`[Anime4KWebExt] Found stashed enhancer for video src: ${videoSrc}. Re-attaching.`);

  // Clear the timer and remove from Map
  clearTimeout(stashedItem.cleanupTimer);
  stash.delete(videoSrc);

  return stashedItem.enhancer;
}

function clearStashEntry(videoSrc: string): void {
  const stashedItem = stash.get(videoSrc);
  if (stashedItem) {
    clearTimeout(stashedItem.cleanupTimer);
    stashedItem.enhancer.destroy(); // Actually destroy
    stash.delete(videoSrc);
  }
}

/**
 * Clear all stashed enhancers, cancel their timers, and destroy them.
 * Stashed enhancers are NOT in the EnhancerMap (they were dissociated on stash),
 * so they must be destroyed here to prevent GPU resource leaks.
 */
export function clearAllStash(): void {
  for (const [, entry] of stash) {
    clearTimeout(entry.cleanupTimer);
    entry.enhancer.destroy();
  }
  stash.clear();
}
