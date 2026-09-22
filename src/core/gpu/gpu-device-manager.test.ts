/**
 * Tests for GPU Device Manager — shared ref-counted device leases, pre-warming,
 * loss notification, and recovery.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installGPUMock, removeGPUMock } from '@/test/webgpu-mock';
import type { MockGPUObjects } from '@/test/webgpu-mock';
import {
  preWarmGPU,
  acquireGPUDevice,
  invalidatePreWarm,
  getPreWarmer,
  MAX_DEVICE_ACQUIRE_ATTEMPTS,
} from './gpu-device-manager';

/**
 * Helper: wait for preWarmGPU's internal async work to complete.
 * The mock resolves on microtasks, so a macrotask tick is enough.
 */
async function awaitPreWarm(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
}

/** Minimal stand-in for a GPUDevice whose `lost` promise never settles. */
function createFakeDevice(): { lost: Promise<never>; destroy: ReturnType<typeof vi.fn> } {
  return { lost: new Promise<never>(() => { /* never */ }), destroy: vi.fn() };
}

/** Minimal stand-in for a GPUDevice that is already lost at creation time. */
function createImmediatelyLostDevice(): {
  lost: Promise<{ reason: string; message: string }>;
  destroy: ReturnType<typeof vi.fn>;
} {
  return {
    lost: Promise.resolve({ reason: 'unknown', message: 'immediately lost' }),
    destroy: vi.fn(),
  };
}

describe('gpu-device-manager', () => {
  describe('acquisition, sharing, and pre-warming', () => {
    let mock: MockGPUObjects;

    beforeEach(() => {
      invalidatePreWarm();
      mock = installGPUMock();
    });

    afterEach(() => {
      removeGPUMock();
    });

    // ── acquireGPUDevice ──

    it('acquireGPUDevice() returns a lease exposing device and adapter', async () => {
      const lease = await acquireGPUDevice();

      expect(lease.device).toBe(mock.device);
      expect(lease.adapter).toBe(mock.adapter);
      expect(lease.lost).toBe(false);

      lease.release();
    });

    it('acquireGPUDevice() requests device with correct limits and features', async () => {
      const lease = await acquireGPUDevice();

      expect(mock.adapter.requestDevice).toHaveBeenCalledWith(
        expect.objectContaining({
          requiredLimits: expect.objectContaining({
            maxBufferSize: expect.any(Number),
            maxStorageBufferBindingSize: expect.any(Number),
          }),
          requiredFeatures: expect.any(Array),
        }),
      );

      lease.release();
    });

    it('acquireGPUDevice() requests timestamp-query when the adapter advertises it', async () => {
      mock.adapter.features.add('timestamp-query');

      const lease = await acquireGPUDevice();

      expect(mock.adapter.requestDevice).toHaveBeenCalledWith(
        expect.objectContaining({ requiredFeatures: ['timestamp-query'] }),
      );

      lease.release();
    });

    it('acquireGPUDevice() omits timestamp-query when the adapter does not advertise it', async () => {
      mock.adapter.features.delete('timestamp-query');

      const lease = await acquireGPUDevice();

      expect(mock.adapter.requestDevice).toHaveBeenCalledWith(
        expect.objectContaining({ requiredFeatures: [] }),
      );

      lease.release();
    });

    it('acquireGPUDevice() uses high-performance on non-Windows', async () => {
      const lease = await acquireGPUDevice();

      const gpu = navigator.gpu as any;
      expect(gpu.requestAdapter).toHaveBeenCalledWith(
        expect.objectContaining({ powerPreference: 'high-performance' }),
      );

      lease.release();
    });

    it('acquireGPUDevice() throws when adapter is null', async () => {
      removeGPUMock();
      installGPUMock({ adapterNull: true });

      await expect(acquireGPUDevice()).rejects.toThrow('WebGPU not supported: No adapter found.');

      removeGPUMock();
      mock = installGPUMock();
    });

    it('concurrent acquires for one request share a single device', async () => {
      const [a, b] = await Promise.all([acquireGPUDevice(), acquireGPUDevice()]);

      expect(a.device).toBe(b.device);
      expect(mock.adapter.requestDevice).toHaveBeenCalledTimes(1);

      a.release();
      b.release();
    });

    // ── Ref-counted release ──

    it('releasing one of two leases keeps the device alive; releasing both destroys it', async () => {
      const first = await acquireGPUDevice();
      const second = await acquireGPUDevice();
      expect(first.device).toBe(second.device);
      expect(mock.adapter.requestDevice).toHaveBeenCalledTimes(1);

      first.release();
      expect(mock.device.destroy).not.toHaveBeenCalled();

      second.release();
      expect(mock.device.destroy).toHaveBeenCalledTimes(1);
    });

    it('release() is idempotent', async () => {
      const lease = await acquireGPUDevice();

      lease.release();
      lease.release();

      expect(mock.device.destroy).toHaveBeenCalledTimes(1);
    });

    // ── preWarmGPU ──

    it('preWarmGPU() is idempotent — second call is a no-op', async () => {
      preWarmGPU();
      preWarmGPU(); // second call should return immediately
      await awaitPreWarm();

      const gpu = navigator.gpu as any;
      expect(gpu.requestAdapter).toHaveBeenCalledTimes(1);
    });

    it('preWarmGPU() requests adapter with high-performance on non-Windows', async () => {
      preWarmGPU();
      await awaitPreWarm();

      const gpu = navigator.gpu as any;
      expect(gpu.requestAdapter).toHaveBeenCalledWith(
        expect.objectContaining({ powerPreference: 'high-performance' }),
      );
    });

    it('preWarmGPU() does not set powerPreference on Windows', async () => {
      const origPlatform = navigator.platform;
      try {
        Object.defineProperty(navigator, 'platform', {
          value: 'Win32',
          configurable: true,
          writable: true,
        });
      } catch {
        (navigator as any).platform = 'Win32';
      }

      preWarmGPU();
      await awaitPreWarm();

      const gpu = navigator.gpu as any;
      expect(gpu.requestAdapter).toHaveBeenCalled();
      expect(gpu.requestAdapter).toHaveBeenCalledWith({});

      // Restore
      try {
        Object.defineProperty(navigator, 'platform', {
          value: origPlatform,
          configurable: true,
          writable: true,
        });
      } catch {
        (navigator as any).platform = origPlatform;
      }
    });

    it('preWarmGPU() requests timestamp-query when the adapter advertises it', async () => {
      mock.adapter.features.add('timestamp-query');

      preWarmGPU();
      await awaitPreWarm();

      expect(mock.adapter.requestDevice).toHaveBeenCalledWith(
        expect.objectContaining({ requiredFeatures: ['timestamp-query'] }),
      );
    });

    it('preWarmGPU() omits timestamp-query when the adapter does not advertise it', async () => {
      mock.adapter.features.delete('timestamp-query');

      preWarmGPU();
      await awaitPreWarm();

      expect(mock.adapter.requestDevice).toHaveBeenCalledWith(
        expect.objectContaining({ requiredFeatures: [] }),
      );
    });

    it('acquireGPUDevice() claims a prewarmed device without a second request', async () => {
      preWarmGPU();
      await awaitPreWarm();

      const lease = await acquireGPUDevice();

      expect(lease.device).toBe(mock.device);
      expect(mock.adapter.requestDevice).toHaveBeenCalledTimes(1);

      lease.release();
    });

    it('getPreWarmer() returns the same singleton instance', () => {
      const a = getPreWarmer();
      const b = getPreWarmer();
      expect(a).toBe(b);
      expect(a).toBeDefined();
    });
  });

  // ── 30-second idle auto-release timer (uses fake timers) ──

  describe('30s idle auto-release timer', () => {
    let mock: MockGPUObjects;

    beforeEach(() => {
      invalidatePreWarm();
      mock = installGPUMock();
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      removeGPUMock();
    });

    it('destroys a prewarmed device after 30s if never leased', async () => {
      preWarmGPU();
      // Let the prewarm async work complete (microtasks)
      await vi.advanceTimersByTimeAsync(0);

      const device = mock.device;
      expect(device.destroy).not.toHaveBeenCalled();

      // Advance 30 seconds
      vi.advanceTimersByTime(30000);
      await vi.advanceTimersByTimeAsync(0);

      expect(device.destroy).toHaveBeenCalled();
    });

    it('acquiring the prewarmed device cancels the 30s auto-release timer', async () => {
      preWarmGPU();
      await vi.advanceTimersByTimeAsync(0);

      const lease = await acquireGPUDevice();

      // Advance 30 seconds — device should NOT be destroyed
      vi.advanceTimersByTime(30000);
      await vi.advanceTimersByTimeAsync(0);

      expect(mock.device.destroy).not.toHaveBeenCalled();

      lease.release();
    });
  });

  // ── Device loss ──

  describe('device loss', () => {
    let mock: MockGPUObjects;

    beforeEach(() => {
      invalidatePreWarm();
      mock = installGPUMock();
    });

    afterEach(() => {
      removeGPUMock();
    });

    it('marks the lease lost, notifies subscribers, and does not destroy the lost device', async () => {
      const lease = await acquireGPUDevice();
      const onLost = vi.fn();
      lease.onLost(onLost);

      mock.deviceLostDeferred.resolve({ reason: 'unknown', message: 'device gone' });
      await Promise.resolve();
      await Promise.resolve();

      expect(lease.lost).toBe(true);
      expect(onLost).toHaveBeenCalledTimes(1);
      expect(onLost.mock.calls[0][0]).toMatchObject({ reason: 'unknown', message: 'device gone' });
      // The device is already lost — the manager must not call destroy().
      expect(mock.device.destroy).not.toHaveBeenCalled();
    });

    it('a subsequent acquire after loss returns a fresh device', async () => {
      const lease = await acquireGPUDevice();

      const fresh = createFakeDevice();
      mock.adapter.requestDevice.mockResolvedValueOnce(fresh as unknown as GPUDevice);

      mock.deviceLostDeferred.resolve({ reason: 'unknown', message: 'device gone' });
      await Promise.resolve();
      await Promise.resolve();
      expect(lease.lost).toBe(true);

      const replacement = await acquireGPUDevice();

      expect(replacement.device).not.toBe(mock.device);
      expect(replacement.device).toBe(fresh);
      expect(mock.adapter.requestDevice).toHaveBeenCalledTimes(2);

      replacement.release();
      expect(fresh.destroy).toHaveBeenCalled();
    });

    it('onLost() fires immediately when the device is already lost', async () => {
      const lease = await acquireGPUDevice();

      mock.deviceLostDeferred.resolve({ reason: 'unknown', message: 'gone' });
      await Promise.resolve();
      await Promise.resolve();

      const onLost = vi.fn();
      lease.onLost(onLost);

      expect(onLost).toHaveBeenCalledTimes(1);
    });

    it('unsubscribing from onLost() stops notifications', async () => {
      const lease = await acquireGPUDevice();
      const onLost = vi.fn();
      const unsubscribe = lease.onLost(onLost);
      unsubscribe();

      mock.deviceLostDeferred.resolve({ reason: 'unknown', message: 'gone' });
      await Promise.resolve();
      await Promise.resolve();

      expect(onLost).not.toHaveBeenCalled();
    });
  });

  // ── Bounded retry when a device is lost immediately after creation ──

  describe('immediate-loss retry bound', () => {
    let mock: MockGPUObjects;

    beforeEach(() => {
      invalidatePreWarm();
      mock = installGPUMock();
    });

    afterEach(() => {
      removeGPUMock();
    });

    it('rejects after MAX_DEVICE_ACQUIRE_ATTEMPTS when every device is already lost', async () => {
      // Provide more candidates than the cap so an unbounded implementation
      // would keep consuming them instead of throwing.
      for (let i = 0; i < MAX_DEVICE_ACQUIRE_ATTEMPTS + 3; i += 1) {
        mock.adapter.requestDevice.mockResolvedValueOnce(
          createImmediatelyLostDevice() as unknown as GPUDevice,
        );
      }

      await expect(acquireGPUDevice()).rejects.toThrow(
        'Failed to acquire a GPU device: device was lost immediately after creation.',
      );

      // Bounded: never requests more than the cap.
      expect(mock.adapter.requestDevice).toHaveBeenCalledTimes(MAX_DEVICE_ACQUIRE_ATTEMPTS);
    });

    it('retries with a fresh device when the first device is lost but the second is healthy', async () => {
      const lost = createImmediatelyLostDevice();
      mock.adapter.requestDevice
        .mockResolvedValueOnce(lost as unknown as GPUDevice)
        .mockResolvedValueOnce(mock.device);

      const lease = await acquireGPUDevice();

      expect(lease.device).toBe(mock.device);
      expect(lease.lost).toBe(false);
      expect(mock.adapter.requestDevice).toHaveBeenCalledTimes(2);

      lease.release();
      expect(mock.device.destroy).toHaveBeenCalled();
    });
  });

  // ── invalidatePreWarm ──

  describe('invalidatePreWarm()', () => {
    let mock: MockGPUObjects;

    beforeEach(() => {
      invalidatePreWarm();
      mock = installGPUMock();
    });

    afterEach(() => {
      removeGPUMock();
    });

    it('destroys an unleased prewarmed device', async () => {
      preWarmGPU();
      await awaitPreWarm();

      invalidatePreWarm();

      expect(mock.device.destroy).toHaveBeenCalled();
    });

    it('does NOT destroy a device that outstanding leases still hold', async () => {
      const lease = await acquireGPUDevice();

      invalidatePreWarm();

      expect(mock.device.destroy).not.toHaveBeenCalled();

      lease.release();
      expect(mock.device.destroy).toHaveBeenCalledTimes(1);
    });
  });

  // ── No navigator.gpu ──

  describe('without navigator.gpu', () => {
    beforeEach(() => {
      invalidatePreWarm();
      removeGPUMock();
    });

    it('preWarmGPU() is a no-op when navigator.gpu is absent', async () => {
      preWarmGPU();
      await Promise.resolve();
      await expect(acquireGPUDevice()).rejects.toThrow('WebGPU not supported: No adapter found.');
    });
  });

  // ── No adapter (adapter returns null) ──

  describe('with null adapter', () => {
    beforeEach(() => {
      invalidatePreWarm();
      installGPUMock({ adapterNull: true });
    });

    afterEach(() => {
      removeGPUMock();
    });

    it('preWarmGPU() is a no-op when requestAdapter returns null', async () => {
      preWarmGPU();
      await Promise.resolve();
      await expect(acquireGPUDevice()).rejects.toThrow('WebGPU not supported: No adapter found.');
    });
  });
});
