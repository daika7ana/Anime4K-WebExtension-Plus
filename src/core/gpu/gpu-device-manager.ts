/**
 * GPU Device Manager — manages shared GPU adapter/device lifecycle, ref-counted
 * leasing, pre-warming, and loss-driven recovery.
 *
 * Extracted from Renderer to isolate device acquisition responsibilities.
 * Handles:
 *  - Pre-warming a GPU adapter/device so it's ready when the user clicks Enhance
 *  - Ref-counted, shared GPUDevice leases so multiple renderers can share one device
 *  - Requesting fresh GPU devices with appropriate limits
 *  - Invalidating the shader pre-warm cache after device loss or destruction
 *
 * Sharing model
 * -------------
 * Devices live in a module-level map keyed by the effective adapter request
 * (`powerPreference`, `forceFallbackAdapter`, `featureLevel`). Required limits
 * and the optional feature set are derived from whichever adapter answers the
 * request and every caller of a key performs the same derivation, so one shared
 * device per key is safe. The extension only ever issues the default request, so
 * in practice there is exactly one shared device. Concurrent acquires for the
 * same key are coalesced so callers share a single request.
 *
 * Loss observation
 * ----------------
 * Exactly ONE `device.lost` listener is attached per shared device. It marks the
 * record lost, removes it from the cache (so the next acquire requests a fresh
 * device), and notifies every subscriber registered through
 * {@link GpuDeviceLease.onLost}. The manager never calls `destroy()` on loss
 * because the device is already gone. Consumers observe loss through
 * `GpuDeviceLease.onLost()`; the raw `device.lost` promise is an implementation
 * detail.
 *
 * Lifecycle
 * ---------
 * `release()` decrements the lease count. When the count reaches zero the device
 * is destroyed and dropped from the cache — there is intentionally no idle
 * retention after the last release. A device created by {@link preWarmGPU} sits
 * at refCount 0 and is destroyed after 30 s if no lease claims it.
 */
import { PipelinePreWarmer } from './pipeline-prewarmer';

/**
 * A ref-counted lease on a shared {@link GPUDevice}.
 *
 * Releasing a lease never destroys the device while other leases remain.
 * Calling {@link GpuDeviceLease.release} more than once is a no-op.
 */
export interface GpuDeviceLease {
  readonly device: GPUDevice;
  readonly adapter: GPUAdapter;
  /** True once the underlying device has been lost/invalidated. */
  readonly lost: boolean;
  /**
   * Release this consumer's reference; the shared device is destroyed only when
   * the last lease is released. Idempotent.
   */
  release(): void;
  /**
   * Subscribe to device-loss notifications for the shared device. Returns an
   * unsubscribe function. If the device is already lost, `callback` fires
   * synchronously.
   */
  onLost(callback: (info: GPUDeviceLostInfo) => void): () => void;
}

/** One shared device and its outstanding-lease bookkeeping. */
interface SharedDevice {
  device: GPUDevice;
  adapter: GPUAdapter;
  /** Registry key this record is stored under (for cache eviction). */
  key: string;
  /** Number of outstanding leases. */
  refCount: number;
  lost: boolean;
  lostInfo: GPUDeviceLostInfo | null;
  lostCallbacks: Set<(info: GPUDeviceLostInfo) => void>;
  /** Idle timer armed only while a prewarmed device sits at refCount 0. */
  idleTimer: ReturnType<typeof setTimeout> | null;
}

// --- Static GPU pre-warm state (shared across all Renderer instances) ---
let prewarmPromise: Promise<void> | null = null;

// --- Shared device registry (keyed by effective adapter request) ---
const sharedDevices = new Map<string, SharedDevice>();
/** Coalesces concurrent requests for one key so callers share a device. */
const pendingAcquisitions = new Map<string, Promise<SharedDevice>>();

/**
 * Maximum number of fresh devices requested when a newly created device is
 * already lost at hand-off time. Bounds what would otherwise be unbounded
 * recursion against a broken driver or adversarial mock.
 */
export const MAX_DEVICE_ACQUIRE_ATTEMPTS = 3;

// --- Shader pre-warm state (shared across all Renderer instances) ---
const preWarmer = new PipelinePreWarmer();

/**
 * Resolve the effective adapter request options, applying the platform default
 * power preference. Setting `powerPreference` on Windows produces a driver
 * warning, so it is only applied on other platforms.
 */
function resolveAdapterOptions(options?: GPURequestAdapterOptions): GPURequestAdapterOptions {
  const resolved: GPURequestAdapterOptions = { ...options };
  if (resolved.powerPreference === undefined && !navigator.platform.startsWith('Win')) {
    resolved.powerPreference = 'high-performance';
  }
  return resolved;
}

/** Stable cache key for a shared device: the effective adapter request. */
function deviceKey(options?: GPURequestAdapterOptions): string {
  const resolved = resolveAdapterOptions(options);
  return JSON.stringify({
    powerPreference: resolved.powerPreference ?? null,
    forceFallbackAdapter: resolved.forceFallbackAdapter ?? false,
    featureLevel: resolved.featureLevel ?? null,
  });
}

/**
 * Request a fresh adapter and device with limits derived from that adapter.
 * Feature detection is adapter-level: unsupported adapters pass an empty
 * feature array and pay nothing for optional profiling.
 */
async function requestDeviceFor(
  options?: GPURequestAdapterOptions,
): Promise<{ device: GPUDevice; adapter: GPUAdapter }> {
  if (!navigator.gpu) {
    throw new Error('WebGPU not supported: No adapter found.');
  }
  const adapter = await navigator.gpu.requestAdapter(resolveAdapterOptions(options));
  if (!adapter) {
    throw new Error('WebGPU not supported: No adapter found.');
  }
  const adapterLimits = adapter.limits;
  const features: GPUFeatureName[] =
    adapter.features?.has('timestamp-query') ? ['timestamp-query'] : [];
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxBufferSize: adapterLimits.maxBufferSize,
      maxStorageBufferBindingSize: adapterLimits.maxStorageBufferBindingSize,
    },
    requiredFeatures: features,
  });
  return { device, adapter };
}

/** Create an unregistered shared-device record at refCount 0. */
function createSharedRecord(device: GPUDevice, adapter: GPUAdapter, key: string): SharedDevice {
  return {
    device,
    adapter,
    key,
    refCount: 0,
    lost: false,
    lostInfo: null,
    lostCallbacks: new Set(),
    idleTimer: null,
  };
}

/**
 * Attach the single `device.lost` listener for a shared device. On loss the
 * record is marked lost, evicted from the cache, and all subscribers are
 * notified. The device is never destroyed here because it is already gone.
 */
function attachLostListener(shared: SharedDevice): void {
  shared.device.lost.then((info) => {
    shared.lost = true;
    shared.lostInfo = info;
    if (shared.idleTimer) {
      clearTimeout(shared.idleTimer);
      shared.idleTimer = null;
    }
    if (sharedDevices.get(shared.key) === shared) {
      sharedDevices.delete(shared.key);
    }
    const callbacks = Array.from(shared.lostCallbacks);
    shared.lostCallbacks.clear();
    for (const callback of callbacks) {
      try {
        callback(info);
      } catch (error) {
        console.error('[Anime4KWebExt] Error in GPU device loss callback:', error);
      }
    }
  });
}

/** Cancel a shared device's idle auto-destroy timer, if armed. */
function cancelIdleTimer(shared: SharedDevice): void {
  if (shared.idleTimer) {
    clearTimeout(shared.idleTimer);
    shared.idleTimer = null;
  }
}

/** Build a lease facade over a shared device. */
function createLease(shared: SharedDevice): GpuDeviceLease {
  let released = false;
  return {
    get device(): GPUDevice {
      return shared.device;
    },
    get adapter(): GPUAdapter {
      return shared.adapter;
    },
    get lost(): boolean {
      return shared.lost;
    },
    release(): void {
      if (released) return;
      released = true;
      if (shared.refCount > 0) shared.refCount -= 1;
      if (shared.refCount > 0) return;

      // Last lease released: no idle retention — evict and destroy.
      cancelIdleTimer(shared);
      if (sharedDevices.get(shared.key) === shared) {
        sharedDevices.delete(shared.key);
      }
      if (!shared.lost) {
        try {
          shared.device.destroy();
        } catch {
          /* already destroyed */
        }
      }
    },
    onLost(callback: (info: GPUDeviceLostInfo) => void): () => void {
      if (shared.lost) {
        if (shared.lostInfo) callback(shared.lostInfo);
        return () => { /* device already lost — nothing to unsubscribe */ };
      }
      shared.lostCallbacks.add(callback);
      return () => {
        shared.lostCallbacks.delete(callback);
      };
    },
  };
}

/**
 * Start (or join) a coalesced request for a shared device under `key`. The
 * returned record is registered in {@link sharedDevices}; the caller owns the
 * refCount increment.
 */
function requestSharedDevice(key: string, options?: GPURequestAdapterOptions): Promise<SharedDevice> {
  const pending = pendingAcquisitions.get(key);
  if (pending) return pending;

  const request = (async () => {
    const { device, adapter } = await requestDeviceFor(options);
    const shared = createSharedRecord(device, adapter, key);
    sharedDevices.set(key, shared);
    attachLostListener(shared);
    return shared;
  })();

  pendingAcquisitions.set(key, request);
  const cleanup = (): void => {
    if (pendingAcquisitions.get(key) === request) pendingAcquisitions.delete(key);
  };
  // Settle-time cleanup that swallows rejections (callers still observe them).
  request.then(cleanup, cleanup);
  return request;
}

/** Acquire a live shared device or create one, incrementing the refCount. */
async function getOrCreateSharedDevice(
  key: string,
  options?: GPURequestAdapterOptions,
): Promise<SharedDevice> {
  const shared = sharedDevices.get(key);
  if (shared && !shared.lost) {
    shared.refCount += 1;
    cancelIdleTimer(shared);
    return shared;
  }

  for (let attempt = 0; attempt < MAX_DEVICE_ACQUIRE_ATTEMPTS; attempt += 1) {
    const candidate = await requestSharedDevice(key, options);
    if (!candidate.lost) {
      candidate.refCount += 1;
      return candidate;
    }
    // Lost between creation and hand-off: try a fresh device for this key.
  }

  throw new Error(
    'Failed to acquire a GPU device: device was lost immediately after creation.',
  );
}

/**
 * Pre-request GPU adapter and device so they're ready when the user clicks Enhance.
 * The device is stored as a shared device at refCount 0 and destroyed after 30 s
 * if no lease claims it. Safe to call multiple times — only the first call does work.
 */
export function preWarmGPU(): void {
  if (prewarmPromise) return;
  prewarmPromise = (async () => {
    try {
      if (!navigator.gpu) return;
      const key = deviceKey();
      const { device, adapter } = await requestDeviceFor();

      // Another consumer may have acquired a device for this key while the pre-warm
      // was in flight; prefer the existing shared device.
      const existing = sharedDevices.get(key);
      if (existing && !existing.lost) {
        try {
          device.destroy();
        } catch {
          /* already destroyed */
        }
        return;
      }

      const shared = createSharedRecord(device, adapter, key);
      sharedDevices.set(key, shared);
      attachLostListener(shared);

      // Auto-destroy a prewarmed device that is never leased within 30 seconds.
      shared.idleTimer = setTimeout(() => {
        shared.idleTimer = null;
        if (shared.refCount === 0 && !shared.lost && sharedDevices.get(key) === shared) {
          console.log('[Anime4KWebExt] Prewarmed GPU device unclaimed after 30s, releasing.');
          sharedDevices.delete(key);
          try {
            shared.device.destroy();
          } catch {
            /* already destroyed */
          }
        }
      }, 30000);
    } catch {
      // Pre-warm is best-effort; errors are non-fatal
    }
  })();
}

/**
 * Acquire a lease on a shared GPUDevice for the given request options (defaults
 * applied). A pre-warmed device at refCount 0 is claimed and its idle timer
 * cancelled; otherwise a fresh adapter/device is requested. Concurrent calls for
 * the same request share one device.
 */
export async function acquireGPUDevice(options?: GPURequestAdapterOptions): Promise<GpuDeviceLease> {
  // If a pre-warm is in flight, await it so we can share its device instead of
  // racing a duplicate request.
  if (prewarmPromise) await prewarmPromise;

  const shared = await getOrCreateSharedDevice(deviceKey(options), options);
  return createLease(shared);
}

/**
 * Invalidate the shader pre-warm cache and the pre-warm promise.
 * Shared devices with outstanding leases are left untouched. An unleased
 * (refCount 0) prewarmed device is destroyed to avoid leaking it.
 */
export function invalidatePreWarm(): void {
  preWarmer.invalidate();
  prewarmPromise = null;

  for (const [key, shared] of sharedDevices) {
    if (shared.refCount > 0) continue;
    cancelIdleTimer(shared);
    sharedDevices.delete(key);
    if (!shared.lost) {
      try {
        shared.device.destroy();
      } catch {
        /* already destroyed */
      }
    }
  }
}

/**
 * Get the shared PipelinePreWarmer instance for shader pre-warming.
 */
export function getPreWarmer(): PipelinePreWarmer {
  return preWarmer;
}
