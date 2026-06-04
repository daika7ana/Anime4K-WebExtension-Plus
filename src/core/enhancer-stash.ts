import { VideoEnhancer } from './video-enhancer';

interface StashedEnhancer {
  enhancer: VideoEnhancer;
  cleanupTimer: number;
}

// 使用 Map 代替数组，O(1) 查找替代 O(n) findIndex
const stash = new Map<string, StashedEnhancer>();
const STASH_TTL = 2000;

export function stashEnhancer(enhancer: VideoEnhancer): void {
  const video = enhancer.getVideoElement();
  // 必须有 src 才能暂存，这是最可靠的标识符
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

  // 清理计时器并从 Map 中移除
  clearTimeout(stashedItem.cleanupTimer);
  stash.delete(video.src);

  return stashedItem.enhancer;
}

function clearStashEntry(videoSrc: string): void {
  const stashedItem = stash.get(videoSrc);
  if (stashedItem) {
    clearTimeout(stashedItem.cleanupTimer);
    stashedItem.enhancer.destroy(); // 真正销毁
    stash.delete(videoSrc);
  }
}
