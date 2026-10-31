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
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    cleanupDom();
  });

  // ── create() ──────────────────────────────────────────────────
  describe('create()', () => {
    it('appends the host to body', () => {
      const video = createTestVideo();
      const manager = OverlayManager.create(video);

      const host = document.body.querySelector(':scope > [data-anime4k-overlay-host]');
      expect(host).toBeDefined();
      expect(host?.tagName).toBe('DIV');
      expect(video.parentElement?.querySelector('[data-anime4k-overlay-host]')).toBeNull();

      manager.destroy();
    });

    it('removes orphaned overlay hosts from the parent on create', () => {
      const video = createTestVideo();

      // Pre-create an orphaned host
      const orphan = document.createElement('div');
      orphan.setAttribute('data-anime4k-overlay-host', '');
      video.parentElement!.appendChild(orphan);

      const removeSpy = vi.spyOn(orphan, 'remove');

      const manager = OverlayManager.create(video);

      expect(removeSpy).toHaveBeenCalled();
      manager.destroy();
    });

    it('leaves body-attached hosts alone on create', () => {
      // Another video's live overlay is a body child; creating this one must
      // not remove it (both hosts share the same parent).
      const orphan = document.createElement('div');
      orphan.setAttribute('data-anime4k-overlay-host', '');
      document.body.appendChild(orphan);

      const removeSpy = vi.spyOn(orphan, 'remove');

      const video = createTestVideo();
      const manager = OverlayManager.create(video);

      expect(removeSpy).not.toHaveBeenCalled();
      manager.destroy();
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

      manager.destroy();
    });
  });

  // ── detach() ──────────────────────────────────────────────────
  describe('detach()', () => {
    it('removes the host from the DOM', () => {
      const video = createTestVideo();
      const manager = OverlayManager.create(video);

      const host = document.body.querySelector(':scope > [data-anime4k-overlay-host]');
      expect(host).toBeDefined();

      manager.detach();

      expect(document.body.querySelector(':scope > [data-anime4k-overlay-host]')).toBeNull();
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

      expect(document.body.querySelector(':scope > [data-anime4k-overlay-host]')).toBeNull();
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

    it('removes the global event listeners on destroy', () => {
      const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');
      const video = createTestVideo();
      const manager = OverlayManager.create(video);

      manager.destroy();

      expect(removeEventListenerSpy).toHaveBeenCalledWith('resize', expect.any(Function));
      expect(removeEventListenerSpy).toHaveBeenCalledWith('scroll', expect.any(Function), true);
    });
  });

  // ── reattach() ────────────────────────────────────────────────
  describe('reattach()', () => {
    it('re-attaches the host to body for the new video', () => {
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

      expect(document.body.querySelector(':scope > [data-anime4k-overlay-host]')).toBeDefined();
      expect(parent2.querySelector('[data-anime4k-overlay-host]')).toBeNull();
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

  // ── Body attachment ───────────────────────────────────────────
  describe('body attachment', () => {
    it('keeps the host click-through', () => {
      const video = createTestVideo();
      const manager = OverlayManager.create(video);

      const host = document.body.querySelector(':scope > [data-anime4k-overlay-host]') as HTMLElement;
      expect(host.style.pointerEvents).toBe('none');
      expect(host.style.position).toBe('absolute');

      manager.destroy();
    });

    it('debounces scroll events into a single position update', () => {
      const video = createTestVideo();
      const manager = OverlayManager.create(video);
      const proto = OverlayManager.prototype as unknown as { updatePosition: () => void };
      const updateSpy = vi.spyOn(proto, 'updatePosition');

      window.dispatchEvent(new Event('scroll'));
      window.dispatchEvent(new Event('scroll'));
      window.dispatchEvent(new Event('scroll'));

      // Coalesced into one rAF callback instead of running per scroll event.
      expect(updateSpy).not.toHaveBeenCalled();
      vi.advanceTimersByTime(0);
      expect(updateSpy).toHaveBeenCalledTimes(1);

      manager.destroy();
    });
  });

  // ── Fullscreen handling ───────────────────────────────────────
  describe('fullscreen handling', () => {
    it('moves host into fullscreen element when video goes fullscreen', () => {
      const video = createTestVideo();
      const manager = OverlayManager.create(video);

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

      const host = document.body.querySelector(':scope > [data-anime4k-overlay-host]') as HTMLElement;
      expect(host.style.display).toBe('none');

      manager.destroy();
    });

    it('shows host when video has dimensions', () => {
      const video = createTestVideo();
      const manager = OverlayManager.create(video);

      const host = document.body.querySelector(':scope > [data-anime4k-overlay-host]') as HTMLElement;
      expect(host.style.display).not.toBe('none');

      manager.destroy();
    });
  });
});
