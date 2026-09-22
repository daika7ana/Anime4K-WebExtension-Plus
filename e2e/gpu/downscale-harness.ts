/**
 * Shared headless-WebGPU plumbing for the Downscale correctness / MTF gates.
 *
 * Extracted from `downscale-correctness.spec.ts` so the new MTF experiment can
 * reuse the exact same secure-origin server, shader loader, generic
 * dispatch/readback path and f16 decoder. The original correctness spec is
 * intentionally left untouched (behaviour must not change); this module is the
 * single source for new GPU specs.
 *
 * Every function here models the rgba16float output of a Downscale-style
 * kernel (`binding 0`: rgba8unorm input, `binding 1`: rgba16float storage
 * output, entry point `computeMain`, 8x8 workgroups).
 *
 * NOTE (intentional remaining duplication): `halfToFloat` is re-declared inside
 * each of the three `page.evaluate` callbacks below. Playwright serialises the
 * callback source and runs it in the page, so the callback cannot close over
 * this module's scope; the copies are byte-exact and must stay in sync.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, type Page } from '@playwright/test';

/** Path prefix under the secure origin that serves the linked library `dist/`. */
export const VENDOR_PREFIX = '/vendor/anime4k/';

export interface GpuRequest {
  wgsl: string;
  srcWidth: number;
  srcHeight: number;
  outWidth: number;
  outHeight: number;
  pixels: number[];
}

export interface GpuSuccess {
  ok: true;
  width: number;
  height: number;
  data: number[];
  adapterInfo: string;
  software: boolean;
}

export interface GpuFailure {
  ok: false;
  kind: 'unavailable' | 'validation';
  error: string;
}

export type GpuResult = GpuSuccess | GpuFailure;

export const ALLOW_GPU_SKIP = process.env.ALLOW_GPU_SKIP === '1';

export const PAGE_HTML =
  '<!doctype html><html><head><meta charset="utf-8">'
  + '<title>gpu-downscale</title></head><body></body></html>';

/**
 * Resolve the linked library's per-module ESM graph on disk: resolve the
 * package entry (`dist/index.js`) and return its directory. The whole `dist/`
 * tree is served under {@link VENDOR_PREFIX} so the browser can follow the
 * relative `.js` specifiers and lazy `import()` chunks.
 */
export function resolveLibraryDistDir(): string {
  const require = createRequire(__filename);
  const entry = require.resolve('anime4k-webgpu-async');
  const distDir = path.dirname(entry);
  if (!existsSync(path.join(distDir, 'index.js'))) {
    throw new Error(`anime4k-webgpu-async dist entry not found next to ${entry}`);
  }
  return distDir;
}

function contentTypeFor(filePath: string): string {
  if (filePath.endsWith('.js') || filePath.endsWith('.mjs')) {
    return 'text/javascript; charset=utf-8';
  }
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.map')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

export interface SecureOriginOptions {
  /**
   * When true (default) the linked library's `dist/` tree is served under
   * {@link VENDOR_PREFIX} so a page can `import()` the real compiled package.
   * Specs that only dispatch inline WGSL pass `false` to keep their server
   * minimal (behaviorally identical to their pre-dedup local implementation).
   */
  serveVendor?: boolean;
  /** Response body for non-vendor requests. Defaults to {@link PAGE_HTML}. */
  pageHtml?: string;
}

export function startSecureOrigin(
  options: SecureOriginOptions = {},
): Promise<{ server: Server; origin: string }> {
  const { serveVendor = true, pageHtml = PAGE_HTML } = options;
  let distDir: string | null = null;
  if (serveVendor) {
    try {
      distDir = resolveLibraryDistDir();
    } catch {
      // The vendor route is simply unavailable; the page still loads.
      distDir = null;
    }
  }

  const created = createServer((req, res) => {
    const rawUrl = req.url ?? '/';
    const pathname = decodeURIComponent(rawUrl.split('?')[0].split('#')[0]);
    if (distDir && pathname.startsWith(VENDOR_PREFIX)) {
      const relative = pathname.slice(VENDOR_PREFIX.length);
      const target = path.resolve(distDir, relative);
      // Refuse path traversal outside the served dist tree.
      if (target !== distDir && !target.startsWith(`${distDir}${path.sep}`)) {
        res.statusCode = 403;
        res.end('forbidden');
        return;
      }
      try {
        const body = readFileSync(target);
        res.setHeader('Content-Type', contentTypeFor(target));
        res.end(body);
      } catch {
        res.statusCode = 404;
        res.end('not found');
      }
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(pageHtml);
  });
  return new Promise((resolve, reject) => {
    created.once('error', reject);
    created.listen(0, '127.0.0.1', () => {
      const address = created.address();
      if (!address || typeof address === 'string') {
        reject(new Error('failed to determine loopback port'));
        return;
      }
      resolve({ server: created, origin: `http://127.0.0.1:${address.port}/` });
    });
  });
}

/**
 * Resolve the compiled WGSL module robustly: resolve the package entry, then
 * look for the shader text module next to `dist/index.js`. Works for both the
 * linked local repo and a published tarball.
 */
export function resolveDownscaleWgslPath(label: string): string {
  const require = createRequire(__filename);
  let entry: string;
  try {
    entry = require.resolve('anime4k-webgpu-async');
  } catch (error) {
    throw new Error(`${label}: cannot resolve 'anime4k-webgpu-async': ${String(error)}`, {
      cause: error,
    });
  }
  const candidate = path.join(
    path.dirname(entry),
    'pipelines',
    'helpers',
    'Downscale',
    'shaders',
    'downscale.wgsl.js',
  );
  if (!existsSync(candidate)) {
    throw new Error(`${label}: Downscale WGSL module not found at ${candidate}`);
  }
  return candidate;
}

/** Import the real compiled `Downscale` WGSL source string. */
export async function loadDownscaleWgsl(label: string): Promise<string> {
  const modulePath = resolveDownscaleWgslPath(label);
  const imported = (await import(pathToFileURL(modulePath).href)) as { default?: unknown };
  if (typeof imported.default !== 'string' || !imported.default.includes('fn computeMain')) {
    throw new Error(`${label}: ${modulePath} did not export the Downscale WGSL source string`);
  }
  return imported.default;
}

/** Run one Downscale dispatch + rgba16float readback entirely inside the page. */
export async function runGpuCase(page: Page, request: GpuRequest): Promise<GpuResult> {
  return page.evaluate(async (req): Promise<GpuResult> => {
    const unavailable = (message: string): GpuFailure => ({
      ok: false,
      kind: 'unavailable',
      error: message,
    });
    const validation = (message: string): GpuFailure => ({
      ok: false,
      kind: 'validation',
      error: message,
    });

    if (typeof navigator === 'undefined' || !navigator.gpu) {
      return unavailable('navigator.gpu is not defined');
    }

    // Prefer the software fallback adapter, then fall back to any adapter.
    let adapter: GPUAdapter | null = null;
    try {
      adapter = await navigator.gpu.requestAdapter({ forceFallbackAdapter: true });
    } catch {
      // Fall through to the generic adapter request below.
    }
    if (!adapter) {
      try {
        adapter = await navigator.gpu.requestAdapter();
      } catch (error) {
        return unavailable(`requestAdapter() threw: ${String(error)}`);
      }
    }
    if (!adapter) {
      return unavailable('requestAdapter() returned null');
    }

    let device: GPUDevice;
    try {
      device = await adapter.requestDevice();
    } catch (error) {
      return unavailable(`requestDevice() threw: ${String(error)}`);
    }

    const adapterInfo = JSON.stringify({
      vendor: adapter.info.vendor,
      architecture: adapter.info.architecture,
      device: adapter.info.device,
    });
    const software =
      adapter.info.isFallbackAdapter || /swiftshader|llvmpipe|software/i.test(adapterInfo);

    // Minimal IEEE-754 binary16 -> float32 decoder. `Float16Array` is not
    // universally available in the headless Chromium build, so decode by hand.
    const halfToFloat = (h: number): number => {
      const sign = (h & 0x8000) !== 0 ? -1 : 1;
      const exponent = (h >> 10) & 0x1f;
      const mantissa = h & 0x3ff;
      if (exponent === 0) {
        return sign * Math.pow(2, -14) * (mantissa / 1024);
      }
      if (exponent === 0x1f) {
        return mantissa === 0 ? sign * Infinity : NaN;
      }
      return sign * Math.pow(2, exponent - 15) * (1 + mantissa / 1024);
    };

    const { srcWidth, srcHeight, outWidth, outHeight } = req;
    const bytesPerRow = Math.ceil((outWidth * 8) / 256) * 256; // rgba16float = 8 B/px

    device.pushErrorScope('validation');
    let scopeOpen = true;
    let failure: GpuFailure | null = null;
    let output: number[] = [];

    try {
      const module = device.createShaderModule({ code: req.wgsl, label: 'downscale-under-test' });
      const pipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module, entryPoint: 'computeMain' },
      });

      const inputTexture = device.createTexture({
        size: { width: srcWidth, height: srcHeight },
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      const outputTexture = device.createTexture({
        size: { width: outWidth, height: outHeight },
        format: 'rgba16float',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
      });
      const readback = device.createBuffer({
        size: bytesPerRow * outHeight,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });

      device.queue.writeTexture(
        { texture: inputTexture },
        new Uint8Array(req.pixels),
        { bytesPerRow: srcWidth * 4, rowsPerImage: srcHeight },
        { width: srcWidth, height: srcHeight },
      );

      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: inputTexture.createView() },
          { binding: 1, resource: outputTexture.createView() },
        ],
      });

      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(outWidth / 8), Math.ceil(outHeight / 8));
      pass.end();
      encoder.copyTextureToBuffer(
        { texture: outputTexture },
        { buffer: readback, bytesPerRow, rowsPerImage: outHeight },
        { width: outWidth, height: outHeight },
      );
      device.queue.submit([encoder.finish()]);

      const validationError = await device.popErrorScope();
      scopeOpen = false;
      if (validationError) {
        failure = validation(validationError.message);
      } else {
        await readback.mapAsync(GPUMapMode.READ);
        const view = new DataView(readback.getMappedRange());
        const decoded: number[] = [];
        for (let y = 0; y < outHeight; y++) {
          for (let x = 0; x < outWidth; x++) {
            const offset = y * bytesPerRow + x * 8;
            for (let channel = 0; channel < 4; channel++) {
              const value = halfToFloat(view.getUint16(offset + channel * 2, true));
              const clamped = Math.min(1, Math.max(0, value));
              decoded.push(Math.round(clamped * 255));
            }
          }
        }
        readback.unmap();
        output = decoded;
      }
    } catch (error) {
      failure = validation(String(error));
    } finally {
      if (scopeOpen) {
        try {
          await device.popErrorScope();
        } catch {
          // Ignore; the device/page may already be gone.
        }
      }
    }

    if (failure) return failure;
    return { ok: true, width: outWidth, height: outHeight, data: output, adapterInfo, software };
  }, request);
}

/**
 * Skip or throw when the preflight failed. Mirrors the discipline of the
 * existing GPU gates: `ALLOW_GPU_SKIP=1` skips in constrained environments,
 * otherwise the failure is loud.
 */
export function guardGpu(preflight: GpuResult | null, label: string): void {
  if (!preflight || preflight.ok) return;
  console.warn(
    `[gpu] environment cannot run ${label}: ${preflight.error}`
    + (ALLOW_GPU_SKIP ? ' (ALLOW_GPU_SKIP=1 -> skipping)' : ''),
  );
  test.skip(ALLOW_GPU_SKIP, `environment cannot run ${label}: ${preflight.error}`);
  throw new Error(`environment cannot run ${label} (${preflight.kind}): ${preflight.error}`);
}

export function writeArtifacts(
  rootSubdir: string,
  caseName: string,
  expected: Uint8Array,
  actual: Uint8Array,
  manifest: Record<string, unknown>,
): string {
  const dir = path.resolve(__dirname, '..', '..', 'test-results', rootSubdir, caseName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'expected.rgba'), Buffer.from(expected));
  writeFileSync(path.join(dir, 'actual.rgba'), Buffer.from(actual));
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

// ---------------------------------------------------------------------------
// End-to-end chain ablation: real `CNNx2M` -> `Downscale`, per-stage readback.
// ---------------------------------------------------------------------------

/** Minimal structural type for a library pipeline (only what the runner uses). */
interface Anime4kPipelineLike {
  getOutputTexture(): GPUTexture;
  getExecutionOrder?(): readonly Anime4kPipelineLike[];
  isCompute?: boolean;
  recordCompute?(pass: GPUComputePassEncoder): Promise<void>;
  pass?(encoder: GPUCommandEncoder): Promise<void>;
  /**
   * Two-stage effects (e.g. `ClampHighlights`) return the epilogue that must run
   * once after the chain tail; its output becomes the chain output.
   */
  getDeferredPipeline?(finalInputTexture: GPUTexture): Anime4kPipelineLike | null;
  /**
   * Optional per-effect parameter setter (e.g. `DoG.updateParam('strength', n)`).
   * Effects that expose no tunable params simply omit it.
   */
  updateParam?(param: string, value: number): void;
}

/**
 * Constructor shape for a real Anime4K effect. `nativeDimensions`/
 * `targetDimensions` are passed through exactly as the extension's pipeline
 * builder does; effect classes that ignore them still accept the wider object
 * because the fields are optional here.
 */
interface Anime4kEffectCtor {
  new (descriptor: {
    device: GPUDevice;
    inputTexture: GPUTexture;
    nativeDimensions?: { width: number; height: number };
    targetDimensions?: { width: number; height: number };
  }): Anime4kPipelineLike;
}

interface Anime4kLibModule {
  Downscale: new (descriptor: {
    device: GPUDevice;
    inputTexture: GPUTexture;
    targetDimensions: { width: number; height: number };
  }) => Anime4kPipelineLike;
  recordPipelineList: (
    encoder: GPUCommandEncoder,
    pipelines: readonly Anime4kPipelineLike[],
  ) => Promise<void>;
}

interface Anime4kEngineModule {
  loadAnime4kConstructor(key: string): Promise<Anime4kEffectCtor>;
}

export interface GpuChainStage {
  width: number;
  height: number;
  /** Row-major RGBA, decoded from f16 and clamped to [0, 1]. Length = width*height*4. */
  data: number[];
}

export interface GpuChainSuccess {
  ok: true;
  src: GpuChainStage;
  cnn: GpuChainStage;
  final: GpuChainStage;
  adapterInfo: string;
  software: boolean;
}

export interface GpuChainFailure {
  ok: false;
  kind: 'unavailable' | 'validation';
  error: string;
}

export type GpuChainResult = GpuChainSuccess | GpuChainFailure;

export interface GpuChainRequest {
  srcWidth: number;
  srcHeight: number;
  outWidth: number;
  outHeight: number;
  /** Gamma-encoded RGBA floats in [0, 1], row-major; length = srcWidth*srcHeight*4. */
  stimulus: number[];
}

/**
 * IEEE-754 binary16 encoder (round-to-nearest-even), returns the 16-bit
 * pattern. Hand-rolled so the harness does not depend on `Float16Array` or
 * `DataView.setFloat16` being present in the runner's Node build.
 */
export function floatToHalf(value: number): number {
  const scratch = new DataView(new ArrayBuffer(4));
  scratch.setFloat32(0, value, true);
  const bits = scratch.getUint32(0, true);
  const sign = (bits >>> 16) & 0x8000;
  const exponent = (bits >>> 23) & 0xff;
  const mantissa = bits & 0x7fffff;

  if (exponent === 0xff) {
    return sign | 0x7c00 | (mantissa === 0 ? 0 : 0x200);
  }
  const unbiased = exponent - 127 + 15;
  if (unbiased >= 0x1f) return sign | 0x7c00;
  if (unbiased <= 0) {
    if (unbiased < -10) return sign;
    const withImplicit = mantissa | 0x800000;
    const shift = 14 - unbiased;
    const half = withImplicit >>> shift;
    const remainder = withImplicit & ((1 << shift) - 1);
    const halfway = 1 << (shift - 1);
    if (remainder > halfway || (remainder === halfway && (half & 1) === 1)) {
      return sign | (half + 1);
    }
    return sign | half;
  }
  let half = (unbiased << 10) | (mantissa >>> 13);
  const remainder = mantissa & 0x1fff;
  if (remainder > 0x1000 || (remainder === 0x1000 && (half & 1) === 1)) {
    half += 1;
  }
  return sign | half;
}

const IDENTITY_BLIT_WGSL = `
@group(0) @binding(0) var tex_in: texture_2d<f32>;
@group(0) @binding(1) var tex_out: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn computeMain(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(tex_out);
  if (gid.x >= dims.x || gid.y >= dims.y) {
    return;
  }
  textureStore(tex_out, gid.xy, textureLoad(tex_in, vec2i(gid.xy), 0));
}
`;

interface PendingStage {
  key: 'src' | 'cnn' | 'final';
  width: number;
  height: number;
  bytesPerRow: number;
  buffer: GPUBuffer;
}

/**
 * Run the real `CNNx2M` then `Downscale` pipelines in-page and read back the
 * source, the CNN x2 intermediate and the final downscaled image.
 *
 * Neither library output exposes `COPY_SRC`, so each texture is blitted through
 * a trivial identity compute shader into a `STORAGE_BINDING | COPY_SRC` texture
 * before `copyTextureToBuffer` -> `mapAsync` -> f16 decode. The stimulus is
 * converted to f16 bit patterns on the Node side.
 */
export async function runGpuChainAblation(
  page: Page,
  request: GpuChainRequest,
): Promise<GpuChainResult> {
  const stimulusF16 = request.stimulus.map(floatToHalf);
  return page.evaluate(
    async (payload): Promise<GpuChainResult> => {
      const unavailable = (message: string): GpuChainFailure => ({
        ok: false,
        kind: 'unavailable',
        error: message,
      });
      const validation = (message: string): GpuChainFailure => ({
        ok: false,
        kind: 'validation',
        error: message,
      });

      if (typeof navigator === 'undefined' || !navigator.gpu) {
        return unavailable('navigator.gpu is not defined');
      }

      // Prefer the software fallback adapter, then fall back to any adapter.
      let adapter: GPUAdapter | null = null;
      try {
        adapter = await navigator.gpu.requestAdapter({ forceFallbackAdapter: true });
      } catch {
        // Fall through to the generic adapter request below.
      }
      if (!adapter) {
        try {
          adapter = await navigator.gpu.requestAdapter();
        } catch (error) {
          return unavailable(`requestAdapter() threw: ${String(error)}`);
        }
      }
      if (!adapter) return unavailable('requestAdapter() returned null');

      let device: GPUDevice;
      try {
        device = await adapter.requestDevice();
      } catch (error) {
        return unavailable(`requestDevice() threw: ${String(error)}`);
      }

      const adapterInfo = JSON.stringify({
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        device: adapter.info.device,
      });
      const software =
        adapter.info.isFallbackAdapter || /swiftshader|llvmpipe|software/i.test(adapterInfo);

      // Minimal IEEE-754 binary16 -> float32 decoder (mirrors `runGpuCase`).
      const halfToFloat = (h: number): number => {
        const sign = (h & 0x8000) !== 0 ? -1 : 1;
        const exponent = (h >> 10) & 0x1f;
        const mantissa = h & 0x3ff;
        if (exponent === 0) {
          return sign * Math.pow(2, -14) * (mantissa / 1024);
        }
        if (exponent === 0x1f) {
          return mantissa === 0 ? sign * Infinity : NaN;
        }
        return sign * Math.pow(2, exponent - 15) * (1 + mantissa / 1024);
      };

      let lib: Anime4kLibModule;
      let engine: Anime4kEngineModule;
      try {
        const libSpecifier = '/vendor/anime4k/index.js';
        const engineSpecifier = '/vendor/anime4k/engines/anime4k/index.js';
        lib = (await import(libSpecifier)) as unknown as Anime4kLibModule;
        engine = (await import(engineSpecifier)) as unknown as Anime4kEngineModule;
      } catch (error) {
        return unavailable(`library import failed: ${String(error)}`);
      }

      let CNNx2M: new (descriptor: {
        device: GPUDevice;
        inputTexture: GPUTexture;
      }) => Anime4kPipelineLike;
      try {
        CNNx2M = await engine.loadAnime4kConstructor('CNNx2M');
      } catch (error) {
        return unavailable(`CNNx2M constructor unavailable: ${String(error)}`);
      }

      const { Downscale } = lib;
      let recordPipelineList = lib.recordPipelineList;
      if (typeof recordPipelineList !== 'function') {
        try {
          const fallbackSpecifier = '/vendor/anime4k/pipelines/recordPipelineList.js';
          const fallback = (await import(fallbackSpecifier)) as unknown as {
            recordPipelineList: Anime4kLibModule['recordPipelineList'];
          };
          recordPipelineList = fallback.recordPipelineList;
        } catch (error) {
          return unavailable(`recordPipelineList unavailable: ${String(error)}`);
        }
      }
      if (typeof recordPipelineList !== 'function') {
        return unavailable('recordPipelineList is not a function');
      }

      const { srcWidth, srcHeight, outWidth, outHeight, stimulusF16: halfBits, blitWgsl } = payload;

      device.pushErrorScope('validation');
      let scopeOpen = true;
      let failure: GpuChainFailure | null = null;
      let captured: { src: GpuChainStage; cnn: GpuChainStage; final: GpuChainStage } | null = null;

      try {
        const srcTexture = device.createTexture({
          size: { width: srcWidth, height: srcHeight },
          format: 'rgba16float',
          usage:
            GPUTextureUsage.TEXTURE_BINDING
            | GPUTextureUsage.COPY_DST
            | GPUTextureUsage.RENDER_ATTACHMENT,
        });

        // Pack the f16 stimulus with a 256-byte-aligned row stride.
        const srcBytesPerRow = Math.ceil((srcWidth * 8) / 256) * 256;
        const stimulusBytes = new Uint8Array(srcBytesPerRow * srcHeight);
        const stimulusData = new DataView(stimulusBytes.buffer);
        for (let y = 0; y < srcHeight; y += 1) {
          for (let x = 0; x < srcWidth; x += 1) {
            const sourceIndex = (y * srcWidth + x) * 4;
            const destIndex = y * srcBytesPerRow + x * 8;
            for (let channel = 0; channel < 4; channel += 1) {
              stimulusData.setUint16(destIndex + channel * 2, halfBits[sourceIndex + channel] & 0xffff, true);
            }
          }
        }
        device.queue.writeTexture(
          { texture: srcTexture },
          stimulusBytes,
          { bytesPerRow: srcBytesPerRow, rowsPerImage: srcHeight },
          { width: srcWidth, height: srcHeight },
        );

        const cnn = new CNNx2M({ device, inputTexture: srcTexture });
        const cnnTexture = cnn.getOutputTexture();
        const downscale = new Downscale({
          device,
          inputTexture: cnnTexture,
          targetDimensions: { width: outWidth, height: outHeight },
        });
        const finalTexture = downscale.getOutputTexture();

        const blitModule = device.createShaderModule({
          code: blitWgsl,
          label: 'chain-ablation-identity-blit',
        });
        const blitPipeline = device.createComputePipeline({
          layout: 'auto',
          compute: { module: blitModule, entryPoint: 'computeMain' },
        });

        const encoder = device.createCommandEncoder();
        const pending: PendingStage[] = [];
        const blit = (key: PendingStage['key'], texture: GPUTexture): void => {
          const width = texture.width;
          const height = texture.height;
          const bytesPerRow = Math.ceil((width * 8) / 256) * 256;
          const destination = device.createTexture({
            size: { width, height },
            format: 'rgba16float',
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
          });
          const buffer = device.createBuffer({
            size: bytesPerRow * height,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          });
          const bindGroup = device.createBindGroup({
            layout: blitPipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: texture.createView() },
              { binding: 1, resource: destination.createView() },
            ],
          });
          const pass = encoder.beginComputePass();
          pass.setPipeline(blitPipeline);
          pass.setBindGroup(0, bindGroup);
          pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
          pass.end();
          encoder.copyTextureToBuffer(
            { texture: destination },
            { buffer, bytesPerRow, rowsPerImage: height },
            { width, height },
          );
          pending.push({ key, width, height, bytesPerRow, buffer });
        };

        blit('src', srcTexture);
        await recordPipelineList(encoder, [cnn, downscale]);
        blit('cnn', cnnTexture);
        blit('final', finalTexture);
        device.queue.submit([encoder.finish()]);

        const validationError = await device.popErrorScope();
        scopeOpen = false;
        if (validationError) {
          failure = validation(validationError.message);
        } else {
          await device.queue.onSubmittedWorkDone();
          const decoded = new Map<PendingStage['key'], GpuChainStage>();
          await Promise.all(
            pending.map(async (entry) => {
              await entry.buffer.mapAsync(GPUMapMode.READ);
              const view = new DataView(entry.buffer.getMappedRange());
              const data: number[] = [];
              for (let y = 0; y < entry.height; y += 1) {
                for (let x = 0; x < entry.width; x += 1) {
                  const offset = y * entry.bytesPerRow + x * 8;
                  for (let channel = 0; channel < 4; channel += 1) {
                    const value = halfToFloat(view.getUint16(offset + channel * 2, true));
                    data.push(Math.min(1, Math.max(0, value)));
                  }
                }
              }
              entry.buffer.unmap();
              decoded.set(entry.key, { width: entry.width, height: entry.height, data });
            }),
          );
          const src = decoded.get('src');
          const cnnStage = decoded.get('cnn');
          const finalStage = decoded.get('final');
          if (!src || !cnnStage || !finalStage) {
            failure = validation('readback did not produce all three stages');
          } else {
            captured = { src, cnn: cnnStage, final: finalStage };
          }
        }
      } catch (error) {
        failure = validation(String(error));
      } finally {
        if (scopeOpen) {
          try {
            await device.popErrorScope();
          } catch {
            // Ignore; the device/page may already be gone.
          }
        }
      }

      if (failure) return failure;
      if (!captured) return validation('no stages captured');
      return {
        ok: true,
        src: captured.src,
        cnn: captured.cnn,
        final: captured.final,
        adapterInfo,
        software,
      };
    },
    {
      srcWidth: request.srcWidth,
      srcHeight: request.srcHeight,
      outWidth: request.outWidth,
      outHeight: request.outHeight,
      stimulusF16,
      blitWgsl: IDENTITY_BLIT_WGSL,
    },
  );
}

// ---------------------------------------------------------------------------
// Generalized real-chain ablation: an arbitrary ordered list of REAL library
// effect stages (each `same` or `scale: N`) plus the library `Downscale`.
//
// This is the test-only extension of `runGpuChainAblation`: instead of the
// hard-coded `CNNx2M -> Downscale` pair it threads `getOutputTexture()` into
// the next stage's `inputTexture`, records every stage sequentially (awaiting
// `recordPipelineList` per stage, so `pass()`'s async pipeline creation is
// honoured), and reads back EVERY stage (source + each effect output + the
// optional deferred `ClampHighlightsApply`). No production `src/**` is touched.
//
// Confirmed real A+A / Ultra chain for 1080p -> 2K (from the extension's
// `effect-chain-templates.ts` and `effect-chain-compiler.ts` /
// `effect-chain.ts` planner):
//
//   template  = [ClampHighlights, CNNUL, CNNx2UL, CNNUL, CNNx2UL, CNNUL, CNNx2VL]
//   factors   = [1,               1,     2,       1,     2,       1,     2      ]
//
// `target.width (2560) > source.width (1920)`, so the planner's *upscale-target*
// branch fires at index 2 (the first x2): `suffix[3] = 4`, ideal intermediate
// `2560/4 = 640 < 1920`, and `curWidth 3840 > 640*1.1`. It retains that x2,
// suppresses every later upscaler, and emits one target-exact `Downscale`
// immediately after it; trailing scale-1 CNNULs then run at the target:
//
//   source 1920x1080
//     -> CNNUL   (same)    1920x1080
//     -> CNNx2UL (x2)      3840x2160
//     -> Downscale         2560x1440   (ratio 1.5 both axes)
//     -> CNNUL   (same)    2560x1440
//     -> CNNUL   (same)    2560x1440
//     -> ClampHighlightsApply (deferred epilogue, same dims)
//
// At 1/10 scale the same rule yields 192x108 -> CNNUL -> CNNx2UL -> Downscale
// -> CNNUL -> CNNUL (this is what `chain-ablation-real.spec.ts` runs).
// ---------------------------------------------------------------------------

/** Dimension behaviour of a real effect stage. */
export type RealChainBehavior =
  | { kind: 'same' }
  | {
      kind: 'scale';
      /** Integer output/input ratio (e.g. 2 for `CNNx2UL`). */
      scale: number;
    };

/** One stage following the source, in execution order. */
export type RealChainStageSpec =
  | {
      kind: 'effect';
      /** Stable label for reporting, e.g. `CNNUL#1`. */
      label: string;
      /** Catalog key resolved through `loadAnime4kConstructor`. */
      key: string;
      behavior: RealChainBehavior;
      /**
       * Optional tunable params applied after construction via
       * `effect.updateParam(name, value)`. Effects that expose no setter ignore
       * them (guarded by a `typeof updateParam === 'function'` check). Omitted
       * by every pre-existing caller, so behavior is unchanged.
       */
      params?: Record<string, number>;
      /**
       * Optional production `gate`-policy wrapper for this restore stage. When
       * present (PNG-dump path only) a compute pass runs after the effect,
       * reading the stage INPUT and the effect OUTPUT and writing
       * `mix(input, restoreOut, smoothstep(low, high, max9-min9) * strength)`
       * into a new rgba16float texture that becomes the stage output. The WGSL
       * text is supplied by the caller (the shipped
       * `src/shaders/restore-gate.wgsl`), mirroring the CAS post-pass pattern.
       * Only meaningful for same-geometry effects (e.g. restores); omitted by
       * every pre-existing caller, so behavior is unchanged.
       */
      gate?: { wgsl: string; low: number; high: number; strength: number };
    }
  | {
      kind: 'downscale';
      label: string;
      /** Exact dimensions handed to the library `Downscale`. */
      width: number;
      height: number;
    };

export interface GpuRealChainRequest {
  srcWidth: number;
  srcHeight: number;
  /** Gamma-encoded RGBA floats in [0, 1], row-major; length = srcWidth*srcHeight*4. */
  stimulus: number[];
  /** Ordered real stages after the source; every stage output is read back. */
  stages: RealChainStageSpec[];
  /**
   * When true, reproduce the two-stage `ClampHighlights` epilogue: the 5x5
   * luma-max stats capture at the head (a pass-through that leaves the tail on
   * its input texture) and the clamp apply appended after the last stage. The
   * apply output is included in {@link GpuRealChainSuccess.stages}.
   */
  clampHighlights?: boolean;
  /**
   * Optional test-only post-pass applied to the chain's final texture. `cas`
   * runs the extension's SHIPPED `src/shaders/cas.wgsl` (rgba8unorm output,
   * vec2<f32> uniform `[sharpness, unused]`) and reads the result back as an
   * extra `CAS(sharp=...)` stage. The WGSL text is supplied by the caller so
   * the harness stays free of `src/**` imports.
   */
  postSharpen?: {
    kind: 'cas';
    /** 0..1, matching the shipped effect's parameter. */
    sharpness: number;
    /** Contents of `src/shaders/cas.wgsl`. */
    wgsl: string;
  };
  /**
   * Memory-saving test-only mode: read back only the source and the final
   * texture instead of every intermediate stage. The returned `stages` array is
   * then `[source, final]` (or `[source]` when the chain has no stages). Use on
   * large real-content inputs where the full per-stage readback would exhaust
   * the Node worker heap. Default `false` preserves the existing behavior.
   */
  readbackOnlyFinal?: boolean;
}

export interface GpuRealChainStage extends GpuChainStage {
  /** Reporting label (`source`, the stage label, or `ClampHighlightsApply`). */
  label: string;
  /** Catalog key, or `source` / `ClampHighlightsApply` for synthetic stages. */
  key: string;
}

export interface GpuRealChainSuccess {
  ok: true;
  /** Readback in execution order; index 0 is always the source. */
  stages: GpuRealChainStage[];
  adapterInfo: string;
  software: boolean;
}

export interface GpuRealChainFailure {
  ok: false;
  kind: 'unavailable' | 'validation';
  error: string;
}

export type GpuRealChainResult = GpuRealChainSuccess | GpuRealChainFailure;

/**
 * Run an arbitrary ordered list of REAL library effect pipelines (plus
 * `Downscale`) and read back the source, every stage output and the final
 * output.
 *
 * Each stage is compiled through `loadAnime4kConstructor(key)` and recorded as
 * its own `recordPipelineList` call so async pipeline creation and any shared
 * compute-pass batching are handled by the library, exactly as the extension
 * does. Between stages the previous `getOutputTexture()` is fed in as the next
 * `inputTexture`. Every real output lacks `COPY_SRC`, so each is identity-blitted
 * into a `STORAGE_BINDING | COPY_SRC` rgba16float texture before
 * `copyTextureToBuffer` -> `mapAsync` -> f16 decode (mirrors
 * {@link runGpuChainAblation}). The stimulus is converted to f16 on the Node
 * side.
 */
export async function runGpuRealChainAblation(
  page: Page,
  request: GpuRealChainRequest,
): Promise<GpuRealChainResult> {
  const stimulusF16 = request.stimulus.map(floatToHalf);
  return page.evaluate(
    async (payload): Promise<GpuRealChainResult> => {
      const unavailable = (message: string): GpuRealChainFailure => ({
        ok: false,
        kind: 'unavailable',
        error: message,
      });
      const validation = (message: string): GpuRealChainFailure => ({
        ok: false,
        kind: 'validation',
        error: message,
      });

      if (typeof navigator === 'undefined' || !navigator.gpu) {
        return unavailable('navigator.gpu is not defined');
      }

      // Prefer the software fallback adapter, then fall back to any adapter.
      let adapter: GPUAdapter | null = null;
      try {
        adapter = await navigator.gpu.requestAdapter({ forceFallbackAdapter: true });
      } catch {
        // Fall through to the generic adapter request below.
      }
      if (!adapter) {
        try {
          adapter = await navigator.gpu.requestAdapter();
        } catch (error) {
          return unavailable(`requestAdapter() threw: ${String(error)}`);
        }
      }
      if (!adapter) return unavailable('requestAdapter() returned null');

      let device: GPUDevice;
      try {
        device = await adapter.requestDevice();
      } catch (error) {
        return unavailable(`requestDevice() threw: ${String(error)}`);
      }

      const adapterInfo = JSON.stringify({
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        device: adapter.info.device,
      });
      const software =
        adapter.info.isFallbackAdapter || /swiftshader|llvmpipe|software/i.test(adapterInfo);

      // Minimal IEEE-754 binary16 -> float32 decoder (mirrors `runGpuCase`).
      const halfToFloat = (h: number): number => {
        const sign = (h & 0x8000) !== 0 ? -1 : 1;
        const exponent = (h >> 10) & 0x1f;
        const mantissa = h & 0x3ff;
        if (exponent === 0) {
          return sign * Math.pow(2, -14) * (mantissa / 1024);
        }
        if (exponent === 0x1f) {
          return mantissa === 0 ? sign * Infinity : NaN;
        }
        return sign * Math.pow(2, exponent - 15) * (1 + mantissa / 1024);
      };

      let lib: Anime4kLibModule;
      let engine: Anime4kEngineModule;
      try {
        const libSpecifier = '/vendor/anime4k/index.js';
        const engineSpecifier = '/vendor/anime4k/engines/anime4k/index.js';
        lib = (await import(libSpecifier)) as unknown as Anime4kLibModule;
        engine = (await import(engineSpecifier)) as unknown as Anime4kEngineModule;
      } catch (error) {
        return unavailable(`library import failed: ${String(error)}`);
      }

      const { Downscale } = lib;
      let recordPipelineList = lib.recordPipelineList;
      if (typeof recordPipelineList !== 'function') {
        try {
          const fallbackSpecifier = '/vendor/anime4k/pipelines/recordPipelineList.js';
          const fallback = (await import(fallbackSpecifier)) as unknown as {
            recordPipelineList: Anime4kLibModule['recordPipelineList'];
          };
          recordPipelineList = fallback.recordPipelineList;
        } catch (error) {
          return unavailable(`recordPipelineList unavailable: ${String(error)}`);
        }
      }
      if (typeof recordPipelineList !== 'function') {
        return unavailable('recordPipelineList is not a function');
      }

      // Resolve every distinct effect constructor up front (one dynamic import
      // per key, memoized by the library loader).
      const effectKeys = Array.from(
        new Set(
          payload.stages
            .filter(
              (stage): stage is Extract<RealChainStageSpec, { kind: 'effect' }> =>
                stage.kind === 'effect',
            )
            .map((stage) => stage.key),
        ),
      );
      if (payload.clampHighlights) effectKeys.push('ClampHighlights');
      const ctors = new Map<string, Anime4kEffectCtor>();
      try {
        for (const key of effectKeys) {
          ctors.set(key, await engine.loadAnime4kConstructor(key));
        }
      } catch (error) {
        return unavailable(`effect constructor unavailable: ${String(error)}`);
      }

      const { srcWidth, srcHeight, stimulusF16: halfBits, blitWgsl } = payload;

      device.pushErrorScope('validation');
      let scopeOpen = true;
      let failure: GpuRealChainFailure | null = null;
      let captured: GpuRealChainStage[] | null = null;

      try {
        const srcTexture = device.createTexture({
          size: { width: srcWidth, height: srcHeight },
          format: 'rgba16float',
          usage:
            GPUTextureUsage.TEXTURE_BINDING
            | GPUTextureUsage.COPY_DST
            | GPUTextureUsage.RENDER_ATTACHMENT,
        });

        // Pack the f16 stimulus with a 256-byte-aligned row stride.
        const srcBytesPerRow = Math.ceil((srcWidth * 8) / 256) * 256;
        const stimulusBytes = new Uint8Array(srcBytesPerRow * srcHeight);
        const stimulusData = new DataView(stimulusBytes.buffer);
        for (let y = 0; y < srcHeight; y += 1) {
          for (let x = 0; x < srcWidth; x += 1) {
            const sourceIndex = (y * srcWidth + x) * 4;
            const destIndex = y * srcBytesPerRow + x * 8;
            for (let channel = 0; channel < 4; channel += 1) {
              stimulusData.setUint16(
                destIndex + channel * 2,
                halfBits[sourceIndex + channel] & 0xffff,
                true,
              );
            }
          }
        }
        device.queue.writeTexture(
          { texture: srcTexture },
          stimulusBytes,
          { bytesPerRow: srcBytesPerRow, rowsPerImage: srcHeight },
          { width: srcWidth, height: srcHeight },
        );

        const blitModule = device.createShaderModule({
          code: blitWgsl,
          label: 'real-chain-ablation-identity-blit',
        });
        const blitPipeline = device.createComputePipeline({
          layout: 'auto',
          compute: { module: blitModule, entryPoint: 'computeMain' },
        });

        interface RealPendingStage {
          label: string;
          key: string;
          width: number;
          height: number;
          bytesPerRow: number;
          buffer: GPUBuffer;
        }

        const encoder = device.createCommandEncoder();
        const pending: RealPendingStage[] = [];
        const blit = (label: string, key: string, texture: GPUTexture): void => {
          const width = texture.width;
          const height = texture.height;
          const bytesPerRow = Math.ceil((width * 8) / 256) * 256;
          const destination = device.createTexture({
            size: { width, height },
            format: 'rgba16float',
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
          });
          const buffer = device.createBuffer({
            size: bytesPerRow * height,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          });
          const bindGroup = device.createBindGroup({
            layout: blitPipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: texture.createView() },
              { binding: 1, resource: destination.createView() },
            ],
          });
          const pass = encoder.beginComputePass();
          pass.setPipeline(blitPipeline);
          pass.setBindGroup(0, bindGroup);
          pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
          pass.end();
          encoder.copyTextureToBuffer(
            { texture: destination },
            { buffer, bytesPerRow, rowsPerImage: height },
            { width, height },
          );
          pending.push({ label, key, width, height, bytesPerRow, buffer });
        };

        const readbackAll = !payload.readbackOnlyFinal;
        blit('source', 'source', srcTexture);

        // Optional two-stage ClampHighlights stats capture at the chain head.
        // Its output texture IS its input texture (pass-through), so it does not
        // change the tail; only the deferred apply at the end writes a new frame.
        let clamp: Anime4kPipelineLike | null = null;
        if (payload.clampHighlights) {
          const ClampHighlights = ctors.get('ClampHighlights');
          if (!ClampHighlights) throw new Error('ClampHighlights constructor missing');
          clamp = new ClampHighlights({ device, inputTexture: srcTexture });
          await recordPipelineList(encoder, [clamp]);
        }

        let currentTexture = srcTexture;
        let curWidth = srcWidth;
        let curHeight = srcHeight;

        for (const spec of payload.stages) {
          if (spec.kind === 'downscale') {
            const downscale = new Downscale({
              device,
              inputTexture: currentTexture,
              targetDimensions: { width: spec.width, height: spec.height },
            });
            await recordPipelineList(encoder, [downscale]);
            currentTexture = downscale.getOutputTexture();
            curWidth = spec.width;
            curHeight = spec.height;
          } else {
            const Ctor = ctors.get(spec.key);
            if (!Ctor) throw new Error(`no constructor for effect key "${spec.key}"`);
            const scale = spec.behavior.kind === 'scale' ? spec.behavior.scale : 1;
            const outWidth = Math.round(curWidth * scale);
            const outHeight = Math.round(curHeight * scale);
            const effect = new Ctor({
              device,
              inputTexture: currentTexture,
              nativeDimensions: { width: curWidth, height: curHeight },
              targetDimensions: { width: outWidth, height: outHeight },
            });
            // Apply optional tunables (e.g. DoG strength) before recording.
            // Restores expose no setter; they are simply skipped.
            if (spec.params) {
              for (const [name, value] of Object.entries(spec.params)) {
                if (typeof effect.updateParam === 'function') {
                  effect.updateParam(name, value);
                }
              }
            }
            await recordPipelineList(encoder, [effect]);
            currentTexture = effect.getOutputTexture();
            curWidth = outWidth;
            curHeight = outHeight;
          }
          if (readbackAll) {
            blit(spec.label, spec.kind === 'downscale' ? 'Downscale' : spec.key, currentTexture);
          }
        }

        // Deferred ClampHighlights epilogue after the chain tail.
        if (clamp && typeof clamp.getDeferredPipeline === 'function') {
          const apply = clamp.getDeferredPipeline(currentTexture);
          if (apply) {
            await recordPipelineList(encoder, [apply]);
            currentTexture = apply.getOutputTexture();
            if (readbackAll) {
              blit('ClampHighlightsApply', 'ClampHighlightsApply', currentTexture);
            }
          }
        }

        // Optional test-only post-pass: the SHIPPED CAS shader applied to the
        // chain tail. Its output is rgba8unorm (as in the extension), so it is
        // identity-blitted into an rgba16float readback texture for decoding.
        if (payload.postSharpen && payload.postSharpen.kind === 'cas') {
          const casModule = device.createShaderModule({
            code: payload.postSharpen.wgsl,
            label: 'shipped-cas-post',
          });
          const casPipeline = device.createComputePipeline({
            layout: 'auto',
            compute: { module: casModule, entryPoint: 'main' },
          });
          const casOutput = device.createTexture({
            size: { width: curWidth, height: curHeight },
            format: 'rgba8unorm',
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
          });
          const casParams = device.createBuffer({
            size: 8,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          });
          device.queue.writeBuffer(
            casParams,
            0,
            new Float32Array([payload.postSharpen.sharpness, 0]),
          );
          const casBindGroup = device.createBindGroup({
            layout: casPipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: currentTexture.createView() },
              { binding: 1, resource: casOutput.createView() },
              { binding: 2, resource: { buffer: casParams } },
            ],
          });
          const casPass = encoder.beginComputePass();
          casPass.setPipeline(casPipeline);
          casPass.setBindGroup(0, casBindGroup);
          casPass.dispatchWorkgroups(Math.ceil(curWidth / 8), Math.ceil(curHeight / 8));
          casPass.end();
          if (readbackAll) {
            blit(
              `CAS(sharp=${payload.postSharpen.sharpness.toFixed(2)})`,
              'CAS',
              casOutput,
            );
          } else {
            blit('final', 'final', casOutput);
          }
        } else if (!readbackAll && payload.stages.length > 0) {
          blit('final', 'final', currentTexture);
        }

        device.queue.submit([encoder.finish()]);

        const validationError = await device.popErrorScope();
        scopeOpen = false;
        if (validationError) {
          failure = validation(validationError.message);
        } else {
          await device.queue.onSubmittedWorkDone();
          const decoded: GpuRealChainStage[] = new Array<GpuRealChainStage>(pending.length);
          await Promise.all(
            pending.map(async (entry, index) => {
              await entry.buffer.mapAsync(GPUMapMode.READ);
              const view = new DataView(entry.buffer.getMappedRange());
              const data: number[] = [];
              for (let y = 0; y < entry.height; y += 1) {
                for (let x = 0; x < entry.width; x += 1) {
                  const offset = y * entry.bytesPerRow + x * 8;
                  for (let channel = 0; channel < 4; channel += 1) {
                    const value = halfToFloat(view.getUint16(offset + channel * 2, true));
                    data.push(Math.min(1, Math.max(0, value)));
                  }
                }
              }
              entry.buffer.unmap();
              decoded[index] = {
                label: entry.label,
                key: entry.key,
                width: entry.width,
                height: entry.height,
                data,
              };
            }),
          );
          if (decoded.some((stage) => !stage)) {
            failure = validation('readback did not produce every stage');
          } else {
            captured = decoded;
          }
        }
      } catch (error) {
        failure = validation(String(error));
      } finally {
        if (scopeOpen) {
          try {
            await device.popErrorScope();
          } catch {
            // Ignore; the device/page may already be gone.
          }
        }
      }

      if (failure) return failure;
      if (!captured) return validation('no stages captured');
      return {
        ok: true,
        stages: captured,
        adapterInfo,
        software,
      };
    },
    {
      srcWidth: request.srcWidth,
      srcHeight: request.srcHeight,
      stimulusF16,
      stages: request.stages,
      clampHighlights: request.clampHighlights ?? false,
      postSharpen: request.postSharpen ?? null,
      readbackOnlyFinal: request.readbackOnlyFinal ?? false,
      blitWgsl: IDENTITY_BLIT_WGSL,
    },
  );
}

// ---------------------------------------------------------------------------
// PNG pass dump: decode a source PNG in-page, run the real chain, encode every
// stage back to PNG and stream it to a Node-side sink.
//
// Unlike {@link runGpuRealChainAblation} (which materializes every stage as a
// float array and therefore cannot survive a full-resolution frame), all pixel
// data here stays in the browser: the source PNG is decoded with
// `createImageBitmap`, each stage is read back, converted to an `ImageData` and
// PNG-encoded with `OffscreenCanvas.convertToBlob`, then handed to the sink one
// stage at a time. Only base64 strings cross the Playwright bridge, and only
// one at a time, so memory stays bounded by a single stage.
// ---------------------------------------------------------------------------

export interface GpuPngDumpRequest {
  /** Base64 (no `data:` prefix) of the source PNG. */
  srcPngBase64: string;
  /**
   * Ordered real stages after the source. The `ClampHighlights` head is *not*
   * listed here; set {@link clampHighlights} to reproduce it (and its deferred
   * tail apply).
   */
  stages: RealChainStageSpec[];
  /**
   * When true, reproduce the two-stage `ClampHighlights` epilogue: a
   * pass-through head capture, then the clamp apply appended after the last
   * stage (its output is dumped as `ClampHighlightsApply`).
   */
  clampHighlights?: boolean;
  /**
   * Optional test-only post-pass applied to the chain's final texture. `cas`
   * runs the extension's SHIPPED `src/shaders/cas.wgsl` (rgba8unorm output,
   * vec2<f32> uniform `[sharpness, unused]`) and dumps the result as an extra
   * `CAS(sharp=...)` stage. The WGSL text is supplied by the caller so the
   * harness stays free of `src/**` imports. Mirrors
   * {@link GpuRealChainRequest.postSharpen}.
   */
  postSharpen?: {
    kind: 'cas';
    /** 0..1, matching the shipped effect's parameter. */
    sharpness: number;
    /** Contents of `src/shaders/cas.wgsl`. */
    wgsl: string;
  };
}

export interface GpuPngDumpStageMeta {
  /** Reporting label (`stage.label`, `Downscale`, or `ClampHighlightsApply`). */
  label: string;
  /** Catalog key, or `Downscale` / `ClampHighlightsApply` for synthetic stages. */
  key: string;
  width: number;
  height: number;
}

/** Sink invoked once per dumped stage, in execution order. */
export type GpuPngDumpSink = (
  meta: GpuPngDumpStageMeta,
  pngBase64: string,
) => void | Promise<void>;

export interface GpuPngDumpSuccess {
  ok: true;
  /** One entry per streamed stage, in execution order. */
  stages: GpuPngDumpStageMeta[];
  adapterInfo: string;
  software: boolean;
}

export interface GpuPngDumpFailure {
  ok: false;
  kind: 'unavailable' | 'validation';
  error: string;
}

export type GpuPngDumpResult = GpuPngDumpSuccess | GpuPngDumpFailure;

/** Monotonic suffix so repeated dumps in one page never collide on the binding name. */
let pngDumpBindingCounter = 0;

/**
 * Decode `request.srcPngBase64` in the page, run the real effect chain, and
 * stream every stage's pixels to `sink` as a PNG. See the module section doc.
 */
export async function runGpuRealChainPngDump(
  page: Page,
  request: GpuPngDumpRequest,
  sink: GpuPngDumpSink,
): Promise<GpuPngDumpResult> {
  const binding = `__a4kPngDump${(pngDumpBindingCounter += 1)}`;
  // The binding name is delivered to the page in the payload; the callback
  // itself cannot be serialized, so `page.exposeFunction` is the only channel.
  await page.exposeFunction(binding, sink);
  return page.evaluate(
    async (payload): Promise<GpuPngDumpResult> => {
      const unavailable = (message: string): GpuPngDumpFailure => ({
        ok: false,
        kind: 'unavailable',
        error: message,
      });
      const validation = (message: string): GpuPngDumpFailure => ({
        ok: false,
        kind: 'validation',
        error: message,
      });

      if (typeof navigator === 'undefined' || !navigator.gpu) {
        return unavailable('navigator.gpu is not defined');
      }

      // Prefer the software fallback adapter, then fall back to any adapter.
      let adapter: GPUAdapter | null = null;
      try {
        adapter = await navigator.gpu.requestAdapter({ forceFallbackAdapter: true });
      } catch {
        // Fall through to the generic adapter request below.
      }
      if (!adapter) {
        try {
          adapter = await navigator.gpu.requestAdapter();
        } catch (error) {
          return unavailable(`requestAdapter() threw: ${String(error)}`);
        }
      }
      if (!adapter) return unavailable('requestAdapter() returned null');

      let device: GPUDevice;
      try {
        device = await adapter.requestDevice();
      } catch (error) {
        return unavailable(`requestDevice() threw: ${String(error)}`);
      }

      const adapterInfo = JSON.stringify({
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        device: adapter.info.device,
      });
      const software =
        adapter.info.isFallbackAdapter || /swiftshader|llvmpipe|software/i.test(adapterInfo);

      const halfToFloat = (h: number): number => {
        const sign = (h & 0x8000) !== 0 ? -1 : 1;
        const exponent = (h >> 10) & 0x1f;
        const mantissa = h & 0x3ff;
        if (exponent === 0) return sign * Math.pow(2, -14) * (mantissa / 1024);
        if (exponent === 0x1f) return mantissa === 0 ? sign * Infinity : NaN;
        return sign * Math.pow(2, exponent - 15) * (1 + mantissa / 1024);
      };

      // In-page float32 -> binary16 encoder (mirror of the Node helper; the
      // evaluate callback cannot close over module scope).
      const floatToHalf = (value: number): number => {
        const scratch = new DataView(new ArrayBuffer(4));
        scratch.setFloat32(0, value, true);
        const bits = scratch.getUint32(0, true);
        const sign = (bits >>> 16) & 0x8000;
        const exponent = (bits >>> 23) & 0xff;
        const mantissa = bits & 0x7fffff;
        if (exponent === 0xff) return sign | 0x7c00 | (mantissa === 0 ? 0 : 0x200);
        const unbiased = exponent - 127 + 15;
        if (unbiased >= 0x1f) return sign | 0x7c00;
        if (unbiased <= 0) {
          if (unbiased < -10) return sign;
          const withImplicit = mantissa | 0x800000;
          const shift = 14 - unbiased;
          const half = withImplicit >>> shift;
          const remainder = withImplicit & ((1 << shift) - 1);
          const halfway = 1 << (shift - 1);
          if (remainder > halfway || (remainder === halfway && (half & 1) === 1)) {
            return sign | (half + 1);
          }
          return sign | half;
        }
        let half = (unbiased << 10) | (mantissa >>> 13);
        const remainder = mantissa & 0x1fff;
        if (remainder > 0x1000 || (remainder === 0x1000 && (half & 1) === 1)) half += 1;
        return sign | half;
      };

      const bytesToBase64 = (bytes: Uint8Array): string => {
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + chunk)));
        }
        return btoa(binary);
      };

      // --- Decode the source PNG entirely in the page ---
      let srcWidth: number;
      let srcHeight: number;
      let srcRgba: Uint8ClampedArray;
      try {
        if (typeof createImageBitmap !== 'function') {
          return unavailable('createImageBitmap is not available');
        }
        const binary = atob(payload.srcPngBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        srcWidth = bitmap.width;
        srcHeight = bitmap.height;
        const canvas = new OffscreenCanvas(srcWidth, srcHeight);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return unavailable('OffscreenCanvas 2d context unavailable');
        ctx.drawImage(bitmap, 0, 0);
        srcRgba = ctx.getImageData(0, 0, srcWidth, srcHeight).data;
      } catch (error) {
        return unavailable(`PNG decode failed: ${String(error)}`);
      }

      let lib: Anime4kLibModule;
      let engine: Anime4kEngineModule;
      try {
        // Dynamic specifiers (not literals): the `/vendor/...` modules only
        // exist at runtime under the test secure origin, so TS must not try to
        // resolve them statically.
        const libSpecifier = '/vendor/anime4k/index.js';
        const engineSpecifier = '/vendor/anime4k/engines/anime4k/index.js';
        lib = (await import(libSpecifier)) as unknown as Anime4kLibModule;
        engine = (await import(engineSpecifier)) as unknown as Anime4kEngineModule;
      } catch (error) {
        return unavailable(`library import failed: ${String(error)}`);
      }

      const { Downscale } = lib;
      let recordPipelineList = lib.recordPipelineList;
      if (typeof recordPipelineList !== 'function') {
        try {
          const fallbackSpecifier = '/vendor/anime4k/pipelines/recordPipelineList.js';
          const fallback = (await import(fallbackSpecifier)) as {
            recordPipelineList: Anime4kLibModule['recordPipelineList'];
          };
          recordPipelineList = fallback.recordPipelineList;
        } catch (error) {
          return unavailable(`recordPipelineList unavailable: ${String(error)}`);
        }
      }
      if (typeof recordPipelineList !== 'function') {
        return unavailable('recordPipelineList is not a function');
      }

      const effectKeys = Array.from(
        new Set(
          payload.stages
            .filter(
              (stage): stage is Extract<RealChainStageSpec, { kind: 'effect' }> =>
                stage.kind === 'effect',
            )
            .map((stage) => stage.key),
        ),
      );
      if (payload.clampHighlights) effectKeys.push('ClampHighlights');
      const ctors = new Map<string, Anime4kEffectCtor>();
      try {
        for (const key of effectKeys) {
          ctors.set(key, await engine.loadAnime4kConstructor(key));
        }
      } catch (error) {
        return unavailable(`effect constructor unavailable: ${String(error)}`);
      }

      device.pushErrorScope('validation');
      let scopeOpen = true;
      let failure: GpuPngDumpFailure | null = null;
      const dumped: GpuPngDumpStageMeta[] = [];

      try {
        const srcTexture = device.createTexture({
          size: { width: srcWidth, height: srcHeight },
          format: 'rgba16float',
          usage:
            GPUTextureUsage.TEXTURE_BINDING
            | GPUTextureUsage.COPY_DST
            | GPUTextureUsage.RENDER_ATTACHMENT,
        });

        const srcBytesPerRow = Math.ceil((srcWidth * 8) / 256) * 256;
        const srcBytes = new Uint8Array(srcBytesPerRow * srcHeight);
        const srcView = new DataView(srcBytes.buffer);
        for (let y = 0; y < srcHeight; y += 1) {
          for (let x = 0; x < srcWidth; x += 1) {
            const sourceIndex = (y * srcWidth + x) * 4;
            const destIndex = y * srcBytesPerRow + x * 8;
            for (let channel = 0; channel < 4; channel += 1) {
              srcView.setUint16(
                destIndex + channel * 2,
                floatToHalf(srcRgba[sourceIndex + channel] / 255) & 0xffff,
                true,
              );
            }
          }
        }
        device.queue.writeTexture(
          { texture: srcTexture },
          srcBytes,
          { bytesPerRow: srcBytesPerRow, rowsPerImage: srcHeight },
          { width: srcWidth, height: srcHeight },
        );

        const blitModule = device.createShaderModule({
          code: payload.blitWgsl,
          label: 'png-dump-identity-blit',
        });
        const blitPipeline = device.createComputePipeline({
          layout: 'auto',
          compute: { module: blitModule, entryPoint: 'computeMain' },
        });

        interface PendingDump {
          label: string;
          key: string;
          width: number;
          height: number;
          bytesPerRow: number;
          buffer: GPUBuffer;
          texture: GPUTexture;
        }

        const encoder = device.createCommandEncoder();
        const pending: PendingDump[] = [];
        const blit = (label: string, key: string, texture: GPUTexture): void => {
          const width = texture.width;
          const height = texture.height;
          const bytesPerRow = Math.ceil((width * 8) / 256) * 256;
          const destination = device.createTexture({
            size: { width, height },
            format: 'rgba16float',
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
          });
          const buffer = device.createBuffer({
            size: bytesPerRow * height,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          });
          const bindGroup = device.createBindGroup({
            layout: blitPipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: texture.createView() },
              { binding: 1, resource: destination.createView() },
            ],
          });
          const pass = encoder.beginComputePass();
          pass.setPipeline(blitPipeline);
          pass.setBindGroup(0, bindGroup);
          pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
          pass.end();
          encoder.copyTextureToBuffer(
            { texture: destination },
            { buffer, bytesPerRow, rowsPerImage: height },
            { width, height },
          );
          pending.push({ label, key, width, height, bytesPerRow, buffer, texture: destination });
        };

        // Lazily built production `restore-gate` pipelines, memoized by WGSL so
        // every gated stage in a chain shares one pipeline.
        const gatePipelines = new Map<string, GPUComputePipeline>();
        const gatePipelineFor = (wgsl: string): GPUComputePipeline => {
          const existing = gatePipelines.get(wgsl);
          if (existing) return existing;
          const module = device.createShaderModule({ code: wgsl, label: 'restore-gate' });
          const pipeline = device.createComputePipeline({
            layout: 'auto',
            compute: { module, entryPoint: 'main' },
          });
          gatePipelines.set(wgsl, pipeline);
          return pipeline;
        };

        // Optional two-stage ClampHighlights head capture (pass-through).
        let clamp: Anime4kPipelineLike | null = null;
        if (payload.clampHighlights) {
          const ClampHighlights = ctors.get('ClampHighlights');
          if (!ClampHighlights) throw new Error('ClampHighlights constructor missing');
          clamp = new ClampHighlights({ device, inputTexture: srcTexture });
          await recordPipelineList(encoder, [clamp]);
        }

        let currentTexture = srcTexture;
        let curWidth = srcWidth;
        let curHeight = srcHeight;

        for (const spec of payload.stages) {
          if (spec.kind === 'downscale') {
            const downscale = new Downscale({
              device,
              inputTexture: currentTexture,
              targetDimensions: { width: spec.width, height: spec.height },
            });
            await recordPipelineList(encoder, [downscale]);
            currentTexture = downscale.getOutputTexture();
            curWidth = spec.width;
            curHeight = spec.height;
          } else {
            const Ctor = ctors.get(spec.key);
            if (!Ctor) throw new Error(`no constructor for effect key "${spec.key}"`);
            const scale = spec.behavior.kind === 'scale' ? spec.behavior.scale : 1;
            const outWidth = Math.round(curWidth * scale);
            const outHeight = Math.round(curHeight * scale);
            const inputTexture = currentTexture;
            const effect = new Ctor({
              device,
              inputTexture,
              nativeDimensions: { width: curWidth, height: curHeight },
              targetDimensions: { width: outWidth, height: outHeight },
            });
            // Apply optional tunables (e.g. DoG strength) before recording.
            // Restores expose no setter; they are simply skipped.
            if (spec.params) {
              for (const [name, value] of Object.entries(spec.params)) {
                if (typeof effect.updateParam === 'function') {
                  effect.updateParam(name, value);
                }
              }
            }
            await recordPipelineList(encoder, [effect]);
            let stageTexture = effect.getOutputTexture();
            if (spec.gate) {
              // Production `gate` policy: blend the pre-restore input with this
              // restore's output under the amplitude mask, then advance the
              // chain to the gated texture so downstream stages see it.
              const gatePipeline = gatePipelineFor(spec.gate.wgsl);
              const gatedTexture = device.createTexture({
                size: { width: outWidth, height: outHeight },
                format: 'rgba16float',
                usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
              });
              const gateUniform = device.createBuffer({
                size: 16,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
              });
              device.queue.writeBuffer(
                gateUniform,
                0,
                new Float32Array([spec.gate.low, spec.gate.high, spec.gate.strength, 0]),
              );
              const gateBindGroup = device.createBindGroup({
                layout: gatePipeline.getBindGroupLayout(0),
                entries: [
                  { binding: 0, resource: inputTexture.createView() },
                  { binding: 1, resource: stageTexture.createView() },
                  { binding: 2, resource: gatedTexture.createView() },
                  { binding: 3, resource: { buffer: gateUniform } },
                ],
              });
              const gatePass = encoder.beginComputePass();
              gatePass.setPipeline(gatePipeline);
              gatePass.setBindGroup(0, gateBindGroup);
              gatePass.dispatchWorkgroups(Math.ceil(outWidth / 8), Math.ceil(outHeight / 8));
              gatePass.end();
              stageTexture = gatedTexture;
            }
            currentTexture = stageTexture;
            curWidth = outWidth;
            curHeight = outHeight;
          }
          blit(spec.label, spec.kind === 'downscale' ? 'Downscale' : spec.key, currentTexture);
        }

        if (clamp && typeof clamp.getDeferredPipeline === 'function') {
          const apply = clamp.getDeferredPipeline(currentTexture);
          if (apply) {
            await recordPipelineList(encoder, [apply]);
            currentTexture = apply.getOutputTexture();
            blit('ClampHighlightsApply', 'ClampHighlightsApply', currentTexture);
          }
        }

        // Optional test-only post-pass: the SHIPPED CAS shader applied to the
        // chain tail. Its output is rgba8unorm (as in the extension), so it is
        // identity-blitted into an rgba16float readback texture for encoding.
        if (payload.postSharpen && payload.postSharpen.kind === 'cas') {
          const casModule = device.createShaderModule({
            code: payload.postSharpen.wgsl,
            label: 'shipped-cas-post',
          });
          const casPipeline = device.createComputePipeline({
            layout: 'auto',
            compute: { module: casModule, entryPoint: 'main' },
          });
          const casOutput = device.createTexture({
            size: { width: curWidth, height: curHeight },
            format: 'rgba8unorm',
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
          });
          const casParams = device.createBuffer({
            size: 8,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          });
          device.queue.writeBuffer(
            casParams,
            0,
            new Float32Array([payload.postSharpen.sharpness, 0]),
          );
          const casBindGroup = device.createBindGroup({
            layout: casPipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: currentTexture.createView() },
              { binding: 1, resource: casOutput.createView() },
              { binding: 2, resource: { buffer: casParams } },
            ],
          });
          const casPass = encoder.beginComputePass();
          casPass.setPipeline(casPipeline);
          casPass.setBindGroup(0, casBindGroup);
          casPass.dispatchWorkgroups(Math.ceil(curWidth / 8), Math.ceil(curHeight / 8));
          casPass.end();
          blit(
            `CAS(sharp=${payload.postSharpen.sharpness.toFixed(2)})`,
            'CAS',
            casOutput,
          );
        }

        device.queue.submit([encoder.finish()]);

        const validationError = await device.popErrorScope();
        scopeOpen = false;
        if (validationError) {
          failure = validation(validationError.message);
        } else {
          await device.queue.onSubmittedWorkDone();
          const write = (globalThis as unknown as Record<
            string,
            (meta: GpuPngDumpStageMeta, png: string) => Promise<void>
          >)[payload.binding];
          if (typeof write !== 'function') {
            failure = validation('PNG dump sink binding is not registered on the page');
          } else {
            for (const entry of pending) {
              await entry.buffer.mapAsync(GPUMapMode.READ);
              const view = new DataView(entry.buffer.getMappedRange());
              const pixels = new Uint8ClampedArray(entry.width * entry.height * 4);
              for (let y = 0; y < entry.height; y += 1) {
                for (let x = 0; x < entry.width; x += 1) {
                  const offset = y * entry.bytesPerRow + x * 8;
                  const dest = (y * entry.width + x) * 4;
                  for (let channel = 0; channel < 4; channel += 1) {
                    const value = halfToFloat(view.getUint16(offset + channel * 2, true));
                    pixels[dest + channel] = Math.round(Math.min(1, Math.max(0, value)) * 255);
                  }
                }
              }
              entry.buffer.unmap();
              // Free the readback texture as soon as its pixels are in hand.
              entry.texture.destroy();

              const offscreen = new OffscreenCanvas(entry.width, entry.height);
              const context = offscreen.getContext('2d');
              if (!context) throw new Error('OffscreenCanvas 2d context unavailable (encode)');
              context.putImageData(new ImageData(pixels, entry.width, entry.height), 0, 0);
              const blob = await offscreen.convertToBlob({ type: 'image/png' });
              const pngBase64 = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
              const meta: GpuPngDumpStageMeta = {
                label: entry.label,
                key: entry.key,
                width: entry.width,
                height: entry.height,
              };
              await write(meta, pngBase64);
              dumped.push(meta);
            }
          }
        }
      } catch (error) {
        failure = validation(String(error));
      } finally {
        if (scopeOpen) {
          try {
            await device.popErrorScope();
          } catch {
            // Ignore; the device/page may already be gone.
          }
        }
      }

      if (failure) return failure;
      return { ok: true, stages: dumped, adapterInfo, software };
    },
    {
      srcPngBase64: request.srcPngBase64,
      stages: request.stages,
      clampHighlights: request.clampHighlights ?? false,
      postSharpen: request.postSharpen ?? null,
      binding,
      blitWgsl: IDENTITY_BLIT_WGSL,
    },
  );
}
