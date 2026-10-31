import { describe, expect, it } from 'vitest';
import { referenceDebanding } from './debanding';

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
  for (let i = 0; i < out.length; i++) out[i] = (i * 89 + 17) % 256;
  for (let p = 3; p < out.length; p += 4) out[p] = 255;
  return out;
}

/** Smooth horizontal ramp that spans shallow luminance steps (banding-prone). */
function ramp(width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = 16 + Math.round((x / Math.max(width - 1, 1)) * 223);
      const offset = (y * width + x) * 4;
      out[offset] = value;
      out[offset + 1] = value;
      out[offset + 2] = value;
      out[offset + 3] = 255;
    }
  }
  return out;
}

function expectIntegralInRange(buffer: Uint8Array): void {
  for (const value of buffer) {
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(255);
  }
}

describe('referenceDebanding', () => {
  it('is the exact identity at strength 0', () => {
    const width = 9;
    const height = 7;
    const input = noisyBuffer(width, height);

    const output = referenceDebanding(input, width, height, {
      strength: 0,
      bandThreshold: 0.08,
    });

    expect(output).toEqual(input);
  });

  it('matches a hand-computed 2x1 case (neighborhood average + clamp)', () => {
    // [128, 255]. At pixel 0: e=128/255, avg=5.01176/8=0.62647,
    // diff=0.12451, threshold 0.5 -> bandMask=0.844831, bayer(0,0)=-0.9375.
    // offset = -0.9375 * 0.015 * 0.844831 = -0.0118834
    // result = 0.501961 - 0.0118834 = 0.490077 -> round(124.9697) = 125.
    // Pixel 1: dither +0.000792 clamps to 1.0 -> 255.
    const input = buildRgba([
      [128, 128, 128],
      [255, 255, 255],
    ]);

    const output = referenceDebanding(input, 2, 1, { strength: 1, bandThreshold: 0.5 });

    expect(Array.from(output)).toEqual([125, 125, 125, 255, 255, 255, 255, 255]);
  });

  it('applies a deterministic per-pixel dither on a flat image', () => {
    // On flat content diff=0, so bandMask=1 everywhere and the Bayer offset is
    // the only effect. Pixel (0,0) has dither -0.9375 -> 128 - 3.586 -> 124.
    const input = buildRgba([
      [128, 128, 128], [128, 128, 128],
      [128, 128, 128], [128, 128, 128],
    ]);

    const strengthOne = referenceDebanding(input, 2, 2, { strength: 1, bandThreshold: 0.08 });

    expect(strengthOne[0]).toBe(124);
    // Determinism: same input -> same output.
    expect(referenceDebanding(input, 2, 2, { strength: 1, bandThreshold: 0.08 }))
      .toEqual(strengthOne);
  });

  it('is parameter-sensitive to strength', () => {
    const input = buildRgba([
      [128, 128, 128], [128, 128, 128],
      [128, 128, 128], [128, 128, 128],
    ]);

    const weak = referenceDebanding(input, 2, 2, { strength: 0.25, bandThreshold: 0.08 });
    const strong = referenceDebanding(input, 2, 2, { strength: 1, bandThreshold: 0.08 });

    expect(Array.from(weak)).not.toEqual(Array.from(strong));
    // Larger strength pushes the pixel further from (but still near) the input.
    expect(Math.abs(weak[0] - 128)).toBeLessThan(Math.abs(strong[0] - 128));
  });

  it('is parameter-sensitive to bandThreshold on a shallow ramp', () => {
    const width = 32;
    const height = 4;
    const input = ramp(width, height);

    const aggressive = referenceDebanding(input, width, height, {
      strength: 1,
      bandThreshold: 0.005,
    });
    const conservative = referenceDebanding(input, width, height, {
      strength: 1,
      bandThreshold: 0.2,
    });

    expect(Array.from(aggressive)).not.toEqual(Array.from(conservative));
  });

  it('actually changes a non-flat input at non-neutral params (oracle is not a no-op)', () => {
    const width = 24;
    const height = 16;
    const input = ramp(width, height);

    const output = referenceDebanding(input, width, height, {
      strength: 0.8,
      bandThreshold: 0.08,
    });

    expect(Array.from(output)).not.toEqual(Array.from(input));
  });

  it('never produces NaN/Inf, stays integral and in [0,255] across a sweep', () => {
    const width = 11;
    const height = 9;
    const input = noisyBuffer(width, height);
    const thresholds = [0.001, 0.02, 0.08, 0.35, 1];
    const strengths = [0, 0.1, 0.5, 0.9, 1];

    for (const strength of strengths) {
      for (const bandThreshold of thresholds) {
        const output = referenceDebanding(input, width, height, { strength, bandThreshold });
        expect(output).toHaveLength(width * height * 4);
        expectIntegralInRange(output);
        for (let p = 3; p < output.length; p += 4) expect(output[p]).toBe(255);
      }
    }
  });

  it('rejects invalid dimensions and mismatched input length', () => {
    expect(() => referenceDebanding(new Uint8Array(0), 0, 1, { strength: 0, bandThreshold: 0.08 }))
      .toThrow(/dimensions/);
    expect(() => referenceDebanding(new Uint8Array(4), 2, 2, { strength: 0, bandThreshold: 0.08 }))
      .toThrow(/input length/);
  });
});
