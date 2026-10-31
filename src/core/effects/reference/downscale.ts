/**
 * Independent pure-TypeScript port of the shipped compute `Downscale` shader
 * (`dist/pipelines/helpers/Downscale/shaders/downscale.wgsl`, emitted as
 * `downscale.wgsl.js`).
 *
 * DEV/TEST ONLY. Used as the CPU oracle by the headless-WebGPU correctness
 * gate. Production code must never import it. This module imports nothing, so
 * it can be loaded by the Playwright spec outside webpack/Vitest alias
 * resolution, and it deliberately does not read or parse the WGSL source.
 *
 * The port mirrors the WGSL line by line. `Downscale` is a two-path kernel
 * selected from the actual input/output dimensions (never from a floating
 * `ratio`):
 *
 *   - Exact integer 2:1 (`srcWidth === 2 * outWidth && srcHeight === 2 * outHeight`):
 *     `sharp2x`, the half-phase 4-tap Keys cubic peaking kernel. Per axis the
 *     taps `o in {-1, 0, 1, 2}` relative to `base = 2 * gid` use
 *     `sharpWeight(o) = (o === -1 || o === 2) ? -A : 0.5 + A` with `A = 0.10`,
 *     i.e. 1-D weights `[-0.10, 0.60, 0.60, -0.10]`; taps are clamp-to-edge
 *     sampled. RGB is srgb_to_linear -> separable 4x4 weighted sum -> hard
 *     per-channel `clamp(acc, vmin, vmax)` over the 16 linear tap values
 *     (libplacebo-style anti-ringing) -> linear_to_srgb. Alpha uses the same
 *     weights without linearization or clamping.
 *   - Everything else: the ratio-scaled fractional-coverage box filter.
 *       - footprint center = (gid + 0.5) * ratio, lo = center - ratio/2,
 *         hi = center + ratio/2  (ratio = src/out, per axis)
 *       - integer source texels overlapping [lo, hi) contribute
 *           wx = overlap_x / ratio.x, wy = overlap_y / ratio.y  (weights sum to 1)
 *       - kx/ky are clamp-to-edge sampled (kx1/ky1 also clamped to max)
 *       - RGB is srgb_to_linear -> weighted sum -> linear_to_srgb; alpha is
 *         weighted without linearization
 *   - the rgba16float store is modeled by scaling to 8 bits and rounding
 */
import { clamp01 } from './math';

const INV_255 = 1 / 255;
const MAX_CHANNEL = 255;

/** Half-phase Keys cubic peaking weight `A` and its center tap `0.5 + A`. */
const SHARP_A = 0.1;
const SHARP_W = 0.5 + SHARP_A;

/** `sharp_weight(o)` for taps `o in {-1, 0, 1, 2}`. */
function sharpWeight(o: number): number {
  return o === -1 || o === 2 ? -SHARP_A : SHARP_W;
}

/** Model an 8-bit unorm read/write: clamp to [0,1], scale and round. NaN -> 0. */
function quantizeUnorm8(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.round(clamp01(value) * MAX_CHANNEL);
}

/** `srgb_to_linear` for a single channel (WGSL `select(hi, lo, c <= 0.04045)`). */
function srgbToLinear(c: number): number {
  if (c <= 0.04045) return c / 12.92;
  return Math.pow((c + 0.055) / 1.055, 2.4);
}

/** `linear_to_srgb` for a single channel (WGSL `select(hi, lo, c <= 0.0031308)`). */
function linearToSrgb(c: number): number {
  if (c <= 0.0031308) return c * 12.92;
  return 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/**
 * CPU oracle for the shipped compute `Downscale` shader. Exact 2:1 input/output
 * uses the half-phase Keys cubic peaking kernel (`sharp2x`); every other ratio
 * uses the ratio-scaled fractional-coverage box. RGBA8 in, RGBA8 out.
 *
 * @param source  RGBA8 buffer, length `srcWidth * srcHeight * 4`.
 * @param srcWidth  Source width in pixels.
 * @param srcHeight Source height in pixels.
 * @param outWidth  Target width in pixels.
 * @param outHeight Target height in pixels.
 * @returns A new RGBA8 buffer of length `outWidth * outHeight * 4`.
 */
export function referenceDownscale(
  source: Uint8Array,
  srcWidth: number,
  srcHeight: number,
  outWidth: number,
  outHeight: number,
): Uint8Array {
  const dims = [
    ['srcWidth', srcWidth],
    ['srcHeight', srcHeight],
    ['outWidth', outWidth],
    ['outHeight', outHeight],
  ] as const;
  for (const [name, value] of dims) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`referenceDownscale: invalid ${name} ${value}`);
    }
  }
  const expectedLength = srcWidth * srcHeight * 4;
  if (source.length !== expectedLength) {
    throw new Error(
      `referenceDownscale: source length ${source.length} does not match `
      + `${srcWidth}x${srcHeight}x4 (${expectedLength})`,
    );
  }

  const ratioX = srcWidth / outWidth;
  const ratioY = srcHeight / outHeight;
  const output = new Uint8Array(outWidth * outHeight * 4);
  const maxX = srcWidth - 1;
  const maxY = srcHeight - 1;

  // textureLoad of an rgba8unorm texture yields the normalized value in [0,1].
  const load = (x: number, y: number, channel: number): number =>
    source[(y * srcWidth + x) * 4 + channel] * INV_255;

  // Exact integer 2:1 on BOTH axes selects the `sharp2x` peaking path in WGSL.
  if (srcWidth === 2 * outWidth && srcHeight === 2 * outHeight) {
    for (let oy = 0; oy < outHeight; oy++) {
      for (let ox = 0; ox < outWidth; ox++) {
        const baseX = ox * 2;
        const baseY = oy * 2;

        let accR = 0;
        let accG = 0;
        let accB = 0;
        let accA = 0;
        let minR = Infinity;
        let minG = Infinity;
        let minB = Infinity;
        let maxR = -Infinity;
        let maxG = -Infinity;
        let maxB = -Infinity;

        for (let j = -1; j <= 2; j++) {
          const wy = sharpWeight(j);
          const sy = Math.min(Math.max(baseY + j, 0), maxY);
          for (let i = -1; i <= 2; i++) {
            const w = sharpWeight(i) * wy;
            const sx = Math.min(Math.max(baseX + i, 0), maxX);
            const r = srgbToLinear(load(sx, sy, 0));
            const g = srgbToLinear(load(sx, sy, 1));
            const b = srgbToLinear(load(sx, sy, 2));
            const a = load(sx, sy, 3);

            minR = Math.min(minR, r);
            minG = Math.min(minG, g);
            minB = Math.min(minB, b);
            maxR = Math.max(maxR, r);
            maxG = Math.max(maxG, g);
            maxB = Math.max(maxB, b);

            accR += r * w;
            accG += g * w;
            accB += b * w;
            accA += a * w; // alpha: no linearization
          }
        }

        // Anti-ringing: hard per-channel clamp to the 16-tap linear min/max.
        const outBase = (oy * outWidth + ox) * 4;
        output[outBase] = quantizeUnorm8(linearToSrgb(Math.min(Math.max(accR, minR), maxR)));
        output[outBase + 1] = quantizeUnorm8(linearToSrgb(Math.min(Math.max(accG, minG), maxG)));
        output[outBase + 2] = quantizeUnorm8(linearToSrgb(Math.min(Math.max(accB, minB), maxB)));
        output[outBase + 3] = quantizeUnorm8(accA);
      }
    }

    return output;
  }

  for (let oy = 0; oy < outHeight; oy++) {
    const centerY = (oy + 0.5) * ratioY;
    const loY = centerY - ratioY * 0.5;
    const hiY = centerY + ratioY * 0.5;
    const ky0 = Math.floor(loY);
    const ky1 = Math.min(Math.ceil(hiY) - 1, maxY);

    for (let ox = 0; ox < outWidth; ox++) {
      const centerX = (ox + 0.5) * ratioX;
      const loX = centerX - ratioX * 0.5;
      const hiX = centerX + ratioX * 0.5;
      const kx0 = Math.floor(loX);
      const kx1 = Math.min(Math.ceil(hiX) - 1, maxX);

      let accR = 0;
      let accG = 0;
      let accB = 0;
      let accA = 0;

      for (let ky = ky0; ky <= ky1; ky++) {
        const wy = Math.max(0, Math.min(hiY, ky + 1) - Math.max(loY, ky)) / ratioY;
        if (wy <= 0) continue;
        const sy = Math.min(Math.max(ky, 0), maxY);
        for (let kx = kx0; kx <= kx1; kx++) {
          const wx = Math.max(0, Math.min(hiX, kx + 1) - Math.max(loX, kx)) / ratioX;
          if (wx <= 0) continue;
          const sx = Math.min(Math.max(kx, 0), maxX);
          const w = wx * wy;
          accR += srgbToLinear(load(sx, sy, 0)) * w;
          accG += srgbToLinear(load(sx, sy, 1)) * w;
          accB += srgbToLinear(load(sx, sy, 2)) * w;
          accA += load(sx, sy, 3) * w; // alpha: no linearization
        }
      }

      const outBase = (oy * outWidth + ox) * 4;
      output[outBase] = quantizeUnorm8(linearToSrgb(accR));
      output[outBase + 1] = quantizeUnorm8(linearToSrgb(accG));
      output[outBase + 2] = quantizeUnorm8(linearToSrgb(accB));
      output[outBase + 3] = quantizeUnorm8(accA);
    }
  }

  return output;
}

/**
 * Naive single bilinear tap at the output-texel center in the **encoded**
 * domain (no linearization, one base level) — roughly what the old
 * render-based `Downscale` did. Used only as a contrast/meaningfulness guard.
 *
 * RGBA8 in, RGBA8 out.
 */
export function referenceBilinearDownscale(
  source: Uint8Array,
  srcWidth: number,
  srcHeight: number,
  outWidth: number,
  outHeight: number,
): Uint8Array {
  const dims = [
    ['srcWidth', srcWidth],
    ['srcHeight', srcHeight],
    ['outWidth', outWidth],
    ['outHeight', outHeight],
  ] as const;
  for (const [name, value] of dims) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`referenceBilinearDownscale: invalid ${name} ${value}`);
    }
  }
  const expectedLength = srcWidth * srcHeight * 4;
  if (source.length !== expectedLength) {
    throw new Error(
      `referenceBilinearDownscale: source length ${source.length} does not match `
      + `${srcWidth}x${srcHeight}x4 (${expectedLength})`,
    );
  }

  const output = new Uint8Array(outWidth * outHeight * 4);
  const ratioX = srcWidth / outWidth;
  const ratioY = srcHeight / outHeight;
  const maxX = srcWidth - 1;
  const maxY = srcHeight - 1;

  // Encoded-domain texel sample with clamp-to-edge.
  const texel = (x: number, y: number, channel: number): number =>
    source[(Math.min(Math.max(y, 0), maxY) * srcWidth + Math.min(Math.max(x, 0), maxX)) * 4 + channel]
    * INV_255;

  for (let oy = 0; oy < outHeight; oy++) {
    const fy = (oy + 0.5) * ratioY - 0.5;
    const y0 = Math.floor(fy);
    const ty = fy - y0;

    for (let ox = 0; ox < outWidth; ox++) {
      const fx = (ox + 0.5) * ratioX - 0.5;
      const x0 = Math.floor(fx);
      const tx = fx - x0;

      const outBase = (oy * outWidth + ox) * 4;
      for (let channel = 0; channel < 4; channel++) {
        const top = texel(x0, y0, channel) * (1 - tx) + texel(x0 + 1, y0, channel) * tx;
        const bottom = texel(x0, y0 + 1, channel) * (1 - tx) + texel(x0 + 1, y0 + 1, channel) * tx;
        output[outBase + channel] = quantizeUnorm8(top * (1 - ty) + bottom * ty);
      }
    }
  }

  return output;
}
