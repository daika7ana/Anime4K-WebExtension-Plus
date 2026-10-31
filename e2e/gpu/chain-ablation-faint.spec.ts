import { mkdirSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  guardGpu,
  runGpuCase,
  runGpuRealChainAblation,
  startSecureOrigin,
  type GpuRealChainStage,
  type RealChainStageSpec,
} from './downscale-harness';

/**
 * TEST-ONLY follow-up to `chain-ablation-real.spec.ts`.
 *
 * The high-contrast straight-line sweep found the real Mode A+A / Ultra chain
 * actually *preserves* (even boosts) 1-px line contrast at 1/10 scale, with the
 * only lossy stage being `Downscale` (retention 0.74 / 0.67) and a net chain
 * retention of ~1.01-1.14. That cannot explain the reported ~76% loss on the
 * wing, so this spec tests the surviving hypothesis: the loss is on FAINT,
 * low-amplitude fine detail (wing membrane veins/grains, ~5-15/255) and/or on
 * OBLIQUE detail, which the learned CNN smooths away as noise.
 *
 * Stimuli (all 192x108 unless noted), each built as gamma-encoded f32 RGBA and
 * fed through the *real* library pipelines:
 *   - faint vertical 1-px lines, delta 10/255 and 4/255 on 128/255 grey;
 *   - the same lines oblique at 45deg and 30deg (delta 10/255);
 *   - a deterministic seeded-LCG 1-px texture patch and a 1-px checkerboard
 *     (amplitude ~6/255);
 *   - a period-2 (Nyquist) low-amplitude sinusoid (~6/255).
 *
 * Metrics per stage:
 *   - line-min contrast (`surround_mean - line_min`) for the line stimuli;
 *   - broadband high-pass energy: luma RMS of `image - 3x3 box blur` over an
 *     ROI, reported as retention vs the source;
 *   - direct float DFT fundamental amplitude for the period-2 sinusoid (the
 *     harness already returns floats; no 8-bit conversion is involved).
 *
 * Three chains run per stimulus so the resampler is separated from the CNNs:
 *   - full:     source -> CNNUL -> CNNx2UL -> Downscale 1.5 -> CNNUL -> CNNUL
 *   - cnnOnly:  source -> CNNUL -> CNNx2UL  (stop before Downscale)
 *   - dscOnly:  source -> Downscale 1.5     (no CNNs)
 *
 * Sanity only is asserted (dims, finite, non-degenerate); the numbers are
 * reported, not gated. No production `src/**` is touched.
 */

const SRC_WIDTH = 192;
const SRC_HEIGHT = 108;

const GREY = 128 / 255;
const DELTA10 = 10 / 255;
const DELTA4 = 4 / 255;
const DELTA6 = 6 / 255;

const SEARCH_RADIUS = 3; // px, search window for the line minimum (stage px)
const SURROUND_INNER = 6; // px, inner edge of the surround band (exclusive)
const SURROUND_OUTER = 10; // px, outer edge of the surround band (inclusive)
const ROW_MARGIN = 8; // source px, excluded top/bottom rows

/** ClampHighlights is transparent at this scale (ret 0.99); skipped to save time. */
const CLAMP_HIGHLIGHTS = false;

// ---------------------------------------------------------------------------
// Chains
// ---------------------------------------------------------------------------

const FULL_CHAIN: RealChainStageSpec[] = [
  { kind: 'effect', label: 'CNNUL#1', key: 'CNNUL', behavior: { kind: 'same' } },
  { kind: 'effect', label: 'CNNx2UL', key: 'CNNx2UL', behavior: { kind: 'scale', scale: 2 } },
  { kind: 'downscale', label: 'Downscale', width: 256, height: 144 },
  { kind: 'effect', label: 'CNNUL#2', key: 'CNNUL', behavior: { kind: 'same' } },
  { kind: 'effect', label: 'CNNUL#3', key: 'CNNUL', behavior: { kind: 'same' } },
];

/** Stop before the target-exact Downscale: source -> CNNUL -> CNNx2UL. */
const CNN_ONLY_CHAIN: RealChainStageSpec[] = FULL_CHAIN.slice(0, 2);

/** Resampler only: 192x108 -> 128x72 (same 1.5 ratio as the full chain). */
const DOWNSCALE_ONLY_CHAIN: RealChainStageSpec[] = [
  { kind: 'downscale', label: 'Downscale', width: 128, height: 72 },
];

interface ChainDef {
  name: string;
  stages: RealChainStageSpec[];
}

const CHAINS: ChainDef[] = [
  { name: 'full', stages: FULL_CHAIN },
  { name: 'cnnOnly', stages: CNN_ONLY_CHAIN },
  { name: 'dscOnly', stages: DOWNSCALE_ONLY_CHAIN },
];

function resolveExpectedDims(stages: RealChainStageSpec[]): Array<{ width: number; height: number }> {
  const dims = [{ width: SRC_WIDTH, height: SRC_HEIGHT }];
  let width = SRC_WIDTH;
  let height = SRC_HEIGHT;
  for (const stage of stages) {
    if (stage.kind === 'downscale') {
      width = stage.width;
      height = stage.height;
    } else if (stage.behavior.kind === 'scale') {
      width = Math.round(width * stage.behavior.scale);
      height = Math.round(height * stage.behavior.scale);
    }
    dims.push({ width, height });
  }
  return dims;
}

// ---------------------------------------------------------------------------
// Stimuli
// ---------------------------------------------------------------------------

interface Roi {
  x0: number;
  y0: number;
  /** Exclusive. */
  x1: number;
  /** Exclusive. */
  y1: number;
}

const DEFAULT_ROI: Roi = { x0: 8, y0: 8, x1: SRC_WIDTH - 8, y1: SRC_HEIGHT - 8 };
const PATCH_ROI: Roi = { x0: 48, y0: 27, x1: 144, y1: 81 };

interface LineSpec {
  x0: number;
  y0: number;
  /** dx/dy (`1/tan(angle from horizontal)`); `null` means a vertical line. */
  cot: number | null;
}

interface StimulusDef {
  name: string;
  build: () => number[];
  lines: LineSpec[] | null;
  roi: Roi;
  /** Whether to report the period-2 fundamental amplitude. */
  fundamental: boolean;
}

function blankCanvas(): number[] {
  const pixels: number[] = [];
  for (let i = 0; i < SRC_WIDTH * SRC_HEIGHT; i += 1) pixels.push(GREY, GREY, GREY, 1);
  return pixels;
}

function buildVerticalLines(lineX: number[], delta: number): number[] {
  const lineSet = new Set(lineX);
  const pixels: number[] = [];
  for (let y = 0; y < SRC_HEIGHT; y += 1) {
    for (let x = 0; x < SRC_WIDTH; x += 1) {
      const value = lineSet.has(x) ? GREY - delta : GREY;
      pixels.push(value, value, value, 1);
    }
  }
  return pixels;
}

/**
 * 1-px oblique lines drawn by perpendicular-distance threshold: a pixel is on
 * the line when its centre is within 0.5 px of the infinite line
 * `x = x0 + cot*(y - y0)`.
 */
function buildObliqueLines(lines: LineSpec[], delta: number): number[] {
  const pixels: number[] = [];
  for (let y = 0; y < SRC_HEIGHT; y += 1) {
    for (let x = 0; x < SRC_WIDTH; x += 1) {
      let on = false;
      for (const line of lines) {
        const cot = line.cot;
        if (cot === null) {
          if (x === line.x0) on = true;
        } else {
          const a = 1;
          const b = -cot;
          const c = -(line.x0 - cot * line.y0);
          const distance = Math.abs(a * x + b * y + c) / Math.hypot(a, b);
          if (distance <= 0.5) on = true;
        }
        if (on) break;
      }
      const value = on ? GREY - delta : GREY;
      pixels.push(value, value, value, 1);
    }
  }
  return pixels;
}

/** Deterministic seeded-LCG white-noise patch of amplitude ~delta on grey. */
function buildTexture(seed: number, delta: number): number[] {
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const pixels = blankCanvas();
  for (let y = PATCH_ROI.y0; y < PATCH_ROI.y1; y += 1) {
    for (let x = PATCH_ROI.x0; x < PATCH_ROI.x1; x += 1) {
      const value = GREY + (next() - 0.5) * 2 * delta;
      const index = (y * SRC_WIDTH + x) * 4;
      pixels[index] = value;
      pixels[index + 1] = value;
      pixels[index + 2] = value;
    }
  }
  return pixels;
}

function buildCheckerboard(delta: number): number[] {
  const pixels: number[] = [];
  for (let y = 0; y < SRC_HEIGHT; y += 1) {
    for (let x = 0; x < SRC_WIDTH; x += 1) {
      const value = (x + y) % 2 === 0 ? GREY + delta : GREY - delta;
      pixels.push(value, value, value, 1);
    }
  }
  return pixels;
}

function buildSinusoid(delta: number): number[] {
  const pixels: number[] = [];
  for (let y = 0; y < SRC_HEIGHT; y += 1) {
    for (let x = 0; x < SRC_WIDTH; x += 1) {
      // cos(pi*x) = (-1)^x: a true period-2 (Nyquist) vertical sinusoid.
      // sin(pi*x) would be identically zero at every integer x.
      const value = GREY + delta * Math.cos(Math.PI * x);
      pixels.push(value, value, value, 1);
    }
  }
  return pixels;
}

const VERTICAL_X = [64, 96, 128];

const STIMULI: StimulusDef[] = [
  {
    name: 'faint-vertical-10of255',
    build: () => buildVerticalLines(VERTICAL_X, DELTA10),
    lines: VERTICAL_X.map((x0) => ({ x0, y0: 0, cot: null })),
    roi: DEFAULT_ROI,
    fundamental: false,
  },
  {
    name: 'faint-vertical-4of255',
    build: () => buildVerticalLines(VERTICAL_X, DELTA4),
    lines: VERTICAL_X.map((x0) => ({ x0, y0: 0, cot: null })),
    roi: DEFAULT_ROI,
    fundamental: false,
  },
  {
    name: 'oblique-45deg-10of255',
    build: () =>
      buildObliqueLines(
        [64, 96, 128].map((x0) => ({ x0, y0: SRC_HEIGHT / 2, cot: 1 })),
        DELTA10,
      ),
    lines: [64, 96, 128].map((x0) => ({ x0, y0: SRC_HEIGHT / 2, cot: 1 })),
    roi: DEFAULT_ROI,
    fundamental: false,
  },
  {
    name: 'oblique-30deg-10of255',
    build: () =>
      buildObliqueLines(
        [80, 96, 112].map((x0) => ({ x0, y0: SRC_HEIGHT / 2, cot: 1 / Math.tan(Math.PI / 6) })),
        DELTA10,
      ),
    lines: [80, 96, 112].map((x0) => ({
      x0,
      y0: SRC_HEIGHT / 2,
      cot: 1 / Math.tan(Math.PI / 6),
    })),
    roi: DEFAULT_ROI,
    fundamental: false,
  },
  {
    name: 'texture-patch-6of255',
    build: () => buildTexture(0x9e3779b9, DELTA6),
    lines: null,
    roi: PATCH_ROI,
    fundamental: false,
  },
  {
    name: 'checkerboard-6of255',
    build: () => buildCheckerboard(DELTA6),
    lines: null,
    roi: DEFAULT_ROI,
    fundamental: false,
  },
  {
    name: 'sinusoid-period2-6of255',
    build: () => buildSinusoid(DELTA6),
    lines: null,
    roi: DEFAULT_ROI,
    fundamental: true,
  },
];

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

function luma(stage: GpuRealChainStage, x: number, y: number): number {
  const index = (y * stage.width + x) * 4;
  return (
    0.2126 * stage.data[index] + 0.7152 * stage.data[index + 1] + 0.0722 * stage.data[index + 2]
  );
}

interface LineMeasurement {
  x0: number;
  cot: number | null;
  rows: number;
  lineMin: number;
  surroundMean: number;
  contrast: number;
}

interface LineStats {
  perLine: LineMeasurement[];
  meanContrast: number;
}

function measureLines(stage: GpuRealChainStage, lines: LineSpec[]): LineStats {
  const sx = stage.width / SRC_WIDTH;
  const sy = stage.height / SRC_HEIGHT;
  const top = Math.max(0, Math.floor(ROW_MARGIN * sy));
  const bottom = Math.min(stage.height, Math.ceil((SRC_HEIGHT - ROW_MARGIN) * sy));
  const perLine: LineMeasurement[] = [];

  for (const line of lines) {
    let lineMin = Number.POSITIVE_INFINITY;
    let surroundSum = 0;
    let surroundCount = 0;
    let rows = 0;

    for (let ys = top; ys < bottom; ys += 1) {
      const srcY = ys / sy;
      const expectedSrcX =
        line.cot === null ? line.x0 : line.x0 + (srcY - line.y0) * line.cot;
      const expectedStageX = expectedSrcX * sx;
      if (expectedStageX < 1 || expectedStageX > stage.width - 2) continue;
      const center = Math.round(expectedStageX);
      const searchLo = Math.max(0, Math.floor(expectedStageX) - SEARCH_RADIUS);
      const searchHi = Math.min(stage.width - 1, Math.ceil(expectedStageX) + SEARCH_RADIUS);

      for (let x = searchLo; x <= searchHi; x += 1) {
        lineMin = Math.min(lineMin, luma(stage, x, ys));
      }
      for (let d = SURROUND_INNER; d <= SURROUND_OUTER; d += 1) {
        for (const x of [center - d, center + d]) {
          if (x >= 0 && x < stage.width) {
            surroundSum += luma(stage, x, ys);
            surroundCount += 1;
          }
        }
      }
      rows += 1;
    }

    const surroundMean = surroundCount > 0 ? surroundSum / surroundCount : Number.NaN;
    perLine.push({
      x0: line.x0,
      cot: line.cot,
      rows,
      lineMin,
      surroundMean,
      contrast: surroundMean - lineMin,
    });
  }

  const meanContrast =
    perLine.reduce((acc, line) => acc + line.contrast, 0) / perLine.length;
  return { perLine, meanContrast };
}

function scaleRoi(roi: Roi, stage: GpuRealChainStage): Roi {
  const sx = stage.width / SRC_WIDTH;
  const sy = stage.height / SRC_HEIGHT;
  return {
    x0: Math.max(1, Math.floor(roi.x0 * sx)),
    y0: Math.max(1, Math.floor(roi.y0 * sy)),
    x1: Math.min(stage.width - 1, Math.ceil(roi.x1 * sx)),
    y1: Math.min(stage.height - 1, Math.ceil(roi.y1 * sy)),
  };
}

/** Luma RMS of `image - 3x3 box blur` over an ROI (interior only). */
function highPassRms(stage: GpuRealChainStage, roi: Roi): number {
  const scaled = scaleRoi(roi, stage);
  let sum = 0;
  let count = 0;
  for (let y = scaled.y0 + 1; y < scaled.y1 - 1; y += 1) {
    for (let x = scaled.x0 + 1; x < scaled.x1 - 1; x += 1) {
      let blur = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          blur += luma(stage, x + dx, y + dy);
        }
      }
      blur /= 9;
      const diff = luma(stage, x, y) - blur;
      sum += diff * diff;
      count += 1;
    }
  }
  return count > 0 ? Math.sqrt(sum / count) : Number.NaN;
}

/**
 * Direct float DFT / least-squares projection of the period-2 source sinusoid.
 *
 * The source pattern has period 2 px, so at a stage of width W the nominal
 * normalised frequency is `(SRC_WIDTH / 2) / W`; for every stage in this
 * experiment `frequency * W` is the integer 96, so the full-width projection
 * has no spectral leakage. Column means over the interior rows form a real
 * signal, and `hypot(a, b)` from the least-squares fit
 * `v[x] ~ dc + a cos(2 pi f x) + b sin(2 pi f x)` is the correct single-sided
 * amplitude at any frequency, including the Nyquist case `f = 0.5` where the
 * usual `2|X|/N` normalisation would be off by a factor of two and `sin` is
 * identically zero. The harness returns float luma, so no 8-bit conversion is
 * involved.
 */
function fundamentalAmplitude(stage: GpuRealChainStage): number {
  const width = stage.width;
  const y0 = Math.max(1, Math.floor(stage.height * 0.1));
  const y1 = Math.min(stage.height, Math.ceil(stage.height * 0.9));
  const columnMean = new Array<number>(width).fill(0);
  for (let y = y0; y < y1; y += 1) {
    for (let x = 0; x < width; x += 1) columnMean[x] += luma(stage, x, y);
  }
  const rows = y1 - y0;
  for (let x = 0; x < width; x += 1) columnMean[x] /= rows;

  const dc = columnMean.reduce((acc, value) => acc + value, 0) / width;
  const frequency = (SRC_WIDTH / 2) / width; // cycles per stage pixel

  let sumC = 0;
  let sumS = 0;
  let normC = 0;
  let normS = 0;
  let cross = 0;
  for (let x = 0; x < width; x += 1) {
    const angle = 2 * Math.PI * frequency * x;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const centred = columnMean[x] - dc;
    sumC += centred * cosine;
    sumS += centred * sine;
    normC += cosine * cosine;
    normS += sine * sine;
    cross += cosine * sine;
  }

  let a = 0;
  let b = 0;
  if (normS <= 1e-12) {
    // Nyquist: the sine basis vanishes; amplitude is carried by the cosine.
    a = normC > 1e-12 ? sumC / normC : 0;
  } else if (normC <= 1e-12) {
    b = sumS / normS;
  } else {
    const det = normC * normS - cross * cross;
    if (Math.abs(det) > 1e-12) {
      a = (sumC * normS - sumS * cross) / det;
      b = (sumS * normC - sumC * cross) / det;
    }
  }
  return Math.hypot(a, b);
}

interface StageMetrics {
  label: string;
  key: string;
  width: number;
  height: number;
  highPassRms: number;
  highPassRetention: number | null;
  lineMeanContrast: number | null;
  lineRetention: number | null;
  lines: LineMeasurement[] | null;
  fundamentalAmplitude: number | null;
  fundamentalRetention: number | null;
}

function safeRatio(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 1e-9) {
    return Number.NaN;
  }
  return numerator / denominator;
}

function measureChain(
  stages: GpuRealChainStage[],
  stimulus: StimulusDef,
): StageMetrics[] {
  const metrics: StageMetrics[] = stages.map((stage) => {
    const highPass = highPassRms(stage, stimulus.roi);
    const lineStats = stimulus.lines ? measureLines(stage, stimulus.lines) : null;
    return {
      label: stage.label,
      key: stage.key,
      width: stage.width,
      height: stage.height,
      highPassRms: highPass,
      highPassRetention: null,
      lineMeanContrast: lineStats ? lineStats.meanContrast : null,
      lineRetention: null,
      lines: lineStats ? lineStats.perLine : null,
      fundamentalAmplitude: stimulus.fundamental ? fundamentalAmplitude(stage) : null,
      fundamentalRetention: null,
    };
  });

  const source = metrics[0];
  for (let i = 1; i < metrics.length; i += 1) {
    const metric = metrics[i];
    metric.highPassRetention = safeRatio(metric.highPassRms, source.highPassRms);
    if (metric.lineMeanContrast !== null && source.lineMeanContrast !== null) {
      metric.lineRetention = safeRatio(metric.lineMeanContrast, source.lineMeanContrast);
    }
    if (metric.fundamentalAmplitude !== null && source.fundamentalAmplitude !== null) {
      metric.fundamentalRetention = safeRatio(
        metric.fundamentalAmplitude,
        source.fundamentalAmplitude,
      );
    }
  }
  return metrics;
}

function dominantSuppressor(
  metrics: StageMetrics[],
  selector: (metric: StageMetrics) => number | null,
): { label: string; attenuation: number } {
  let best = { label: 'none', attenuation: 0 };
  for (const metric of metrics) {
    const retention = selector(metric);
    if (retention === null || !Number.isFinite(retention)) continue;
    const attenuation = 1 - retention;
    if (attenuation > best.attenuation) best = { label: metric.label, attenuation };
  }
  return best;
}

function assertNotDegenerate(stage: GpuRealChainStage, label: string): void {
  expect(stage.data.length, `${label} length`).toBe(stage.width * stage.height * 4);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let finite = true;
  for (const value of stage.data) {
    if (!Number.isFinite(value)) finite = false;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  expect(finite, `${label} finite`).toBe(true);
  expect(max - min, `${label} is not constant`).toBeGreaterThan(1e-4);
}

const IDENTITY_PREFLIGHT_WGSL = `
@group(0) @binding(0) var tex_in: texture_2d<f32>;
@group(0) @binding(1) var tex_out: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8, 8)
fn computeMain(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(tex_out);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }
  textureStore(tex_out, vec2i(gid.xy), textureLoad(tex_in, vec2i(gid.xy), 0));
}
`;

function formatTable(metrics: StageMetrics[], stimulus: StimulusDef): string[] {
  const lines: string[] = [];
  lines.push(
    '[gpu] stage            dims        hpRMS     hpRet   lineCon   lineRet   fund     fundRet',
  );
  for (const metric of metrics) {
    const dims = `${metric.width}x${metric.height}`;
    const hpRet =
      metric.highPassRetention === null ? '-' : metric.highPassRetention.toFixed(4);
    const lineCon =
      metric.lineMeanContrast === null ? '-' : metric.lineMeanContrast.toFixed(4);
    const lineRet = metric.lineRetention === null ? '-' : metric.lineRetention.toFixed(4);
    const fund =
      metric.fundamentalAmplitude === null ? '-' : metric.fundamentalAmplitude.toFixed(5);
    const fundRet =
      metric.fundamentalRetention === null ? '-' : metric.fundamentalRetention.toFixed(4);
    lines.push(
      `[gpu] ${metric.label.padEnd(16)} ${dims.padEnd(11)} ${metric.highPassRms
        .toFixed(5)
        .padStart(8)}  ${hpRet.padStart(7)}  ${lineCon.padStart(8)}  ${lineRet.padStart(
        7,
      )}  ${fund.padStart(7)}  ${fundRet.padStart(8)}`,
    );
  }
  if (!stimulus.lines && !stimulus.fundamental) {
    lines.push('[gpu] (no line-contrast / fundamental columns for this stimulus)');
  }
  return lines;
}

let server: Server | undefined;
let origin = '';
let preflight: Awaited<ReturnType<typeof runGpuCase>> | null = null;

test.beforeAll(async ({ browser }) => {
  const started = await startSecureOrigin();
  server = started.server;
  origin = started.origin;

  const page = await browser.newPage();
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    preflight = await runGpuCase(page, {
      wgsl: IDENTITY_PREFLIGHT_WGSL,
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
      `[gpu] chain-ablation-faint preflight OK; adapter=${preflight.adapterInfo} software=${preflight.software}`,
    );
  } else {
    console.warn(
      `[gpu] chain-ablation-faint preflight FAILED (${preflight.kind}): ${preflight.error}`,
    );
  }
});

test.afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve) => {
      server!.close(() => resolve());
    });
  }
});

test('faint / oblique / texture detail: real-chain vs resampler-only vs CNN-only attribution', async ({
  page,
}) => {
  // 7 stimuli x 3 chains; the full chain alone is ~10 s under SwiftShader.
  test.setTimeout(1_200_000);

  guardGpu(preflight, 'faint chain ablation');

  const report: Record<string, unknown> = {};
  let adapter: { info: string; software: boolean } | null = null;

  for (const stimulus of STIMULI) {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    const chainReports: Record<string, unknown> = {};

    for (const chain of CHAINS) {
      const startedAt = Date.now();
      const result = await runGpuRealChainAblation(page, {
        srcWidth: SRC_WIDTH,
        srcHeight: SRC_HEIGHT,
        stimulus: stimulus.build(),
        stages: chain.stages,
        clampHighlights: CLAMP_HIGHLIGHTS,
      });
      const elapsedMs = Date.now() - startedAt;

      if (!result.ok) {
        guardGpu(result, `faint chain ablation (${stimulus.name}/${chain.name})`);
        throw new Error(
          `faint chain ablation failed (${result.kind}): ${result.error} [${stimulus.name}/${chain.name}]`,
        );
      }

      adapter = { info: result.adapterInfo, software: result.software };

      const expectedDims = resolveExpectedDims(chain.stages);
      expect(result.stages.length, `${stimulus.name}/${chain.name}: stage count`).toBe(
        expectedDims.length,
      );
      result.stages.forEach((stage, index) => {
        expect(stage.width, `${stimulus.name}/${chain.name}: stage ${index} width`).toBe(
          expectedDims[index].width,
        );
        expect(stage.height, `${stimulus.name}/${chain.name}: stage ${index} height`).toBe(
          expectedDims[index].height,
        );
        assertNotDegenerate(stage, `${stimulus.name}/${chain.name}: ${stage.label}`);
      });

      const metrics = measureChain(result.stages, stimulus);
      const finalMetric = metrics[metrics.length - 1];

      console.log(
        `\n[gpu] faint ablation: stimulus=${stimulus.name} chain=${chain.name} (${elapsedMs} ms)`,
      );
      console.log(`[gpu] adapter=${result.adapterInfo} software=${result.software}`);
      for (const line of formatTable(metrics, stimulus)) console.log(line);
      console.log(
        `[gpu] finalRetention: hp=${finalMetric.highPassRetention?.toFixed(4) ?? '-'}`
          + ` line=${finalMetric.lineRetention?.toFixed(4) ?? '-'}`
          + ` fund=${finalMetric.fundamentalRetention?.toFixed(4) ?? '-'}`,
      );

      chainReports[chain.name] = {
        stages: metrics,
        elapsedMs,
        finalRetention: {
          highPass: finalMetric.highPassRetention,
          line: finalMetric.lineRetention,
          fundamental: finalMetric.fundamentalRetention,
        },
        dominantSuppressor: {
          highPass: dominantSuppressor(metrics, (metric) => metric.highPassRetention),
          line: dominantSuppressor(metrics, (metric) => metric.lineRetention),
          fundamental: dominantSuppressor(metrics, (metric) => metric.fundamentalRetention),
        },
      };
    }

    report[stimulus.name] = {
      stimulus: {
        roi: stimulus.roi,
        hasLines: stimulus.lines !== null,
        fundamental: stimulus.fundamental,
      },
      chains: chainReports,
    };
  }

  const reportDir = path.resolve(__dirname, '..', '..', 'test-results', 'chain-ablation-real');
  mkdirSync(reportDir, { recursive: true });
  const payload = {
    description:
      'Faint / oblique / texture detail ablation of the real Mode A+A/Ultra chain vs '
      + 'CNN-only and Downscale-only controls, at 1/10 scale (192x108)',
    srcWidth: SRC_WIDTH,
    srcHeight: SRC_HEIGHT,
    grey: GREY,
    deltas: { faint10: DELTA10, faint4: DELTA4, texture: DELTA6 },
    clampHighlights: CLAMP_HIGHLIGHTS,
    chains: CHAINS.map((chain) => ({ name: chain.name, stages: chain.stages })),
    adapter,
    stimuli: report,
    caveats: [
      'The full chain is 1.333x the source resolution (192->384->256); dscOnly is 0.667x '
        + '(192->128). High-pass RMS retention across different output resolutions mixes the '
        + 'resampler/upscaler spreading effect with genuine CNN attenuation, so the cleanest '
        + 'single-stage evidence is the same-resolution CNNUL#1 row (192x108 -> 192x108).',
      'The period-2 sinusoid and the 1-px checkerboard sit at the source Nyquist limit; the '
        + 'dscOnly 1.5 downscale necessarily aliases them, so dscOnly is not a like-for-like '
        + 'resampler control for those two stimuli.',
      'ClampHighlightsApply was skipped (transparent at this scale in the prior run, ret 0.99).',
      'The learned CNN is data-dependent, so a synthetic 1-px stimulus only bounds its '
        + 'behavior; the real wing membrane may differ.',
    ],
  };
  const reportPath = path.join(reportDir, 'faint-report.json');
  writeFileSync(reportPath, JSON.stringify(payload, null, 2));
  console.log(`[gpu] wrote ${reportPath}`);
});
