import { mkdirSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  referenceBilinearDownscale,
  referenceDownscale,
} from '../../src/core/effects/reference/downscale';
import { compareRgba } from '../../src/core/effects/reference/compare';
import {
  idealBoxMtf,
  makeGrating,
  makeStepEdge,
  measureEdgeResponse,
  mtfFromPair,
  type RgbaImage,
} from '../../src/core/effects/reference/signal';
import {
  guardGpu,
  loadDownscaleWgsl,
  runGpuCase,
  startSecureOrigin,
  writeArtifacts,
  type GpuResult,
} from './downscale-harness';

/**
 * C3 / §7.1 — controlled MTF (frequency-response) experiment isolating the
 * shipped `Downscale` kernel.
 *
 * For ratios 4/3, 3/2 and 2/1 (plus the target-exact 2/1 insertion the chain
 * uses) this runs the real compiled Downscale WGSL and the pure-TS oracle /
 * bilinear references on sinusoidal gratings, and measures the fundamental
 * retention per period.
 *
 * The shipped kernel has two paths, selected from the dimensions:
 *   - Non-2:1 (4/3, 3/2): the ratio-scaled fractional-coverage box, a true
 *     convex area average in linear light. It is a low-pass with a structural
 *     zero at input Nyquist and exactly zero step-edge overshoot/undershoot.
 *   - Exact 2:1 (2/1 and 2/1-target): the half-phase Keys cubic peaking kernel
 *     `[-0.10, 0.60, 0.60, -0.10]` with a hard anti-ringing clamp. It lifts the
 *     output-Nyquist band (~0.70 at p=4 vs ~0.49 for the box), peaks slightly
 *     above 1 in the mid band (~1.04 at p=8), still nulls input Nyquist, and
 *     the clamp keeps step-edge overshoot/undershoot at exactly 0.
 *
 * Two test-local sharper kernels (never added to the library) are measured for
 * 2/1: a 4-tap Catmull-Rom cubic and a box+unsharp variant; they are
 * contrast/ringing comparators only, not claims about the shipped kernel.
 * Step-edge overshoot/undershoot is measured for every kernel.
 *
 * All retention numbers are ratios of the **fundamental** 8-bit luminance
 * component (see `src/core/effects/reference/signal.ts`), so the sRGB
 * encode/decode nonlinearity does not corrupt them the way raw max-min would.
 */

const PERIODS = [2, 3, 4, 6, 8, 16, 32];
const GRATING_DC = 128;
const GRATING_AMPLITUDE = 60;
// A mid-grey step with headroom on both sides so negative-lobe overshoot and
// undershoot are measured, not clipped by the [0, 1] readback clamp. (The
// `makeStepEdge` default is the 0 -> 255 step; the experiment uses 96 -> 160.)
const STEP_LOW = 96;
const STEP_HIGH = 160;

interface RatioCase {
  name: string;
  ratio: number;
  srcWidth: number;
  srcHeight: number;
  outWidth: number;
  outHeight: number;
}

// Source widths are multiples of lcm(PERIODS)=96 and of the ratio denominator,
// so every stimulus holds an integer number of cycles both before and after the
// integer-ratio downscale (leakage-free discrete bins). Heights are >= 32.
const RATIO_CASES: RatioCase[] = [
  { name: 'ratio-4-3', ratio: 4 / 3, srcWidth: 384, srcHeight: 48, outWidth: 288, outHeight: 36 },
  { name: 'ratio-3-2', ratio: 3 / 2, srcWidth: 384, srcHeight: 48, outWidth: 256, outHeight: 32 },
  { name: 'ratio-2-1', ratio: 2, srcWidth: 384, srcHeight: 48, outWidth: 192, outHeight: 24 },
  // The target-exact 2x step the shrinking/equal-target chain actually inserts
  // (the exact-2:1 sharp2x peaking path, like ratio-2-1).
  { name: 'ratio-2-1-target', ratio: 2, srcWidth: 192, srcHeight: 64, outWidth: 96, outHeight: 32 },
];

/**
 * Shipped-kernel fundamental retention per case and source period, matched to
 * the two-path shader. The non-2:1 ratios run the box; the 2:1 cases run the
 * exact-2:1 sharp2x peaking kernel. The shipped GPU must reproduce these
 * within tolerance (0.02 absorbs 8-bit quantization). Period `2` is
 * intentionally absent for the 2/1 cases, where the fundamental aliases to DC
 * (`null`). The box entries are unchanged from the pre-peaking harness; the
 * 2/1 entries are the peaking kernel's ~0.70 (p4) and ~1.04 (p8) response.
 */
const SHIPPED_REFERENCE: Record<string, Record<number, number>> = {
  'ratio-4-3': { 2: 0.521, 3: 0.67, 4: 0.735, 8: 0.913, 16: 0.986, 32: 0.997 },
  'ratio-3-2': { 2: 0.424, 3: 0.558, 4: 0.725, 8: 0.923, 16: 0.981, 32: 0.996 },
  'ratio-2-1': { 4: 0.7, 8: 1.04 },
  'ratio-2-1-target': { 4: 0.7, 8: 1.04 },
};

/**
 * Test-local Catmull-Rom / cubic 4-tap downscale at ratio 2.
 *
 * For output x the source block is [2x, 2x+2); the cubic is evaluated at the
 * half phase using the four nearest source texels 2x-1 .. 2x+2 with weights
 * (-1, 9, 9, -1)/16 (sum = 1). Separable, clamp-to-edge, in linear light. The
 * kernel has negative lobes (ringing) and a structural zero at input Nyquist.
 */
const CUBIC2_WGSL = `
@group(0) @binding(0) var tex_in: texture_2d<f32>;
@group(0) @binding(1) var tex_out: texture_storage_2d<rgba16float, write>;

fn srgb_to_linear(c: vec3f) -> vec3f {
  let lo = c / 12.92;
  let hi = pow((c + vec3f(0.055)) / 1.055, vec3f(2.4));
  return select(hi, lo, c <= vec3f(0.04045));
}
fn linear_to_srgb(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(c, vec3f(1.0 / 2.4)) - vec3f(0.055);
  return select(hi, lo, c <= vec3f(0.0031308));
}
fn cubic_weight(i: i32) -> f32 {
  if (i == 0 || i == 3) { return -0.0625; }
  return 0.5625;
}
@compute @workgroup_size(8, 8)
fn computeMain(@builtin(global_invocation_id) gid: vec3u) {
  let out_dims = textureDimensions(tex_out);
  if (gid.x >= out_dims.x || gid.y >= out_dims.y) { return; }
  let in_dims = textureDimensions(tex_in);
  let max_x = i32(in_dims.x) - 1;
  let max_y = i32(in_dims.y) - 1;
  let base_x = i32(gid.x) * 2;
  let base_y = i32(gid.y) * 2;
  var acc = vec3f(0.0);
  var acc_a = 0.0;
  for (var j = 0; j < 4; j = j + 1) {
    let sy = clamp(base_y - 1 + j, 0, max_y);
    let wy = cubic_weight(j);
    for (var i = 0; i < 4; i = i + 1) {
      let sx = clamp(base_x - 1 + i, 0, max_x);
      let w = cubic_weight(i) * wy;
      let pixel = textureLoad(tex_in, vec2i(sx, sy), 0);
      acc = acc + srgb_to_linear(pixel.rgb) * w;
      acc_a = acc_a + pixel.a * w;
    }
  }
  textureStore(tex_out, gid.xy, vec4f(linear_to_srgb(max(acc, vec3f(0.0))), acc_a));
}
`;

/**
 * Test-local box + controlled unsharp at ratio 2:
 *
 *   out = box2 + K * (box2 - box4)
 *
 * where box2 is the shipped 2x2 area average (source offsets 0,1) and box4 is
 * the 4x4 average (offsets -1,0,1,2). The combined separable weights are
 * `w2 + K*(w2 - 0.25)` and sum to 1, so DC is preserved. Negative weights ring.
 */
function unsharpWgsl(k: number): string {
  return `
@group(0) @binding(0) var tex_in: texture_2d<f32>;
@group(0) @binding(1) var tex_out: texture_storage_2d<rgba16float, write>;

fn srgb_to_linear(c: vec3f) -> vec3f {
  let lo = c / 12.92;
  let hi = pow((c + vec3f(0.055)) / 1.055, vec3f(2.4));
  return select(hi, lo, c <= vec3f(0.04045));
}
fn linear_to_srgb(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(c, vec3f(1.0 / 2.4)) - vec3f(0.055);
  return select(hi, lo, c <= vec3f(0.0031308));
}
fn combined_weight(i: i32) -> f32 {
  let w2 = select(0.0, 0.5, i == 1 || i == 2);
  let w4 = 0.25;
  return w2 + ${k.toFixed(1)} * (w2 - w4);
}
@compute @workgroup_size(8, 8)
fn computeMain(@builtin(global_invocation_id) gid: vec3u) {
  let out_dims = textureDimensions(tex_out);
  if (gid.x >= out_dims.x || gid.y >= out_dims.y) { return; }
  let in_dims = textureDimensions(tex_in);
  let max_x = i32(in_dims.x) - 1;
  let max_y = i32(in_dims.y) - 1;
  let base_x = i32(gid.x) * 2;
  let base_y = i32(gid.y) * 2;
  var acc = vec3f(0.0);
  var acc_a = 0.0;
  for (var j = 0; j < 4; j = j + 1) {
    let sy = clamp(base_y - 1 + j, 0, max_y);
    let wy = combined_weight(j);
    for (var i = 0; i < 4; i = i + 1) {
      let sx = clamp(base_x - 1 + i, 0, max_x);
      let w = combined_weight(i) * wy;
      let pixel = textureLoad(tex_in, vec2i(sx, sy), 0);
      acc = acc + srgb_to_linear(pixel.rgb) * w;
      acc_a = acc_a + pixel.a * w;
    }
  }
  textureStore(tex_out, gid.xy, vec4f(linear_to_srgb(max(acc, vec3f(0.0))), acc_a));
}
`;
}

type CpuKernel = (
  source: Uint8Array,
  srcWidth: number,
  srcHeight: number,
  outWidth: number,
  outHeight: number,
) => Uint8Array;

interface KernelSpec {
  name: string;
  /**
   * The shader to dispatch. The shipped WGSL is only known after `beforeAll`,
   * so it is supplied lazily; this matrix is built at module scope, before the
   * loader runs. Test-local kernels pass a plain string.
   */
  gpuWgsl?: string | (() => string);
  cpu?: CpuKernel;
  ideal?: boolean;
}

interface RetentionRecord {
  period: number;
  retention: number | null;
  ideal: number;
}

interface KernelRecord {
  case: string;
  ratio: number;
  kernel: string;
  retentions: RetentionRecord[];
  nyquistPeriod: number;
  nyquistRetention: number | null;
  cutoffPeriod: number | null;
  overshootPct: number;
  undershootPct: number;
}

const RESULTS: KernelRecord[] = [];
let server: Server | undefined;
let origin = '';
let preflight: GpuResult | null = null;
let downscaleWgsl = '';

function kernelsFor(ratioCase: RatioCase): KernelSpec[] {
  const kernels: KernelSpec[] = [
    { name: 'shipped-gpu', gpuWgsl: () => downscaleWgsl, cpu: referenceDownscale },
    { name: 'oracle-ts', cpu: referenceDownscale },
    { name: 'bilinear', cpu: referenceBilinearDownscale },
    { name: 'ideal-box', ideal: true },
  ];
  if (ratioCase.ratio === 2) {
    kernels.push({ name: 'cubic2-catmullrom', gpuWgsl: CUBIC2_WGSL });
    kernels.push({ name: 'unsharp-k0.5', gpuWgsl: unsharpWgsl(0.5) });
    kernels.push({ name: 'unsharp-k1.0', gpuWgsl: unsharpWgsl(1.0) });
  }
  return kernels;
}

function findRetention(retentions: RetentionRecord[], period: number): number | null {
  return retentions.find((entry) => entry.period === period)?.retention ?? null;
}

function retentionAt(record: KernelRecord, period: number): number | null {
  return findRetention(record.retentions, period);
}

/** Run a kernel (GPU or CPU) on an image and return the RGBA8 output. */
async function runKernel(
  page: Page,
  ratioCase: RatioCase,
  kernel: KernelSpec,
  image: RgbaImage,
  context: string,
): Promise<RgbaImage> {
  const wgsl = typeof kernel.gpuWgsl === 'function' ? kernel.gpuWgsl() : kernel.gpuWgsl;
  if (wgsl) {
    const result = await runGpuCase(page, {
      wgsl,
      srcWidth: image.width,
      srcHeight: image.height,
      outWidth: ratioCase.outWidth,
      outHeight: ratioCase.outHeight,
      pixels: Array.from(image.data),
    });
    expect(
      result.ok,
      result.ok ? 'unexpected result shape' : `GPU ${context} failed (${result.kind}): ${result.error}`,
    ).toBe(true);
    if (!result.ok) throw new Error(`GPU ${context} failed: ${result.error}`);
    return { width: ratioCase.outWidth, height: ratioCase.outHeight, data: new Uint8Array(result.data) };
  }
  if (kernel.cpu) {
    const data = kernel.cpu(
      image.data,
      image.width,
      image.height,
      ratioCase.outWidth,
      ratioCase.outHeight,
    );
    return { width: ratioCase.outWidth, height: ratioCase.outHeight, data };
  }
  // ideal: never used for image output (retention/ringing are analytic).
  return image;
}

test.beforeAll(async ({ browser }) => {
  downscaleWgsl = await loadDownscaleWgsl('downscale-mtf');
  console.log('[gpu] loaded Downscale WGSL for the MTF experiment');

  const started = await startSecureOrigin();
  server = started.server;
  origin = started.origin;

  const page = await browser.newPage();
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    preflight = await runGpuCase(page, {
      wgsl: `
@group(0) @binding(0) var tex_in: texture_2d<f32>;
@group(0) @binding(1) var tex_out: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8, 8)
fn computeMain(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(tex_out);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }
  textureStore(tex_out, vec2i(gid.xy), textureLoad(tex_in, vec2i(gid.xy), 0));
}
`,
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
      `[gpu] MTF preflight OK; adapter=${preflight.adapterInfo} software=${preflight.software}`,
    );
  } else {
    console.warn(`[gpu] MTF preflight FAILED (${preflight.kind}): ${preflight.error}`);
  }
});

test.afterAll(async () => {
  if (RESULTS.length > 0) {
    const dir = path.resolve(__dirname, '..', '..', 'test-results', 'downscale-mtf');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'results.json'), JSON.stringify(RESULTS, null, 2));

    const header = 'case,ratio,kernel,period,retention,ideal';
    const rows = [header];
    for (const record of RESULTS) {
      for (const entry of record.retentions) {
        rows.push([
          record.case,
          record.ratio.toFixed(4),
          record.kernel,
          entry.period,
          entry.retention === null ? 'null' : entry.retention.toFixed(6),
          entry.ideal.toFixed(6),
        ].join(','));
      }
    }
    writeFileSync(path.join(dir, 'results.csv'), `${rows.join('\n')}\n`);
    writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(RESULTS.map((record) => ({
      case: record.case,
      ratio: record.ratio,
      kernel: record.kernel,
      retentionP2: retentionAt(record, 2),
      retentionP4: retentionAt(record, 4),
      retentionP8: retentionAt(record, 8),
      nyquistPeriod: record.nyquistPeriod,
      nyquistRetention: record.nyquistRetention,
      cutoffPeriod: record.cutoffPeriod,
      overshootPct: record.overshootPct,
      undershootPct: record.undershootPct,
    })), null, 2));

    console.log('\n[gpu] Downscale MTF summary (fundamental retention; null = aliases to DC)');
    console.log('case, kernel, ret@2, ret@4, ret@8, nyq(p), nyqRet, cutoff<0.5, over%, under%');
    for (const record of RESULTS) {
      const fmt = (value: number | null): string => (value === null ? '  null' : value.toFixed(3));
      console.log(
        `${record.case}, ${record.kernel}, ${fmt(retentionAt(record, 2))}, `
        + `${fmt(retentionAt(record, 4))}, ${fmt(retentionAt(record, 8))}, `
        + `${record.nyquistPeriod.toFixed(2)}, ${fmt(record.nyquistRetention)}, `
        + `${record.cutoffPeriod === null ? ' none' : String(record.cutoffPeriod)}, `
        + `${record.overshootPct.toFixed(2)}, ${record.undershootPct.toFixed(2)}`,
      );
    }
  }

  if (server) {
    await new Promise<void>((resolve) => {
      server!.close(() => resolve());
    });
  }
});

for (const ratioCase of RATIO_CASES) {
  for (const kernel of kernelsFor(ratioCase)) {
    test(`${ratioCase.name} / ${kernel.name}`, async ({ page }) => {
      guardGpu(preflight, 'downscale MTF');
      await page.goto(origin, { waitUntil: 'domcontentloaded' });

      const retentions: RetentionRecord[] = [];

      for (const period of PERIODS) {
        const ideal = idealBoxMtf(ratioCase.ratio, period);
        if (kernel.ideal) {
          retentions.push({ period, retention: ideal, ideal });
          continue;
        }

        const grating = makeGrating({
          width: ratioCase.srcWidth,
          height: ratioCase.srcHeight,
          period,
          axis: 'x',
          dc: GRATING_DC,
          amplitude: GRATING_AMPLITUDE,
        });
        const output = await runKernel(page, ratioCase, kernel, grating, `grating p=${period}`);
        const retention = mtfFromPair(grating, output, {
          ratio: ratioCase.ratio,
          period,
          axis: 'x',
        });
        retentions.push({ period, retention, ideal });

        if (kernel.name === 'shipped-gpu') {
          const expected = referenceDownscale(
            grating.data,
            ratioCase.srcWidth,
            ratioCase.srcHeight,
            ratioCase.outWidth,
            ratioCase.outHeight,
          );
          const cmp = compareRgba(expected, output.data);
          // Infrastructure guard: the real GPU kernel (box at non-2:1, sharp2x
          // at exact 2:1) must track the two-path oracle.
          expect(cmp.maxAbs, `${ratioCase.name} p=${period} GPU-vs-oracle ${JSON.stringify(cmp)}`)
            .toBeLessThanOrEqual(2);
          // Spectral expectation for the selected path: box values for the
          // non-2:1 ratios, sharp2x peaking values for the 2:1 ratios
          // (tolerance 0.02 absorbs 8-bit quantization).
          const shippedReference = SHIPPED_REFERENCE[ratioCase.name]?.[period];
          if (shippedReference !== undefined) {
            expect(retention, `${ratioCase.name} p=${period} shipped retention`).not.toBeNull();
            expect(
              Math.abs((retention as number) - shippedReference),
              `${ratioCase.name} p=${period} shipped retention ${String(retention)} vs ${shippedReference}`,
            ).toBeLessThanOrEqual(0.02);
          }
          writeArtifacts('downscale-mtf', `${ratioCase.name}-p${period}`, expected, output.data, {
            case: ratioCase.name,
            period,
            ratio: ratioCase.ratio,
            srcWidth: ratioCase.srcWidth,
            outWidth: ratioCase.outWidth,
            maxAbs: cmp.maxAbs,
            meanAbs: cmp.meanAbs,
          });
        }
      }

      // Step-edge ringing on the same kernel.
      const step = makeStepEdge({
        width: ratioCase.srcWidth,
        height: ratioCase.srcHeight,
        axis: 'x',
        low: STEP_LOW,
        high: STEP_HIGH,
        position: Math.floor(ratioCase.srcWidth / 2),
      });
      let edgeOutput: RgbaImage;
      if (kernel.ideal) {
        // The ideal box is a convex average: monotonic, no ringing.
        edgeOutput = step;
      } else {
        edgeOutput = await runKernel(page, ratioCase, kernel, step, 'step');
        if (kernel.name === 'shipped-gpu') {
          const expected = referenceDownscale(
            step.data,
            ratioCase.srcWidth,
            ratioCase.srcHeight,
            ratioCase.outWidth,
            ratioCase.outHeight,
          );
          writeArtifacts('downscale-mtf', `${ratioCase.name}-step`, expected, edgeOutput.data, {
            case: ratioCase.name,
            kind: 'step',
            low: STEP_LOW,
            high: STEP_HIGH,
          });
        }
      }
      const edge = measureEdgeResponse(edgeOutput, {
        axis: 'x',
        low: STEP_LOW,
        high: STEP_HIGH,
        margin: Math.max(8, Math.floor(ratioCase.outWidth / 16)),
      });

      const nyquistPeriod = 2 * ratioCase.ratio;
      const nyquistCandidates = PERIODS.filter((p) => p + 1e-9 >= nyquistPeriod);
      const nyquistMeasuredPeriod = nyquistCandidates.length > 0 ? nyquistCandidates[0] : null;
      const nyquistRetention = nyquistMeasuredPeriod === null
        ? null
        : findRetention(retentions, nyquistMeasuredPeriod);
      const cutoffPeriod = [...PERIODS]
        .sort((a, b) => a - b)
        .find((p) => {
          const value = findRetention(retentions, p);
          return value !== null && value < 0.5;
        }) ?? null;

      const record: KernelRecord = {
        case: ratioCase.name,
        ratio: ratioCase.ratio,
        kernel: kernel.name,
        retentions,
        nyquistPeriod,
        nyquistRetention,
        cutoffPeriod,
        overshootPct: edge.overshootPct,
        undershootPct: edge.undershootPct,
      };
      RESULTS.push(record);

      const ret8 = retentionAt(record, 8);
      const ret32 = retentionAt(record, 32);
      // Only the unconditional convex area averages are guaranteed monotone in
      // retention as the period grows. `shipped-gpu`/`oracle-ts` are two-path
      // kernels: they are convex boxes at non-2:1, but at exact 2:1 the sharp2x
      // peaking kernel deliberately rises above 1 in the mid band and then
      // falls, so they are excluded here rather than special-cased per ratio.
      // The test-local ringing kernels (cubic/unsharp) are excluded too: their
      // negative lobes intentionally push retention above 1 at long periods.
      const isConvexBoxKernel = kernel.name === 'bilinear' || kernel.name === 'ideal-box';
      if (isConvexBoxKernel && ret8 !== null && ret32 !== null) {
        expect(ret32, `${record.case}/${record.kernel} retention should rise with period`)
          .toBeGreaterThanOrEqual(ret8 - 0.02);
      }

      // Test-local negative-lobe comparators must out-resolve a plain box
      // (measured ~0.49 at p=4 on 2/1 before the peaking path). At the 2:1
      // cases the shipped kernel is itself peaking (~0.70 at p=4), so the
      // unsharp variants are required to beat that too (p4 ~= 0.77 for k=0.5
      // and ~1.15 for k=1.0); the A=0.0625 Catmull-Rom is the weaker one
      // (~0.63) and is measured, not asserted against the shipped kernel.
      if (kernel.name === 'cubic2-catmullrom' || kernel.name.startsWith('unsharp')) {
        const ret4 = retentionAt(record, 4);
        expect(ret4, `${record.case}/${record.kernel} p=4 retention`).not.toBeNull();
        expect(ret4 as number, `${record.case}/${record.kernel} p=4 floor`)
          .toBeGreaterThan(0.55);
        if (kernel.name.startsWith('unsharp')) {
          const shipped = RESULTS.find(
            (entry) => entry.case === ratioCase.name && entry.kernel === 'shipped-gpu',
          );
          const shippedRet4 = shipped ? retentionAt(shipped, 4) : null;
          if (shippedRet4 !== null) {
            expect(ret4 as number, `${record.case}/${record.kernel} p=4 vs shipped kernel`)
              .toBeGreaterThan(shippedRet4);
          }
        }
        // ...at the cost of step-edge ringing.
        expect(edge.overshootPct + edge.undershootPct, `${record.case}/${record.kernel} ringing`)
          .toBeGreaterThan(0);
      }

      // The shipped kernel has exactly zero step-edge ringing on both paths:
      // the box is a convex average, and sharp2x's negative lobes are removed
      // by the hard anti-ringing clamp. The oracle/bilinear/ideal references
      // are likewise ringing-free. Only the test-local negative-lobe
      // comparators (which have no clamp) ring.
      if (
        kernel.name === 'shipped-gpu'
        || kernel.name === 'oracle-ts'
        || kernel.name === 'bilinear'
        || kernel.name === 'ideal-box'
      ) {
        expect(edge.overshootPct, `${record.case}/${record.kernel} overshoot`).toBe(0);
        expect(edge.undershootPct, `${record.case}/${record.kernel} undershoot`).toBe(0);
      }

      const fmt = (value: number | null): string => (value === null ? 'null' : value.toFixed(3));
      console.log(
        `[gpu] ${record.case}/${record.kernel} p2=${fmt(retentionAt(record, 2))}`
        + ` p4=${fmt(retentionAt(record, 4))} p8=${fmt(retentionAt(record, 8))}`
        + ` cutoff=${record.cutoffPeriod ?? 'none'} over=${record.overshootPct.toFixed(2)}%`
        + ` under=${record.undershootPct.toFixed(2)}%`,
      );
    });
  }
}
