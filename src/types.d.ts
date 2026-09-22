// ===== Anime4K Library Types =====
import type { Anime4KPipeline } from 'anime4k-webgpu-async';
import type { ProfilerSnapshot } from './core/gpu/gpu-timestamp-profiler';

// ===== CSS Module Declarations =====
declare module "*.css";

// ===== Performance Tier Type =====
type PerformanceTier = 'performance' | 'balanced' | 'quality' | 'ultra';

// ===== Base Mode Type =====
type BaseMode = 'A' | 'B' | 'C' | 'A+A' | 'B+B' | 'C+A';

// Whitelist rule interface
interface WhitelistRule {
  pattern: string;
  enabled: boolean;
}

// Enhancement effect interface
interface EnhancementEffect {
  id: string;       // Unique ID, e.g., "anime4k/Upscale/CNNx2VL"
  name: string;     // Display name, e.g., "Upscale CNNx2VL"
  className: string; // Class name used for instantiation in code, e.g., "CNNx2VL"
  backendId?: string; // Engine backend id, e.g. "anime4k" | "core"; absent ⇒ resolve by id/className
  key?: string;       // Backend-local effect key; defaults to className
  params?: Record<string, number>; // Effect parameter configuration (all numeric values)
  upscaleFactor?: number; // Upscale factor of the effect, e.g. 2 means 2x upscale
}

// ===== Built-in Mode Interface (effect chain determined by tier) =====
interface BuiltInMode {
  id: string;          // 'builtin-mode-a'
  baseMode: BaseMode;  // 'A'
  name: string;        // 'Mode A'
  isBuiltIn: true;
}

// ===== Custom Mode Interface (effect chain fully user-controlled) =====
interface CustomMode {
  id: string;
  name: string;
  isBuiltIn: false;
  effects: EnhancementEffect[];
}

// Unified enhancement mode type
type EnhancementMode = BuiltInMode | CustomMode;

// ===== Param Slider Configuration (for options UI) =====
interface ParamSliderConfig {
  paramKey: string;       // e.g. 'sharpness', 'strength'
  labelKey: string;       // i18n key
  labelFallback: string;  // fallback text
  sliderMin: number;
  sliderMax: number;
  defaultValue: number;
  toSlider: (v: number) => number;   // param value → slider position
  fromSlider: (v: number) => number; // slider position → param value
  formatValue: (v: number) => string; // display format
}

// ===== Effect Class Descriptor (constructor parameter) =====
interface EffectClassDescriptor {
  device: GPUDevice;
  inputTexture: GPUTexture;
  [key: string]: unknown;
}

// ===== Anime4K Pipeline Types =====

/** Anime4K pipeline with optional destroy() that some implementations expose. */
interface DestroyablePipeline extends Anime4KPipeline {
  destroy?(): void;
}

/** Shape of pipeline objects traversed by safeDestroy -- expose destroy + optional children. */
interface DisposablePipeline {
  destroy?: () => void;
  pipelines?: unknown[];
  outputTexture?: { destroy?: () => void };
}

// ===== WebGPU Extension Types =====

/** GPU adapter info (Chrome's deprecated requestAdapterInfo() API, pre-Chrome 113). */
interface GPUAdapterInfo {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
}

/** GPU adapter with the deprecated requestAdapterInfo() method. */
interface GPUAdapterWithInfo {
  requestAdapterInfo?: () => Promise<GPUAdapterInfo>;
}

// ===== Scheduler API (Chrome 115+, not yet in standard lib.dom.d.ts) =====

/** scheduler.yield() gives input events priority over animation frames. */
declare global {
  interface Scheduler {
    yield(): Promise<void>;
  }
}

// ===== GPU Benchmark Result Interface =====
interface GPUBenchmarkResult {
  tier: PerformanceTier;
  scores: Record<PerformanceTier, number>;       // Average frame time per tier (ms)
  maxScores: Record<PerformanceTier, number>;    // Max frame time per tier (ms)
  timestamp: number;
  adapterInfo: string;
}

// ===== Color Grading Settings =====
interface ColorGradingSettings {
  enabled: boolean;
  brightness: number;  // [-1, 1], default 0
  gamma: number;       // [0.1, 4], default 1
  contrast: number;    // [0, 2], default 1
  saturation: number;  // [0, 2], default 1
  vibrance: number;    // [-1, 1], default 0
  exposure: number;    // [-3, 3], default 0 (in stops)
}

// ===== Cross-device Synced Settings (storage.sync) =====
interface SyncedSettings {
  selectedModeId: string;
  targetResolutionSetting: string;
  whitelistEnabled: boolean;
  whitelist: WhitelistRule[];
  customModes: CustomMode[];
  enableCrossOriginFix: boolean;
  autoEnableOnWhitelist: boolean;
  autoEnableSettleMs: number;
  enableHotkey: boolean;
  colorGrading: ColorGradingSettings;
}

/**
 * How much detail the on-video diagnostics HUD renders.
 * - `auto`     — expanded, but compact automatically on small video rects;
 * - `compact`  — minimal always-on HUD (FPS / frame budget / GPU share);
 * - `expanded` — full metric block plus the per-pass GPU timing table.
 */
type DiagnosticsDetailMode = 'auto' | 'compact' | 'expanded';

/**
 * Restore-pass policy for the emitted effect chain.
 * - `off`      — keep every restore (full V1 chain), no gating;
 * - `gate`     — keep every restore, then gate each one by local luma;
 * - `trailing` — drop restores after the final Downscale (no gating);
 * - `leading`  — drop restores before the first retained upscaler.
 */
type RestorePolicy = 'off' | 'gate' | 'trailing' | 'leading';

// ===== Local-only Settings (storage.local) =====
interface LocalSettings {
  performanceTier: PerformanceTier;
  gpuBenchmarkResult: GPUBenchmarkResult | null;

  hasCompletedOnboarding: boolean;
  showDiagnostics: boolean;
  /** Diagnostics HUD detail level; defaults to `'auto'`. */
  diagnosticsDetail?: DiagnosticsDetailMode;
  /**
   * Restore-pass policy applied to all modes, built-in and custom. Defaults to
   * `'gate'` (keep every restore, local-luma gating each one) for
   * fresh/normalized-missing values. Persisted locally.
   */
  restorePolicy?: RestorePolicy;
}

// ===== Runtime-merged Full Settings =====
interface Anime4KWebExtSettings extends SyncedSettings {
  performanceTier: PerformanceTier;
  // Built-in modes are dynamically generated at runtime and merged with customModes
  enhancementModes: EnhancementMode[];
}

// Dimensions interface
interface Dimensions {
  width: number;
  height: number;
}

// ===== GPU Benchmark Progress Interface =====
interface BenchmarkProgress {
  tier: string;
  progress: number;
  completed: boolean;
  error?: string;
}

// ===== Runtime Message Types (type-safe message passing) =====
type SettingsUpdatePayload = Partial<SyncedSettings> & { performanceTier?: PerformanceTier };

type RuntimeMessage =
  | { type: 'SETTINGS_UPDATED'; settings?: SettingsUpdatePayload; modifiedModeId?: string }
  | { type: 'URL_UPDATED'; url: string }
  | { type: 'OPEN_OPTIONS_PAGE' }
  | { type: 'OPEN_ONBOARDING' }
  | { type: 'WHITELIST_UPDATED' }
  | { type: 'TOGGLE_ENHANCEMENT' };

// ===== Renderer Options Interface =====
interface RendererOptions {
  /** Video player element */
  video: HTMLVideoElement;
  /** Canvas element used for rendering */
  canvas: HTMLCanvasElement;
  /** Array of enhancement effects to apply */
  effects: EnhancementEffect[];
  /** Target resolution for rendering */
  targetDimensions: Dimensions;
  /** Callback function invoked when a runtime error occurs */
  onError?: (error: Error) => void;
  /** Callback function invoked when the first frame is successfully rendered */
  onFirstFrameRendered?: () => void;
  /**
   * Callback invoked after each successfully rendered frame with the frame time
   * in ms, when GPU timings are enabled the latest profiler snapshot, and the
   * number of GPU pipeline stages that were built/executed for the frame
   * (excluding the final blit).
   */
  onFrameRendered?: (frameTime: number, profiler?: ProfilerSnapshot | null, pipelineCount?: number) => void;
  /** Initialization progress callback function */
  onProgress?: (stage: string | null, current?: number, total?: number) => void;
  /**
   * Enables GPU timestamp profiling via the optional `timestamp-query` feature.
   * Profiling is silently skipped when the feature is unavailable.
   */
  enableGpuTimings?: boolean;
  /**
   * Restore-pass policy. Applies to all modes: `'gate'` (default) keeps every
   * restore and wraps each one in the local-luma gate; `'off'` keeps every
   * restore without gating; `'trailing'` drops restores after the target-exact
   * final Downscale; `'leading'` drops restores before the first retained
   * upscaler.
   */
  restorePolicy?: RestorePolicy;
}

// Export interfaces for use by other modules
export {
  PerformanceTier,
  BaseMode,
  Anime4KWebExtSettings,
  SyncedSettings,
  LocalSettings,
  DiagnosticsDetailMode,
  RestorePolicy,
  ColorGradingSettings,
  Dimensions,
  WhitelistRule,
  EnhancementEffect,
  EnhancementMode,
  BuiltInMode,
  CustomMode,
  GPUBenchmarkResult,
  ParamSliderConfig,
  EffectClassDescriptor,
  DestroyablePipeline,
  DisposablePipeline,
  GPUAdapterInfo,
  GPUAdapterWithInfo,
  BenchmarkProgress,
  SettingsUpdatePayload,
  RuntimeMessage,
  RendererOptions,
};