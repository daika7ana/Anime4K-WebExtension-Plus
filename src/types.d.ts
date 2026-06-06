// ===== CSS Module Declarations =====
declare module "*.css";

// ===== Performance Tier Type =====
type PerformanceTier = 'performance' | 'balanced' | 'quality' | 'ultra';

// ===== Base Mode Type =====
type BaseMode = 'A' | 'B' | 'C' | 'A+A' | 'B+B' | 'C+A';

// Video enhancer interface
interface VideoEnhancer {
  destroy: () => void;
  toggleEnhancement: () => Promise<void>;
  getCurrentModeId: () => string | null;
  updateSettings: (settings: Anime4KWebExtSettings) => Promise<void>;
  getVideoElement: () => HTMLVideoElement;
  detach: () => void;
  reattach: (newVideo: HTMLVideoElement) => Promise<void>;
}

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

// Export interfaces for use by other modules
export {
  PerformanceTier,
  BaseMode,
  VideoEnhancer,
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
};