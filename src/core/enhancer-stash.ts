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
  // Must have src to stash, as it is the most reliable identifier
  if (!video.src) return;

  console.log(`[Anime4KWebExt] Stashing enhancer for video src: ${video.src}`);
  enhancer.detach();

  const cleanupTimer = window.setTimeout(() => {
    console.log(`[Anime4KWebExt] Stash for ${video.src} expired. Cleaning up.`);
    clearStashEntry(video.src);
  }, STASH_TTL);

  stash.set(video.src, {
    enhancer,
    cleanupTimer,
  });
}

export function findAndunstashEnhancer(video: HTMLVideoElement): VideoEnhancer | null {
  if (!video.src) return null;

  const stashedItem = stash.get(video.src);
  if (!stashedItem) {
    return null;
  }

  console.log(`[Anime4KWebExt] Found stashed enhancer for video src: ${video.src}. Re-attaching.`);

  // Clear the timer and remove from Map
  clearTimeout(stashedItem.cleanupTimer);
  stash.delete(video.src);

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
