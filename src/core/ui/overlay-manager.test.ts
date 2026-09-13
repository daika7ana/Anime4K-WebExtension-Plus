import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OverlayManager } from './overlay-manager';

/**
 * Creates a video element inside a parent div, sets common layout properties,
 * and stubs browser APIs that jsdom does not provide.
 */
function createTestVideo(): HTMLVideoElement {
  const parent = document.createElement('div');
  parent.id = 'test-parent';
  document.body.appendChild(parent);

  const video = document.createElement('video');
  parent.appendChild(video);

  // Give the video some dimensions so updatePosition() doesn't hide the host
  Object.defineProperty(video, 'offsetWidth', { value: 640, configurable: true });
  Object.defineProperty(video, 'offsetHeight', { value: 360, configurable: true });
  Object.defineProperty(video, 'offsetTop', { value: 0, configurable: true });
  Object.defineProperty(video, 'offsetLeft', { value: 0, configurable: true });
  Object.defineProperty(video, 'videoWidth', { value: 640, configurable: true });
  Object.defineProperty(video, 'videoHeight', { value: 360, configurable: true });

  return video;
}

function cleanupDom(): void {
  document.body.innerHTML = '';
}

/**
 * Stub-able mock for document.elementFromPoint.
 * jsdom does not expose this method by default.
 */
let elementFromPointMock: any;

describe('OverlayManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();

    // Stub ResizeObserver (not available in jsdom)
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });

    // Stub requestAnimationFrame / cancelAnimationFrame using fake-timer compatible approach
    // NOTE: with fake timers, setTimeout is also faked, so rAF callbacks only fire on advanceTimersByTime.
    vi.stubGlobal('requestAnimationFrame', vi.fn((cb: FrameRequestCallback) => {
      return setTimeout(() => cb(performance.now()), 0) as unknown as number;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => clearTimeout(id)));

    // elementFromPoint is not defined in jsdom — polyfill it as a mock.
    elementFromPointMock = vi.fn((_x: number, _y: number) => null) as any;
    (document as any).elementFromPoint = elementFromPointMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    cleanupDom();
  });

  // ── create() ──────────────────────────────────────────────────
  describe('create()', () => {
    it('creates a host element as a sibling of the video', () => {
      const video = createTestVideo();
      const manager = OverlayManager.create(video);

      const host = video.parentElement?.querySelector('[data-anime4k-overlay-host]');
      expect(host).toBeDefined();
      expect(host?.tagName).toBe('DIV');

      manager.destroy();
    });

    it('removes orphaned overlay hosts from the parent on create', () => {
      const video = createTestVideo();

      // Pre-create an orphaned host
      const orphan = document.createElement('div');
      orphan.setAttribute('data-anime4k-overlay-host', '');
      video.parentElement!.appendChild(orphan);

      const removeSpy = vi.spyOn(orphan, 'remove');

      OverlayManager.create(video);

      expect(removeSpy).toHaveBeenCalled();
    });

    it('removes orphaned overlay hosts from body on create', () => {
      // Create a body-attached orphan
      const orphan = document.createElement('div');
      orphan.setAttribute('data-anime4k-overlay-host', '');
      document.body.appendChild(orphan);

      const removeSpy = vi.spyOn(orphan, 'remove');

      const video = createTestVideo();
      OverlayManager.create(video);

      expect(removeSpy).toHaveBeenCalled();
    });

    it('returns an OverlayManager instance', () => {
      const video = createTestVideo();
      const manager = OverlayManager.create(video);
      expect(manager).toBeInstanceOf(OverlayManager);
      manager.destroy();
    });
  });

  // ── getButton() ───────────────────────────────────────────────
  describe('getButton()', () => {
    it('returns the button from the shadow DOM', () => {
      const video = createTestVideo();
      const manager = OverlayManager.create(video);

      const button = manager.getButton();
      expect(button).toBeInstanceOf(HTMLButtonElement);
      expect(button.classList.contains('anime4k-button')).toBe(true);

      manager.destroy();
    });

    it('returns the same button on subsequent calls', () => {
      const video = createTestVideo();
      const manager = OverlayManager.create(video);

      const b1 = manager.getButton();
      const b2 = manager.getButton();
      expect(b1).toBe(b2);

      manager.destroy();
    });
  });

  // ── getCanvas() ───────────────────────────────────────────────
  describe('getCanvas()', () => {
    it('creates a canvas on first call', () => {
      const video = createTestVideo();
      const manager = OverlayManager.create(video);

      const canvas = manager.getCanvas();
      expect(canvas).toBeInstanceOf(HTMLCanvasElement);
      expect(canvas.style.pointerEvents).toBe('none');
      expect(canvas.style.visibility).toBe('hidden');

      manager.destroy();
    });

    it('sets canvas dimensions from the video', () => {
      const video = createTestVideo();
      const manager = OverlayManager.create(video);

      const canvas = manager.getCanvas();
      expect(canvas.width).toBe(video.videoWidth);
      expect(canvas.height).toBe(video.videoHeight);

      manager.destroy();
    });

    it('returns the same canvas on subsequent calls', () => {
      const video = createTestVideo();
      const manager = OverlayManager.create(video);

      const c1 = manager.getCanvas();
      const c2 = manager.getCanvas();
      expect(c1).toBe(c2);

      manager.destroy();
    });
  });

  // ── showCanvas() / hideCanvas() ───────────────────────────────
  describe('showCanvas()', () => {
    it('inserts canvas into the DOM and hides the original video', () => {
      const video = createTestVideo();
      const manager = OverlayManager.create(video);

      manager.showCanvas();

      // Canvas should be a sibling of the video
      const canvas = video.parentElement?.querySelector('canvas');
      expect(canvas).toBeDefined();
      expect(canvas!.style.visibility).toBe('visible');
      expect(video.style.opacity).toBe('0');

      manager.destroy();
    });

    it('is idempotent — calling showCanvas twice does not insert a second canvas', () => {
      const video = createTestVideo();
      const manager = OverlayManager.create(video);

      manager.showCanvas();
      manager.showCanvas();

      const canvases = video.parentElement?.querySelectorAll('canvas');
      expect(canvases?.length).toBe(1);

      manager.destroy();
    });
  });

  describe('hideCanvas()', () => {
    it('removes canvas from DOM and restores video opacity', () => {
      const video = createTestVideo();
      const manager = OverlayManager.create(video);

      manager.showCanvas();
      manager.hideCanvas();

      expect(video.parentElement?.querySelector('canvas')).toBeNull();
      expect(video.style.opacity).toBe('');
    });
  });

  // ── detach() ──────────────────────────────────────────────────
  describe('detach()', () => {
    it('removes the host from the DOM', () => {
      const video = createTestVideo();
      const manager = OverlayManager.create(video);

      const host = video.parentElement?.querySelector('[data-anime4k-overlay-host]');
      expect(host).toBeDefined();

      manager.detach();

      expect(video.parentElement?.querySelector('[data-anime4k-overlay-host]')).toBeNull();
      manager.destroy();
    });

    it('removes canvas from DOM when canvas was shown', () => {
      const video = createTestVideo();
      const manager = OverlayManager.create(video);

      manager.showCanvas();
      expect(video.parentElement?.querySelector('canvas')).toBeDefined();

      manager.detach();
      expect(video.parentElement?.querySelector('canvas')).toBeNull();
      manager.destroy();
    });

    it('restores the video opacity and removes the canvas after showCanvas()', () => {
      const video = createTestVideo();
      const manager = OverlayManager.create(video);

      manager.showCanvas();
      expect(video.style.opacity).toBe('0');
      expect(video.parentElement?.querySelector('canvas')).toBeDefined();

      manager.detach();

      // Without restoring opacity, the video would stay hidden with no canvas.
      expect(video.style.opacity).toBe('');
      expect(video.parentElement?.querySelector('canvas')).toBeNull();

      manager.destroy();
    });
  });

  // ── destroy() ─────────────────────────────────────────────────
  describe('destroy()', () => {
    it('removes the host from the DOM', () => {
      const video = createTestVideo();
      const manager = OverlayManager.create(video);

      manager.destroy();

      expect(video.parentElement?.querySelector('[data-anime4k-overlay-host]')).toBeNull();
    });

    it('is idempotent — safe to call destroy twice', () => {
      const video = createTestVideo();
      const manager = OverlayManager.create(video);

      expect(() => {
        manager.destroy();
        manager.destroy();
      }).not.toThrow();
    });

    it('clears the hide-button timeout', () => {
      const video = createTestVideo();
      const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');
      const manager = OverlayManager.create(video);

      manager.destroy();

      // The constructor sets a 3000ms timeout for show-initially removal
      expect(clearTimeoutSpy).toHaveBeenCalled();
    });

    it('disconnects observers', () => {
      const video = createTestVideo();
      const disconnectSpy = vi.spyOn(ResizeObserver.prototype, 'disconnect');
      const manager = OverlayManager.create(video);

      manager.destroy();

      expect(disconnectSpy).toHaveBeenCalled();
    });

    it('hides canvas on destroy', () => {
      const video = createTestVideo();
      const manager = OverlayManager.create(video);
      manager.showCanvas();

      manager.destroy();

      expect(video.parentElement?.querySelector('canvas')).toBeNull();
    });

    it('removes body-strategy event listeners on destroy', () => {
      const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');
      const video = createTestVideo();

      // Force body strategy by making elementFromPoint return something not the button
      elementFromPointMock.mockReturnValue(document.createElement('div'));
      const manager = OverlayManager.create(video);

      // Advance timers so the strategy detection timeout fires
      vi.advanceTimersByTime(200);

      manager.destroy();

      // Should have removed the resize listener when on body strategy
      expect(removeEventListenerSpy).toHaveBeenCalledWith('resize', expect.any(Function));
    });
  });

  // ── reattach() ────────────────────────────────────────────────
  describe('reattach()', () => {
    it('re-inserts the host into the DOM under the new video', () => {
      const video = createTestVideo();
      const manager = OverlayManager.create(video);
      manager.detach();

      // Create a new video
      const parent2 = document.createElement('div');
      parent2.id = 'test-parent-2';
      document.body.appendChild(parent2);
      const video2 = document.createElement('video');
      parent2.appendChild(video2);
      Object.defineProperty(video2, 'offsetWidth', { value: 640, configurable: true });
      Object.defineProperty(video2, 'offsetHeight', { value: 360, configurable: true });
      Object.defineProperty(video2, 'offsetTop', { value: 0, configurable: true });
      Object.defineProperty(video2, 'offsetLeft', { value: 0, configurable: true });

      manager.reattach(video2);

      expect(parent2.querySelector('[data-anime4k-overlay-host]')).toBeDefined();
      manager.destroy();
    });

    it('reattaches canvas to new video parent when canvas exists', () => {
      const video = createTestVideo();
      const manager = OverlayManager.create(video);
      manager.getCanvas(); // create canvas
      manager.detach();

      const parent2 = document.createElement('div');
      document.body.appendChild(parent2);
      const video2 = document.createElement('video');
      parent2.appendChild(video2);
      Object.defineProperty(video2, 'offsetWidth', { value: 640, configurable: true });
      Object.defineProperty(video2, 'offsetHeight', { value: 360, configurable: true });
      Object.defineProperty(video2, 'offsetTop', { value: 0, configurable: true });
      Object.defineProperty(video2, 'offsetLeft', { value: 0, configurable: true });

      manager.reattach(video2);

      expect(parent2.querySelector('canvas')).toBeDefined();
      manager.destroy();
    });
  });

  // ── Body attachment strategy ──────────────────────────────────
  describe('body attachment strategy', () => {
    it('switches to body strategy when button is obscured', () => {
      const video = createTestVideo();
      // elementFromPoint returns something not the button → obscured → switch to body
      elementFromPointMock.mockReturnValue(document.createElement('div'));

      const manager = OverlayManager.create(video);

      // Advance past the 100ms detection timeout
      vi.advanceTimersByTime(200);

      // Host should now be a direct child of body (body strategy)
      const hostOnBody = document.body.querySelector(':scope > [data-anime4k-overlay-host]');
      expect(hostOnBody).toBeDefined();

      manager.destroy();
    });

    it('host is initially a sibling of the video (before strategy detection)', () => {
      const video = createTestVideo();
      const manager = OverlayManager.create(video);

      // Before the 100ms strategy-detection timeout fires, the host
      // should be a direct sibling of the video, not on body
      const host = video.parentElement?.querySelector('[data-anime4k-overlay-host]');
      expect(host).toBeDefined();
      expect(host?.tagName).toBe('DIV');
      // Use :scope > to check only direct children of body (host is a grandchild)
      expect(document.body.querySelector(':scope > [data-anime4k-overlay-host]')).toBeNull();

      manager.destroy();
    });

    it('stays on sibling strategy when button is visible at point', () => {
      const video = createTestVideo();
      const manager = OverlayManager.create(video);

      // Make elementFromPoint return the button so strategy stays sibling
      const button = manager.getButton();
      elementFromPointMock.mockImplementation(() => button);

      // Fire the 100ms strategy detection timeout
      vi.advanceTimersByTime(200);

      // Host should still be a sibling of the video, NOT a direct child of body
      const host = video.parentElement?.querySelector('[data-anime4k-overlay-host]');
      expect(host).toBeDefined();
      expect(document.body.querySelector(':scope > [data-anime4k-overlay-host]')).toBeNull();

      manager.destroy();
    });
  });

  // ── Fullscreen handling ───────────────────────────────────────
  describe('fullscreen handling', () => {
    it('moves host into fullscreen element when video goes fullscreen (body strategy)', () => {
      const video = createTestVideo();
      elementFromPointMock.mockReturnValue(document.createElement('div'));
      const manager = OverlayManager.create(video);
      vi.advanceTimersByTime(200); // switch to body strategy

      // Create a fullscreen container
      const fsContainer = document.createElement('div');
      fsContainer.id = 'fullscreen-container';
      document.body.appendChild(fsContainer);
      fsContainer.appendChild(video);

      // Trigger fullscreen
      Object.defineProperty(document, 'fullscreenElement', {
        value: fsContainer,
        configurable: true,
      });

      // Trigger the fullscreenchange event
      document.dispatchEvent(new Event('fullscreenchange'));

      // Host should be inside the fullscreen container
      const host = fsContainer.querySelector('[data-anime4k-overlay-host]');
      expect(host).toBeDefined();

      manager.destroy();
    });
  });

  // ── Button show-initially behavior ────────────────────────────
  describe('button show-initially', () => {
    it('adds show-initially class on first position update', () => {
      const video = createTestVideo();
      const manager = OverlayManager.create(video);

      const button = manager.getButton();
      expect(button.classList.contains('show-initially')).toBe(true);

      manager.destroy();
    });

    it('removes show-initially class after 3 seconds', () => {
      const video = createTestVideo();
      const manager = OverlayManager.create(video);

      const button = manager.getButton();
      expect(button.classList.contains('show-initially')).toBe(true);

      // Advance past the 3s hide timeout
      vi.advanceTimersByTime(3100);

      expect(button.classList.contains('show-initially')).toBe(false);

      manager.destroy();
    });
  });

  // ── Position update edge cases ────────────────────────────────
  describe('position update', () => {
    it('hides host when video has zero dimensions', () => {
      const video = createTestVideo();
      // Override dimensions to zero
      Object.defineProperty(video, 'offsetWidth', { value: 0, configurable: true });
      Object.defineProperty(video, 'offsetHeight', { value: 0, configurable: true });

      const manager = OverlayManager.create(video);

      const host = video.parentElement?.querySelector('[data-anime4k-overlay-host]') as HTMLElement;
      expect(host.style.display).toBe('none');

      manager.destroy();
    });

    it('shows host when video has dimensions', () => {
      const video = createTestVideo();
      const manager = OverlayManager.create(video);

      const host = video.parentElement?.querySelector('[data-anime4k-overlay-host]') as HTMLElement;
      expect(host.style.display).not.toBe('none');

      manager.destroy();
    });
  });
});
