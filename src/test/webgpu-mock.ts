/**
 * Reusable WebGPU mock for the Anime4K-WebExtension test suite.
 *
 * Provides installGPUMock() / removeGPUMock() to fully stub the WebGPU API
 * in jsdom, allowing pipeline constructors, GPU device managers, renderers,
 * and effect classes to run without a real GPU.
 *
 * Usage in test files:
 *   import { installGPUMock, removeGPUMock, createMockGPUTexture } from '@/test/webgpu-mock';
 *
 *   beforeEach(() => { installGPUMock(); });
 *   afterEach(() => { removeGPUMock(); });
 */

import { vi } from 'vitest';

// ─── TypeScript interfaces for mock objects (exported for downstream test annotations) ───

interface MockGPUAdapter {
  limits: { maxBufferSize: number; maxStorageBufferBindingSize: number };
  /** Adapter-supported optional features. Mutable so tests can toggle e.g. 'timestamp-query'. */
  features: Set<string>;
  requestDevice: ReturnType<typeof vi.fn>;
  requestAdapterInfo: ReturnType<typeof vi.fn>;
}

export interface MockGPUDevice {
  /** Device-enabled optional features. Mutable so tests can toggle e.g. 'timestamp-query'. */
  features: Set<string>;
  /** Adapter/device limits exposed to geometry planners (e.g. maxTextureDimension2D). */
  limits: {
    maxTextureDimension2D: number;
    maxBufferSize: number;
    maxStorageBufferBindingSize: number;
  };
  createTexture: ReturnType<typeof vi.fn>;
  createBuffer: ReturnType<typeof vi.fn>;
  createShaderModule: ReturnType<typeof vi.fn>;
  createComputePipeline: ReturnType<typeof vi.fn>;
  createRenderPipelineAsync: ReturnType<typeof vi.fn>;
  createBindGroupLayout: ReturnType<typeof vi.fn>;
  createPipelineLayout: ReturnType<typeof vi.fn>;
  createBindGroup: ReturnType<typeof vi.fn>;
  createSampler: ReturnType<typeof vi.fn>;
  createQuerySet: ReturnType<typeof vi.fn>;
  createCommandEncoder: ReturnType<typeof vi.fn>;
  queue: MockGPUQueue;
  lost: Promise<{ reason: string; message: string }>;
  destroy: ReturnType<typeof vi.fn>;
  pushErrorScope: ReturnType<typeof vi.fn>;
  popErrorScope: ReturnType<typeof vi.fn>;
}

interface MockGPUQueue {
  submit: ReturnType<typeof vi.fn>;
  onSubmittedWorkDone: ReturnType<typeof vi.fn>;
  writeBuffer: ReturnType<typeof vi.fn>;
  writeTexture: ReturnType<typeof vi.fn>;
  copyExternalImageToTexture: ReturnType<typeof vi.fn>;
}

interface MockGPUCanvasContext {
  configure: ReturnType<typeof vi.fn>;
  getCurrentTexture: ReturnType<typeof vi.fn>;
  unconfigure: ReturnType<typeof vi.fn>;
}

export interface MockGPUTexture {
  width: number;
  height: number;
  format: string;
  usage: number;
  createView: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

interface MockGPUBuffer {
  size: number;
  usage: number;
  /**
   * True when the mock rejected the usage combination. WebGPU only permits
   * `MAP_READ` together with `COPY_DST`; any other combination models Dawn's
   * asynchronous validation failure: the buffer exists but is invalid and
   * `mapAsync()` rejects.
   */
  invalid: boolean;
  /**
   * Writable/assignable BigUint64Array over the buffer's backing store.
   * Timestamp-profiler tests write nanosecond values here before settling
   * a pending `mapAsync()`.
   */
  data: BigUint64Array;
  destroy: ReturnType<typeof vi.fn>;
  /** Returns the backing ArrayBuffer (what `new BigUint64Array(range)` reads). */
  getMappedRange: ReturnType<typeof vi.fn>;
  /** Pending until the test calls {@link settleMap} or {@link rejectMapWith}. */
  mapAsync: ReturnType<typeof vi.fn>;
  unmap: ReturnType<typeof vi.fn>;
  /** Resolve the most recent pending `mapAsync()` (test control). */
  settleMap(): void;
  /** Reject the most recent pending `mapAsync()` (test control). */
  rejectMapWith(error: unknown): void;
}

export interface MockGPUObjects {
  adapter: MockGPUAdapter;
  device: MockGPUDevice;
  context: MockGPUCanvasContext;
  /** Call resolve({ reason, message }) to simulate device loss in tests. */
  deviceLostDeferred: { resolve: (value: { reason: string; message: string }) => void };
}

// ─── Static enum values (polyfilled as real numbers so bitwise OR works) ───

const GPUTextureUsageValues = {
  TEXTURE_BINDING: 1,
  COPY_DST: 2,
  RENDER_ATTACHMENT: 4,
  STORAGE_BINDING: 8,
  COPY_SRC: 16,
} as const;

const GPUBufferUsageValues = {
  UNIFORM: 1,
  COPY_DST: 2,
  MAP_READ: 1,
  COPY_SRC: 4,
  QUERY_RESOLVE: 512,
} as const;

const GPUMapModeValues = {
  READ: 1,
  WRITE: 2,
} as const;

const GPUShaderStageValues = {
  VERTEX: 1,
  FRAGMENT: 2,
  COMPUTE: 4,
} as const;

// ─── Stored originals for restoration ───

let originalNavigatorGPU: unknown = undefined;
let originalGetContext: typeof HTMLCanvasElement.prototype.getContext | null = null;
let navigatorGPUDescriptor: PropertyDescriptor | null = null;

// ─── Factory: create a standalone mock GPUTexture ───

export function createMockGPUTexture(width = 1, height = 1): MockGPUTexture {
  return {
    width,
    height,
    format: 'rgba8unorm',
    usage: GPUTextureUsageValues.TEXTURE_BINDING,
    createView: vi.fn(() => ({ label: 'texture-view' })),
    destroy: vi.fn(),
  };
}

// ─── Factory: create a standalone mock GPUBuffer ───

/**
 * Create a mock GPUBuffer with a controllable `mapAsync()` and a writable
 * BigUint64Array backing store. Timestamp tests assign `data[i] = ns` then call
 * `settleMap()` (or `rejectMapWith(err)`); profiler readback does
 * `new BigUint64Array(buffer.getMappedRange())` over the same store.
 */
export function createMockGPUBuffer(size = 0, usage = 0): MockGPUBuffer {
  // Backing store is rounded up to a whole BigUint64 so `data` is always valid.
  const byteLength = Math.ceil(Math.max(0, Number(size)) / 8) * 8;
  const backing = new ArrayBuffer(byteLength);
  const data = new BigUint64Array(backing);

  // WebGPU rule: a buffer whose usage includes MAP_READ may not include any
  // other flag except COPY_DST. Chrome/Dawn rejects this at createBuffer
  // without throwing (async uncaptured validation error) and returns an invalid
  // buffer whose mapAsync() rejects.
  const hasMapRead = (usage & GPUBufferUsageValues.MAP_READ) !== 0;
  const hasForbiddenFlag =
    (usage & ~(GPUBufferUsageValues.MAP_READ | GPUBufferUsageValues.COPY_DST)) !== 0;
  const invalid = hasMapRead && hasForbiddenFlag;

  let resolveMap: (() => void) | null = null;
  let rejectMap: ((error: unknown) => void) | null = null;

  return {
    size,
    usage,
    invalid,
    data,
    destroy: vi.fn(),
    getMappedRange: vi.fn(() => backing),
    mapAsync: vi.fn(
      (_mode: number) =>
        new Promise<void>((resolve, reject) => {
          if (invalid) {
            reject(new Error('[webgpu-mock] invalid buffer: MAP_READ combined with a forbidden usage flag'));
            return;
          }
          resolveMap = resolve;
          rejectMap = reject;
        }),
    ),
    unmap: vi.fn(),
    settleMap: () => {
      resolveMap?.();
      resolveMap = null;
      rejectMap = null;
    },
    rejectMapWith: (error: unknown) => {
      rejectMap?.(error);
      rejectMap = null;
      resolveMap = null;
    },
  };
}

// ─── Internal: parse createTexture size descriptor to {width, height} ───

function parseTextureSize(size: unknown): { width: number; height: number } {
  if (Array.isArray(size)) {
    return { width: (size as number[])[0] ?? 1, height: (size as number[])[1] ?? 1 };
  }
  if (size && typeof size === 'object') {
    const s = size as Record<string, number>;
    return { width: s.width ?? 1, height: s.height ?? 1 };
  }
  return { width: 1, height: 1 };
}

// ─── Internal: build the full mock objects ───

interface InternalMockOptions {
  adapterNull: boolean;
}

function buildMockObjects(options: InternalMockOptions): {
  mockGPU: Record<string, unknown>;
  mockAdapter: MockGPUAdapter;
  mockDevice: MockGPUDevice;
  mockContext: MockGPUCanvasContext;
  deviceLostDeferred: { resolve: (value: { reason: string; message: string }) => void };
} {
  // ── Deferred device.lost ──
  let deviceLostResolve!: (value: { reason: string; message: string }) => void;
  const deviceLost = new Promise<{ reason: string; message: string }>((resolve) => {
    deviceLostResolve = resolve;
  });

  const deviceLostDeferred = { resolve: deviceLostResolve };

  // ── Mock GPUQueue ──
  const mockQueue: MockGPUQueue = {
    submit: vi.fn(),
    onSubmittedWorkDone: vi.fn().mockResolvedValue(undefined),
    writeBuffer: vi.fn(),
    writeTexture: vi.fn(),
    copyExternalImageToTexture: vi.fn(),
  };

  // ── Mock GPUDevice ──
  const mockDevice: MockGPUDevice = {
    features: new Set<string>(),
    limits: {
      maxTextureDimension2D: 8192,
      maxBufferSize: 268435456,
      maxStorageBufferBindingSize: 134217728,
    },
    createTexture: vi.fn((descriptor?: Record<string, unknown>) => {
      const { width, height } = parseTextureSize(descriptor?.size);
      return {
        width,
        height,
        format: (descriptor?.format as string) ?? 'rgba8unorm',
        usage: (descriptor?.usage as number) ?? 0,
        createView: vi.fn(() => ({ label: 'texture-view' })),
        destroy: vi.fn(),
      };
    }),
    createBuffer: vi.fn((descriptor?: Record<string, unknown>) =>
      createMockGPUBuffer(Number(descriptor?.size ?? 0), Number(descriptor?.usage ?? 0)),
    ),
    createShaderModule: vi.fn((descriptor?: Record<string, unknown>) => ({
      label: (descriptor?.label as string) ?? 'shader',
    })),
    createComputePipeline: vi.fn(() => ({
      getBindGroupLayout: vi.fn(() => ({ label: 'bind-group-layout' })),
    })),
    createRenderPipelineAsync: vi.fn().mockResolvedValue({
      getBindGroupLayout: vi.fn(() => ({ label: 'bind-group-layout' })),
    }),
    createBindGroupLayout: vi.fn(() => ({ label: 'bind-group-layout' })),
    createPipelineLayout: vi.fn(() => ({ label: 'pipeline-layout' })),
    createBindGroup: vi.fn(() => ({ label: 'bind-group' })),
    createSampler: vi.fn(() => ({ label: 'sampler' })),
    createQuerySet: vi.fn((descriptor?: Record<string, unknown>) => ({
      type: (descriptor?.type as string) ?? 'timestamp',
      count: (descriptor?.count as number) ?? 0,
      label: (descriptor?.label as string) ?? 'query-set',
      destroy: vi.fn(),
    })),
    createCommandEncoder: vi.fn(() => ({
      beginRenderPass: vi.fn(() => ({
        setPipeline: vi.fn(),
        setBindGroup: vi.fn(),
        draw: vi.fn(),
        end: vi.fn(),
        setViewport: vi.fn(),
        setScissorRect: vi.fn(),
      })),
      beginComputePass: vi.fn(() => ({
        setPipeline: vi.fn(),
        setBindGroup: vi.fn(),
        dispatchWorkgroups: vi.fn(),
        end: vi.fn(),
      })),
      resolveQuerySet: vi.fn(),
      finish: vi.fn(() => ({ label: 'command-buffer' })),
      copyTextureToTexture: vi.fn(),
      copyBufferToTexture: vi.fn(),
      copyBufferToBuffer: vi.fn(),
    })),
    queue: mockQueue,
    lost: deviceLost,
    destroy: vi.fn(),
    pushErrorScope: vi.fn(),
    popErrorScope: vi.fn().mockResolvedValue(null),
  };

  // ── Mock GPUAdapter ──
  const mockAdapter: MockGPUAdapter = {
    limits: {
      maxBufferSize: 268435456,
      maxStorageBufferBindingSize: 134217728,
    },
    features: new Set<string>(),
    requestDevice: vi.fn().mockResolvedValue(mockDevice),
    requestAdapterInfo: vi.fn().mockResolvedValue({
      vendor: 'mock-vendor',
      architecture: 'mock-arch',
      device: 'mock-device',
      description: 'mock-description',
    }),
  };

  // ── Mock GPUCanvasContext ──
  // getCurrentTexture() returns a fresh mock texture each call (size matches 1x1 default)
  const mockContext: MockGPUCanvasContext = {
    configure: vi.fn(),
    getCurrentTexture: vi.fn(() => createMockGPUTexture(1, 1)),
    unconfigure: vi.fn(),
  };

  // ── navigator.gpu mock (plain object, cast to GPU wherever needed by callers) ──
  const mockGPU = {
    requestAdapter: vi.fn(() => {
      if (options.adapterNull) return Promise.resolve(null);
      return Promise.resolve(mockAdapter);
    }),
    getPreferredCanvasFormat: vi.fn(() => 'bgra8unorm'),
  };

  return { mockGPU, mockAdapter, mockDevice, mockContext, deviceLostDeferred };
}

// ─── Main install function ───

export function installGPUMock(opts?: { adapterNull?: boolean }): MockGPUObjects {
  const options: InternalMockOptions = {
    adapterNull: opts?.adapterNull ?? false,
  };

  // Save originals
  const nav = navigator as unknown as Record<string, unknown>;
  originalNavigatorGPU = nav.gpu;
  originalGetContext = null;
  navigatorGPUDescriptor = null;

  // Build mock objects
  const { mockGPU, mockAdapter, mockDevice, mockContext, deviceLostDeferred } = buildMockObjects(options);

  // Override navigator.gpu (preserve other navigator properties)
  try {
    navigatorGPUDescriptor = Object.getOwnPropertyDescriptor(navigator, 'gpu') ?? null;
    Object.defineProperty(navigator, 'gpu', {
      value: mockGPU,
      configurable: true,
      writable: true,
    });
  } catch {
    // Fallback: use direct assignment
    nav.gpu = mockGPU;
  }

  // Override HTMLCanvasElement.prototype.getContext for 'webgpu'
  // Use a plain function (not an arrow) so `this` binds to the canvas instance
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  originalGetContext = origGetContext;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (HTMLCanvasElement.prototype as any).getContext = function (
    this: HTMLCanvasElement,
    contextId: string,
    ...args: unknown[]
  ) {
    if (contextId === 'webgpu') {
      return mockContext as unknown as RenderingContext | null;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (origGetContext as any).apply(this, [contextId, ...args] as unknown[]);
  };

  // Stub enum globals
  vi.stubGlobal('GPUTextureUsage', GPUTextureUsageValues);
  vi.stubGlobal('GPUBufferUsage', GPUBufferUsageValues);
  vi.stubGlobal('GPUShaderStage', GPUShaderStageValues);
  vi.stubGlobal('GPUMapMode', GPUMapModeValues);

  return { adapter: mockAdapter, device: mockDevice, context: mockContext, deviceLostDeferred };
}

// ─── Remove function ───

export function removeGPUMock(): void {
  // Restore navigator.gpu
  if (navigatorGPUDescriptor) {
    try {
      Object.defineProperty(navigator, 'gpu', navigatorGPUDescriptor);
    } catch {
      // descriptor restore failed, try direct assignment
      (navigator as unknown as Record<string, unknown>).gpu = originalNavigatorGPU;
    }
  } else {
    try {
      (navigator as unknown as Record<string, unknown>).gpu = originalNavigatorGPU;
    } catch {
      delete (navigator as unknown as Record<string, unknown>).gpu;
    }
  }

  // Restore canvas.getContext
  if (originalGetContext) {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    originalGetContext = null;
  }

  // Unstub enum globals (only our globals — vi.unstubAllGlobals would also
  // remove the chrome stub from test-setup.ts, which is undesirable)
  vi.unstubAllGlobals();

  // Re-apply test-setup chrome stub since vi.unstubAllGlobals removes it.
  // The test-setup.ts only runs once before all tests, so we must re-apply here.
  vi.stubGlobal('chrome', {
    storage: {
      sync: {
        get: vi.fn((_keys: unknown, cb?: (result: Record<string, unknown>) => void) => cb?.({})),
        set: vi.fn((_data: unknown, cb?: () => void) => cb?.()),
      },
      local: {
        get: vi.fn((_keys: unknown, cb?: (result: Record<string, unknown>) => void) => cb?.({})),
        set: vi.fn((_data: unknown, cb?: () => void) => cb?.()),
      },
      onChanged: { addListener: vi.fn() },
    },
    runtime: {
      lastError: null,
      sendMessage: vi.fn(),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    tabs: { sendMessage: vi.fn() },
    i18n: {
      getMessage: vi.fn((key: string) => key),
    },
  });
}
