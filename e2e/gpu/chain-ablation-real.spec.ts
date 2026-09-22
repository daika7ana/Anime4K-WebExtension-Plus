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
 * TEST-ONLY end-to-end ablation of the REAL Mode A+A / Ultra chain.
 *
 * The sibling `chain-ablation.spec.ts` ran the hard-coded `CNNx2M -> Downscale`
 * pair and measured only ~6% net loss, so the reported ~76% loss of 1-px
 * thin-line contrast must come from the U-variant restore/upscale CNNs. This
 * spec runs the actual emitted chain at 1/10 scale (192x108 -> 2K analogue) and
 * attributes the fine-detail loss per stage:
 *
 *   source 192x108
 *     -> CNNUL#1   (same)   192x108
 *     -> CNNx2UL   (x2)     384x216
 *     -> Downscale (1.5)    256x144
 *     -> CNNUL#2   (same)   256x144
 *     -> CNNUL#3   (same)   256x144
 *     -> ClampHighlightsApply (deferred, same dims)
 *
 * Confirmed against the extension: `effect-chain-templates.ts` A+A / ultra is
 * `[ClampHighlights, CNNUL, CNNx2UL, CNNUL, CNNx2UL, CNNUL, CNNx2VL]` and the
 * `effect-chain.ts` planner (upscale-target branch, since 2K width > 1080p
 * width) retains the first x2 at index 2, suppresses every later upscaler and
 * emits exactly one target-exact Downscale right after it; trailing scale-1
 * CNNULs run at the target, then the deferred ClampHighlights epilogue is
 * materialized last (`effect-chain-compiler.ts`).
 *
 * Stimuli: (a) three 1-px dark vertical lines at src x = 64/96/128; (b) a
 * period-8 single-px line train (the 2-10 px band), with a period-4 variant
 * reported too. `contrast = surround_mean - line_min`, min searched within
 * +/-3 px of the stage-scaled expected x. Only sanity is asserted (dims,
 * finite, non-degenerate); the contrast/retention numbers are reported, not
 * gated. No production `src/**` is touched.
 */

const SRC_WIDTH = 192;
const SRC_HEIGHT = 108;

const GREY = 0.5; // gamma-encoded mid-grey DC
const DARK = 0.2; // gamma-encoded 1-px line value

const SEARCH_RADIUS = 3; // px, search window for the line minimum
const SURROUND_INNER = 6; // px, inner edge of the surround band (exclusive)
const SURROUND_OUTER = 10; // px, outer edge of the surround band (inclusive)
const ROW_MARGIN = 8; // px, excluded top/bottom rows

const CLAMP_HIGHLIGHTS = true;

/**
 * The real emitted chain, in execution order, expressed as dimension
 * behaviours. `same` = restore (CNNUL), `scale` = upscale (CNNx2UL), and the
 * library `Downscale` carries the exact target-exact dimensions.
 */
const REAL_CHAIN: RealChainStageSpec[] = [
  { kind: 'effect', label: 'CNNUL#1', key: 'CNNUL', behavior: { kind: 'same' } },
  { kind: 'effect', label: 'CNNx2UL', key: 'CNNx2UL', behavior: { kind: 'scale', scale: 2 } },
  { kind: 'downscale', label: 'Downscale', width: 256, height: 144 },
  { kind: 'effect', label: 'CNNUL#2', key: 'CNNUL', behavior: { kind: 'same' } },
  { kind: 'effect', label: 'CNNUL#3', key: 'CNNUL', behavior: { kind: 'same' } },
];

interface Stimulus {
  name: string;
  lineX: number[];
  build: () => number[];
}

/** Multiples of `period` in the interior [16, SRC_WIDTH - 16]. */
function lineTrain(period: number): number[] {
  const lines: number[] = [];
  for (let x = 16; x <= SRC_WIDTH - 16; x += period) lines.push(x);
  return lines;
}

const SPARSE_1PX = [64, 96, 128];
const TRAIN_8PX = lineTrain(8);
const TRAIN_4PX = lineTrain(4);

/** Gamma-encoded RGBA stimulus with 1-px dark lines at `lineX`, full height. */
function buildStimulus(lineX: number[]): number[] {
  const lineSet = new Set(lineX);
  const pixels: number[] = [];
  for (let y = 0; y < SRC_HEIGHT; y += 1) {
    for (let x = 0; x < SRC_WIDTH; x += 1) {
      const value = lineSet.has(x) ? DARK : GREY;
      pixels.push(value, value, value, 1);
    }
  }
  return pixels;
}

const STIMULI: Stimulus[] = [
  { name: 'sparse-1px', lineX: SPARSE_1PX, build: () => buildStimulus(SPARSE_1PX) },
  { name: 'train-8px', lineX: TRAIN_8PX, build: () => buildStimulus(TRAIN_8PX) },
  { name: 'train-4px', lineX: TRAIN_4PX, build: () => buildStimulus(TRAIN_4PX) },
];

/**
 * Resolve the expected output dimensions of every readback stage (source
 * first) from the stage behaviours. `clampHighlights` appends the deferred
 * apply at the tail at the final stage's dimensions.
 */
function resolveExpectedDims(): Array<{ width: number; height: number }> {
  const dims = [{ width: SRC_WIDTH, height: SRC_HEIGHT }];
  let width = SRC_WIDTH;
  let height = SRC_HEIGHT;
  for (const stage of REAL_CHAIN) {
    if (stage.kind === 'downscale') {
      width = stage.width;
      height = stage.height;
    } else if (stage.behavior.kind === 'scale') {
      width *= stage.behavior.scale;
      height *= stage.behavior.scale;
    }
    dims.push({ width, height });
  }
  if (CLAMP_HIGHLIGHTS) dims.push({ width, height });
  return dims;
}

interface LineMeasurement {
  srcX: number;
  expectedX: number;
  lineMin: number;
  surroundMean: number;
  contrast: number;
}

interface StageMeasurement {
  label: string;
  key: string;
  width: number;
  height: number;
  lines: LineMeasurement[];
  meanContrast: number;
  /** meanContrast / previous stage's meanContrast; null for the source. */
  retention: number | null;
  /** 1 - retention; null for the source. */
  attenuation: number | null;
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

/** Rec. 709 luma from the first three channels of a row-major RGBA float image. */
function luma(stage: GpuRealChainStage, x: number, y: number): number {
  const index = (y * stage.width + x) * 4;
  return (
    0.2126 * stage.data[index] + 0.7152 * stage.data[index + 1] + 0.0722 * stage.data[index + 2]
  );
}

function assertNotDegenerate(stage: GpuRealChainStage, label: string): void {
  expect(stage.data.length, `${label} length`).toBe(stage.width * stage.height * 4);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let finite = true;
  for (let i = 0; i < stage.data.length; i += 1) {
    const value = stage.data[i];
    if (!Number.isFinite(value)) finite = false;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  expect(finite, `${label} finite`).toBe(true);
  expect(max - min, `${label} is not constant`).toBeGreaterThan(1e-4);
}

/**
 * Generalized `measureStage`: identical surround/min logic, but the expected x
 * is scaled by `stage.width / SRC_WIDTH` so any stage size is measured.
 */
function measureStage(stage: GpuRealChainStage, lineX: number[]): StageMeasurement {
  const top = ROW_MARGIN;
  const bottom = stage.height - ROW_MARGIN;
  const lines: LineMeasurement[] = [];

  for (const srcX of lineX) {
    const expectedX = srcX * (stage.width / SRC_WIDTH);
    const center = Math.round(expectedX);
    const searchLo = Math.max(0, Math.floor(expectedX) - SEARCH_RADIUS);
    const searchHi = Math.min(stage.width - 1, Math.ceil(expectedX) + SEARCH_RADIUS);

    let lineMin = Number.POSITIVE_INFINITY;
    let surroundSum = 0;
    let surroundCount = 0;

    for (let y = top; y < bottom; y += 1) {
      for (let x = searchLo; x <= searchHi; x += 1) {
        lineMin = Math.min(lineMin, luma(stage, x, y));
      }
      for (let d = SURROUND_INNER; d <= SURROUND_OUTER; d += 1) {
        for (const x of [center - d, center + d]) {
          if (x >= 0 && x < stage.width) {
            surroundSum += luma(stage, x, y);
            surroundCount += 1;
          }
        }
      }
    }

    const surroundMean = surroundCount > 0 ? surroundSum / surroundCount : Number.NaN;
    lines.push({ srcX, expectedX, lineMin, surroundMean, contrast: surroundMean - lineMin });
  }

  const meanContrast = lines.reduce((acc, line) => acc + line.contrast, 0) / lines.length;
  return {
    label: stage.label,
    key: stage.key,
    width: stage.width,
    height: stage.height,
    lines,
    meanContrast,
    retention: null,
    attenuation: null,
  };
}

function safeRatio(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 1e-9) {
    return Number.NaN;
  }
  return numerator / denominator;
}

function measureChain(stages: GpuRealChainStage[], lineX: number[]): StageMeasurement[] {
  const measurements = stages.map((stage) => measureStage(stage, lineX));
  for (let i = 1; i < measurements.length; i += 1) {
    const retention = safeRatio(measurements[i].meanContrast, measurements[i - 1].meanContrast);
    measurements[i].retention = retention;
    measurements[i].attenuation = Number.isFinite(retention) ? 1 - retention : Number.NaN;
  }
  return measurements;
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
      `[gpu] chain-ablation-real preflight OK; adapter=${preflight.adapterInfo} software=${preflight.software}`,
    );
  } else {
    console.warn(
      `[gpu] chain-ablation-real preflight FAILED (${preflight.kind}): ${preflight.error}`,
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

test('1080p->2K Mode A+A Ultra: real-chain per-stage fine-detail attribution', async ({
  page,
}) => {
  // Two CNNULs + CNNx2UL under SwiftShader are heavy; allow the full sweep.
  test.setTimeout(600_000);

  guardGpu(preflight, 'real chain ablation');
  const expectedDims = resolveExpectedDims();

  const stimuliReport: Record<string, unknown> = {};
  let adapter: { info: string; software: boolean } | null = null;

  for (const stimulus of STIMULI) {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    const result = await runGpuRealChainAblation(page, {
      srcWidth: SRC_WIDTH,
      srcHeight: SRC_HEIGHT,
      stimulus: stimulus.build(),
      stages: REAL_CHAIN,
      clampHighlights: CLAMP_HIGHLIGHTS,
    });

    if (!result.ok) {
      guardGpu(result, `real chain ablation (${stimulus.name})`);
      throw new Error(`real chain ablation failed (${result.kind}): ${result.error}`);
    }

    adapter = { info: result.adapterInfo, software: result.software };

    // -- Sanity only -------------------------------------------------------
    expect(result.stages.length, `${stimulus.name}: stage count`).toBe(expectedDims.length);
    result.stages.forEach((stage, index) => {
      expect(stage.width, `${stimulus.name}: stage ${index} width`).toBe(
        expectedDims[index].width,
      );
      expect(stage.height, `${stimulus.name}: stage ${index} height`).toBe(
        expectedDims[index].height,
      );
      assertNotDegenerate(stage, `${stimulus.name}: ${stage.label}`);
    });

    // -- Measurement -------------------------------------------------------
    const measurements = measureChain(result.stages, stimulus.lineX);
    const sourceMean = measurements[0].meanContrast;
    const finalMean = measurements[measurements.length - 1].meanContrast;
    const cumulativeRetention = safeRatio(finalMean, sourceMean);

    let dominant: { label: string; attenuation: number } = { label: 'none', attenuation: 0 };
    for (const measurement of measurements) {
      if (measurement.attenuation !== null && measurement.attenuation > dominant.attenuation) {
        dominant = { label: measurement.label, attenuation: measurement.attenuation };
      }
    }

    // -- Report ------------------------------------------------------------
    console.log(`\n[gpu] real chain ablation: stimulus=${stimulus.name} (${stimulus.lineX.length} lines)`);
    console.log(`[gpu] adapter=${result.adapterInfo} software=${result.software}`);
    console.log('[gpu] stage            dims        meanContrast  retention  attenuation');
    for (const measurement of measurements) {
      const dims = `${measurement.width}x${measurement.height}`;
      const retention =
        measurement.retention === null ? '     -' : measurement.retention.toFixed(4);
      const attenuation =
        measurement.attenuation === null ? '     -' : measurement.attenuation.toFixed(4);
      console.log(
        `[gpu] ${measurement.label.padEnd(16)} ${dims.padEnd(11)} ${measurement.meanContrast
          .toFixed(4)
          .padStart(8)}  ${retention.padStart(9)}  ${attenuation.padStart(11)}`,
      );
    }
    console.log(
      `[gpu] dominant=${dominant.label} (${(dominant.attenuation * 100).toFixed(1)}%)`
      + ` cumulativeRetention=${cumulativeRetention.toFixed(4)}`,
    );

    stimuliReport[stimulus.name] = {
      lineX: stimulus.lineX,
      meanContrastByStage: Object.fromEntries(
        measurements.map((measurement) => [measurement.label, measurement.meanContrast]),
      ),
      stages: measurements,
      dominantStage: dominant.label,
      dominantAttenuation: dominant.attenuation,
      cumulativeRetention,
    };
  }

  const reportDir = path.resolve(__dirname, '..', '..', 'test-results', 'chain-ablation-real');
  mkdirSync(reportDir, { recursive: true });
  const report = {
    description:
      'Real Mode A+A/Ultra 1080p->2K analogue at 1/10 scale: per-stage 1-px line-contrast attribution',
    srcWidth: SRC_WIDTH,
    srcHeight: SRC_HEIGHT,
    chain: REAL_CHAIN,
    clampHighlights: CLAMP_HIGHLIGHTS,
    expectedDims,
    adapter,
    stimuli: stimuliReport,
  };
  writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`[gpu] wrote ${path.join(reportDir, 'report.json')}`);
});
