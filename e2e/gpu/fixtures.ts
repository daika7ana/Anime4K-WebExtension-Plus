/**
 * Deterministic RGBA8 fixtures for the headless-WebGPU CAS correctness gate.
 *
 * No randomness and no committed images: every fixture is generated from its
 * dimensions so runs are reproducible.
 *
 * All-black fixtures are now safe: `cas.wgsl` floors the smooth-max divisor
 * (`max(mxRGB, 1e-8)`) so an all-black 3x3 neighborhood degenerates to the
 * identity instead of `0 * Infinity` -> NaN. See `black()` / `blackRegion()`.
 * The other fixtures keep every channel strictly above zero for continuity
 * with the original CAS coverage.
 */

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Lowest channel value used by any fixture (never 0). */
const FLOOR = 16;
/** Highest channel value used by any fixture. */
const CEIL = 239;
const SPAN = CEIL - FLOOR;

function createImage(
  width: number,
  height: number,
  valueAt: (x: number, y: number, channel: number) => number,
): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      data[offset] = valueAt(x, y, 0);
      data[offset + 1] = valueAt(x, y, 1);
      data[offset + 2] = valueAt(x, y, 2);
      data[offset + 3] = 255;
    }
  }
  return { width, height, data };
}

function scale(value: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((value / denominator) * SPAN);
}

/** Smooth per-axis ramp: a good baseline for adaptive sharpening. */
export function gradient(width = 64, height = 64): RgbaImage {
  const xDen = Math.max(width - 1, 1);
  const yDen = Math.max(height - 1, 1);
  const diagDen = Math.max(width + height - 2, 1);
  return createImage(width, height, (x, y, channel) => {
    if (channel === 0) return FLOOR + scale(x, xDen);
    if (channel === 1) return FLOOR + scale(y, yDen);
    return FLOOR + scale(x + y, diagDen);
  });
}

/** Hard 8px checkerboard: stresses CAS at high-contrast block edges. */
export function checker(width = 64, height = 64): RgbaImage {
  const low: [number, number, number] = [24, 40, 24];
  const high: [number, number, number] = [230, 210, 230];
  return createImage(width, height, (x, y, channel) => {
    const block = Math.floor(x / 8) + Math.floor(y / 8);
    return block % 2 === 0 ? low[channel] : high[channel];
  });
}

/** Horizontal intensity bands with a mild horizontal ramp in each channel. */
export function bands(width = 64, height = 64): RgbaImage {
  const bandCount = 8;
  return createImage(width, height, (x, y, channel) => {
    const band = Math.min(Math.floor((y / height) * bandCount), bandCount - 1);
    const ramp = scale(x, Math.max(width - 1, 1));
    if (channel === 0) return 24 + band * 28 + Math.round(ramp * 0.05);
    if (channel === 1) return 230 - band * 28;
    return 24 + ((band * 37) % 190) + Math.round(ramp * 0.03);
  });
}

/** Odd 33x17 image split by a vertical edge (exercises workgroup tails). */
export function edge(width = 33, height = 17): RgbaImage {
  const mid = Math.floor(width / 2);
  return createImage(width, height, (x, y, channel) => {
    const bright = x >= mid;
    const vertical = scale(y, Math.max(height - 1, 1));
    if (channel === 0) return (bright ? 216 : 24) + Math.round(vertical * 0.05);
    if (channel === 1) return bright ? 208 : 32;
    return (bright ? 200 : 40) + Math.round(vertical * 0.04);
  });
}

/** Single non-black pixel. */
export function corner(): RgbaImage {
  return createImage(1, 1, (_x, _y, channel) => [72, 144, 216][channel]);
}

/**
 * Pure-black RGBA frame (alpha 255). Every 3x3 neighborhood is exactly black,
 * the former `0 * Infinity` case; the shader guard must return the identity.
 */
export function black(width = 33, height = 17): RgbaImage {
  return createImage(width, height, () => 0);
}

/**
 * Black region + flat grey + bright step. The leftmost columns have all-black
 * 3x3 neighborhoods (the degenerate path), while the grey/bright edge sits far
 * enough away that its neighborhoods contain no black and sharpen normally.
 */
export function blackRegion(width = 32, height = 16): RgbaImage {
  return createImage(width, height, (x, _y, channel) => {
    if (x < 8) return 0; // all-black block: every early neighborhood is black
    if (x < 24) return [128, 120, 136][channel]; // flat grey: identity
    return [208, 192, 176][channel]; // bright block: sharp step at x = 23/24
  });
}

/**
 * Fine 2px-period checkerboard: high-frequency content for the downscale
 * correctness gate. The area/box filter and a naive bilinear tap diverge
 * strongly on this pattern, which makes the box-vs-bilinear contrast guard
 * meaningful. Channels stay strictly above zero.
 */
export function fineChecker(width = 96, height = 72): RgbaImage {
  const low: [number, number, number] = [24, 48, 72];
  const high: [number, number, number] = [232, 208, 184];
  return createImage(width, height, (x, y, channel) => {
    const cell = (Math.floor(x / 2) + Math.floor(y / 2)) % 2;
    return cell === 0 ? low[channel] : high[channel];
  });
}

/**
 * Mostly mid-grey with bright single-pixel impulses on an 8px grid: stresses
 * how the downscale spreads (box) versus phase-samples (bilinear) impulses.
 */
export function impulse(width = 80, height = 40): RgbaImage {
  return createImage(width, height, (x, y, channel) => {
    if (x % 8 === 4 && y % 8 === 4) {
      return [240, 220, 200][channel];
    }
    return 96 + ((x * 7 + y * 13) % 24);
  });
}
