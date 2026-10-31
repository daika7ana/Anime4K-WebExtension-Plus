import type { Server } from 'node:http';
import { expect, test } from '@playwright/test';
import {
  referenceBilinearDownscale,
  referenceDownscale,
} from '../../src/core/effects/reference/downscale';
import { compareRgba, formatComparison } from '../../src/core/effects/reference/compare';
import {
  guardGpu,
  loadDownscaleWgsl,
  resolveDownscaleWgslPath,
  runGpuCase,
  startSecureOrigin,
  writeArtifacts,
  type GpuResult,
} from './downscale-harness';
import { fineChecker, gradient, impulse, type RgbaImage } from './fixtures';

/**
 * Headless-WebGPU numeric correctness gate for the shipped compute `Downscale`
 * (ratio-scaled fractional-coverage box filter in linear light).
 *
 * Loads the *real* compiled WGSL string from the linked `anime4k-webgpu-async`
 * package (resolved through the package entry, so it also works with a
 * published, non-linked install), runs it on a GPU (SwiftShader fallback),
 * reads the `rgba16float` storage texture back and compares it against the
 * independent pure-TS oracle in `src/core/effects/reference/downscale.ts`.
 *
 * Launched with `playwright.gpu.config.ts` / `pnpm test:gpu`; the config's
 * `testDir: './e2e/gpu'` picks this file up automatically.
 */

// Trivial rgba16float passthrough (identity) used to probe that this
// environment can create a device, dispatch compute, store to an rgba16float
// storage texture, copy it to a buffer and map it back.
const PREFLIGHT_WGSL = `
@group(0) @binding(0) var tex_in: texture_2d<f32>;
@group(0) @binding(1) var tex_out: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn computeMain(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(tex_out);
  if (gid.x >= dims.x || gid.y >= dims.y) {
    return;
  }
  textureStore(tex_out, vec2<i32>(gid.xy), textureLoad(tex_in, vec2<i32>(gid.xy), 0));
}
`;

const PAGE_HTML =
  '<!doctype html><html><head><meta charset="utf-8">'
  + '<title>gpu-downscale-correctness</title></head><body></body></html>';

interface DownscaleCase {
  name: string;
  image: RgbaImage;
  outWidth: number;
  outHeight: number;
}

// Every per-axis ratio is exact: 96/72 = 72/54 = 4/3, 96/72 = 64/48 = 3/2,
// 96/72 = 48/36 = 2/1, 80/40 = 48/24 = 5/3 (top of the (1, 1.67) envelope).
const DOWNSCALE_CASES: DownscaleCase[] = [
  { name: 'downscale-4-3', image: fineChecker(96, 72), outWidth: 72, outHeight: 54 },
  { name: 'downscale-3-2', image: fineChecker(96, 72), outWidth: 64, outHeight: 48 },
  { name: 'downscale-2-1', image: impulse(96, 72), outWidth: 48, outHeight: 36 },
  { name: 'downscale-5-3', image: impulse(80, 40), outWidth: 48, outHeight: 24 },
  { name: 'downscale-1-1', image: gradient(64, 48), outWidth: 64, outHeight: 48 },
];

let server: Server | undefined;
let origin = '';
let preflight: GpuResult | null = null;
let downscaleWgsl = '';

test.beforeAll(async ({ browser }) => {
  // Fail loudly (before touching the GPU) if the shipped shader module is gone.
  const modulePath = resolveDownscaleWgslPath('downscale-correctness');
  downscaleWgsl = await loadDownscaleWgsl('downscale-correctness');
  console.log(`[gpu] loaded Downscale WGSL from ${modulePath}`);

  const started = await startSecureOrigin({ serveVendor: false, pageHtml: PAGE_HTML });
  server = started.server;
  origin = started.origin;

  const page = await browser.newPage();
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    preflight = await runGpuCase(page, {
      wgsl: PREFLIGHT_WGSL,
      srcWidth: 2,
      srcHeight: 2,
      outWidth: 2,
      outHeight: 2,
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

for (const gpuCase of DOWNSCALE_CASES) {
  test(gpuCase.name, async ({ page }) => {
    guardGpu(preflight, 'downscale compute');
    await page.goto(origin, { waitUntil: 'domcontentloaded' });

    const { image, outWidth, outHeight } = gpuCase;
    const result = await runGpuCase(page, {
      wgsl: downscaleWgsl,
      srcWidth: image.width,
      srcHeight: image.height,
      outWidth,
      outHeight,
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
    const isIdentity = image.width === outWidth && image.height === outHeight;

    const expected = referenceDownscale(image.data, image.width, image.height, outWidth, outHeight);
    const cmp = compareRgba(expected, actual);

    // Contrast guard: prove the GPU is running the fractional box in linear
    // light rather than the old naive bilinear tap. (1:1 has no difference to
    // detect and is skipped.)
    const bilinearCmp = isIdentity
      ? null
      : compareRgba(referenceBilinearDownscale(image.data, image.width, image.height, outWidth, outHeight), actual);

    const dimensionsOk =
      result.width === outWidth
      && result.height === outHeight
      && actual.length === expected.length;
    const metricsOk = cmp.maxAbs <= 2 && cmp.meanAbs <= 0.5 && cmp.psnr >= 40;
    const contrastOk = bilinearCmp === null || bilinearCmp.maxAbs >= 3;

    if (!dimensionsOk || !metricsOk || !contrastOk) {
      const adapter = preflight && preflight.ok ? preflight.adapterInfo : 'unknown';
      const dir = writeArtifacts('downscale-correctness', gpuCase.name, expected, actual, {
        case: gpuCase.name,
        srcWidth: image.width,
        srcHeight: image.height,
        outWidth,
        outHeight,
        ratioX: image.width / outWidth,
        ratioY: image.height / outHeight,
        adapter,
        software: result.software,
        comparison: cmp,
        bilinearContrast: bilinearCmp,
      });
      console.warn(`[gpu] ${gpuCase.name} artifacts written to ${dir}`);
    }

    const summary = formatComparison(gpuCase.name, cmp);
    expect(dimensionsOk, `${summary} (dimensions mismatch)`).toBe(true);
    expect(cmp.maxAbs, summary).toBeLessThanOrEqual(2);
    expect(cmp.meanAbs, summary).toBeLessThanOrEqual(0.5);
    expect(cmp.psnr, summary).toBeGreaterThanOrEqual(40);

    if (bilinearCmp) {
      expect(
        bilinearCmp.maxAbs,
        `${gpuCase.name}: box-vs-bilinear contrast too small (${bilinearCmp.maxAbs}); `
        + `GPU may be doing a bilinear tap instead of the fractional box`,
      ).toBeGreaterThanOrEqual(3);
    }

    const psnr = cmp.psnr === Infinity ? 'Infinity' : `${cmp.psnr.toFixed(2)}dB`;
    console.log(
      `[gpu] ${gpuCase.name} src=${image.width}x${image.height} -> ${outWidth}x${outHeight}`
      + ` maxAbs=${cmp.maxAbs} meanAbs=${cmp.meanAbs.toFixed(4)} psnr=${psnr}`
      + ` bilinearDelta=${bilinearCmp ? bilinearCmp.maxAbs : 'n/a'}`
      + ` mismatches=${cmp.mismatchCount}`,
    );
  });
}
