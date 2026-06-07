import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  stashEnhancer,
  findAndUnstashEnhancer,
  clearAllStash,
} from './enhancer-stash';

// Mock VideoEnhancer with a fake video element
function makeMockEnhancer(src: string) {
  const video = document.createElement('video');
  // jsdom doesn't support currentSrc property setter, so we use Object.defineProperty
  Object.defineProperty(video, 'currentSrc', { value: src, writable: true, configurable: true });
  // Provide a fallback src if currentSrc is empty
  if (!src) video.setAttribute('src', '');

  return {
    getVideoElement: () => video,
    detach: vi.fn(),
    destroy: vi.fn(),
    reattach: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe('enhancer-stash', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearAllStash();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('stashEnhancer', () => {
    it('stashes an enhancer and detaches it', () => {
      const enhancer = makeMockEnhancer('https://example.com/video.mp4');
      stashEnhancer(enhancer);

      expect(enhancer.detach).toHaveBeenCalledOnce();
    });

    it('does nothing if video has no src (both currentSrc and src empty)', () => {
      // Create a mock where both currentSrc and src resolve to empty
      const video = document.createElement('video');
      // Don't set src attribute; jsdom returns '' for both currentSrc and src
      const enhancer = {
        getVideoElement: () => video,
        detach: vi.fn(),
        destroy: vi.fn(),
      } as any;

      // Override currentSrc to ensure it's empty (jsdom default)
      Object.defineProperty(video, 'currentSrc', { value: '', configurable: true });

      stashEnhancer(enhancer);

      // Both are empty → early return, detach should not be called
      expect(enhancer.detach).not.toHaveBeenCalled();
    });
  });

  describe('findAndUnstashEnhancer', () => {
    it('returns null when stash is empty', () => {
      const video = document.createElement('video');
      Object.defineProperty(video, 'currentSrc', { value: 'https://example.com/v.mp4', configurable: true });

      expect(findAndUnstashEnhancer(video)).toBeNull();
    });

    it('returns null when video src does not match any stashed entry', () => {
      const enhancer = makeMockEnhancer('https://example.com/video1.mp4');
      stashEnhancer(enhancer);

      const video = document.createElement('video');
      Object.defineProperty(video, 'currentSrc', { value: 'https://example.com/video2.mp4', configurable: true });

      expect(findAndUnstashEnhancer(video)).toBeNull();
    });

    it('finds and returns stashed enhancer by matching src', () => {
      const src = 'https://example.com/video.mp4';
      const enhancer = makeMockEnhancer(src);
      stashEnhancer(enhancer);

      const video = document.createElement('video');
      Object.defineProperty(video, 'currentSrc', { value: src, configurable: true });

      const found = findAndUnstashEnhancer(video);
      expect(found).toBe(enhancer);
    });

    it('removes the entry from stash after unstashing', () => {
      const src = 'https://example.com/video.mp4';
      const enhancer = makeMockEnhancer(src);
      stashEnhancer(enhancer);

      const video = document.createElement('video');
      Object.defineProperty(video, 'currentSrc', { value: src, configurable: true });

      findAndUnstashEnhancer(video);

      // Second attempt should return null
      expect(findAndUnstashEnhancer(video)).toBeNull();
    });

    it('cancels the cleanup timer when unstashing', () => {
      const src = 'https://example.com/video.mp4';
      const enhancer = makeMockEnhancer(src);
      stashEnhancer(enhancer);

      const video = document.createElement('video');
      Object.defineProperty(video, 'currentSrc', { value: src, configurable: true });

      findAndUnstashEnhancer(video);

      // Advancing time past TTL should not trigger destroy (timer was cancelled)
      vi.advanceTimersByTime(5000);
      expect(enhancer.destroy).not.toHaveBeenCalled();
    });
  });

  describe('stash TTL expiry', () => {
    it('destroys enhancer after TTL expires (2s)', () => {
      const enhancer = makeMockEnhancer('https://example.com/video.mp4');
      stashEnhancer(enhancer);

      expect(enhancer.destroy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(2001);

      expect(enhancer.destroy).toHaveBeenCalledOnce();
    });

    it('does not destroy if unstashed before TTL', () => {
      const src = 'https://example.com/video.mp4';
      const enhancer = makeMockEnhancer(src);
      stashEnhancer(enhancer);

      vi.advanceTimersByTime(1000); // Halfway through TTL

      const video = document.createElement('video');
      Object.defineProperty(video, 'currentSrc', { value: src, configurable: true });
      findAndUnstashEnhancer(video);

      vi.advanceTimersByTime(5000);
      expect(enhancer.destroy).not.toHaveBeenCalled();
    });
  });

  describe('clearAllStash', () => {
    it('destroys all stashed enhancers and clears timers', () => {
      const e1 = makeMockEnhancer('https://example.com/v1.mp4');
      const e2 = makeMockEnhancer('https://example.com/v2.mp4');

      stashEnhancer(e1);
      stashEnhancer(e2);

      clearAllStash();

      expect(e1.destroy).toHaveBeenCalledOnce();
      expect(e2.destroy).toHaveBeenCalledOnce();

      // Timers should be cancelled — advancing time should not trigger double-destroy
      vi.advanceTimersByTime(5000);
      expect(e1.destroy).toHaveBeenCalledTimes(1);
      expect(e2.destroy).toHaveBeenCalledTimes(1);
    });

    it('is safe to call when stash is empty', () => {
      expect(() => clearAllStash()).not.toThrow();
    });
  });
});
