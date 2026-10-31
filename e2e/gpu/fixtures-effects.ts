/**
 * Deterministic RGBA8 fixtures for the Debanding / ColorAdjust correctness
 * gate. Deliberately self-contained (its own `RgbaImage`) so it is independent
 * of `e2e/gpu/fixtures.ts` and can evolve separately.
 *
 * No randomness and no committed images: every fixture is generated from its
 * dimensions so runs are reproducible. All values are legal `rgba8unorm`
 * bytes (0..255); alpha is always 255.
 */

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Lowest channel value used by the generated ramps (matches fixtures.ts). */
const FLOOR = 16;
/** Highest channel value used by the generated ramps. */
const CEIL = 239;
const SPAN = CEIL - FLOOR;

function clampByte(value: number): number {
  if (value < 0) return 0;
  if (value > 255) return 255;
  return value;
}

function createImage(
  width: number,
  height: number,
  valueAt: (x: number, y: number, channel: number) => number,
): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      data[offset] = clampByte(valueAt(x, y, 0));
      data[offset + 1] = clampByte(valueAt(x, y, 1));
      data[offset + 2] = clampByte(valueAt(x, y, 2));
      data[offset + 3] = 255;
    }
  }
  return { width, height, data };
}

function scale(value: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((value / denominator) * SPAN);
}

/** Flat mid-gray: maximum band mask, so only the Bayer dither can change it. */
export function midGray(width = 32, height = 32): RgbaImage {
  return createImage(width, height, () => 128);
}

/**
 * Banding-prone fixture: a smooth horizontal ramp quantized into a small
 * number of flat bands, so each band has zero local contrast (bandMask ~= 1)
 * separated by hard quantization steps (bandMask ~= 0). Small per-channel
 * offsets keep it chromatic.
 */
export function hardGradient(width = 64, height = 48): RgbaImage {
  const bandCount = 6;
  const channelOffset = [0, 6, -6];
  return createImage(width, height, (x, _y, channel) => {
    const band = Math.min(Math.floor((x / width) * bandCount), bandCount - 1);
    const value = FLOOR + Math.round((band / (bandCount - 1)) * SPAN);
    return value + channelOffset[channel];
  });
}

/** Odd 33x17 image split by a hard vertical edge (with a mild vertical ramp). */
export function hardEdge(width = 33, height = 17): RgbaImage {
  const mid = Math.floor(width / 2);
  return createImage(width, height, (x, y, channel) => {
    const bright = x >= mid;
    const base = bright ? [220, 210, 200] : [24, 32, 40];
    return base[channel] + Math.round((y / Math.max(height - 1, 1)) * 8);
  });
}

/**
 * Smooth, chromatic sweep: red ramps along x, green along y, blue along the
 * diagonal. Exercises saturation/vibrance/gamma on both saturated and
 * near-neutral pixels.
 */
export function colorSweep(width = 32, height = 24): RgbaImage {
  const xDen = Math.max(width - 1, 1);
  const yDen = Math.max(height - 1, 1);
  const diagDen = Math.max(width + height - 2, 1);
  return createImage(width, height, (x, y, channel) => {
    if (channel === 0) return FLOOR + scale(x, xDen);
    if (channel === 1) return FLOOR + scale(y, yDen);
    return FLOOR + scale(x + y, diagDen);
  });
}
