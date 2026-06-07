import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock VideoEnhancer before importing video-manager
const mockCreate = vi.fn();
const mockEnhancers: any[] = [];

vi.mock('./video-enhancer', () => ({
  VideoEnhancer: {
    create: (...args: any[]) => {
      const enhancer = {
        destroy: vi.fn(),
        detach: vi.fn(),
        reattach: vi.fn().mockResolvedValue(undefined),
        getVideoElement: vi.fn(),
        getCurrentModeId: vi.fn().mockReturnValue('builtin-mode-a'),
        updateSettings: vi.fn().mockResolvedValue(undefined),
        reapply: vi.fn().mockResolvedValue(undefined),
      };
      mockEnhancers.push(enhancer);
      mockCreate(...args);
      return enhancer;
    },
  },
}));

// Mock settings
vi.mock('@utils/settings', () => ({
  getSettings: vi.fn().mockResolvedValue({
    selectedModeId: 'builtin-mode-a',
    enhancementModes: [],
    performanceTier: 'balanced',
    customModes: [],
    whitelist: [],
    whitelistEnabled: false,
  }),
}));

// Mock @/constants
vi.mock('@/constants', () => ({
  ANIME4K_APPLIED_ATTR: 'data-anime4k-applied',
}));

import {
  processVideoElement,
  initializeOnPage,
  setupDOMObserver,
  deinitializeOnPage,
} from './video-manager';
import * as EnhancerMap from './enhancer-map';

describe('video-manager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Clean up module state between tests
    deinitializeOnPage();
    EnhancerMap.clearAll();
    mockEnhancers.length = 0;
    mockCreate.mockClear();
    // Clear any leftover DOM
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.useRealTimers();
    deinitializeOnPage();
  });

  describe('processVideoElement', () => {
    it('skips video that already has an enhancer', () => {
      const video = document.createElement('video');
      document.body.appendChild(video);

      processVideoElement(video, 'test');
      expect(mockCreate).toHaveBeenCalledOnce();

      processVideoElement(video, 'test-again');
      expect(mockCreate).toHaveBeenCalledOnce(); // still 1
    });

    it('skips video not in the DOM (no parentElement)', () => {
      const video = document.createElement('video');
      // Not appended to document

      processVideoElement(video, 'test');
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('creates a new enhancer for a DOM-attached video', () => {
      const video = document.createElement('video');
      document.body.appendChild(video);

      processVideoElement(video, 'test');

      expect(mockCreate).toHaveBeenCalledWith(video);
      expect(EnhancerMap.hasEnhancer(video)).toBe(true);
    });
  });

  describe('initializeOnPage / deinitializeOnPage', () => {
    it('initializes and creates observers', () => {
      const video = document.createElement('video');
      document.body.appendChild(video);

      initializeOnPage();

      // Should process existing videos
      expect(mockCreate).toHaveBeenCalledOnce();
    });

    it('skips re-initialization if already initialized', () => {
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      initializeOnPage();
      initializeOnPage();

      expect(consoleWarn).toHaveBeenCalledWith(
        expect.stringContaining('already initialized'),
      );
      consoleWarn.mockRestore();
    });

    it('deinitializeOnPage cleans up all resources', () => {
      const video = document.createElement('video');
      document.body.appendChild(video);

      initializeOnPage();
      expect(EnhancerMap.getAllManagedVideos()).toHaveLength(1);

      deinitializeOnPage();
      expect(EnhancerMap.getAllManagedVideos()).toEqual([]);
    });

    it('deinitializeOnPage is safe to call when not initialized', () => {
      expect(() => deinitializeOnPage()).not.toThrow();
    });
  });

  describe('setupDOMObserver', () => {
    it('watches for added video elements', async () => {
      // Start with no videos
      initializeOnPage();

      // Add a video dynamically
      const video = document.createElement('video');
      document.body.appendChild(video);

      // MutationObserver fires as a microtask in jsdom; advanceTimersByTimeAsync flushes microtasks
      await vi.advanceTimersByTimeAsync(150);

      expect(EnhancerMap.hasEnhancer(video)).toBe(true);
    });

    it('cleans up when video is removed from DOM', async () => {
      const video = document.createElement('video');
      document.body.appendChild(video);
      initializeOnPage();

      expect(EnhancerMap.hasEnhancer(video)).toBe(true);

      // Remove the video from DOM
      document.body.removeChild(video);

      // MutationObserver callback fires as a microtask; flush it
      await vi.advanceTimersByTimeAsync(0);

      // The video has no data-anime4k-applied attr, so it should be destroyed
      expect(EnhancerMap.hasEnhancer(video)).toBe(false);
    });

    it('batches multiple added nodes within debounce window', async () => {
      initializeOnPage();

      const v1 = document.createElement('video');
      const v2 = document.createElement('video');
      document.body.appendChild(v1);
      document.body.appendChild(v2);

      // Before debounce fires
      expect(mockEnhancers.length).toBe(0);

      // Advance past debounce (100ms) — async to flush MutationObserver microtask
      await vi.advanceTimersByTimeAsync(150);

      expect(EnhancerMap.hasEnhancer(v1)).toBe(true);
      expect(EnhancerMap.hasEnhancer(v2)).toBe(true);
    });

    it('skips non-element nodes in mutations', async () => {
      initializeOnPage();

      // Add a text node (should be ignored)
      document.body.appendChild(document.createTextNode('hello'));

      await vi.advanceTimersByTimeAsync(150);

      // No video enhancers created beyond what initializeOnPage already did
      expect(EnhancerMap.getAllManagedVideos()).toEqual([]);
    });

    it('skips script/style/link nodes in mutations', async () => {
      initializeOnPage();

      const script = document.createElement('script');
      const style = document.createElement('style');
      const link = document.createElement('link');
      document.body.appendChild(script);
      document.body.appendChild(style);
      document.body.appendChild(link);

      await vi.advanceTimersByTimeAsync(150);

      expect(EnhancerMap.getAllManagedVideos()).toEqual([]);
    });

    it('scans for videos inside newly added container elements', async () => {
      initializeOnPage();

      const container = document.createElement('div');
      const video = document.createElement('video');
      container.appendChild(video);
      document.body.appendChild(container);

      await vi.advanceTimersByTimeAsync(150);

      expect(EnhancerMap.hasEnhancer(video)).toBe(true);
    });
  });
});
