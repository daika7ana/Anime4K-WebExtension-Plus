/**
 * Deterministic test-signal helpers for the Downscale MTF experiment.
 *
 * DEV/TEST ONLY. Used by `signal.test.ts` (Vitest) and by the headless-WebGPU
 * `downscale-mtf.spec.ts` (Playwright). Production code must never import it.
 * This module imports nothing, so the Playwright spec can load it through a
 * relative path outside the webpack `@`/`@core` alias graph.
 *
 * Conventions:
 *   - Images are RGBA8 (`Uint8Array`, row-major, `width * height * 4`), alpha
 *     always 255. All generated channels stay strictly above zero (mirrors the
 *     fixture conventions used by the existing GPU gates).
 *   - "period" is always in **pixels** and refers to the stimulus grid (the
 *     Downscale input). A period-p sinusoid has frequency 1/p cycles/px; after
 *     a downscale by `ratio` it moves to `ratio/p` cycles/output-px.
 *   - Amplitudes are returned in the same units as the channel samples
 *     (8-bit levels, 0..255); retention ratios are unitless.
 */

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export type Axis = 'x' | 'y';

export interface GratingOptions {
  width: number;
  height: number;
  /** Period in pixels along `axis`. */
  period: number;
  /** Axis the sinusoid varies along. Defaults to `'x'`. */
  axis?: Axis;
  /** Mid-grey DC level (0..255). Defaults to 128. */
  dc?: number;
  /** Peak amplitude in 8-bit levels. Defaults to 64. */
  amplitude?: number;
  /** Phase in radians. Defaults to 0. */
  phase?: number;
}

export interface StepEdgeOptions {
  width: number;
  height: number;
  axis?: Axis;
  /** Low plateau (0..255). Defaults to 0. */
  low?: number;
  /** High plateau (0..255). Defaults to 255. */
  high?: number;
  /** Index of the first high sample along `axis`. Defaults to floor(size / 2). */
  position?: number;
}

export interface FundamentalOptions {
  /** Period in pixels. Supply either `period` or `frequency`. */
  period?: number;
  /** Frequency in cycles per pixel. Takes precedence over `period`. */
  frequency?: number;
  axis: Axis;
}

export interface MtfSpec {
  /** Downsample factor: source size / output size (same on both axes here). */
  ratio: number;
  /** Stimulus period in source pixels. */
  period: number;
  axis: Axis;
}

export interface EdgeResponse {
  /** Peak excursion above the high plateau, as a percentage of the step. */
  overshootPct: number;
  /** Peak excursion below the low plateau, as a percentage of the step. */
  undershootPct: number;
  /** Peak above-high excursion in 8-bit levels (0 when none). */
  maxOvershoot: number;
  /** Peak below-low excursion in 8-bit levels (0 when none). */
  maxUndershoot: number;
}

function clampByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 255) return 255;
  return Math.round(value);
}

function createImage(
  width: number,
  height: number,
  valueAt: (along: number, across: number) => number,
): RgbaImage {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`createImage: invalid dimensions ${width}x${height}`);
  }
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = clampByte(valueAt(x, y));
      const offset = (y * width + x) * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return { width, height, data };
}

/** Map (x, y) onto (along, across) for the chosen axis. */
function alongValue(axis: Axis, x: number, y: number): number {
  return axis === 'x' ? x : y;
}

/**
 * Mid-grey sinusoidal grating: grayscale (all channels equal, so every channel
 * is non-zero and the sRGB math is identical per channel). The sinusoid varies
 * along `axis` with period `period` source pixels.
 *
 * The carrier is a **cosine** so that every integer period (including the
 * Nyquist period 2) has non-zero samples; a sine with phase 0 samples to zero
 * at every pixel for period 2.
 */
export function makeGrating(options: GratingOptions): RgbaImage {
  const { width, height, period, axis = 'x', dc = 128, amplitude = 64, phase = 0 } = options;
  if (!(period > 0)) throw new Error(`makeGrating: period must be > 0 (got ${period})`);
  const omega = (2 * Math.PI) / period;
  return createImage(width, height, (x, y) => {
    const n = alongValue(axis, x, y);
    return dc + amplitude * Math.cos(omega * n + phase);
  });
}

/**
 * Hard step edge: `low` for samples before `position`, `high` from `position`
 * on. Grayscale. Defaults to a 0 -> 255 step at the centre.
 */
export function makeStepEdge(options: StepEdgeOptions): RgbaImage {
  const { width, height, axis = 'x', low = 0, high = 255 } = options;
  const size = axis === 'x' ? width : height;
  const position = options.position ?? Math.floor(size / 2);
  return createImage(width, height, (x, y) => {
    const n = alongValue(axis, x, y);
    return n >= position ? high : low;
  });
}

/**
 * Peak amplitude of the fundamental Fourier component at `frequency`
 * (cycles/px) along `axis`, in 8-bit levels (0..255).
 *
 * For every line perpendicular to `axis` the signal `s[n] = channel0` is
 * projected onto `exp(-2*pi*i*f*n)` with a Hann window, then normalized by the
 * window sum and doubled to recover the sinusoid's peak amplitude:
 *
 *     C = sum_n s[n] * w[n] * exp(-2*pi*i*f*n) / sum_n w[n]
 *     amplitude_line = 2 * |C|
 *
 * DC and harmonics are orthogonal to the fundamental and therefore ignored.
 * The Hann window keeps the estimate stable when an integer number of periods
 * does not fit the line; for an integer number of cycles it gives the exact
 * amplitude. The per-line amplitudes are averaged.
 *
 * At exactly Nyquist (f = 0.5) the positive and negative frequency components
 * coincide, so the projection already returns the peak amplitude and the
 * doubling factor is dropped.
 */
export function measureFundamental(image: RgbaImage, options: FundamentalOptions): number {
  const { axis } = options;
  const frequency = options.frequency ?? (options.period !== undefined ? 1 / options.period : NaN);
  if (!(frequency > 0) || !Number.isFinite(frequency)) {
    throw new Error(`measureFundamental: need a positive period or frequency (got ${frequency})`);
  }

  const { width, height, data } = image;
  const along = axis === 'x' ? width : height;
  const lines = axis === 'x' ? height : width;
  if (along <= 1) return 0;

  // Hann window (coherent gain is removed by the sum normalization).
  const window = new Float64Array(along);
  let sumWindow = 0;
  for (let n = 0; n < along; n++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (along - 1));
    window[n] = w;
    sumWindow += w;
  }

  const omega = 2 * Math.PI * frequency;
  // Peak amplitude = 2|C|, except at Nyquist where the ± frequency components
  // coincide and 2|C| already is the peak.
  const amplitudeScale = Math.abs(frequency - 0.5) < 1e-7 ? 1 : 2;
  let total = 0;

  for (let line = 0; line < lines; line++) {
    let re = 0;
    let im = 0;
    for (let n = 0; n < along; n++) {
      const index = axis === 'x' ? line * width + n : n * width + line;
      const sample = data[index * 4];
      const weighted = sample * window[n];
      re += weighted * Math.cos(omega * n);
      im -= weighted * Math.sin(omega * n);
    }
    re /= sumWindow;
    im /= sumWindow;
    total += amplitudeScale * Math.hypot(re, im);
  }

  return total / lines;
}

/**
 * Ideal area-average box MTF.
 *
 * The shipped `Downscale` is a fractional-coverage box of width `ratio` source
 * pixels (per axis). For an input sinusoid of period `period` source pixels
 * (input frequency f_in = 1/period cycles/px), the transfer function is
 *
 *     H = sinc(ratio * f_in) = sinc(ratio / period)
 *
 * where `sinc(x) = sin(pi*x) / (pi*x)` and the argument is also the output-domain
 * frequency `ratio/period` (cycles/output-px). This function returns |H|.
 *
 * Sanity points: ratio 2, period 2 -> 0 (the box nulls output Nyquist); ratio 2,
 * period 4 -> 2/pi ~= 0.6366; ratio 2, period much larger than ratio -> 1.
 *
 * Note: this is the **continuous** area-average response for a band-limited
 * input. The shipped kernel point-samples texel values and averages the
 * piecewise-constant signal, so near output Nyquist the measured sampled
 * retention can differ from this continuous prediction (e.g. ratio 2, period 4
 * measures ~0.5 because the sampled tone lands on the output Nyquist grid while
 * |sinc(0.5)| = 2/pi). The two converge for periods well above `ratio`.
 */
export function idealBoxMtf(ratio: number, period: number): number {
  if (!(ratio > 0)) throw new Error(`idealBoxMtf: ratio must be > 0 (got ${ratio})`);
  if (!(period > 0)) throw new Error(`idealBoxMtf: period must be > 0 (got ${period})`);
  const x = ratio / period;
  if (Math.abs(x) < 1e-9) return 1;
  return Math.abs(Math.sin(Math.PI * x) / (Math.PI * x));
}

/** Fold an output-domain frequency into [0, 0.5] (sampling alias). */
export function foldFrequency(frequency: number): number {
  let f = frequency;
  while (f > 0.5) f = Math.abs(1 - f);
  return f;
}

/**
 * Retention ratio of the fundamental across a kernel:
 * `outputFundamental / inputFundamental`.
 *
 * The input fundamental is measured at 1/period. The output fundamental is
 * measured at the (possibly folded) output frequency `ratio/period`; folding
 * models the output sampling when the stimulus is above output Nyquist. Returns
 * `null` when the fundamental aliases onto DC (frequency ~= 0 after folding),
 * where the fundamental is not recoverable by projection.
 */
export function mtfFromPair(input: RgbaImage, output: RgbaImage, spec: MtfSpec): number | null {
  const { ratio, period, axis } = spec;
  const inputAmplitude = measureFundamental(input, { period, axis });
  if (inputAmplitude < 1e-9) return null;

  const folded = foldFrequency(ratio / period);
  if (folded <= 1e-6) return null;

  const outputAmplitude = measureFundamental(output, { frequency: folded, axis });
  return outputAmplitude / inputAmplitude;
}

/**
 * Step-edge overshoot/undershoot as a percentage of the step height, measured
 * on the central line perpendicular to `axis` and excluding a `margin` at each
 * end (clamp-to-edge can distort the borders).
 */
export function measureEdgeResponse(
  image: RgbaImage,
  options: { axis: Axis; low: number; high: number; margin?: number },
): EdgeResponse {
  const { axis, low, high, margin = 8 } = options;
  const step = high - low;
  if (!(step > 0)) throw new Error(`measureEdgeResponse: high must exceed low (got ${step})`);

  const { width, height, data } = image;
  const along = axis === 'x' ? width : height;
  const across = axis === 'x' ? height : width;
  const line = Math.floor(across / 2);

  let maxOvershoot = 0;
  let maxUndershoot = 0;
  for (let n = margin; n < along - margin; n++) {
    const index = axis === 'x' ? line * width + n : n * width + line;
    const value = data[index * 4];
    if (value > high) maxOvershoot = Math.max(maxOvershoot, value - high);
    if (value < low) maxUndershoot = Math.max(maxUndershoot, low - value);
  }

  return {
    overshootPct: (100 * maxOvershoot) / step,
    undershootPct: (100 * maxUndershoot) / step,
    maxOvershoot,
    maxUndershoot,
  };
}
