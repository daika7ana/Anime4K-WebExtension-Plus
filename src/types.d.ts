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
  params?: { [key: string]: any }; // Could be used in the future for effect parameter configuration
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

// ===== Effect Class Name (for param-slider registry) =====
// Class names of effects that expose a user-tunable param.
// Kept in sync with PARAM_REGISTRY keys — TypeScript will flag any drift.
type EffectClassName = 'CAS' | 'DoG' | 'BilateralMean' | 'Debanding';

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

// ===== Custom Effect Descriptor (for renderer custom-effect registry) =====
interface CustomEffectDescriptor {
  EffectClass: new (descriptor: any) => unknown;
  getDescriptor: (
    device: GPUDevice,
    inputTexture: GPUTexture,
    params?: { [key: string]: any },
  ) => Record<string, unknown>;
}

// ===== GPU Benchmark Result Interface =====
interface GPUBenchmarkResult {
  tier: PerformanceTier;
  scores: Record<PerformanceTier, number>;       // Average frame time per tier (ms)
  maxScores: Record<PerformanceTier, number>;    // Max frame time per tier (ms)
  timestamp: number;
  adapterInfo: string;
}

// ===== Cross-device Synced Settings (storage.sync) =====
interface SyncedSettings {
  selectedModeId: string;
  targetResolutionSetting: string;
  whitelistEnabled: boolean;
  whitelist: WhitelistRule[];
  customModes: CustomMode[];
  enableCrossOriginFix: boolean;
}

// ===== Local-only Settings (storage.local) =====
interface LocalSettings {
  performanceTier: PerformanceTier;
  gpuBenchmarkResult: GPUBenchmarkResult | null;

  hasCompletedOnboarding: boolean;
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
  /** Initialization progress callback function */
  onProgress?: (stage: string | null, current?: number, total?: number) => void;
}

// Export interfaces for use by other modules
export {
  PerformanceTier,
  BaseMode,
  Anime4KWebExtSettings,
  SyncedSettings,
  LocalSettings,
  Dimensions,
  WhitelistRule,
  EnhancementEffect,
  EnhancementMode,
  BuiltInMode,
  CustomMode,
  GPUBenchmarkResult,
  EffectClassName,
  ParamSliderConfig,
  CustomEffectDescriptor,
  BenchmarkProgress,
  RendererOptions,
};