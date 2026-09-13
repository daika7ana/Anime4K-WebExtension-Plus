import { describe, expect, it } from 'vitest';
import { referenceCas } from './cas';

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

describe('referenceCas', () => {
  it('is the exact identity at sharpness 0', () => {
    const width = 5;
    const height = 4;
    const input = new Uint8Array(width * height * 4);
    for (let i = 0; i < input.length; i++) {
      input[i] = (i * 37 + 11) % 256;
    }
    for (let p = 3; p < input.length; p += 4) {
      input[p] = 255;
    }

    const output = referenceCas(input, width, height, { sharpness: 0 });

    expect(output).toEqual(input);
  });

  it('leaves a constant image unchanged for any sharpness', () => {
    const width = 4;
    const height = 3;
    const input = buildRgba(Array.from({ length: width * height }, () => [80, 130, 200] as [number, number, number]));

    for (const sharpness of [0, 0.5, 1]) {
      const output = referenceCas(input, width, height, { sharpness });
      expect(Array.from(output)).toEqual(Array.from(input));
    }
  });

  it('matches a hand-computed 3x1 scalar case', () => {
    // R = [26, 102, 230]; G/B constant so only the red channel varies.
    // At the centre pixel, the independent hand derivation gives 0.393512...
    // -> round(0.393512 * 255) = 100 at sharpness 0.5 and 97 at sharpness 1.0.
    const input = buildRgba([
      [26, 100, 100],
      [102, 100, 100],
      [230, 100, 100],
    ]);

    const atHalf = referenceCas(input, 3, 1, { sharpness: 0.5 });
    const atMax = referenceCas(input, 3, 1, { sharpness: 1 });

    expect(atHalf[4]).toBe(100);
    expect(atMax[4]).toBe(97);
    // G and B are constant in the neighborhood, so they must be preserved.
    expect([atHalf[1], atHalf[2], atHalf[5], atHalf[6], atHalf[9], atHalf[10]])
      .toEqual([100, 100, 100, 100, 100, 100]);
  });

  it('clamps the 3x3 neighborhood at the top-left corner to the 2x2 crop', () => {
    // At pixel (0,0), x0=y0=0 and x1=y1=1 for both the 3x3 image and its
    // top-left 2x2 crop, so the corner output must be identical.
    const input3x3 = buildRgba([
      [26, 40, 60], [102, 80, 100], [205, 160, 200],
      [51, 90, 12], [128, 100, 140], [230, 200, 180],
      [12, 30, 70], [180, 210, 90], [90, 150, 250],
    ]);

    const input2x2 = buildRgba([
      [26, 40, 60], [102, 80, 100],
      [51, 90, 12], [128, 100, 140],
    ]);

    const out3x3 = referenceCas(input3x3, 3, 3, { sharpness: 0.5 });
    const out2x2 = referenceCas(input2x2, 2, 2, { sharpness: 0.5 });

    expect(Array.from(out3x3.slice(0, 4))).toEqual(Array.from(out2x2.slice(0, 4)));
  });

  it('produces width*height*4 bytes, keeps alpha at 255 and stays in range', () => {
    const width = 7;
    const height = 3;
    const input = new Uint8Array(width * height * 4);
    for (let i = 0; i < input.length; i++) {
      input[i] = (i * 53 + 7) % 256;
    }

    const output = referenceCas(input, width, height, { sharpness: 0.5 });

    expect(output).toHaveLength(width * height * 4);
    for (let i = 0; i < output.length; i++) {
      expect(output[i]).toBeGreaterThanOrEqual(0);
      expect(output[i]).toBeLessThanOrEqual(255);
    }
    for (let p = 3; p < output.length; p += 4) {
      expect(output[p]).toBe(255);
    }
  });

  it('actually changes a high-contrast input (oracle is not a no-op)', () => {
    const input = buildRgba([
      [26, 26, 26], [230, 230, 230], [26, 26, 26],
    ]);

    const output = referenceCas(input, 3, 1, { sharpness: 1 });

    expect(Array.from(output)).not.toEqual(Array.from(input));
  });

  it('produces the identity for an all-black neighborhood (no 0*Infinity NaN)', () => {
    const input = buildRgba(
      Array.from({ length: 9 }, () => [0, 0, 0] as [number, number, number]),
    );

    for (const sharpness of [0, 0.5, 1]) {
      const output = referenceCas(input, 3, 3, { sharpness });
      for (let p = 0; p < output.length; p += 4) {
        // The guard makes the filter degenerate to outColor == e, so black stays
        // black rather than becoming NaN (which quantizes to 0) or Infinity.
        expect([output[p], output[p + 1], output[p + 2], output[p + 3]])
          .toEqual([0, 0, 0, 255]);
      }
      for (let i = 0; i < output.length; i++) {
        expect(Number.isFinite(output[i])).toBe(true);
      }
    }
  });

  it('stays finite for a mixed image with one all-black neighborhood', () => {
    // 9x1: four black texels, one grey, then a bright block. Pixel 2 has an
    // all-black 3x3 neighborhood (x0=1, x1=3 on the single row) and must be the
    // finite identity; pixel 5 sits on the grey/bright edge (no black in its
    // neighborhood) and must still take the normal sharpening path.
    const input = buildRgba([
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [128, 128, 128],
      [208, 208, 208],
      [208, 208, 208],
      [208, 208, 208],
      [208, 208, 208],
    ]);

    const output = referenceCas(input, 9, 1, { sharpness: 0.5 });

    for (let i = 0; i < output.length; i++) {
      expect(Number.isFinite(output[i])).toBe(true);
    }
    // Pixel 2 is the all-black neighborhood and must be the identity.
    expect([output[8], output[9], output[10], output[11]]).toEqual([0, 0, 0, 255]);
    // The rest of the mixed image must still be sharpened (oracle not a no-op).
    expect(Array.from(output)).not.toEqual(Array.from(input));
  });

  it('keeps the near-black nonzero path finite and unchanged by the floor', () => {
    // maxSum = 2/255 ~= 0.00784, far above the 1e-8 floor, so the normal
    // sharpening math runs. A constant image is the identity at any sharpness.
    const input = buildRgba(Array.from({ length: 3 }, () => [1, 1, 1] as [number, number, number]));

    const output = referenceCas(input, 3, 1, { sharpness: 0.5 });

    expect(Array.from(output)).toEqual(Array.from(input));
  });

  it('rejects invalid dimensions and mismatched input length', () => {
    expect(() => referenceCas(new Uint8Array(0), 0, 1, { sharpness: 0.5 })).toThrow(/dimensions/);
    expect(() => referenceCas(new Uint8Array(4), 2, 2, { sharpness: 0.5 })).toThrow(/input length/);
  });
});
