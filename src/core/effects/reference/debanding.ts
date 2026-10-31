/**
 * Independent pure-TypeScript port of the shipped `src/shaders/debanding.wgsl`.
 *
 * DEV/TEST ONLY. Used as the CPU oracle by the headless-WebGPU correctness
 * gate. Production code must never import it. This module imports nothing, so
 * it can be loaded by the Playwright spec outside webpack/Vitest alias
 * resolution, and it deliberately does not read or parse the WGSL source.
 *
 * The port mirrors the WGSL line by line:
 *   - 4x4 Bayer ordered dither over `pos.x & 3`, `pos.y & 3`
 *   - cross neighbors at radius 1 and 2 with clamp-to-edge coordinates
 *   - average of the 8 neighbors, BT.709 luminance difference
 *   - `bandMask = 1 - smoothstep(0, bandThreshold, diff)`
 *   - `debanded = e + bayer * strength * 0.015 * bandMask` (same scalar on RGB)
 *   - clamp to [0,1] and model the `rgba8unorm` store by rounding to 8 bits.
 *
 * Parameters match the `Debanding` wrapper uniform layout: `vec2<f32>` where
 * `.x = strength` and `.y = bandThreshold`.
 */
import { clamp01 } from './math';

/** Parameters accepted by {@link referenceDebanding}. */
export interface DebandingParams {
  strength: number;
  bandThreshold: number;
}

const INV_255 = 1 / 255;
const MAX_CHANNEL = 255;

/** Standard 4x4 Bayer matrix, flattened row-major (matches the WGSL lookup). */
const BAYER4: readonly number[] = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
];

/**
 * Model an `rgba8unorm` `textureStore`: clamp to [0,1], scale to 8-bit and
 * round. `NaN` is mapped to 0 the same way an 8-bit unorm store behaves.
 */
function quantizeUnorm8(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.round(clamp01(value) * MAX_CHANNEL);
}

/** WGSL `smoothstep(edge0, edge1, x)`. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** 4x4 ordered dither, deterministic in [0,1]. Mirrors the WGSL `bayer4`. */
function bayer4(x: number, y: number): number {
  const xm = x & 3;
  const ym = y & 3;
  return (BAYER4[ym * 4 + xm] + 0.5) / 16;
}

/**
 * Apply the shipped Debanding filter on the CPU.
 *
 * @param input  RGBA8 buffer, length `width * height * 4`.
 * @param width  Image width in pixels.
 * @param height Image height in pixels.
 * @param params Debanding parameters (`strength`, `bandThreshold`).
 * @returns A new RGBA8 buffer of length `width * height * 4` (alpha = 255).
 */
export function referenceDebanding(
  input: Uint8Array,
  width: number,
  height: number,
  params: DebandingParams,
): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`referenceDebanding: invalid dimensions ${width}x${height}`);
  }
  const expectedLength = width * height * 4;
  if (input.length !== expectedLength) {
    throw new Error(
      `referenceDebanding: input length ${input.length} does not match `
      + `${width}x${height}x4 (${expectedLength})`,
    );
  }

  const output = new Uint8Array(expectedLength);
  const { strength, bandThreshold } = params;
  const noiseScale = strength * 0.015;

  // textureLoad of an rgba8unorm texture yields the normalized value in [0,1].
  const load = (x: number, y: number, channel: number): number =>
    input[(y * width + x) * 4 + channel] * INV_255;

  for (let y = 0; y < height; y++) {
    const y0 = Math.max(y - 1, 0);
    const y1 = Math.min(y + 1, height - 1);
    const y2 = Math.max(y - 2, 0);
    const y3 = Math.min(y + 2, height - 1);

    for (let x = 0; x < width; x++) {
      const x0 = Math.max(x - 1, 0);
      const x1 = Math.min(x + 1, width - 1);
      const x2 = Math.max(x - 2, 0);
      const x3 = Math.min(x + 2, width - 1);
      const outBase = (y * width + x) * 4;

      // e = center; n1..n4 = cross at radius 1; n5..n8 = cross at radius 2.
      const e: [number, number, number] = [load(x, y, 0), load(x, y, 1), load(x, y, 2)];
      const n1: [number, number, number] = [load(x0, y, 0), load(x0, y, 1), load(x0, y, 2)];
      const n2: [number, number, number] = [load(x1, y, 0), load(x1, y, 1), load(x1, y, 2)];
      const n3: [number, number, number] = [load(x, y0, 0), load(x, y0, 1), load(x, y0, 2)];
      const n4: [number, number, number] = [load(x, y1, 0), load(x, y1, 1), load(x, y1, 2)];
      const n5: [number, number, number] = [load(x2, y, 0), load(x2, y, 1), load(x2, y, 2)];
      const n6: [number, number, number] = [load(x3, y, 0), load(x3, y, 1), load(x3, y, 2)];
      const n7: [number, number, number] = [load(x, y2, 0), load(x, y2, 1), load(x, y2, 2)];
      const n8: [number, number, number] = [load(x, y3, 0), load(x, y3, 1), load(x, y3, 2)];

      // avg = sum(neighbors) / 8, then BT.709 luminance of center and average
      // (mirrors the WGSL, which averages the vec3 before the dot product).
      const avg: [number, number, number] = [0, 0, 0];
      const neighbors = [n1, n2, n3, n4, n5, n6, n7, n8];
      for (const neighbor of neighbors) {
        avg[0] += neighbor[0];
        avg[1] += neighbor[1];
        avg[2] += neighbor[2];
      }
      avg[0] /= 8;
      avg[1] /= 8;
      avg[2] /= 8;

      const lum = (c: [number, number, number]): number =>
        0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      const lumE = lum(e);
      const lumAvg = lum(avg);
      const diff = Math.abs(lumE - lumAvg);

      // Banding mask: lower threshold -> more aggressive detection.
      const bandMask = 1 - smoothstep(0, bandThreshold, diff);

      // Same scalar dither applied to all three channels.
      const dither = bayer4(x, y) * 2 - 1;
      const offset = dither * noiseScale * bandMask;

      output[outBase] = quantizeUnorm8(e[0] + offset);
      output[outBase + 1] = quantizeUnorm8(e[1] + offset);
      output[outBase + 2] = quantizeUnorm8(e[2] + offset);
      output[outBase + 3] = MAX_CHANNEL;
    }
  }

  return output;
}
