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
        toggleEnhancement: vi.fn().mockResolvedValue(undefined),
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
    autoEnableOnWhitelist: false,
    autoEnableSettleMs: 300,
  }),
}));

// Mock @/constants
vi.mock('@/constants', () => ({
  ANIME4K_APPLIED_ATTR: 'data-anime4k-applied',
}));

import {
  processVideoElement,
  initializeOnPage,
  deinitializeOnPage,
  disableAllAutoEnabled,
  DEFAULT_AUTO_ENABLE_SETTLE_MS,
} from './video-manager';
import * as EnhancerMap from './enhancer-map';
import { getSettings } from '@utils/settings';

/** jsdom reports a 0×0 rect by default, which would fail the eligibility gate. */
function stubVideoRect(video: HTMLVideoElement, width = 640, height = 360): void {
  vi.spyOn(video, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, width, height));
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const AUTO_ENABLE_SETTINGS = {
  selectedModeId: 'builtin-mode-a',
  enhancementModes: [],
  performanceTier: 'balanced',
  customModes: [],
  whitelist: [],
  whitelistEnabled: true,
  autoEnableOnWhitelist: true,
  autoEnableSettleMs: 300,
};

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

    it('auto-enables enhancement when autoEnableOnWhitelist is true and whitelist is enabled', async () => {
      vi.mocked(getSettings).mockResolvedValue({
        selectedModeId: 'builtin-mode-a',
        enhancementModes: [],
        performanceTier: 'balanced',
        customModes: [],
        whitelist: [],
        whitelistEnabled: true,
        autoEnableOnWhitelist: true,
      } as any);

      const video = document.createElement('video');
      document.body.appendChild(video);
      stubVideoRect(video);

      processVideoElement(video, 'test');

      // Wait out the settle window, then the fire-and-forget auto-enable completes.
      await vi.advanceTimersByTimeAsync(DEFAULT_AUTO_ENABLE_SETTLE_MS);

      // Get the enhancer that was created
      const enhancer = EnhancerMap.getEnhancer(video);
      expect(enhancer).toBeDefined();
      expect(enhancer!.toggleEnhancement).toHaveBeenCalled();
    });

    it('does not auto-enable when autoEnableOnWhitelist is false', async () => {
      vi.mocked(getSettings).mockResolvedValue({
        selectedModeId: 'builtin-mode-a',
        enhancementModes: [],
        performanceTier: 'balanced',
        customModes: [],
        whitelist: [],
        whitelistEnabled: true,
        autoEnableOnWhitelist: false,
      } as any);

      const video = document.createElement('video');
      document.body.appendChild(video);

      processVideoElement(video, 'test');

      await vi.advanceTimersByTimeAsync(0);

      const enhancer = EnhancerMap.getEnhancer(video);
      expect(enhancer).toBeDefined();
      expect(enhancer!.toggleEnhancement).not.toHaveBeenCalled();
    });

    it('does not auto-enable when whitelist is disabled', async () => {
      vi.mocked(getSettings).mockResolvedValue({
        selectedModeId: 'builtin-mode-a',
        enhancementModes: [],
        performanceTier: 'balanced',
        customModes: [],
        whitelist: [],
        whitelistEnabled: false,
        autoEnableOnWhitelist: true,
      } as any);

      const video = document.createElement('video');
      document.body.appendChild(video);

      processVideoElement(video, 'test');

      await vi.advanceTimersByTimeAsync(0);

      const enhancer = EnhancerMap.getEnhancer(video);
      expect(enhancer).toBeDefined();
      expect(enhancer!.toggleEnhancement).not.toHaveBeenCalled();
    });

    it('does not auto-enable a hidden/zero-size video', async () => {
      vi.mocked(getSettings).mockResolvedValue({
        selectedModeId: 'builtin-mode-a',
        enhancementModes: [],
        performanceTier: 'balanced',
        customModes: [],
        whitelist: [],
        whitelistEnabled: true,
        autoEnableOnWhitelist: true,
      } as any);

      const video = document.createElement('video');
      document.body.appendChild(video);
      // jsdom's getBoundingClientRect defaults to 0×0 — keep it that way.

      processVideoElement(video, 'test');
      await vi.advanceTimersByTimeAsync(DEFAULT_AUTO_ENABLE_SETTLE_MS);

      const enhancer = EnhancerMap.getEnhancer(video);
      expect(enhancer).toBeDefined();
      expect(enhancer!.toggleEnhancement).not.toHaveBeenCalled();
    });

    it('does not auto-enable an enhancer dissociated while settings load', async () => {
      const settingsPromise = deferred<any>();
      vi.mocked(getSettings).mockReturnValue(settingsPromise.promise);

      const video = document.createElement('video');
      document.body.appendChild(video);
      stubVideoRect(video);

      processVideoElement(video, 'test');
      const enhancer = EnhancerMap.getEnhancer(video);
      expect(enhancer).toBeDefined();

      // Simulate the element being removed/dissociated while getSettings resolves.
      EnhancerMap.dissociateEnhancer(video);

      settingsPromise.resolve({ whitelistEnabled: true, autoEnableOnWhitelist: true });
      await vi.advanceTimersByTimeAsync(DEFAULT_AUTO_ENABLE_SETTLE_MS);

      expect(enhancer!.toggleEnhancement).not.toHaveBeenCalled();
    });

    it('does not auto-enable a video that becomes ineligible during the settle window', async () => {
      vi.mocked(getSettings).mockResolvedValue({ ...AUTO_ENABLE_SETTINGS } as any);

      const video = document.createElement('video');
      document.body.appendChild(video);
      const rectSpy = vi.spyOn(video, 'getBoundingClientRect')
        .mockReturnValue(new DOMRect(0, 0, 640, 360));

      processVideoElement(video, 'test');
      await vi.advanceTimersByTimeAsync(0); // settings resolve; settle timer armed

      // The element collapses (e.g. a transient preview or ad) before the window ends.
      rectSpy.mockReturnValue(new DOMRect(0, 0, 0, 0));
      await vi.advanceTimersByTimeAsync(DEFAULT_AUTO_ENABLE_SETTLE_MS);

      const enhancer = EnhancerMap.getEnhancer(video);
      expect(enhancer).toBeDefined();
      expect(enhancer!.toggleEnhancement).not.toHaveBeenCalled();
    });

    it('does not auto-enable an enhancer dissociated during the settle window', async () => {
      vi.mocked(getSettings).mockResolvedValue({ ...AUTO_ENABLE_SETTINGS } as any);

      const video = document.createElement('video');
      document.body.appendChild(video);
      stubVideoRect(video);

      processVideoElement(video, 'test');
      const enhancer = EnhancerMap.getEnhancer(video);
      expect(enhancer).toBeDefined();

      await vi.advanceTimersByTimeAsync(0); // settle timer armed

      // The element is removed/re-associated while the window is open.
      EnhancerMap.dissociateEnhancer(video);
      await vi.advanceTimersByTimeAsync(DEFAULT_AUTO_ENABLE_SETTLE_MS);

      expect(enhancer!.toggleEnhancement).not.toHaveBeenCalled();
    });

    it('auto-enables a late-laid-out video that sizes within the settle window', async () => {
      vi.mocked(getSettings).mockResolvedValue({ ...AUTO_ENABLE_SETTINGS } as any);

      const video = document.createElement('video');
      document.body.appendChild(video);
      const rectSpy = vi.spyOn(video, 'getBoundingClientRect')
        .mockReturnValue(new DOMRect(0, 0, 0, 0)); // not yet laid out at discovery

      processVideoElement(video, 'test');
      await vi.advanceTimersByTimeAsync(0); // settle timer armed

      // The main player acquires its real size before the window closes.
      rectSpy.mockReturnValue(new DOMRect(0, 0, 1280, 720));
      await vi.advanceTimersByTimeAsync(DEFAULT_AUTO_ENABLE_SETTLE_MS);

      const enhancer = EnhancerMap.getEnhancer(video);
      expect(enhancer).toBeDefined();
      expect(enhancer!.toggleEnhancement).toHaveBeenCalledTimes(1);
    });

    it('auto-enables immediately when autoEnableSettleMs is 0', async () => {
      vi.mocked(getSettings).mockResolvedValue({ ...AUTO_ENABLE_SETTINGS, autoEnableSettleMs: 0 } as any);

      const video = document.createElement('video');
      document.body.appendChild(video);
      stubVideoRect(video);

      processVideoElement(video, 'test');
      // No timer advance needed: a 0 delay is skipped entirely.
      await vi.advanceTimersByTimeAsync(0);

      const enhancer = EnhancerMap.getEnhancer(video);
      expect(enhancer).toBeDefined();
      expect(enhancer!.toggleEnhancement).toHaveBeenCalledTimes(1);
    });

    it('does not auto-enable a hidden/0×0 video even when autoEnableSettleMs is 0', async () => {
      vi.mocked(getSettings).mockResolvedValue({ ...AUTO_ENABLE_SETTINGS, autoEnableSettleMs: 0 } as any);

      const video = document.createElement('video');
      document.body.appendChild(video);
      // jsdom getBoundingClientRect defaults to 0×0 — the eligibility gate applies.

      processVideoElement(video, 'test');
      await vi.advanceTimersByTimeAsync(0);

      const enhancer = EnhancerMap.getEnhancer(video);
      expect(enhancer).toBeDefined();
      expect(enhancer!.toggleEnhancement).not.toHaveBeenCalled();
    });

    it('honours a custom autoEnableSettleMs value', async () => {
      vi.mocked(getSettings).mockResolvedValue({ ...AUTO_ENABLE_SETTINGS, autoEnableSettleMs: 150 } as any);

      const video = document.createElement('video');
      document.body.appendChild(video);
      stubVideoRect(video);

      processVideoElement(video, 'test');

      await vi.advanceTimersByTimeAsync(149);
      const enhancer = EnhancerMap.getEnhancer(video)!;
      expect(enhancer.toggleEnhancement).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(enhancer.toggleEnhancement).toHaveBeenCalledTimes(1);
    });

    it('falls back to DEFAULT_AUTO_ENABLE_SETTLE_MS when the setting is missing', async () => {
      vi.mocked(getSettings).mockResolvedValue({
        selectedModeId: 'builtin-mode-a',
        enhancementModes: [],
        performanceTier: 'balanced',
        customModes: [],
        whitelist: [],
        whitelistEnabled: true,
        autoEnableOnWhitelist: true,
        // autoEnableSettleMs intentionally absent
      } as any);

      const video = document.createElement('video');
      document.body.appendChild(video);
      stubVideoRect(video);

      processVideoElement(video, 'test');

      await vi.advanceTimersByTimeAsync(DEFAULT_AUTO_ENABLE_SETTLE_MS - 1);
      const enhancer = EnhancerMap.getEnhancer(video)!;
      expect(enhancer.toggleEnhancement).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(enhancer.toggleEnhancement).toHaveBeenCalledTimes(1);
    });
  });

  describe('disableAllAutoEnabled', () => {
    it('disables only active auto-enabled videos and returns the count', async () => {
      vi.mocked(getSettings)
        // First video is processed while auto-enable is off (manual enhancer).
        .mockResolvedValueOnce({
          selectedModeId: 'builtin-mode-a',
          enhancementModes: [],
          performanceTier: 'balanced',
          customModes: [],
          whitelist: [],
          whitelistEnabled: true,
          autoEnableOnWhitelist: false,
        } as any)
        // Second video is auto-enabled.
        .mockResolvedValueOnce({
          selectedModeId: 'builtin-mode-a',
          enhancementModes: [],
          performanceTier: 'balanced',
          customModes: [],
          whitelist: [],
          whitelistEnabled: true,
          autoEnableOnWhitelist: true,
        } as any);

      const manualVideo = document.createElement('video');
      document.body.appendChild(manualVideo);
      stubVideoRect(manualVideo);

      const autoVideo = document.createElement('video');
      document.body.appendChild(autoVideo);
      stubVideoRect(autoVideo);

      processVideoElement(manualVideo, 'manual');
      processVideoElement(autoVideo, 'auto');
      await vi.advanceTimersByTimeAsync(DEFAULT_AUTO_ENABLE_SETTLE_MS);

      const manualEnhancer = EnhancerMap.getEnhancer(manualVideo)!;
      const autoEnhancer = EnhancerMap.getEnhancer(autoVideo)!;
      vi.mocked(manualEnhancer.toggleEnhancement).mockClear();
      vi.mocked(autoEnhancer.toggleEnhancement).mockClear();

      manualVideo.setAttribute('data-anime4k-applied', 'true');
      autoVideo.setAttribute('data-anime4k-applied', 'true');

      expect(disableAllAutoEnabled()).toBe(1);
      expect(autoEnhancer.toggleEnhancement).toHaveBeenCalledTimes(1);
      expect(manualEnhancer.toggleEnhancement).not.toHaveBeenCalled();
    });

    it('returns 0 when no auto-enabled video is active', () => {
      expect(disableAllAutoEnabled()).toBe(0);
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
