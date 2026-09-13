#!/usr/bin/env node
/* global console, process, URL */
// Diagnostic: crop a user-specified axis-aligned ROI out of every pass of one
// or more A+A-ultra pass-dump chains, build labelled filmstrips, and compute
// per-pass ROI luma metrics to localize where a thin wing contour loses
// contrast. The built-in set is the Fast-mode toggle ON vs OFF pair; override
// with ROI_CHAINS (comma list of `label=relativeDir`). The two-chain final diff
// is only computed for the built-in pair; any other set skips it.
//
// Read-only with respect to the repository: it only reads the existing dump
// dirs and writes into new subdirectories of videoframe_497385_analysis/.
//
// The same ROI is interpreted in TWO reference frames (the ROI coordinates are
// meaningful in whichever full-frame resolution the user was looking at):
//   - "source": spaceWidth = 1920 (the 1920x1080 source frame)
//   - "2k":     spaceWidth = 2560 (the 2560x1440 render target)
// For each pass of width `passWidth`, scale = passWidth / spaceWidth and the ROI
// is mapped/clamped into the pass.
//
// Prerequisites: ImageMagick 6 `convert` on PATH (raw RGBA decode + artifacts).
//
// Usage:
//   node scripts/analyze-roi.mjs
//
// Exit codes:
//   0  analysis completed, metrics.json + artifacts written
//   1  an input artifact was missing or malformed

import { execFileSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const ANALYSIS_DIR = path.join(rootDir, 'videoframe_497385_analysis');

// Built-in chain pair (dirs relative to the repo root). `on` = Fast mode /
// preserve detail ON. Override the set of chains to score with ROI_CHAINS, a
// comma list of `label=relativeDir` entries (e.g.
// `baseline=videoframe_497385_toggle-on/A+A-ultra,cnnvl=videoframe_497385_ab/on-cnnvl`).
const DEFAULT_CHAINS = [
  { label: 'on', dir: 'videoframe_497385_toggle-on/A+A-ultra' },
  { label: 'off', dir: 'videoframe_497385_toggle-off/A+A-ultra' },
];

/**
 * Resolve the chain list. With ROI_CHAINS unset the built-in on/off pair is
 * used (and the final-diff section stays enabled). When ROI_CHAINS is set to
 * anything other than the default pair, `isDefaultPair` is false so the
 * two-chain final diff is skipped instead of crashing.
 */
function parseChains() {
  const raw = process.env.ROI_CHAINS;
  if (raw === undefined || raw.trim() === '') {
    return { chains: DEFAULT_CHAINS, isDefaultPair: true };
  }
  const chains = raw.split(',').map((entry) => {
    const trimmed = entry.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      throw new Error(`invalid ROI_CHAINS entry "${trimmed}" (expected label=relativeDir)`);
    }
    const label = trimmed.slice(0, eq).trim();
    const dir = trimmed.slice(eq + 1).trim();
    if (!label || !dir) {
      throw new Error(`invalid ROI_CHAINS entry "${trimmed}" (expected label=relativeDir)`);
    }
    return { label, dir };
  });
  if (chains.length === 0) throw new Error('ROI_CHAINS did not contain any entries');
  const isDefaultPair = chains.length === DEFAULT_CHAINS.length
    && chains.every((chain, i) => (
      chain.label === DEFAULT_CHAINS[i].label && chain.dir === DEFAULT_CHAINS[i].dir
    ));
  return { chains, isDefaultPair };
}

const { chains: CHAINS, isDefaultPair: IS_DEFAULT_PAIR } = parseChains();

// User-specified rectangle in the interpretation's reference frame. The defaults
// are the original wing ROI; override without editing the script via
// ROI_LABEL / ROI_X0 / ROI_Y0 / ROI_X1 / ROI_Y1 and ROI_INTERPRETATIONS
// (a comma list of `source`, `2k`).
const ROI_LABEL = process.env.ROI_LABEL ?? 'wing';
const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const ROI = {
  x0: num(process.env.ROI_X0, 475),
  y0: num(process.env.ROI_Y0, 655),
  x1: num(process.env.ROI_X1, 560),
  y1: num(process.env.ROI_Y1, 820),
};
const ROI_WIDTH = ROI.x1 - ROI.x0; // 85
const ROI_HEIGHT = ROI.y1 - ROI.y0; // 165

// Coordinate interpretations, selectable via ROI_INTERPRETATIONS.
const ALL_INTERPRETATIONS = {
  source: { tag: 'source', spaceWidth: 1920 },
  '2k': { tag: '2k', spaceWidth: 2560 },
};
const INTERPRETATIONS = (process.env.ROI_INTERPRETATIONS ?? 'source,2k')
  .split(',')
  .map((tag) => tag.trim())
  .filter(Boolean)
  .map((tag) => {
    const interp = ALL_INTERPRETATIONS[tag];
    if (!interp) throw new Error(`unknown ROI interpretation "${tag}"`);
    return interp;
  });

// Fixed filmstrip tile size: 6x the ROI in each axis.
const DISPLAY_WIDTH = 6 * ROI_WIDTH; // 510
const DISPLAY_HEIGHT = 6 * ROI_HEIGHT; // 990
const MIN_ROI_PIXELS = 8;

// Whole-frame metric border trim (mirrors analyze-pass-dump.mjs).
const FRAME_MARGIN = 4;

const MAX_BUFFER = 80 * 1024 * 1024;

// --- Inputs ----------------------------------------------------------------

/** Numeric pass prefix of a dump filename (`NN-...png`). */
function passNumber(file) {
  return Number(file.slice(0, file.indexOf('-')));
}

/** Pass label derived from the filename (e.g. `CNNUL-0`, `ClampHighlightsApply`). */
function passLabel(file) {
  return file
    .replace(/^\d+-/, '')
    .replace(/-\d+x\d+\.png$/, '')
    .replace(/\.png$/, '');
}

/** Dump PNG filenames in `<dir>`, ordered by numeric prefix. */
function listPassFiles(dirAbs) {
  return readdirSync(dirAbs)
    .filter((name) => /^\d+-.*\.png$/.test(name))
    .sort((a, b) => passNumber(a) - passNumber(b));
}

/** Read PNG pixel dimensions from the IHDR chunk (bytes 16..24, big-endian). */
function readPngSize(pngPath) {
  const header = Buffer.alloc(24);
  const fd = openSync(pngPath, 'r');
  try {
    if (readSync(fd, header, 0, 24, 0) < 24) throw new Error(`PNG too small: ${pngPath}`);
  } finally {
    closeSync(fd);
  }
  if (header.subarray(0, 8).toString('latin1') !== '\x89PNG\r\n\x1a\n') {
    throw new Error(`Not a PNG: ${pngPath}`);
  }
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

/** Decode an 8-bit RGBA PNG to a tightly-packed RGBA byte buffer. */
function decodeRgba(pngPath, width, height) {
  const raw = execFileSync('convert', [pngPath, '-depth', '8', 'rgba:-'], {
    maxBuffer: MAX_BUFFER,
  });
  const expected = width * height * 4;
  if (raw.length !== expected) {
    throw new Error(
      `Decoded ${pngPath} to ${raw.length} bytes, expected ${expected} (${width}x${height}x4).`,
    );
  }
  return raw;
}

// --- ROI mapping -----------------------------------------------------------

/** Map the reference-frame ROI into a `passWidth`-wide pass, clamped in bounds. */
function mapRoi(passWidth, passHeight, spaceWidth) {
  const scale = passWidth / spaceWidth;
  const x = Math.max(0, Math.min(Math.round(ROI.x0 * scale), passWidth - MIN_ROI_PIXELS));
  const y = Math.max(0, Math.min(Math.round(ROI.y0 * scale), passHeight - MIN_ROI_PIXELS));
  const width = Math.max(
    MIN_ROI_PIXELS,
    Math.min(Math.round(ROI_WIDTH * scale), passWidth - x),
  );
  const height = Math.max(
    MIN_ROI_PIXELS,
    Math.min(Math.round(ROI_HEIGHT * scale), passHeight - y),
  );
  return { x, y, width, height };
}

/** Copy the ROI out of a full-pass RGBA buffer into a compact RGBA buffer. */
function sliceRoi(rgba, passWidth, roi) {
  const out = new Uint8Array(roi.width * roi.height * 4);
  const rowBytes = roi.width * 4;
  for (let row = 0; row < roi.height; row += 1) {
    const src = ((roi.y + row) * passWidth + roi.x) * 4;
    out.set(rgba.subarray(src, src + rowBytes), row * rowBytes);
  }
  return out;
}

// --- Luma + metrics --------------------------------------------------------

/** Normalized Rec.709 luma in [0, 1] over a compact RGBA buffer. */
function computeLuma(rgba, pixelCount) {
  const y = new Float32Array(pixelCount);
  for (let i = 0, j = 0; i < pixelCount; i += 1, j += 4) {
    y[i] = (0.2126 * rgba[j] + 0.7152 * rgba[j + 1] + 0.0722 * rgba[j + 2]) / 255;
  }
  return y;
}

/**
 * Separable O(N) box blur with clamped (replicated) edges. Returns a radius-r
 * mean field; horizontal then vertical sliding windows.
 */
function boxBlur(src, width, height, radius) {
  const tmp = new Float32Array(width * height);
  const dst = new Float32Array(width * height);
  const prefix = new Float64Array(Math.max(width, height) + 1);

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let sum = 0;
    prefix[0] = 0;
    for (let x = 0; x < width; x += 1) {
      sum += src[row + x];
      prefix[x + 1] = sum;
    }
    for (let x = 0; x < width; x += 1) {
      let lo = x - radius;
      if (lo < 0) lo = 0;
      let hi = x + radius;
      if (hi > width - 1) hi = width - 1;
      tmp[row + x] = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
    }
  }

  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    prefix[0] = 0;
    for (let y = 0; y < height; y += 1) {
      sum += tmp[y * width + x];
      prefix[y + 1] = sum;
    }
    for (let y = 0; y < height; y += 1) {
      let lo = y - radius;
      if (lo < 0) lo = 0;
      let hi = y + radius;
      if (hi > height - 1) hi = height - 1;
      dst[y * width + x] = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
    }
  }

  return dst;
}

function median(values) {
  const sorted = Float32Array.from(values);
  sorted.sort();
  const n = sorted.length;
  const mid = n >> 1;
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Whole-ROI luma metrics on the native-resolution ROI pixels. */
function computeRoiMetrics(luma, width, height) {
  const box3 = boxBlur(luma, width, height, 1);
  const box9 = boxBlur(luma, width, height, 4);
  const n = width * height;

  let sumY = 0;
  let sumY2 = 0;
  let sumHp = 0;
  let sumFine = 0;
  let sumMid = 0;
  let minY = Infinity;

  for (let yy = 0; yy < height; yy += 1) {
    const row = yy * width;
    for (let xx = 0; xx < width; xx += 1) {
      const i = row + xx;
      const v = luma[i];
      sumY += v;
      sumY2 += v * v;

      const hp = v - box3[i];
      sumHp += hp * hp;
      const mid = box3[i] - box9[i];
      sumMid += mid * mid;

      const up = yy > 0 ? luma[i - width] : v;
      const down = yy < height - 1 ? luma[i + width] : v;
      const left = xx > 0 ? luma[i - 1] : v;
      const right = xx < width - 1 ? luma[i + 1] : v;
      const lap = 4 * v - up - down - left - right;
      sumFine += lap * lap;

      if (v < minY) minY = v;
    }
  }

  const meanY = sumY / n;
  const variance = sumY2 / n - meanY * meanY;
  return {
    meanY,
    stdY: Math.sqrt(variance > 0 ? variance : 0),
    hpRMS: Math.sqrt(sumHp / n),
    fineRMS: Math.sqrt(sumFine / n),
    midRMS: Math.sqrt(sumMid / n),
    lineContrast: median(luma) - minY,
  };
}

/**
 * Whole-frame high-pass luma RMS (interior only, FRAME_MARGIN px trimmed) — the
 * `hpRMS` sharpness/noise proxy from analyze-pass-dump.mjs. Reuses the already
 * decoded full-frame RGBA so no extra ImageMagick decode is needed.
 */
function computeWholeFrameHpRMS(rgba, width, height) {
  const luma = computeLuma(rgba, width * height);
  const box3 = boxBlur(luma, width, height, 1);
  let sum = 0;
  let count = 0;
  for (let yy = FRAME_MARGIN; yy < height - FRAME_MARGIN; yy += 1) {
    const row = yy * width;
    for (let xx = FRAME_MARGIN; xx < width - FRAME_MARGIN; xx += 1) {
      const d = luma[row + xx] - box3[row + xx];
      sum += d * d;
      count += 1;
    }
  }
  return count === 0 ? null : Math.sqrt(sum / count);
}

// --- Per-pass analysis -----------------------------------------------------

/** Decode all passes of one chain for one interpretation, ROI metrics per pass. */
function analyzeChain(chainDirAbs, spaceWidth) {
  const dirAbs = path.join(rootDir, chainDirAbs);
  if (!existsSync(dirAbs)) throw new Error(`Missing chain dir: ${dirAbs}`);

  const passes = listPassFiles(dirAbs).map((file) => {
    const pngPath = path.join(dirAbs, file);
    const { width, height } = readPngSize(pngPath);
    const roi = mapRoi(width, height, spaceWidth);
    const rgba = decodeRgba(pngPath, width, height);
    const roiRgba = sliceRoi(rgba, width, roi);
    const luma = computeLuma(roiRgba, roi.width * roi.height);
    const metrics = computeRoiMetrics(luma, roi.width, roi.height);
    const wholeFrameHpRMS = computeWholeFrameHpRMS(rgba, width, height);
    return {
      pass: passNumber(file),
      file,
      label: passLabel(file),
      width,
      height,
      roi,
      metrics,
      wholeFrameHpRMS,
      luma,
    };
  });

  return passes;
}

/** First pass (index >= 1) whose metric drops below the previous pass's value. */
function firstDrop(passes, key) {
  for (let i = 1; i < passes.length; i += 1) {
    const previous = passes[i - 1];
    const current = passes[i];
    const delta = current.metrics[key] - previous.metrics[key];
    if (delta < 0) {
      return {
        pass: current.pass,
        label: current.label,
        fromPass: previous.pass,
        fromLabel: previous.label,
        previous: previous.metrics[key],
        current: current.metrics[key],
        delta,
      };
    }
  }
  return null;
}

// --- ImageMagick artifacts -------------------------------------------------

function runConvert(args) {
  execFileSync('convert', args, { maxBuffer: MAX_BUFFER });
}

function cropRoi(chainDirAbs, pass, outPath) {
  runConvert([
    path.join(rootDir, chainDirAbs, pass.file),
    '-crop', `${pass.roi.width}x${pass.roi.height}+${pass.roi.x}+${pass.roi.y}`,
    '+repage',
    '-depth', '8',
    outPath,
  ]);
}

/** One labelled filmstrip per chain: each pass ROI enlarged 6x, appended L->R. */
function buildFilmstrip(chainDirAbs, chainName, passes, outDirAbs) {
  const tmp = mkdtempSync(path.join(tmpdir(), `roi-${chainName}-`));
  try {
    const tilePaths = passes.map((pass, index) => {
      const tilePath = path.join(tmp, `tile-${String(index).padStart(2, '0')}.png`);
      const label = `${pass.label} ${pass.width}x${pass.height}`;
      runConvert([
        path.join(rootDir, chainDirAbs, pass.file),
        '-crop', `${pass.roi.width}x${pass.roi.height}+${pass.roi.x}+${pass.roi.y}`,
        '+repage',
        '-filter', 'point', '-resize', `${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}!`,
        '-background', 'black', '-fill', 'white',
        '-pointsize', '24', '-gravity', 'northwest',
        '-annotate', '+6+28', label,
        '-depth', '8',
        tilePath,
      ]);
      return tilePath;
    });

    const filmstripPath = path.join(outDirAbs, `filmstrip-${chainName}.png`);
    runConvert([...tilePaths, '+append', filmstripPath]);

    const listing = passes
      .map((pass, index) => `tile ${String(index + 1).padStart(2, '0')}  ${pass.label}  ${pass.width}x${pass.height}  (pass ${String(pass.pass).padStart(2, '0')})`)
      .join('\n');
    writeFileSync(path.join(outDirAbs, `filmstrip-${chainName}.txt`), `${listing}\n`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// --- Console formatting ----------------------------------------------------

function fmt(value, digits = 6) {
  if (value === null || value === undefined) return 'n/a';
  if (!Number.isFinite(value)) return String(value);
  return value.toFixed(digits);
}

function printTable(title, passes) {
  console.log(`\n${title}`);
  const header = [
    'pass', 'label', 'WxH', 'meanY', 'stdY', 'hpRMS', 'fineRMS', 'midRMS', 'lineContrast',
  ];
  const body = passes.map((pass) => [
    String(pass.pass).padStart(2, '0'),
    pass.label,
    `${pass.width}x${pass.height}`,
    fmt(pass.metrics.meanY),
    fmt(pass.metrics.stdY),
    fmt(pass.metrics.hpRMS),
    fmt(pass.metrics.fineRMS),
    fmt(pass.metrics.midRMS),
    fmt(pass.metrics.lineContrast),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
  const line = (cells) => cells
    .map((cell, i) => (i === 1 ? cell.padEnd(widths[i]) : cell.padStart(widths[i])))
    .join('  ');
  console.log(line(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of body) console.log(line(row));
}

function printFirstDrop(chainName, drops) {
  console.log(`  ${chainName}:`);
  for (const key of ['fineRMS', 'lineContrast']) {
    const drop = drops[key];
    if (drop) {
      console.log(
        `    first ${key} drop: ${drop.fromLabel} -> ${drop.label} `
        + `(${fmt(drop.previous)} -> ${fmt(drop.current)}, delta ${fmt(drop.delta)})`,
      );
    } else {
      console.log(`    first ${key} drop: none (monotonic non-decreasing)`);
    }
  }
}

function summarizeDrops(passes) {
  return {
    fineRMS: firstDrop(passes, 'fineRMS'),
    lineContrast: firstDrop(passes, 'lineContrast'),
  };
}

// --- Final ON vs OFF ROI difference ---------------------------------------

function computeFinalDiff(onPasses, offPasses) {
  const onFinal = onPasses[onPasses.length - 1];
  const offFinal = offPasses[offPasses.length - 1];

  // Both finals render at the target width, so the mapped ROI is identical.
  const sameRoi = onFinal.width === offFinal.width
    && onFinal.roi.x === offFinal.roi.x
    && onFinal.roi.y === offFinal.roi.y
    && onFinal.roi.width === offFinal.roi.width
    && onFinal.roi.height === offFinal.roi.height;
  if (!sameRoi) return null;

  const a = onFinal.luma;
  const b = offFinal.luma;
  let sumAbs = 0;
  let maxAbs = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = Math.abs(a[i] - b[i]);
    sumAbs += d;
    if (d > maxAbs) maxAbs = d;
  }

  const fineOn = onFinal.metrics.fineRMS;
  const fineOff = offFinal.metrics.fineRMS;
  return {
    onPass: onFinal.pass,
    onLabel: onFinal.label,
    offPass: offFinal.pass,
    offLabel: offFinal.label,
    roi: onFinal.roi,
    meanAbsDiffLuma: sumAbs / a.length,
    maxAbsDiffLuma: maxAbs,
    meanYOn: onFinal.metrics.meanY,
    meanYOff: offFinal.metrics.meanY,
    fineRMSOn: fineOn,
    fineRMSOff: fineOff,
    fineRMSRatioOnOverOff: fineOff === 0 ? null : fineOn / fineOff,
  };
}

// --- Main ------------------------------------------------------------------

/** Explicit JSON shape, dropping the non-serializable luma buffer. */
function serializePass(pass) {
  return {
    pass: pass.pass,
    file: pass.file,
    label: pass.label,
    width: pass.width,
    height: pass.height,
    roi: pass.roi,
    metrics: pass.metrics,
    wholeFrameHpRMS: pass.wholeFrameHpRMS,
  };
}

function analyzeInterpretation(interp) {
  const analyzed = CHAINS.map((chain) => {
    const passes = analyzeChain(chain.dir, interp.spaceWidth);
    return {
      label: chain.label,
      dir: chain.dir,
      passes,
      drops: summarizeDrops(passes),
    };
  });

  // `computeFinalDiff` assumes exactly two chains; only run it for the built-in
  // on/off pair. Any other ROI_CHAINS set skips the section.
  const finalDiff = IS_DEFAULT_PAIR && analyzed.length === 2
    ? computeFinalDiff(analyzed[0].passes, analyzed[1].passes)
    : null;

  const outDirAbs = path.join(ANALYSIS_DIR, `${ROI_LABEL}-roi-${interp.tag}`);
  mkdirSync(outDirAbs, { recursive: true });
  for (const chain of analyzed) {
    for (const pass of chain.passes) {
      const base = `pass-${String(pass.pass).padStart(2, '0')}-${pass.label}-roi.png`;
      // Custom chain sets can collide on generic labels (Downscale,
      // ClampHighlightsApply); prefix the chain label. The built-in pair keeps
      // its historical filenames.
      const name = IS_DEFAULT_PAIR ? base : `${chain.label}-${base}`;
      cropRoi(chain.dir, pass, path.join(outDirAbs, name));
    }
    buildFilmstrip(chain.dir, chain.label, chain.passes, outDirAbs);
  }

  const result = {
    interpretation: { tag: interp.tag, spaceWidth: interp.spaceWidth },
    roiReferenceFrame: ROI,
    chains: Object.fromEntries(
      analyzed.map((chain) => [
        chain.label,
        { passes: chain.passes.map(serializePass), firstDrop: chain.drops },
      ]),
    ),
    finalDiff,
  };
  writeFileSync(
    path.join(outDirAbs, 'metrics.json'),
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8',
  );

  return { analyzed, finalDiff, outDirAbs };
}

function main() {
  console.log(`A+A-ultra ${ROI_LABEL}-ROI analysis`);
  console.log(
    `  ROI: (${ROI.x0},${ROI.y0})-(${ROI.x1},${ROI.y1}) `
    + `= ${ROI_WIDTH}x${ROI_HEIGHT}`,
  );
  if (!IS_DEFAULT_PAIR) {
    console.log(`  chains: ${CHAINS.map((chain) => `${chain.label}=${chain.dir}`).join(', ')}`);
  }

  mkdirSync(ANALYSIS_DIR, { recursive: true });

  for (const interp of INTERPRETATIONS) {
    console.log(`\n=== Interpretation "${interp.tag}" (spaceWidth=${interp.spaceWidth}) ===`);
    const r = analyzeInterpretation(interp);

    for (const chain of r.analyzed) {
      printTable(`${chain.label.toUpperCase()} (${chain.dir})`, chain.passes);
    }

    console.log('\nFirst-drop summary:');
    for (const chain of r.analyzed) {
      printFirstDrop(chain.label.toUpperCase(), chain.drops);
    }

    if (IS_DEFAULT_PAIR) {
      console.log('\nFinal ON vs OFF ROI difference (aligned finals):');
      if (r.finalDiff) {
        const f = r.finalDiff;
        console.log(`  ${f.onLabel} (pass ${String(f.onPass).padStart(2, '0')}) vs ${f.offLabel} (pass ${String(f.offPass).padStart(2, '0')})`);
        console.log(`  roi            : ${f.roi.width}x${f.roi.height}+${f.roi.x}+${f.roi.y}`);
        console.log(`  meanAbsDiffLuma: ${fmt(f.meanAbsDiffLuma)}`);
        console.log(`  maxAbsDiffLuma : ${fmt(f.maxAbsDiffLuma)}`);
        console.log(`  meanY on/off   : ${fmt(f.meanYOn)} / ${fmt(f.meanYOff)}`);
        console.log(`  fineRMS on/off : ${fmt(f.fineRMSOn)} / ${fmt(f.fineRMSOff)}  ratio=${fmt(f.fineRMSRatioOnOverOff)}`);
      } else {
        console.log('  (skipped: final dims/ROIs not aligned)');
      }
    } else {
      console.log(
        '\nFinal chain difference: skipped (ROI_CHAINS overrides the built-in on/off pair)',
      );
    }

    console.log(`\nWrote ${path.join(r.outDirAbs, 'metrics.json')}`);
  }
}

try {
  main();
} catch (err) {
  console.error(`ROI analysis failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
