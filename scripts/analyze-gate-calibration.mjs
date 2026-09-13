#!/usr/bin/env node
/* global console, process, URL */
// CPU-only calibration for the amplitude gate in `src/shaders/restore-gate.wgsl`.
//
// The gate mask is defined as:
//   amp = max9 - min9   of Rec.709 luma over a clamped 3x3 neighbourhood
//   m   = smoothstep(gateLow, gateHigh, amp) * strength
// with luma in the ENCODED (gamma) domain:
//   luma = 0.2126*R + 0.7152*G + 0.0722*B   (R,G,B in [0,1])
//
// The leading restore's INPUT is the chain source texture, so calibration runs
// on the source frame directly. Flat pixels are irrelevant to the gate: on flat
// regions `restoreOut ~= input` (the CNN residual ~= 0), so gating them either
// way changes nothing. The populations that matter are therefore:
//   - `wingContour`  : the thin dark stroke pixels we want to BYPASS (m ~= 0);
//   - `faceStructure`: real face structure we want to RESTORE (m ~= 1).
//
// This script:
//   1. decodes the input PNG with ImageMagick 6 (`convert ... rgba:-`),
//   2. computes per-pixel `amp`,
//   3. reports the amp distribution for the wing and face ROIs,
//   4. defines the contour/structure populations and reports their amp spreads,
//   5. sweeps (gateLow, gateHigh) and prints bypass/full-gate/restore rates,
//   6. recommends a pair maximizing contour bypass subject to restoring >= 90%
//      of face structure, and
//   7. repeats under tighter/looser contour definitions for sensitivity.
//
// Prerequisites: ImageMagick 6 `convert` on PATH.
//
// Usage:
//   node scripts/analyze-gate-calibration.mjs
//   GATE_INPUT=/path/to/frame.png node scripts/analyze-gate-calibration.mjs
//
// Exit codes:
//   0  calibration completed
//   1  decode/input error

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const INPUT_PATH = path.resolve(process.env.GATE_INPUT ?? path.join(rootDir, 'e2e', 'testdata', 'videoframe_497385.png'));
const ANALYSIS_DIR = path.join(rootDir, 'videoframe_497385_analysis');

const MAX_BUFFER = 80 * 1024 * 1024;

// Source-frame ROIs (x0,y0)-(x1,y1), half-open on x1/y1.
const ROIS = {
  wing: { x0: 475, y0: 655, x1: 560, y1: 820 },
  face: { x0: 725, y0: 175, x1: 1025, y1: 750 },
};

// 8-bit quantization step in normalized units.
const STEP = 1 / 255; // ~0.0039215686

const PERCENTILES = [25, 50, 75, 90, 99, 99.9];

// Population definitions.
const WING_CONTOUR_STEPS_BELOW = 1; // luma < wing ROI background median - 1 step
const FACE_STRUCTURE_STEPS = 3; // amp >= 3 steps

// Threshold sweep grid.
const GATE_LOWS = [0.002, 0.004, 0.006, 0.008, 0.010, 0.014, 0.018, 0.024];
const GATE_HIGH_MAX = 0.06;
const GATE_HIGH_STEP = 0.004;
const RESTORE_TARGET = 0.9;

/** Read PNG pixel dimensions from the IHDR chunk (bytes 16..24, big-endian). */
function readPngSize(pngPath) {
  const raw = execFileSync('convert', [pngPath, '-format', '%w %h', 'info:'], {
    maxBuffer: MAX_BUFFER,
  }).toString('utf8').trim();
  const [width, height] = raw.split(/\s+/).map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error(`could not read PNG dimensions from ${pngPath}`);
  }
  return { width, height };
}

/** Decode an 8-bit RGBA PNG to a tightly-packed RGBA byte buffer. */
function decodeRgba(pngPath, width, height) {
  const rgba = execFileSync('convert', [pngPath, '-depth', '8', 'rgba:-'], {
    maxBuffer: MAX_BUFFER,
  });
  const expected = width * height * 4;
  if (rgba.length !== expected) {
    throw new Error(
      `decoded ${pngPath} to ${rgba.length} bytes, expected ${expected} (${width}x${height}x4)`,
    );
  }
  return rgba;
}

/** Normalized Rec.709 luma in [0,1] per pixel. */
function computeLuma(rgba, width, height) {
  const n = width * height;
  const luma = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i += 1, j += 4) {
    luma[i] = (0.2126 * rgba[j] + 0.7152 * rgba[j + 1] + 0.0722 * rgba[j + 2]) / 255;
  }
  return luma;
}

/** Per-pixel `amp = max9 - min9` of luma over a clamped 3x3 neighbourhood. */
function computeAmp(luma, width, height) {
  const amp = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const y0 = y > 0 ? y - 1 : 0;
    const y1 = y < height - 1 ? y + 1 : height - 1;
    for (let x = 0; x < width; x += 1) {
      const x0 = x > 0 ? x - 1 : 0;
      const x1 = x < width - 1 ? x + 1 : width - 1;
      let max = -Infinity;
      let min = Infinity;
      for (let yy = y0; yy <= y1; yy += 1) {
        const row = yy * width;
        for (let xx = x0; xx <= x1; xx += 1) {
          const v = luma[row + xx];
          if (v > max) max = v;
          if (v < min) min = v;
        }
      }
      amp[y * width + x] = max - min;
    }
  }
  return amp;
}

/** Linear-interpolated percentile (numpy default) over an ascending array. */
function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

/** Distribution summary of an array/typed array of values. */
function distribution(values) {
  const count = values.length;
  let sum = 0;
  let max = -Infinity;
  for (let i = 0; i < count; i += 1) {
    const v = values[i];
    sum += v;
    if (v > max) max = v;
  }
  const sorted = Float64Array.from(values);
  sorted.sort();
  const p = {};
  for (const q of PERCENTILES) p[q] = percentile(sorted, q);
  return { count, mean: count ? sum / count : NaN, max: count ? max : NaN, p };
}

/** Copy every ROI amp value into an array. */
function roiAmps(amp, width, roi) {
  const out = [];
  for (let y = roi.y0; y < roi.y1; y += 1) {
    const row = y * width;
    for (let x = roi.x0; x < roi.x1; x += 1) out.push(amp[row + x]);
  }
  return out;
}

const fmt = (v, digits = 6) => (Number.isFinite(v) ? v.toFixed(digits) : String(v));
const fmtSteps = (v) => `${(v * 255).toFixed(3)} steps`;

function printDistribution(label, values, extra = '') {
  const dist = distribution(values);
  console.log(`\nROI "${label}" (${dist.count} px)${extra}`);
  console.log('  metric      normalized     8-bit steps');
  console.log(`  mean     ${fmt(dist.mean).padStart(12)}  ${fmtSteps(dist.mean).padStart(14)}`);
  for (const q of PERCENTILES) {
    console.log(
      `  ${`p${q}`.padEnd(8)} ${fmt(dist.p[q]).padStart(12)}  ${fmtSteps(dist.p[q]).padStart(14)}`,
    );
  }
  console.log(`  max      ${fmt(dist.max).padStart(12)}  ${fmtSteps(dist.max).padStart(14)}`);
  return dist;
}

// --- Populations -----------------------------------------------------------

/** Median luma of the ROI (the flat-field level). */
function roiMedianLuma(luma, width, roi) {
  const values = [];
  for (let y = roi.y0; y < roi.y1; y += 1) {
    const row = y * width;
    for (let x = roi.x0; x < roi.x1; x += 1) values.push(luma[row + x]);
  }
  values.sort((a, b) => a - b);
  return percentile(values, 50);
}

/**
 * Thin dark-stroke mask: ROI pixels darker than the ROI background median by
 * more than `stepsBelow` quantization steps.
 */
function contourMask(luma, width, roi, stepsBelow) {
  const backgroundMedian = roiMedianLuma(luma, width, roi);
  const threshold = backgroundMedian - stepsBelow * STEP;
  const mask = new Uint8Array(luma.length);
  let count = 0;
  for (let y = roi.y0; y < roi.y1; y += 1) {
    const row = y * width;
    for (let x = roi.x0; x < roi.x1; x += 1) {
      const i = row + x;
      if (luma[i] < threshold) {
        mask[i] = 1;
        count += 1;
      }
    }
  }
  return { mask, backgroundMedian, threshold, count, stepsBelow };
}

/** Dilate a mask by one 8-neighbourhood ring, clamped to the ROI. */
function dilateMask(mask, width, roi) {
  const out = new Uint8Array(mask.length);
  for (let y = roi.y0; y < roi.y1; y += 1) {
    const row = y * width;
    for (let x = roi.x0; x < roi.x1; x += 1) {
      const i = row + x;
      let hit = mask[i] === 1;
      for (let dy = -1; dy <= 1 && !hit; dy += 1) {
        const yy = y + dy;
        if (yy < roi.y0 || yy >= roi.y1) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = x + dx;
          if (xx < roi.x0 || xx >= roi.x1) continue;
          if (mask[yy * width + xx] === 1) {
            hit = true;
            break;
          }
        }
      }
      if (hit) out[i] = 1;
    }
  }
  return out;
}

/** Amp values under a boolean mask, restricted to the ROI. */
function maskedAmps(amp, width, roi, predicate) {
  const out = [];
  for (let y = roi.y0; y < roi.y1; y += 1) {
    const row = y * width;
    for (let x = roi.x0; x < roi.x1; x += 1) {
      const i = row + x;
      if (predicate(i)) out.push(amp[i]);
    }
  }
  return out;
}

// --- Sweep / recommendation -------------------------------------------------

function rateBelow(values, threshold) {
  let count = 0;
  for (const v of values) if (v < threshold) count += 1;
  return values.length ? count / values.length : NaN;
}

function rateAbove(values, threshold) {
  let count = 0;
  for (const v of values) if (v > threshold) count += 1;
  return values.length ? count / values.length : NaN;
}

/** Mean smoothstep mask the shader would apply to this population. */
function meanMask(values, low, high) {
  if (values.length === 0) return NaN;
  let sum = 0;
  for (const v of values) {
    let t = (v - low) / (high - low);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    sum += t * t * (3 - 2 * t);
  }
  return sum / values.length;
}

function buildGrid() {
  const grid = [];
  for (const gateLow of GATE_LOWS) {
    for (let k = 1; ; k += 1) {
      const gateHigh = Number((gateLow + k * GATE_HIGH_STEP).toFixed(6));
      if (gateHigh > GATE_HIGH_MAX + 1e-9) break;
      grid.push({ gateLow, gateHigh });
    }
  }
  return grid;
}

function sweepGrid(wingAmps, faceAmps, grid) {
  return grid.map(({ gateLow, gateHigh }) => ({
    gateLow,
    gateHigh,
    wingContourBypassRate: rateBelow(wingAmps, gateLow),
    wingContourFullGateRate: rateAbove(wingAmps, gateHigh),
    faceStructureRestoredRate: rateAbove(faceAmps, gateHigh),
    faceStructureBypassedRate: rateBelow(faceAmps, gateLow),
    wingContourMeanMask: meanMask(wingAmps, gateLow, gateHigh),
    faceStructureMeanMask: meanMask(faceAmps, gateLow, gateHigh),
  }));
}

/**
 * Pick the pair maximizing contour bypass subject to restoring >= RESTORE_TARGET
 * of face structure. If none is feasible, return the honest frontier: the pair
 * with the highest restore rate (tie-broken by higher bypass).
 */
function recommend(rows) {
  const feasible = rows.filter((r) => r.faceStructureRestoredRate >= RESTORE_TARGET);
  if (feasible.length > 0) {
    feasible.sort(
      (a, b) =>
        b.wingContourBypassRate - a.wingContourBypassRate ||
        b.faceStructureRestoredRate - a.faceStructureRestoredRate ||
        a.wingContourFullGateRate - b.wingContourFullGateRate ||
        a.gateHigh - b.gateHigh,
    );
    return { feasible: true, ...feasible[0] };
  }
  const maxRestored = ratesMax(rows, (r) => r.faceStructureRestoredRate);
  const frontier = rows
    .filter((r) => Math.abs(r.faceStructureRestoredRate - maxRestored) < 1e-12)
    .sort((a, b) => b.wingContourBypassRate - a.wingContourBypassRate)[0];
  return { feasible: false, maxRestored, ...frontier };
}

function ratesMax(rows, pick) {
  let max = -Infinity;
  for (const r of rows) {
    const v = pick(r);
    if (v > max) max = v;
  }
  return max;
}

const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : 'n/a');

function printRecommendation(rec, label) {
  console.log(`\nRecommended pair (${label}):`);
  if (rec.feasible) {
    console.log(
      `  gateLow=${fmt(rec.gateLow, 4)} (${fmtSteps(rec.gateLow)})  `
      + `gateHigh=${fmt(rec.gateHigh, 4)} (${fmtSteps(rec.gateHigh)})  strength=1.0`,
    );
    console.log(`  wingContourBypassRate      = ${pct(rec.wingContourBypassRate)}`);
    console.log(`  wingContourFullGateRate    = ${pct(rec.wingContourFullGateRate)}`);
    console.log(`  faceStructureRestoredRate  = ${pct(rec.faceStructureRestoredRate)}`);
    console.log(`  faceStructureBypassedRate  = ${pct(rec.faceStructureBypassedRate)}`);
    console.log(`  wingContourMeanMask        = ${fmt(rec.wingContourMeanMask)}`);
    console.log(`  faceStructureMeanMask      = ${fmt(rec.faceStructureMeanMask)}`);
  } else {
    console.log(
      `  no pair reaches faceStructureRestoredRate >= ${RESTORE_TARGET}; `
      + `best frontier: gateLow=${fmt(rec.gateLow, 4)} gateHigh=${fmt(rec.gateHigh, 4)}`,
    );
    console.log(`  faceStructureRestoredRate  = ${pct(rec.faceStructureRestoredRate)} (max)`);
    console.log(`  wingContourBypassRate      = ${pct(rec.wingContourBypassRate)}`);
    console.log(`  wingContourFullGateRate    = ${pct(rec.wingContourFullGateRate)}`);
    console.log(`  faceStructureBypassedRate  = ${pct(rec.faceStructureBypassedRate)}`);
    console.log(`  wingContourMeanMask        = ${fmt(rec.wingContourMeanMask)}`);
    console.log(`  faceStructureMeanMask      = ${fmt(rec.faceStructureMeanMask)}`);
  }
}

function printSweepCompact(rows) {
  console.log('\nThreshold sweep — representative gateHigh per gateLow');
  console.log('(feasible rows: max contour bypass subject to restore>=90%; else max restore)');
  const header = [
    'gateLow', 'gateHigh', 'wingBypass', 'wingFull', 'faceRestored', 'faceBypassed',
  ];
  console.log(
    header.map((h, i) => (i === 0 || i === 1 ? h.padStart(8) : h.padStart(13))).join('  '),
  );
  for (const low of GATE_LOWS) {
    const subset = rows.filter((r) => r.gateLow === low);
    const feasible = subset.filter((r) => r.faceStructureRestoredRate >= RESTORE_TARGET);
    let pick;
    if (feasible.length > 0) {
      feasible.sort(
        (a, b) =>
          b.wingContourBypassRate - a.wingContourBypassRate ||
          b.faceStructureRestoredRate - a.faceStructureRestoredRate,
      );
      pick = feasible[0];
    } else {
      pick = subset.slice().sort((a, b) => b.faceStructureRestoredRate - a.faceStructureRestoredRate)[0];
    }
    const cells = [
      fmt(pick.gateLow, 3),
      fmt(pick.gateHigh, 3),
      pct(pick.wingContourBypassRate),
      pct(pick.wingContourFullGateRate),
      pct(pick.faceStructureRestoredRate),
      pct(pick.faceStructureBypassedRate),
    ];
    console.log(cells.map((c, i) => (i === 0 || i === 1 ? c.padStart(8) : c.padStart(13))).join('  '));
  }
}

function main() {
  if (!existsSync(INPUT_PATH)) throw new Error(`input PNG not found: ${INPUT_PATH}`);

  console.log('A+A restore-gate amplitude calibration (v2: affected populations)');
  console.log(`  input : ${INPUT_PATH}`);
  console.log('  amp   : max9 - min9 of Rec.709 luma (encoded domain), clamped 3x3');
  console.log(`  1 step: 1/255 = ${STEP.toFixed(8)} (normalized)`);

  const { width, height } = readPngSize(INPUT_PATH);
  const rgba = decodeRgba(INPUT_PATH, width, height);
  const luma = computeLuma(rgba, width, height);
  const amp = computeAmp(luma, width, height);
  console.log(`  frame : ${width}x${height}`);

  // Raw ROI amp distributions (context).
  const wingDist = printDistribution('wing (all)', roiAmps(amp, width, ROIS.wing));
  const faceDist = printDistribution('face (all)', roiAmps(amp, width, ROIS.face));

  // --- Populations ---
  const baseContour = contourMask(luma, width, ROIS.wing, WING_CONTOUR_STEPS_BELOW);
  const wingContourAmps = maskedAmps(amp, width, ROIS.wing, (i) => baseContour.mask[i] === 1);
  const faceStructureAmps = maskedAmps(
    amp,
    width,
    ROIS.face,
    (i) => amp[i] >= FACE_STRUCTURE_STEPS * STEP,
  );

  console.log('\nPopulations');
  console.log(
    `  wingContour  : luma < wingROI background median (${fmt(baseContour.backgroundMedian)})`
    + ` - ${WING_CONTOUR_STEPS_BELOW} step  [threshold ${fmt(baseContour.threshold)}]`,
  );
  console.log(`  faceStructure: amp >= ${FACE_STRUCTURE_STEPS} steps`);
  const wingContourDist = printDistribution('wingContour', wingContourAmps);
  const faceStructureDist = printDistribution('faceStructure', faceStructureAmps);

  // --- Sweep + recommendation (base definition) ---
  const grid = buildGrid();
  const rows = sweepGrid(wingContourAmps, faceStructureAmps, grid);
  printSweepCompact(rows);
  const recommendation = recommend(rows);
  printRecommendation(recommendation, 'base wingContour');

  // --- Sensitivity ---
  const tighterContour = contourMask(
    luma,
    width,
    ROIS.wing,
    WING_CONTOUR_STEPS_BELOW + 1,
  );
  const tighterAmps = maskedAmps(amp, width, ROIS.wing, (i) => tighterContour.mask[i] === 1);
  const looseThresholdContour = contourMask(
    luma,
    width,
    ROIS.wing,
    Math.max(0, WING_CONTOUR_STEPS_BELOW - 1),
  );
  const looseThresholdAmps = maskedAmps(
    amp,
    width,
    ROIS.wing,
    (i) => looseThresholdContour.mask[i] === 1,
  );
  const haloCandidate = dilateMask(baseContour.mask, width, ROIS.wing);
  const haloAmps = maskedAmps(amp, width, ROIS.wing, (i) => haloCandidate[i] === 1);

  const sensitivityVariants = [
    {
      key: 'tighter',
      label: `luma < median - ${WING_CONTOUR_STEPS_BELOW + 1} step`,
      amps: tighterAmps,
    },
    {
      key: 'looserThreshold',
      label: `luma < median - ${Math.max(0, WING_CONTOUR_STEPS_BELOW - 1)} step`,
      amps: looseThresholdAmps,
    },
    {
      key: 'looserHalo',
      label: `base + 1-px halo`,
      amps: haloAmps,
    },
  ];

  console.log('\nSensitivity (recompute recommendation under other wingContour definitions)');
  const sensitivity = {
    base: {
      definition: `luma < median - ${WING_CONTOUR_STEPS_BELOW} step`,
      count: baseContour.count,
      recommendation: {
        feasible: recommendation.feasible,
        gateLow: recommendation.gateLow,
        gateHigh: recommendation.gateHigh,
        strength: 1.0,
        wingContourBypassRate: recommendation.wingContourBypassRate,
        wingContourFullGateRate: recommendation.wingContourFullGateRate,
        faceStructureRestoredRate: recommendation.faceStructureRestoredRate,
      },
    },
  };
  for (const variant of sensitivityVariants) {
    const dist = distribution(variant.amps);
    const variantRows = sweepGrid(variant.amps, faceStructureAmps, grid);
    const rec = recommend(variantRows);
    console.log(
      `  ${variant.key.padEnd(16)} (${variant.label}, n=${dist.count}): `
      + `gateLow=${fmt(rec.gateLow, 4)} gateHigh=${fmt(rec.gateHigh, 4)} `
      + `bypass=${pct(rec.wingContourBypassRate)} restored=${pct(rec.faceStructureRestoredRate)} `
      + `feasible=${rec.feasible}`,
    );
    sensitivity[variant.key] = {
      definition: variant.label,
      count: dist.count,
      distribution: dist,
      recommendation: {
        feasible: rec.feasible,
        gateLow: rec.gateLow,
        gateHigh: rec.gateHigh,
        strength: 1.0,
        wingContourBypassRate: rec.wingContourBypassRate,
        wingContourFullGateRate: rec.wingContourFullGateRate,
        faceStructureRestoredRate: rec.faceStructureRestoredRate,
      },
    };
  }

  // Legacy pre-registered test (kept for continuity; mis-specified, see v2).
  const wingP999 = wingDist.p[99.9];
  const faceP50 = faceDist.p[50];

  const result = {
    input: path.relative(rootDir, INPUT_PATH),
    frame: { width, height },
    metric: 'amp = max9 - min9 of Rec.709 luma (encoded, clamped 3x3)',
    normalizedStep: STEP,
    rois: {
      wing: { rect: ROIS.wing, ...wingDist },
      face: { rect: ROIS.face, ...faceDist },
    },
    populations: {
      wingContour: {
        definition: `wing ROI pixels with luma < ROI background median - ${WING_CONTOUR_STEPS_BELOW} step`,
        rationale:
          'proxy for the thin dark stroke; want the gate to bypass these (m ~= 0)',
        backgroundMedian: baseContour.backgroundMedian,
        threshold: baseContour.threshold,
        ...wingContourDist,
      },
      faceStructure: {
        definition: `face ROI pixels with amp >= ${FACE_STRUCTURE_STEPS} steps`,
        rationale:
          'proxy for real face structure (hair/eye/brow edges); want the gate to restore these (m ~= 1)',
        ...faceStructureDist,
      },
    },
    sweep: rows,
    recommendation: {
      feasible: recommendation.feasible,
      gateLow: recommendation.gateLow,
      gateHigh: recommendation.gateHigh,
      strength: 1.0,
      wingContourBypassRate: recommendation.wingContourBypassRate,
      wingContourFullGateRate: recommendation.wingContourFullGateRate,
      faceStructureRestoredRate: recommendation.faceStructureRestoredRate,
      faceStructureBypassedRate: recommendation.faceStructureBypassedRate,
      wingContourMeanMask: recommendation.wingContourMeanMask,
      faceStructureMeanMask: recommendation.faceStructureMeanMask,
    },
    sensitivity,
    separability: {
      test: 'p99.9(wing) < p50(face)',
      wingP99_9: wingP999,
      faceP50,
      margin: faceP50 - wingP999,
      separable: wingP999 < faceP50,
      note: 'legacy pre-registered test; mis-specified (compares a contour percentile to a flat-skin median)',
    },
  };
  mkdirSync(ANALYSIS_DIR, { recursive: true });
  const outPath = path.join(ANALYSIS_DIR, 'gate-calibration.json');
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(`\nWrote ${outPath}`);
}

try {
  main();
} catch (err) {
  console.error(`Gate calibration failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
