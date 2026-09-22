import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProfilerSnapshot } from '@core/gpu/gpu-timestamp-profiler';
import { DiagnosticsOverlay, shortenAdapter, truncateMiddle } from './diagnostics-overlay';

// Surface the English fallbacks so assertions can target user-visible strings.
vi.mock('@utils/i18n', () => ({
  t: vi.fn((_key: string, fallback?: string) => fallback ?? _key),
}));

/**
 * Builds an active profiler snapshot, letting each test override only the
 * fields it cares about.
 */
function activeSnapshot(overrides: Partial<ProfilerSnapshot> = {}): ProfilerSnapshot {
  return {
    status: 'active',
    framesSampled: 0,
    totalGpuP50: null,
    totalGpuP95: null,
    passes: [],
    ...overrides,
  };
}

/**
 * Creates a video element inside a parent div with common layout properties,
 * and stubs browser APIs that jsdom does not provide.
 */
function createTestVideo(): HTMLVideoElement {
  const parent = document.createElement('div');
  parent.id = 'test-parent';
  document.body.appendChild(parent);

  const video = document.createElement('video');
  parent.appendChild(video);

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

let currentTime = 0;

describe('DiagnosticsOverlay', () => {
  beforeEach(() => {
    currentTime = 0;
    vi.stubGlobal('performance', { now: () => currentTime });
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    // The one-time display-refresh probe must never resolve in tests: the
    // stubbed constant `performance.now()` would otherwise make the measurement
    // nondeterministic. A no-op rAF keeps the 60 Hz fallback budget.
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 0));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    cleanupDom();
  });

  describe('create()', () => {
    it('creates a host element as a sibling of the video', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');

      const host = video.parentElement?.querySelector('div');
      expect(host).toBeDefined();
      expect(host?.style.position).toBe('absolute');

      overlay.destroy();
    });

    it('returns a DiagnosticsOverlay instance', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');
      expect(overlay).toBeInstanceOf(DiagnosticsOverlay);
      overlay.destroy();
    });

    it('creates shadow DOM content with diagnostic metrics', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');

      const host = video.parentElement?.querySelector('div');
      expect(host?.shadowRoot).toBeDefined();
      const textContent = host?.shadowRoot?.textContent ?? '';
      expect(textContent).toContain('FPS');
      expect(textContent).toContain('Frame');
      expect(textContent).toContain('Avg');
      expect(textContent).toContain('Pipes');
      expect(textContent).toContain('GPU');
      expect(textContent).toContain('Test GPU');

      overlay.destroy();
    });

    it('starts hidden by default', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');

      const host = video.parentElement?.querySelector('div') as HTMLElement;
      expect(host.style.display).toBe('none');

      overlay.destroy();
    });

    it('renders the provided mode, tier and resolution values', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU', {
        mode: 'Mode A',
        performanceTier: 'balanced',
        inputResolution: '1920×1080',
        targetResolution: '3840×2160',
        restorePolicy: 'gate',
      });

      const host = video.parentElement?.querySelector('div');
      const textContent = host?.shadowRoot?.textContent ?? '';
      expect(textContent).toContain('Mode');
      expect(textContent).toContain('Mode A');
      expect(textContent).toContain('Tier');
      expect(textContent).toContain('balanced');
      expect(textContent).toContain('Input');
      expect(textContent).toContain('1920×1080');
      expect(textContent).toContain('Target');
      expect(textContent).toContain('3840×2160');
      expect(textContent).toContain('Restore policy');
      expect(textContent).toContain('Gate');

      overlay.destroy();
    });

    it('shows placeholders when no info is provided', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');

      const textContent = (video.parentElement?.querySelector('div')?.shadowRoot?.textContent) ?? '';
      expect(textContent).toContain('--');

      overlay.destroy();
    });
  });

  describe('setInfo()', () => {
    it('updates only the provided field, leaving unrelated values intact', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU', {
        mode: 'Mode A',
        performanceTier: 'balanced',
        inputResolution: '1920×1080',
        targetResolution: '3840×2160',
        restorePolicy: 'gate',
      });

      overlay.setInfo({ inputResolution: '1280×720' });

      const textContent = (video.parentElement?.querySelector('div')?.shadowRoot?.textContent) ?? '';
      expect(textContent).toContain('1280×720');
      expect(textContent).not.toContain('1920×1080');
      // Unrelated values remain intact.
      expect(textContent).toContain('Mode A');
      expect(textContent).toContain('balanced');
      expect(textContent).toContain('3840×2160');
      expect(textContent).toContain('Gate');

      overlay.destroy();
    });

    it('is safe to call after destroy()', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU', {
        mode: 'Mode A',
        performanceTier: 'balanced',
        inputResolution: '1920×1080',
        targetResolution: '3840×2160',
        restorePolicy: 'gate',
      });

      overlay.destroy();

      expect(() => overlay.setInfo({ inputResolution: '1280×720' })).not.toThrow();
    });
  });

  describe('restore policy row', () => {
    /** Reads the value cell of the row whose label is "Restore policy". */
    function policyValue(video: HTMLVideoElement): string {
      const shadow = video.parentElement?.querySelector('div')?.shadowRoot;
      const rows = shadow ? Array.from(shadow.querySelectorAll('.metric')) : [];
      for (const row of rows) {
        if (row.querySelector('.metric-label')?.textContent === 'Restore policy') {
          return row.querySelector('.metric-value')?.textContent ?? '';
        }
      }
      return '';
    }

    function createWithPolicy(policy: string): { video: HTMLVideoElement; overlay: DiagnosticsOverlay } {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU', {
        mode: 'Mode A',
        performanceTier: 'balanced',
        inputResolution: '640×360',
        targetResolution: '1280×720',
        restorePolicy: policy,
      });
      return { video, overlay };
    }

    it.each([
      ['off', 'Off'],
      ['gate', 'Gate'],
      ['trailing', 'Trailing'],
      ['leading', 'Leading'],
    ])('renders the %s policy as the short label "%s"', (policy, expected) => {
      const { video, overlay } = createWithPolicy(policy);

      const shadow = video.parentElement?.querySelector('div')?.shadowRoot;
      expect(shadow?.textContent).toContain('Restore policy');
      expect(policyValue(video)).toBe(expected);

      overlay.destroy();
    });

    it('updates the row through setInfo()', () => {
      const { video, overlay } = createWithPolicy('off');

      overlay.setInfo({ restorePolicy: 'leading' });
      expect(policyValue(video)).toBe('Leading');

      overlay.destroy();
    });

    it('falls back to the raw value for an unknown policy', () => {
      const { video, overlay } = createWithPolicy('mystery');

      expect(policyValue(video)).toBe('mystery');

      overlay.destroy();
    });

    it('clears the element on destroy()', () => {
      const { overlay } = createWithPolicy('gate');

      overlay.destroy();
      expect(overlay['restorePolicyEl']).toBeNull();
    });
  });

  describe('show() / hide()', () => {
    it('show() makes overlay visible', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');

      overlay.show();
      const host = video.parentElement?.querySelector('div') as HTMLElement;
      expect(host.style.display).toBe('block');

      overlay.destroy();
    });

    it('hide() hides the overlay', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');

      overlay.show();
      overlay.hide();
      const host = video.parentElement?.querySelector('div') as HTMLElement;
      expect(host.style.display).toBe('none');

      overlay.destroy();
    });
  });

  describe('update()', () => {
    it('calculates FPS from wall-clock time between updates', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');

      // First call — no FPS yet (no previous timestamp to compute delta)
      overlay.update(0, 4);
      expect(overlay['fpsEl']?.textContent).toBe('0.00');

      // Advance time by 16.67ms (~60 FPS — 1000/16.67 ≈ 59.99)
      currentTime = 16.67;
      overlay.update(0, 4);
      expect(overlay['fpsEl']?.textContent).toBe('59.99');

      // Advance by another 16.67ms — avg stays at 16.67ms
      currentTime = 33.34;
      overlay.update(0, 4);
      expect(overlay['fpsEl']?.textContent).toBe('59.99');

      overlay.destroy();
    });

    it('displays frame time and average frame time from wall-clock deltas', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');

      // First call — no delta yet
      overlay.update(0, 3);

      // Advance by 10ms (100 FPS)
      currentTime = 10;
      overlay.update(0, 3);

      // Advance by another 20ms (now buffer: [10, 20], avg = 15ms)
      currentTime = 30;
      overlay.update(0, 3);

      const host = video.parentElement?.querySelector('div') as HTMLElement;
      const textContent = host.shadowRoot?.textContent ?? '';

      // Latest frame time (wall-clock delta)
      expect(textContent).toContain('20.0 ms');
      // Average frame time: (10 + 20) / 2 = 15ms
      expect(textContent).toContain('15.0 ms');

      overlay.destroy();
    });

    it('rolling buffer keeps max 60 entries', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');

      // First call (no delta recorded)
      overlay.update(0, 4);

      // Push 70 frames at 16.67ms intervals
      for (let i = 1; i <= 70; i++) {
        currentTime = i * 16.67;
        overlay.update(0, 4);
      }

      // Should only keep last 60 entries
      expect(overlay['frameTimes'].length).toBe(60);

      overlay.destroy();
    });

    it('handles zero delta gracefully', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');

      // First call — no delta
      overlay.update(0, 0);

      // Second call at same time (zero delta)
      overlay.update(0, 0);

      const host = video.parentElement?.querySelector('div') as HTMLElement;
      const textContent = host.shadowRoot?.textContent ?? '';

      expect(textContent).toContain('0.0 ms');
      expect(textContent).toContain('0');

      overlay.destroy();
    });

    it('resets buffer on abnormally large wall-clock delta', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');

      // Build up some frame times at 16.67ms intervals
      for (let i = 1; i <= 10; i++) {
        currentTime = i * (1000 / 60);
        overlay.update(0, 4);
      }
      expect(overlay['frameTimes'].length).toBeGreaterThan(0);

      // Large gap (e.g. tab was hidden) — should reset the buffer
      currentTime += 1000; // 1 second gap (>500ms threshold)
      overlay.update(0, 4);

      // Buffer should be empty after the reset
      expect(overlay['frameTimes'].length).toBe(0);
      expect(overlay['fpsEl']?.textContent).toBe('0.00');

      // Next normal frame should recover immediately
      currentTime += 1000 / 60;
      overlay.update(0, 4);
      expect(overlay['frameTimes'].length).toBe(1);
      expect(overlay['fpsEl']?.textContent).toBe('60.00');

      overlay.destroy();
    });
  });

  describe('destroy()', () => {
    it('removes host from DOM', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');

      overlay.destroy();

      const host = video.parentElement?.querySelector('div');
      expect(host).toBeNull();
    });

    it('disconnects ResizeObserver', () => {
      const video = createTestVideo();
      const disconnectSpy = vi.spyOn(ResizeObserver.prototype, 'disconnect');
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');

      overlay.destroy();

      expect(disconnectSpy).toHaveBeenCalled();
    });

    it('is idempotent — safe to call destroy twice', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');

      expect(() => {
        overlay.destroy();
        overlay.destroy();
      }).not.toThrow();
    });
  });

  describe('GPU/CPU timing section', () => {
    function shadowOf(video: HTMLVideoElement): ShadowRoot {
      const host = video.parentElement?.querySelector('div') as HTMLElement;
      return host.shadowRoot as ShadowRoot;
    }

    it('renders a row per pass, the totals, and the sample count', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');

      overlay.update(0, 4, activeSnapshot({
        framesSampled: 128,
        totalGpuP50: 7.5,
        totalGpuP95: 9.25,
        passes: [
          { label: 'EffectA', cpuP50: 1.2, cpuP95: 2.5, gpuP50: 0.8, gpuP95: 1.4, gpuP99: 2.0 },
          // GPU values intentionally omitted — those cells must stay clean.
          { label: 'EffectB', cpuP50: 3.0, cpuP95: 4.0 },
        ],
      }));

      const shadow = shadowOf(video);
      const section = shadow.querySelector('.timing-section') as HTMLElement;
      expect(section.style.display).toBe('block');

      const grid = shadow.querySelector('.timing-grid') as HTMLElement;
      expect(grid.style.display).toBe('grid');
      expect(grid.textContent).toContain('EffectA');
      expect(grid.textContent).toContain('EffectB');
      // The stubbed clock is coarse, so per-pass CPU columns are dropped and the
      // grid renders GPU columns only. CPU values must never be shown as if the
      // 0.1 ms-resolution numbers were meaningful.
      expect(grid.classList.contains('timing-grid--gpu-only')).toBe(true);
      expect(grid.textContent).not.toContain('CPU p50');
      expect(grid.textContent).not.toContain('1.20');
      expect(grid.textContent).not.toContain('2.50');
      expect(grid.textContent).not.toContain('3.00');
      expect(grid.textContent).not.toContain('4.00');
      // GPU p50/p95/p99 for EffectA.
      expect(grid.textContent).toContain('0.80');
      expect(grid.textContent).toContain('1.40');
      expect(grid.textContent).toContain('2.00');
      // Omitted GPU values render as an em dash, never "undefined".
      expect(grid.textContent).toContain('\u2014');
      expect(grid.textContent).not.toContain('undefined');
      // Totals (p50 / p95).
      expect(grid.textContent).toContain('7.50');
      expect(grid.textContent).toContain('9.25');
      // Coarse-timer footnote.
      const note = shadow.querySelector('.timing-note') as HTMLElement;
      expect(note.style.display).toBe('block');
      expect(note.textContent).toBe('CPU timings limited to 0.1 ms');
      // Sample count readout.
      expect(shadow.querySelector('.timing-frames')?.textContent).toContain('128');

      overlay.destroy();
    });

    it('shows n/a for null totals', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');

      overlay.update(0, 4, activeSnapshot({
        totalGpuP50: null,
        totalGpuP95: null,
        passes: [{ label: 'EffectA', gpuP50: 1.0 }],
      }));

      const grid = shadowOf(video).querySelector('.timing-grid') as HTMLElement;
      // Two null total cells both render as em dashes.
      expect(grid.textContent).toContain('\u2014');

      overlay.destroy();
    });

    it('shows a status line and no pass rows when the profiler is not active', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');

      overlay.update(0, 4, {
        status: 'degraded',
        framesSampled: 9,
        totalGpuP50: null,
        totalGpuP95: null,
        passes: [{ label: 'StaleEffect', gpuP50: 1.0 }],
      });

      const shadow = shadowOf(video);
      const section = shadow.querySelector('.timing-section') as HTMLElement;
      expect(section.style.display).toBe('block');

      const status = shadow.querySelector('.timing-status') as HTMLElement;
      expect(status.style.display).toBe('block');
      expect(status.textContent).toBe('GPU timings unavailable');

      const grid = shadow.querySelector('.timing-grid') as HTMLElement;
      expect(grid.style.display).toBe('none');
      expect(grid.textContent).not.toContain('StaleEffect');

      overlay.destroy();
    });

    it('keeps the section hidden when no snapshot or no passes are provided', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');
      const section = () => shadowOf(video).querySelector('.timing-section') as HTMLElement;

      // Omitted snapshot (backwards-compatible 2-argument call).
      overlay.update(0, 4);
      expect(section().style.display).toBe('none');

      // Explicit null snapshot.
      overlay.update(0, 4, null);
      expect(section().style.display).toBe('none');

      // Active profiler but no sampled passes yet.
      overlay.update(0, 4, activeSnapshot({ passes: [] }));
      expect(section().style.display).toBe('none');

      overlay.destroy();
    });

    it('throttles timing DOM rebuilds to ~250ms while later updates do rebuild', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');
      const grid = () => shadowOf(video).querySelector('.timing-grid') as HTMLElement;

      // t=0 — first snapshot renders immediately.
      overlay.update(0, 4, activeSnapshot({ passes: [{ label: 'EffectA' }] }));
      expect(grid().textContent).toContain('EffectA');

      // t=100 — inside the throttle window, so the table must not change.
      currentTime = 100;
      overlay.update(0, 4, activeSnapshot({ passes: [{ label: 'EffectB' }] }));
      expect(grid().textContent).toContain('EffectA');
      expect(grid().textContent).not.toContain('EffectB');

      // t=300 — outside the throttle window, so a rebuild is allowed.
      currentTime = 300;
      overlay.update(0, 4, activeSnapshot({ passes: [{ label: 'EffectB' }] }));
      expect(grid().textContent).toContain('EffectB');
      expect(grid().textContent).not.toContain('EffectA');

      overlay.destroy();
    });

    it('removes the timing section on destroy', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');

      overlay.update(0, 4, activeSnapshot({ passes: [{ label: 'EffectA' }] }));
      const section = shadowOf(video).querySelector('.timing-section') as HTMLElement;
      expect(section.isConnected).toBe(true);

      overlay.destroy();
      expect(section.isConnected).toBe(false);
    });
  });

  describe('detail mode', () => {
    function containerOf(video: HTMLVideoElement): HTMLElement {
      return video.parentElement?.querySelector('div')?.shadowRoot
        ?.querySelector('.diagnostics') as HTMLElement;
    }

    it('applies the compact class when setDetailMode("compact") is selected', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');

      overlay.setDetailMode('compact');
      expect(containerOf(video).classList.contains('is-compact')).toBe(true);

      overlay.setDetailMode('expanded');
      expect(containerOf(video).classList.contains('is-compact')).toBe(false);

      overlay.destroy();
    });

    it('defaults to expanded on the auto path and names the budget reference', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');

      const host = video.parentElement?.querySelector('div');
      expect(host?.shadowRoot?.textContent).toContain('Frame \u00b7 16.7 ms');

      overlay.destroy();
    });

    it('middle-truncates long pass labels only in compact mode', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');
      const snapshot = activeSnapshot({
        passes: [{ label: 'ClampHighlightsApplyStrength', gpuP50: 1 }],
      });

      overlay.update(0, 4, snapshot);
      let grid = containerOf(video).querySelector('.timing-grid') as HTMLElement;
      expect(grid.textContent).toContain('ClampHighlightsApplyStrength');

      overlay.setDetailMode('compact');
      grid = containerOf(video).querySelector('.timing-grid') as HTMLElement;
      expect(grid.textContent).not.toContain('ClampHighlightsApplyStrength');
      expect(grid.textContent).toContain('\u2026');

      overlay.destroy();
    });
  });

  describe('budget + hot-pass encoding', () => {
    function containerOf(video: HTMLVideoElement): HTMLElement {
      return video.parentElement?.querySelector('div')?.shadowRoot
        ?.querySelector('.diagnostics') as HTMLElement;
    }

    it('does not flag healthy 60 fps content with small processing cost', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');

      // 60 fps wall-clock cadence, trivial per-frame processing cost.
      overlay.update(1, 4);
      currentTime = 16.67; // 59.99 fps, one display interval
      overlay.update(1, 4);

      const container = containerOf(video);
      const row = container.querySelector('.metric--frame') as HTMLElement;
      expect(row.getAttribute('data-state')).toBe('ok');
      expect(container.getAttribute('data-state')).toBe('ok');

      // The numeric badge was removed; the bar is the only budget indicator.
      expect(row.querySelector('.metric-badge')).toBeNull();
      const fill = container.querySelector('.budget-fill') as HTMLElement;
      expect(parseFloat(fill.style.width)).toBeLessThan(90);

      overlay.destroy();
    });

    it('shows warn when processing cost is 90-100% of the budget', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');

      // 15.5 ms of processing against the 16.7 ms budget → ~93% → warn.
      overlay.update(15.5, 4);
      overlay.update(15.5, 4);

      const container = containerOf(video);
      const row = container.querySelector('.metric--frame') as HTMLElement;
      expect(row.getAttribute('data-state')).toBe('warn');

      const fill = container.querySelector('.budget-fill') as HTMLElement;
      const width = parseFloat(fill.style.width);
      expect(width).toBeGreaterThanOrEqual(90);
      expect(width).toBeLessThanOrEqual(100);

      overlay.destroy();
    });

    it('clamps the budget bar at 100% for processing far over budget', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');

      // 40 ms of processing is ~240% of the budget but must never overflow.
      overlay.update(40, 4);
      overlay.update(40, 4);

      const container = containerOf(video);
      const row = container.querySelector('.metric--frame') as HTMLElement;
      expect(row.getAttribute('data-state')).toBe('over');
      expect((container.querySelector('.budget-fill') as HTMLElement).style.width).toBe('100%');

      overlay.destroy();
    });

    it('reflects processing cost at any content cadence (no fps gate)', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');

      // 24 fps wall-clock content with an over-budget processing cost is still a
      // renderer fault: the display budget is a valid reference at any cadence.
      overlay.update(0, 4);
      currentTime = 1000 / 24;
      overlay.update(20, 4);

      const row = containerOf(video).querySelector('.metric--frame') as HTMLElement;
      expect(row.getAttribute('data-state')).toBe('over');

      overlay.destroy();
    });

    it('uses GPU p50 as processing cost when it exceeds CPU frame time', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');

      // CPU cost alone (2 ms) would be well under the 16.7 ms budget...
      overlay.update(2, 4, activeSnapshot({ totalGpuP50: 2 }));
      let row = containerOf(video).querySelector('.metric--frame') as HTMLElement;
      expect(row.getAttribute('data-state')).toBe('ok');

      // ...but the GPU-derived cost (20 ms) pushes the same frame over budget.
      overlay.update(2, 4, activeSnapshot({ totalGpuP50: 20 }));
      row = containerOf(video).querySelector('.metric--frame') as HTMLElement;
      expect(row.getAttribute('data-state')).toBe('over');

      overlay.destroy();
    });

    it('encodes relative GPU cost with heat and highlights the dominant pass', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');

      overlay.update(0, 4, activeSnapshot({
        passes: [
          { label: 'BigPass', gpuP50: 10.5 },
          { label: 'SmallPass', gpuP50: 0.07 },
        ],
      }));

      const grid = containerOf(video).querySelector('.timing-grid') as HTMLElement;
      const passes = grid.querySelectorAll('.timing-pass:not(.timing-head)');
      const big = passes[0] as HTMLElement;
      const small = passes[1] as HTMLElement;

      expect(big.style.getPropertyValue('--heat')).toBe('1');
      expect(big.classList.contains('timing-pass--hot')).toBe(true);
      // 10.5 ms is under the 16.7 ms budget, so the dominant pass is not red.
      expect(big.classList.contains('timing-pass--over')).toBe(false);
      expect(small.classList.contains('timing-pass--hot')).toBe(false);
      expect(Number(small.style.getPropertyValue('--heat'))).toBeLessThan(0.1);

      overlay.destroy();
    });
  });

  describe('display-refresh probe (MIN-1)', () => {
    /**
     * The one-time probe is driven by captured `requestAnimationFrame`
     * callbacks; each timestamp feeds one frame. The label rendered by the
     * expanded HUD (`Frame · <budget> ms`) is the public observable for the
     * accepted/rejected measurement.
     */
    function frameLabel(video: HTMLVideoElement): string {
      const host = video.parentElement?.querySelector('div') as HTMLElement;
      return (
        host.shadowRoot?.querySelector('.metric--frame .metric-label')?.textContent ?? ''
      );
    }

    /**
     * Install a capturing rAF: created overlay schedules a callback, then each
     * invoked callback schedules the next until the probe completes. Returns a
     * pump that feeds one timestamp per scheduled frame.
     */
    function installCapturingRaf(): (timestamps: number[]) => void {
      const queue: FrameRequestCallback[] = [];
      vi.stubGlobal(
        'requestAnimationFrame',
        vi.fn((callback: FrameRequestCallback): number => {
          queue.push(callback);
          return queue.length;
        }),
      );
      return (timestamps: number[]): void => {
        for (const timestamp of timestamps) {
          const callback = queue.shift();
          if (!callback) break;
          callback(timestamp);
        }
      };
    }

    /**
     * Create an overlay, run the six-frame probe at a fixed cadence, and return
     * the resulting frame-label text.
     */
    function runProbe(intervalMs: number): string {
      const video = createTestVideo();
      const pump = installCapturingRaf();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');

      // Six frames yield five deltas; the first timestamp is only the baseline.
      pump(Array.from({ length: 6 }, (_, index) => index * intervalMs));

      const label = frameLabel(video);
      overlay.destroy();
      return label;
    }

    it('accepts a ~280 Hz interval (~3.57 ms) and records it as the budget', () => {
      // 1000 / 280 ≈ 3.57 ms, inside the [2, 50] ms accept window.
      expect(runProbe(1000 / 280)).toBe('Frame \u00b7 3.6 ms');
    });

    it('accepts a ~240 Hz interval (~4.17 ms) and records it as the budget', () => {
      // 1000 / 240 ≈ 4.17 ms, inside the [2, 50] ms accept window.
      expect(runProbe(1000 / 240)).toBe('Frame \u00b7 4.2 ms');
    });

    it('rejects an interval below the 2 ms floor and keeps the 60 Hz fallback', () => {
      expect(runProbe(1)).toBe('Frame \u00b7 16.7 ms');
    });

    it('rejects an interval above the 50 ms ceiling and keeps the 60 Hz fallback', () => {
      expect(runProbe(60)).toBe('Frame \u00b7 16.7 ms');
    });
  });

  describe('helper formatters', () => {
    it('middle-truncates keeping head and tail', () => {
      expect(truncateMiddle('short', 20)).toBe('short');
      const out = truncateMiddle('ClampHighlightsApply', 11);
      expect(out).toHaveLength(11);
      expect(out).toContain('\u2026');
      expect(out.startsWith('Clam')).toBe(true);
      expect(out.endsWith('ly')).toBe(true);
    });

    it('shortens ANGLE-wrapped adapter strings and keeps the model', () => {
      const shortened = shortenAdapter(
        'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      );
      expect(shortened).toContain('RTX 3080');
      expect(shortened).not.toContain('ANGLE');
      expect(shortened.length).toBeLessThanOrEqual(28);
      expect(shortenAdapter('Intel Iris Xe Graphics')).toBe('Intel Iris Xe Graphics');
    });
  });
});
