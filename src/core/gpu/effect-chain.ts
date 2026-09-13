/**
 * Effect Chain — shared helpers for effect-chain geometry planning.
 *
 * Both the renderer's pipeline builder and the GPU benchmark walk an effect
 * chain, tracking the current texture dimensions and deciding when an
 * intermediate `Downscale` must be inserted between two upscaling effects to
 * keep intermediate textures from ballooning past the render target. That
 * ordered walk itself is shared by both call sites through
 * `compileEffectChain` in `./effect-chain-compiler` (A4); this module holds the
 * pure geometry decisions it calls.
 *
 * The decision is a per-step remaining-upscale rule:
 *
 *  - {@link computeRemainingUpscaleFactors} pre-computes, for every effect, the
 *    product of the upscale factors of all effects strictly after it.
 *  - {@link planIntermediateDownscale} then, after an upscaling step, compares
 *    the current width against the ideal intermediate size (target width
 *    divided by the remaining upscale factor) and requests a Downscale when the
 *    current width exceeds that ideal by more than
 *    {@link INTERMEDIATE_DOWNSCALE_THRESHOLD}.
 *
 * A second, chain-level pre-pass ({@link planChainGeometryPreview}) replaces
 * that per-step rule in two pathological cases:
 *
 *  - Upscale targets (`target.width > source.width`): the per-step rule would
 *    downscale the chain *below the source* only to have a later neural effect
 *    upscale it again from an aliased field. The later upscalers are suppressed
 *    and a single final Downscale (exactly to the target) is emitted after the
 *    last retained upscaler.
 *  - Shrinking/equal targets (`target.width <= source.width`, target height
 *    `>=` {@link MIN_DOWNSCALE_HEIGHT}): the legacy rule downscales below the
 *    target and then upscales again. Only the first upscaling effect is
 *    retained, every later upscaler is suppressed, and a single Downscale to
 *    exactly the render target is emitted right after it.
 *
 * A third, limit-driven case wraps either branch when the caller supplies
 * {@link ChainGeometryLimits} (normally derived from the adapter's
 * `maxTextureDimension2D` and {@link DEFAULT_MAX_INTERMEDIATE_PIXELS}):
 *
 *  - The candidate plan is computed first, then the chain is re-simulated from
 *    the source applying that candidate's suppression. The first retained
 *    upscaling effect whose output texture would exceed the per-axis ceiling or
 *    the pixel budget is suppressed (precedence over both branches above), and
 *    a single final Downscale to the render target is emitted at that slot when
 *    the pre-upscale texture exceeds it. Because the offending effect is
 *    suppressed, the builder/benchmark feed the Downscale the pre-upscale
 *    texture.
 *
 * Chains that never hit any case keep the legacy rule byte-for-byte.
 *
 * This is deliberately NOT the `anime4k-webgpu-async` `PipelineChain` /
 * `AutoDownscale` / `planAutoDownscale` heuristic, which reasons about preset
 * native→target ratio bands. The rule here is a per-step remaining-factor rule
 * and must stay behavior-identical across call sites.
 *
 * The module is pure and dependency-free (type-only imports); it performs no
 * GPU work and constructs no pipelines.
 */
import type { Dimensions, EnhancementEffect, DestroyablePipeline } from '@/types';

/**
 * Fraction of the ideal intermediate width that the current width must exceed
 * before an intermediate Downscale is inserted. Strictly greater-than: a width
 * exactly equal to `ideal * INTERMEDIATE_DOWNSCALE_THRESHOLD` does NOT trigger.
 */
export const INTERMEDIATE_DOWNSCALE_THRESHOLD = 1.1;

/**
 * Minimum render-target height (px) for which the shrinking-target safe geometry
 * engages. Targets below this keep the legacy per-step path; the render target
 * itself always wins and is never enlarged beyond.
 */
export const MIN_DOWNSCALE_HEIGHT = 720;

/** Bytes per pixel of an `rgba16float` intermediate texture. */
export const BYTES_PER_PIXEL_RGBA16F = 8;

/** Byte budget for a single intermediate texture; parity with texture-pool's default. */
export const MAX_INTERMEDIATE_BYTES = 256 * 1024 * 1024;

/** Pixel-count budget for a single intermediate texture (~33.55 MP, ~8K UHD). */
export const DEFAULT_MAX_INTERMEDIATE_PIXELS =
    Math.floor(MAX_INTERMEDIATE_BYTES / BYTES_PER_PIXEL_RGBA16F);

/**
 * Device-derived ceilings the chain-geometry planner must never exceed when
 * emitting an intermediate texture.
 */
export interface ChainGeometryLimits {
    /** Per-axis ceiling for any intermediate texture (device.limits.maxTextureDimension2D). */
    maxDimension: number;
    /** Pixel-count ceiling for any single intermediate texture. */
    maxIntermediatePixels: number;
}

/**
 * Constructor signature for a pipeline that consumes an input texture and emits
 * an output texture, as accepted by the library effect classes and `Downscale`.
 */
export type PipelineCtor = new (descriptor: {
    device: GPUDevice;
    inputTexture: GPUTexture;
    nativeDimensions: Dimensions;
    targetDimensions: Dimensions;
}) => DestroyablePipeline;

/**
 * Compute, for every effect index `i`, the product of the `upscaleFactor`
 * (defaulting to `1`) of every effect strictly after index `i`.
 *
 * For `[1, 2, 1, 2]` this yields `[4, 2, 2, 1]`: the last effect has no
 * remaining upscales after it, so its factor is `1` (the empty-product
 * identity).
 *
 * @param effects Effect chain in encode order.
 * @returns One remaining-upscale factor per effect, in the same order.
 */
export function computeRemainingUpscaleFactors(
    effects: ReadonlyArray<Pick<EnhancementEffect, 'upscaleFactor'>>,
): number[] {
    const upscaleFactors = effects.map(e => e.upscaleFactor ?? 1);
    return upscaleFactors.map((_, i) =>
        upscaleFactors.slice(i + 1).reduce((acc, val) => acc * val, 1)
    );
}

/**
 * Decide whether an intermediate Downscale is required after an upscaling step.
 *
 * An intermediate Downscale is requested only when BOTH hold:
 *
 *  1. `remainingFactor > 1` — there is still at least one upscale after this
 *     step, so the chain will grow again.
 *  2. `curWidth > (targetDimensions.width / remainingFactor) * 1.1` — the
 *     current width overshoots the ideal intermediate width by more than
 *     {@link INTERMEDIATE_DOWNSCALE_THRESHOLD} (strict `>`).
 *
 * The trigger considers width only. Both axes are still rounded up
 * independently with `Math.ceil`, so an odd/indivisible target yields the
 * smallest integer dimensions that fully contain the ideal.
 *
 * @param params Current width/height, the render target, and the product of the
 *   upscale factors remaining after the current step.
 * @returns The `Math.ceil`-rounded intermediate dimensions to hand to a
 *   Downscale, or `null` when no intermediate Downscale is needed.
 */
export function planIntermediateDownscale(params: {
    curWidth: number;
    curHeight: number;
    targetDimensions: Dimensions;
    remainingFactor: number;
}): Dimensions | null {
    const { curWidth, targetDimensions, remainingFactor } = params;
    if (remainingFactor <= 1) return null;

    const idealIntermediateWidth = targetDimensions.width / remainingFactor;
    const idealIntermediateHeight = targetDimensions.height / remainingFactor;

    if (curWidth > idealIntermediateWidth * INTERMEDIATE_DOWNSCALE_THRESHOLD) {
        return {
            width: Math.ceil(idealIntermediateWidth),
            height: Math.ceil(idealIntermediateHeight),
        };
    }
    return null;
}

/**
 * How much scale-1 `restore` suppression the emitted chain applies.
 *
 * | policy       | restores kept                       | rule                                                     |
 * | ------------ | ----------------------------------- | -------------------------------------------------------- |
 * | `'off'`      | all                                 | no restore drop, no gating (the full V1 chain).          |
 * | `'gate'`     | all                                 | no restore drop; each retained restore is wrapped/gated. |
 * | `'trailing'` | those at/before the final Downscale | drop restores with `index > finalDownscaleAfterIndex`, no gating. |
 * | `'leading'`  | those after the first upscaler      | drop restores with `index < firstRetainedUpscaleIndex`, no gating. |
 *
 * `'gate'` never drops a restore; the difference from `'off'` is that each
 * retained restore is wrapped in the local-luma gate.
 */
export type RestoreSuppression = 'off' | 'gate' | 'trailing' | 'leading';

/**
 * Result of the chain-level geometry pre-pass.
 */
export interface ChainGeometryPreview {
    /**
     * Index of the upscaling effect at which safe-geometry suppression begins,
     * or `null` when the legacy per-step rule must be used unchanged.
     */
    suppressFromIndex: number | null;
    /**
     * The single final Downscale target (always exactly the render target), or
     * `null` when no final Downscale is required.
     */
    finalDownscale: Dimensions | null;
    /**
     * Effect index immediately after which the final Downscale must be emitted
     * (before any trailing non-upscaling effects), or `null` when there is no
     * final Downscale. This is the last retained upscaling effect: trailing
     * restore/denoise effects then run at the target resolution rather than at
     * the oversized intermediate.
     */
    finalDownscaleAfterIndex: number | null;
    /**
     * When `true`, the upscaling effect at {@link suppressFromIndex} is itself
     * suppressed (inclusive) instead of being retained. Set only by the
     * limit-driven pass; legacy candidates leave it absent so
     * {@link isSuppressedIndex} keeps its exclusive semantics byte-for-byte.
     *
     * Defined non-enumerably so existing consumers comparing the preview with a
     * plain `{ suppressFromIndex, finalDownscale, finalDownscaleAfterIndex }`
     * object are unaffected.
     */
    suppressFromIndexInclusive?: boolean;
    /**
     * Restore-suppression policy carried alongside the geometry. Defined
     * non-enumerably (see {@link suppressFromIndexInclusive}) so the documented
     * geometry fields keep comparing and serializing byte-for-byte; read by
     * {@link isSuppressedIndex}.
     */
    restoreSuppression?: RestoreSuppression;
    /**
     * Per-effect `descriptor.category === 'restore'` flags, in encode order.
     * Defined non-enumerably like {@link suppressFromIndexInclusive}. When
     * absent (legacy callers) no restore is ever suppressed.
     */
    restoreFlags?: readonly boolean[];
}

/**
 * Chain-level pre-pass that detects the pathological geometry and, when it
 * fires, switches the whole chain to a safe one.
 *
 * Two branches:
 *
 *  - **Shrinking/equal target** (`target.width <= source.width`): retain only
 *    the first upscaling effect, suppress every later upscaler, and emit exactly
 *    one Downscale to the render target immediately after the retained
 *    upscaler. Disabled (legacy path) when there is no upscaler or the target
 *    height is below {@link MIN_DOWNSCALE_HEIGHT}.
 *  - **Upscale target** (`target.width > source.width`): walk the chain, and at
 *    each upscaling effect `i` (factor `> 1`), after applying its upscale,
 *    evaluate the legacy ideal intermediate `ideal = target / R` (where `R` is
 *    the product of the upscale factors of every effect strictly after `i`).
 *    Suppression triggers iff ALL hold:
 *      1. `ideal.width < source.width` — the legacy rule would drop below source;
 *      2. `curWidth > ideal.width * INTERMEDIATE_DOWNSCALE_THRESHOLD` — the
 *         legacy rule actually would insert that Downscale.
 *    Once triggered, later upscalers are skipped and a single Downscale to
 *    exactly the target is emitted after the last retained upscaler when the
 *    final size exceeds the target.
 *
 * In both branches the Downscale (if any) is emitted immediately after the
 * relevant retained upscaling effect (before any trailing scale-1 effects), so
 * trailing restore CNNs run at the target resolution instead of the oversized
 * intermediate. When neither branch fires, all fields are `null` and callers
 * must fall back to the per-step {@link planIntermediateDownscale} path
 * (byte-identical legacy behavior).
 *
 * Width is the trigger axis (matching the legacy rule); the final Downscale
 * test considers either axis so the emitted size never exceeds the target.
 */
export function planChainGeometryPreview(params: {
    sourceDimensions: Dimensions;
    targetDimensions: Dimensions;
    /** Per-effect upscale factor, in encode order. */
    upscaleFactors: readonly number[];
    /**
     * Optional device-derived intermediate texture limits. When omitted the
     * planner is byte-for-byte identical to the pre-limit implementation.
     */
    limits?: ChainGeometryLimits;
    /**
     * Restore-suppression policy recorded on the returned preview (default
     * `'trailing'`, the V2 default). Only meaningful together with
     * `restoreFlags`; see {@link isSuppressedIndex}.
     */
    restoreSuppression?: RestoreSuppression;
    /**
     * Per-effect `descriptor.category === 'restore'` flags, in encode order.
     * Callers derive them from the resolved descriptors so this module stays
     * library-free; helpers such as `ClampHighlights` must be `false`.
     */
    restoreFlags?: readonly boolean[];
}): ChainGeometryPreview {
    const {
        sourceDimensions,
        targetDimensions,
        upscaleFactors,
        limits,
        restoreSuppression = 'trailing',
        restoreFlags,
    } = params;

    const candidate = planCandidateGeometry(
        sourceDimensions,
        targetDimensions,
        upscaleFactors,
    );
    const preview = limits
        ? applyChainGeometryLimits(
            candidate,
            sourceDimensions,
            targetDimensions,
            upscaleFactors,
            limits,
        )
        : candidate;

    return attachRestoreContext(preview, restoreSuppression, restoreFlags);
}

/**
 * Attach the restore-suppression policy/flags to a preview without making them
 * enumerable, so the documented geometry shape (and every existing `toEqual` /
 * serialization check) is unaffected. Mirrors
 * {@link ChainGeometryPreview.suppressFromIndexInclusive}.
 */
function attachRestoreContext(
    preview: ChainGeometryPreview,
    restoreSuppression: RestoreSuppression,
    restoreFlags: readonly boolean[] | undefined,
): ChainGeometryPreview {
    Object.defineProperty(preview, 'restoreSuppression', {
        value: restoreSuppression,
        enumerable: false,
        writable: false,
        configurable: true,
    });
    if (restoreFlags) {
        Object.defineProperty(preview, 'restoreFlags', {
            value: restoreFlags,
            enumerable: false,
            writable: false,
            configurable: true,
        });
    }
    return preview;
}

/**
 * The pre-limit chain-level candidate (the two branches documented above).
 * Kept separate so the optional limit pass can only reduce its retention.
 */
function planCandidateGeometry(
    sourceDimensions: Dimensions,
    targetDimensions: Dimensions,
    upscaleFactors: readonly number[],
): ChainGeometryPreview {
    // Shrinking/equal target: retain the first upscaler and downscale to target.
    if (targetDimensions.width <= sourceDimensions.width) {
        return planShrinkingTargetGeometry(targetDimensions, upscaleFactors);
    }

    const count = upscaleFactors.length;
    // suffix[i] = product of upscaleFactors[j] for j >= i.
    const suffix = new Array<number>(count + 1).fill(1);
    for (let i = count - 1; i >= 0; i--) {
        suffix[i] = suffix[i + 1] * (upscaleFactors[i] ?? 1);
    }

    let curWidth = sourceDimensions.width;
    let curHeight = sourceDimensions.height;
    let suppressFromIndex: number | null = null;

    for (let i = 0; i < count; i++) {
        const factor = upscaleFactors[i] ?? 1;
        if (factor <= 1) continue;
        // Once suppression starts, every later upscaler is skipped entirely,
        // so stop accumulating their factors.
        if (suppressFromIndex !== null) continue;

        curWidth *= factor;
        curHeight *= factor;

        const remainingFactor = suffix[i + 1];
        const idealIntermediateWidth = targetDimensions.width / remainingFactor;

        // (2) ideal below source, and (3) legacy would actually insert it.
        if (
            idealIntermediateWidth < sourceDimensions.width
            && curWidth > idealIntermediateWidth * INTERMEDIATE_DOWNSCALE_THRESHOLD
        ) {
            suppressFromIndex = i;
        }
    }

    if (suppressFromIndex === null) {
        return { suppressFromIndex: null, finalDownscale: null, finalDownscaleAfterIndex: null };
    }

    const exceedsTarget =
        curWidth > targetDimensions.width || curHeight > targetDimensions.height;

    return {
        suppressFromIndex,
        finalDownscale: exceedsTarget
            ? { width: targetDimensions.width, height: targetDimensions.height }
            : null,
        // Emit the Downscale right after the last retained upscaler so trailing
        // scale-1 effects run at the target resolution (≈2x faster).
        finalDownscaleAfterIndex: exceedsTarget ? suppressFromIndex : null,
    };
}

/**
 * Limit pass: walk the candidate's retained upscalers in encode order and stop
 * at the first one whose output texture would exceed either ceiling.
 *
 * The pass only ever removes retention: it starts from the candidate's
 * suppression, so any upscaler the candidate already skips is skipped here too.
 * At the first inadmissible upscaler `i` it returns a preview that suppresses
 * `i` inclusively and emits the final Downscale at `i` (from the pre-upscale
 * texture). The Downscale targets the render target when the pre-upscale
 * texture exceeds it on either axis, otherwise none is needed.
 *
 * An over-limit *source* cannot be fixed here (the source texture is created
 * upstream), but it also cannot get worse: every upscaler is suppressed and the
 * candidate's structure is otherwise preserved. When the source is over-limit
 * and the chain has no upscaler there is nothing to suppress, so the candidate
 * is returned unchanged.
 */
function applyChainGeometryLimits(
    candidate: ChainGeometryPreview,
    sourceDimensions: Dimensions,
    targetDimensions: Dimensions,
    upscaleFactors: readonly number[],
    limits: ChainGeometryLimits,
): ChainGeometryPreview {
    let width = sourceDimensions.width;
    let height = sourceDimensions.height;
    let firstInadmissible: number | null = null;

    for (let i = 0; i < upscaleFactors.length; i++) {
        const factor = upscaleFactors[i] ?? 1;
        if (factor <= 1) continue;
        // The candidate's suppression is the authority for what is retained;
        // the limit pass may only suppress further.
        if (isSuppressedIndex(candidate, upscaleFactors, i)) continue;

        const postWidth = width * factor;
        const postHeight = height * factor;
        if (
            postWidth > limits.maxDimension
            || postHeight > limits.maxDimension
            || postWidth * postHeight > limits.maxIntermediatePixels
        ) {
            firstInadmissible = i;
            break;
        }

        width = postWidth;
        height = postHeight;
    }

    if (firstInadmissible === null) return candidate;

    const exceedsTarget =
        width > targetDimensions.width || height > targetDimensions.height;

    return createLimitPreview(
        firstInadmissible,
        exceedsTarget
            ? { width: targetDimensions.width, height: targetDimensions.height }
            : null,
    );
}

/**
 * Build a limit-preview that suppresses the upscaler at `suppressFromIndex`
 * inclusively (see {@link ChainGeometryPreview.suppressFromIndexInclusive}).
 *
 * `finalDownscaleAfterIndex` is only anchored when a final Downscale is actually
 * emitted; with a `null` `finalDownscale` it stays `null` too. This keeps the
 * documented invariant (`finalDownscaleAfterIndex === null` whenever
 * `finalDownscale === null`) true for every producer, so the restore rule in
 * {@link isSuppressedIndex} keys off the emitted target-exact Downscale rather
 * than the suppressed upscaler's slot.
 *
 * The marker is defined non-enumerably so `toEqual`/serialization of the
 * preview's documented three fields keeps working, while
 * {@link isSuppressedIndex} still sees it.
 */
function createLimitPreview(
    suppressFromIndex: number,
    finalDownscale: Dimensions | null,
): ChainGeometryPreview {
    const preview: ChainGeometryPreview = {
        suppressFromIndex,
        finalDownscale,
        finalDownscaleAfterIndex: finalDownscale ? suppressFromIndex : null,
    };
    Object.defineProperty(preview, 'suppressFromIndexInclusive', {
        value: true,
        enumerable: false,
        writable: false,
        configurable: false,
    });
    return preview;
}

/**
 * Safe geometry for a target at or below the source resolution.
 *
 * The legacy per-step rule downscales below the target and then upscales again,
 * so retain only the FIRST upscaling effect, suppress every later upscaler via
 * {@link isSuppressedIndex}, and emit exactly one Downscale to the render target
 * immediately after that first upscaler.
 *
 * Returns the legacy null preview (no suppression, no final Downscale) when:
 *  - the target height is below {@link MIN_DOWNSCALE_HEIGHT} (720p floor), or
 *  - the chain contains no upscaling effect.
 *
 * The retained size is `source * factor >= 2 * source >= target`, so it always
 * exceeds the target; the render target itself always wins and is never
 * enlarged beyond.
 */
function planShrinkingTargetGeometry(
    targetDimensions: Dimensions,
    upscaleFactors: readonly number[],
): ChainGeometryPreview {
    const legacyPreview: ChainGeometryPreview = {
        suppressFromIndex: null,
        finalDownscale: null,
        finalDownscaleAfterIndex: null,
    };

    // 720p floor: sub-720p targets keep the legacy path unchanged.
    if (targetDimensions.height < MIN_DOWNSCALE_HEIGHT) {
        return legacyPreview;
    }

    const firstUpscaleIndex = upscaleFactors.findIndex(
        (factor) => (factor ?? 1) > 1,
    );
    if (firstUpscaleIndex === -1) {
        return legacyPreview;
    }

    return {
        suppressFromIndex: firstUpscaleIndex,
        finalDownscale: {
            width: targetDimensions.width,
            height: targetDimensions.height,
        },
        finalDownscaleAfterIndex: firstUpscaleIndex,
    };
}

/**
 * Whether an upscaling effect at `index` is suppressed by the geometry preview
 * (the rule that predates restore suppression): every upscaling effect strictly
 * after {@link ChainGeometryPreview.suppressFromIndex} is suppressed, except that
 * the limit pass marks `suppressFromIndexInclusive` and also suppresses the
 * upscaler at the anchor itself.
 */
function isUpscalerSuppressed(
    preview: ChainGeometryPreview,
    factor: number,
    index: number,
): boolean {
    if (factor <= 1) return false;
    if (preview.suppressFromIndex === null) return false;
    return preview.suppressFromIndexInclusive
        ? index >= preview.suppressFromIndex
        : index > preview.suppressFromIndex;
}

/**
 * Index of the first upscaling effect the preview retains (the first factor
 * `> 1` that {@link isUpscalerSuppressed} does not drop), or `null` when the
 * chain retains no upscaler.
 */
function firstRetainedUpscaleIndex(
    preview: ChainGeometryPreview,
    upscaleFactors: readonly number[],
): number | null {
    for (let i = 0; i < upscaleFactors.length; i++) {
        const factor = upscaleFactors[i] ?? 1;
        if (factor > 1 && !isUpscalerSuppressed(preview, factor, i)) return i;
    }
    return null;
}

/**
 * Whether effect `index` must be skipped under a geometry preview.
 *
 * Upscaler rule (unchanged): every upscaling effect strictly after
 * {@link ChainGeometryPreview.suppressFromIndex} is suppressed (the candidate
 * branches retain the upscaler at `suppressFromIndex`). When the limit pass
 * built the preview, {@link ChainGeometryPreview.suppressFromIndexInclusive} is
 * set and the upscaler at `suppressFromIndex` itself is suppressed too.
 *
 * Restore rule: a scale-1 effect flagged as a `restore` may additionally be
 * suppressed, under the `'trailing'` and `'leading'` policies:
 *
 *  - `'off'` / `'gate'`: never suppress a restore. `'gate'` additionally wraps
 *    each retained restore in the local-luma gate.
 *  - `'trailing'`: suppress restores that run after the emitted target-exact
 *    final Downscale (`index > finalDownscaleAfterIndex`). The anchor is only
 *    non-null when a Downscale is actually emitted, so a preview that triggers
 *    suppression without a final Downscale drops nothing.
 *  - `'leading'`: suppress restores that run before the first retained
 *    upscaler (`index < firstRetainedUpscaleIndex`). When the preview retains no
 *    upscaler, nothing is dropped.
 *
 * Non-restore effects (helpers, deblur, denoise, color) and the limit pass are
 * never affected by the restore rule. `restoreFlags`/`restoreSuppression` are
 * carried non-enumerably on the preview (see {@link attachRestoreContext});
 * a preview built without them suppresses no restores.
 *
 * Kept next to {@link planChainGeometryPreview} so the pipeline builder and the
 * GPU benchmark stay in lockstep.
 */
export function isSuppressedIndex(
    preview: ChainGeometryPreview,
    upscaleFactors: readonly number[],
    index: number,
): boolean {
    const factor = upscaleFactors[index] ?? 1;

    // Upscaler rule first; a retained upscaler is never a restore.
    if (isUpscalerSuppressed(preview, factor, index)) return true;
    if (factor > 1) return false;

    if (!preview.restoreFlags?.[index]) return false;

    const policy = preview.restoreSuppression ?? 'trailing';
    // 'off' and 'gate' keep every restore; 'gate' wraps each retained restore
    // in the local-luma gate later at compile time.
    if (policy === 'off' || policy === 'gate') return false;

    if (policy === 'leading') {
        const first = firstRetainedUpscaleIndex(preview, upscaleFactors);
        return first !== null && index < first;
    }

    // 'trailing'.
    return (
        preview.finalDownscaleAfterIndex !== null
        && index > preview.finalDownscaleAfterIndex
    );
}
