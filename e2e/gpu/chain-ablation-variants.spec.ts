import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
 * TEST-ONLY variant sweep on top of `chain-ablation-faint.spec.ts`.
 *
 * Prior result: the real A+A / Ultra chain suppresses faint coherent detail by
 * 76-97 %, and the largest single attacker is the scale-1 `CNNUL` restore at
 * identical dimensions (faint 1-px d10/255 line retention 0.599; d4 0.488;
 * period-2 +/-6/255 fundamental 0.354). This spec asks which chain shape best
 * restores that detail without overshoot or noise amplification.
 *
 * Variants (all through the real `runGpuRealChainAblation`):
 *   V1  full              CNNUL -> CNNx2UL -> Downscale -> CNNUL -> CNNUL
 *   V2  no-tail-restores  CNNUL -> CNNx2UL -> Downscale
 *   V3  no-restores       CNNx2UL -> Downscale
 *   V4  no-head-restore   CNNx2UL -> Downscale -> CNNUL -> CNNUL
 *   V5  m-full            CNNM  -> CNNx2M  -> Downscale -> CNNM  -> CNNM
 *   V6  m-no-tail         CNNM  -> CNNx2M  -> Downscale
 *   V7  downscale-only    Downscale (floor control)
 *   V8  full + CAS(0.30)  V1 then the SHIPPED `src/shaders/cas.wgsl`
 *   V9  full + CAS(0.60)  V1 then the SHIPPED `src/shaders/cas.wgsl`
 *
 * V8/V9 use the extension's shipped CAS (not a test-local unsharp): the WGSL
 * is read verbatim from `src/shaders/cas.wgsl` and fed through the harness's
 * new test-only `postSharpen` hook, which binds a `[sharpness, 0]` uniform and
 * reads the rgba8unorm CAS output back (the same output format the extension
 * uses).
 *
 * Metrics reuse the faint spec (line-min contrast, 3x3 high-pass luma RMS,
 * Nyquist-correct float-DFT fundamental) and add artifact metrics:
 *   - step ringing: max overshoot/undershoot as % of a 0.3 step, using local
 *     plateaus to cancel the CNN's DC shift;
 *   - noise amplification: texture high-pass retention, plus the ratio vs V1;
 *   - faint-line peak luma excursion (halo check).
 *
 * Checkerboard was trimmed to bound runtime (the 1-px white-noise texture is
 * the noise-amplification control). Sanity only is asserted; numbers are
 * reported. No production `src/**`, packaging, or commits.
 */

const SRC_WIDTH = 192;
const SRC_HEIGHT = 108;

const GREY = 128 / 255;
const DELTA10 = 10 / 255;
const DELTA4 = 4 / 255;
const DELTA6 = 6 / 255;
const STEP_AMPLITUDE = 0.3;

const SEARCH_RADIUS = 3;
const SURROUND_INNER = 6;
const SURROUND_OUTER = 10;
const ROW_MARGIN = 8;

const CAS_WGSL = readFileSync(
  path.resolve(__dirname, '..', '..', 'src', 'shaders', 'cas.wgsl'),
  'utf8',
);

// ---------------------------------------------------------------------------
// Chains / variants
// ---------------------------------------------------------------------------

const D = (width: number, height: number): RealChainStageSpec => ({
  kind: 'downscale',
  label: 'Downscale',
  width,
  height,
});
const E = (
  label: string,
  key: string,
  scale: number | null,
): RealChainStageSpec => ({
  kind: 'effect',
  label,
  key,
  behavior: scale === null ? { kind: 'same' } : { kind: 'scale', scale },
});

interface VariantDef {
  id: string;
  label: string;
  stages: RealChainStageSpec[];
  postSharpen?: { kind: 'cas'; sharpness: number; wgsl: string };
}

const V1_STAGES: RealChainStageSpec[] = [
  E('CNNUL#1', 'CNNUL', null),
  E('CNNx2UL', 'CNNx2UL', 2),
  D(256, 144),
  E('CNNUL#2', 'CNNUL', null),
  E('CNNUL#3', 'CNNUL', null),
];

const VARIANTS: VariantDef[] = [
  { id: 'V1', label: 'full', stages: V1_STAGES },
  {
    id: 'V2',
    label: 'no-tail-restores',
    stages: [E('CNNUL#1', 'CNNUL', null), E('CNNx2UL', 'CNNx2UL', 2), D(256, 144)],
  },
  {
    id: 'V3',
    label: 'no-restores',
    stages: [E('CNNx2UL', 'CNNx2UL', 2), D(256, 144)],
  },
  {
    id: 'V4',
    label: 'no-head-restore',
    stages: [
      E('CNNx2UL', 'CNNx2UL', 2),
      D(256, 144),
      E('CNNUL#2', 'CNNUL', null),
      E('CNNUL#3', 'CNNUL', null),
    ],
  },
  {
    id: 'V5',
    label: 'm-full',
    stages: [
      E('CNNM#1', 'CNNM', null),
      E('CNNx2M', 'CNNx2M', 2),
      D(256, 144),
      E('CNNM#2', 'CNNM', null),
      E('CNNM#3', 'CNNM', null),
    ],
  },
  {
    id: 'V6',
    label: 'm-no-tail',
    stages: [E('CNNM#1', 'CNNM', null), E('CNNx2M', 'CNNx2M', 2), D(256, 144)],
  },
  { id: 'V7', label: 'downscale-only', stages: [D(128, 72)] },
  {
    id: 'V8',
    label: 'full + CAS(0.30)',
    stages: V1_STAGES,
    postSharpen: { kind: 'cas', sharpness: 0.3, wgsl: CAS_WGSL },
  },
  {
    id: 'V9',
    label: 'full + CAS(0.60)',
    stages: V1_STAGES,
    postSharpen: { kind: 'cas', sharpness: 0.6, wgsl: CAS_WGSL },
  },
];

function resolveExpectedDims(
  variant: VariantDef,
): Array<{ width: number; height: number }> {
  const dims = [{ width: SRC_WIDTH, height: SRC_HEIGHT }];
  let width = SRC_WIDTH;
  let height = SRC_HEIGHT;
  for (const stage of variant.stages) {
    if (stage.kind === 'downscale') {
      width = stage.width;
      height = stage.height;
    } else if (stage.behavior.kind === 'scale') {
      width = Math.round(width * stage.behavior.scale);
      height = Math.round(height * stage.behavior.scale);
    }
    dims.push({ width, height });
  }
  if (variant.postSharpen) dims.push({ width, height });
  return dims;
}

// ---------------------------------------------------------------------------
// Stimuli
// ---------------------------------------------------------------------------

interface Roi {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const DEFAULT_ROI: Roi = { x0: 8, y0: 8, x1: SRC_WIDTH - 8, y1: SRC_HEIGHT - 8 };
const PATCH_ROI: Roi = { x0: 48, y0: 27, x1: 144, y1: 81 };

interface LineSpec {
  x0: number;
  y0: number;
  cot: number | null;
}

interface StimulusDef {
  name: string;
  build: () => number[];
  lines: LineSpec[] | null;
  roi: Roi;
  fundamental: boolean;
  step: boolean;
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
          if (Math.abs(a * x + b * y + c) / Math.hypot(a, b) <= 0.5) on = true;
        }
        if (on) break;
      }
      const value = on ? GREY - delta : GREY;
      pixels.push(value, value, value, 1);
    }
  }
  return pixels;
}

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

function buildSinusoid(delta: number): number[] {
  const pixels: number[] = [];
  for (let y = 0; y < SRC_HEIGHT; y += 1) {
    for (let x = 0; x < SRC_WIDTH; x += 1) {
      // Period-2 (Nyquist); cos() avoids the all-zero sin(pi*x) trap.
      const value = GREY + delta * Math.cos(Math.PI * x);
      pixels.push(value, value, value, 1);
    }
  }
  return pixels;
}

function buildStep(amplitude: number): number[] {
  const left = GREY - amplitude / 2;
  const right = GREY + amplitude / 2;
  const pixels: number[] = [];
  for (let y = 0; y < SRC_HEIGHT; y += 1) {
    for (let x = 0; x < SRC_WIDTH; x += 1) {
      const value = x < SRC_WIDTH / 2 ? left : right;
      pixels.push(value, value, value, 1);
    }
  }
  return pixels;
}

const VERTICAL_X = [64, 96, 128];
const OBLIQUE_COT_45 = 1;
const OBLIQUE_COT_30 = 1 / Math.tan(Math.PI / 6);

const STIMULI: StimulusDef[] = [
  {
    name: 'faint-vertical-10of255',
    build: () => buildVerticalLines(VERTICAL_X, DELTA10),
    lines: VERTICAL_X.map((x0) => ({ x0, y0: 0, cot: null })),
    roi: DEFAULT_ROI,
    fundamental: false,
    step: false,
  },
  {
    name: 'faint-vertical-4of255',
    build: () => buildVerticalLines(VERTICAL_X, DELTA4),
    lines: VERTICAL_X.map((x0) => ({ x0, y0: 0, cot: null })),
    roi: DEFAULT_ROI,
    fundamental: false,
    step: false,
  },
  {
    name: 'oblique-45deg-10of255',
    build: () =>
      buildObliqueLines(
        [64, 96, 128].map((x0) => ({ x0, y0: SRC_HEIGHT / 2, cot: OBLIQUE_COT_45 })),
        DELTA10,
      ),
    lines: [64, 96, 128].map((x0) => ({ x0, y0: SRC_HEIGHT / 2, cot: OBLIQUE_COT_45 })),
    roi: DEFAULT_ROI,
    fundamental: false,
    step: false,
  },
  {
    name: 'oblique-30deg-10of255',
    build: () =>
      buildObliqueLines(
        [80, 96, 112].map((x0) => ({ x0, y0: SRC_HEIGHT / 2, cot: OBLIQUE_COT_30 })),
        DELTA10,
      ),
    lines: [80, 96, 112].map((x0) => ({ x0, y0: SRC_HEIGHT / 2, cot: OBLIQUE_COT_30 })),
    roi: DEFAULT_ROI,
    fundamental: false,
    step: false,
  },
  {
    name: 'texture-patch-6of255',
    build: () => buildTexture(0x9e3779b9, DELTA6),
    lines: null,
    roi: PATCH_ROI,
    fundamental: false,
    step: false,
  },
  {
    name: 'sinusoid-period2-6of255',
    build: () => buildSinusoid(DELTA6),
    lines: null,
    roi: DEFAULT_ROI,
    fundamental: true,
    step: false,
  },
  {
    name: 'step-0.3',
    build: () => buildStep(STEP_AMPLITUDE),
    lines: null,
    roi: DEFAULT_ROI,
    fundamental: false,
    step: true,
  },
];

// ---------------------------------------------------------------------------
// Measurement (shared logic with chain-ablation-faint.spec.ts)
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

function measureLines(stage: GpuRealChainStage, lines: LineSpec[]): LineMeasurement[] {
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
      const expectedSrcX = line.cot === null ? line.x0 : line.x0 + (srcY - line.y0) * line.cot;
      const expectedStageX = expectedSrcX * sx;
      if (expectedStageX < 1 || expectedStageX > stage.width - 2) continue;
      const center = Math.round(expectedStageX);
      const lo = Math.max(0, Math.floor(expectedStageX) - SEARCH_RADIUS);
      const hi = Math.min(stage.width - 1, Math.ceil(expectedStageX) + SEARCH_RADIUS);
      for (let x = lo; x <= hi; x += 1) lineMin = Math.min(lineMin, luma(stage, x, ys));
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
  return perLine;
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

function highPassRms(stage: GpuRealChainStage, roi: Roi): number {
  const scaled = scaleRoi(roi, stage);
  let sum = 0;
  let count = 0;
  for (let y = scaled.y0 + 1; y < scaled.y1 - 1; y += 1) {
    for (let x = scaled.x0 + 1; x < scaled.x1 - 1; x += 1) {
      let blur = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) blur += luma(stage, x + dx, y + dy);
      }
      blur /= 9;
      const diff = luma(stage, x, y) - blur;
      sum += diff * diff;
      count += 1;
    }
  }
  return count > 0 ? Math.sqrt(sum / count) : Number.NaN;
}

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
  const frequency = SRC_WIDTH / 2 / width;

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

/**
 * Max overshoot/undershoot as a percentage of the 0.3 step, measured against
 * the local plateaus (which cancels any CNN DC shift). Searches +/-12 px of the
 * expected edge and samples plateaus +/-18..30 px out.
 */
function stepRingingPct(stage: GpuRealChainStage): number {
  const scale = stage.width / SRC_WIDTH;
  const edge = (SRC_WIDTH / 2) * scale;
  const sy = stage.height / SRC_HEIGHT;
  const top = Math.max(0, Math.floor(ROW_MARGIN * sy));
  const bottom = Math.min(stage.height, Math.ceil((SRC_HEIGHT - ROW_MARGIN) * sy));
  const leftPlateau0 = Math.max(1, Math.floor(edge) - 30);
  const leftPlateau1 = Math.max(1, Math.floor(edge) - 18);
  const rightPlateau0 = Math.min(stage.width - 2, Math.ceil(edge) + 18);
  const rightPlateau1 = Math.min(stage.width - 2, Math.ceil(edge) + 30);

  let leftSum = 0;
  let leftN = 0;
  let rightSum = 0;
  let rightN = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = leftPlateau0; x < leftPlateau1; x += 1) {
      leftSum += luma(stage, x, y);
      leftN += 1;
    }
    for (let x = rightPlateau0; x < rightPlateau1; x += 1) {
      rightSum += luma(stage, x, y);
      rightN += 1;
    }
  }
  if (leftN === 0 || rightN === 0) return Number.NaN;
  const plateauL = leftSum / leftN;
  const plateauR = rightSum / rightN;
  const step = plateauR - plateauL;
  if (!(Math.abs(step) > 1e-6)) return Number.NaN;

  const searchL0 = Math.max(0, Math.floor(edge) - 12);
  const searchL1 = Math.max(0, Math.floor(edge) - 1);
  const searchR0 = Math.min(stage.width - 1, Math.ceil(edge) + 1);
  const searchR1 = Math.min(stage.width - 1, Math.ceil(edge) + 12);

  let maxRight = Number.NEGATIVE_INFINITY;
  let minLeft = Number.POSITIVE_INFINITY;
  for (let y = top; y < bottom; y += 1) {
    for (let x = searchR0; x <= searchR1; x += 1) maxRight = Math.max(maxRight, luma(stage, x, y));
    for (let x = searchL0; x <= searchL1; x += 1) minLeft = Math.min(minLeft, luma(stage, x, y));
  }
  const overshoot = (maxRight - plateauR) / step;
  const undershoot = (plateauL - minLeft) / step;
  return Math.max(0, Math.max(overshoot, undershoot)) * 100;
}

function peakExcursion(stage: GpuRealChainStage, roi: Roi): number {
  const scaled = scaleRoi(roi, stage);
  let peak = 0;
  for (let y = scaled.y0; y < scaled.y1; y += 1) {
    for (let x = scaled.x0; x < scaled.x1; x += 1) {
      peak = Math.max(peak, Math.abs(luma(stage, x, y) - GREY));
    }
  }
  return peak;
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
  stepRingingPct: number | null;
  peakExcursion: number | null;
  peakExcursionRetention: number | null;
}

function safeRatio(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 1e-9) {
    return Number.NaN;
  }
  return numerator / denominator;
}

function measureChain(stages: GpuRealChainStage[], stimulus: StimulusDef): StageMetrics[] {
  const metrics: StageMetrics[] = stages.map((stage) => {
    const lines = stimulus.lines ? measureLines(stage, stimulus.lines) : null;
    return {
      label: stage.label,
      key: stage.key,
      width: stage.width,
      height: stage.height,
      highPassRms: highPassRms(stage, stimulus.roi),
      highPassRetention: null,
      lineMeanContrast: lines ? lines.reduce((a, l) => a + l.contrast, 0) / lines.length : null,
      lineRetention: null,
      lines,
      fundamentalAmplitude: stimulus.fundamental ? fundamentalAmplitude(stage) : null,
      fundamentalRetention: null,
      stepRingingPct: stimulus.step ? stepRingingPct(stage) : null,
      peakExcursion: stimulus.lines ? peakExcursion(stage, stimulus.roi) : null,
      peakExcursionRetention: null,
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
    if (metric.peakExcursion !== null && source.peakExcursion !== null) {
      metric.peakExcursionRetention = safeRatio(metric.peakExcursion, source.peakExcursion);
    }
  }
  return metrics;
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

interface MatrixRow {
  id: string;
  label: string;
  faint10LineRet: number | null;
  faint4LineRet: number | null;
  oblique45LineRet: number | null;
  oblique30LineRet: number | null;
  textureHpRet: number | null;
  sineFundRet: number | null;
  stepRingingPct: number | null;
  noiseAmpVsV1: number | null;
  faint10PeakExcursionRet: number | null;
}

function finalOf(
  results: Record<string, Record<string, StageMetrics[]>>,
  variantId: string,
  stimulusName: string,
): StageMetrics | null {
  const stages = results[variantId]?.[stimulusName];
  if (!stages || stages.length === 0) return null;
  return stages[stages.length - 1];
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null) return null;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 1e-9) {
    return null;
  }
  return numerator / denominator;
}

const fmt = (value: number | null, digits = 4): string =>
  value === null || !Number.isFinite(value) ? '-' : value.toFixed(digits);

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
      `[gpu] chain-ablation-variants preflight OK; adapter=${preflight.adapterInfo} software=${preflight.software}`,
    );
  } else {
    console.warn(
      `[gpu] chain-ablation-variants preflight FAILED (${preflight.kind}): ${preflight.error}`,
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

test('variant sweep: faint-detail recovery vs ringing/noise on the real chain', async ({
  page,
}) => {
  // 9 variants x 7 stimuli; full chain alone is ~8 s under SwiftShader.
  test.setTimeout(1_800_000);

  guardGpu(preflight, 'variant sweep');

  const results: Record<string, Record<string, StageMetrics[]>> = {};
  let adapter: { info: string; software: boolean } | null = null;

  for (const variant of VARIANTS) {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    results[variant.id] = {};
    const expectedDims = resolveExpectedDims(variant);

    for (const stimulus of STIMULI) {
      const startedAt = Date.now();
      const result = await runGpuRealChainAblation(page, {
        srcWidth: SRC_WIDTH,
        srcHeight: SRC_HEIGHT,
        stimulus: stimulus.build(),
        stages: variant.stages,
        clampHighlights: false,
        postSharpen: variant.postSharpen,
      });
      const elapsedMs = Date.now() - startedAt;

      if (!result.ok) {
        guardGpu(result, `variant sweep (${variant.id}/${stimulus.name})`);
        throw new Error(
          `variant sweep failed (${result.kind}): ${result.error} [${variant.id}/${stimulus.name}]`,
        );
      }
      adapter = { info: result.adapterInfo, software: result.software };

      expect(result.stages.length, `${variant.id}/${stimulus.name}: stage count`).toBe(
        expectedDims.length,
      );
      result.stages.forEach((stage, index) => {
        expect(stage.width, `${variant.id}/${stimulus.name}: stage ${index} width`).toBe(
          expectedDims[index].width,
        );
        expect(stage.height, `${variant.id}/${stimulus.name}: stage ${index} height`).toBe(
          expectedDims[index].height,
        );
        assertNotDegenerate(stage, `${variant.id}/${stimulus.name}: ${stage.label}`);
      });

      const metrics = measureChain(result.stages, stimulus);
      results[variant.id][stimulus.name] = metrics;

      const final = metrics[metrics.length - 1];
      console.log(
        `[gpu] ${variant.id} ${variant.label.padEnd(18)} ${stimulus.name.padEnd(24)}`
          + ` (${elapsedMs} ms) hpRet=${fmt(final.highPassRetention)}`
          + ` lineRet=${fmt(final.lineRetention)} fundRet=${fmt(final.fundamentalRetention)}`
          + ` ring=${fmt(final.stepRingingPct, 2)} peakRet=${fmt(final.peakExcursionRetention)}`,
      );
    }
  }

  // -- Comparison matrix -----------------------------------------------------
  const matrix: MatrixRow[] = VARIANTS.map((variant) => {
    const faint10 = finalOf(results, variant.id, 'faint-vertical-10of255');
    const faint4 = finalOf(results, variant.id, 'faint-vertical-4of255');
    const oblique45 = finalOf(results, variant.id, 'oblique-45deg-10of255');
    const oblique30 = finalOf(results, variant.id, 'oblique-30deg-10of255');
    const texture = finalOf(results, variant.id, 'texture-patch-6of255');
    const sine = finalOf(results, variant.id, 'sinusoid-period2-6of255');
    const step = finalOf(results, variant.id, 'step-0.3');
    return {
      id: variant.id,
      label: variant.label,
      faint10LineRet: faint10?.lineRetention ?? null,
      faint4LineRet: faint4?.lineRetention ?? null,
      oblique45LineRet: oblique45?.lineRetention ?? null,
      oblique30LineRet: oblique30?.lineRetention ?? null,
      textureHpRet: texture?.highPassRetention ?? null,
      sineFundRet: sine?.fundamentalRetention ?? null,
      stepRingingPct: step?.stepRingingPct ?? null,
      noiseAmpVsV1: null,
      faint10PeakExcursionRet: faint10?.peakExcursionRetention ?? null,
    };
  });

  const v1Texture = matrix.find((row) => row.id === 'V1')?.textureHpRet ?? null;
  for (const row of matrix) {
    row.noiseAmpVsV1 = ratio(row.textureHpRet, v1Texture);
  }

  const v1 = matrix.find((row) => row.id === 'V1');
  const deltaVsV1 = matrix.map((row) => ({
    id: row.id,
    label: row.label,
    faint10Line: row.faint10LineRet !== null && v1?.faint10LineRet != null
      ? row.faint10LineRet - v1.faint10LineRet
      : null,
    textureHp: row.textureHpRet !== null && v1?.textureHpRet != null
      ? row.textureHpRet - v1.textureHpRet
      : null,
    stepRingingPct: row.stepRingingPct,
  }));

  // -- Console matrix --------------------------------------------------------
  console.log('\n[gpu] === variant comparison matrix (final-stage retentions) ===');
  console.log(
    '[gpu] id  label               v10Line  v4Line   o45Line  o30Line  texHp    sineFund ring%   noise/V1 peak',
  );
  for (const row of matrix) {
    console.log(
      `[gpu] ${row.id.padEnd(3)} ${row.label.padEnd(18)}`
        + ` ${fmt(row.faint10LineRet).padStart(7)} ${fmt(row.faint4LineRet).padStart(8)}`
        + ` ${fmt(row.oblique45LineRet).padStart(8)} ${fmt(row.oblique30LineRet).padStart(8)}`
        + ` ${fmt(row.textureHpRet).padStart(7)} ${fmt(row.sineFundRet).padStart(8)}`
        + ` ${fmt(row.stepRingingPct, 2).padStart(6)} ${fmt(row.noiseAmpVsV1).padStart(8)}`
        + ` ${fmt(row.faint10PeakExcursionRet).padStart(6)}`,
    );
  }

  const reportDir = path.resolve(__dirname, '..', '..', 'test-results', 'chain-ablation-real');
  mkdirSync(reportDir, { recursive: true });
  const payload = {
    description:
      'Real Mode A+A/Ultra chain variant sweep: faint-detail recovery vs ringing/noise, at '
      + '1/10 scale (192x108). V8/V9 use the shipped src/shaders/cas.wgsl post-pass.',
    srcWidth: SRC_WIDTH,
    srcHeight: SRC_HEIGHT,
    clampHighlights: false,
    grey: GREY,
    deltas: { faint10: DELTA10, faint4: DELTA4, texture: DELTA6 },
    stepAmplitude: STEP_AMPLITUDE,
    postSharpen: 'shipped src/shaders/cas.wgsl, sharpness 0.30 (V8) and 0.60 (V9)',
    trimmedStimuli: ['checkerboard-6of255 (noise/aliasing is covered by texture-patch-6of255)'],
    variants: VARIANTS.map((variant) => ({
      id: variant.id,
      label: variant.label,
      stages: variant.stages,
      postSharpen: variant.postSharpen
        ? { kind: variant.postSharpen.kind, sharpness: variant.postSharpen.sharpness }
        : null,
    })),
    adapter,
    stimuli: STIMULI.map((stimulus) => ({
      name: stimulus.name,
      roi: stimulus.roi,
      hasLines: stimulus.lines !== null,
      fundamental: stimulus.fundamental,
      step: stimulus.step,
    })),
    results,
    matrix,
    deltaVsV1: deltaVsV1,
  };
  const reportPath = path.join(reportDir, 'variants-report.json');
  writeFileSync(reportPath, JSON.stringify(payload, null, 2));
  console.log(`[gpu] wrote ${reportPath}`);
});
