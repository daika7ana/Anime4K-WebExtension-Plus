import type { ProfilerSnapshot } from '@core/gpu/gpu-timestamp-profiler';
import type { DiagnosticsDetailMode } from '@/types';
import { t } from '@utils/i18n';

/** Format a millisecond value for the HUD, using an em dash when unavailable. */
function formatTimingMs(value: number | null | undefined): string {
  if (value === undefined || value === null || !Number.isFinite(value)) {
    return '\u2014';
  }
  return value.toFixed(2);
}

/**
 * Middle-truncate a label, keeping both the head and the tail so that visually
 * similar pass names (e.g. `ClampHighlightsA` vs `ClampHighlightsB`) stay
 * distinguishable. Used in compact mode; expanded mode uses CSS wrapping.
 */
export function truncateMiddle(value: string, max: number): string {
  if (value.length <= max || max < 5) return value;
  const keep = max - 1; // room for the single-character ellipsis
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${value.slice(0, head)}\u2026${value.slice(value.length - tail)}`;
}

/**
 * Shorten a GPU adapter string for the compact HUD. WebGL reports long
 * ANGLE-wrapped renderer strings such as
 * `ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)`;
 * compact mode strips the wrapper, de-duplicates the repeated vendor token and
 * keeps the meaningful model. Expanded mode shows the full string.
 */
export function shortenAdapter(raw: string): string {
  if (!raw) return raw;
  let value = raw.trim();

  const angle = /^ANGLE\s*\((.*)\)\s*$/i.exec(value);
  if (angle && angle[1]) {
    value = angle[1];
    value = value.replace(/,\s*(D3D11|D3D9|OpenGL ES|OpenGL|Vulkan|Metal)\b.*$/i, '');
  }

  // De-duplicate a repeated vendor token across comma-separated segments
  // ("NVIDIA, NVIDIA GeForce RTX 3080" → "NVIDIA GeForce RTX 3080").
  const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
  const deduped: string[] = [];
  for (const part of parts) {
    const head = part.split(/\s+/)[0];
    const previous = deduped[deduped.length - 1];
    const previousHead = previous?.split(/\s+/)[0];
    if (previous !== undefined && previousHead === head) {
      deduped[deduped.length - 1] = part;
      continue;
    }
    deduped.push(part);
  }

  value = deduped.join(' ').replace(/\s+/g, ' ').trim();
  value = value.replace(/\s+(Direct3D\d+|vs_\d+_\d+|ps_\d+_\d+).*$/i, '').trim();

  if (value.length <= 28) return value;

  const model = /\b(?:NVIDIA|AMD|ATI|Intel|Apple)?\s*((?:GeForce\s+)?(?:RTX|GTX|RX|Arc|Radeon|Iris|UHD|Adreno|Mali|Apple M)[\w\s-]*)/i.exec(value);
  const candidate = model?.[0]?.trim() ?? value;
  return candidate.length <= 28 ? candidate : truncateMiddle(candidate, 28);
}

/** Median of a numeric sample; `null` when the sample is empty. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Read-only configuration values shown by the diagnostics HUD. */
export interface DiagnosticsInfo {
  /** Built-in preset name, or 'Custom' for a custom mode. */
  mode: string;
  /** Raw performance tier value, e.g. 'balanced'. */
  performanceTier: string;
  /** Input (source) video resolution, e.g. '1920×1080'. */
  inputResolution: string;
  /** Computed output target resolution, e.g. '3840×2160'. */
  targetResolution: string;
  /** Active restore policy, e.g. 'gate'. */
  restorePolicy: string;
}

/**
 * Map a restore policy value to a short HUD label. The diagnostics panel is a
 * narrow monospace overlay, so the long options-page descriptors are never
 * used; unknown values fall back to the raw string, then to the 'off' label.
 */
export function formatRestorePolicy(policy: string): string {
  switch (policy) {
    case 'off':
      return t('restorePolicyNameOff', 'Off');
    case 'gate':
      return t('restorePolicyNameGate', 'Gate');
    case 'trailing':
      return t('restorePolicyNameTrailing', 'Trailing');
    case 'leading':
      return t('restorePolicyNameLeading', 'Leading');
    default:
      return policy || t('restorePolicyNameOff', 'Off');
  }
}

/** Effective frame-budget state used for the HUD's semantic accent colors. */
type BudgetState = 'ok' | 'warn' | 'over';

/**
 * Diagnostics overlay showing live performance metrics during video enhancement.
 * Attaches to the same video element as the enhance button, positioned top-right.
 * Uses shadow DOM for style isolation.
 */
export class DiagnosticsOverlay {
  private static readonly MAX_FRAME_TIMES = 60;
  private static readonly MAX_REASONABLE_DELTA_MS = 500;
  private static readonly TIMING_THROTTLE_MS = 250;
  /** Fallback display budget: one 60 Hz refresh interval. */
  private static readonly DEFAULT_FRAME_BUDGET_MS = 16.667;
  /**
   * Accept/reject window for a display refresh interval measured by the probe
   * (not a clamp: values outside it are discarded). The 2–50 ms range covers
   * roughly 20–500 Hz; anything outside is implausible and the probe keeps the
   * 60 Hz fallback.
   */
  private static readonly MIN_FRAME_BUDGET_MS = 2;
  private static readonly MAX_FRAME_BUDGET_MS = 50;
  /** rAF deltas sampled by the one-time display-refresh probe. */
  private static readonly BUDGET_PROBE_SAMPLES = 6;
  /**
   * Hard cap on the `performance.now()` resolution probe. The cap is what keeps
   * the probe from hanging: environments that clamp the clock (or tests that
   * stub it to a constant) never change `performance.now()`, so an unbounded
   * `while` loop would spin forever.
   */
  private static readonly RESOLUTION_PROBE_MAX_ITERATIONS = 10;
  /** Videos smaller than this fall back to the compact HUD in 'auto' mode. */
  private static readonly COMPACT_MIN_WIDTH = 480;
  private static readonly COMPACT_MIN_HEIGHT = 270;
  /** Maximum pass-label length used for middle truncation in compact mode. */
  private static readonly COMPACT_PASS_LABEL_MAX = 20;

  private host: HTMLDivElement | null = null;
  private shadowRoot: ShadowRoot | null = null;
  private containerEl: HTMLElement | null = null;
  private fpsEl: HTMLElement | null = null;
  private frameLabelEl: HTMLElement | null = null;
  private frameRowEl: HTMLElement | null = null;
  private budgetFillEl: HTMLElement | null = null;
  private frameTimeEl: HTMLElement | null = null;
  private avgFrameTimeEl: HTMLElement | null = null;
  private cpuEl: HTMLElement | null = null;
  private pipelineCountEl: HTMLElement | null = null;
  private adapterInfoEl: HTMLElement | null = null;
  private modeEl: HTMLElement | null = null;
  private tierEl: HTMLElement | null = null;
  private inputResolutionEl: HTMLElement | null = null;
  private targetResolutionEl: HTMLElement | null = null;
  private restorePolicyEl: HTMLElement | null = null;
  private gpuShareEl: HTMLElement | null = null;
  private timingSectionEl: HTMLElement | null = null;
  private timingTitleEl: HTMLElement | null = null;
  private timingStatusEl: HTMLElement | null = null;
  private timingGridEl: HTMLElement | null = null;
  private timingNoteEl: HTMLElement | null = null;
  private timingFramesEl: HTMLElement | null = null;
  private timingVisible = false;
  private lastTimingRenderTime = Number.NEGATIVE_INFINITY;
  private lastSnapshot: ProfilerSnapshot | null = null;
  private frameTimes: number[] = [];
  private lastUpdateTime = 0;
  private hasFirstUpdate = false;
  private adapterInfo: string;
  private info: DiagnosticsInfo | null = null;
  private detailMode: DiagnosticsDetailMode = 'auto';
  private isCompact = false;
  private smallVideo = false;
  /** Display frame budget in ms (one refresh interval); overridable by probe. */
  private frameBudgetMs = DiagnosticsOverlay.DEFAULT_FRAME_BUDGET_MS;
  /** False when `performance.now()` is too coarse for per-pass CPU timing. */
  private cpuTimingReliable = false;
  private lastBudgetState: BudgetState = 'ok';
  private video: HTMLVideoElement;
  private resizeObserver: ResizeObserver | null = null;

  private constructor(
    video: HTMLVideoElement,
    adapterInfo: string,
    info: DiagnosticsInfo | null = null,
    detailMode: DiagnosticsDetailMode = 'auto',
  ) {
    this.video = video;
    this.adapterInfo = adapterInfo;
    this.info = info;
    this.detailMode = detailMode;
  }

  public static create(
    video: HTMLVideoElement,
    adapterInfo: string,
    info?: DiagnosticsInfo,
    detailMode?: DiagnosticsDetailMode,
  ): DiagnosticsOverlay {
    const overlay = new DiagnosticsOverlay(video, adapterInfo, info ?? null, detailMode ?? 'auto');
    overlay.initialize();
    return overlay;
  }

  private initialize(): void {
    this.host = document.createElement('div');
    this.host.style.position = 'absolute';
    this.host.style.pointerEvents = 'none';
    this.host.style.zIndex = '2147483645';

    this.video.parentElement?.insertBefore(this.host, this.video);

    this.shadowRoot = this.host.attachShadow({ mode: 'open' });

    // Create styles
    const style = document.createElement('style');
    style.textContent = `
      .diagnostics {
        --a4k-panel: rgba(8, 10, 14, 0.72);
        --a4k-text: #f5f7fa;
        --a4k-label: rgba(245, 247, 250, 0.60);
        --a4k-accent: #5eead4;
        --a4k-ok: #4ade80;
        --a4k-warn: #fbbf24;
        --a4k-over: #f87171;
        --a4k-track: rgba(255, 255, 255, 0.12);
        --a4k-border: rgba(255, 255, 255, 0.18);
        position: absolute;
        top: 10px;
        right: 10px;
        max-width: calc(100% - 20px);
        max-height: calc(100% - 20px);
        overflow: hidden;
        background: var(--a4k-panel);
        color: var(--a4k-text);
        font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
        font-size: 14px;
        line-height: 1.6;
        font-variant-numeric: tabular-nums;
        padding: 10px;
        border-radius: 4px;
        /* Explicit width in expanded mode must include the padding so the
           calc(100% - 20px) inset is honoured on narrow videos. */
        box-sizing: border-box;
        white-space: nowrap;
        user-select: none;
        pointer-events: none;
        contain: layout paint;
      }
      .diagnostics:not(.is-compact) {
        /* A definite panel width gives the timing grid something to fill, so the
           PASS column can absorb the slack and the metric columns sit flush
           right. Compact mode stays content-sized. */
        width: min(560px, calc(100% - 20px));
        max-width: min(560px, calc(100% - 20px));
      }
      .diagnostics.is-compact {
        font-size: 12px;
        line-height: 1.5;
        padding: 6px 8px;
      }
      .diag__health-dot {
        display: inline-block;
        width: 7px;
        height: 7px;
        border-radius: 50%;
        margin-right: 6px;
        vertical-align: middle;
        background: var(--a4k-ok);
        box-shadow: 0 0 0 2px rgba(74, 222, 128, 0.18);
      }
      .diagnostics[data-state="warn"] .diag__health-dot {
        background: var(--a4k-warn);
        box-shadow: 0 0 0 2px rgba(251, 191, 36, 0.18);
      }
      .diagnostics[data-state="over"] .diag__health-dot {
        background: var(--a4k-over);
        box-shadow: 0 0 0 2px rgba(248, 113, 113, 0.18);
      }
      .metric {
        display: flex;
        justify-content: space-between;
        gap: 16px;
      }
      .metric-label {
        opacity: 0.7;
      }
      .metric-value {
        font-weight: bold;
        text-align: right;
      }
      .metric--adapter .metric-value {
        min-width: 0;
        max-width: 70%;
        white-space: normal;
        overflow-wrap: anywhere;
        text-align: right;
      }
      .budget-bar {
        height: 3px;
        margin: 2px 0 6px;
        border-radius: 2px;
        background: var(--a4k-track);
        overflow: hidden;
      }
      .budget-fill {
        display: block;
        height: 100%;
        width: 0%;
        background: var(--a4k-ok);
        border-radius: 2px;
        transition: width 120ms linear, background-color 120ms linear;
      }
      .metric--frame[data-state="warn"] + .budget-bar .budget-fill {
        background: var(--a4k-warn);
      }
      .metric--frame[data-state="over"] + .budget-bar .budget-fill {
        background: var(--a4k-over);
      }
      @media (prefers-reduced-motion: reduce) {
        .budget-fill { transition: none; }
      }
      .diag__config {
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px solid var(--a4k-border);
      }
      .diag__config .metric-label {
        opacity: 0.5;
      }
      .diag__gpu-share {
        display: none;
        margin-top: 4px;
        font-size: 12px;
        color: var(--a4k-label);
      }
      .diagnostics.is-compact .diag__gpu-share {
        display: block;
      }
      .diagnostics.is-compact .diag__row--detail {
        display: none;
      }
      .diagnostics.is-compact .diag__config {
        display: none;
      }
      .diagnostics.is-compact .timing-section {
        display: none !important;
      }
      .timing-section {
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px solid var(--a4k-border);
      }
      .timing-title {
        font-size: 11px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--a4k-accent);
        opacity: 0.9;
        margin-bottom: 4px;
      }
      .timing-status {
        opacity: 0.7;
        font-style: italic;
      }
      .timing-grid {
        display: grid;
        /* PASS takes the slack (1fr) so the metric columns anchor to the right
           edge of the full-width table. */
        grid-template-columns: minmax(0, 1fr) repeat(5, max-content);
        width: 100%;
        column-gap: 12px;
        row-gap: 2px;
        align-items: baseline;
      }
      .timing-grid--gpu-only {
        grid-template-columns: minmax(0, 1fr) repeat(3, max-content);
      }
      .timing-cell {
        text-align: right;
      }
      .timing-pass {
        position: relative;
        padding-left: 9px;
        text-align: left;
        max-width: 140px;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .timing-pass::before {
        content: '';
        position: absolute;
        left: 0;
        top: 0.25em;
        bottom: 0.25em;
        width: 3px;
        border-radius: 2px;
        background: var(--a4k-accent);
        opacity: calc(0.12 + var(--heat, 0) * 0.88);
      }
      .timing-head::before {
        display: none;
      }
      .timing-pass--hot {
        font-weight: 700;
      }
      .timing-pass--warn::before {
        background: var(--a4k-warn);
        opacity: 1;
      }
      .timing-pass--over::before {
        background: var(--a4k-over);
        opacity: 1;
      }
      .timing-cell--top {
        color: var(--a4k-accent);
        font-weight: 700;
      }
      .timing-head {
        font-size: 11px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        opacity: 0.55;
      }
      .timing-total {
        opacity: 0.85;
      }
      .diagnostics:not(.is-compact) .timing-pass {
        max-width: 180px;
        white-space: normal;
        overflow-wrap: anywhere;
        overflow: visible;
        text-overflow: clip;
        line-height: 1.25;
      }
      .timing-frames {
        margin-top: 4px;
        font-size: 11px;
        opacity: 0.6;
      }
      .diag__note {
        margin-top: 4px;
        font-size: 10px;
        color: var(--a4k-label);
      }
    `;
    this.shadowRoot.appendChild(style);

    // Create container
    const container = document.createElement('div');
    container.className = 'diagnostics';
    container.setAttribute('aria-hidden', 'true');
    container.setAttribute('data-state', 'ok');
    this.containerEl = container;

    // FPS row (health dot communicates the overall frame-budget state)
    const fpsRow = document.createElement('div');
    fpsRow.className = 'metric';
    const fpsLabel = document.createElement('span');
    fpsLabel.className = 'metric-label';
    const healthDot = document.createElement('span');
    healthDot.className = 'diag__health-dot';
    fpsLabel.appendChild(healthDot);
    fpsLabel.appendChild(document.createTextNode('FPS'));
    const fpsValue = document.createElement('span');
    fpsValue.className = 'metric-value';
    fpsValue.textContent = '--';
    this.fpsEl = fpsValue;
    fpsRow.appendChild(fpsLabel);
    fpsRow.appendChild(fpsValue);
    container.appendChild(fpsRow);

    // Frame time row (current) + budget bar
    const frameBlock = document.createElement('div');
    frameBlock.className = 'frame-block';

    const ftRow = document.createElement('div');
    ftRow.className = 'metric metric--frame';
    ftRow.setAttribute('data-state', 'ok');
    const ftLabel = document.createElement('span');
    ftLabel.className = 'metric-label';
    ftLabel.textContent = this.frameLabelText(true);
    this.frameLabelEl = ftLabel;
    const ftValue = document.createElement('span');
    ftValue.className = 'metric-value';
    ftValue.textContent = '-- ms';
    this.frameTimeEl = ftValue;
    ftRow.appendChild(ftLabel);
    ftRow.appendChild(ftValue);
    this.frameRowEl = ftRow;
    frameBlock.appendChild(ftRow);

    const budgetBar = document.createElement('div');
    budgetBar.className = 'budget-bar';
    const budgetFill = document.createElement('span');
    budgetFill.className = 'budget-fill';
    this.budgetFillEl = budgetFill;
    budgetBar.appendChild(budgetFill);
    frameBlock.appendChild(budgetBar);
    container.appendChild(frameBlock);

    // Avg frame time row
    const avgRow = document.createElement('div');
    avgRow.className = 'metric';
    const avgLabel = document.createElement('span');
    avgLabel.className = 'metric-label';
    avgLabel.textContent = 'Avg';
    const avgValue = document.createElement('span');
    avgValue.className = 'metric-value';
    avgValue.textContent = '-- ms';
    this.avgFrameTimeEl = avgValue;
    avgRow.appendChild(avgLabel);
    avgRow.appendChild(avgValue);
    container.appendChild(avgRow);

    // Aggregate CPU frame time (the renderer's `frameTime` argument).
    const cpuRow = document.createElement('div');
    cpuRow.className = 'metric diag__row--detail';
    const cpuLabel = document.createElement('span');
    cpuLabel.className = 'metric-label';
    cpuLabel.textContent = t('diagnosticsCpu', 'CPU');
    const cpuValue = document.createElement('span');
    cpuValue.className = 'metric-value';
    cpuValue.textContent = '-- ms';
    this.cpuEl = cpuValue;
    cpuRow.appendChild(cpuLabel);
    cpuRow.appendChild(cpuValue);
    container.appendChild(cpuRow);

    // Pipeline count row
    const plcRow = document.createElement('div');
    plcRow.className = 'metric diag__row--detail';
    const plcLabel = document.createElement('span');
    plcLabel.className = 'metric-label';
    plcLabel.textContent = 'Pipes';
    const plcValue = document.createElement('span');
    plcValue.className = 'metric-value';
    plcValue.textContent = '--';
    this.pipelineCountEl = plcValue;
    plcRow.appendChild(plcLabel);
    plcRow.appendChild(plcValue);
    container.appendChild(plcRow);

    // GPU total share (compact-only summary line)
    const gpuShare = document.createElement('div');
    gpuShare.className = 'diag__gpu-share';
    this.gpuShareEl = gpuShare;
    container.appendChild(gpuShare);

    // Read-only configuration block
    const config = document.createElement('div');
    config.className = 'diag__config';

    // Adapter info row
    const adpRow = document.createElement('div');
    adpRow.className = 'metric metric--adapter';
    const adpLabel = document.createElement('span');
    adpLabel.className = 'metric-label';
    adpLabel.textContent = 'GPU';
    const adpValue = document.createElement('span');
    adpValue.className = 'metric-value';
    adpValue.textContent = this.adapterInfo;
    this.adapterInfoEl = adpValue;
    adpRow.appendChild(adpLabel);
    adpRow.appendChild(adpValue);
    config.appendChild(adpRow);

    // Mode row (built-in preset name or "Custom")
    const modeRow = document.createElement('div');
    modeRow.className = 'metric';
    const modeLabel = document.createElement('span');
    modeLabel.className = 'metric-label';
    modeLabel.textContent = t('diagnosticsMode', 'Mode');
    const modeValue = document.createElement('span');
    modeValue.className = 'metric-value';
    modeValue.textContent = this.info?.mode ?? '--';
    this.modeEl = modeValue;
    modeRow.appendChild(modeLabel);
    modeRow.appendChild(modeValue);
    config.appendChild(modeRow);

    // Performance tier row (raw value)
    const tierRow = document.createElement('div');
    tierRow.className = 'metric';
    const tierLabel = document.createElement('span');
    tierLabel.className = 'metric-label';
    tierLabel.textContent = t('diagnosticsTier', 'Tier');
    const tierValue = document.createElement('span');
    tierValue.className = 'metric-value';
    tierValue.textContent = this.info?.performanceTier ?? '--';
    this.tierEl = tierValue;
    tierRow.appendChild(tierLabel);
    tierRow.appendChild(tierValue);
    config.appendChild(tierRow);

    // Input (source) resolution row
    const inputRow = document.createElement('div');
    inputRow.className = 'metric';
    const inputLabel = document.createElement('span');
    inputLabel.className = 'metric-label';
    inputLabel.textContent = t('diagnosticsInputResolution', 'Input');
    const inputValue = document.createElement('span');
    inputValue.className = 'metric-value';
    inputValue.textContent = this.info?.inputResolution ?? '--';
    this.inputResolutionEl = inputValue;
    inputRow.appendChild(inputLabel);
    inputRow.appendChild(inputValue);
    config.appendChild(inputRow);

    // Target (output) resolution row
    const targetRow = document.createElement('div');
    targetRow.className = 'metric';
    const targetLabel = document.createElement('span');
    targetLabel.className = 'metric-label';
    targetLabel.textContent = t('diagnosticsTargetResolution', 'Target');
    const targetValue = document.createElement('span');
    targetValue.className = 'metric-value';
    targetValue.textContent = this.info?.targetResolution ?? '--';
    this.targetResolutionEl = targetValue;
    targetRow.appendChild(targetLabel);
    targetRow.appendChild(targetValue);
    config.appendChild(targetRow);

    // Restore policy row (short label; the long descriptor lives on the options page)
    const policyRow = document.createElement('div');
    policyRow.className = 'metric';
    const policyLabel = document.createElement('span');
    policyLabel.className = 'metric-label';
    policyLabel.textContent = t('diagnosticsRestorePolicy', 'Restore policy');
    const policyValue = document.createElement('span');
    policyValue.className = 'metric-value';
    policyValue.textContent = this.info ? formatRestorePolicy(this.info.restorePolicy) : '--';
    this.restorePolicyEl = policyValue;
    policyRow.appendChild(policyLabel);
    policyRow.appendChild(policyValue);
    config.appendChild(policyRow);

    container.appendChild(config);

    // GPU/CPU per-effect timing section (populated from a profiler snapshot)
    const timingSection = document.createElement('div');
    timingSection.className = 'timing-section';
    timingSection.style.display = 'none';

    const timingTitle = document.createElement('div');
    timingTitle.className = 'timing-title';
    timingTitle.textContent = t('diagnosticsGpuTimings', 'GPU Timings');
    timingSection.appendChild(timingTitle);
    this.timingTitleEl = timingTitle;

    const timingStatus = document.createElement('div');
    timingStatus.className = 'timing-status';
    timingStatus.style.display = 'none';
    timingSection.appendChild(timingStatus);
    this.timingStatusEl = timingStatus;

    const timingGrid = document.createElement('div');
    timingGrid.className = 'timing-grid';
    timingGrid.style.display = 'none';
    timingSection.appendChild(timingGrid);
    this.timingGridEl = timingGrid;

    const timingNote = document.createElement('div');
    timingNote.className = 'diag__note timing-note';
    timingNote.style.display = 'none';
    timingSection.appendChild(timingNote);
    this.timingNoteEl = timingNote;

    const timingFrames = document.createElement('div');
    timingFrames.className = 'timing-frames';
    timingFrames.style.display = 'none';
    timingSection.appendChild(timingFrames);
    this.timingFramesEl = timingFrames;

    this.timingSectionEl = timingSection;
    container.appendChild(timingSection);

    this.shadowRoot.appendChild(container);

    // Start hidden
    this.host.style.display = 'none';

    // Observe video resizes
    this.resizeObserver = new ResizeObserver(() => this.updatePosition());
    this.resizeObserver.observe(this.video);
    this.updatePosition();

    // One-time capability probes. Both are bounded and wrapped so a hostile or
    // stubbed clock can never hang initialization.
    this.cpuTimingReliable = DiagnosticsOverlay.probeCpuTimingReliable();
    this.setupFrameBudget();
    this.applyEffectiveMode();
  }

  public show(): void {
    if (this.host) {
      this.host.style.display = 'block';
    }
  }

  public hide(): void {
    if (this.host) {
      this.host.style.display = 'none';
    }
  }

  /**
   * Select how much detail the HUD renders. `'auto'` uses the compact layout
   * when the video rect is small (see {@link updatePosition}); `'expanded'`
   * always renders the full HUD and `'compact'` always renders the minimal one.
   * Additive; safe to call before or after {@link show}/{@link hide}.
   */
  public setDetailMode(mode: DiagnosticsDetailMode): void {
    if (this.detailMode === mode) {
      this.applyEffectiveMode();
      return;
    }
    this.detailMode = mode;
    this.applyEffectiveMode();
  }

  /** The currently selected detail mode (not the effective auto-resolved one). */
  public getDetailMode(): DiagnosticsDetailMode {
    return this.detailMode;
  }

  private frameLabelText(compact: boolean): string {
    const label = t('diagnosticsFrameLabel', 'Frame');
    return compact ? label : `${label} \u00b7 ${this.frameBudgetMs.toFixed(1)} ms`;
  }

  private applyEffectiveMode(): void {
    const compact = this.detailMode === 'compact'
      || (this.detailMode === 'auto' && this.smallVideo);
    this.isCompact = compact;
    this.containerEl?.classList.toggle('is-compact', compact);

    if (this.frameLabelEl) {
      this.frameLabelEl.textContent = this.frameLabelText(compact);
    }
    if (this.adapterInfoEl) {
      this.adapterInfoEl.textContent = compact
        ? shortenAdapter(this.adapterInfo)
        : this.adapterInfo;
    }

    // Force the throttled pass table to re-render so per-mode label treatment
    // (middle-ellipsis vs wrapping) applies immediately.
    this.lastTimingRenderTime = Number.NEGATIVE_INFINITY;
    if (this.lastSnapshot && this.timingVisible) {
      this.renderTimingSection(this.lastSnapshot);
    }
  }

  /**
   * Detect whether `performance.now()` is fine-grained enough for per-pass CPU
   * measurement. Chrome clamps it to ~100 µs outside cross-origin-isolated
   * pages, making per-pass CPU deltas read as `0.00`/`0.10`. The loop is
   * hard-capped so a constant (stubbed) clock cannot spin forever; an
   * inconclusive probe is treated as coarse.
   */
  private static probeCpuTimingReliable(): boolean {
    try {
      const first = performance.now();
      let current = first;
      let iterations = 0;
      while (
        current === first
        && iterations < DiagnosticsOverlay.RESOLUTION_PROBE_MAX_ITERATIONS
      ) {
        current = performance.now();
        iterations += 1;
      }
      const resolution = current - first;
      return resolution > 0 && resolution < 0.05;
    } catch {
      return false;
    }
  }

  /**
   * One-time display-refresh probe: request a handful of animation frames and
   * use the median interval as the frame budget. Falls back to 60 Hz when rAF
   * is unavailable or the measurement is implausible. Never awaits; the value
   * is applied when the probe resolves.
   */
  private setupFrameBudget(): void {
    try {
      if (typeof requestAnimationFrame !== 'function') return;
      const deltas: number[] = [];
      let previous: number | null = null;
      let frames = 0;

      const tick = (timestamp: number): void => {
        try {
          // The overlay may have been destroyed between frames; nothing to do.
          if (!this.host) return;
          if (previous !== null) deltas.push(timestamp - previous);
          previous = timestamp;
          frames += 1;

          if (frames < DiagnosticsOverlay.BUDGET_PROBE_SAMPLES) {
            requestAnimationFrame(tick);
            return;
          }

          const measured = median(deltas);
          if (
            measured !== null
            && measured >= DiagnosticsOverlay.MIN_FRAME_BUDGET_MS
            && measured <= DiagnosticsOverlay.MAX_FRAME_BUDGET_MS
          ) {
            this.frameBudgetMs = measured;
            if (this.frameLabelEl && !this.isCompact) {
              this.frameLabelEl.textContent = this.frameLabelText(false);
            }
          }
        } catch {
          // Keep the fallback budget on any probe failure.
        }
      };

      requestAnimationFrame(tick);
    } catch {
      // Keep the fallback budget when rAF itself is unavailable.
    }
  }

  /**
   * Update one or more read-only configuration rows. Safe to call after
   * {@link destroy}: missing elements are simply skipped.
   */
  public setInfo(info: Partial<DiagnosticsInfo>): void {
    const base = this.info
      ?? { mode: '', performanceTier: '', inputResolution: '', targetResolution: '', restorePolicy: '' };
    this.info = { ...base, ...info };

    if (info.mode !== undefined && this.modeEl) {
      this.modeEl.textContent = info.mode;
    }
    if (info.performanceTier !== undefined && this.tierEl) {
      this.tierEl.textContent = info.performanceTier;
    }
    if (info.inputResolution !== undefined && this.inputResolutionEl) {
      this.inputResolutionEl.textContent = info.inputResolution;
    }
    if (info.targetResolution !== undefined && this.targetResolutionEl) {
      this.targetResolutionEl.textContent = info.targetResolution;
    }
    if (info.restorePolicy !== undefined && this.restorePolicyEl) {
      this.restorePolicyEl.textContent = formatRestorePolicy(info.restorePolicy);
    }
  }

  /**
   * Record one frame's metrics.
   *
   * `snapshot` is optional so existing two-argument callers keep working; when
   * omitted (or `null`) the GPU/CPU timing section stays hidden.
   */
  public update(
    frameTime: number,
    pipelineCount: number,
    snapshot?: ProfilerSnapshot | null,
  ): void {
    const now = performance.now();

    // Use wall-clock time between consecutive update() calls for FPS calculation.
    // The frameTime parameter (CPU processing time) is not used for display
    // because it doesn't reflect the actual frame rate (which is determined by
    // requestVideoFrameCallback, typically 24/30/60 fps).
    if (this.hasFirstUpdate) {
      const wallDelta = now - this.lastUpdateTime;
      // Reset the rolling buffer if a single delta is abnormally large (e.g. tab
      // was hidden, page was backgrounded, or initialization gap). This prevents
      // one bad delta from polluting the rolling average for up to 60 frames.
      if (wallDelta > DiagnosticsOverlay.MAX_REASONABLE_DELTA_MS) {
        this.frameTimes = [];
      } else {
        this.frameTimes.push(wallDelta);
        if (this.frameTimes.length > DiagnosticsOverlay.MAX_FRAME_TIMES) {
          this.frameTimes = this.frameTimes.slice(-DiagnosticsOverlay.MAX_FRAME_TIMES);
        }
      }
    }
    this.lastUpdateTime = now;
    this.hasFirstUpdate = true;

    const avgFrameTime = this.frameTimes.length > 0
      ? this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length
      : 0;
    const fps = avgFrameTime > 0 ? (1000 / avgFrameTime) : 0;
    const currentFrameTime = this.frameTimes.length > 0
      ? this.frameTimes[this.frameTimes.length - 1]
      : 0;
    // Per-frame processing cost is the larger of the CPU time already measured
    // for this frame and the GPU p50 reported by the profiler (0 when absent).
    const gpuMs = snapshot?.totalGpuP50 ?? 0;
    const processingMs = Math.max(frameTime, gpuMs);

    if (this.fpsEl) {
      this.fpsEl.textContent = fps.toFixed(2);
    }
    if (this.frameTimeEl) {
      this.frameTimeEl.textContent = `${currentFrameTime.toFixed(1)} ms`;
    }
    if (this.avgFrameTimeEl) {
      this.avgFrameTimeEl.textContent = `${avgFrameTime.toFixed(1)} ms`;
    }
    if (this.cpuEl) {
      this.cpuEl.textContent = `${frameTime.toFixed(1)} ms`;
    }
    if (this.pipelineCountEl) {
      this.pipelineCountEl.textContent = String(pipelineCount);
    }

    this.updateBudgetState(processingMs);
    this.updateTimingSection(snapshot, now);
  }

  /**
   * Encode the current per-frame processing cost relative to the display budget
   * via the bar fill and the frame row's `data-state` attribute (which also
   * drives the health dot). The cost is the larger of the CPU frame time and
   * the profiler's `totalGpuP50`, so the state reflects whether the renderer's
   * per-frame processing fits one display refresh interval.
   */
  private updateBudgetState(processingMs: number): void {
    const rawPct = this.frameBudgetMs > 0
      ? (processingMs / this.frameBudgetMs) * 100
      : 0;

    let state: BudgetState = 'ok';
    if (rawPct > 100) state = 'over';
    else if (rawPct >= 90) state = 'warn';

    if (state !== this.lastBudgetState) {
      this.lastBudgetState = state;
      this.containerEl?.setAttribute('data-state', state);
      this.frameRowEl?.setAttribute('data-state', state);
    }

    if (this.budgetFillEl) {
      this.budgetFillEl.style.width = `${Math.min(100, Math.max(0, rawPct))}%`;
    }
  }

  /**
   * Show/hide and (throttled) rebuild the timing section from the latest
   * snapshot. Visibility changes are applied immediately; the pass table is
   * only rebuilt every {@link DiagnosticsOverlay.TIMING_THROTTLE_MS} so the HUD
   * is not thrashed on every frame.
   */
  private updateTimingSection(snapshot: ProfilerSnapshot | null | undefined, now: number): void {
    const section = this.timingSectionEl;
    if (!section) return;

    if (snapshot != null) {
      this.lastSnapshot = snapshot;
    }

    const shouldShow = snapshot != null
      && (snapshot.status !== 'active' || snapshot.passes.length > 0);
    if (!shouldShow) {
      if (this.timingVisible) {
        section.style.display = 'none';
        this.timingVisible = false;
        this.clearTimingSection();
      }
      return;
    }

    const becameVisible = !this.timingVisible;
    section.style.display = 'block';
    this.timingVisible = true;

    // A non-active status is a single, cheap line and must replace any rows
    // immediately so a degraded/destroyed profiler never leaves stale data.
    if (snapshot.status !== 'active' || becameVisible) {
      this.lastTimingRenderTime = now;
      this.renderTimingSection(snapshot);
      return;
    }

    if (now - this.lastTimingRenderTime < DiagnosticsOverlay.TIMING_THROTTLE_MS) {
      return;
    }
    this.lastTimingRenderTime = now;
    this.renderTimingSection(snapshot);
  }

  private renderTimingSection(snapshot: ProfilerSnapshot): void {
    const title = this.timingTitleEl;
    const status = this.timingStatusEl;
    const grid = this.timingGridEl;
    const note = this.timingNoteEl;
    const frames = this.timingFramesEl;
    if (!title || !status || !grid || !note || !frames) return;

    grid.replaceChildren();
    frames.textContent = '';

    if (snapshot.status !== 'active') {
      title.style.display = 'none';
      grid.style.display = 'none';
      note.style.display = 'none';
      frames.style.display = 'none';
      status.textContent = t('diagnosticsGpuTimingsUnavailable', 'GPU timings unavailable');
      status.style.display = 'block';
      this.renderGpuShare(snapshot);
      return;
    }

    title.style.display = 'block';
    status.style.display = 'none';
    status.textContent = '';
    grid.style.display = 'grid';
    frames.style.display = 'block';

    const showCpu = this.cpuTimingReliable;
    grid.classList.toggle('timing-grid--gpu-only', !showCpu);
    if (showCpu) {
      note.style.display = 'none';
      note.textContent = '';
    } else {
      note.style.display = 'block';
      note.textContent = t('diagnosticsCpuTimingLimited', 'CPU timings limited to 0.1 ms');
    }

    grid.appendChild(this.createTimingCell(t('diagnosticsTimingPass', 'Pass'), 'timing-pass timing-head'));
    if (showCpu) {
      grid.appendChild(this.createTimingCell(t('diagnosticsTimingCpuP50', 'CPU p50'), 'timing-cell timing-head'));
      grid.appendChild(this.createTimingCell(t('diagnosticsTimingCpuP95', 'CPU p95'), 'timing-cell timing-head'));
    }
    grid.appendChild(this.createTimingCell(t('diagnosticsTimingGpuP50', 'GPU p50'), 'timing-cell timing-head'));
    grid.appendChild(this.createTimingCell(t('diagnosticsTimingGpuP95', 'GPU p95'), 'timing-cell timing-head'));
    grid.appendChild(this.createTimingCell(t('diagnosticsTimingGpuP99', 'GPU p99'), 'timing-cell timing-head'));

    const maxGpu = snapshot.passes.reduce(
      (max, pass) => Math.max(max, pass.gpuP50 ?? 0),
      0,
    );
    const topPass = maxGpu > 0
      ? snapshot.passes.find((pass) => (pass.gpuP50 ?? 0) === maxGpu)
      : undefined;

    for (const pass of snapshot.passes) {
      const isTop = topPass !== undefined && pass === topPass;
      const displayLabel = this.isCompact
        ? truncateMiddle(pass.label, DiagnosticsOverlay.COMPACT_PASS_LABEL_MAX)
        : pass.label;

      const passCell = this.createTimingCell(displayLabel, 'timing-pass');
      const heat = maxGpu > 0 ? Math.min(1, (pass.gpuP50 ?? 0) / maxGpu) : 0;
      passCell.style.setProperty('--heat', String(heat));
      if (isTop) passCell.classList.add('timing-pass--hot');
      if (pass.gpuP50 !== undefined && pass.gpuP50 > this.frameBudgetMs) {
        passCell.classList.add('timing-pass--over');
      } else if (pass.gpuP50 !== undefined && pass.gpuP50 > this.frameBudgetMs * 0.5 && pass.gpuP50 > 0) {
        passCell.classList.add('timing-pass--warn');
      }
      grid.appendChild(passCell);

      if (showCpu) {
        grid.appendChild(this.createTimingCell(formatTimingMs(pass.cpuP50), 'timing-cell'));
        grid.appendChild(this.createTimingCell(formatTimingMs(pass.cpuP95), 'timing-cell'));
      }
      grid.appendChild(this.createTimingCell(
        formatTimingMs(pass.gpuP50),
        isTop ? 'timing-cell timing-cell--top' : 'timing-cell',
      ));
      grid.appendChild(this.createTimingCell(formatTimingMs(pass.gpuP95), 'timing-cell'));
      grid.appendChild(this.createTimingCell(formatTimingMs(pass.gpuP99), 'timing-cell'));
    }

    // Total GPU row aligns under the GPU columns; total has no p99.
    grid.appendChild(this.createTimingCell(t('diagnosticsTimingTotal', 'Total GPU'), 'timing-pass timing-total'));
    if (showCpu) {
      grid.appendChild(this.createTimingCell('', 'timing-cell'));
      grid.appendChild(this.createTimingCell('', 'timing-cell'));
    }
    grid.appendChild(this.createTimingCell(formatTimingMs(snapshot.totalGpuP50), 'timing-cell timing-total'));
    grid.appendChild(this.createTimingCell(formatTimingMs(snapshot.totalGpuP95), 'timing-cell timing-total'));
    grid.appendChild(this.createTimingCell('', 'timing-cell'));

    frames.textContent = `${t('diagnosticsFramesSampled', 'Frames sampled')}: ${snapshot.framesSampled}`;
    this.renderGpuShare(snapshot);
  }

  /** Compact-only summary of GPU cost as a share of the frame budget. */
  private renderGpuShare(snapshot: ProfilerSnapshot): void {
    if (!this.gpuShareEl) return;
    const label = t('diagnosticsGpuShare', 'GPU');
    const p50 = snapshot.totalGpuP50;
    if (p50 === null || !Number.isFinite(p50)) {
      this.gpuShareEl.textContent = `${label} \u2014`;
      return;
    }
    const pct = Math.round((p50 / this.frameBudgetMs) * 100);
    this.gpuShareEl.textContent = `${label} ${p50.toFixed(1)} / ${this.frameBudgetMs.toFixed(1)} ms \u00b7 ${pct}%`;
  }

  private createTimingCell(text: string, className: string): HTMLElement {
    const cell = document.createElement('span');
    cell.className = className;
    cell.textContent = text;
    return cell;
  }

  private clearTimingSection(): void {
    this.timingGridEl?.replaceChildren();
    if (this.timingStatusEl) this.timingStatusEl.textContent = '';
    if (this.timingNoteEl) {
      this.timingNoteEl.textContent = '';
      this.timingNoteEl.style.display = 'none';
    }
    if (this.timingFramesEl) this.timingFramesEl.textContent = '';
    if (this.gpuShareEl) this.gpuShareEl.textContent = '';
  }

  private updatePosition(): void {
    if (!this.host) return;

    const rect = this.video.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      this.host.style.display = 'none';
      return;
    }

    const parentRect = this.video.parentElement?.getBoundingClientRect() ?? { left: 0, top: 0 };
    this.host.style.left = `${rect.left - parentRect.left}px`;
    this.host.style.top = `${rect.top - parentRect.top}px`;
    this.host.style.width = `${rect.width}px`;
    this.host.style.height = `${rect.height}px`;

    const small = rect.width < DiagnosticsOverlay.COMPACT_MIN_WIDTH
      || rect.height < DiagnosticsOverlay.COMPACT_MIN_HEIGHT;
    if (small !== this.smallVideo) {
      this.smallVideo = small;
      this.applyEffectiveMode();
    }
  }

  public destroy(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.host) {
      this.host.remove();
      this.host = null;
      this.shadowRoot = null;
    }
    this.containerEl = null;
    this.fpsEl = null;
    this.frameLabelEl = null;
    this.frameRowEl = null;
    this.budgetFillEl = null;
    this.frameTimeEl = null;
    this.avgFrameTimeEl = null;
    this.cpuEl = null;
    this.pipelineCountEl = null;
    this.adapterInfoEl = null;
    this.gpuShareEl = null;
    this.timingSectionEl = null;
    this.timingTitleEl = null;
    this.timingStatusEl = null;
    this.timingGridEl = null;
    this.timingNoteEl = null;
    this.timingFramesEl = null;
    this.modeEl = null;
    this.tierEl = null;
    this.inputResolutionEl = null;
    this.targetResolutionEl = null;
    this.restorePolicyEl = null;
    this.timingVisible = false;
    this.lastTimingRenderTime = Number.NEGATIVE_INFINITY;
    this.lastSnapshot = null;
    this.isCompact = false;
    this.lastBudgetState = 'ok';
  }
}
