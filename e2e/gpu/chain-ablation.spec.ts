import { mkdirSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  guardGpu,
  runGpuCase,
  runGpuChainAblation,
  startSecureOrigin,
  type GpuChainStage,
} from './downscale-harness';

/**
 * TEST-ONLY end-to-end chain ablation.
 *
 * Attributes the loss of 1-px vertical-line contrast in the 1080p -> 2K
 * Mode A+A Ultra chain to either the x2 CNN upscale (`CNNx2M`) or the
 * `Downscale` stage, by running the REAL library pipelines and reading back
 * the source, the CNN x2 intermediate and the final downscaled image.
 *
 * Geometry is 1/10th of native: 192x108 -> CNNx2M -> 384x216 -> Downscale ->
 * 256x144 (ratio exactly 1.5 on both axes, matching the real chain). The
 * stimulus is a mid-grey DC with three 1-px dark vertical lines at source
 * x = 64, 96, 128. Per line and per stage we measure
 * `contrast = surround_mean - line_min`, with the expected x scaled by each
 * stage's width and the min searched within +/-3 px of it.
 *
 * This spec only asserts sanity (shapes, dimensions, non-degenerate images);
 * the contrast numbers are reported, not gated. All arithmetic is float in
 * [0, 1]; nothing here touches production `src/**`.
 */

const SRC_WIDTH = 192;
const SRC_HEIGHT = 108;
const CNN_WIDTH = SRC_WIDTH * 2; // 384
const CNN_HEIGHT = SRC_HEIGHT * 2; // 216
const OUT_WIDTH = 256; // 384 / 256 = 1.5
const OUT_HEIGHT = 144; // 216 / 144 = 1.5

const GREY = 0.5; // gamma-encoded mid-grey DC
const DARK = 0.2; // gamma-encoded 1-px line value
const LINE_X = [64, 96, 128];

const SEARCH_RADIUS = 3; // px, search window for the line minimum
const SURROUND_INNER = 6; // px, inner edge of the surround band (exclusive)
const SURROUND_OUTER = 10; // px, outer edge of the surround band (inclusive)
const ROW_MARGIN = 8; // px, excluded top/bottom rows

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

interface LineMeasurement {
  srcX: number;
  expectedX: number;
  lineMin: number;
  surroundMean: number;
  contrast: number;
}

interface StageMeasurement {
  width: number;
  height: number;
  lines: LineMeasurement[];
  meanContrast: number;
}

let server: Server | undefined;
let origin = '';
let preflight: Awaited<ReturnType<typeof runGpuCase>> | null = null;

/** Gamma-encoded RGBA stimulus with 1-px dark lines at `LINE_X`, full height. */
function buildStimulus(): number[] {
  const lineSet = new Set(LINE_X);
  const pixels: number[] = [];
  for (let y = 0; y < SRC_HEIGHT; y += 1) {
    for (let x = 0; x < SRC_WIDTH; x += 1) {
      const value = lineSet.has(x) ? DARK : GREY;
      pixels.push(value, value, value, 1);
    }
  }
  return pixels;
}

/** Rec. 709 luma from the first three channels of a row-major RGBA float image. */
function luma(stage: GpuChainStage, x: number, y: number): number {
  const index = (y * stage.width + x) * 4;
  return (
    0.2126 * stage.data[index] + 0.7152 * stage.data[index + 1] + 0.0722 * stage.data[index + 2]
  );
}

function assertNotDegenerate(stage: GpuChainStage, label: string): void {
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

function measureStage(stage: GpuChainStage, sourceLineX: number[]): StageMeasurement {
  const top = ROW_MARGIN;
  const bottom = stage.height - ROW_MARGIN;
  const lines: LineMeasurement[] = [];

  for (const srcX of sourceLineX) {
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
  return { width: stage.width, height: stage.height, lines, meanContrast };
}

function safeRatio(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 1e-9) {
    return Number.NaN;
  }
  return numerator / denominator;
}

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
      `[gpu] chain-ablation preflight OK; adapter=${preflight.adapterInfo} software=${preflight.software}`,
    );
  } else {
    console.warn(`[gpu] chain-ablation preflight FAILED (${preflight.kind}): ${preflight.error}`);
  }
});

test.afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve) => {
      server!.close(() => resolve());
    });
  }
});

test('1080p->2K Mode A+A Ultra: CNN x2 vs Downscale line-contrast attribution', async ({
  page,
}) => {
  guardGpu(preflight, 'chain ablation');
  await page.goto(origin, { waitUntil: 'domcontentloaded' });

  const result = await runGpuChainAblation(page, {
    srcWidth: SRC_WIDTH,
    srcHeight: SRC_HEIGHT,
    outWidth: OUT_WIDTH,
    outHeight: OUT_HEIGHT,
    stimulus: buildStimulus(),
  });

  if (!result.ok) {
    guardGpu(result, 'chain ablation');
    throw new Error(`chain ablation failed (${result.kind}): ${result.error}`);
  }

  const { src, cnn, final: finalStage } = result;

  // -- Sanity only ---------------------------------------------------------
  expect(src.width, 'source width').toBe(SRC_WIDTH);
  expect(src.height, 'source height').toBe(SRC_HEIGHT);
  expect(cnn.width, 'CNN width').toBe(CNN_WIDTH);
  expect(cnn.height, 'CNN height').toBe(CNN_HEIGHT);
  expect(finalStage.width, 'final width').toBe(OUT_WIDTH);
  expect(finalStage.height, 'final height').toBe(OUT_HEIGHT);
  assertNotDegenerate(src, 'source');
  assertNotDegenerate(cnn, 'CNN output');
  assertNotDegenerate(finalStage, 'final output');

  // -- Measurement ---------------------------------------------------------
  const srcMeasure = measureStage(src, LINE_X);
  const cnnMeasure = measureStage(cnn, LINE_X);
  const finalMeasure = measureStage(finalStage, LINE_X);

  const cnnOverSrc = cnnMeasure.lines.map((line, index) =>
    safeRatio(line.contrast, srcMeasure.lines[index].contrast),
  );
  const finalOverSrc = finalMeasure.lines.map((line, index) =>
    safeRatio(line.contrast, srcMeasure.lines[index].contrast),
  );
  const finalOverCnn = finalMeasure.lines.map((line, index) =>
    safeRatio(line.contrast, cnnMeasure.lines[index].contrast),
  );

  const meanCnnOverSrc = safeRatio(cnnMeasure.meanContrast, srcMeasure.meanContrast);
  const meanFinalOverSrc = safeRatio(finalMeasure.meanContrast, srcMeasure.meanContrast);
  const meanFinalOverCnn = safeRatio(finalMeasure.meanContrast, cnnMeasure.meanContrast);

  // -- Report --------------------------------------------------------------
  console.log('\n[gpu] chain ablation: 192x108 -> CNNx2M 384x216 -> Downscale 256x144');
  console.log(`[gpu] adapter=${result.adapterInfo} software=${result.software}`);
  console.log('[gpu] line   stage   expectedX  lineMin  surround  contrast  retained');
  const stagesForLog: Array<[string, StageMeasurement, Array<number | null>]> = [
    ['src  ', srcMeasure, [1, 1, 1]],
    ['cnn  ', cnnMeasure, cnnOverSrc],
    ['final', finalMeasure, finalOverSrc],
  ];
  for (const [label, stageMeasure, retained] of stagesForLog) {
    stageMeasure.lines.forEach((line, index) => {
      const retention = retained[index];
      console.log(
        `[gpu] x=${String(line.srcX).padStart(3)} ${label}  ${line.expectedX
          .toFixed(2)
          .padStart(7)}  ${line.lineMin.toFixed(4)}  ${line.surroundMean.toFixed(4)}`
        + `  ${line.contrast.toFixed(4)}  ${retention === null ? 'null' : retention.toFixed(3)}`,
      );
    });
  }
  console.log(
    `[gpu] mean contrast: src=${srcMeasure.meanContrast.toFixed(4)}`
    + ` cnn=${cnnMeasure.meanContrast.toFixed(4)} final=${finalMeasure.meanContrast.toFixed(4)}`,
  );
  console.log(
    `[gpu] mean retained: cnn/src=${meanCnnOverSrc.toFixed(3)}`
    + ` final/src=${meanFinalOverSrc.toFixed(3)} final/cnn=${meanFinalOverCnn.toFixed(3)}`,
  );
  const attenuationCnn = 1 - meanCnnOverSrc;
  const attenuationDownscale = 1 - meanFinalOverCnn;
  console.log(
    `[gpu] attenuation: CNN=${(attenuationCnn * 100).toFixed(1)}%`
    + ` Downscale=${(attenuationDownscale * 100).toFixed(1)}%`
    + ` dominant=${attenuationCnn >= attenuationDownscale ? 'CNN x2' : 'Downscale'}`,
  );

  const reportDir = path.resolve(__dirname, '..', '..', 'test-results', 'chain-ablation');
  mkdirSync(reportDir, { recursive: true });
  const report = {
    stimulus: {
      srcWidth: SRC_WIDTH,
      srcHeight: SRC_HEIGHT,
      cnnWidth: CNN_WIDTH,
      cnnHeight: CNN_HEIGHT,
      outWidth: OUT_WIDTH,
      outHeight: OUT_HEIGHT,
      downscaleRatio: CNN_WIDTH / OUT_WIDTH,
      sourceScale: OUT_WIDTH / SRC_WIDTH,
      cnnScale: CNN_WIDTH / SRC_WIDTH,
      grey: GREY,
      dark: DARK,
      lineX: LINE_X,
    },
    adapter: { info: result.adapterInfo, software: result.software },
    dims: {
      src: { width: src.width, height: src.height },
      cnn: { width: cnn.width, height: cnn.height },
      final: { width: finalStage.width, height: finalStage.height },
    },
    stages: {
      src: srcMeasure,
      cnn: cnnMeasure,
      final: finalMeasure,
    },
    retained: {
      cnnOverSrc,
      finalOverSrc,
      finalOverCnn,
      meanCnnOverSrc,
      meanFinalOverSrc,
      meanFinalOverCnn,
      attenuationCnn,
      attenuationDownscale,
      dominant: attenuationCnn >= attenuationDownscale ? 'cnn' : 'downscale',
    },
  };
  writeFileSync(
    path.join(reportDir, 'report.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(`[gpu] wrote ${path.join(reportDir, 'report.json')}`);
});
