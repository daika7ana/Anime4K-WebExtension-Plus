import { describe, expect, it } from 'vitest';
import { compareRgba, formatComparison, type RgbaComparison } from './compare';

describe('compareRgba', () => {
  it('reports all-zero metrics and Infinity psnr for identical buffers', () => {
    const buffer = new Uint8Array([0, 1, 2, 255, 10, 20, 30, 255]);

    const cmp = compareRgba(buffer, buffer.slice());

    expect(cmp).toEqual({
      maxAbs: 0,
      meanAbs: 0,
      p99Abs: 0,
      mismatchCount: 0,
      psnr: Infinity,
      worstPixel: null,
    });
  });

  it('computes per-channel differences, mean, mismatch count and psnr', () => {
    const expected = new Uint8Array([0, 0, 0, 255]);
    const actual = new Uint8Array([1, 0, 2, 255]);

    const cmp = compareRgba(expected, actual);

    expect(cmp.maxAbs).toBe(2);
    expect(cmp.mismatchCount).toBe(2);
    expect(cmp.meanAbs).toBeCloseTo((1 + 0 + 2 + 0) / 4, 10);
    // mse = (1 + 0 + 4 + 0) / 4 = 1.25
    expect(cmp.psnr).toBeCloseTo(10 * Math.log10((255 * 255) / 1.25), 10);
    expect(cmp.worstPixel).toEqual({
      index: 0,
      expected: [0, 0, 0, 255],
      actual: [1, 0, 2, 255],
    });
  });

  it('uses nearest-rank p99 (a single large outlier is not p99 for large N)', () => {
    const expected = new Uint8Array(100);
    const actual = new Uint8Array(100);
    actual[0] = 7;

    const cmp = compareRgba(expected, actual);

    // rank = ceil(0.99 * 100) - 1 = 98 -> the 99th smallest value is still 0.
    expect(cmp.p99Abs).toBe(0);
    expect(cmp.maxAbs).toBe(7);
  });

  it('reports p99 equal to the common difference when every channel differs', () => {
    const expected = new Uint8Array(100);
    const actual = new Uint8Array(100).fill(5);

    const cmp = compareRgba(expected, actual);

    expect(cmp.p99Abs).toBe(5);
    expect(cmp.maxAbs).toBe(5);
    expect(cmp.mismatchCount).toBe(100);
  });

  it('locates the first pixel with the maximum difference', () => {
    const expected = new Uint8Array([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
    const actual = new Uint8Array([0, 0, 0, 255, 9, 0, 0, 255, 9, 0, 0, 255]);

    const cmp = compareRgba(expected, actual);

    expect(cmp.worstPixel?.index).toBe(1);
    expect(cmp.worstPixel?.expected).toEqual([0, 0, 0, 255]);
    expect(cmp.worstPixel?.actual).toEqual([9, 0, 0, 255]);
  });

  it('returns zeroed metrics for empty buffers', () => {
    const cmp = compareRgba(new Uint8Array(0), new Uint8Array(0));

    expect(cmp.psnr).toBe(Infinity);
    expect(cmp.worstPixel).toBeNull();
    expect(cmp.meanAbs).toBe(0);
  });

  it('throws on a buffer length mismatch', () => {
    expect(() => compareRgba(new Uint8Array(4), new Uint8Array(8))).toThrow(/length mismatch/);
  });
});

describe('formatComparison', () => {
  it('renders a one-line summary including label, metrics and worst pixel', () => {
    const cmp: RgbaComparison = {
      maxAbs: 2,
      meanAbs: 0.25,
      p99Abs: 1,
      mismatchCount: 3,
      psnr: 42.5,
      worstPixel: { index: 5, expected: [1, 2, 3, 255], actual: [3, 2, 3, 255] },
    };

    const summary = formatComparison('cas-default', cmp);

    expect(summary).toContain('cas-default');
    expect(summary).toContain('maxAbs=2');
    expect(summary).toContain('meanAbs=0.2500');
    expect(summary).toContain('p99Abs=1');
    expect(summary).toContain('mismatches=3');
    expect(summary).toContain('psnr=42.50dB');
    expect(summary).toContain('worstPixel#5');
  });

  it('renders Infinity psnr for identical buffers', () => {
    const cmp = compareRgba(new Uint8Array(4), new Uint8Array(4));

    expect(formatComparison('cas-identity', cmp)).toContain('psnr=Infinity');
  });
});
