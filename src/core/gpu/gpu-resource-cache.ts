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
 * - Creation is wrapped in a `pushErrorScope('validation')` / `popErrorScope()`
 *   pair when the device implements them (feature-detected — some mocks and older
 *   devices do not). For synchronous creators the pop result is inherently
 *   asynchronous, so a validation error is logged rather than thrown (a sync API
 *   cannot await it). `createAsync` pops the scope synchronously before awaiting
 *   the creation promise, so concurrent creations never cross-pop each other's
 *   scope (a WebGPU error scope is a LIFO stack).
 */

// ─── Error scope feature-detection helpers ───

function supportsErrorScope(device: GPUDevice): boolean {
  const candidate = device as Partial<GPUDevice>;
  return typeof candidate.pushErrorScope === 'function' && typeof candidate.popErrorScope === 'function';
}

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

    const module = this.createSync(device, 'shader module', label ?? 'shader', () =>
      device.createShaderModule({ code, label }),
    );
    cache.set(key, module);
    return module;
  }

  /** Drop only `device`'s caches (device loss / teardown). */
  release(device: GPUDevice): void {
    // `WeakMap.delete` is a no-op for an unknown device, so repeated calls and
    // releasing a device that was never used are both safe.
    this.caches.delete(device);
  }

  // ─── Internal creation helpers ───

  private createSync<T>(device: GPUDevice, kind: string, key: string, create: () => T): T {
    if (!supportsErrorScope(device)) {
      try {
        return create();
      } catch (error) {
        throw wrapCreationError(kind, key, error);
      }
    }

    let pushed = false;
    try {
      device.pushErrorScope('validation');
      pushed = true;
    } catch {
      // push failed despite feature detection — proceed without a scope.
    }
    if (!pushed) {
      try {
        return create();
      } catch (error) {
        throw wrapCreationError(kind, key, error);
      }
    }

    let result: T | undefined;
    let createError: unknown;
    let createFailed = false;
    try {
      result = create();
    } catch (error) {
      createError = error;
      createFailed = true;
    }

    // Balance the scope. For synchronous creators the pop result is inherently
    // asynchronous; surface it for diagnostics but do not throw from a sync API.
    try {
      const popResult = device.popErrorScope();
      if (popResult && typeof popResult.then === 'function') {
        popResult
          .then(error => {
            if (error) {
              console.error(
                `[GpuResourceCache] GPU validation error creating ${kind} "${key}": ${error.message}`,
              );
            }
          })
          .catch(() => {
            // A misbehaving mock/device pop must not escape as an unhandled rejection.
          });
      }
    } catch {
      // Pop unavailable despite feature detection — ignore.
    }

    if (createFailed) throw wrapCreationError(kind, key, createError);
    return result as T;
  }

  private async createAsync<T>(
    device: GPUDevice,
    kind: string,
    key: string,
    create: () => Promise<T>,
  ): Promise<T> {
    if (!supportsErrorScope(device)) {
      try {
        return await create();
      } catch (error) {
        throw wrapCreationError(kind, key, error);
      }
    }

    let pushed = false;
    try {
      device.pushErrorScope('validation');
      pushed = true;
    } catch {
      // push failed despite feature detection — proceed without a scope.
    }

    // Invoke the creator and pop the scope in the same synchronous stretch.
    // WebGPU error scopes are a LIFO stack, so holding one open across an
    // `await` would let two concurrent creations pop each other's scope and
    // misattribute validation errors. The returned promise is awaited only
    // after the scope has been popped, so pending creations never overlap
    // scopes on the device.
    let createPromise: Promise<T> | undefined;
    let createError: unknown;
    let createFailed = false;
    try {
      createPromise = create();
    } catch (error) {
      createError = error;
      createFailed = true;
    }

    let popResult: Promise<GPUError | null> | null = null;
    if (pushed) {
      try {
        popResult = device.popErrorScope();
      } catch {
        popResult = null;
      }
    }

    let result: T | undefined;
    if (createPromise) {
      try {
        result = await createPromise;
      } catch (error) {
        createError = error;
        createFailed = true;
      }
    }

    let validationError: GPUError | null = null;
    if (popResult) {
      try {
        validationError = await popResult;
      } catch {
        validationError = null;
      }
    }

    if (validationError) {
      throw new Error(
        `[GpuResourceCache] GPU validation failed for ${kind} "${key}": ${validationError.message}`,
      );
    }
    if (createFailed) throw wrapCreationError(kind, key, createError);
    return result as T;
  }
}

/**
 * Shared cache for the extension's own shader construction.
 *
 * Keyed per `GPUDevice`; call {@link GpuResourceCache.release} on device loss or
 * teardown.
 */
export const gpuResourceCache = new GpuResourceCache();
