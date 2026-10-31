import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installGPUMock, removeGPUMock, createMockGPUTexture } from '@/test/webgpu-mock';
import type { MockGPUDevice } from '@/test/webgpu-mock';

vi.mock('@shaders/color-adjust.wgsl', () => ({ default: 'mock-color-adjust-shader' }));

import { ColorAdjust } from './color-adjust';

describe('ColorAdjust', () => {
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
    it('creates output texture with correct usage flags', () => {
      new ColorAdjust({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });

      expect(mockDevice.createTexture).toHaveBeenCalledWith(
        expect.objectContaining({
          size: { width: 1920, height: 1080 },
          format: 'rgba8unorm',
          usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
        }),
      );
    });

    it('creates paramsBuffer (16 bytes) and params2Buffer (8 bytes)', () => {
      new ColorAdjust({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });

      expect(mockDevice.createBuffer).toHaveBeenCalledWith(
        expect.objectContaining({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      );
      expect(mockDevice.createBuffer).toHaveBeenCalledWith(
        expect.objectContaining({ size: 8, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      );
    });

    it('writes default param values to both buffers', () => {
      new ColorAdjust({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });

      // paramsBuffer: [brightness, gamma, contrast, vibrance]
      const firstCall = mockDevice.queue.writeBuffer.mock.calls[0]?.[2] as Float32Array;
      expect(firstCall[0]).toBe(0);   // brightness
      expect(firstCall[1]).toBe(1);   // gamma
      expect(firstCall[2]).toBe(1);   // contrast
      expect(firstCall[3]).toBe(0);   // vibrance

      // params2Buffer: [saturation, exposure]
      const secondCall = mockDevice.queue.writeBuffer.mock.calls[1]?.[2] as Float32Array;
      expect(secondCall[0]).toBe(1);  // saturation
      expect(secondCall[1]).toBe(0);  // exposure
    });

    it('writes custom initial param values to buffers', () => {
      new ColorAdjust({
        device: mockDevice as unknown as GPUDevice,
        inputTexture: inputTexture as unknown as GPUTexture,
        brightness: 0.2,
        gamma: 2.0,
        contrast: 1.5,
        vibrance: 0.3,
        saturation: 0.8,
        exposure: 1.0,
      });

      const firstCall = mockDevice.queue.writeBuffer.mock.calls[0]?.[2] as Float32Array;
      expect(firstCall[0]).toBeCloseTo(0.2, 5);  // brightness
      expect(firstCall[1]).toBe(2.0);  // gamma
      expect(firstCall[2]).toBe(1.5);  // contrast (exact in float32)
      expect(firstCall[3]).toBeCloseTo(0.3, 5);  // vibrance

      const secondCall = mockDevice.queue.writeBuffer.mock.calls[1]?.[2] as Float32Array;
      expect(secondCall[0]).toBeCloseTo(0.8, 5); // saturation
      expect(secondCall[1]).toBe(1.0); // exposure
    });

    it('creates shader module with color-adjust shader code', () => {
      new ColorAdjust({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });

      expect(mockDevice.createShaderModule).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'mock-color-adjust-shader' }),
      );
    });

    it('creates compute pipeline with auto layout and main entry point', () => {
      new ColorAdjust({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });

      expect(mockDevice.createComputePipeline).toHaveBeenCalledWith(
        expect.objectContaining({
          layout: 'auto',
          compute: expect.objectContaining({ entryPoint: 'main' }),
        }),
      );
    });

    it('creates bind group with 4 entries (input, output, params, params2)', () => {
      new ColorAdjust({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });

      expect(mockDevice.createBindGroup).toHaveBeenCalledWith(
        expect.objectContaining({
          entries: expect.arrayContaining([
            expect.objectContaining({ binding: 0 }),
            expect.objectContaining({ binding: 1 }),
            expect.objectContaining({ binding: 2 }),
            expect.objectContaining({ binding: 3 }),
          ]),
        }),
      );
      expect(mockDevice.createBindGroup.mock.calls[0]?.[0]?.entries).toHaveLength(4);
    });
  });

  describe('shader param propagation', () => {
    it('binds paramsBuffer at binding 2 and params2Buffer at binding 3', () => {
      new ColorAdjust({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });

      const paramsBuffer = (mockDevice.createBuffer as any).mock.results[0]?.value;
      const params2Buffer = (mockDevice.createBuffer as any).mock.results[1]?.value;
      const entries = mockDevice.createBindGroup.mock.calls[0]?.[0]?.entries as any[];

      expect(entries.find((e) => e.binding === 2)?.resource.buffer).toBe(paramsBuffer);
      expect(entries.find((e) => e.binding === 3)?.resource.buffer).toBe(params2Buffer);
    });

    it('routes the configured saturation and exposure to the shader-bound secondary buffer', () => {
      new ColorAdjust({
        device: mockDevice as unknown as GPUDevice,
        inputTexture: inputTexture as unknown as GPUTexture,
        saturation: 1.4,
        exposure: -0.7,
      });

      const params2Buffer = (mockDevice.createBuffer as any).mock.results[1]?.value;
      const writeCall = mockDevice.queue.writeBuffer.mock.calls.find((c) => c[0] === params2Buffer);

      expect(writeCall).toBeDefined();
      const writtenData = writeCall?.[2] as Float32Array;
      expect(writtenData[0]).toBeCloseTo(1.4, 5);
      expect(writtenData[1]).toBeCloseTo(-0.7, 5);
    });

    it('routes a runtime saturation update to the shader-bound secondary buffer', () => {
      const ca = new ColorAdjust({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });
      const params2Buffer = (mockDevice.createBuffer as any).mock.results[1]?.value;
      vi.clearAllMocks();

      ca.updateParam('saturation', 0.6);

      const writeCall = mockDevice.queue.writeBuffer.mock.calls.find((c) => c[0] === params2Buffer);
      expect(writeCall).toBeDefined();
      const writtenData = writeCall?.[2] as Float32Array;
      expect(writtenData[0]).toBeCloseTo(0.6, 5);
    });

    it('routes a runtime brightness update to the shader-bound primary buffer', () => {
      const ca = new ColorAdjust({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });
      const paramsBuffer = (mockDevice.createBuffer as any).mock.results[0]?.value;
      vi.clearAllMocks();

      ca.updateParam('brightness', 0.25);

      const writeCall = mockDevice.queue.writeBuffer.mock.calls.find((c) => c[0] === paramsBuffer);
      expect(writeCall).toBeDefined();
      const writtenData = writeCall?.[2] as Float32Array;
      expect(writtenData[0]).toBeCloseTo(0.25, 5);
    });
  });

  describe('updateParam', () => {
    function createColorAdjust() {
      return new ColorAdjust({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });
    }

    it('updates brightness and clamps to [-1, 1]', () => {
      const ca = createColorAdjust();
      vi.clearAllMocks();

      ca.updateParam('brightness', 0.5);
      const data = mockDevice.queue.writeBuffer.mock.calls[0]?.[2] as Float32Array;
      expect(data[0]).toBe(0.5);

      vi.clearAllMocks();
      ca.updateParam('brightness', -2);
      const clamped = mockDevice.queue.writeBuffer.mock.calls[0]?.[2] as Float32Array;
      expect(clamped[0]).toBe(-1);

      vi.clearAllMocks();
      ca.updateParam('brightness', 2);
      const clamped2 = mockDevice.queue.writeBuffer.mock.calls[0]?.[2] as Float32Array;
      expect(clamped2[0]).toBe(1);
    });

    it('updates gamma and clamps to [0.1, 4]', () => {
      const ca = createColorAdjust();
      vi.clearAllMocks();

      ca.updateParam('gamma', 2.5);
      const data = mockDevice.queue.writeBuffer.mock.calls[0]?.[2] as Float32Array;
      expect(data[1]).toBe(2.5);

      vi.clearAllMocks();
      ca.updateParam('gamma', 0);
      const clamped = mockDevice.queue.writeBuffer.mock.calls[0]?.[2] as Float32Array;
      expect(clamped[1]).toBeCloseTo(0.1, 5);

      vi.clearAllMocks();
      ca.updateParam('gamma', 5);
      const clamped2 = mockDevice.queue.writeBuffer.mock.calls[0]?.[2] as Float32Array;
      expect(clamped2[1]).toBe(4);
    });

    it('updates contrast and clamps to [0, 2]', () => {
      const ca = createColorAdjust();
      vi.clearAllMocks();

      ca.updateParam('contrast', 1.5);
      const data = mockDevice.queue.writeBuffer.mock.calls[0]?.[2] as Float32Array;
      expect(data[2]).toBe(1.5);

      vi.clearAllMocks();
      ca.updateParam('contrast', -0.5);
      const clamped = mockDevice.queue.writeBuffer.mock.calls[0]?.[2] as Float32Array;
      expect(clamped[2]).toBe(0);

      vi.clearAllMocks();
      ca.updateParam('contrast', 3);
      const clamped2 = mockDevice.queue.writeBuffer.mock.calls[0]?.[2] as Float32Array;
      expect(clamped2[2]).toBe(2);
    });

    it('updates saturation and clamps to [0, 2]', () => {
      const ca = createColorAdjust();
      vi.clearAllMocks();

      ca.updateParam('saturation', 1.5);
      // Saturation lives in params2Buffer
      const data = mockDevice.queue.writeBuffer.mock.calls[1]?.[2] as Float32Array;
      expect(data[0]).toBe(1.5);

      vi.clearAllMocks();
      ca.updateParam('saturation', -1);
      const clamped = mockDevice.queue.writeBuffer.mock.calls[1]?.[2] as Float32Array;
      expect(clamped[0]).toBe(0);

      vi.clearAllMocks();
      ca.updateParam('saturation', 3);
      const clamped2 = mockDevice.queue.writeBuffer.mock.calls[1]?.[2] as Float32Array;
      expect(clamped2[0]).toBe(2);
    });

    it('updates vibrance and clamps to [-1, 1]', () => {
      const ca = createColorAdjust();
      vi.clearAllMocks();

      ca.updateParam('vibrance', 0.7);
      const data = mockDevice.queue.writeBuffer.mock.calls[0]?.[2] as Float32Array;
      expect(data[3]).toBeCloseTo(0.7, 5);

      vi.clearAllMocks();
      ca.updateParam('vibrance', -2);
      const clamped = mockDevice.queue.writeBuffer.mock.calls[0]?.[2] as Float32Array;
      expect(clamped[3]).toBe(-1);

      vi.clearAllMocks();
      ca.updateParam('vibrance', 2);
      const clamped2 = mockDevice.queue.writeBuffer.mock.calls[0]?.[2] as Float32Array;
      expect(clamped2[3]).toBe(1);
    });

    it('updates exposure and clamps to [-3, 3]', () => {
      const ca = createColorAdjust();
      vi.clearAllMocks();

      ca.updateParam('exposure', 2);
      const data = mockDevice.queue.writeBuffer.mock.calls[1]?.[2] as Float32Array;
      expect(data[1]).toBe(2);

      vi.clearAllMocks();
      ca.updateParam('exposure', -4);
      const clamped = mockDevice.queue.writeBuffer.mock.calls[1]?.[2] as Float32Array;
      expect(clamped[1]).toBe(-3);

      vi.clearAllMocks();
      ca.updateParam('exposure', 5);
      const clamped2 = mockDevice.queue.writeBuffer.mock.calls[1]?.[2] as Float32Array;
      expect(clamped2[1]).toBe(3);
    });

    it('writes both buffers on param update', () => {
      const ca = createColorAdjust();
      vi.clearAllMocks();

      ca.updateParam('brightness', 0.5);

      expect(mockDevice.queue.writeBuffer).toHaveBeenCalledTimes(2);
    });

    it('ignores non-number values', () => {
      const ca = createColorAdjust();
      vi.clearAllMocks();

      ca.updateParam('brightness', '0.5');
      expect(mockDevice.queue.writeBuffer).not.toHaveBeenCalled();
    });

    it('ignores non-finite values (NaN)', () => {
      const ca = createColorAdjust();
      vi.clearAllMocks();

      ca.updateParam('gamma', NaN);
      expect(mockDevice.queue.writeBuffer).not.toHaveBeenCalled();
    });

    it('ignores non-finite values (Infinity)', () => {
      const ca = createColorAdjust();
      vi.clearAllMocks();

      ca.updateParam('gamma', Infinity);
      expect(mockDevice.queue.writeBuffer).not.toHaveBeenCalled();
    });

    it('ignores unknown param names', () => {
      const ca = createColorAdjust();
      vi.clearAllMocks();

      ca.updateParam('unknownParam', 0.5);
      expect(mockDevice.queue.writeBuffer).not.toHaveBeenCalled();
    });
  });

  describe('pass', () => {
    it('records compute pass with correct pipeline, bind group, and workgroup dispatch', async () => {
      const ca = new ColorAdjust({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });
      const encoder = (mockDevice as any).createCommandEncoder() as unknown as GPUCommandEncoder;

      await ca.pass(encoder);

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
      const ca = new ColorAdjust({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });
      const encoder = (mockDevice as any).createCommandEncoder() as unknown as GPUCommandEncoder;

      const result = ca.pass(encoder);

      expect(result).toBeInstanceOf(Promise);
      await expect(result).resolves.toBeUndefined();
    });
  });

  describe('getOutputTexture', () => {
    it('returns the output texture', () => {
      const ca = new ColorAdjust({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });

      const texture = ca.getOutputTexture();
      expect(texture).toBeDefined();
      expect(texture.width).toBe(1920);
      expect(texture.height).toBe(1080);
    });
  });

  describe('destroy', () => {
    it('destroys output texture and both param buffers', () => {
      const ca = new ColorAdjust({ device: mockDevice as unknown as GPUDevice, inputTexture: inputTexture as unknown as GPUTexture });
      const outputTexture = ca.getOutputTexture();
      const paramsBuffer = (mockDevice.createBuffer as any).mock.results[0]?.value;
      const params2Buffer = (mockDevice.createBuffer as any).mock.results[1]?.value;

      ca.destroy();

      expect((outputTexture as any).destroy).toHaveBeenCalled();
      expect(paramsBuffer.destroy).toHaveBeenCalled();
      expect(params2Buffer.destroy).toHaveBeenCalled();
    });
  });
});
