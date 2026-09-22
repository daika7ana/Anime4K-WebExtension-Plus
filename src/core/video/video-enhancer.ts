import { getSettings, getEffectsForMode, getLocalSettings } from '@utils/settings';
import { sendMessage } from '@utils/messaging';
import { t } from '@utils/i18n';
import { Renderer } from '@core/renderer';
import { ANIME4K_APPLIED_ATTR } from '@/constants';
import { Dimensions, Anime4KWebExtSettings, EnhancementMode, EnhancementEffect, ColorGradingSettings } from '@/types';
import { OverlayManager } from '@core/ui/overlay-manager';
import { DiagnosticsOverlay, type DiagnosticsInfo } from '@core/ui/diagnostics-overlay';
import { yieldToAnimationFrame } from '@core/utils/yield-utils';
import { waitForMediaEvent } from '@core/utils/media-events';

/** Debounce delay before reacting to monitor size / DPR changes. */
const DISPLAY_RESIZE_DEBOUNCE_MS = 200;

/** Upscale multipliers for the `x2`/`x4`/`x8` resolution settings. */
const RESOLUTION_MULTIPLIERS: Record<string, number> = { 'x2': 2, 'x4': 4, 'x8': 8 };

/** Fixed output sizes for the named resolution settings. */
const FIXED_RESOLUTIONS: Record<string, Dimensions> = {
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '2k': { width: 2560, height: 1440 },
  '4k': { width: 3840, height: 2160 },
};

/** Hard cap to keep render textures from growing large enough to OOM. */
const MAX_WIDTH = 7680;
const MAX_HEIGHT = 4320;

/** Built-in modes are Anime4K presets; custom modes report simply as "Custom". */
function getDiagnosticsModeLabel(mode: EnhancementMode): string {
  return mode.isBuiltIn ? mode.name : t('diagnosticsCustomMode', 'Custom');
}

/** Format a resolution pair for the diagnostics HUD; em dash when unknown. */
function formatResolution(width: number, height: number): string {
  return width > 0 && height > 0 ? `${width}×${height}` : '--';
}

/**
 * Video enhancer class that encapsulates Anime4K processing logic.
 * Manages the enhancement state, renderer instance, and resource cleanup for a single video element.
 */
export class VideoEnhancer {
  private renderer: Renderer | null = null;
  private currentModeId: string | null = null;
  private overlay: OverlayManager;
  private button: HTMLButtonElement;
  private diagnosticsOverlay: DiagnosticsOverlay | null = null;
  /**
   * Fallback pipeline count (selected-effect count) used by the diagnostics
   * overlay when the renderer does not supply its authoritative staged count.
   */
  private currentPipelineCount = 0;

  /** The resolution setting the renderer is currently configured with. */
  private activeResolutionSetting: string | null = null;
  /** Whether the monitor size / DPR listeners are currently attached. */
  private displayListenersAttached = false;
  private resizeDebounceTimer: number | null = null;
  private dprMediaQuery: MediaQueryList | null = null;

  /** Stable handler reference so listeners can be removed cleanly. */
  private readonly onDisplayResize = (): void => {
    this.scheduleDisplayResize();
  };

  /**
   * Refreshes the HUD's input-resolution row when the current video's metadata
   * changes. Never reconfigures the renderer — display only.
   */
  private readonly onVideoMetadataLoaded = (): void => {
    this.diagnosticsOverlay?.setInfo({
      inputResolution: formatResolution(this.video.videoWidth, this.video.videoHeight),
    });
  };

  private constructor(private video: HTMLVideoElement) {
    this.overlay = OverlayManager.create(this.video);
    this.button = this.overlay.getButton();
    this.video.addEventListener('loadedmetadata', this.onVideoMetadataLoaded);
    this.initUI();
  }

  /**
   * Creates and initializes a new VideoEnhancer instance.
   * This is the recommended instantiation method.
   */
  public static create(video: HTMLVideoElement): VideoEnhancer {
    return new VideoEnhancer(video);
  }

  /**
   * Initializes UI components and event listeners
   */
  private initUI(): void {
    this.button.onclick = (e) => {
      e.stopPropagation();
      this.toggleEnhancement();
    };
  }

  private fixAttempted = false;
  private initializing = false;
  /** Terminal lifecycle flag: once destroyed, the enhancer never acts again. */
  private destroyed = false;

  /**
   * Checks and fixes cross-origin issues with the video.
   * @param isFallback - Whether this is called as a fallback after an error
   * @returns {Promise<void>}
   */
  private async fixCrossOrigin(isFallback = false): Promise<void> {
    console.log(`[Anime4KWebExt] Executing cross-origin fix. Is fallback: ${isFallback}`);
    this.fixAttempted = true;
    this.video.crossOrigin = 'anonymous';

    const currentTime = this.video.currentTime;
    const originalSrc = this.video.src;
    const isPaused = this.video.paused;

    // Listener attached before the reload; the bounded helper owns the timeout
    // and the error path, so this can never hang.
    const ready = waitForMediaEvent(
      this.video,
      'canplay',
      new Error(t('videoNotReady', "Video isn't ready. Start playback, then try again.")),
    );

    this.video.src = '';
    this.video.src = originalSrc;
    this.video.load();

    await ready;
    this.video.currentTime = currentTime;
    if (!isPaused) {
      this.video.play().catch(e => console.warn('[Anime4KWebExt] Autoplay after reload was blocked.', e));
    }
    console.log('[Anime4KWebExt] Video reloaded successfully with crossOrigin attribute.');
  }

  /**
   * Toggles the video enhancement on/off
   */
  async toggleEnhancement(): Promise<void> {
    if (this.destroyed) return;

    if (this.renderer) {
      console.log('[Anime4KWebExt] Disabling video enhancement.');
      this.disableEnhancement();
      return;
    }

    if (this.initializing) return;
    this.initializing = true;

    this.button.innerText = t('enhancing');
    this.button.disabled = true;
    this.fixAttempted = false; // Reset the fix attempt flag

    // Defer heavy initialization to the next animation frame so the browser can
    // repaint the "Enhancing..." button text before any blocking GPU work begins.
    await yieldToAnimationFrame();
    if (this.destroyed) {
      this.initializing = false;
      return;
    }

    const settings = await getSettings();
    if (this.destroyed) {
      this.initializing = false;
      return;
    }

    try {
      if (settings.enableCrossOriginFix) {
        // --- First line of defense: proactive check ---
        const videoUrl = this.video.src;
        if (videoUrl && videoUrl.startsWith('http') && !this.video.crossOrigin) {
          try {
            const videoOrigin = new URL(videoUrl).origin;
            if (videoOrigin !== window.location.origin) {
              console.log('[Anime4KWebExt] Proactive check: Cross-origin video detected. Applying fix...');
              await this.fixCrossOrigin();
            }
          } catch (e) {
            console.warn('[Anime4KWebExt] Could not parse video src URL for proactive check.', e);
          }
        }
      }

      // --- Core operation ---
      await this.initRenderer();
      if (this.destroyed) {
        this.initializing = false;
        return;
      }
      this.video.setAttribute(ANIME4K_APPLIED_ATTR, 'true');
      this.button.innerText = t('cancelEnhance');

    } catch (error) {
      if (this.destroyed) return;
      const err = error as Error;
      const isCrossOriginError = err.name === 'SecurityError' && err.message.includes('tainted');

      if (isCrossOriginError && settings.enableCrossOriginFix && !this.fixAttempted) {
        // --- Second line of defense: error fallback ---
        console.warn('[Anime4KWebExt] Fallback: Caught a SecurityError. Attempting to fix and retry...');
        try {
          await this.fixCrossOrigin();
          await this.initRenderer(); // Retry
          if (this.destroyed) return;
          this.video.setAttribute(ANIME4K_APPLIED_ATTR, 'true');
          this.button.innerText = t('cancelEnhance');
        } catch (retryError) {
          if (this.destroyed) return;
          console.error('[Anime4KWebExt] Enhancer failed even after retry:', retryError);
          this.disableEnhancement();
          this.showErrorModal((retryError as Error).message || t('enhanceError'));
        }
      } else if (isCrossOriginError && !settings.enableCrossOriginFix) {
        // --- User prompt ---
        console.warn('[Anime4KWebExt] Cross-origin error detected, but fix is disabled. Prompting user.');
        this.disableEnhancement();
          this.showErrorModal(t('crossOriginHint', 'Enhancement failed due to cross-origin restrictions. Please enable Compatibility Mode in the options.'), true);
      } else {
        // --- Other errors ---
        console.error('[Anime4KWebExt] Failed to initialize enhancer:', err);
        this.disableEnhancement();
        this.showErrorModal(err.message || t('enhanceError'));
      }
    } finally {
      this.initializing = false;
      this.button.disabled = false;
    }
  }


  /**
   * Initializes the renderer, including loading settings, loading modules, and creating the Renderer instance
   */
  private async initRenderer(): Promise<void> {
    if (this.destroyed) return;

    // Detect DRM-protected content early (EME sets mediaKeys on the video element)
    if (this.video.mediaKeys) {
      throw new Error('DRM detected. Video enhancement is not supported for DRM-protected content.');
    }

    // Ensure metadata is loaded before initializing the renderer
    if (this.video.readyState < 1) { // HAVE_METADATA
      this.button.innerText = t('waitingVideoLoad', '⏳ Waiting for video...');
      await waitForMediaEvent(
        this.video,
        'loadedmetadata',
        new Error(t('videoNotReady', "Video isn't ready. Start playback, then try again.")),
      );
    }

    if (this.destroyed) return;

    if (!navigator.gpu) {
      throw new Error('WebGPU is not supported on this browser.');
    }

    const settings = await getSettings();

    const { selectedModeId, enhancementModes, targetResolutionSetting } = settings;
    const selectedMode =
      enhancementModes.find((m: EnhancementMode) => m.id === selectedModeId)
      ?? enhancementModes.find((m: EnhancementMode) => m.isBuiltIn);
    if (!selectedMode) {
      throw new Error('No valid enhancement mode found');
    }
    this.currentModeId = selectedMode.id;

    const targetDimensions = this.calculateTargetDimensions(
      this.video.videoWidth,
      this.video.videoHeight,
      targetResolutionSetting
    );

    const canvas = this.overlay.getCanvas();
    canvas.width = targetDimensions.width;
    canvas.height = targetDimensions.height;

    // Get the actual effect chain based on mode and performance tier
    const baseEffects = getEffectsForMode(selectedMode, settings.performanceTier);
    const effects = this.getEffectsWithColorGrading(baseEffects, settings.colorGrading);

    // Store the selected-effect count as a diagnostics fallback.
    this.currentPipelineCount = effects.length;

    // Create diagnostics overlay if enabled in local settings
    const localSettings = await getLocalSettings();
    if (this.destroyed) return;
    const showDiagnostics = localSettings.showDiagnostics;
    if (showDiagnostics) {
      const adapterInfo = await this.getAdapterInfo();
      // destroy() may have landed during the adapter probe. Never attach a
      // diagnostics overlay to a torn-down enhancer.
      if (this.destroyed) return;
      const diagnosticsInfo: DiagnosticsInfo = {
        mode: getDiagnosticsModeLabel(selectedMode),
        performanceTier: settings.performanceTier,
        inputResolution: formatResolution(this.video.videoWidth, this.video.videoHeight),
        targetResolution: formatResolution(targetDimensions.width, targetDimensions.height),
        restorePolicy: localSettings.restorePolicy ?? 'gate',
      };
      this.diagnosticsOverlay = DiagnosticsOverlay.create(
        this.video,
        adapterInfo,
        diagnosticsInfo,
        localSettings.diagnosticsDetail ?? 'auto',
      );
      this.diagnosticsOverlay.show();
    }

    const renderer = await Renderer.create({
      video: this.video,
      canvas: canvas,
      effects: effects,
      targetDimensions,
      // GPU timings are only collected while the diagnostics overlay is shown.
      enableGpuTimings: showDiagnostics,
      // Restore-pass policy. Defaults to 'gate' (keep every restore, local-luma
      // gating each one); the value applies to all modes, built-in and custom.
      restorePolicy: localSettings.restorePolicy ?? 'gate',
      onError: async (error: Error) => {
        // A destroyed enhancer has no live UI/resources; never surface errors or
        // re-run teardown for it (e.g. a frame failing after the element was removed).
        if (this.destroyed) return;
        console.error('[Anime4KWebExt] Renderer runtime error:', error);
        const isCrossOriginError = error.name === 'SecurityError' && error.message.includes('tainted');
        const isDrmError = error.message.includes('DRM') || error.message.includes('copy protection');
        const settings = await getSettings();

        // State can change across the await (the element may be removed meanwhile).
        if (this.destroyed) return;

        if (isDrmError) {
          this.showErrorModal('This video uses DRM copy protection. Video enhancement is not supported for DRM-protected content.');
        } else if (isCrossOriginError && !settings.enableCrossOriginFix) {
        this.showErrorModal(t('crossOriginHint', 'Enhancement failed due to cross-origin restrictions. Please enable Compatibility Mode in the options.'), true);
        } else {
          this.showErrorModal(t('renderError', 'A rendering error occurred.'));
        }
        this.disableEnhancement();
      },
      onFirstFrameRendered: () => {
        this.overlay.showCanvas();
      },
      onProgress: (stage: string | null) => {
        if (stage === null) {
          // Warmup complete, restore button text
          this.button.innerText = t('cancelEnhance');
        } else {
          this.button.innerText = stage;
        }
      },
      onFrameRendered: (frameTime, snapshot, pipelineCount) => {
        // The renderer reports the number of actually-built GPU stages; fall back
        // to the selected-effect count when the renderer argument is unavailable.
        this.diagnosticsOverlay?.update(frameTime, pipelineCount ?? this.currentPipelineCount, snapshot);
      },
    });

    if (this.destroyed) {
      renderer.destroy();
      return;
    }
    this.renderer = renderer;

    // Track the active resolution setting and attach monitor/DPR listeners when
    // the target follows the monitor display size.
    if (!this.destroyed) {
      this.updateDisplayResizeListeners(targetResolutionSetting);
    }

    console.log(`[Anime4KWebExt] Renderer initialized with mode: ${selectedMode.name}`);
  }

  /**
   * Updates the renderer with new settings.
   * This is much more efficient than a full reinitialization.
   * @param newSettings - The latest settings object
   */
  public async updateSettings(newSettings: Anime4KWebExtSettings): Promise<void> {
    if (!this.renderer) return;
    // Capture the renderer identity so the awaits below can detect a teardown:
    // destroy() nulls this.renderer via releaseWebGPUResources().
    const renderer = this.renderer;

    console.log('[Anime4KWebExt] Updating renderer with new settings...');
    const { selectedModeId, enhancementModes, targetResolutionSetting } = newSettings;
    const selectedMode =
      enhancementModes.find((m: EnhancementMode) => m.id === selectedModeId)
      ?? enhancementModes.find((m: EnhancementMode) => m.isBuiltIn);
    if (!selectedMode) {
      throw new Error('No valid enhancement mode found');
    }

    const newTargetDimensions = this.calculateTargetDimensions(
      this.video.videoWidth,
      this.video.videoHeight,
      targetResolutionSetting
    );

    // If the target dimensions have changed, update the canvas size. This must be done before calling the renderer update.
    const canvas = this.overlay.getCanvas();
    if (newTargetDimensions.width !== canvas.width || newTargetDimensions.height !== canvas.height) {
      console.log(`[Anime4KWebExt] Target resolution changed, resizing canvas to ${newTargetDimensions.width}x${newTargetDimensions.height}.`);
      canvas.width = newTargetDimensions.width;
      canvas.height = newTargetDimensions.height;
    }

    // Get the actual effect chain based on mode and performance tier
    const baseEffects = getEffectsForMode(selectedMode, newSettings.performanceTier);
    const effects = this.getEffectsWithColorGrading(baseEffects, newSettings.colorGrading);

    // Local prefs (restore policy) are applied at build time; read them
    // before the configuration update so a policy change is detected and the
    // chain rebuilds.
    const localSettings = await getLocalSettings();

    // State can change across the await: destroy() releases the renderer, while
    // a disable/enable cycle replaces it. Bail rather than dereferencing a
    // nulled or stale instance.
    if (this.destroyed || this.renderer !== renderer) return;

    // Call the renderer's unified configuration update method, which intelligently handles changes
    await renderer.updateConfiguration({
      effects: effects,
      targetDimensions: newTargetDimensions,
      restorePolicy: localSettings.restorePolicy ?? 'gate',
    });

    // The renderer may have been torn down while updateConfiguration() was in
    // flight; do not mutate enhancer state or touch the diagnostics overlay.
    if (this.destroyed || this.renderer !== renderer) return;

    this.currentModeId = selectedMode.id;
    this.updateDisplayResizeListeners(targetResolutionSetting);
    console.log(`[Anime4KWebExt] Renderer updated to mode: ${selectedMode.name}`);

    // Update the diagnostics fallback count
    this.currentPipelineCount = effects.length;

    const diagnosticsInfo: DiagnosticsInfo = {
      mode: getDiagnosticsModeLabel(selectedMode),
      performanceTier: newSettings.performanceTier,
      inputResolution: formatResolution(this.video.videoWidth, this.video.videoHeight),
      targetResolution: formatResolution(newTargetDimensions.width, newTargetDimensions.height),
      restorePolicy: localSettings.restorePolicy ?? 'gate',
    };

    // Handle diagnostics overlay toggle (localSettings read above)
    if (localSettings.showDiagnostics) {
      if (!this.diagnosticsOverlay) {
        const adapterInfo = await this.getAdapterInfo();
        // destroy() may have landed during the adapter probe; never re-create
        // a diagnostics overlay on a torn-down enhancer.
        if (this.destroyed || this.renderer !== renderer) return;
        this.diagnosticsOverlay = DiagnosticsOverlay.create(
          this.video,
          adapterInfo,
          diagnosticsInfo,
          localSettings.diagnosticsDetail ?? 'auto',
        );
        this.diagnosticsOverlay.show();
      } else {
        this.diagnosticsOverlay.setDetailMode(localSettings.diagnosticsDetail ?? 'auto');
        this.diagnosticsOverlay.setInfo(diagnosticsInfo);
      }
    } else if (this.diagnosticsOverlay) {
      this.diagnosticsOverlay.destroy();
      this.diagnosticsOverlay = null;
    }
  }

  /**
   * Reapplies enhancement with fresh settings.
   * Performs a clean disable-then-enable cycle to ensure all old filters are removed and new ones applied.
   */
  public async reapply(): Promise<void> {
    if (!this.renderer) return;

    console.log('[Anime4KWebExt] Reapplying enhancement with fresh settings...');
    this.disableEnhancement();
    await this.toggleEnhancement();
  }

  /**
   * Calculates the target rendering dimensions (capped at 8K to prevent OOM)
   */
  private calculateTargetDimensions(videoWidth: number, videoHeight: number, resolutionSetting: string): Dimensions {
    if (resolutionSetting === 'display') {
      return this.calculateDisplayDimensions(videoWidth, videoHeight);
    }

    let width: number;
    let height: number;

    if (RESOLUTION_MULTIPLIERS[resolutionSetting]) {
      width = videoWidth * RESOLUTION_MULTIPLIERS[resolutionSetting];
      height = videoHeight * RESOLUTION_MULTIPLIERS[resolutionSetting];
    } else if (FIXED_RESOLUTIONS[resolutionSetting]) {
      return FIXED_RESOLUTIONS[resolutionSetting];
    } else {
      return { width: videoWidth, height: videoHeight };
    }

    return this.clampToMaxResolution(width, height);
  }

  /**
   * Computes the render target that maps to the monitor's pixels.
   *
   * This is intentionally based on the monitor rather than the video element's
   * on-screen box: the player can be windowed (smaller than the monitor) or
   * fullscreen, and sizing to the player would render a small texture that the
   * browser then blurs on upscale. Targeting the monitor keeps the texture
   * constant and sharp — the browser downscales it for smaller players and it
   * is 1:1 in fullscreen.
   *
   * Uses window.screen.width/height as the reference box (falling back to the
   * viewport), fits the source aspect ratio into it, then scales by the device
   * pixel ratio.
   */
  private calculateDisplayDimensions(videoWidth: number, videoHeight: number): Dimensions {
    const dpr = window.devicePixelRatio || 1;

    // Reference box in CSS pixels: the monitor. Fall back to the viewport when
    // screen dimensions are unavailable or invalid (e.g. jsdom, odd hosts).
    let boxWidth = window.screen?.width ?? 0;
    let boxHeight = window.screen?.height ?? 0;
    if (boxWidth <= 0 || boxHeight <= 0) {
      boxWidth = window.innerWidth || 0;
      boxHeight = window.innerHeight || 0;
    }

    // Never create a zero-sized texture: fall back to the source dimensions.
    if (boxWidth <= 0 || boxHeight <= 0 || videoWidth <= 0 || videoHeight <= 0) {
      return { width: videoWidth, height: videoHeight };
    }

    // The target is fitted into the reference box with the source aspect ratio
    // preserved, mirroring how the video is letterboxed with object-fit: contain.
    const srcAspect = videoWidth / videoHeight;
    let contentWidth: number;
    let contentHeight: number;
    if (boxWidth / boxHeight > srcAspect) {
      // Box is wider than the source: pillarboxed, height is the constraint.
      contentHeight = boxHeight;
      contentWidth = boxHeight * srcAspect;
    } else {
      // Box is taller than the source: letterboxed, width is the constraint.
      contentWidth = boxWidth;
      contentHeight = boxWidth / srcAspect;
    }

    // Map CSS pixels to device pixels and round down to an even integer
    // (texture-friendly alignment), flooring at 2.
    let width = Math.round(contentWidth * dpr);
    let height = Math.round(contentHeight * dpr);
    width = Math.max(2, width - (width % 2));
    height = Math.max(2, height - (height % 2));

    return this.clampToMaxResolution(width, height);
  }

  /**
   * Caps a render target at 8K to prevent textures from being too large and
   * causing OOM, preserving the aspect ratio.
   */
  private clampToMaxResolution(width: number, height: number): Dimensions {
    if (width > MAX_WIDTH || height > MAX_HEIGHT) {
      const scale = Math.min(MAX_WIDTH / width, MAX_HEIGHT / height);
      width = Math.floor(width * scale);
      height = Math.floor(height * scale);
    }

    return { width, height };
  }

  /**
   * Keeps the monitor-size listeners in sync with the active resolution
   * setting. They are only attached while the target is 'display'.
   */
  private updateDisplayResizeListeners(resolutionSetting: string): void {
    this.activeResolutionSetting = resolutionSetting;
    if (resolutionSetting === 'display') {
      this.attachDisplayResizeListeners();
    } else {
      this.detachDisplayResizeListeners();
    }
  }

  /**
   * Attaches the window-resize and DPR listeners used to follow monitor
   * changes (browser zoom, monitor switch). Idempotent, so repeated calls do
   * not double-register.
   */
  private attachDisplayResizeListeners(): void {
    if (this.displayListenersAttached) return;
    this.displayListenersAttached = true;

    window.addEventListener('resize', this.onDisplayResize);
    this.armDprWatcher();
  }

  /**
   * Removes every monitor-size listener and clears any pending debounce.
   */
  private detachDisplayResizeListeners(): void {
    if (!this.displayListenersAttached) return;
    this.displayListenersAttached = false;

    window.removeEventListener('resize', this.onDisplayResize);
    this.disarmDprWatcher();

    if (this.resizeDebounceTimer !== null) {
      clearTimeout(this.resizeDebounceTimer);
      this.resizeDebounceTimer = null;
    }
  }

  /**
   * Watches for device-pixel-ratio changes (monitor switch, browser zoom).
   */
  private armDprWatcher(): void {
    if (typeof window.matchMedia !== 'function') return;
    const dpr = window.devicePixelRatio || 1;
    this.dprMediaQuery = window.matchMedia(`(resolution: ${dpr}dppx)`);
    this.dprMediaQuery.addEventListener('change', this.onDisplayResize);
  }

  /**
   * Re-creates the DPR watcher against the current ratio. Used after a change
   * so the media query tracks the new value.
   */
  private rearmDprWatcher(): void {
    if (!this.displayListenersAttached) return;
    this.disarmDprWatcher();
    this.armDprWatcher();
  }

  private disarmDprWatcher(): void {
    if (this.dprMediaQuery) {
      this.dprMediaQuery.removeEventListener('change', this.onDisplayResize);
      this.dprMediaQuery = null;
    }
  }

  /**
   * Debounces resize events, coalescing bursts (e.g. while dragging/fullscreen)
   * into a single recompute. No work is scheduled when enhancement is inactive.
   */
  private scheduleDisplayResize(): void {
    if (!this.renderer || this.activeResolutionSetting !== 'display') return;

    if (this.resizeDebounceTimer !== null) {
      clearTimeout(this.resizeDebounceTimer);
    }

    this.resizeDebounceTimer = window.setTimeout(() => {
      this.resizeDebounceTimer = null;
      // A DPR change may not emit a window resize; re-check it here too.
      this.rearmDprWatcher();
      void this.applyDisplayResize();
    }, DISPLAY_RESIZE_DEBOUNCE_MS);
  }

  /**
   * Recomputes the display-sized target and, only when it actually changed,
   * resizes the canvas and reconfigures the renderer.
   */
  private async applyDisplayResize(): Promise<void> {
    if (!this.renderer || this.activeResolutionSetting !== 'display') return;

    const dimensions = this.calculateTargetDimensions(
      this.video.videoWidth,
      this.video.videoHeight,
      'display'
    );

    const canvas = this.overlay.getCanvas();
    if (dimensions.width === canvas.width && dimensions.height === canvas.height) {
      return; // Unchanged dimensions: skip the costly pipeline rebuild.
    }

    // Mirror updateSettings() so the effect chain stays consistent.
    const settings = await getSettings();
    await this.updateSettings(settings);
  }

  /**
   * Appends a ColorAdjust effect to the end of the effect chain when color grading is enabled.
   * Color grading is always applied last (after all enhancement effects).
   */
  private getEffectsWithColorGrading(
    effects: EnhancementEffect[],
    colorGrading: ColorGradingSettings | undefined,
  ): EnhancementEffect[] {
    if (!colorGrading?.enabled) return effects;
    return [...effects, {
      id: 'anime4k/ColorGrading/ColorAdjust',
      name: 'Color Grading',
      className: 'ColorAdjust',
      params: {
        brightness: colorGrading.brightness,
        gamma: colorGrading.gamma,
        contrast: colorGrading.contrast,
        saturation: colorGrading.saturation,
        vibrance: colorGrading.vibrance,
        exposure: colorGrading.exposure,
      },
    }];
  }

  /**
   * Gets the ID of the currently active mode
   */
  public getCurrentModeId(): string | null {
    return this.currentModeId;
  }

  public getVideoElement(): HTMLVideoElement {
    return this.video;
  }

  /**
   * Detach method
   */
  public detach(): void {
    console.log('[Anime4KWebExt] Detaching enhancer from video.');
    this.overlay.detach();
    // Remove the attribute since it is no longer "applied" to any DOM element at this point
    this.video.removeAttribute(ANIME4K_APPLIED_ATTR);
  }

  /**
   * Reattach method
   */
  public async reattach(newVideo: HTMLVideoElement): Promise<void> {
    if (this.destroyed) return;
    console.log('[Anime4KWebExt] Re-attaching enhancer to new video.');
    this.video.removeEventListener('loadedmetadata', this.onVideoMetadataLoaded);
    this.video = newVideo;
    this.video.addEventListener('loadedmetadata', this.onVideoMetadataLoaded);
    this.overlay.reattach(newVideo);

    // The monitor/DPR listeners are independent of the video element, so there
    // is nothing to re-point here.

    // Update the renderer
    if (this.renderer) {
      await this.renderer.updateVideoSource(newVideo);
      // Re-apply the attribute
      this.video.setAttribute(ANIME4K_APPLIED_ATTR, 'true');
    } else {
      this.disableEnhancement();
    }
  }

  /**
   * Destroys the entire enhancer instance (including UI elements and internal resources)
   */
  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    console.log('[Anime4KWebExt] Destroying enhancer instance:', this);
    this.disableEnhancement();
    this.video.removeEventListener('loadedmetadata', this.onVideoMetadataLoaded);
    this.overlay.destroy();
    console.log('[Anime4KWebExt] Enhancer destroyed')
  }

  /**
   * Disables video enhancement (releases resources and resets video state)
   */
  private disableEnhancement(): void {
    console.log('[Anime4KWebExt] disableEnhancement called. Current renderer:', this.renderer);
    console.log('[Anime4KWebExt] Video opacity before:', this.video.style.opacity);
    this.detachDisplayResizeListeners();
    this.activeResolutionSetting = null;
    if (this.diagnosticsOverlay) {
      this.diagnosticsOverlay.destroy();
      this.diagnosticsOverlay = null;
    }
    this.releaseWebGPUResources();
    this.overlay.hideCanvas();
    console.log('[Anime4KWebExt] Video opacity after hideCanvas:', this.video.style.opacity);
    this.video.removeAttribute(ANIME4K_APPLIED_ATTR);
    this.button.innerText = t('enhanceButton');
    this.currentModeId = null;
    console.log('[Anime4KWebExt] disableEnhancement completed.');
  }

  /**
   * Gets GPU adapter info string for diagnostics display.
   * Tries WebGPU adapter info first, then falls back to WebGL renderer info
   * when WebGPU info is unavailable (common with anti-fingerprinting hardening).
   */
  private async getAdapterInfo(): Promise<string> {
    // Try WebGPU adapter info first
    try {
      if (navigator.gpu) {
        const adapter = await navigator.gpu.requestAdapter();
        if (adapter) {
          const gpuAdapter = adapter as unknown as {
            requestAdapterInfo?: () => Promise<{ vendor: string; architecture: string; device: string; description: string }>
          };
          if (gpuAdapter.requestAdapterInfo) {
            const info = await gpuAdapter.requestAdapterInfo();
            const parts = [info.vendor, info.architecture, info.device]
              .filter(Boolean)
              .filter(s => s.length > 0);
            if (parts.length > 0) {
              return parts.join(' ');
            }
          }
        }
      }
    } catch {
      // Fall through to WebGL fallback
    }

    // Fallback: WebGL debug renderer info
    try {
      const canvas = document.createElement('canvas');
      const gl = (canvas.getContext('webgl2') || canvas.getContext('webgl')) as WebGLRenderingContext | null;
      if (gl) {
        const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
        if (debugInfo) {
          const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
          if (renderer && typeof renderer === 'string' && renderer.length > 0) {
            return renderer;
          }
        }
        // Last resort: standard RENDERER parameter
        const renderer = gl.getParameter(gl.RENDERER);
        if (renderer && typeof renderer === 'string' && renderer.length > 0 && renderer !== 'WebKit WebGL') {
          return renderer;
        }
      }
    } catch {
      // Fall through to default
    }

    return 'Unknown GPU';
  }

  /**
   * Releases WebGPU-related resources
   */
  private releaseWebGPUResources(): void {
    if (this.renderer) {
      console.log('[Anime4KWebExt] Releasing WebGPU resources. Entering release block.');
      try {
        this.renderer.destroy();
        console.log('[Anime4KWebExt] renderer.destroy() completed.');
      } catch (e) {
        console.error('[Anime4KWebExt] Error caught during renderer.destroy():', e);
      } finally {
        this.renderer = null;
        console.log('[Anime4KWebExt] renderer set to null.');
      }
    }
  }

  /**
   * Shows an error notification (uses a singleton notification element to avoid duplicate DOM creation)
   */
  private static activeNotification: HTMLElement | null = null;
  private static notificationTimeout: number | null = null;

  private showErrorModal(message: string, showOptionsLink = false): void {
    // Reuse existing notification element
    if (VideoEnhancer.activeNotification) {
      VideoEnhancer.activeNotification.remove();
      VideoEnhancer.activeNotification = null;
    }
    if (VideoEnhancer.notificationTimeout !== null) {
      clearTimeout(VideoEnhancer.notificationTimeout);
      VideoEnhancer.notificationTimeout = null;
    }

    const notification = document.createElement('div');
    Object.assign(notification.style, {
      position: 'fixed', top: '20px', right: '20px',
      backgroundColor: '#333', color: '#fff', padding: '15px 20px',
      borderRadius: '4px', boxShadow: '0 2px 10px rgba(0,0,0,0.2)',
      zIndex: '10000', maxWidth: '350px', fontFamily: 'Arial, sans-serif',
      fontSize: '14px', lineHeight: '1.5'
    });

    const messageNode = document.createElement('p');
    messageNode.textContent = `[Anime4K WebExtension] ${message}`;
    messageNode.style.margin = '0';
    notification.appendChild(messageNode);

    if (showOptionsLink) {
      const link = document.createElement('a');
      link.textContent = t('goToOptions', 'Go to Options');
      link.href = '#';
      link.style.color = '#8ab4f8';
      link.style.marginTop = '8px';
      link.style.display = 'block';
      link.onclick = (e) => {
        e.preventDefault();
        sendMessage({ type: 'OPEN_OPTIONS_PAGE' });
      };
      notification.appendChild(link);
    }

    document.body.appendChild(notification);
    VideoEnhancer.activeNotification = notification;

    VideoEnhancer.notificationTimeout = window.setTimeout(() => {
      notification.remove();
      if (VideoEnhancer.activeNotification === notification) {
        VideoEnhancer.activeNotification = null;
      }
      VideoEnhancer.notificationTimeout = null;
    }, 8000);
  }
}