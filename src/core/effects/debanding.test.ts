import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installGPUMock, removeGPUMock, createMockGPUTexture } from '@/test/webgpu-mock';
import type { MockGPUDevice } from '@/test/webgpu-mock';

vi.mock('@shaders/debanding.wgsl', () => ({ default: 'mock-debanding-shader' }));

import { Debanding } from './debanding';

describe('Debanding', () => {
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
    it('creates output texture without COPY_SRC flag (unlike CAS/ColorAdjust)', () => {
      new Debanding({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });

      expect(mockDevice.createTexture).toHaveBeenCalledWith(
        expect.objectContaining({
          size: { width: 1920, height: 1080 },
          format: 'rgba8unorm',
          usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
        }),
      );
    });

    it('output texture usage does NOT include COPY_SRC', () => {
      new Debanding({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });

      const callArgs = mockDevice.createTexture.mock.calls[0]?.[0] as Record<string, unknown>;
      const usage = callArgs?.usage as number;
      expect(usage & GPUTextureUsage.COPY_SRC).toBe(0);
    });

    it('creates params buffer (size 8, UNIFORM | COPY_DST)', () => {
      new Debanding({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });

      expect(mockDevice.createBuffer).toHaveBeenCalledWith(
        expect.objectContaining({
          size: 8,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
      );
    });

    it('writes default [strength=0.5, bandThreshold=0.08] to params buffer', () => {
      new Debanding({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });

      expect(mockDevice.queue.writeBuffer).toHaveBeenCalledWith(
        expect.any(Object),
        0,
        expect.any(Float32Array),
      );
      const writtenData = mockDevice.queue.writeBuffer.mock.calls[0]?.[2] as Float32Array;
      expect(writtenData[0]).toBe(0.5);
      expect(writtenData[1]).toBeCloseTo(0.08, 5);
    });

    it('writes custom initial values to params buffer', () => {
      new Debanding({
        device: mockDevice as unknown as GPUDevice,
        inputTexture: inputTexture as unknown as GPUTexture,
        strength: 0.7,
        bandThreshold: 0.15,
      });

      const writtenData = mockDevice.queue.writeBuffer.mock.calls[0]?.[2] as Float32Array;
      expect(writtenData[0]).toBeCloseTo(0.7, 5);
      expect(writtenData[1]).toBeCloseTo(0.15, 5);
    });

    it('creates shader module with debanding shader code', () => {
      new Debanding({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });

      expect(mockDevice.createShaderModule).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'mock-debanding-shader' }),
      );
    });

    it('creates compute pipeline with auto layout and main entry point', () => {
      new Debanding({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });

      expect(mockDevice.createComputePipeline).toHaveBeenCalledWith(
        expect.objectContaining({
          layout: 'auto',
          compute: expect.objectContaining({ entryPoint: 'main' }),
        }),
      );
    });

    it('creates bind group with 3 entries (input, output, params)', () => {
      new Debanding({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });

      expect(mockDevice.createBindGroup).toHaveBeenCalledWith(
        expect.objectContaining({
          entries: expect.arrayContaining([
            expect.objectContaining({ binding: 0 }),
            expect.objectContaining({ binding: 1 }),
            expect.objectContaining({ binding: 2 }),
          ]),
        }),
      );
      expect(mockDevice.createBindGroup.mock.calls[0]?.[0]?.entries).toHaveLength(3);
    });
  });

  describe('shader param propagation', () => {
    it('binds the same params buffer that receives the debanding uniform write', () => {
      new Debanding({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });

      const paramsBuffer = (mockDevice.createBuffer as any).mock.results[0]?.value;
      const entries = mockDevice.createBindGroup.mock.calls[0]?.[0]?.entries as any[];
      const paramsEntry = entries.find((e) => e.binding === 2);

      expect(paramsEntry).toBeDefined();
      expect(paramsEntry.resource.buffer).toBe(paramsBuffer);
    });

    it('routes both debanding params to the shader-bound params buffer', () => {
      const db = new Debanding({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });
      const paramsBuffer = (mockDevice.createBuffer as any).mock.results[0]?.value;
      vi.clearAllMocks();

      db.updateParam('bandThreshold', 0.3);

      expect(mockDevice.queue.writeBuffer).toHaveBeenCalledWith(
        paramsBuffer,
        0,
        expect.any(Float32Array),
      );
      const writtenData = mockDevice.queue.writeBuffer.mock.calls[0]?.[2] as Float32Array;
      expect(writtenData[0]).toBe(0.5);
      expect(writtenData[1]).toBeCloseTo(0.3, 5);
    });

    it('preserves a previously configured bandThreshold when strength changes', () => {
      const db = new Debanding({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });
      db.updateParam('bandThreshold', 0.3);
      vi.clearAllMocks();

      db.updateParam('strength', 0.7);

      const writtenData = mockDevice.queue.writeBuffer.mock.calls[0]?.[2] as Float32Array;
      expect(writtenData[0]).toBeCloseTo(0.7, 5);
      expect(writtenData[1]).toBeCloseTo(0.3, 5);
    });
  });

  describe('updateParam', () => {
    function createDebanding() {
      return new Debanding({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });
    }

    it('updates strength within range [0, 1]', () => {
      const db = createDebanding();
      vi.clearAllMocks();

      db.updateParam('strength', 0.7);

      expect(mockDevice.queue.writeBuffer).toHaveBeenCalledTimes(1);
      const writtenData = mockDevice.queue.writeBuffer.mock.calls[0]?.[2] as Float32Array;
      expect(writtenData[0]).toBeCloseTo(0.7, 5);
    });

    it('clamps strength to 0 when value < 0', () => {
      const db = createDebanding();
      vi.clearAllMocks();

      db.updateParam('strength', -0.5);

      const writtenData = mockDevice.queue.writeBuffer.mock.calls[0]?.[2] as Float32Array;
      expect(writtenData[0]).toBe(0);
    });

    it('clamps strength to 1 when value > 1', () => {
      const db = createDebanding();
      vi.clearAllMocks();

      db.updateParam('strength', 2);

      const writtenData = mockDevice.queue.writeBuffer.mock.calls[0]?.[2] as Float32Array;
      expect(writtenData[0]).toBe(1);
    });

    it('updates bandThreshold within range [0, 1]', () => {
      const db = createDebanding();
      vi.clearAllMocks();

      db.updateParam('bandThreshold', 0.3);

      expect(mockDevice.queue.writeBuffer).toHaveBeenCalledTimes(1);
      const writtenData = mockDevice.queue.writeBuffer.mock.calls[0]?.[2] as Float32Array;
      expect(writtenData[1]).toBeCloseTo(0.3, 5);
    });

    it('clamps bandThreshold to 0 when value < 0', () => {
      const db = createDebanding();
      vi.clearAllMocks();

      db.updateParam('bandThreshold', -0.5);

      const writtenData = mockDevice.queue.writeBuffer.mock.calls[0]?.[2] as Float32Array;
      expect(writtenData[1]).toBe(0);
    });

    it('clamps bandThreshold to 1 when value > 1', () => {
      const db = createDebanding();
      vi.clearAllMocks();

      db.updateParam('bandThreshold', 2);

      const writtenData = mockDevice.queue.writeBuffer.mock.calls[0]?.[2] as Float32Array;
      expect(writtenData[1]).toBe(1);
    });

    it('ignores non-number values', () => {
      const db = createDebanding();
      vi.clearAllMocks();

      db.updateParam('strength', '0.5');
      expect(mockDevice.queue.writeBuffer).not.toHaveBeenCalled();
    });

    it('ignores non-finite values (NaN)', () => {
      const db = createDebanding();
      vi.clearAllMocks();

      db.updateParam('strength', NaN);
      expect(mockDevice.queue.writeBuffer).not.toHaveBeenCalled();
    });

    it('ignores non-finite values (Infinity)', () => {
      const db = createDebanding();
      vi.clearAllMocks();

      db.updateParam('bandThreshold', Infinity);
      expect(mockDevice.queue.writeBuffer).not.toHaveBeenCalled();
    });

    it('ignores unknown param names', () => {
      const db = createDebanding();
      vi.clearAllMocks();

      db.updateParam('unknown', 0.5);
      expect(mockDevice.queue.writeBuffer).not.toHaveBeenCalled();
    });
  });

  describe('pass', () => {
    it('records compute pass with correct pipeline, bind group, and workgroup dispatch', async () => {
      const db = new Debanding({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });
      const encoder = (mockDevice as any).createCommandEncoder() as unknown as GPUCommandEncoder;

      await db.pass(encoder);

      const computePass = (encoder as Record<string, any>).beginComputePass.mock.results[0]?.value;
      expect(computePass.setPipeline).toHaveBeenCalled();
      expect(computePass.setBindGroup).toHaveBeenCalledWith(0, expect.any(Object));
      expect(computePass.dispatchWorkgroups).toHaveBeenCalledWith(
        Math.ceil(1920 / 8),
        Math.ceil(1080 / 8),
      );
      expect(computePass.end).toHaveBeenCalled();
    });

    it('returns a resolved Promise', async () => {
      const db = new Debanding({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });
      const encoder = (mockDevice as any).createCommandEncoder() as unknown as GPUCommandEncoder;

      const result = db.pass(encoder);

      expect(result).toBeInstanceOf(Promise);
      await expect(result).resolves.toBeUndefined();
    });
  });

  describe('getOutputTexture', () => {
    it('returns the output texture', () => {
      const db = new Debanding({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });
      const texture = db.getOutputTexture();

      expect(texture).toBeDefined();
      expect(texture.width).toBe(1920);
      expect(texture.height).toBe(1080);
    });
  });

  describe('destroy', () => {
    it('destroys output texture and params buffer', () => {
      const db = new Debanding({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });
      const outputTexture = db.getOutputTexture();
      const paramsBuffer = (mockDevice.createBuffer as any).mock.results[0]?.value;

      db.destroy();

      expect((outputTexture as any).destroy).toHaveBeenCalled();
      expect(paramsBuffer.destroy).toHaveBeenCalled();
    });
  });
});
