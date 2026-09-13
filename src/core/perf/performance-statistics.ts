/**
 * Pure (GPU-free) statistics helpers for the renderer's frame-time HUD.
 *
 * These utilities back {@link GpuTimestampProfiler}: the profiler pushes one
 * sample per label per sampled frame, and the HUD reads {@link RollingStats.summary}
 * at ~4 Hz (not every frame) to avoid sorting a window on the hot path.
 *
 * ## Percentile method
 * Percentiles use **linear interpolation between closest ranks** (the R-7
 * definition used by `numpy.percentile`, Excel `PERCENTILE.INC`, and most
 * profilers). For `n` sorted samples and a percentile `p` in `[0, 100]`:
 *
 * ```
 * rank  = (p / 100) * (n - 1)
 * lower = floor(rank)
 * upper = ceil(rank)
 * frac  = rank - lower
 * value = sorted[lower] + (sorted[upper] - sorted[lower]) * frac
 * ```
 *
 * `n === 1` returns the sole sample for every percentile and `n === 0` returns
 * zero for every requested percentile (matching the all-zero empty
 * {@link RollingStats.summary}).
 */

/** Default rolling-window length: ~2 s at 60 fps. */
export const DEFAULT_ROLLING_CAPACITY = 120;

/** Default percentile ranks (in percent) requested by {@link computePercentiles}. */
export const DEFAULT_PERCENTILE_POINTS: readonly number[] = [50, 95, 99];

/** Summary of a sample window. All fields are zero when `count === 0`. */
export interface PercentileSummary {
    count: number;
    min: number;
    max: number;
    mean: number;
    p50: number;
    p95: number;
    p99: number;
}

/**
 * Compute the percentile at each rank in `points` (each in `[0, 100]`) using
 * linear interpolation between closest ranks. The input is not mutated.
 *
 * @param samples - Sample values; order is irrelevant (a copy is sorted).
 * @param points - Percentile ranks in percent. Defaults to `[50, 95, 99]`.
 * @returns One interpolated value per requested point; zeros when `samples` is empty.
 */
export function computePercentiles(
    samples: readonly number[],
    points: readonly number[] = DEFAULT_PERCENTILE_POINTS,
): number[] {
    const sorted = [...samples].sort((a, b) => a - b);
    const n = sorted.length;
    if (n === 0) return points.map(() => 0);

    return points.map((point) => {
        const rank = (point / 100) * (n - 1);
        const lower = Math.floor(rank);
        const upper = Math.ceil(rank);
        if (lower === upper) return sorted[lower] as number;
        const frac = rank - lower;
        const lo = sorted[lower] as number;
        const hi = sorted[upper] as number;
        return lo + (hi - lo) * frac;
    });
}

/**
 * Fixed-capacity ring of recent samples with O(1) insertion.
 *
 * Only the most recent `capacity` samples are retained; older samples are
 * evicted implicitly as the ring wraps. `summary()` copies and sorts the live
 * window, so it is intended for HUD cadence (~4 Hz), not per frame.
 */
export class RollingStats {
    private readonly capacity: number;
    private readonly buffer: number[];
    private next = 0;
    private size = 0;

    constructor(capacity: number = DEFAULT_ROLLING_CAPACITY) {
        this.capacity = Math.max(1, Math.floor(capacity));
        this.buffer = new Array<number>(this.capacity);
    }

    /** Append a sample, evicting the oldest when the window is full. */
    push(value: number): void {
        this.buffer[this.next] = value;
        this.next = (this.next + 1) % this.capacity;
        if (this.size < this.capacity) this.size++;
    }

    /**
     * Summarize the live window. Empty windows return `count: 0` with every
     * numeric field equal to zero (never `NaN`/`Infinity`).
     */
    summary(): PercentileSummary {
        if (this.size === 0) {
            return { count: 0, min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 };
        }

        const samples = this.snapshot();
        let min = Infinity;
        let max = -Infinity;
        let sum = 0;
        for (const value of samples) {
            if (value < min) min = value;
            if (value > max) max = value;
            sum += value;
        }

        const [p50 = 0, p95 = 0, p99 = 0] = computePercentiles(samples);
        return {
            count: samples.length,
            min,
            max,
            mean: sum / samples.length,
            p50,
            p95,
            p99,
        };
    }

    /** Drop every sample, leaving the window empty and reusable. */
    clear(): void {
        this.next = 0;
        this.size = 0;
    }

    /** Copy the live window (insertion order; not sorted). */
    private snapshot(): number[] {
        const out: number[] = new Array<number>(this.size);
        for (let i = 0; i < this.size; i++) {
            out[i] = this.buffer[i] as number;
        }
        return out;
    }
}
