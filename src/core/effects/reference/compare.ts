/**
 * Numeric RGBA8 comparison helpers for the headless-WebGPU correctness gate.
 *
 * DEV/TEST ONLY. This module is imported by Vitest and by the Playwright GPU
 * spec through a relative path (outside the webpack `@`/`@core` alias graph).
 * Production code must never import it.
 */

/** Outcome of a per-channel integer comparison between two RGBA8 buffers. */
export interface RgbaComparison {
  /** Largest absolute per-channel difference (0 when identical). */
  maxAbs: number;
  /** Mean absolute per-channel difference. */
  meanAbs: number;
  /** Nearest-rank 99th percentile of the absolute per-channel differences. */
  p99Abs: number;
  /** Number of channels whose absolute difference is greater than zero. */
  mismatchCount: number;
  /** Peak signal-to-noise ratio in dB; `Infinity` when the buffers are identical. */
  psnr: number;
  /**
   * The first pixel with the largest absolute difference, or `null` when the
   * buffers are identical. `index` is the zero-based pixel index (byte offset
   * `index * 4`); the tuples are the four RGBA channels of that pixel.
   */
  worstPixel: {
    index: number;
    expected: [number, number, number, number];
    actual: [number, number, number, number];
  } | null;
}

const MAX_CHANNEL = 255;

function pixelAt(buffer: Uint8Array, pixelIndex: number): [number, number, number, number] {
  const offset = pixelIndex * 4;
  return [buffer[offset], buffer[offset + 1], buffer[offset + 2], buffer[offset + 3]];
}

/** Nearest-rank p99 over an ascending-sorted array. */
function nearestRank99(sortedAscending: readonly number[]): number {
  if (sortedAscending.length === 0) return 0;
  const rank = Math.ceil(0.99 * sortedAscending.length) - 1;
  const index = Math.max(0, Math.min(sortedAscending.length - 1, rank));
  return sortedAscending[index];
}

/**
 * Compare two equal-length RGBA8 buffers channel by channel.
 *
 * @throws if the buffers differ in length.
 */
export function compareRgba(expected: Uint8Array, actual: Uint8Array): RgbaComparison {
  if (expected.length !== actual.length) {
    throw new Error(
      `compareRgba: buffer length mismatch (expected ${expected.length}, actual ${actual.length})`,
    );
  }

  const length = expected.length;
  if (length === 0) {
    return {
      maxAbs: 0,
      meanAbs: 0,
      p99Abs: 0,
      mismatchCount: 0,
      psnr: Infinity,
      worstPixel: null,
    };
  }

  let maxAbs = 0;
  let sumAbs = 0;
  let sumSquared = 0;
  let mismatchCount = 0;
  let worstIndex = 0;
  let worstDiff = -1;
  const diffs = new Array<number>(length);

  for (let i = 0; i < length; i++) {
    const diff = Math.abs(expected[i] - actual[i]);
    diffs[i] = diff;
    if (diff > 0) mismatchCount += 1;
    if (diff > maxAbs) maxAbs = diff;
    sumAbs += diff;
    sumSquared += diff * diff;
    const index = i >> 2;
    if (diff > worstDiff) {
      worstDiff = diff;
      worstIndex = index;
    }
  }

  const meanAbs = sumAbs / length;
  diffs.sort((a, b) => a - b);
  const p99Abs = nearestRank99(diffs);
  const meanSquaredError = sumSquared / length;
  const psnr =
    meanSquaredError === 0
      ? Infinity
      : 10 * Math.log10((MAX_CHANNEL * MAX_CHANNEL) / meanSquaredError);

  const worstPixel =
    maxAbs === 0
      ? null
      : {
          index: worstIndex,
          expected: pixelAt(expected, worstIndex),
          actual: pixelAt(actual, worstIndex),
        };

  return { maxAbs, meanAbs, p99Abs, mismatchCount, psnr, worstPixel };
}

/** Render a one-line human summary suitable for an assertion message. */
export function formatComparison(label: string, cmp: RgbaComparison): string {
  const psnr = cmp.psnr === Infinity ? 'Infinity' : `${cmp.psnr.toFixed(2)}dB`;
  const worst = cmp.worstPixel
    ? ` worstPixel#${cmp.worstPixel.index} expected=[${cmp.worstPixel.expected.join(',')}]`
      + ` actual=[${cmp.worstPixel.actual.join(',')}]`
    : '';
  return (
    `${label}: maxAbs=${cmp.maxAbs} meanAbs=${cmp.meanAbs.toFixed(4)}`
    + ` p99Abs=${cmp.p99Abs} mismatches=${cmp.mismatchCount} psnr=${psnr}${worst}`
  );
}
