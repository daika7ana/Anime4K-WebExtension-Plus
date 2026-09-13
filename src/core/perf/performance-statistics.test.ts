/**
 * Tests for the pure statistics helpers backing the timestamp profiler:
 * percentile interpolation, empty windows, and ring-buffer eviction.
 */
import { describe, it, expect } from 'vitest';
import {
    computePercentiles,
    RollingStats,
    DEFAULT_ROLLING_CAPACITY,
} from './performance-statistics';

describe('computePercentiles', () => {
    it('returns zeros for an empty sample set', () => {
        expect(computePercentiles([])).toEqual([0, 0, 0]);
        expect(computePercentiles([], [25, 50, 75, 100])).toEqual([0, 0, 0, 0]);
    });

    it('interpolates linearly between closest ranks', () => {
        const result = computePercentiles([1, 2, 3, 4], [50, 95, 99]);
        // rank p50 = 1.5 -> 2.5; p95 = 2.85 -> 3.85; p99 = 2.97 -> 3.97
        expect(result[0]).toBeCloseTo(2.5, 10);
        expect(result[1]).toBeCloseTo(3.85, 10);
        expect(result[2]).toBeCloseTo(3.97, 10);
    });

    it('returns the sole sample for every point when n === 1', () => {
        expect(computePercentiles([42], [0, 50, 100])).toEqual([42, 42, 42]);
    });

    it('is order-independent and respects the 0/100 endpoints', () => {
        expect(computePercentiles([9, 1, 5], [0, 100])).toEqual([1, 9]);
        expect(computePercentiles([4, 3, 2, 1], [50])[0]).toBeCloseTo(2.5, 10);
    });
});

describe('RollingStats', () => {
    it('summarizes an empty window as all zeros', () => {
        expect(new RollingStats().summary()).toEqual({
            count: 0,
            min: 0,
            max: 0,
            mean: 0,
            p50: 0,
            p95: 0,
            p99: 0,
        });
    });

    it('computes count/min/max/mean and percentiles', () => {
        const stats = new RollingStats();
        for (const value of [1, 2, 3, 4]) stats.push(value);

        const summary = stats.summary();
        expect(summary.count).toBe(4);
        expect(summary.min).toBe(1);
        expect(summary.max).toBe(4);
        expect(summary.mean).toBeCloseTo(2.5, 10);
        expect(summary.p50).toBeCloseTo(2.5, 10);
        expect(summary.p95).toBeCloseTo(3.85, 10);
        expect(summary.p99).toBeCloseTo(3.97, 10);
    });

    it('evicts the oldest samples beyond capacity', () => {
        const stats = new RollingStats(3);
        for (const value of [10, 20, 30, 40]) stats.push(value);

        const summary = stats.summary();
        expect(summary.count).toBe(3);
        expect(summary.min).toBe(20);
        expect(summary.max).toBe(40);
        expect(summary.mean).toBe(30);
    });

    it('clear() empties the window and leaves it reusable', () => {
        const stats = new RollingStats(2);
        stats.push(1);
        stats.push(2);
        stats.clear();
        expect(stats.summary().count).toBe(0);

        stats.push(5);
        const summary = stats.summary();
        expect(summary.count).toBe(1);
        expect(summary.mean).toBe(5);
    });

    it('defaults to a 120-sample window (~2s at 60fps)', () => {
        expect(DEFAULT_ROLLING_CAPACITY).toBe(120);
        const stats = new RollingStats();
        for (let i = 0; i < 130; i++) stats.push(i);

        const summary = stats.summary();
        expect(summary.count).toBe(120);
        expect(summary.min).toBe(10);
        expect(summary.max).toBe(129);
    });
});
