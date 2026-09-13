import { describe, expect, it } from 'vitest';
import {
  foldFrequency,
  idealBoxMtf,
  makeGrating,
  makeStepEdge,
  measureEdgeResponse,
  measureFundamental,
  mtfFromPair,
} from './signal';
import { referenceDownscale } from './downscale';

/** Build an RGBA grayscale image from a per-pixel value function. */
function grayImage(
  width: number,
  height: number,
  valueAt: (x: number, y: number) => number,
): { width: number; height: number; data: Uint8Array } {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const value = valueAt(x, y);
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return { width, height, data };
}

/**
 * Local DEV/TEST helper (moved out of the production `signal` module): a
 * single-pixel impulse train at a fixed spacing (grayscale). Used to probe
 * sub-period / broadband behaviour when a pure tone cannot represent it.
 */
function makeImpulseTrain(options: {
  width: number;
  height: number;
  period: number;
  axis?: 'x' | 'y';
  dc?: number;
  amplitude?: number;
}): { width: number; height: number; data: Uint8Array } {
  const { width, height, period, axis = 'x', dc = 96, amplitude = 64 } = options;
  if (!(period > 0)) throw new Error(`makeImpulseTrain: period must be > 0 (got ${period})`);
  return grayImage(width, height, (x, y) => {
    const n = axis === 'x' ? x : y;
    return n % period === 0 ? dc + amplitude : dc;
  });
}

describe('makeGrating / measureFundamental', () => {
  it('produces the requested DC level and fundamental amplitude', () => {
    const image = makeGrating({ width: 128, height: 8, period: 8, dc: 128, amplitude: 60 });

    let sum = 0;
    for (let i = 0; i < image.data.length; i += 4) sum += image.data[i];
    expect(sum / (image.width * image.height)).toBeCloseTo(128, 0);

    expect(measureFundamental(image, { period: 8, axis: 'x' })).toBeCloseTo(60, 0);
  });

  it('measures the same fundamental regardless of the DC offset', () => {
    const low = makeGrating({ width: 128, height: 8, period: 8, dc: 80, amplitude: 50 });
    const high = makeGrating({ width: 128, height: 8, period: 8, dc: 170, amplitude: 50 });

    const a = measureFundamental(low, { period: 8, axis: 'x' });
    const b = measureFundamental(high, { period: 8, axis: 'x' });

    expect(a).toBeCloseTo(50, 0);
    expect(b).toBeCloseTo(50, 0);
    expect(Math.abs(a - b)).toBeLessThan(0.5);
  });

  it('ignores harmonics: an off-period probe reports ~zero', () => {
    const image = makeGrating({ width: 128, height: 8, period: 8, dc: 128, amplitude: 60 });

    expect(measureFundamental(image, { period: 5, axis: 'x' })).toBeLessThan(2);
  });

  it('works along the y axis', () => {
    const image = makeGrating({
      width: 8,
      height: 128,
      period: 8,
      axis: 'y',
      dc: 128,
      amplitude: 40,
    });

    expect(measureFundamental(image, { period: 8, axis: 'y' })).toBeCloseTo(40, 0);
  });

  it('resolves the Nyquist period 2 at full amplitude', () => {
    const image = makeGrating({ width: 128, height: 8, period: 2, dc: 128, amplitude: 60 });

    // A period-2 cosine alternates 188 / 68; the projection must not halve it.
    const row = Array.from({ length: 4 }, (_, x) => image.data[(2 * 128 + x) * 4]);
    expect(row).toEqual([188, 68, 188, 68]);
    expect(measureFundamental(image, { period: 2, axis: 'x' })).toBeCloseTo(60, 0);
  });

  it('rejects a non-positive period', () => {
    expect(() => makeGrating({ width: 8, height: 8, period: 0 })).toThrow(/period/);
    expect(() => measureFundamental(makeGrating({ width: 8, height: 8, period: 8 }), {
      period: 0,
      axis: 'x',
    })).toThrow(/positive period/);
  });
});

describe('idealBoxMtf', () => {
  it('nulls output Nyquist at ratio 2 / period 2', () => {
    expect(idealBoxMtf(2, 2)).toBeLessThan(1e-9);
  });

  it('matches known box values', () => {
    // ratio 2, period 4 -> output frequency 0.5 -> sinc(0.5) = 2/pi.
    expect(idealBoxMtf(2, 4)).toBeCloseTo(2 / Math.PI, 6);
    // ratio 4/3, period 2 -> output frequency 2/3.
    expect(idealBoxMtf(4 / 3, 2)).toBeCloseTo(Math.sin((2 * Math.PI) / 3) / ((2 * Math.PI) / 3), 6);
  });

  it('approaches unity as the ratio shrinks or the period grows', () => {
    expect(idealBoxMtf(2, 1000)).toBeGreaterThan(0.999);
    expect(idealBoxMtf(0.01, 2)).toBeCloseTo(1, 3);
  });

  it('rejects invalid arguments', () => {
    expect(() => idealBoxMtf(0, 4)).toThrow(/ratio/);
    expect(() => idealBoxMtf(2, 0)).toThrow(/period/);
  });
});

describe('makeStepEdge / measureEdgeResponse', () => {
  it('builds a monotonic two-level step', () => {
    const image = makeStepEdge({ width: 16, height: 4, low: 10, high: 200 });

    const row = Array.from({ length: 16 }, (_, x) => image.data[(2 * 16 + x) * 4]);
    for (let x = 1; x < row.length; x++) expect(row[x]).toBeGreaterThanOrEqual(row[x - 1]);
    expect(new Set(row).size).toBe(2);
    expect(row[0]).toBe(10);
    expect(row[row.length - 1]).toBe(200);
  });

  it('reports zero ringing on a monotonic step', () => {
    const image = makeStepEdge({ width: 32, height: 8, low: 32, high: 224 });

    const response = measureEdgeResponse(image, { axis: 'x', low: 32, high: 224 });

    expect(response.overshootPct).toBe(0);
    expect(response.undershootPct).toBe(0);
  });

  it('reports overshoot and undershoot on a ringing profile', () => {
    // Step at x=16 with a +16 overshoot just after and a -16 undershoot just before.
    const image = grayImage(32, 4, (x) => {
      if (x === 15) return 16; // undershoot below low=32
      if (x === 16) return 240; // overshoot above high=224
      return x < 16 ? 32 : 224;
    });

    const response = measureEdgeResponse(image, { axis: 'x', low: 32, high: 224, margin: 4 });

    expect(response.maxOvershoot).toBe(16);
    expect(response.maxUndershoot).toBe(16);
    expect(response.overshootPct).toBeCloseTo((100 * 16) / 192, 6);
    expect(response.undershootPct).toBeCloseTo((100 * 16) / 192, 6);
  });

  it('rejects a non-positive step', () => {
    expect(() => measureEdgeResponse(makeStepEdge({ width: 8, height: 8 }), {
      axis: 'x',
      low: 200,
      high: 100,
    })).toThrow(/exceed/);
  });
});

describe('makeImpulseTrain', () => {
  it('places single-pixel impulses at the requested spacing', () => {
    const image = makeImpulseTrain({ width: 16, height: 4, period: 4, dc: 96, amplitude: 64 });

    const row = Array.from({ length: 16 }, (_, x) => image.data[(2 * 16 + x) * 4]);
    expect(row.filter((value) => value === 160)).toHaveLength(4);
    expect(row.filter((value) => value === 96)).toHaveLength(12);
  });
});

describe('foldFrequency', () => {
  it('folds frequencies above Nyquist back into [0, 0.5]', () => {
    expect(foldFrequency(0.25)).toBeCloseTo(0.25, 12);
    expect(foldFrequency(0.75)).toBeCloseTo(0.25, 12);
    expect(foldFrequency(1.0)).toBe(0);
  });
});

describe('mtfFromPair', () => {
  it('returns ~1 for an identity pass at ratio 1', () => {
    const input = makeGrating({ width: 128, height: 8, period: 8 });
    const retention = mtfFromPair(input, input, { ratio: 1, period: 8, axis: 'x' });

    expect(retention).not.toBeNull();
    expect(retention as number).toBeCloseTo(1, 2);
  });

  it('tracks the ideal box within a few percent on a real downscale', () => {
    const input = makeGrating({ width: 256, height: 8, period: 16, dc: 128, amplitude: 60 });
    const output = referenceDownscale(input.data, 256, 8, 128, 4);

    const retention = mtfFromPair(input, { width: 128, height: 4, data: output }, {
      ratio: 2,
      period: 16,
      axis: 'x',
    });

    expect(retention).not.toBeNull();
    expect(retention as number).toBeGreaterThan(0.85);
    expect(retention as number).toBeCloseTo(idealBoxMtf(2, 16), 1);
  });

  it('returns null when the fundamental aliases onto DC', () => {
    const input = makeGrating({ width: 128, height: 8, period: 2, dc: 128, amplitude: 60 });
    const output = referenceDownscale(input.data, 128, 8, 64, 4);

    const retention = mtfFromPair(input, { width: 64, height: 4, data: output }, {
      ratio: 2,
      period: 2,
      axis: 'x',
    });

    expect(retention).toBeNull();
  });
});
