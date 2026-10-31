/**
 * GPU Resource Cache — per-device de-duplication of immutable WebGPU resources.
 *
 * Shader modules are immutable and safe to share across pipeline instances, so
 * this cache returns the *same* module for a semantically identical request.
 *
 * Design
 * ------
 * - One `GpuResourceCache` instance owns a `WeakMap<GPUDevice, Map<string, GPUShaderModule>>`,
 *   so entry lifetime is tied to the device and a device can be dropped with
 *   {@link GpuResourceCache.release}. A shared singleton ({@link gpuResourceCache})
 *   is exported for the extension's own shader construction.
 * - Shader modules are keyed by their WGSL `code` (plus optional label).
 * - A synchronous creation failure (`createShaderModule` throwing) is wrapped
 *   with the requested kind/key so callers get an actionable message.
 */

function wrapCreationError(kind: string, key: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`[GpuResourceCache] Failed to create ${kind} "${key}": ${message}`);
}

// ─── Cache ───

/**
 * Per-device cache of immutable WebGPU resources.
 *
 * See the module header for key-identity and error-handling semantics.
 */
export class GpuResourceCache {
  private readonly caches = new WeakMap<GPUDevice, Map<string, GPUShaderModule>>();

  private cacheFor(device: GPUDevice): Map<string, GPUShaderModule> {
    let cache = this.caches.get(device);
    if (!cache) {
      cache = new Map();
      this.caches.set(device, cache);
    }
    return cache;
  }

  /**
   * Return a cached shader module for `code`, creating it once per device.
   * The optional `label` is forwarded to the descriptor and used in log messages.
   */
  getShaderModule(device: GPUDevice, code: string, label?: string): GPUShaderModule {
    const cache = this.cacheFor(device);
    const key = `shader:${label ?? ''}\u0000${code}`;
    const existing = cache.get(key);
    if (existing) return existing;

    let module: GPUShaderModule;
    try {
      module = device.createShaderModule({ code, label });
    } catch (error) {
      throw wrapCreationError('shader module', label ?? 'shader', error);
    }
    cache.set(key, module);
    return module;
  }

  /** Drop only `device`'s caches (device loss / teardown). */
  release(device: GPUDevice): void {
    // `WeakMap.delete` is a no-op for an unknown device, so repeated calls and
    // releasing a device that was never used are both safe.
    this.caches.delete(device);
  }
}

/**
 * Shared cache for the extension's own shader construction.
 *
 * Keyed per `GPUDevice`; call {@link GpuResourceCache.release} on device loss or
 * teardown.
 */
export const gpuResourceCache = new GpuResourceCache();
