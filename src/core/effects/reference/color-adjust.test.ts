import { describe, expect, it } from 'vitest';
import { referenceColorAdjust, type ColorAdjustParams } from './color-adjust';

/** Build an RGBA8 buffer from a per-pixel [r,g,b] list; alpha is forced to 255. */
function buildRgba(pixels: [number, number, number][]): Uint8Array {
  const out = new Uint8Array(pixels.length * 4);
  pixels.forEach(([r, g, b], index) => {
    out[index * 4] = r;
    out[index * 4 + 1] = g;
    out[index * 4 + 2] = b;
    out[index * 4 + 3] = 255;
  });
  return out;
}

/** Deterministic pseudo-random RGBA8 buffer (alpha forced to 255). */
function noisyBuffer(width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < out.length; i++) out[i] = (i * 53 + 29) % 256;
  for (let p = 3; p < out.length; p += 4) out[p] = 255;
  return out;
}

/** Neutral ("no grading") parameters. */
const NEUTRAL: ColorAdjustParams = {
  brightness: 0,
  gamma: 1,
  contrast: 1,
  saturation: 1,
  vibrance: 0,
  exposure: 0,
};

function withParams(overrides: Partial<ColorAdjustParams>): ColorAdjustParams {
  return { ...NEUTRAL, ...overrides };
}

function expectIntegralInRange(buffer: Uint8Array): void {
  for (const value of buffer) {
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(255);
  }
}

describe('referenceColorAdjust', () => {
  it('is the exact identity at neutral params', () => {
    const width = 8;
    const height = 6;
    const input = noisyBuffer(width, height);

    const output = referenceColorAdjust(input, width, height, NEUTRAL);

    expect(output).toEqual(input);
  });

  it('matches a hand-computed exposure case: 128 at -1 stop -> 64', () => {
    // 128/255 * 2^-1 = 0.2509804 -> round(64) = 64 exactly.
    const input = buildRgba([[128, 128, 128]]);

    const output = referenceColorAdjust(input, 1, 1, withParams({ exposure: -1 }));

    expect(Array.from(output)).toEqual([64, 64, 64, 255]);
  });

  it('matches a hand-computed additive brightness case: black + 0.25 -> 64', () => {
    const input = buildRgba([[0, 0, 0]]);

    const output = referenceColorAdjust(input, 1, 1, withParams({ brightness: 0.25 }));

    expect(Array.from(output)).toEqual([64, 64, 64, 255]);
  });

  it('is parameter-sensitive to gamma (brightens/darkens midtones)', () => {
    const input = buildRgba([[128, 128, 128]]);

    const darker = referenceColorAdjust(input, 1, 1, withParams({ gamma: 0.5 }));
    const neutral = referenceColorAdjust(input, 1, 1, NEUTRAL);
    const brighter = referenceColorAdjust(input, 1, 1, withParams({ gamma: 2 }));

    expect(darker[0]).toBeLessThan(neutral[0]);
    expect(brighter[0]).toBeGreaterThan(neutral[0]);
  });

  it('is parameter-sensitive to saturation (0 collapses to luminance)', () => {
    const input = buildRgba([[200, 100, 50]]);

    const output = referenceColorAdjust(input, 1, 1, withParams({ saturation: 0 }));

    expect(output[0]).toBe(output[1]);
    expect(output[1]).toBe(output[2]);
    // BT.709 luminance of (200,100,50) is ~117.65 -> round 118.
    expect(output[0]).toBe(118);
    expect(Array.from(output)).not.toEqual(Array.from(input));
  });

  it('is parameter-sensitive to contrast (0 -> mid gray)', () => {
    const input = buildRgba([[200, 100, 50]]);

    const output = referenceColorAdjust(input, 1, 1, withParams({ contrast: 0 }));

    expect(Array.from(output)).toEqual([128, 128, 128, 255]);
  });

  it('is parameter-sensitive to vibrance on a low-saturation pixel', () => {
    const input = buildRgba([[130, 125, 120]]);

    const output = referenceColorAdjust(input, 1, 1, withParams({ vibrance: 1 }));

    expect(Array.from(output)).not.toEqual(Array.from(input));
  });

  it('actually changes a colored input at non-neutral params (oracle is not a no-op)', () => {
    const width = 12;
    const height = 8;
    const input = noisyBuffer(width, height);

    const output = referenceColorAdjust(input, width, height, withParams({
      brightness: 0.05,
      gamma: 1.2,
      contrast: 1.1,
      saturation: 1.2,
      vibrance: 0.3,
      exposure: 0.25,
    }));

    expect(Array.from(output)).not.toEqual(Array.from(input));
  });

  it('never produces NaN/Inf, stays integral and in [0,255] across a sweep', () => {
    const width = 9;
    const height = 7;
    const input = noisyBuffer(width, height);
    const gammas = [0, 0.0001, 0.5, 1, 2.2, 4];
    const exposures = [-3, -1, 0, 1, 3];

    for (const gamma of gammas) {
      for (const exposure of exposures) {
        const output = referenceColorAdjust(input, width, height, withParams({
          brightness: -1,
          gamma,
          contrast: 2,
          saturation: 2,
          vibrance: 1,
          exposure,
        }));
        expect(output).toHaveLength(width * height * 4);
        expectIntegralInRange(output);
        for (let p = 3; p < output.length; p += 4) expect(output[p]).toBe(255);
      }
    }
  });

  it('rejects invalid dimensions and mismatched input length', () => {
    expect(() => referenceColorAdjust(new Uint8Array(0), 0, 1, NEUTRAL)).toThrow(/dimensions/);
    expect(() => referenceColorAdjust(new Uint8Array(4), 2, 2, NEUTRAL)).toThrow(/input length/);
  });
});
