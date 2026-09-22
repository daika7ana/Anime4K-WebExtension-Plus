/**
 * Tests for the per-device GPU resource cache.
 *
 * The shared WebGPU mock (src/test/webgpu-mock.ts) is used for the shader-module
 * identity paths. The synchronous creation-failure path uses a minimal local
 * fake device defined here. The shared mock is intentionally not modified.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installGPUMock, removeGPUMock } from '@/test/webgpu-mock';
import { GpuResourceCache } from './gpu-resource-cache';

// ─── Minimal local fake device (covers the async + error-scope paths) ───

interface FakeDevice {
  createShaderModule: ReturnType<typeof vi.fn>;
  pushErrorScope: ReturnType<typeof vi.fn>;
  popErrorScope: ReturnType<typeof vi.fn>;
}

function createFakeDevice(overrides: Record<string, unknown> = {}): FakeDevice {
  const device: FakeDevice = {
    createShaderModule: vi.fn((descriptor: GPUShaderModuleDescriptor) => ({ __kind: 'shader', ...descriptor })),
    pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(async () => null),
  };
  return Object.assign(device, overrides);
}

function asDevice(device: FakeDevice | object): GPUDevice {
  return device as unknown as GPUDevice;
}

describe('GpuResourceCache (shared WebGPU mock, shader modules)', () => {
  let cache: GpuResourceCache;
  let device: GPUDevice;

  beforeEach(() => {
    const mock = installGPUMock();
    cache = new GpuResourceCache();
    device = mock.device as unknown as GPUDevice;
  });

  afterEach(() => {
    removeGPUMock();
  });

  it('returns identical shader module object identity for the same code', () => {
    const a = cache.getShaderModule(device, 'shader-code', 'my-shader');
    const b = cache.getShaderModule(device, 'shader-code', 'my-shader');

    expect(a).toBe(b);
  });

  it('returns distinct shader modules for different code', () => {
    const a = cache.getShaderModule(device, 'shader-a');
    const b = cache.getShaderModule(device, 'shader-b');

    expect(a).not.toBe(b);
  });

  it('treats the same code under different labels as distinct modules', () => {
    const a = cache.getShaderModule(device, 'code', 'label-a');
    const b = cache.getShaderModule(device, 'code', 'label-b');

    expect(a).not.toBe(b);
  });

  it('does not share resources across different devices', () => {
    const other = asDevice(createFakeDevice());
    const a = cache.getShaderModule(device, 'code');
    const b = cache.getShaderModule(other, 'code');

    expect(a).not.toBe(b);
  });
});

describe('GpuResourceCache (local fake device, creation errors + release)', () => {
  it('wraps synchronous creation failures and does not cache them', () => {
    const cache = new GpuResourceCache();
    const device = createFakeDevice({
      createShaderModule: vi.fn(() => {
        throw new Error('synchronous failure');
      }),
    });

    expect(() => cache.getShaderModule(asDevice(device), 'code', 'bad')).toThrow(/bad/);

    // Not cached: a retry calls the device again.
    expect(() => cache.getShaderModule(asDevice(device), 'code', 'bad')).toThrow();
    expect(device.createShaderModule).toHaveBeenCalledTimes(2);
  });

  it('works without error-scope support (feature-detected)', () => {
    const cache = new GpuResourceCache();
    const noScopeDevice = {
      createShaderModule: vi.fn(() => ({ __kind: 'shader' })),
    };

    const shader = cache.getShaderModule(asDevice(noScopeDevice), 'code');
    expect(shader).toBeDefined();
  });

  it('release(device) drops that device caches and recreates on the next request', () => {
    const cache = new GpuResourceCache();
    const device = createFakeDevice();

    const first = cache.getShaderModule(asDevice(device), 'code', 'shader');
    expect(cache.getShaderModule(asDevice(device), 'code', 'shader')).toBe(first);

    cache.release(asDevice(device));

    // After release, the resource is recreated rather than served stale.
    const second = cache.getShaderModule(asDevice(device), 'code', 'shader');
    expect(second).not.toBe(first);
    expect(device.createShaderModule).toHaveBeenCalledTimes(2);
  });

  it('release(device) only affects the released device', () => {
    const cache = new GpuResourceCache();
    const deviceA = createFakeDevice();
    const deviceB = createFakeDevice();

    cache.getShaderModule(asDevice(deviceA), 'code');
    cache.getShaderModule(asDevice(deviceB), 'code');

    cache.release(asDevice(deviceA));

    expect(cache.getShaderModule(asDevice(deviceB), 'code')).toBeDefined();
    // Device B still serves its cached object (no extra creation).
    expect(deviceB.createShaderModule).toHaveBeenCalledTimes(1);
  });

  it('release(device) is idempotent', () => {
    const cache = new GpuResourceCache();
    const device = createFakeDevice();

    cache.getShaderModule(asDevice(device), 'code');
    cache.release(asDevice(device));
    expect(() => cache.release(asDevice(device))).not.toThrow();
    expect(() => cache.release(asDevice(createFakeDevice()))).not.toThrow();

    // Still usable after a repeated release.
    expect(cache.getShaderModule(asDevice(device), 'code')).toBeDefined();
  });
});
