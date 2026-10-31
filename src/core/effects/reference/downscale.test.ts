import { describe, expect, it } from 'vitest';
import { referenceBilinearDownscale, referenceDownscale } from './downscale';
import { compareRgba } from './compare';
import { makeGrating, makeStepEdge, measureEdgeResponse, mtfFromPair } from './signal';

/** Build an RGBA8 buffer from a per-pixel [r,g,b,a] list. */
function buildRgba(pixels: [number, number, number, number][]): Uint8Array {
  const out = new Uint8Array(pixels.length * 4);
  pixels.forEach(([r, g, b, a], index) => {
    out[index * 4] = r;
    out[index * 4 + 1] = g;
    out[index * 4 + 2] = b;
    out[index * 4 + 3] = a;
  });
  return out;
}

/** Build a grayscale RGBA8 buffer (alpha 255) from row-major values. */
function buildGray(rows: number[][]): Uint8Array {
  const pixels: [number, number, number, number][] = [];
  for (const row of rows) {
    for (const value of row) {
      pixels.push([value, value, value, 255]);
    }
  }
  return buildRgba(pixels);
}

describe('referenceDownscale', () => {
  it('uses sharp2x at exact 2:1; its 2x2 taps collapse to a plain average', () => {
    // 2x2 -> 1x1 is exact 2:1, so the sharp2x branch runs. With two texels per
    // axis the clamp-to-edge expansion maps i in {-1, 0} -> x=0 and i in
    // {1, 2} -> x=1, so each source texel collects weight
    // (-A + W) * (-A + W) = 0.5 * 0.5 = 0.25 and the kernel degenerates to the
    // arithmetic mean. Values <= 10 stay in the sRGB linear segment on both
    // ends, so the output is exactly (0 + 2 + 4 + 6) / 4 = 3.
    const source = buildGray([
      [0, 2],
      [4, 6],
    ]);

    const output = referenceDownscale(source, 2, 2, 1, 1);

    expect(Array.from(output)).toEqual([3, 3, 3, 255]);
  });

  it('applies the sharp2x 1-D weights [-0.10, 0.60, 0.60, -0.10] at 2:1', () => {
    // 6x2 -> 3x1 is exact 2:1 on both axes (`6 === 2*3`, `2 === 2*1`). Both
    // rows are identical and the y taps clamp to the two rows, where the
    // sharp weights sum to 1, so the output follows the 1-D x kernel. All
    // values stay in the sRGB linear segment, so output = round(sum w_i v_i):
    //   ox=0: taps x=-1,0,1,2 -> 0,0,1,2 -> -0.1*0 + 0.6*0 + 0.6*1 - 0.1*2 = 0.4 -> 0
    //   ox=1: taps x= 1,2,3,4 -> 0,1,2,4 -> -0.1*0 + 0.6*1 + 0.6*2 - 0.1*4 = 1.4 -> 1
    //   ox=2: taps x= 3,4,5,6(clamp 5) -> 2,4,6,6 -> -0.1*2 + 0.6*4 + 0.6*6 - 0.1*6 = 5.2 -> 5
    // A plain average would give 0.75 -> 1 and 1.75 -> 2 at ox=0/1, so the
    // negative lobes are observable and the anti-ringing clamp stays inactive.
    const row = [0, 0, 1, 2, 4, 6];
    const source = buildGray([row, row]);

    const output = referenceDownscale(source, 6, 2, 3, 1);

    expect(Array.from(output)).toEqual([
      0, 0, 0, 255,
      1, 1, 1, 255,
      5, 5, 5, 255,
    ]);
  });

  it('is the identity at ratio 1 (round-trips every 8-bit value)', () => {
    const width = 5;
    const height = 4;
    const source = new Uint8Array(width * height * 4);
    for (let i = 0; i < source.length; i++) source[i] = (i * 37 + 11) % 256;
    // Include the exact piecewise boundaries 10 / 11 and extremes.
    source.set([0, 10, 11, 128, 254, 255, 1, 2, 3, 4, 5, 6, 7, 8, 9, 12], 0);

    const output = referenceDownscale(source, width, height, width, height);

    expect(Array.from(output)).toEqual(Array.from(source));
  });

  it('uses the exact 3/2 overlap weights on a hand-computed image', () => {
    // 3x3 -> 2x2, ratio 1.5 per axis. All values <= 10 so the linear segment
    // makes the filter an exact weighted average. X weights: [2/3, 1/3] then
    // [1/3, 2/3]; same for Y (separable). Hand-derived outputs:
    //   (0,0)=2  (1,0)=6  (0,1)=6  (1,1)=9
    const source = buildGray([
      [0, 3, 6],
      [3, 6, 9],
      [6, 9, 9],
    ]);

    const output = referenceDownscale(source, 3, 3, 2, 2);

    expect(Array.from(output)).toEqual([
      2, 2, 2, 255,
      6, 6, 6, 255,
      6, 6, 6, 255,
      9, 9, 9, 255,
    ]);
  });

  it('uses the fractional-coverage box (not sharp2x) at 4/3 and 5/3', () => {
    // Exact 2:1 requires BOTH axes. These cases set the x ratio to 4/3 and 5/3
    // while y is 2:1, so the sharp2x guard (`srcWidth === 2*outWidth`) is false
    // and the box path runs. All values are in the sRGB linear segment, so the
    // output is the exact fractional-coverage weighted mean.
    //
    // 4/3: 4 -> 3. X overlap weights are ox=0: [3/4, 1/4], ox=1: [1/2, 1/2],
    // ox=2: [1/4, 3/4]. With both rows [0, 0, 8, 8] the y box is a no-op:
    //   ox=0: (3*0 + 1*0)/4 = 0   ox=1: (0 + 8)/2 = 4   ox=2: (8 + 3*8)/4 = 8
    // sharp2x would instead emit [0, 8] (the step is clamped).
    const at43 = referenceDownscale(buildGray([[0, 0, 8, 8], [0, 0, 8, 8]]), 4, 2, 3, 1);
    expect(Array.from(at43)).toEqual([0, 0, 0, 255, 4, 4, 4, 255, 8, 8, 8, 255]);

    // 5/3: 5 -> 3. X overlap weights are ox=0: [3/5, 2/5], ox=1: [1/5, 3/5, 1/5],
    // ox=2: [2/5, 3/5]. With both rows [0, 0, 8, 8, 8]:
    //   ox=0: 0   ox=1: 0.6*8 + 0.2*8 = 6.4 -> 6   ox=2: 0.4*8 + 0.6*8 = 8
    const at53 = referenceDownscale(
      buildGray([[0, 0, 8, 8, 8], [0, 0, 8, 8, 8]]),
      5,
      2,
      3,
      1,
    );
    expect(Array.from(at53)).toEqual([0, 0, 0, 255, 6, 6, 6, 255, 8, 8, 8, 255]);
  });

  it('filters in linear light: black + white -> ~188, not the encoded 128', () => {
    // 2:1 along x only (height ratio 1), so the box path applies. Averaging
    // encoded values would give round(0.5 * 255) = 128; averaging in linear
    // then encoding gives linear_to_srgb(0.5) = 0.735357 -> round(187.52) = 188.
    const output = referenceDownscale(new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]), 2, 1, 1, 1);

    expect(output[0]).toBe(188);
    expect(output[0]).not.toBe(128);
  });

  it('averages alpha linearly (no sRGB encoding)', () => {
    // 2x2 -> 1x1 is exact 2:1 (sharp2x), whose taps degenerate to uniform
    // 0.25 weights here. Alphas [0,100,200,255] therefore average to
    // round(555/4) = 139. Linearizing alpha would land near 175 instead.
    const source = buildRgba([
      [40, 40, 40, 0],
      [40, 40, 40, 100],
      [40, 40, 40, 200],
      [40, 40, 40, 255],
    ]);

    const output = referenceDownscale(source, 2, 2, 1, 1);

    expect(output[0]).toBe(40);
    expect(output[3]).toBe(139);
    expect(output[3]).not.toBe(175);
  });

  it('respects the sRGB decode threshold near 0.04045', () => {
    // 2:1 average of black and an 8-bit value. 10/255 = 0.03922 is <= 0.04045
    // (linear segment) while 11/255 = 0.04314 uses the gamma segment, so the
    // pair straddles the decode threshold and must produce 5 then 6.
    const at10 = referenceDownscale(buildRgba([[0, 0, 0, 255], [10, 10, 10, 255]]), 2, 1, 1, 1);
    const at11 = referenceDownscale(buildRgba([[0, 0, 0, 255], [11, 11, 11, 255]]), 2, 1, 1, 1);

    expect(at10[0]).toBe(5);
    expect(at11[0]).toBe(6);
    expect(at10[0]).not.toBe(at11[0]);
  });

  it('respects the sRGB encode threshold near 0.0031308', () => {
    // 2:1 average of black and 18 (linear ~0.00605 -> 0.003025 <= 0.0031308,
    // linear segment -> 10) vs 19 (linear ~0.00650 -> 0.003250 > 0.0031308,
    // gamma segment -> 11). Crossing the threshold must change the byte.
    const at18 = referenceDownscale(buildRgba([[0, 0, 0, 255], [18, 18, 18, 255]]), 2, 1, 1, 1);
    const at19 = referenceDownscale(buildRgba([[0, 0, 0, 255], [19, 19, 19, 255]]), 2, 1, 1, 1);

    expect(at18[0]).toBe(10);
    expect(at19[0]).toBe(11);
    expect(at18[0]).not.toBe(at19[0]);
  });

  it('clamps to the edge for fractional footprints at the image border', () => {
    // 1x1 source up-sampled never happens for a downscale, but ratio-1 at the
    // border must reuse the edge texel rather than escape the image.
    const source = buildGray([[20, 200]]);
    const output = referenceDownscale(source, 2, 1, 2, 1);

    expect(Array.from(output)).toEqual([
      20, 20, 20, 255,
      200, 200, 200, 255,
    ]);
  });

  it('differs from a naive bilinear tap on a high-frequency fixture', () => {
    // Fine 1px striping at a 3/2 ratio: the box filter averages adjacent
    // columns in linear light while a bilinear tap samples one phase.
    const width = 6;
    const height = 4;
    const pixels: [number, number, number, number][] = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const value = (x % 2 === 0) ? 16 : 239;
        pixels.push([value, value, value, 255]);
      }
    }
    const source = buildRgba(pixels);

    const box = referenceDownscale(source, width, height, 4, 3);
    const bilinear = referenceBilinearDownscale(source, width, height, 4, 3);

    expect(compareRgba(box, bilinear).maxAbs).toBeGreaterThan(0);
  });

  it('peaks at 2:1: the 4px grating retains ~0.70 and the 8px grating ~1.03', () => {
    // Exact 2:1 selects the sharp2x branch. On the output-Nyquist grating
    // (source period 4) the half-phase cubic lands on the alternating samples
    // and retains ~0.70 of the fundamental, versus ~0.49 for the box. The
    // in-band mid-band boost peaks above 1 around source period 8.
    const width = 64;
    const height = 8;
    const p4 = makeGrating({ width, height, period: 4, axis: 'x', dc: 128, amplitude: 60 });
    const p8 = makeGrating({ width, height, period: 8, axis: 'x', dc: 128, amplitude: 60 });

    const retention4 = mtfFromPair(
      p4,
      { width: 32, height: 4, data: referenceDownscale(p4.data, width, height, 32, 4) },
      { ratio: 2, period: 4, axis: 'x' },
    );
    const retention8 = mtfFromPair(
      p8,
      { width: 32, height: 4, data: referenceDownscale(p8.data, width, height, 32, 4) },
      { ratio: 2, period: 8, axis: 'x' },
    );

    expect(retention4).not.toBeNull();
    expect(retention8).not.toBeNull();
    expect(retention4 as number).toBeCloseTo(0.7, 2);
    expect(retention4 as number).toBeGreaterThan(0.55);
    expect(retention8 as number).toBeCloseTo(1.041, 2);
    expect(retention8 as number).toBeGreaterThan(1);
  });

  it('clamps 2:1 step ringing to zero (anti-ringing hard min/max clamp)', () => {
    // The sharp2x negative lobes overshoot a step, but the WGSL hard clamp of
    // each channel to the 16-tap linear min/max forces the step response back
    // inside [low, high], so measured overshoot/undershoot is exactly 0.
    const width = 64;
    const height = 8;
    const low = 32;
    const high = 224;
    const source = makeStepEdge({
      width,
      height,
      axis: 'x',
      low,
      high,
      position: Math.floor(width / 2),
    });
    const output = referenceDownscale(source.data, width, height, 32, 4);

    const response = measureEdgeResponse({ width: 32, height: 4, data: output }, {
      axis: 'x',
      low,
      high,
      margin: 4,
    });

    expect(response.overshootPct).toBe(0);
    expect(response.undershootPct).toBe(0);
  });

  it('produces outWidth*outHeight*4 bytes within range', () => {
    const source = new Uint8Array(6 * 5 * 4);
    for (let i = 0; i < source.length; i++) source[i] = (i * 53 + 7) % 256;

    const output = referenceDownscale(source, 6, 5, 4, 3);

    expect(output).toHaveLength(4 * 3 * 4);
    for (let i = 0; i < output.length; i++) {
      expect(output[i]).toBeGreaterThanOrEqual(0);
      expect(output[i]).toBeLessThanOrEqual(255);
    }
  });

  it('rejects invalid dimensions and mismatched source length', () => {
    expect(() => referenceDownscale(new Uint8Array(0), 0, 1, 1, 1)).toThrow(/invalid srcWidth/);
    expect(() => referenceDownscale(new Uint8Array(0), 1, 1, 0, 1)).toThrow(/invalid outWidth/);
    expect(() => referenceDownscale(new Uint8Array(4), 2, 2, 1, 1)).toThrow(/source length/);
  });
});

describe('referenceBilinearDownscale', () => {
  it('is the identity at ratio 1', () => {
    const width = 4;
    const height = 3;
    const source = new Uint8Array(width * height * 4);
    for (let i = 0; i < source.length; i++) source[i] = (i * 29 + 5) % 256;

    const output = referenceBilinearDownscale(source, width, height, width, height);

    expect(Array.from(output)).toEqual(Array.from(source));
  });

  it('rejects invalid dimensions and mismatched source length', () => {
    expect(() => referenceBilinearDownscale(new Uint8Array(0), 0, 1, 1, 1)).toThrow(/invalid srcWidth/);
    expect(() => referenceBilinearDownscale(new Uint8Array(4), 2, 2, 1, 1)).toThrow(/source length/);
  });
});
