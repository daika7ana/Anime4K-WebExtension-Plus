/**
 * Smoke tests for the shared WebGPU mock.
 * Verifies that installGPUMock/removeGPUMock correctly stub the WebGPU API
 * surface and that all mocking primitives work as expected.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  installGPUMock,
  removeGPUMock,
  createMockGPUTexture,
} from '@/test/webgpu-mock';
import type {
  MockGPUObjects,
} from '@/test/webgpu-mock';

// ─── Helper: get adapter and device instances cast as `any` to avoid TS noise ───

async function getAdapter(): Promise<any> {
  return navigator.gpu.requestAdapter() as any;
}

async function getDevice(): Promise<any> {
  const adapter = await getAdapter();
  return adapter.requestDevice();
}

describe('WebGPU Mock (smoke tests)', () => {
  let mock: MockGPUObjects;

  beforeEach(() => {
    mock = installGPUMock();
  });

  afterEach(() => {
    removeGPUMock();
  });

  // ─── navigator.gpu ───

  describe('navigator.gpu', () => {
    it('exists after installGPUMock()', () => {
      expect(navigator.gpu).toBeDefined();
    });

    it('has requestAdapter and getPreferredCanvasFormat', () => {
      expect((navigator.gpu as any).requestAdapter).toBeDefined();
      expect((navigator.gpu as any).getPreferredCanvasFormat).toBeDefined();
    });

    it('getPreferredCanvasFormat() returns "bgra8unorm"', () => {
      expect(navigator.gpu!.getPreferredCanvasFormat()).toBe('bgra8unorm');
    });
  });

  // ─── GPUAdapter ───

  describe('GPUAdapter', () => {
    it('requestAdapter() resolves to the mock adapter', async () => {
      const gpu = navigator.gpu as any;
      const adapter = await gpu.requestAdapter();
      expect(adapter).toBeDefined();
      expect(adapter).toBe(mock.adapter);
    });

    it('adapter.limits has expected values', async () => {
      const adapter = await getAdapter();
      expect(adapter.limits.maxBufferSize).toBe(268435456);
      expect(adapter.limits.maxStorageBufferBindingSize).toBe(134217728);
    });

    it('adapter.requestAdapterInfo() resolves with mock info', async () => {
      const adapter = await getAdapter();
      const info = await adapter.requestAdapterInfo();
      expect(info).toEqual({
        vendor: 'mock-vendor',
        architecture: 'mock-arch',
        device: 'mock-device',
        description: 'mock-description',
      });
    });
  });

  // ─── GPUDevice ───

  describe('GPUDevice', () => {
    it('requestDevice() resolves to the mock device', async () => {
      const device = await getDevice();
      expect(device).toBeDefined();
    });

    it('device.lost is a Promise', async () => {
      const device = await getDevice();
      expect(device.lost).toBeInstanceOf(Promise);
    });

    it('device.destroy is a function', async () => {
      const device = await getDevice();
      expect(typeof device.destroy).toBe('function');
      device.destroy();
      expect(device.destroy).toHaveBeenCalled();
    });

    it('createTexture returns texture with width/height from descriptor size array', async () => {
      const device = await getDevice();
      const tex = device.createTexture({ size: [1920, 1080], format: 'rgba8unorm', usage: 1 });
      expect(tex.width).toBe(1920);
      expect(tex.height).toBe(1080);
      expect(tex.format).toBe('rgba8unorm');
      expect(typeof tex.createView).toBe('function');
      expect(typeof tex.destroy).toBe('function');
    });

    it('createTexture returns texture with width/height from descriptor size object', async () => {
      const device = await getDevice();
      const tex = device.createTexture({ size: { width: 640, height: 360 }, format: 'bgra8unorm', usage: 2 });
      expect(tex.width).toBe(640);
      expect(tex.height).toBe(360);
      expect(tex.format).toBe('bgra8unorm');
    });

    it('createTexture defaults width/height to 1', async () => {
      const device = await getDevice();
      const tex = device.createTexture({ size: {} });
      expect(tex.width).toBe(1);
      expect(tex.height).toBe(1);
    });

    it('createBuffer returns buffer with size and usage', async () => {
      const device = await getDevice();
      const buf = device.createBuffer({ size: 16, usage: (globalThis as any).GPUTextureUsage.TEXTURE_BINDING });
      expect(buf.size).toBe(16);
      expect(typeof buf.destroy).toBe('function');
      expect(typeof buf.mapAsync).toBe('function');
    });

    it('createBuffer.getMappedRange returns an ArrayBuffer', async () => {
      const device = await getDevice();
      const buf = device.createBuffer({ size: 16, usage: 1 });
      const range = buf.getMappedRange();
      expect(range).toBeInstanceOf(ArrayBuffer);
    });

    it('accepts MAP_READ combined only with COPY_DST', async () => {
      const device = await getDevice();
      const usage = (globalThis as any).GPUBufferUsage;
      const buf = device.createBuffer({ size: 16, usage: usage.MAP_READ | usage.COPY_DST });
      expect(buf.invalid).toBe(false);
      // A valid buffer's mapAsync stays pending until settled; it must not reject.
      expect(buf.mapAsync(1)).toBeInstanceOf(Promise);
    });

    it('models MAP_READ + forbidden flag as an invalid, asynchronously-failing buffer', async () => {
      const device = await getDevice();
      const usage = (globalThis as any).GPUBufferUsage;
      const buf = device.createBuffer({ size: 16, usage: usage.MAP_READ | usage.COPY_SRC });
      expect(buf.invalid).toBe(true);
      await expect(buf.mapAsync(1)).rejects.toThrow(/invalid buffer/);
    });

    it('models MAP_READ + QUERY_RESOLVE as invalid without throwing at createBuffer', async () => {
      const device = await getDevice();
      const usage = (globalThis as any).GPUBufferUsage;
      const buf = device.createBuffer({ size: 16, usage: usage.MAP_READ | usage.QUERY_RESOLVE });
      expect(buf.invalid).toBe(true);
      await expect(buf.mapAsync(1)).rejects.toThrow(/invalid buffer/);
    });

    it('createShaderModule returns opaque shader object', async () => {
      const device = await getDevice();
      const mod = device.createShaderModule({ code: 'fn main() {}', label: 'test-shader' });
      expect(mod.label).toBe('test-shader');
    });

    it('createComputePipeline returns pipeline with getBindGroupLayout', async () => {
      const device = await getDevice();
      const pipeline = device.createComputePipeline({ layout: 'auto', compute: {} });
      const layout = pipeline.getBindGroupLayout(0);
      expect(layout.label).toBe('bind-group-layout');
    });

    it('createRenderPipelineAsync resolves with pipeline', async () => {
      const device = await getDevice();
      const pipeline = await device.createRenderPipelineAsync({});
      expect(pipeline.getBindGroupLayout).toBeDefined();
    });

    it('createBindGroupLayout returns opaque layout', async () => {
      const device = await getDevice();
      const layout = device.createBindGroupLayout({ entries: [] });
      expect(layout.label).toBe('bind-group-layout');
    });

    it('createPipelineLayout returns opaque layout', async () => {
      const device = await getDevice();
      const layout = device.createPipelineLayout({ bindGroupLayouts: [] });
      expect(layout.label).toBe('pipeline-layout');
    });

    it('createBindGroup returns opaque bind group', async () => {
      const device = await getDevice();
      const group = device.createBindGroup({ layout: {}, entries: [] });
      expect(group.label).toBe('bind-group');
    });

    it('createSampler returns opaque sampler', async () => {
      const device = await getDevice();
      const sampler = device.createSampler({ magFilter: 'linear' });
      expect(sampler.label).toBe('sampler');
    });

    it('pushErrorScope / popErrorScope work', async () => {
      const device = await getDevice();
      device.pushErrorScope();
      const err = await device.popErrorScope();
      expect(err).toBeNull();
    });
  });

  // ─── GPUQueue ───

  describe('GPUQueue', () => {
    it('exists on device', async () => {
      const device = await getDevice();
      expect(device.queue).toBeDefined();
    });

    it('submit, writeBuffer, writeTexture, copyExternalImageToTexture are functions', async () => {
      const device = await getDevice();
      expect(typeof device.queue.submit).toBe('function');
      expect(typeof device.queue.writeBuffer).toBe('function');
      expect(typeof device.queue.writeTexture).toBe('function');
      expect(typeof device.queue.copyExternalImageToTexture).toBe('function');
    });

    it('onSubmittedWorkDone resolves', async () => {
      const device = await getDevice();
      await expect(device.queue.onSubmittedWorkDone()).resolves.toBeUndefined();
    });

    it('submit accepts command buffers', async () => {
      const device = await getDevice();
      const encoder = device.createCommandEncoder();
      device.queue.submit([encoder.finish()]);
      expect(device.queue.submit).toHaveBeenCalled();
    });
  });

  // ─── GPUCommandEncoder ───

  describe('GPUCommandEncoder', () => {
    it('createCommandEncoder returns encoder with beginComputePass/beginRenderPass/finish', async () => {
      const device = await getDevice();
      const encoder = device.createCommandEncoder();
      expect(typeof encoder.beginComputePass).toBe('function');
      expect(typeof encoder.beginRenderPass).toBe('function');
      expect(typeof encoder.finish).toBe('function');
    });

    it('finish() returns opaque command buffer', async () => {
      const device = await getDevice();
      const encoder = device.createCommandEncoder();
      const buf = encoder.finish();
      expect(buf.label).toBe('command-buffer');
    });

    it('beginComputePass returns compute pass encoder', async () => {
      const device = await getDevice();
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      expect(typeof pass.setPipeline).toBe('function');
      expect(typeof pass.setBindGroup).toBe('function');
      expect(typeof pass.dispatchWorkgroups).toBe('function');
      expect(typeof pass.end).toBe('function');
    });

    it('beginRenderPass returns render pass encoder', async () => {
      const device = await getDevice();
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [],
      });
      expect(typeof pass.setPipeline).toBe('function');
      expect(typeof pass.setBindGroup).toBe('function');
      expect(typeof pass.draw).toBe('function');
      expect(typeof pass.end).toBe('function');
      expect(typeof pass.setViewport).toBe('function');
      expect(typeof pass.setScissorRect).toBe('function');
    });

    it('has copyTextureToTexture / copyBufferToTexture / copyBufferToBuffer', async () => {
      const device = await getDevice();
      const encoder = device.createCommandEncoder();
      expect(typeof encoder.copyTextureToTexture).toBe('function');
      expect(typeof encoder.copyBufferToTexture).toBe('function');
      expect(typeof encoder.copyBufferToBuffer).toBe('function');
    });
  });

  // ─── GPUCanvasContext ───

  describe('GPUCanvasContext (canvas.getContext)', () => {
    it('canvas.getContext("webgpu") returns mock context', () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('webgpu');
      expect(ctx).toBeDefined();
      expect(ctx).toBe(mock.context);
    });

    it('mock context has configure / getCurrentTexture / unconfigure', () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('webgpu') as any;
      expect(typeof ctx.configure).toBe('function');
      expect(typeof ctx.getCurrentTexture).toBe('function');
      expect(typeof ctx.unconfigure).toBe('function');
    });

    it('configure is callable', () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('webgpu') as any;
      ctx.configure({ device: {} as GPUDevice, format: 'bgra8unorm' });
      expect(ctx.configure).toHaveBeenCalled();
    });

    it('getCurrentTexture returns a mock texture', () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('webgpu') as any;
      const tex = ctx.getCurrentTexture();
      expect(tex.width).toBe(1);
      expect(tex.height).toBe(1);
      expect(tex.format).toBe('rgba8unorm');
      expect(typeof tex.createView).toBe('function');
      expect(typeof tex.destroy).toBe('function');
    });

    it('canvas.getContext("2d") delegates to original (does not intercept)', () => {
      // The original getContext is saved before overriding and called
      // for non-webgpu context types. Verify calling it does not throw.
      const canvas = document.createElement('canvas');
      expect(() => canvas.getContext('2d')).not.toThrow();
    });
  });

  // ─── Static enum values ───

  describe('static enum globals', () => {
    it('GPUTextureUsage values are polyfilled', () => {
      const g = (globalThis as any).GPUTextureUsage;
      expect(g.TEXTURE_BINDING).toBe(1);
      expect(g.COPY_DST).toBe(2);
      expect(g.RENDER_ATTACHMENT).toBe(4);
      expect(g.STORAGE_BINDING).toBe(8);
      expect(g.COPY_SRC).toBe(16);
    });

    it('GPUTextureUsage bitwise OR produces truthy number', () => {
      const g = (globalThis as any).GPUTextureUsage;
      const combined = g.TEXTURE_BINDING | g.STORAGE_BINDING;
      expect(combined).toBe(9); // 1 | 8
    });

    it('GPUBufferUsage values are polyfilled', () => {
      const g = (globalThis as any).GPUBufferUsage;
      expect(g.UNIFORM).toBe(1);
      expect(g.COPY_DST).toBe(2);
    });

    it('GPUShaderStage values are polyfilled', () => {
      const g = (globalThis as any).GPUShaderStage;
      expect(g.VERTEX).toBe(1);
      expect(g.FRAGMENT).toBe(2);
      expect(g.COMPUTE).toBe(4);
    });
  });

  // ─── createMockGPUTexture standalone ───

  describe('createMockGPUTexture()', () => {
    it('creates texture with given dimensions', () => {
      const tex = createMockGPUTexture(640, 360);
      expect(tex.width).toBe(640);
      expect(tex.height).toBe(360);
      expect(tex.format).toBe('rgba8unorm');
    });

    it('creates texture with default dimensions (1x1)', () => {
      const tex = createMockGPUTexture();
      expect(tex.width).toBe(1);
      expect(tex.height).toBe(1);
    });

    it('createView returns opaque view', () => {
      const tex = createMockGPUTexture() as any;
      const view = tex.createView();
      expect(view.label).toBe('texture-view');
    });

    it('destroy is callable', () => {
      const tex = createMockGPUTexture() as any;
      tex.destroy();
      expect(tex.destroy).toHaveBeenCalled();
    });
  });

  // ─── device.lost deferred ───

  describe('device.lost deferred', () => {
    it('deviceLostDeferred is exposed in the returned object', () => {
      expect(mock.deviceLostDeferred).toBeDefined();
      expect(typeof mock.deviceLostDeferred.resolve).toBe('function');
    });

    it('resolving deviceLostDeferred resolves device.lost', async () => {
      const device = await getDevice();

      const lostPromise = device.lost.then((info: any) => {
        expect(info.reason).toBe('test-reason');
        expect(info.message).toBe('test-message');
      });

      mock.deviceLostDeferred.resolve({ reason: 'test-reason', message: 'test-message' });
      await lostPromise;
    });
  });

  // ─── Teardown / restoration ───

  describe('removeGPUMock()', () => {
    it('is idempotent (safe to call twice)', () => {
      removeGPUMock();
      expect(() => removeGPUMock()).not.toThrow();
      // Re-install for subsequent tests
      installGPUMock();
    });
  });

  // ─── adapterNull option ───

  describe('installGPUMock({ adapterNull: true })', () => {
    it('requestAdapter returns null', async () => {
      // Temporarily override with adapterNull: true
      removeGPUMock();
      installGPUMock({ adapterNull: true });
      const gpu = navigator.gpu as any;
      const adapter = await gpu.requestAdapter();
      expect(adapter).toBeNull();
      // Clean up
      removeGPUMock();
      // Re-install normal for subsequent tests
      installGPUMock();
    });
  });
});
