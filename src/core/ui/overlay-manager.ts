import { ANIME4K_BUTTON_CLASS } from '@/constants';
import { t } from '@utils/i18n';

/**
 * OverlayManager
 * Module solely responsible for creating, managing, and destroying all UI elements associated with a specific video.
 * This includes the UI overlay (Host + Shadow DOM + Button) and the rendering target Canvas.
 */
export class OverlayManager {
  private video: HTMLVideoElement;
  private host: HTMLElement;
  private shadowRoot: ShadowRoot;
  private button: HTMLButtonElement;
  private canvas?: HTMLCanvasElement;
  private hideButtonTimeout?: number;

  private boundUpdatePosition: () => void;
  private boundHandleFullscreenChange: () => void;

  private resizeObserver: ResizeObserver;
  private mutationObserver: MutationObserver;
  private updatePositionRafId: number | null = null;
  private isFirstPositionUpdate = true;

  // Attribute name used to identify overlay host elements
  private static readonly HOST_MARKER_ATTR = 'data-anime4k-overlay-host';

  /**
   * Creates and returns an OverlayManager instance.
   * Includes defensive checks to prevent duplicate overlays for the same video.
   * @param video The target video element
   */
  public static create(video: HTMLVideoElement): OverlayManager {
    // Defensive check: clean up leftover hosts from an older build that sat
    // next to the video. Skip when the parent is <body>: hosts live there now,
    // so every sibling would be another video's live overlay.
    const parent = video.parentElement;
    if (parent && parent !== document.body) {
      const existingHosts = parent.querySelectorAll(`[${OverlayManager.HOST_MARKER_ATTR}]`);
      existingHosts.forEach(host => {
        console.warn('[Anime4KWebExt] Detected orphaned overlay host, removing:', host);
        host.remove();
      });
    }
    // No body-wide sweep: hosts live on body now, so it would delete the
    // overlays of other enhanced videos on the same page. Teardown paths
    // (detach/destroy) already remove their own host.

    return new OverlayManager(video);
  }

  private constructor(video: HTMLVideoElement) {
    this.video = video;

    // 1. Create Host element and attach it to body (viewport-anchored)
    this.host = document.createElement('div');
    this.host.setAttribute(OverlayManager.HOST_MARKER_ATTR, ''); // Add marker attribute for defensive checks
    this.host.style.position = 'absolute';
    this.host.style.pointerEvents = 'none'; // Don't intercept events by default
    this.host.style.zIndex = '2147483646'; // Slightly lower than the button
    document.body.appendChild(this.host);

    // 2. Create Shadow DOM
    this.shadowRoot = this.host.attachShadow({ mode: 'closed' });

    // 3. Create button and styles inside Shadow DOM
    this.button = this.createButtonInShadow();
    this.injectStyles();

    // 4. Initialize listeners (using rAF debounce to avoid layout thrashing)
    this.resizeObserver = new ResizeObserver(() => this.scheduleUpdatePosition());
    this.resizeObserver.observe(this.video);

    // Watch for style changes
    this.mutationObserver = new MutationObserver(() => this.scheduleUpdatePosition());
    this.mutationObserver.observe(this.video, {
      attributes: true,
      attributeFilter: ['style', 'class'],
    });

    // Global listeners: the host is body-attached, so track viewport and
    // fullscreen changes. All of them re-position through the rAF debounce.
    this.boundUpdatePosition = this.scheduleUpdatePosition.bind(this);
    this.boundHandleFullscreenChange = this.handleFullscreenChange.bind(this);
    window.addEventListener('resize', this.boundUpdatePosition);
    window.addEventListener('scroll', this.boundUpdatePosition, true);
    document.addEventListener('fullscreenchange', this.boundHandleFullscreenChange);

    // Execute immediately to determine initial position
    this.updatePosition();
  }

  /**
   * Uses requestAnimationFrame debouncing to schedule position updates,
   * avoiding layout thrashing caused by high-frequency ResizeObserver/MutationObserver triggers.
   */
  private scheduleUpdatePosition(): void {
    if (this.updatePositionRafId !== null) return;
    this.updatePositionRafId = requestAnimationFrame(() => {
      this.updatePositionRafId = null;
      this.updatePosition();
    });
  }

  /**
   * Uniformly update Host and Canvas positions
   */
  private updatePosition(): void {
    // Hide overlay when the video or the host itself left the DOM
    if (!this.host.isConnected || !this.video.isConnected || (this.video.offsetWidth === 0 && this.video.offsetHeight === 0)) {
      this.host.style.display = 'none';
      return;
    }
    this.host.style.display = ''; // Ensure visible

    const videoStyle = window.getComputedStyle(this.video);

    // Host is body-attached: use getBoundingClientRect for viewport-relative position
    const rect = this.video.getBoundingClientRect();
    const hostStyles: Record<string, string> = {
      top: `${rect.top + window.scrollY}px`,
      left: `${rect.left + window.scrollX}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      transform: videoStyle.transform,
      transformOrigin: videoStyle.transformOrigin,
    };

    // Update Host
    Object.assign(this.host.style, hostStyles);

    // If Canvas exists, update it synchronously
    if (this.canvas) {
      // Canvas is always a sibling of the video, so its positioning remains the same
      Object.assign(this.canvas.style, {
        top: `${this.video.offsetTop}px`,
        left: `${this.video.offsetLeft}px`,
        width: `${this.video.offsetWidth}px`,
        height: `${this.video.offsetHeight}px`,
        transform: videoStyle.transform,
        transformOrigin: videoStyle.transformOrigin,
        position: 'absolute',
        objectFit: videoStyle.objectFit,
        objectPosition: videoStyle.objectPosition,
        zIndex: videoStyle.zIndex,
      });
    }

    // Only show button briefly on the first position update (avoid flashing on every resize)
    if (this.isFirstPositionUpdate) {
      this.isFirstPositionUpdate = false;
      this.button.classList.add('show-initially');
      this.hideButtonTimeout = window.setTimeout(() => {
        this.button.classList.remove('show-initially');
      }, 3000);
    }
  }

  private handleFullscreenChange(): void {
    const fullscreenElement = document.fullscreenElement;
    // When video enters fullscreen, move Host into the fullscreen element to ensure it's visible
    if (fullscreenElement && fullscreenElement.contains(this.video)) {
      fullscreenElement.appendChild(this.host);
    } else if (this.host.parentElement !== document.body) {
      // When exiting fullscreen, move Host back to body
      document.body.appendChild(this.host);
    }
    // Update position after the DOM structure change
    this.scheduleUpdatePosition();
  }

  /**
   * Returns the button element in the Shadow DOM
   */
  public getButton(): HTMLButtonElement {
    return this.button;
  }

  /**
   * Creates (if not exists) and returns a Canvas element without attaching it to the DOM.
   * @returns {HTMLCanvasElement}
   */
  public getCanvas(): HTMLCanvasElement {
    if (this.canvas) {
      return this.canvas;
    }

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.video.videoWidth;
    this.canvas.height = this.video.videoHeight;
    this.canvas.style.pointerEvents = 'none';
    // Initially invisible, showCanvas is responsible for displaying
    this.canvas.style.visibility = 'hidden';
    return this.canvas;
  }

  /**
   * Attaches the created Canvas to the DOM and makes it visible.
   */
  public showCanvas(): void {
    if (!this.canvas) {
      // In theory getCanvas should be called first, but as a safety measure we also create it here
      this.getCanvas();
    }

    // Ensure canvas is in the DOM
    const canvas = this.canvas;
    if (!canvas) return;
    if (!canvas.parentElement) {
      this.video.parentElement?.insertBefore(canvas, this.video);
    }

    this.updatePosition(); // Update position and size
    canvas.style.visibility = 'visible'; // Make visible
    this.video.style.opacity = '0'; // Hide original video
  }

  /**
   * Hide and destroy the Canvas.
   */
  public hideCanvas(): void {
    this.canvas?.remove();
    this.canvas = undefined;
    this.video.style.opacity = ''; // Restore original video
  }

  /**
   * Detach UI
   * Remove all UI elements from the DOM but keep their instances for subsequent reattachment.
   * This prevents the issue of multiple overlays caused by residual hosts under the body strategy.
   */
  public detach(): void {
    this.host.remove();
    if (this.canvas) {
      this.canvas.remove();
    }
    // The canvas that covered the video is gone, so the original video must be
    // made visible again. Otherwise the element stays at opacity 0 with no
    // canvas on top, leaving a permanently black video.
    this.video.style.opacity = '';
  }

  /**
   * Reattach to a new video element
   * @param newVideo The new video element
   */
  public reattach(newVideo: HTMLVideoElement): void {
    this.resizeObserver.disconnect();
    this.mutationObserver.disconnect();

    this.video = newVideo;

    // Re-insert host into the DOM (removed during detach)
    document.body.appendChild(this.host);

    if (this.canvas) {
      newVideo.parentElement?.insertBefore(this.canvas, this.video);
    }

    this.resizeObserver.observe(newVideo);
    this.mutationObserver.observe(newVideo, {
      attributes: true,
      attributeFilter: ['style', 'class'],
    });

    this.updatePosition();
  }

  /**
   * Destroy instance and clean up all resources.
   */
  public destroy(): void {
    this.resizeObserver.disconnect();
    this.mutationObserver.disconnect();
    if (this.updatePositionRafId !== null) {
      cancelAnimationFrame(this.updatePositionRafId);
      this.updatePositionRafId = null;
    }
    this.host.remove();
    this.hideCanvas();

    // Global listeners are always registered (host is body-attached)
    window.removeEventListener('resize', this.boundUpdatePosition);
    window.removeEventListener('scroll', this.boundUpdatePosition, true);
    document.removeEventListener('fullscreenchange', this.boundHandleFullscreenChange);

    if (this.hideButtonTimeout) {
      clearTimeout(this.hideButtonTimeout);
    }
  }

  // --- Private helper methods ---

  private createButtonInShadow(): HTMLButtonElement {
    const button = document.createElement('button');
    button.innerText = t('enhanceButton');
    button.classList.add(ANIME4K_BUTTON_CLASS);
    button.part = 'button'; // Expose to external styles (if needed)
    this.shadowRoot.appendChild(button);
    return button;
  }

  private injectStyles(): void {
    const style = document.createElement('style');
    style.textContent = `
      :host {
        pointer-events: none;
      }
      
      .${ANIME4K_BUTTON_CLASS} {
        position: absolute;
        top: 50%;
        left: 10px;
        transform: translateY(-50%);
        z-index: 2147483647;
        padding: 8px 12px;
        opacity: 0;
        transition: opacity 0.3s ease-in-out;
        background-color: #6A0DAD;
        color: white;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 14px;
        box-shadow: 0 2px 5px rgba(0,0,0,0.2);
        pointer-events: auto; /* Make the button clickable */
        isolation: isolate;
      }

      .${ANIME4K_BUTTON_CLASS}.show-initially {
        opacity: 1;
      }

      .${ANIME4K_BUTTON_CLASS}:hover {
        opacity: 1 !important;
      }
    `;
    this.shadowRoot.appendChild(style);
  }

}