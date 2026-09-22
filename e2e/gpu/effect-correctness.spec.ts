import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { referenceCas } from '../../src/core/effects/reference/cas';
import { compareRgba, formatComparison } from '../../src/core/effects/reference/compare';
import {
  guardGpu,
  startSecureOrigin,
  writeArtifacts,
  type GpuFailure,
  type GpuResult,
} from './downscale-harness';
import { bands, black, blackRegion, checker, corner, edge, gradient, type RgbaImage } from './fixtures';

/**
 * C3 Phase 1 — headless-WebGPU numeric correctness gate for the shipped
 * `src/shaders/cas.wgsl`.
 *
 * Runs the real shader on a GPU (SwiftShader fallback) via a secure loopback
 * origin, reads the output back and compares it against the independent
 * pure-TS oracle in `src/core/effects/reference/cas.ts`.
 *
 * This suite is deliberately separate from the GPU-free smoke suite: it is
 * launched with `playwright.gpu.config.ts` / `pnpm test:gpu`.
 */

interface GpuRequest {
  wgsl: string;
  width: number;
  height: number;
  sharpness: number;
  pixels: number[];
}

const CAS_WGSL = readFileSync(
  path.resolve(__dirname, '..', '..', 'src', 'shaders', 'cas.wgsl'),
  'utf8',
);

// Trivial passthrough used only to probe that this environment can create a
// device, dispatch compute, copy to a buffer and map it back. Binding 2 exists
// so the same bind-group shape as the CAS cases can be reused.
const PREFLIGHT_WGSL = `
@group(0) @binding(0) var inputTex: texture_2d<f32>;
@group(0) @binding(1) var outputTex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> params: vec2<f32>;

@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let size = textureDimensions(inputTex);
  if (gid.x >= size.x || gid.y >= size.y) {
    return;
  }
  let pos = vec2<i32>(i32(gid.x), i32(gid.y));
  // Reference the uniform so auto layout retains binding 2 (mirrors CAS).
  // At sharpness 0 this is a no-op: max(sample, 0) == sample.
  textureStore(outputTex, pos, max(textureLoad(inputTex, pos, 0), vec4<f32>(params.x)));
}
`;

const PAGE_HTML =
  '<!doctype html><html><head><meta charset="utf-8">'
  + '<title>gpu-effect-correctness</title></head><body></body></html>';

interface GpuCase {
  name: string;
  image: RgbaImage;
  sharpness: number;
  exact: boolean;
  /** When set, assert every output pixel is pure black (alpha 255). */
  allBlack?: boolean;
}

const CAS_CASES: GpuCase[] = [
  { name: 'cas-identity', image: gradient(), sharpness: 0, exact: true },
  { name: 'cas-default', image: bands(), sharpness: 0.5, exact: false },
  { name: 'cas-max', image: checker(), sharpness: 1, exact: false },
  { name: 'cas-edge', image: edge(), sharpness: 0.5, exact: false },
  { name: 'cas-1x1', image: corner(), sharpness: 0.5, exact: false },
  // Degenerate input: every 3x3 neighborhood is exactly black. The shader guard
  // must return the finite identity, so the result is exactly black (exact).
  { name: 'cas-black', image: black(), sharpness: 0.5, exact: true, allBlack: true },
  // Black region inside a normal frame: the left columns exercise the
  // degenerate path while the grey/bright edge takes the normal sharpening path.
  { name: 'cas-black-region', image: blackRegion(), sharpness: 0.5, exact: false },
];

let server: Server | undefined;
let origin = '';
let preflight: GpuResult | null = null;

/** Run one compute dispatch + readback round-trip entirely inside the page. */
async function runGpuCase(page: Page, request: GpuRequest): Promise<GpuResult> {
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

    const { width, height } = req;
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;

    device.pushErrorScope('validation');
    let scopeOpen = true;
    let failure: GpuFailure | null = null;
    let output: number[] = [];

    try {
      const module = device.createShaderModule({ code: req.wgsl, label: 'cas-under-test' });
      const pipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module, entryPoint: 'main' },
      });

      const inputTexture = device.createTexture({
        size: { width, height },
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      const outputTexture = device.createTexture({
        size: { width, height },
        format: 'rgba8unorm',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
      });
      const paramsBuffer = device.createBuffer({
        size: 8, // vec2<f32>, matching src/core/effects/cas.ts
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const readback = device.createBuffer({
        size: bytesPerRow * height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });

      device.queue.writeTexture(
        { texture: inputTexture },
        new Uint8Array(req.pixels),
        { bytesPerRow: width * 4, rowsPerImage: height },
        { width, height },
      );
      // Uniform packing matches CAS: [sharpness, 0].
      device.queue.writeBuffer(paramsBuffer, 0, new Float32Array([req.sharpness, 0]));

      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: inputTexture.createView() },
          { binding: 1, resource: outputTexture.createView() },
          { binding: 2, resource: { buffer: paramsBuffer } },
        ],
      });

      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
      pass.end();
      encoder.copyTextureToBuffer(
        { texture: outputTexture },
        { buffer: readback, bytesPerRow, rowsPerImage: height },
        { width, height },
      );
      device.queue.submit([encoder.finish()]);

      const validationError = await device.popErrorScope();
      scopeOpen = false;
      if (validationError) {
        failure = validation(validationError.message);
      } else {
        await readback.mapAsync(GPUMapMode.READ);
        const mapped = new Uint8Array(readback.getMappedRange());
        const stripped = new Uint8Array(width * height * 4);
        for (let y = 0; y < height; y++) {
          stripped.set(
            mapped.subarray(y * bytesPerRow, y * bytesPerRow + width * 4),
            y * width * 4,
          );
        }
        readback.unmap();
        output = Array.from(stripped);
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
    return { ok: true, width, height, data: output, adapterInfo, software };
  }, request);
}

test.beforeAll(async ({ browser }) => {
  const started = await startSecureOrigin({ serveVendor: false, pageHtml: PAGE_HTML });
  server = started.server;
  origin = started.origin;

  const page = await browser.newPage();
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    preflight = await runGpuCase(page, {
      wgsl: PREFLIGHT_WGSL,
      width: 2,
      height: 2,
      sharpness: 0,
      pixels: [32, 64, 96, 255, 128, 160, 192, 255, 200, 210, 220, 255, 45, 90, 135, 255],
    });
  } finally {
    await page.close();
  }

  if (preflight.ok) {
    console.log(
      `[gpu] preflight OK; adapter=${preflight.adapterInfo} software=${preflight.software}`,
    );
  } else {
    console.warn(`[gpu] preflight FAILED (${preflight.kind}): ${preflight.error}`);
  }
});

test.afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve) => {
      server!.close(() => resolve());
    });
  }
});

for (const gpuCase of CAS_CASES) {
  test(gpuCase.name, async ({ page }) => {
    guardGpu(preflight, 'GPU compute');
    await page.goto(origin, { waitUntil: 'domcontentloaded' });

    const { image, sharpness } = gpuCase;
    const result = await runGpuCase(page, {
      wgsl: CAS_WGSL,
      width: image.width,
      height: image.height,
      sharpness,
      pixels: Array.from(image.data),
    });

    expect(
      result.ok,
      result.ok
        ? 'unexpected result shape'
        : `GPU case failed (${result.kind}): ${result.error}`,
    ).toBe(true);
    if (!result.ok) return;

    const actual = new Uint8Array(result.data);
    const expected = referenceCas(image.data, image.width, image.height, { sharpness });
    const cmp = compareRgba(expected, actual);

    // The oracle must be finite for every case (guards the 0*Infinity path).
    for (let i = 0; i < expected.length; i++) {
      expect(
        Number.isFinite(expected[i]),
        `${gpuCase.name}: oracle produced a non-finite value at byte ${i}`,
      ).toBe(true);
    }

    // Explicit degenerate-case assertion: the all-black frame must come back
    // finite and exactly black, never NaN/Infinity or garbage.
    if (gpuCase.allBlack) {
      for (let p = 0; p < actual.length; p += 4) {
        expect(
          [actual[p], actual[p + 1], actual[p + 2], actual[p + 3]],
          `${gpuCase.name}: expected pure black at pixel ${p / 4}`,
        ).toEqual([0, 0, 0, 255]);
      }
    }

    // Guard against a false pass where both the oracle and the GPU are no-ops.
    // (cas-1x1 cannot be non-trivial: a 1x1 neighborhood is just the pixel.)
    if (!gpuCase.exact && gpuCase.name !== 'cas-1x1') {
      const inputVsExpected = compareRgba(image.data, expected);
      expect(
        inputVsExpected.maxAbs,
        `${gpuCase.name}: oracle produced no change for this fixture/sharpness`,
      ).toBeGreaterThan(0);
    }

    let badAlphaCount = 0;
    for (let i = 3; i < actual.length; i += 4) {
      if (actual[i] !== 255) badAlphaCount += 1;
    }

    const dimensionsOk =
      result.width === image.width
      && result.height === image.height
      && actual.length === expected.length;
    const metricsOk = gpuCase.exact
      ? cmp.maxAbs === 0
      : cmp.maxAbs <= 2 && cmp.meanAbs <= 0.5 && cmp.psnr >= 40;

    if (!dimensionsOk || badAlphaCount > 0 || !metricsOk) {
      const adapter = preflight && preflight.ok ? preflight.adapterInfo : 'unknown';
      const dir = writeArtifacts('effect-correctness', gpuCase.name, expected, actual, {
        case: gpuCase.name,
        width: image.width,
        height: image.height,
        sharpness,
        exact: gpuCase.exact,
        adapter,
        comparison: cmp,
      });
      console.warn(`[gpu] ${gpuCase.name} artifacts written to ${dir}`);
    }

    const summary = formatComparison(gpuCase.name, cmp);
    expect(dimensionsOk, `${summary} (dimensions mismatch)`).toBe(true);
    expect(badAlphaCount, `${summary} (alpha != 255 on ${badAlphaCount} pixels)`).toBe(0);

    if (gpuCase.exact) {
      expect(cmp.maxAbs, summary).toBe(0);
    } else {
      expect(cmp.maxAbs, summary).toBeLessThanOrEqual(2);
      expect(cmp.meanAbs, summary).toBeLessThanOrEqual(0.5);
      expect(cmp.psnr, summary).toBeGreaterThanOrEqual(40);
    }

    const psnr = cmp.psnr === Infinity ? 'Infinity' : `${cmp.psnr.toFixed(2)}dB`;
    console.log(
      `[gpu] ${gpuCase.name} maxAbs=${cmp.maxAbs} meanAbs=${cmp.meanAbs.toFixed(4)}`
      + ` psnr=${psnr} mismatches=${cmp.mismatchCount}`,
    );
  });
}
