/**
 * Tests for GPU Device Manager — shared ref-counted device leases, loss
 * notification, and recovery.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installGPUMock, removeGPUMock } from '@/test/webgpu-mock';
import type { MockGPUObjects } from '@/test/webgpu-mock';
import {
  acquireGPUDevice,
  invalidatePreWarm,
  getPreWarmer,
  MAX_DEVICE_ACQUIRE_ATTEMPTS,
} from './gpu-device-manager';

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
  describe('acquisition and sharing', () => {
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

    // ── getPreWarmer ──

    it('getPreWarmer() returns the same singleton instance', () => {
      const a = getPreWarmer();
      const b = getPreWarmer();
      expect(a).toBe(b);
      expect(a).toBeDefined();
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

    it('invalidates the shader pre-warm cache without destroying the shared device', async () => {
      const preWarmer = getPreWarmer();
      const invalidateSpy = vi.spyOn(preWarmer, 'invalidate');
      const lease = await acquireGPUDevice();

      invalidatePreWarm();

      expect(invalidateSpy).toHaveBeenCalled();
      expect(mock.device.destroy).not.toHaveBeenCalled();

      lease.release();
      invalidateSpy.mockRestore();
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

    it('acquireGPUDevice() rejects when navigator.gpu is absent', async () => {
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

    it('acquireGPUDevice() rejects when requestAdapter returns null', async () => {
      await expect(acquireGPUDevice()).rejects.toThrow('WebGPU not supported: No adapter found.');
    });
  });
});
