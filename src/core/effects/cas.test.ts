import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installGPUMock, removeGPUMock, createMockGPUTexture } from '@/test/webgpu-mock';
import type { MockGPUDevice } from '@/test/webgpu-mock';

vi.mock('@shaders/cas.wgsl', () => ({ default: 'mock-cas-shader' }));

import { CAS } from './cas';

describe('CAS', () => {
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
    it('creates output texture with same dimensions and correct usage flags', () => {
      new CAS({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });

      expect(mockDevice.createTexture).toHaveBeenCalledWith(
        expect.objectContaining({
          size: { width: 1920, height: 1080 },
          format: 'rgba8unorm',
          usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
        }),
      );
    });

    it('creates params buffer (size 8, UNIFORM | COPY_DST)', () => {
      new CAS({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });

      expect(mockDevice.createBuffer).toHaveBeenCalledWith(
        expect.objectContaining({
          size: 8,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
      );
    });

    it('writes default sharpness (0.5) to params buffer', () => {
      new CAS({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });

      expect(mockDevice.queue.writeBuffer).toHaveBeenCalledWith(
        expect.any(Object),
        0,
        expect.any(Float32Array),
      );
      const writtenData = mockDevice.queue.writeBuffer.mock.calls[0]?.[2] as Float32Array;
      expect(writtenData[0]).toBe(0.5);
      expect(writtenData[1]).toBe(0);
    });

    it('writes custom sharpness value to params buffer', () => {
      new CAS({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture, sharpness: 0.8 });

      const writtenData = mockDevice.queue.writeBuffer.mock.calls[0]?.[2] as Float32Array;
      expect(writtenData[0]).toBeCloseTo(0.8, 5);
      expect(writtenData[1]).toBe(0);
    });

    it('creates shader module with CAS shader code', () => {
      new CAS({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });

      expect(mockDevice.createShaderModule).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'mock-cas-shader' }),
      );
    });

    it('creates compute pipeline with auto layout and main entry point', () => {
      new CAS({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });

      expect(mockDevice.createComputePipeline).toHaveBeenCalledWith(
        expect.objectContaining({
          layout: 'auto',
          compute: expect.objectContaining({ entryPoint: 'main' }),
        }),
      );
    });

    it('creates bind group with 3 entries (input, output, params)', () => {
      new CAS({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });

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

    it('creates view on input texture for bind group', () => {
      new CAS({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });
      expect((inputTexture as any).createView).toHaveBeenCalled();
    });
  });

  describe('shader param propagation', () => {
    it('binds the same params buffer that receives the sharpness uniform write', () => {
      new CAS({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });

      const paramsBuffer = (mockDevice.createBuffer as any).mock.results[0]?.value;
      const entries = mockDevice.createBindGroup.mock.calls[0]?.[0]?.entries as any[];
      const paramsEntry = entries.find((e) => e.binding === 2);

      expect(paramsEntry).toBeDefined();
      expect(paramsEntry.resource.buffer).toBe(paramsBuffer);
    });

    it('routes an updated sharpness value to the shader-bound params buffer', () => {
      const cas = new CAS({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });
      const paramsBuffer = (mockDevice.createBuffer as any).mock.results[0]?.value;
      vi.clearAllMocks();

      cas.updateParam('sharpness', 0.9);

      expect(mockDevice.queue.writeBuffer).toHaveBeenCalledWith(
        paramsBuffer,
        0,
        expect.any(Float32Array),
      );
      const writtenData = mockDevice.queue.writeBuffer.mock.calls[0]?.[2] as Float32Array;
      expect(writtenData[0]).toBeCloseTo(0.9, 5);
    });
  });

  describe('updateParam', () => {
    it('updates sharpness within range [0, 1]', () => {
      const cas = new CAS({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });
      vi.clearAllMocks();

      cas.updateParam('sharpness', 0.7);

      expect(mockDevice.queue.writeBuffer).toHaveBeenCalledTimes(1);
      const writtenData = mockDevice.queue.writeBuffer.mock.calls[0]?.[2] as Float32Array;
      expect(writtenData[0]).toBeCloseTo(0.7, 5);
    });

    it('clamps sharpness to 0 when value < 0', () => {
      const cas = new CAS({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });
      vi.clearAllMocks();

      cas.updateParam('sharpness', -0.5);

      const writtenData = mockDevice.queue.writeBuffer.mock.calls[0]?.[2] as Float32Array;
      expect(writtenData[0]).toBe(0);
    });

    it('clamps sharpness to 1 when value > 1', () => {
      const cas = new CAS({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });
      vi.clearAllMocks();

      cas.updateParam('sharpness', 2.5);

      const writtenData = mockDevice.queue.writeBuffer.mock.calls[0]?.[2] as Float32Array;
      expect(writtenData[0]).toBe(1);
    });

    it('ignores non-number values', () => {
      const cas = new CAS({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });
      vi.clearAllMocks();

      cas.updateParam('sharpness', '0.5');
      expect(mockDevice.queue.writeBuffer).not.toHaveBeenCalled();
    });

    it('ignores non-finite values (NaN)', () => {
      const cas = new CAS({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });
      vi.clearAllMocks();

      cas.updateParam('sharpness', NaN);
      expect(mockDevice.queue.writeBuffer).not.toHaveBeenCalled();
    });

    it('ignores non-finite values (Infinity)', () => {
      const cas = new CAS({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });
      vi.clearAllMocks();

      cas.updateParam('sharpness', Infinity);
      expect(mockDevice.queue.writeBuffer).not.toHaveBeenCalled();
    });

    it('ignores unknown param names', () => {
      const cas = new CAS({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });
      vi.clearAllMocks();

      cas.updateParam('unknown', 0.5);
      expect(mockDevice.queue.writeBuffer).not.toHaveBeenCalled();
    });
  });

  describe('pass', () => {
    it('records compute pass with correct pipeline, bind group, and workgroup dispatch', async () => {
      const cas = new CAS({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });
      const encoder = (mockDevice as any).createCommandEncoder() as unknown as GPUCommandEncoder;

      await cas.pass(encoder);

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
      const cas = new CAS({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });
      const encoder = (mockDevice as any).createCommandEncoder() as unknown as GPUCommandEncoder;

      const result = cas.pass(encoder);

      expect(result).toBeInstanceOf(Promise);
      await expect(result).resolves.toBeUndefined();
    });
  });

  describe('getOutputTexture', () => {
    it('returns the output texture', () => {
      const cas = new CAS({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });
      const texture = cas.getOutputTexture();

      expect(texture).toBeDefined();
      expect(texture.width).toBe(1920);
      expect(texture.height).toBe(1080);
    });
  });

  describe('destroy', () => {
    it('destroys output texture and params buffer', () => {
      const cas = new CAS({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });
      const outputTexture = cas.getOutputTexture();
      const paramsBuffer = (mockDevice.createBuffer as any).mock.results[0]?.value;

      cas.destroy();

      expect((outputTexture as any).destroy).toHaveBeenCalled();
      expect(paramsBuffer.destroy).toHaveBeenCalled();
    });
  });
});
