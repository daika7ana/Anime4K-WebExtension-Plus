#!/usr/bin/env node
/* global console, process, URL */
// Diagnostic: decode the already-dumped GPU pass PNGs for the A+A "ultra"
// pipeline (full vs. fast chains), compute whole-frame quality metrics per
// pass, quantify where the two FINAL images diverge, and emit visual
// artifacts (overview, diff heatmap, top-divergence crops).
//
// This script is read-only with respect to the repository: it only reads the
// pre-existing dump directories and writes into a dedicated analysis folder.
//
// Prerequisites:
//   - ImageMagick 6 `convert` on PATH (decodes PNG -> raw rgba bytes and
//     produces the visual artifacts).
//
// Usage:
//   node scripts/analyze-pass-dump.mjs
//
// Exit codes:
//   0  analysis completed, metrics.json + artifacts written
//   1  an input artifact was missing or malformed

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { boxBlur, computeLuma, decodeRgba, fmt, readPngSize } from './lib/png-metrics.mjs';

const rootDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const FULL_DIR = 'videoframe_497385_full/A+A-ultra';
const FAST_DIR = 'videoframe_497385_fast/A+A-ultra';
const OUT_DIR = 'videoframe_497385_analysis';

const MARGIN = 4; // px excluded from global stats to avoid boundary effects
const TILE = 120; // tile edge; 3840/120 = 32 cols, 2160/120 = 18 rows
const TOP_TILES = 20;
const TOP_TILE_CROPS = 8;
const OVERVIEW_WIDTH = 1280;

// Pass tables mirror the dump's passes.txt. `label` is human-readable only.
const FULL_PASSES = [
  { pass: 0, file: '00-source.png', label: 'source' },
  { pass: 1, file: '01-CNNUL-0-1920x1080.png', label: 'CNNUL' },
  { pass: 2, file: '02-CNNx2UL-1-3840x2160.png', label: 'CNNx2UL' },
  { pass: 3, file: '03-Downscale-960x540.png', label: 'Downscale' },
  { pass: 4, file: '04-CNNUL-2-960x540.png', label: 'CNNUL' },
  { pass: 5, file: '05-CNNx2UL-3-1920x1080.png', label: 'CNNx2UL' },
  { pass: 6, file: '06-CNNUL-4-1920x1080.png', label: 'CNNUL' },
  { pass: 7, file: '07-CNNx2VL-5-3840x2160.png', label: 'CNNx2VL' },
  { pass: 8, file: '08-ClampHighlightsApply-3840x2160.png', label: 'ClampHighlightsApply' },
];

const FAST_PASSES = [
  { pass: 0, file: '00-source.png', label: 'source' },
  { pass: 1, file: '01-CNNUL-0-1920x1080.png', label: 'CNNUL' },
  { pass: 2, file: '02-CNNx2UL-1-3840x2160.png', label: 'CNNx2UL' },
  { pass: 3, file: '03-CNNUL-2-3840x2160.png', label: 'CNNUL' },
  { pass: 4, file: '04-CNNUL-4-3840x2160.png', label: 'CNNUL' },
  { pass: 5, file: '05-ClampHighlightsApply-3840x2160.png', label: 'ClampHighlightsApply' },
];

const FULL_FINAL = { file: '08-ClampHighlightsApply-3840x2160.png', label: 'ClampHighlightsApply' };
const FAST_FINAL = { file: '05-ClampHighlightsApply-3840x2160.png', label: 'ClampHighlightsApply' };

// --- Image I/O -------------------------------------------------------------

// --- Per-image metrics -----------------------------------------------------

// Computes whole-frame quality metrics over the interior (MARGIN px cropped
// from every border). Returns the metrics plus the radius-1 blur so callers can
// reuse it for tiled comparison; the radius-4 blur is released immediately.
function analyzeLuma(y, width, height) {
  const box3 = boxBlur(y, width, height, 1);
  const box9 = boxBlur(y, width, height, 4);

  let n = 0;
  let sumY = 0;
  let sumY2 = 0;
  let sumHp = 0;
  let sumFine = 0;
  let sumMid = 0;

  for (let yy = MARGIN; yy < height - MARGIN; yy += 1) {
    const row = yy * width;
    for (let xx = MARGIN; xx < width - MARGIN; xx += 1) {
      const i = row + xx;
      const v = y[i];
      sumY += v;
      sumY2 += v * v;

      const hp = v - box3[i];
      sumHp += hp * hp;

      const mid = box3[i] - box9[i];
      sumMid += mid * mid;

      const lap = 4 * v - y[i - width] - y[i + width] - y[i - 1] - y[i + 1];
      sumFine += lap * lap;

      n += 1;
    }
  }

  const meanY = sumY / n;
  const variance = sumY2 / n - meanY * meanY;
  const metrics = {
    meanY,
    stdY: Math.sqrt(variance > 0 ? variance : 0),
    hpRMS: Math.sqrt(sumHp / n),
    fineRMS: Math.sqrt(sumFine / n),
    midRMS: Math.sqrt(sumMid / n),
  };
  return { metrics, box3 };
}

// Decodes a file and returns its luma field + dimensions. The raw RGBA buffer
// is dropped before returning so only the Float32Array survives.
function loadLuma(pngPath) {
  const { width, height } = readPngSize(pngPath);
  const rgba = decodeRgba(pngPath, width, height);
  const y = computeLuma(rgba, width, height);
  return { y, width, height };
}

// --- Final vs. final comparison --------------------------------------------

function compareFinals(full, fast, width, height) {
  let sumAbsLuma = 0;
  let maxAbs = 0;
  let mse = 0;
  let count = 0;
  for (let yy = MARGIN; yy < height - MARGIN; yy += 1) {
    const row = yy * width;
    for (let xx = MARGIN; xx < width - MARGIN; xx += 1) {
      const i = row + xx;
      const d = Math.abs(full.y[i] - fast.y[i]);
      sumAbsLuma += d;
      if (d > maxAbs) maxAbs = d;
      mse += d * d;
      count += 1;
    }
  }
  const meanAbsDiffLuma = sumAbsLuma / count;
  mse /= count;
  const psnrLuma = mse === 0 ? null : 10 * Math.log10(1 / mse);

  // Per-channel means require the original RGB samples; the luma fields alone
  // cannot recover them, so decode them from the retained RGBA buffers.
  const meanAbsRgb = meanAbsDiffRgb(full.rgba, fast.rgba, width, height);

  // Global high-frequency RMS for each final (interior only).
  const hpFull = interiorRms(full.y, full.box3, width, height);
  const hpFast = interiorRms(fast.y, fast.box3, width, height);
  const ratioFastOverFull = hpFull === 0 ? null : hpFast / hpFull;

  const tiles = rankTiles(full, fast, width, height);

  return {
    width,
    height,
    meanAbsDiffLuma,
    meanAbsDiffRgb: meanAbsRgb,
    maxAbsDiff: maxAbs,
    psnrLuma,
    hpRMS: { full: hpFull, fast: hpFast, ratioFastOverFull },
    tiles,
  };
}

function interiorRms(a, blurred, width, height) {
  let sum = 0;
  let count = 0;
  for (let yy = MARGIN; yy < height - MARGIN; yy += 1) {
    const row = yy * width;
    for (let xx = MARGIN; xx < width - MARGIN; xx += 1) {
      const i = row + xx;
      const d = a[i] - blurred[i];
      sum += d * d;
      count += 1;
    }
  }
  return Math.sqrt(sum / count);
}

function meanAbsDiffRgb(aRgba, bRgba, width, height) {
  const n = width * height * 4;
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    sum += Math.abs(aRgba[i] - bRgba[i]);
  }
  return sum / (width * height * 3) / 255;
}

function rankTiles(full, fast, width, height) {
  const cols = width / TILE;
  const rows = height / TILE;
  const tiles = [];

  for (let ty = 0; ty < rows; ty += 1) {
    for (let tx = 0; tx < cols; tx += 1) {
      const x0 = tx * TILE;
      const y0 = ty * TILE;
      let sumDiff = 0;
      let sumHpFull = 0;
      let sumHpFast = 0;
      let count = 0;
      for (let yy = y0; yy < y0 + TILE; yy += 1) {
        const row = yy * width;
        for (let xx = x0; xx < x0 + TILE; xx += 1) {
          const i = row + xx;
          sumDiff += Math.abs(full.y[i] - fast.y[i]);
          const df = full.y[i] - full.box3[i];
          const ds = fast.y[i] - fast.box3[i];
          sumHpFull += df * df;
          sumHpFast += ds * ds;
          count += 1;
        }
      }
      const hpFull = Math.sqrt(sumHpFull / count);
      const hpFast = Math.sqrt(sumHpFast / count);
      tiles.push({
        x: x0,
        y: y0,
        meanAbsDiffLuma: sumDiff / count,
        hpFull,
        hpFast,
        hpRatio: hpFull === 0 ? null : hpFast / hpFull,
      });
    }
  }

  tiles.sort((a, b) => b.meanAbsDiffLuma - a.meanAbsDiffLuma);
  return {
    size: TILE,
    cols,
    rows,
    top: tiles.slice(0, TOP_TILES),
  };
}

// --- Console formatting ----------------------------------------------------

function printTable(title, rows) {
  console.log(`\n${title}`);
  const header = ['pass', 'label', 'WxH', 'meanY', 'stdY', 'hpRMS', 'fineRMS', 'midRMS'];
  const body = rows.map((r) => [
    String(r.pass).padStart(2, '0'),
    r.label,
    `${r.width}x${r.height}`,
    fmt(r.metrics.meanY),
    fmt(r.metrics.stdY),
    fmt(r.metrics.hpRMS),
    fmt(r.metrics.fineRMS),
    fmt(r.metrics.midRMS),
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((row) => row[i].length)),
  );
  const line = (cells) =>
    cells
      .map((cell, i) => (i === 1 ? cell.padEnd(widths[i]) : cell.padStart(widths[i])))
      .join('  ');
  console.log(line(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of body) console.log(line(row));
}

// --- Visual artifacts ------------------------------------------------------

function convert(args) {
  execFileSync('convert', args, { maxBuffer: 80 * 1024 * 1024 });
}

function writeArtifacts(outAbs, fullFinalAbs, fastFinalAbs, sourceAbs, final) {
  const overviewAbs = path.join(outAbs, '01-overview.png');
  const heatmapAbs = path.join(outAbs, '02-diff-heatmap-1280.png');

  // [source, full final, fast final], each scaled to 1280 wide, left-to-right.
  // Parentheses isolate each input so -resize/-crop only touch that image.
  convert([
    '(', sourceAbs, '-resize', `${OVERVIEW_WIDTH}x`, '-depth', '8', ')',
    '(', fullFinalAbs, '-resize', `${OVERVIEW_WIDTH}x`, '-depth', '8', ')',
    '(', fastFinalAbs, '-resize', `${OVERVIEW_WIDTH}x`, '-depth', '8', ')',
    '+append', overviewAbs,
  ]);

  // Luma |full - fast|, auto-contrasted, scaled to 1280 wide.
  convert([
    fullFinalAbs, fastFinalAbs,
    '-compose', 'difference', '-composite',
    '-colorspace', 'Gray', '-auto-level',
    '-resize', `${OVERVIEW_WIDTH}x`,
    heatmapAbs,
  ]);

  const tilesDirAbs = outAbs;
  const crops = final.tiles.top.slice(0, TOP_TILE_CROPS);
  const cropPaths = [];
  crops.forEach((tile, index) => {
    const rank = index + 1;
    const diff = tile.meanAbsDiffLuma.toFixed(6);
    const name = `tile-${rank}-x${tile.x}y${tile.y}-mad${diff}.png`;
    const outPath = path.join(tilesDirAbs, name);
    convert([
      '(',
      fullFinalAbs,
      '-crop', `${TILE}x${TILE}+${tile.x}+${tile.y}`, '+repage',
      '-filter', 'point', '-resize', '400%',
      ')',
      '(',
      fastFinalAbs,
      '-crop', `${TILE}x${TILE}+${tile.x}+${tile.y}`, '+repage',
      '-filter', 'point', '-resize', '400%',
      ')',
      '+append', outPath,
    ]);
    cropPaths.push(outPath);
  });

  return { overviewAbs, heatmapAbs, cropPaths };
}

// --- Main ------------------------------------------------------------------

function analyzeChain(chainDirAbs, passes) {
  const rows = [];
  for (const pass of passes) {
    const abs = path.join(chainDirAbs, pass.file);
    if (!existsSync(abs)) throw new Error(`Missing pass image: ${abs}`);
    const { y, width, height } = loadLuma(abs);
    const { metrics } = analyzeLuma(y, width, height);
    rows.push({ pass: pass.pass, file: pass.file, label: pass.label, width, height, metrics });
  }
  return rows;
}

function main() {
  const fullDirAbs = path.join(rootDir, FULL_DIR);
  const fastDirAbs = path.join(rootDir, FAST_DIR);
  const outAbs = path.join(rootDir, OUT_DIR);

  if (!existsSync(fullDirAbs)) throw new Error(`Missing full chain dir: ${fullDirAbs}`);
  if (!existsSync(fastDirAbs)) throw new Error(`Missing fast chain dir: ${fastDirAbs}`);

  console.log('A+A ultra pass-dump analysis');
  console.log(`  full: ${FULL_DIR}`);
  console.log(`  fast: ${FAST_DIR}`);

  const fullRows = analyzeChain(fullDirAbs, FULL_PASSES);
  const fastRows = analyzeChain(fastDirAbs, FAST_PASSES);
  const source = fullRows[0];

  // --- Final vs. final (both 3840x2160, pixel-aligned) ---------------------
  const fullFinalAbs = path.join(fullDirAbs, FULL_FINAL.file);
  const fastFinalAbs = path.join(fastDirAbs, FAST_FINAL.file);
  const sourceAbs = path.join(fullDirAbs, source.file);

  const fullFinalLuma = loadLuma(fullFinalAbs);
  const fastFinalLuma = loadLuma(fastFinalAbs);
  if (fullFinalLuma.width !== fastFinalLuma.width || fullFinalLuma.height !== fastFinalLuma.height) {
    throw new Error('Final images are not pixel-aligned (dimension mismatch).');
  }

  fullFinalLuma.box3 = boxBlur(fullFinalLuma.y, fullFinalLuma.width, fullFinalLuma.height, 1);
  fastFinalLuma.box3 = boxBlur(fastFinalLuma.y, fastFinalLuma.width, fastFinalLuma.height, 1);

  // Re-decode RGBA for the per-channel RGB diff (luma fields alone cannot
  // recover it). Decode sequentially to keep peak memory bounded, then drop.
  fullFinalLuma.rgba = decodeRgba(fullFinalAbs, fullFinalLuma.width, fullFinalLuma.height);
  fastFinalLuma.rgba = decodeRgba(fastFinalAbs, fastFinalLuma.width, fastFinalLuma.height);

  const final = compareFinals(fullFinalLuma, fastFinalLuma, fullFinalLuma.width, fullFinalLuma.height);
  final.fullFile = FULL_FINAL.file;
  final.fastFile = FAST_FINAL.file;

  // Release the heavyweight buffers before spawning ImageMagick.
  fullFinalLuma.rgba = null;
  fastFinalLuma.rgba = null;

  // --- Report --------------------------------------------------------------
  printTable(`FULL chain (${FULL_DIR})`, fullRows);
  printTable(`FAST chain (${FAST_DIR})`, fastRows);

  console.log('\nFINAL vs FINAL (3840x2160)');
  console.log(`  meanAbsDiffLuma : ${fmt(final.meanAbsDiffLuma)}`);
  console.log(`  meanAbsDiffRgb  : ${fmt(final.meanAbsDiffRgb)}`);
  console.log(`  maxAbsDiff      : ${fmt(final.maxAbsDiff)}`);
  console.log(`  psnrLuma (dB)   : ${fmt(final.psnrLuma)}`);
  console.log(`  hpRMS full      : ${fmt(final.hpRMS.full)}`);
  console.log(`  hpRMS fast      : ${fmt(final.hpRMS.fast)}`);
  console.log(`  hp ratio f/f    : ${fmt(final.hpRMS.ratioFastOverFull)}`);

  console.log('\nTop 10 divergent tiles (of 32x18, 120x120 px):');
  console.log('  rank   x     y    meanAbsDiffLuma   hpFull     hpFast    hpRatio');
  for (let i = 0; i < 10; i += 1) {
    const t = final.tiles.top[i];
    console.log(
      `  ${String(i + 1).padStart(2)}  ${String(t.x).padStart(4)}  ${String(t.y).padStart(4)}  ` +
        `${fmt(t.meanAbsDiffLuma).padStart(15)}  ${fmt(t.hpFull).padStart(8)}  ` +
        `${fmt(t.hpFast).padStart(8)}  ${fmt(t.hpRatio).padStart(8)}`,
    );
  }

  // --- Write outputs -------------------------------------------------------
  mkdirSync(outAbs, { recursive: true });

  const result = {
    generatedAt: new Date().toISOString(),
    source: {
      file: source.file,
      width: source.width,
      height: source.height,
      metrics: source.metrics,
    },
    full: fullRows,
    fast: fastRows,
    final,
  };

  const metricsPath = path.join(outAbs, 'metrics.json');
  writeFileSync(metricsPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  const artifacts = writeArtifacts(outAbs, fullFinalAbs, fastFinalAbs, sourceAbs, final);

  console.log('\nWrote:');
  console.log(`  ${metricsPath}`);
  console.log(`  ${artifacts.overviewAbs}`);
  console.log(`  ${artifacts.heatmapAbs}`);
  for (const crop of artifacts.cropPaths) console.log(`  ${crop}`);
}

try {
  main();
} catch (err) {
  console.error(`Analysis failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
