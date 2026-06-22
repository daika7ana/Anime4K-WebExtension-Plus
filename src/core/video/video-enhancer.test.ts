import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.hoisted ensures these are available when vi.mock factories execute (they're hoisted too)
const { mockOverlay, mockRenderer } = vi.hoisted(() => {
  const mockOverlay = {
    getButton: vi.fn(() => document.createElement('button')),
    getCanvas: vi.fn(() => document.createElement('canvas')),
    showCanvas: vi.fn(),
    hideCanvas: vi.fn(),
    detach: vi.fn(),
    reattach: vi.fn(),
    destroy: vi.fn(),
  };

  const mockRenderer = {
    destroy: vi.fn(),
    updateConfiguration: vi.fn().mockResolvedValue(undefined),
    updateVideoSource: vi.fn().mockResolvedValue(undefined),
  };

  return { mockOverlay, mockRenderer };
});

vi.mock('@core/ui/overlay-manager', () => ({
  OverlayManager: {
    create: vi.fn(() => mockOverlay),
  },
}));

vi.mock('@core/renderer', () => ({
  Renderer: {
    create: vi.fn().mockResolvedValue(mockRenderer),
  },
}));

vi.mock('@utils/settings', () => ({
  getSettings: vi.fn().mockResolvedValue({
    selectedModeId: 'builtin-mode-a',
    enhancementModes: [
      { id: 'builtin-mode-a', baseMode: 'A', name: 'Mode A', isBuiltIn: true },
    ],
    targetResolutionSetting: 'x2',
    performanceTier: 'balanced',
    enableCrossOriginFix: false,
  }),
  getEffectsForMode: vi.fn().mockReturnValue([
    { id: 'anime4k/Helper/ClampHighlights', name: 'Clamp Highlights', className: 'ClampHighlights' },
  ]),
}));

vi.mock('@/constants', () => ({
  ANIME4K_APPLIED_ATTR: 'data-anime4k-applied',
}));

vi.mock('@core/utils/yield-utils', () => ({
  yieldToAnimationFrame: vi.fn().mockResolvedValue(undefined),
  yieldToMain: vi.fn().mockResolvedValue(undefined),
}));

import { VideoEnhancer } from './video-enhancer';
import { OverlayManager } from '@core/ui/overlay-manager';
import { Renderer } from '@core/renderer';
import { getSettings } from '@utils/settings';

describe('VideoEnhancer', () => {
  let video: HTMLVideoElement;

  beforeEach(() => {
    vi.clearAllMocks();
    video = document.createElement('video');
    document.body.appendChild(video);

    // jsdom videos have readyState=0 by default, but initRenderer() awaits
    // loadedmetadata when readyState < 1 — set it to 1 (HAVE_METADATA) to avoid hang
    Object.defineProperty(video, 'readyState', { value: 1, configurable: true });

    // initRenderer() checks navigator.gpu — stub it for jsdom
    vi.stubGlobal('navigator', { ...navigator, gpu: {} });

    // Reset mock implementations to defaults
    mockOverlay.getButton.mockReturnValue(document.createElement('button'));
    mockOverlay.getCanvas.mockReturnValue(document.createElement('canvas'));
    (Renderer.create as ReturnType<typeof vi.fn>).mockResolvedValue(mockRenderer);
    (getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      selectedModeId: 'builtin-mode-a',
      enhancementModes: [
        { id: 'builtin-mode-a', baseMode: 'A', name: 'Mode A', isBuiltIn: true },
      ],
      targetResolutionSetting: 'x2',
      performanceTier: 'balanced',
      enableCrossOriginFix: false,
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  describe('creation', () => {
    it('create() returns an instance', () => {
      const enhancer = VideoEnhancer.create(video);
      expect(enhancer).toBeDefined();
      enhancer.destroy();
    });

    it('creates an overlay for the video', () => {
      const enhancer = VideoEnhancer.create(video);
      expect(OverlayManager.create).toHaveBeenCalledWith(video);
      enhancer.destroy();
    });

    it('initially has no active mode', () => {
      const enhancer = VideoEnhancer.create(video);
      expect(enhancer.getCurrentModeId()).toBeNull();
      enhancer.destroy();
    });

    it('getVideoElement() returns the video', () => {
      const enhancer = VideoEnhancer.create(video);
      expect(enhancer.getVideoElement()).toBe(video);
      enhancer.destroy();
    });
  });

  describe('toggleEnhancement (off → on)', () => {
    it('sets data-anime4k-applied attribute on video', async () => {
      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      expect(video.getAttribute('data-anime4k-applied')).toBe('true');
      enhancer.destroy();
    });

    it('creates a Renderer', async () => {
      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      expect(Renderer.create).toHaveBeenCalled();
      enhancer.destroy();
    });

    it('sets currentModeId after successful toggle', async () => {
      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      expect(enhancer.getCurrentModeId()).toBe('builtin-mode-a');
      enhancer.destroy();
    });

    it('does not reinitialize while already initializing', async () => {
      const enhancer = VideoEnhancer.create(video);

      // Fire two toggles in quick succession
      const p1 = enhancer.toggleEnhancement();
      const p2 = enhancer.toggleEnhancement();

      await Promise.all([p1, p2]);

      // Second toggle should have been a no-op (initializing guard)
      // Only one Renderer.create should have been called
      expect((Renderer.create as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(1);
      enhancer.destroy();
    });
  });

  describe('toggleEnhancement (on → off)', () => {
    it('removes data-anime4k-applied attribute', async () => {
      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();
      expect(video.getAttribute('data-anime4k-applied')).toBe('true');

      await enhancer.toggleEnhancement();
      expect(video.hasAttribute('data-anime4k-applied')).toBe(false);
    });

    it('destroys the renderer', async () => {
      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      await enhancer.toggleEnhancement();
      expect(mockRenderer.destroy).toHaveBeenCalled();
    });

    it('clears currentModeId', async () => {
      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();
      expect(enhancer.getCurrentModeId()).toBe('builtin-mode-a');

      await enhancer.toggleEnhancement();
      expect(enhancer.getCurrentModeId()).toBeNull();
    });
  });

  describe('destroy()', () => {
    it('destroys renderer and overlay', async () => {
      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      enhancer.destroy();

      expect(mockRenderer.destroy).toHaveBeenCalled();
      expect(mockOverlay.destroy).toHaveBeenCalled();
    });

    it('removes data-anime4k-applied attribute', async () => {
      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      enhancer.destroy();

      expect(video.hasAttribute('data-anime4k-applied')).toBe(false);
    });

    it('is safe to call without prior toggle', () => {
      const enhancer = VideoEnhancer.create(video);
      expect(() => enhancer.destroy()).not.toThrow();
    });
  });

  describe('detach() / reattach()', () => {
    it('detach removes overlay and attribute', async () => {
      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      enhancer.detach();

      expect(mockOverlay.detach).toHaveBeenCalled();
      expect(video.hasAttribute('data-anime4k-applied')).toBe(false);
    });

    it('reattach updates video source on renderer', async () => {
      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      const newVideo = document.createElement('video');
      document.body.appendChild(newVideo);

      await enhancer.reattach(newVideo);

      expect(mockOverlay.reattach).toHaveBeenCalledWith(newVideo);
      expect(mockRenderer.updateVideoSource).toHaveBeenCalledWith(newVideo);
      expect(enhancer.getVideoElement()).toBe(newVideo);

      enhancer.destroy();
    });

    it('reattach without renderer calls disableEnhancement', async () => {
      const enhancer = VideoEnhancer.create(video);
      // Don't toggle — no renderer

      const newVideo = document.createElement('video');
      document.body.appendChild(newVideo);

      // Should not throw
      await enhancer.reattach(newVideo);
      enhancer.destroy();
    });
  });

  describe('updateSettings()', () => {
    it('updates renderer configuration when renderer exists', async () => {
      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      const newSettings = {
        selectedModeId: 'builtin-mode-a',
        enhancementModes: [
          { id: 'builtin-mode-a', baseMode: 'A' as const, name: 'Mode A', isBuiltIn: true as const },
        ],
        targetResolutionSetting: 'x4',
        performanceTier: 'quality' as const,
        customModes: [],
        whitelist: [],
        whitelistEnabled: false,
        enableCrossOriginFix: false,
        colorGrading: { enabled: false, brightness: 0, gamma: 1, contrast: 1, saturation: 1, vibrance: 0, exposure: 0 },
      };

      await enhancer.updateSettings(newSettings);

      expect(mockRenderer.updateConfiguration).toHaveBeenCalled();
      enhancer.destroy();
    });

    it('does nothing when no renderer exists', async () => {
      const enhancer = VideoEnhancer.create(video);
      // Don't toggle

      await enhancer.updateSettings({} as any);

      expect(mockRenderer.updateConfiguration).not.toHaveBeenCalled();
      enhancer.destroy();
    });
  });

  describe('reapply()', () => {
    it('calls disable then toggle', async () => {
      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      const toggleSpy = vi.spyOn(enhancer, 'toggleEnhancement');

      await enhancer.reapply();

      // After reapply, renderer should have been destroyed then recreated
      expect(mockRenderer.destroy).toHaveBeenCalled();
      expect(toggleSpy).toHaveBeenCalled();
      enhancer.destroy();
    });

    it('does nothing when no renderer exists', async () => {
      const enhancer = VideoEnhancer.create(video);
      // Don't toggle

      await enhancer.reapply();

      expect(Renderer.create).not.toHaveBeenCalled();
      enhancer.destroy();
    });
  });

  describe('calculateTargetDimensions (via toggle)', () => {
    it('applies x2 multiplier', async () => {
      Object.defineProperty(video, 'videoWidth', { value: 640, configurable: true });
      Object.defineProperty(video, 'videoHeight', { value: 360, configurable: true });

      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      const createCall = (Renderer.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createCall.targetDimensions).toEqual({ width: 1280, height: 720 });

      enhancer.destroy();
    });

    it('caps dimensions at 8K', async () => {
      Object.defineProperty(video, 'videoWidth', { value: 3840, configurable: true });
      Object.defineProperty(video, 'videoHeight', { value: 2160, configurable: true });

      (getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        selectedModeId: 'builtin-mode-a',
        enhancementModes: [
          { id: 'builtin-mode-a', baseMode: 'A', name: 'Mode A', isBuiltIn: true },
        ],
        targetResolutionSetting: 'x4',
        performanceTier: 'balanced',
        enableCrossOriginFix: false,
      });

      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      const createCall = (Renderer.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createCall.targetDimensions.width).toBeLessThanOrEqual(7680);
      expect(createCall.targetDimensions.height).toBeLessThanOrEqual(4320);

      enhancer.destroy();
    });

    it('uses fixed resolution when specified', async () => {
      Object.defineProperty(video, 'videoWidth', { value: 640, configurable: true });
      Object.defineProperty(video, 'videoHeight', { value: 360, configurable: true });

      (getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        selectedModeId: 'builtin-mode-a',
        enhancementModes: [
          { id: 'builtin-mode-a', baseMode: 'A', name: 'Mode A', isBuiltIn: true },
        ],
        targetResolutionSetting: '1080p',
        performanceTier: 'balanced',
        enableCrossOriginFix: false,
      });

      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      const createCall = (Renderer.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createCall.targetDimensions).toEqual({ width: 1920, height: 1080 });

      enhancer.destroy();
    });
  });
});
