/**
 * Independent pure-TypeScript port of the shipped `src/shaders/color-adjust.wgsl`.
 *
 * DEV/TEST ONLY. Used as the CPU oracle by the headless-WebGPU correctness
 * gate. Production code must never import it. This module imports nothing, so
 * it can be loaded by the Playwright spec outside webpack/Vitest alias
 * resolution, and it deliberately does not read or parse the WGSL source.
 *
 * The port mirrors the WGSL line by line and in the same order:
 *   1. exposure        : color * 2^exposure (multiplicative)
 *   2. brightness      : color + brightness (additive)
 *   3. contrast        : (color - 0.5) * contrast + 0.5
 *   4. gamma           : clamp to [0,1] then pow(color, 1/max(gamma, 1e-4))
 *   5. saturation      : mix(luminance, color, saturation) with BT.709 luma
 *   6. vibrance        : mix(luminance2, color, 1 + vibrance * (1 - chroma))
 *   7. clamp to [0,1] and model the `rgba8unorm` store by rounding to 8 bits.
 *
 * Parameters match the `ColorAdjust` wrapper uniform layout:
 *   - `params`  (vec4<f32>): brightness, gamma, contrast, vibrance
 *   - `params2` (vec2<f32>): saturation, exposure
 */
import { clamp01 } from './math';

/** Parameters accepted by {@link referenceColorAdjust}. */
export interface ColorAdjustParams {
  brightness: number;
  gamma: number;
  contrast: number;
  saturation: number;
  vibrance: number;
  exposure: number;
}

const INV_255 = 1 / 255;
const MAX_CHANNEL = 255;
const EPSILON = 0.0001;

/**
 * Model an `rgba8unorm` `textureStore`: clamp to [0,1], scale to 8-bit and
 * round. `NaN` is mapped to 0 the same way an 8-bit unorm store behaves.
 */
function quantizeUnorm8(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.round(clamp01(value) * MAX_CHANNEL);
}

/** WGSL `mix(a, b, t)` == `a + (b - a) * t`. */
function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** BT.709 luminance coefficients used by the WGSL. */
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

function luminance(r: number, g: number, b: number): number {
  return LUMA_R * r + LUMA_G * g + LUMA_B * b;
}

/**
 * Apply the shipped ColorAdjust grading on the CPU.
 *
 * @param input  RGBA8 buffer, length `width * height * 4`.
 * @param width  Image width in pixels.
 * @param height Image height in pixels.
 * @param params Color adjustment parameters.
 * @returns A new RGBA8 buffer of length `width * height * 4` (alpha = 255).
 */
export function referenceColorAdjust(
  input: Uint8Array,
  width: number,
  height: number,
  params: ColorAdjustParams,
): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`referenceColorAdjust: invalid dimensions ${width}x${height}`);
  }
  const expectedLength = width * height * 4;
  if (input.length !== expectedLength) {
    throw new Error(
      `referenceColorAdjust: input length ${input.length} does not match `
      + `${width}x${height}x4 (${expectedLength})`,
    );
  }

  const output = new Uint8Array(expectedLength);
  const gamma = Math.max(params.gamma, EPSILON);
  const invGamma = 1 / gamma;
  const exposureGain = Math.pow(2, params.exposure);
  const { brightness, contrast, saturation, vibrance } = params;

  // textureLoad of an rgba8unorm texture yields the normalized value in [0,1].
  const load = (pixelIndex: number, channel: number): number =>
    input[pixelIndex * 4 + channel] * INV_255;

  const total = width * height;
  for (let pixel = 0; pixel < total; pixel++) {
    const outBase = pixel * 4;

    // 1-4: per-channel exposure -> brightness -> contrast -> clamp -> gamma.
    let r = load(pixel, 0);
    let g = load(pixel, 1);
    let b = load(pixel, 2);

    r = clamp01((r * exposureGain + brightness - 0.5) * contrast + 0.5);
    g = clamp01((g * exposureGain + brightness - 0.5) * contrast + 0.5);
    b = clamp01((b * exposureGain + brightness - 0.5) * contrast + 0.5);

    r = Math.pow(r, invGamma);
    g = Math.pow(g, invGamma);
    b = Math.pow(b, invGamma);

    // 5. Saturation around BT.709 luminance.
    const lum = luminance(r, g, b);
    r = mix(lum, r, saturation);
    g = mix(lum, g, saturation);
    b = mix(lum, b, saturation);

    // 6. Vibrance: recompute luminance after saturation, then mix by
    //    1 + vibrance * (1 - chroma), where chroma is max - min.
    const lum2 = luminance(r, g, b);
    const chroma = Math.max(r, Math.max(g, b)) - Math.min(r, Math.min(g, b));
    const factor = 1 + vibrance * (1 - chroma);
    r = mix(lum2, r, factor);
    g = mix(lum2, g, factor);
    b = mix(lum2, b, factor);

    // 7. Clamp and store.
    output[outBase] = quantizeUnorm8(r);
    output[outBase + 1] = quantizeUnorm8(g);
    output[outBase + 2] = quantizeUnorm8(b);
    output[outBase + 3] = MAX_CHANNEL;
  }

  return output;
}
