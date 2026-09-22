// Shared PNG decode + luma metric helpers for the analyze-*.mjs diagnostics.
//
// Every helper here is a byte-for-byte extraction of a copy that was previously
// inlined in analyze-roi.mjs / analyze-pass-dump.mjs / analyze-gate-calibration.mjs,
// so importing them preserves the scripts' output exactly. Node builtins only.

import { execFileSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { closeSync, openSync, readSync } from 'node:fs';

const MAX_BUFFER = 80 * 1024 * 1024;

/** Read PNG pixel dimensions from the IHDR chunk (bytes 16..24, big-endian). */
export function readPngSize(pngPath) {
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
export function decodeRgba(pngPath, width, height) {
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

/** Normalized Rec.709 luma in [0, 1] over a `width*height` RGBA buffer. */
export function computeLuma(rgba, width, height) {
  const n = width * height;
  const y = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i += 1, j += 4) {
    y[i] = (0.2126 * rgba[j] + 0.7152 * rgba[j + 1] + 0.0722 * rgba[j + 2]) / 255;
  }
  return y;
}

/**
 * Separable O(N) box blur with clamped (replicated) edges. Returns a radius-r
 * mean field; horizontal then vertical sliding windows.
 */
export function boxBlur(src, width, height, radius) {
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

/** Format a metric for the console tables (`n/a` for null/undefined). */
export function fmt(value, digits = 6) {
  if (value === null || value === undefined) return 'n/a';
  if (!Number.isFinite(value)) return String(value);
  return value.toFixed(digits);
}
