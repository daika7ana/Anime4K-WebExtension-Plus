/**
 * Tests for {@link GatedRestore} — the restore-policy `gate` wrapper node.
 * The mock device supports compute pipelines, buffers and compute passes, so the
 * full construction/pass/updateParam/destroy surface is covered here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  installGPUMock,
  removeGPUMock,
  createMockGPUTexture,
  type MockGPUDevice,
} from '@/test/webgpu-mock';
import type { DestroyablePipeline } from '@/types';
import { GatedRestore, GATED_RESTORE_DEFAULTS, GATED_RESTORE_4K_DEFAULTS, selectGatedRestoreOptions } from './gated-restore';

vi.mock('@shaders/restore-gate.wgsl', () => ({ default: 'mock-restore-gate-shader' }));

function fakeRestore(width = 16, height = 16) {
  const output = createMockGPUTexture(width, height);
  const restore: DestroyablePipeline = {
    pass: vi.fn().mockResolvedValue(undefined),
    getOutputTexture: vi.fn(() => output as unknown as GPUTexture),
    updateParam: vi.fn(),
    destroy: vi.fn(),
  };
  return { restore, output };
}

function makeEncoder() {
  return {
    beginComputePass: vi.fn(() => ({
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      dispatchWorkgroups: vi.fn(),
      end: vi.fn(),
    })),
  } as unknown as GPUCommandEncoder;
}

describe('GatedRestore', () => {
  let mockDevice: MockGPUDevice;
  let inputTexture: ReturnType<typeof createMockGPUTexture>;

  beforeEach(() => {
    const mock = installGPUMock();
    mockDevice = mock.device;
    inputTexture = createMockGPUTexture(1920, 1080);
  });

  afterEach(() => {
    removeGPUMock();
  });

  describe('constructor', () => {
    it('creates a same-size rgba16float output with STORAGE|TEXTURE|COPY_SRC', () => {
      const { restore } = fakeRestore();
      new GatedRestore({
        device: mockDevice as unknown as GPUDevice,
        inputTexture: inputTexture as unknown as GPUTexture,
        restore,
      });

      expect(mockDevice.createTexture).toHaveBeenCalledWith(
        expect.objectContaining({
          size: { width: 1920, height: 1080 },
          format: 'rgba16float',
          usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
        }),
      );
    });

    it('creates a 16-byte uniform buffer and writes [low, high, strength, 0]', () => {
      const { restore } = fakeRestore();
      new GatedRestore({
        device: mockDevice as unknown as GPUDevice,
        inputTexture: inputTexture as unknown as GPUTexture,
        restore,
      });

      expect(mockDevice.createBuffer).toHaveBeenCalledWith(
        expect.objectContaining({
          size: 16,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
      );
      const written = mockDevice.queue.writeBuffer.mock.calls[0]?.[2] as Float32Array;
      expect(written[0]).toBeCloseTo(GATED_RESTORE_DEFAULTS.gateLow, 6);
      expect(written[1]).toBeCloseTo(GATED_RESTORE_DEFAULTS.gateHigh, 6);
      expect(written[2]).toBe(GATED_RESTORE_DEFAULTS.gateStrength);
      expect(written[3]).toBe(0);
    });

    it('creates a compute pipeline (entry main) and a 4-binding bind group', () => {
      const { restore, output } = fakeRestore();
      new GatedRestore({
        device: mockDevice as unknown as GPUDevice,
        inputTexture: inputTexture as unknown as GPUTexture,
        restore,
      });

      expect(mockDevice.createComputePipeline).toHaveBeenCalledWith(
        expect.objectContaining({ compute: expect.objectContaining({ entryPoint: 'main' }) }),
      );
      const entries = mockDevice.createBindGroup.mock.calls[0]?.[0]?.entries as unknown[];
      expect(entries).toHaveLength(4);
      // The inner restore's output is bound as the restored texture.
      expect((entries[1] as { resource: unknown }).resource).toBe(output.createView.mock.results[0]?.value);
    });
  });

  describe('pass', () => {
    it('runs the inner restore then dispatches the gate at ceil(w/8), ceil(h/8)', async () => {
      const { restore } = fakeRestore();
      const gated = new GatedRestore({
        device: mockDevice as unknown as GPUDevice,
        inputTexture: inputTexture as unknown as GPUTexture,
        restore,
      });
      const encoder = makeEncoder();

      await gated.pass(encoder);

      expect(restore.pass).toHaveBeenCalledWith(encoder);
      const pass = (encoder as Record<string, any>).beginComputePass.mock.results[0]?.value;
      expect(pass.setPipeline).toHaveBeenCalled();
      expect(pass.setBindGroup).toHaveBeenCalledWith(0, expect.any(Object));
      expect(pass.dispatchWorkgroups).toHaveBeenCalledWith(
        Math.ceil(1920 / 8),
        Math.ceil(1080 / 8),
      );
      expect(pass.end).toHaveBeenCalled();
    });

    it('is safe at 1x1 (prewarm)', async () => {
      const oneByOne = createMockGPUTexture(1, 1);
      const { restore } = fakeRestore(1, 1);
      const gated = new GatedRestore({
        device: mockDevice as unknown as GPUDevice,
        inputTexture: oneByOne as unknown as GPUTexture,
        restore,
      });
      const encoder = makeEncoder();

      await gated.pass(encoder);

      const pass = (encoder as Record<string, any>).beginComputePass.mock.results[0]?.value;
      expect(pass.dispatchWorkgroups).toHaveBeenCalledWith(1, 1);
    });
  });

  describe('updateParam', () => {
    it('accepts and clamps the three gate params', () => {
      const { restore } = fakeRestore();
      const gated = new GatedRestore({
        device: mockDevice as unknown as GPUDevice,
        inputTexture: inputTexture as unknown as GPUTexture,
        restore,
      });
      vi.clearAllMocks();

      gated.updateParam('gateLow', -1);
      gated.updateParam('gateHigh', 2);
      gated.updateParam('gateStrength', 0.4);

      const writes = mockDevice.queue.writeBuffer.mock.calls.map(
        (call) => Array.from(call[2] as Float32Array),
      );
      expect(writes).toHaveLength(3);
      // gateLow = -1 clamps to 0; gateHigh = 2 clamps to 1; strength = 0.4.
      expect(writes[0][0]).toBe(0);
      expect(writes[0][1]).toBeCloseTo(GATED_RESTORE_DEFAULTS.gateHigh, 5);
      expect(writes[0][2]).toBe(1);
      expect(writes[1][0]).toBe(0);
      expect(writes[1][1]).toBe(1);
      expect(writes[1][2]).toBe(1);
      expect(writes[2][1]).toBe(1);
      expect(writes[2][2]).toBeCloseTo(0.4, 5);
    });

    it('ignores unknown params and non-finite values, never forwarding to the restore', () => {
      const { restore } = fakeRestore();
      const gated = new GatedRestore({
        device: mockDevice as unknown as GPUDevice,
        inputTexture: inputTexture as unknown as GPUTexture,
        restore,
      });
      vi.clearAllMocks();

      gated.updateParam('sharpness', 0.5);
      gated.updateParam('gateLow', NaN);
      gated.updateParam('gateLow', '0.02');
      gated.updateParam('gateLow', Infinity);

      expect(mockDevice.queue.writeBuffer).not.toHaveBeenCalled();
      expect(restore.updateParam).not.toHaveBeenCalled();
    });
  });

  describe('destroy', () => {
    it('destroys its own texture + buffer, then the inner restore', () => {
      const { restore } = fakeRestore();
      const gated = new GatedRestore({
        device: mockDevice as unknown as GPUDevice,
        inputTexture: inputTexture as unknown as GPUTexture,
        restore,
      });
      const output = gated.getOutputTexture();
      const uniformBuffer = mockDevice.createBuffer.mock.results[0]?.value;

      gated.destroy();

      expect((output as any).destroy).toHaveBeenCalled();
      expect(uniformBuffer.destroy).toHaveBeenCalled();
      expect(restore.destroy).toHaveBeenCalled();
    });
  });
});

describe('selectGatedRestoreOptions', () => {
  it('picks the sub-4K profile below 2160p', () => {
    for (const target of [
      { width: 1280, height: 720 },
      { width: 1920, height: 1080 },
      { width: 2560, height: 1440 },
    ]) {
      expect(selectGatedRestoreOptions(target)).toBe(GATED_RESTORE_DEFAULTS);
    }
  });

  it('picks the ≥4K profile at and above 2160p', () => {
    expect(selectGatedRestoreOptions({ width: 3840, height: 2160 }))
      .toBe(GATED_RESTORE_4K_DEFAULTS);
    expect(selectGatedRestoreOptions({ width: 7680, height: 4320 }))
      .toBe(GATED_RESTORE_4K_DEFAULTS);
  });

  it('exposes the seeded profile values', () => {
    expect(GATED_RESTORE_DEFAULTS).toEqual({
      gateLow: 0.006,
      gateHigh: 0.030,
      gateStrength: 1.0,
    });
    expect(GATED_RESTORE_4K_DEFAULTS).toEqual({
      gateLow: 0.030,
      gateHigh: 0.060,
      gateStrength: 1.0,
    });
  });
});
