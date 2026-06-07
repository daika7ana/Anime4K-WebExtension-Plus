/**
 * GPU Device Manager — manages GPU adapter/device lifecycle, pre-warming, and recovery.
 *
 * Extracted from Renderer to isolate device acquisition responsibilities.
 * Handles:
 *  - Pre-warming GPU adapter/device so they're ready when the user clicks Enhance
 *  - Claiming pre-warmed device (one-time transfer to a Renderer)
 *  - Requesting fresh GPU devices with appropriate limits
 *  - Invalidating pre-warm cache after device loss or destruction
 */
import { PipelinePreWarmer } from './pipeline-prewarmer';

// --- Static GPU pre-warm state (shared across all Renderer instances) ---
let prewarmedAdapter: GPUAdapter | null = null;
let prewarmedDevice: GPUDevice | null = null;
let prewarmPromise: Promise<void> | null = null;
let prewarmTimeoutId: ReturnType<typeof setTimeout> | null = null;

// --- Shader pre-warm state (shared across all Renderer instances) ---
const preWarmer = new PipelinePreWarmer();

/**
 * Pre-request GPU adapter and device so they're ready when the user clicks Enhance.
 * This warms the GPU driver and saves 50-100ms during initialization.
 * Safe to call multiple times — only the first call does work.
 */
export function preWarmGPU(): void {
  if (prewarmPromise) return;
  prewarmPromise = (async () => {
    try {
      if (!navigator.gpu) return;
      const adapterOptions: GPURequestAdapterOptions = {};
      if (!navigator.platform.startsWith('Win')) {
        adapterOptions.powerPreference = 'high-performance';
      }
      const adapter = await navigator.gpu.requestAdapter(adapterOptions);
      if (!adapter) return;
      prewarmedAdapter = adapter;
      const adapterLimits = adapter.limits;
      prewarmedDevice = await adapter.requestDevice({
        requiredLimits: {
          maxBufferSize: adapterLimits.maxBufferSize,
          maxStorageBufferBindingSize: adapterLimits.maxStorageBufferBindingSize,
        },
      });

      // Auto-destroy prewarmed device if unclaimed after 30 seconds
      prewarmTimeoutId = setTimeout(() => {
        if (prewarmedDevice) {
          console.log('[Anime4KWebExt] Prewarmed GPU device unclaimed after 30s, releasing.');
          prewarmedDevice.destroy();
          prewarmedDevice = null;
          prewarmedAdapter = null;
        }
        prewarmTimeoutId = null;
      }, 30000);
    } catch {
      // Pre-warm is best-effort; errors are non-fatal
    }
  })();
}

/**
 * Claim the pre-warmed GPU device for use by a Renderer.
 * Returns the device if available, or null if no pre-warmed device exists.
 * After claiming, the cached device is cleared so each renderer gets its own.
 * Sharing a single device across renderers would cause use-after-destroy
 * when one renderer's destroy() kills the shared device.
 */
export function claimPreWarmedDevice(): GPUDevice | null {
  if (prewarmedDevice) {
    const device = prewarmedDevice;
    prewarmedDevice = null;
    prewarmedAdapter = null;
    // Cancel the 30s auto-destroy timer
    if (prewarmTimeoutId) {
      clearTimeout(prewarmTimeoutId);
      prewarmTimeoutId = null;
    }
    return device;
  }
  return null;
}

/**
 * Request a fresh GPU adapter and device with appropriate limits.
 * Sets high-performance power preference on non-Windows platforms.
 * Requests maximum buffer sizes supported by the adapter for high-res video processing.
 */
export async function requestGPUDevice(): Promise<{ device: GPUDevice; adapter: GPUAdapter }> {
  const adapterOptions: GPURequestAdapterOptions = {};
  // Setting powerPreference on Windows produces a warning, so only use it on other platforms
  if (!navigator.platform.startsWith('Win')) {
    adapterOptions.powerPreference = 'high-performance';
  }
  const adapter = await navigator.gpu.requestAdapter(adapterOptions);
  if (!adapter) {
    throw new Error('WebGPU not supported: No adapter found.');
  }
  const adapterLimits = adapter.limits;
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxBufferSize: adapterLimits.maxBufferSize,
      maxStorageBufferBindingSize: adapterLimits.maxStorageBufferBindingSize,
    },
  });
  return { device, adapter };
}

/**
 * Invalidate the pre-warm cache (adapter, device, promise, and shader cache).
 * Called after device loss or renderer destruction, since the new device
 * has a separate shader cache and the old adapter/device are no longer valid.
 */
export function invalidatePreWarm(): void {
  preWarmer.invalidate();
  // Destroy the prewarmed device to prevent GPU resource leak
  try { prewarmedDevice?.destroy(); } catch { /* already destroyed */ }
  // Cancel the 30s auto-destroy timer if still pending
  if (prewarmTimeoutId) {
    clearTimeout(prewarmTimeoutId);
    prewarmTimeoutId = null;
  }
  prewarmPromise = null;
  prewarmedDevice = null;
  prewarmedAdapter = null;
}

/**
 * Get the shared PipelinePreWarmer instance for shader pre-warming.
 */
export function getPreWarmer(): PipelinePreWarmer {
  return preWarmer;
}
