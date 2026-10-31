/**
 * Tests for {@link computeRemainingUpscaleFactors} and
 * {@link planIntermediateDownscale} — the shared per-step remaining-factor
 * heuristic used by both the pipeline builder and the GPU benchmark.
 *
 * The heuristic must reproduce the previous inline behavior byte-for-byte:
 * width-only trigger, strict `>` against `ideal * 1.1`, `Math.ceil` on each axis.
 */
import { describe, it, expect } from 'vitest';
import type { BaseMode, Dimensions, EnhancementEffect, PerformanceTier } from '@/types';
import { resolveEffectChain } from '@utils/effect-chain-templates';
import {
    computeRemainingUpscaleFactors,
    planIntermediateDownscale,
    planChainGeometryPreview,
    isSuppressedIndex,
    INTERMEDIATE_DOWNSCALE_THRESHOLD,
    MIN_DOWNSCALE_HEIGHT,
    DEFAULT_MAX_INTERMEDIATE_PIXELS,
    type ChainGeometryLimits,
    type RestoreSuppression,
} from './effect-chain';

/** Build a minimal effect whose only relevant field is `upscaleFactor`. */
function effect(upscaleFactor?: number): Pick<EnhancementEffect, 'upscaleFactor'> {
    return { upscaleFactor };
}

describe('computeRemainingUpscaleFactors', () => {
    it('returns the product of every later upscale factor', () => {
        expect(computeRemainingUpscaleFactors([effect(1), effect(2), effect(1), effect(2)]))
            .toEqual([4, 2, 2, 1]);
    });

    it('returns all ones for an all-1 chain', () => {
        expect(computeRemainingUpscaleFactors([effect(1), effect(1), effect(1)]))
            .toEqual([1, 1, 1]);
    });

    it('returns 1 for the final element of a chain ending in an upscale', () => {
        expect(computeRemainingUpscaleFactors([effect(1), effect(2)])).toEqual([2, 1]);
        expect(computeRemainingUpscaleFactors([effect(2)])).toEqual([1]);
    });

    it('returns an empty array for an empty chain', () => {
        expect(computeRemainingUpscaleFactors([])).toEqual([]);
    });

    it('treats effects without an upscaleFactor as factor 1', () => {
        expect(computeRemainingUpscaleFactors([
            {},
            { upscaleFactor: 2 },
            {},
        ])).toEqual([2, 1, 1]);
    });

    it('falls back to 1 for an explicit undefined upscaleFactor', () => {
        expect(computeRemainingUpscaleFactors([effect(undefined), effect(2)]))
            .toEqual([2, 1]);
    });
});

describe('planIntermediateDownscale', () => {
    it('plans an intermediate Downscale when the current width overshoots', () => {
        const plan = planIntermediateDownscale({
            curWidth: 3840,
            curHeight: 2160,
            targetDimensions: { width: 1920, height: 1080 },
            remainingFactor: 2,
        });

        // ideal = 1920 / 2 = 960, 1080 / 2 = 540
        expect(plan).toEqual({ width: 960, height: 540 });
    });

    it('returns null when there is no remaining upscale (remainingFactor <= 1)', () => {
        expect(planIntermediateDownscale({
            curWidth: 100_000,
            curHeight: 100_000,
            targetDimensions: { width: 1920, height: 1080 },
            remainingFactor: 1,
        })).toBeNull();

        expect(planIntermediateDownscale({
            curWidth: 100_000,
            curHeight: 100_000,
            targetDimensions: { width: 1920, height: 1080 },
            remainingFactor: 0.5,
        })).toBeNull();
    });

    it('returns null at the exact threshold boundary (strict >)', () => {
        const ideal = 1920 / 2; // 960
        const boundary = ideal * INTERMEDIATE_DOWNSCALE_THRESHOLD; // 1056

        expect(planIntermediateDownscale({
            curWidth: boundary,
            curHeight: 1080,
            targetDimensions: { width: 1920, height: 1080 },
            remainingFactor: 2,
        })).toBeNull();
    });

    it('plans a Downscale just above the threshold boundary', () => {
        const ideal = 1920 / 2; // 960
        const boundary = ideal * INTERMEDIATE_DOWNSCALE_THRESHOLD; // 1056

        expect(planIntermediateDownscale({
            curWidth: boundary + 1,
            curHeight: 1080,
            targetDimensions: { width: 1920, height: 1080 },
            remainingFactor: 2,
        })).toEqual({ width: 960, height: 540 });
    });

    it('rounds each axis up independently with Math.ceil', () => {
        const plan = planIntermediateDownscale({
            curWidth: 2000,
            curHeight: 2000,
            targetDimensions: { width: 1921, height: 1081 },
            remainingFactor: 2,
        });

        // ideal = 960.5 x 540.5 -> ceil 961 x 541
        expect(plan).toEqual({ width: 961, height: 541 });
    });

    it('uses width only as the trigger, ignoring the current height', () => {
        // Width below threshold with an enormous height -> no Downscale.
        expect(planIntermediateDownscale({
            curWidth: 1000,
            curHeight: 100_000,
            targetDimensions: { width: 1920, height: 1080 },
            remainingFactor: 2,
        })).toBeNull();

        // Width above threshold with a tiny height -> Downscale still planned.
        expect(planIntermediateDownscale({
            curWidth: 2000,
            curHeight: 1,
            targetDimensions: { width: 1920, height: 1080 },
            remainingFactor: 2,
        })).toEqual({ width: 960, height: 540 });
    });

    it('matches the plan the old inline benchmark traversal produced', () => {
        // Benchmark scene: 1080p source, 4K target, chain upscale factors [1,2,1,2].
        // Traversal mirrors runEffectChainTest: upscale then decide, threading dims.
        const effects = [effect(1), effect(2), effect(1), effect(2)];
        const remaining = computeRemainingUpscaleFactors(effects);
        const target: Dimensions = { width: 3840, height: 2160 };

        let curWidth = 1920;
        let curHeight = 1080;
        const inserted: Dimensions[] = [];

        effects.forEach((e, i) => {
            const factor = e.upscaleFactor ?? 1;
            if (factor > 1) {
                curWidth *= factor;
                curHeight *= factor;

                const plan = planIntermediateDownscale({
                    curWidth,
                    curHeight,
                    targetDimensions: target,
                    remainingFactor: remaining[i],
                });
                if (plan) {
                    inserted.push(plan);
                    curWidth = plan.width;
                    curHeight = plan.height;
                }
            }
        });

        // Step index 1 (2x, remaining 2) overshoots 3840 > 1920*1.1 -> insert 1920x1080.
        // Step index 3 (2x, remaining 1) has no remaining upscale -> no insert.
        expect(inserted).toEqual([{ width: 1920, height: 1080 }]);
        expect({ width: curWidth, height: curHeight }).toEqual({ width: 3840, height: 2160 });

        // The single triggering call, spelled out.
        expect(planIntermediateDownscale({
            curWidth: 3840,
            curHeight: 2160,
            targetDimensions: target,
            remainingFactor: 2,
        })).toEqual({ width: 1920, height: 1080 });
    });
});

describe('planChainGeometryPreview', () => {
    const source: Dimensions = { width: 1920, height: 1080 };
    const preview = (upscaleFactors: number[], targetDimensions: Dimensions) =>
        planChainGeometryPreview({ sourceDimensions: source, targetDimensions, upscaleFactors });

    it('plans the exact C+A / ultra case at 1080p (equal target)', () => {
        // [ClampHighlights, DenoiseCNNx2VL(2x), CNNUL, CNNx2UL(2x)] with T == S.
        // The first upscaler (index 1) is retained, the later one suppressed, and
        // a single Downscale to exactly 1920x1080 is emitted right after it.
        expect(preview([1, 2, 1, 2], { width: 1920, height: 1080 }))
            .toEqual({ suppressFromIndex: 1, finalDownscale: { width: 1920, height: 1080 }, finalDownscaleAfterIndex: 1 });
    });

    it('plans the exact C+A / ultra case at 720p (shrinking target)', () => {
        expect(preview([1, 2, 1, 2], { width: 1280, height: 720 }))
            .toEqual({ suppressFromIndex: 1, finalDownscale: { width: 1280, height: 720 }, finalDownscaleAfterIndex: 1 });
    });

    it('retains only the first upscaler for shrinking/equal targets', () => {
        // Factors [1, 2, 1, 2, 2]: first upscaler is index 1; every later
        // upscaler (index 3, 4) is suppressed.
        expect(preview([1, 2, 1, 2, 2], { width: 1280, height: 720 }))
            .toEqual({ suppressFromIndex: 1, finalDownscale: { width: 1280, height: 720 }, finalDownscaleAfterIndex: 1 });
    });

    it('returns the legacy preview for a chain with no upscaling effect', () => {
        const legacy = { suppressFromIndex: null, finalDownscale: null, finalDownscaleAfterIndex: null };
        expect(preview([1, 1, 1], { width: 1280, height: 720 })).toEqual(legacy);
        expect(preview([], { width: 1280, height: 720 })).toEqual(legacy);
    });

    it('respects the 720p floor for sub-720p targets', () => {
        // 540p target: below MIN_DOWNSCALE_HEIGHT -> legacy path unchanged.
        expect(preview([1, 2, 1, 2], { width: 960, height: 540 }))
            .toEqual({ suppressFromIndex: null, finalDownscale: null, finalDownscaleAfterIndex: null });
        // Exactly 720p engages the safe branch.
        expect(preview([1, 2, 1, 2], { width: 1280, height: MIN_DOWNSCALE_HEIGHT }).suppressFromIndex)
            .toBe(1);
    });

    it('does not trigger when the legacy ideal is not below the source (condition 2)', () => {
        // Single upscaler: R == 1 after it, so ideal == target (>= source).
        expect(preview([1, 2], { width: 2560, height: 1440 }))
            .toEqual({ suppressFromIndex: null, finalDownscale: null, finalDownscaleAfterIndex: null });
    });

    it('does not trigger when the current width does not overshoot the ideal by >10% (condition 3)', () => {
        // Fractional factors keep `cur` inside the 1.1x overshoot band; with the
        // real integer factors (>=2) conditions 1+2 imply the overshoot.
        expect(preview([1.02, 1.1], { width: 2000, height: 1125 }))
            .toEqual({ suppressFromIndex: null, finalDownscale: null, finalDownscaleAfterIndex: null });
        // Just past the boundary the same shape does trigger.
        expect(preview([1.05, 1.1], { width: 2000, height: 1125 }))
            .toEqual({ suppressFromIndex: 0, finalDownscale: { width: 2000, height: 1125 }, finalDownscaleAfterIndex: 0 });
    });

    it('plans the exact C+A / ultra defect case (1080p -> 2K)', () => {
        // [ClampHighlights, DenoiseCNNx2VL(2x), CNNUL, CNNx2UL(2x)]
        expect(preview([1, 2, 1, 2], { width: 2560, height: 1440 }))
            .toEqual({ suppressFromIndex: 1, finalDownscale: { width: 2560, height: 1440 }, finalDownscaleAfterIndex: 1 });
    });

    it('appends no final Downscale when the trigger leaves the size at/below the target', () => {
        // A+A / ultra at 4K: [1,1,2,1,2,1,2] -> trigger at index 2, final 3840.
        expect(preview([1, 1, 2, 1, 2, 1, 2], { width: 3840, height: 2160 }))
            .toEqual({ suppressFromIndex: 2, finalDownscale: null, finalDownscaleAfterIndex: null });
    });

    it('handles empty and all-1 chains without triggering', () => {
        expect(preview([], { width: 2560, height: 1440 }))
            .toEqual({ suppressFromIndex: null, finalDownscale: null, finalDownscaleAfterIndex: null });
        expect(preview([1, 1, 1], { width: 2560, height: 1440 }))
            .toEqual({ suppressFromIndex: null, finalDownscale: null, finalDownscaleAfterIndex: null });
    });
});

describe('isSuppressedIndex', () => {
    it('suppresses only later upscaling effects', () => {
        const upscaleFactors = [1, 2, 1, 2];
        const preview = planChainGeometryPreview({
            sourceDimensions: { width: 1920, height: 1080 },
            targetDimensions: { width: 2560, height: 1440 },
            upscaleFactors,
        });

        expect(upscaleFactors.map((_, i) => isSuppressedIndex(preview, upscaleFactors, i)))
            .toEqual([false, false, false, true]);
    });

    it('retains the first upscaler and suppresses later ones for shrinking targets', () => {
        const upscaleFactors = [1, 2, 1, 2];
        const preview = planChainGeometryPreview({
            sourceDimensions: { width: 1920, height: 1080 },
            targetDimensions: { width: 1280, height: 720 },
            upscaleFactors,
        });

        // Index 1 is the retained first upscaler (`index > suppressFromIndex`
        // is false for it); index 3 is suppressed.
        expect(upscaleFactors.map((_, i) => isSuppressedIndex(preview, upscaleFactors, i)))
            .toEqual([false, false, false, true]);
    });

    it('suppresses nothing when the preview did not trigger', () => {
        const upscaleFactors = [1, 2, 1, 2];
        // Sub-720p target: below the floor, so the legacy path is used.
        const preview = planChainGeometryPreview({
            sourceDimensions: { width: 1920, height: 1080 },
            targetDimensions: { width: 960, height: 540 },
            upscaleFactors,
        });

        expect(upscaleFactors.map((_, i) => isSuppressedIndex(preview, upscaleFactors, i)))
            .toEqual([false, false, false, false]);
    });
});

describe('isSuppressedIndex (restore rule)', () => {
    const RESTORE_SOURCE: Dimensions = { width: 1920, height: 1080 };
    // A+A / ultra: [ClampHighlights, CNNUL, CNNx2UL(2), CNNUL, CNNx2UL(2), CNNUL, CNNx2VL(2)].
    const A_A_ULTRA = [1, 1, 2, 1, 2, 1, 2];
    const A_A_ULTRA_RESTORE = [false, true, false, true, false, true, false];

    const suppressed = (
        upscaleFactors: number[],
        restoreFlags: boolean[],
        target: Dimensions,
        restoreSuppression: RestoreSuppression,
    ): boolean[] => {
        const preview = planChainGeometryPreview({
            sourceDimensions: RESTORE_SOURCE,
            targetDimensions: target,
            upscaleFactors,
            restoreFlags,
            restoreSuppression,
        });
        return upscaleFactors.map((_, i) => isSuppressedIndex(preview, upscaleFactors, i));
    };

    it("V2 'trailing' suppresses restores after the final Downscale only", () => {
        // 1080p -> 2K: final Downscale after index 2, so trailing restores 3 and 5 go.
        expect(suppressed(A_A_ULTRA, A_A_ULTRA_RESTORE, { width: 2560, height: 1440 }, 'trailing'))
            .toEqual([false, false, false, true, true, true, true]);
    });

    it("'off' (V1) keeps the full chain in the shrinking/equal-target branch (A+A @1080p)", () => {
        // A+A / ultra @1080p: the equal-target branch anchors the Downscale after
        // the retained upscaler at index 2. V1 keeps every restore; V2 drops the
        // two that run after the Downscale and keeps the leading one at index 1.
        expect(suppressed(A_A_ULTRA, A_A_ULTRA_RESTORE, { width: 1920, height: 1080 }, 'off'))
            .toEqual([false, false, false, false, true, false, true]);
        expect(suppressed(A_A_ULTRA, A_A_ULTRA_RESTORE, { width: 1920, height: 1080 }, 'trailing'))
            .toEqual([false, false, false, true, true, true, true]);
    });

    it('handles an anchored final Downscale at index 0', () => {
        // [2x, 2x, scale-1 restore] from 1080p -> 2K: the first upscaler triggers
        // the safe geometry and the final Downscale is anchored at index 0 (the
        // falsy-boundary case). The restore at index 2 sits after it and is
        // dropped by the trailing policy.
        const factors = [2, 2, 1];
        const preview = planChainGeometryPreview({
            sourceDimensions: RESTORE_SOURCE,
            targetDimensions: { width: 2560, height: 1440 },
            upscaleFactors: factors,
            restoreFlags: [false, false, true],
            restoreSuppression: 'trailing',
        });

        expect(preview.suppressFromIndex).toBe(0);
        expect(preview.finalDownscale).toEqual({ width: 2560, height: 1440 });
        expect(preview.finalDownscaleAfterIndex).toBe(0);
        expect(isSuppressedIndex(preview, factors, 1)).toBe(true);
        expect(isSuppressedIndex(preview, factors, 2)).toBe(true);
    });

    it("'off' keeps every restore (only upscalers are suppressed)", () => {
        expect(suppressed(A_A_ULTRA, A_A_ULTRA_RESTORE, { width: 2560, height: 1440 }, 'off'))
            .toEqual([false, false, false, false, true, false, true]);
    });

    it("'gate' never drops a restore (retained restores are gated downstream)", () => {
        // 'gate' keeps every restore exactly like 'off'; each retained restore
        // is wrapped in the gate at compile time. At 2K the final Downscale sits
        // after index 2, but gate suppresses nothing; at 4K there is no final
        // Downscale either.
        expect(suppressed(A_A_ULTRA, A_A_ULTRA_RESTORE, { width: 2560, height: 1440 }, 'gate'))
            .toEqual([false, false, false, false, true, false, true]);
        expect(suppressed(A_A_ULTRA, A_A_ULTRA_RESTORE, { width: 3840, height: 2160 }, 'gate'))
            .toEqual([false, false, false, false, true, false, true]);
    });

    it("'leading' drops only the restores before the first retained upscaler (A+A @2K and @4K)", () => {
        // A+A / ultra: the first retained upscaler is the CNNx2UL at index 2.
        // The head restore at index 1 sits before it and is dropped; the two
        // target-resolution restores (indices 3 and 5) are kept. At 4K there is
        // no final Downscale, but the leading boundary is unchanged.
        expect(suppressed(A_A_ULTRA, A_A_ULTRA_RESTORE, { width: 2560, height: 1440 }, 'leading'))
            .toEqual([false, true, false, false, true, false, true]);
        expect(suppressed(A_A_ULTRA, A_A_ULTRA_RESTORE, { width: 3840, height: 2160 }, 'leading'))
            .toEqual([false, true, false, false, true, false, true]);
    });

    it("'leading' drops the same leading restore in the equal-target branch (A+A @1080p)", () => {
        expect(suppressed(A_A_ULTRA, A_A_ULTRA_RESTORE, { width: 1920, height: 1080 }, 'leading'))
            .toEqual([false, true, false, false, true, false, true]);
    });

    it("'leading' drops nothing when the preview retains no upscaler", () => {
        // All-scale-1 chain: there is no retained upscaler to define the leading
        // boundary, so no restore can be "before" one.
        const factors = [1, 1, 1];
        const flags = [false, true, true];
        expect(suppressed(factors, flags, { width: 2560, height: 1440 }, 'leading'))
            .toEqual([false, false, false]);
        expect(suppressed(factors, flags, { width: 2560, height: 1440 }, 'off'))
            .toEqual([false, false, false]);
    });

    it('never suppresses an index that is not flagged as a restore', () => {
        // Index 0 (ClampHighlights, helper) has a false flag; no policy may touch it.
        for (const policy of ['off', 'trailing'] as const) {
            expect(suppressed(A_A_ULTRA, A_A_ULTRA_RESTORE, { width: 2560, height: 1440 }, policy)[0])
                .toBe(false);
        }
        // The rule keys off the flags: a false flag is never suppressed even if
        // it sits in the trailing window.
        const noFlags = A_A_ULTRA_RESTORE.map(() => false);
        expect(suppressed(A_A_ULTRA, noFlags, { width: 2560, height: 1440 }, 'trailing'))
            .toEqual([false, false, false, false, true, false, true]);
    });

    it('trailing suppression requires a final Downscale (4K A+A/ultra no-op)', () => {
        // 4K target: finalDownscaleAfterIndex is null, so nothing trailing is
        // dropped. V1 ('off') is identical here because there is no emitted
        // Downscale for either policy to suppress after.
        expect(suppressed(A_A_ULTRA, A_A_ULTRA_RESTORE, { width: 3840, height: 2160 }, 'trailing'))
            .toEqual([false, false, false, false, true, false, true]);
        expect(suppressed(A_A_ULTRA, A_A_ULTRA_RESTORE, { width: 3840, height: 2160 }, 'off'))
            .toEqual([false, false, false, false, true, false, true]);
    });

    it('suppresses trailing restores in the shrinking/equal-target branch', () => {
        // C+A / ultra at 1080p: [Clamp, DenoiseCNNx2VL(2), CNNUL, CNNx2UL(2)].
        const factors = [1, 2, 1, 2];
        const flags = [false, false, true, false];
        expect(suppressed(factors, flags, { width: 1920, height: 1080 }, 'trailing'))
            .toEqual([false, false, true, true]);
        expect(suppressed(factors, flags, { width: 1920, height: 1080 }, 'off'))
            .toEqual([false, false, false, true]);
    });

    it('leaves the sub-720p legacy path unchanged under every policy', () => {
        const factors = [1, 2, 1, 2];
        const flags = [false, true, false, true];
        for (const policy of ['off', 'trailing'] as const) {
            expect(suppressed(factors, flags, { width: 960, height: 540 }, policy))
                .toEqual([false, false, false, false]);
        }
    });

    it('suppresses no restore when no restoreFlags are supplied (legacy callers)', () => {
        const factors = [1, 1, 2, 1, 2, 1, 2];
        const preview = planChainGeometryPreview({
            sourceDimensions: RESTORE_SOURCE,
            targetDimensions: { width: 2560, height: 1440 },
            upscaleFactors: factors,
        });
        expect(factors.map((_, i) => isSuppressedIndex(preview, factors, i)))
            .toEqual([false, false, false, false, true, false, true]);
    });
});

// ─── Shared geometry simulation (mirrors the builder/benchmark traversal) ───

const GEOMETRY_MODES: BaseMode[] = ['A', 'B', 'C', 'A+A', 'B+B', 'C+A'];
const GEOMETRY_TIERS: PerformanceTier[] = ['performance', 'balanced', 'quality', 'ultra'];
const SOURCE_1080P: Dimensions = { width: 1920, height: 1080 };
const SOURCE_4K: Dimensions = { width: 3840, height: 2160 };

const factorOf = (effect: EnhancementEffect): number => effect.upscaleFactor ?? 1;

interface SimulatedGeometry {
    sequence: string[];
    stages: Dimensions[];
    downscales: Dimensions[];
    final: Dimensions;
}

/** Mirrors the legacy per-step traversal in the builder/benchmark. */
function legacyGeometry(
    source: Dimensions,
    effects: EnhancementEffect[],
    target: Dimensions,
): SimulatedGeometry {
    const remaining = computeRemainingUpscaleFactors(effects);
    let width = source.width;
    let height = source.height;
    const stages: Dimensions[] = [{ width, height }];
    const downscales: Dimensions[] = [];
    const sequence: string[] = [];

    effects.forEach((effect, i) => {
        const factor = factorOf(effect);
        if (factor > 1) {
            width *= factor;
            height *= factor;
            sequence.push(effect.className);
            stages.push({ width, height });

            const plan = planIntermediateDownscale({
                curWidth: width,
                curHeight: height,
                targetDimensions: target,
                remainingFactor: remaining[i],
            });
            if (plan) {
                width = plan.width;
                height = plan.height;
                sequence.push('Downscale');
                stages.push({ width, height });
                downscales.push({ width, height });
            }
        } else {
            sequence.push(effect.className);
        }
    });

    return { sequence, stages, downscales, final: { width, height } };
}

/** Mirrors the new builder/benchmark traversal (safe-geometry suppression). */
function newGeometry(
    source: Dimensions,
    effects: EnhancementEffect[],
    target: Dimensions,
    limits?: ChainGeometryLimits,
): SimulatedGeometry & { preview: ReturnType<typeof planChainGeometryPreview> } {
    const upscaleFactors = effects.map(factorOf);
    const preview = planChainGeometryPreview({
        sourceDimensions: source,
        targetDimensions: target,
        upscaleFactors,
        limits,
    });

    if (preview.suppressFromIndex === null) {
        return { ...legacyGeometry(source, effects, target), preview };
    }

    let width = source.width;
    let height = source.height;
    const stages: Dimensions[] = [{ width, height }];
    const downscales: Dimensions[] = [];
    const sequence: string[] = [];

    effects.forEach((effect, i) => {
        if (isSuppressedIndex(preview, upscaleFactors, i)) {
            // A limit-guard preview anchors its final Downscale at the
            // suppressed upscaler's slot; emit it from the pre-upscale texture.
            if (preview.finalDownscale && preview.finalDownscaleAfterIndex === i) {
                width = preview.finalDownscale.width;
                height = preview.finalDownscale.height;
                sequence.push('Downscale');
                stages.push({ width, height });
                downscales.push({ width, height });
            }
            return;
        }
        const factor = factorOf(effect);
        if (factor > 1) {
            width *= factor;
            height *= factor;
            stages.push({ width, height });
        }
        sequence.push(effect.className);

        // The single final Downscale is emitted immediately after the retained
        // upscaler, before any trailing scale-1 effects.
        if (preview.finalDownscale && preview.finalDownscaleAfterIndex === i) {
            width = preview.finalDownscale.width;
            height = preview.finalDownscale.height;
            sequence.push('Downscale');
            stages.push({ width, height });
            downscales.push({ width, height });
        }
    });

    return { sequence, stages, downscales, final: { width, height }, preview };
}

function runChainGeometryTable(
    sourceLabel: string,
    source: Dimensions,
    targets: Array<[string, Dimensions]>,
) {
    describe(`built-in chain geometry (${sourceLabel})`, () => {
        for (const mode of GEOMETRY_MODES) {
            for (const tier of GEOMETRY_TIERS) {
                for (const [targetName, target] of targets) {
                    const label = `${mode}/${tier} @ ${targetName}`;

                    it(`keeps the safe geometry for ${label}`, () => {
                        const effects = resolveEffectChain(mode, tier);
                        const legacy = legacyGeometry(source, effects, target);
                        const next = newGeometry(source, effects, target);

                        if (next.preview.suppressFromIndex === null) {
                            // (c) Non-triggering chains must be byte-identical to legacy.
                            expect(next.sequence, `${label}: sequence`).toEqual(legacy.sequence);
                            expect(next.stages, `${label}: stages`).toEqual(legacy.stages);
                            expect(next.downscales, `${label}: downscales`).toEqual(legacy.downscales);
                            expect(next.final, `${label}: final`).toEqual(legacy.final);
                            return;
                        }

                        // (a) Triggered chains never drop below min(source, target).
                        const minWidth = Math.min(source.width, target.width);
                        const minHeight = Math.min(source.height, target.height);
                        for (const stage of next.stages) {
                            expect(stage.width, `${label}: width below min at ${JSON.stringify(stage)}`)
                                .toBeGreaterThanOrEqual(minWidth);
                            expect(stage.height, `${label}: height below min at ${JSON.stringify(stage)}`)
                                .toBeGreaterThanOrEqual(minHeight);
                        }

                        // (b) A single final Downscale lands exactly on the target
                        // and is emitted directly after the retained upscaler.
                        if (next.preview.finalDownscale) {
                            expect(next.final, `${label}: final size`).toEqual(target);
                            const after = next.preview.finalDownscaleAfterIndex;
                            expect(after).not.toBeNull();
                            // All effects up to and including the retained upscaler
                            // are present, so the Downscale occupies slot `after + 1`.
                            expect(next.sequence[(after as number) + 1], `${label}: Downscale placement`)
                                .toBe('Downscale');
                            expect(next.downscales, `${label}: downscale count`).toHaveLength(1);
                            expect(next.downscales[0], `${label}: downscale target`).toEqual(target);

                            // Never below the render target, and (when the target is
                            // at/above the floor) never below 720p.
                            expect(next.downscales[0].width, `${label}: downscale width`)
                                .toBeGreaterThanOrEqual(target.width);
                            expect(next.downscales[0].height, `${label}: downscale height`)
                                .toBeGreaterThanOrEqual(target.height);
                            if (target.height >= MIN_DOWNSCALE_HEIGHT) {
                                expect(next.downscales[0].height, `${label}: downscale below 720p`)
                                    .toBeGreaterThanOrEqual(MIN_DOWNSCALE_HEIGHT);
                            }
                        }
                    });
                }
            }
        }
    });
}

runChainGeometryTable('1080p source', SOURCE_1080P, [
    ['720p', { width: 1280, height: 720 }],
    ['1080p (native)', { width: 1920, height: 1080 }],
    ['2k', { width: 2560, height: 1440 }],
    ['4k', { width: 3840, height: 2160 }],
    ['x2', { width: 3840, height: 2160 }],
    ['x4', { width: 7680, height: 4320 }],
]);

runChainGeometryTable('4K source', SOURCE_4K, [
    ['720p', { width: 1280, height: 720 }],
    ['1080p', { width: 1920, height: 1080 }],
    ['2k', { width: 2560, height: 1440 }],
    ['4k (native)', { width: 3840, height: 2160 }],
]);

// ─── Intermediate texture limits (maxTextureDimension2D + pixel budget) ───

/** A realistic adapter ceiling (matches the test WebGPU mock). */
const DEVICE_LIMITS: ChainGeometryLimits = {
    maxDimension: 8192,
    maxIntermediatePixels: DEFAULT_MAX_INTERMEDIATE_PIXELS,
};
const SOURCE_8K: Dimensions = { width: 7680, height: 4320 };
const TARGET_4K: Dimensions = { width: 3840, height: 2160 };
const TARGET_8K: Dimensions = { width: 7680, height: 4320 };

const previewWithLimits = (
    source: Dimensions,
    target: Dimensions,
    upscaleFactors: number[],
    limits: ChainGeometryLimits = DEVICE_LIMITS,
) => planChainGeometryPreview({
    sourceDimensions: source,
    targetDimensions: target,
    upscaleFactors,
    limits,
});

describe('planChainGeometryPreview limits', () => {
    it('exposes the 256 MB / 8-byte rgba16float intermediate pixel budget', () => {
        expect(DEFAULT_MAX_INTERMEDIATE_PIXELS).toBe(33_554_432);
        // 8K UHD exactly; a 2x from 4K fits, a 2x from 8K does not.
        expect(7680 * 4320).toBeLessThanOrEqual(DEFAULT_MAX_INTERMEDIATE_PIXELS);
        expect(15360 * 8640).toBeGreaterThan(DEFAULT_MAX_INTERMEDIATE_PIXELS);
    });

    it('suppresses a 2x upscaler from an 8K source instead of emitting a 15360-wide intermediate', () => {
        const preview = previewWithLimits(SOURCE_8K, TARGET_8K, [2]);

        expect(preview.suppressFromIndex).toBe(0);
        expect(preview.finalDownscale).toBeNull(); // pre-upscale 8K does not exceed the 8K target
        // No Downscale is emitted, so no anchor is set (restore suppression must
        // not key off the suppressed upscaler's slot).
        expect(preview.finalDownscaleAfterIndex).toBeNull();
        // The offending upscaler is suppressed *inclusively*.
        expect(isSuppressedIndex(preview, [2], 0)).toBe(true);
    });

    it('keeps trailing restores when the limit guard emits no final Downscale (8K->8K)', () => {
        // 8K source -> 8K target with [2x, scale-1 restore]: the 2x would emit a
        // 15360-wide intermediate, so the limit pass suppresses it, but no
        // Downscale is emitted because the pre-upscale 8K already equals the
        // target. The restore after it must be kept: there is no target-exact
        // final Downscale to suppress after.
        const factors = [2, 1];
        const preview = planChainGeometryPreview({
            sourceDimensions: SOURCE_8K,
            targetDimensions: TARGET_8K,
            upscaleFactors: factors,
            limits: DEVICE_LIMITS,
            restoreFlags: [false, true],
            restoreSuppression: 'trailing',
        });

        expect(preview.suppressFromIndex).toBe(0);
        expect(preview.finalDownscale).toBeNull();
        expect(preview.finalDownscaleAfterIndex).toBeNull();
        // The offending upscaler is still suppressed inclusively.
        expect(isSuppressedIndex(preview, factors, 0)).toBe(true);
        // Regression guard: this used to be dropped because the limit preview
        // anchored `finalDownscaleAfterIndex` at the suppressed upscaler.
        expect(isSuppressedIndex(preview, factors, 1)).toBe(false);
    });

    it('suppresses a 2x upscaler from a shrinking 8K->4K chain and emits the target Downscale at its slot', () => {
        const preview = previewWithLimits(SOURCE_8K, TARGET_4K, [2]);

        expect(preview.suppressFromIndex).toBe(0);
        expect(preview.finalDownscale).toEqual(TARGET_4K);
        expect(preview.finalDownscaleAfterIndex).toBe(0);
        expect(isSuppressedIndex(preview, [2], 0)).toBe(true);
    });

    it('allows a 4K source through a 2x upscaler (8K UHD is within the default budget)', () => {
        const preview = previewWithLimits(
            { width: 3840, height: 2160 },
            TARGET_8K,
            [2],
        );

        expect(preview).toEqual({
            suppressFromIndex: null,
            finalDownscale: null,
            finalDownscaleAfterIndex: null,
        });
    });

    it('suppresses a 4x upscaler from a 4K source (16K exceeds both bounds)', () => {
        const u4 = { width: 3840, height: 2160 };
        const preview = previewWithLimits(u4, TARGET_8K, [4]);

        expect(preview.suppressFromIndex).toBe(0);
        // The pre-upscale texture (4K) does not exceed the 8K target.
        expect(preview.finalDownscale).toBeNull();
        // No final Downscale => no anchor (see the 8K/8K case above).
        expect(preview.finalDownscaleAfterIndex).toBeNull();
        expect(isSuppressedIndex(preview, [4], 0)).toBe(true);
    });

    it('overrides the shrinking branch and emits the target Downscale at the suppressed first upscaler', () => {
        // 8K -> 4K, factors [1, 2, 1, 2]. The shrinking branch alone would
        // retain the first upscaler (-> 16K). The limit pass suppresses it.
        const factors = [1, 2, 1, 2];
        const preview = previewWithLimits(SOURCE_8K, TARGET_4K, factors);

        expect(preview.suppressFromIndex).toBe(1);
        expect(preview.finalDownscale).toEqual(TARGET_4K);
        expect(preview.finalDownscaleAfterIndex).toBe(1);
        expect(isSuppressedIndex(preview, factors, 1)).toBe(true);
        expect(isSuppressedIndex(preview, factors, 3)).toBe(true);
    });

    it('takes precedence over the default (no-limits) candidate retention', () => {
        const factors = [1, 2, 1, 2];
        const source = { width: 1920, height: 1080 };
        const target = { width: 1280, height: 720 };

        const withoutLimits = planChainGeometryPreview({
            sourceDimensions: source,
            targetDimensions: target,
            upscaleFactors: factors,
        });
        // The candidate retains the first upscaler at index 1 (exclusive suppression).
        expect(isSuppressedIndex(withoutLimits, factors, 1)).toBe(false);

        // A budget that the retained 2x (-> 3840x2160 = 8.29 MP) exceeds.
        const withLimits = planChainGeometryPreview({
            sourceDimensions: source,
            targetDimensions: target,
            upscaleFactors: factors,
            limits: { maxDimension: 8192, maxIntermediatePixels: 2_000_000 },
        });
        expect(isSuppressedIndex(withLimits, factors, 1)).toBe(true);
        expect(withLimits.finalDownscale).toEqual({ width: 1280, height: 720 });
        expect(withLimits.finalDownscaleAfterIndex).toBe(1);
    });

    it('does not multiply an already-over-limit source (all upscalers suppressed)', () => {
        const overLimitSource: Dimensions = { width: 16384, height: 8192 };
        const factors = [1, 2, 2];
        const preview = previewWithLimits(overLimitSource, TARGET_4K, factors);

        expect(preview.suppressFromIndex).toBe(1);
        expect(preview.finalDownscale).toEqual(TARGET_4K);
        expect(preview.finalDownscaleAfterIndex).toBe(1);
        expect(factors.map((_, i) => isSuppressedIndex(preview, factors, i)))
            .toEqual([false, true, true]);
    });

    it('returns the candidate unchanged when an over-limit source has no upscaler to suppress', () => {
        const overLimitSource: Dimensions = { width: 16384, height: 8192 };
        const preview = previewWithLimits(overLimitSource, TARGET_4K, [1, 1]);

        expect(preview).toEqual({
            suppressFromIndex: null,
            finalDownscale: null,
            finalDownscaleAfterIndex: null,
        });
    });

    it('keeps the limit marker non-enumerable so the documented preview shape is unchanged', () => {
        const preview = previewWithLimits(SOURCE_8K, TARGET_4K, [2]);

        expect(Object.keys(preview).sort()).toEqual([
            'finalDownscale',
            'finalDownscaleAfterIndex',
            'suppressFromIndex',
        ]);
        expect(preview.suppressFromIndexInclusive).toBe(true);
        expect(preview).toEqual({
            suppressFromIndex: 0,
            finalDownscale: TARGET_4K,
            finalDownscaleAfterIndex: 0,
        });
    });

    it('omitting limits leaves the documented three-field candidate unchanged', () => {
        const preview = planChainGeometryPreview({
            sourceDimensions: SOURCE_1080P,
            targetDimensions: { width: 2560, height: 1440 },
            upscaleFactors: [1, 2, 1, 2],
        });

        expect(preview).toEqual({
            suppressFromIndex: 1,
            finalDownscale: { width: 2560, height: 1440 },
            finalDownscaleAfterIndex: 1,
        });
        expect(preview.suppressFromIndexInclusive).toBeUndefined();
        expect(isSuppressedIndex(preview, [1, 2, 1, 2], 1)).toBe(false);
    });
});

describe('planChainGeometryPreview limits sweep', () => {
    const SOURCES: Array<[string, Dimensions]> = [
        ['1080p', { width: 1920, height: 1080 }],
        ['1440p', { width: 2560, height: 1440 }],
        ['4K', { width: 3840, height: 2160 }],
        ['8K', { width: 7680, height: 4320 }],
    ];
    const TARGETS: Array<[string, Dimensions]> = [
        ['720p', { width: 1280, height: 720 }],
        ['1080p', { width: 1920, height: 1080 }],
        ['1440p', { width: 2560, height: 1440 }],
        ['4K', { width: 3840, height: 2160 }],
    ];
    const FACTOR_SETS: number[][] = [
        [],
        [1],
        [2],
        [4],
        [2, 2],
        [1, 2],
        [2, 1, 2],
        [4, 2],
        [1, 1, 2, 1, 2],
        [1, 1, 2, 1, 2, 1, 2],
    ];
    const LIMITS: Array<[string, ChainGeometryLimits]> = [
        ['default budget', DEVICE_LIMITS],
        ['16K axis', { maxDimension: 16384, maxIntermediatePixels: DEFAULT_MAX_INTERMEDIATE_PIXELS }],
        // 4K pixel budget: targets above 4K are excluded above so the render
        // target itself (clamped upstream) always satisfies the ceiling.
        ['4K pixel budget', { maxDimension: 8192, maxIntermediatePixels: 3840 * 2160 }],
    ];

    it('never emits an over-limit intermediate for any source/target/factor/limit combination', () => {
        let checked = 0;

        for (const [limitsName, limits] of LIMITS) {
            for (const [sourceName, source] of SOURCES) {
                for (const [targetName, target] of TARGETS) {
                    for (const factors of FACTOR_SETS) {
                        const label = `${limitsName} | ${sourceName}->${targetName} | [${factors.join(',')}]`;
                        const effects: EnhancementEffect[] = factors.map((factor, index) => ({
                            id: `sweep/${index}`,
                            name: `Sweep ${factor}x`,
                            className: `Sweep${index}`,
                            upscaleFactor: factor,
                        }));
                        const geometry = newGeometry(source, effects, target, limits);

                        // Every emitted stage after the source (upscale outputs
                        // and any intermediate/final Downscale) must fit.
                        for (const stage of geometry.stages.slice(1)) {
                            expect(stage.width, `${label}: width ${JSON.stringify(stage)}`)
                                .toBeLessThanOrEqual(limits.maxDimension);
                            expect(stage.height, `${label}: height ${JSON.stringify(stage)}`)
                                .toBeLessThanOrEqual(limits.maxDimension);
                            expect(stage.width * stage.height, `${label}: pixels ${JSON.stringify(stage)}`)
                                .toBeLessThanOrEqual(limits.maxIntermediatePixels);
                        }

                        if (geometry.preview.finalDownscale) {
                            expect(geometry.downscales, `${label}: final downscale`).toEqual([target]);
                        }
                        checked++;
                    }
                }
            }
        }

        expect(checked).toBe(LIMITS.length * SOURCES.length * TARGETS.length * FACTOR_SETS.length);
    });
});
