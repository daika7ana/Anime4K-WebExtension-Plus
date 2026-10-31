/**
 * Independent pure-TypeScript port of the shipped `src/shaders/cas.wgsl`.
 *
 * DEV/TEST ONLY. Used as the CPU oracle by the headless-WebGPU correctness
 * gate. Production code must never import it. This module imports nothing, so
 * it can be loaded by the Playwright spec outside webpack/Vitest alias
 * resolution.
 *
 * The port mirrors the WGSL line by line (3x3 clamped neighborhood, soft
 * min/max sums, inverseSqrt, `peak = -3*sharpness + 8`, the weighted filter and
 * the final `mix(e, outColor, sharpness)`), then models the `rgba8unorm`
 * texture store by clamping to [0,1] and rounding to 8 bits.
 */
import { clamp01 } from './math';

/** Parameters accepted by {@link referenceCas}. */
export interface CasParams {
  sharpness: number;
}

const INV_255 = 1 / 255;
const MAX_CHANNEL = 255;
/**
 * Floor for the smooth-max divisor, mirroring the `max(mxRGB, 1e-8)` guard in
 * `cas.wgsl`. For any non-black 8-bit neighborhood `maxSum >= 2/255`, so this
 * never changes the normal path; it only keeps an all-black neighborhood finite
 * (`0 * Infinity` -> NaN).
 */
const MAX_SUM_EPSILON = 1e-8;

/**
 * Model an `rgba8unorm` `textureStore`: clamp to [0,1], scale to 8-bit and
 * round. `NaN` is mapped to 0 the same way an 8-bit unorm store behaves.
 */
function quantizeUnorm8(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.round(clamp01(value) * MAX_CHANNEL);
}

/**
 * Apply the shipped CAS filter on the CPU.
 *
 * @param input  RGBA8 buffer, length `width * height * 4`.
 * @param width  Image width in pixels.
 * @param height Image height in pixels.
 * @param params CAS parameters.
 * @returns A new RGBA8 buffer of length `width * height * 4` (alpha = 255).
 */
export function referenceCas(
  input: Uint8Array,
  width: number,
  height: number,
  params: CasParams,
): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`referenceCas: invalid dimensions ${width}x${height}`);
  }
  const expectedLength = width * height * 4;
  if (input.length !== expectedLength) {
    throw new Error(
      `referenceCas: input length ${input.length} does not match ${width}x${height}x4 (${expectedLength})`,
    );
  }

  const output = new Uint8Array(expectedLength);
  const sharpness = params.sharpness;
  const peak = -3 * sharpness + 8;

  // textureLoad of an rgba8unorm texture yields the normalized value in [0,1].
  const load = (x: number, y: number, channel: number): number =>
    input[(y * width + x) * 4 + channel] * INV_255;

  for (let y = 0; y < height; y++) {
    // Clamp to valid coordinates (matches the WGSL x0/x1/y0/y1).
    const y0 = Math.max(y - 1, 0);
    const y1 = Math.min(y + 1, height - 1);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(x - 1, 0);
      const x1 = Math.min(x + 1, width - 1);
      const outBase = (y * width + x) * 4;

      // CAS is per-channel; alpha is written unconditionally.
      for (let channel = 0; channel < 3; channel++) {
        // a b c
        // d e f
        // g h i
        const a = load(x0, y0, channel);
        const b = load(x, y0, channel);
        const c = load(x1, y0, channel);
        const d = load(x0, y, channel);
        const e = load(x, y, channel);
        const f = load(x1, y, channel);
        const g = load(x0, y1, channel);
        const h = load(x, y1, channel);
        const i = load(x1, y1, channel);

        // Soft min/max: cross pattern plus full 3x3, summed.
        const crossMin = Math.min(Math.min(d, e), Math.min(f, b), h);
        const fullMin = Math.min(crossMin, Math.min(Math.min(a, c), Math.min(g, i)));
        const minSum = crossMin + fullMin;

        const crossMax = Math.max(Math.max(d, e), Math.max(f, b), h);
        const fullMax = Math.max(crossMax, Math.max(Math.max(a, c), Math.max(g, i)));
        const maxSum = crossMax + fullMax;

        const reciprocalMax = 1 / Math.max(maxSum, MAX_SUM_EPSILON);
        let amplitude = clamp01(Math.min(minSum, 2 - maxSum) * reciprocalMax);
        amplitude = 1 / Math.sqrt(amplitude); // inverseSqrt

        const weight = -(1 / (amplitude * peak));
        const reciprocalWeight = 1 / (4 * weight + 1);

        const window = b + d + (f + h);
        const outColor = clamp01((window * weight + e) * reciprocalWeight);
        const result = e * (1 - sharpness) + outColor * sharpness; // mix(e, outColor, sharpness)

        output[outBase + channel] = quantizeUnorm8(result);
      }

      output[outBase + 3] = MAX_CHANNEL;
    }
  }

  return output;
}
