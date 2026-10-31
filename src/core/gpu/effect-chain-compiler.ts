/**
 * Effect Chain Compiler — the shared ordered-chain walk used by the renderer's
 * pipeline builder and the GPU benchmark.
 *
 * Both call sites previously carried a near-identical loop that:
 *
 *  1. computes the per-effect remaining-upscale factors and the
 *     chain-level geometry preview (safe-geometry suppression + final
 *     Downscale slot),
 *  2. walks the effects in encode order, compiling each retained effect through
 *     a caller-supplied {@link CompileChainEffect} (engine backend),
 *  3. inserts intermediate `Downscale`s after an upscaling step, emits the
 *     single final `Downscale` at its anchored slot, and records deferred
 *     two-stage epilogues in append order,
 *  4. materializes the deferred epilogues once the chain tail is final, and
 *  5. yields to the main thread between steps and honors a stale-build check.
 *
 * This module is the single home for that walk. It is pure orchestration: it
 * imports only the geometry helpers from {@link ./effect-chain}, the
 * `yieldToMain` scheduler shim, and types. It must NOT statically import
 * `anime4k-webgpu-async` or the backend registry (see
 * `src/utils/seam-bundle-purity.test.ts`); the per-effect compilation is
 * injected by each caller.
 */
import type { Dimensions, DestroyablePipeline, EnhancementEffect } from '@/types';
import { yieldToMain } from '@core/utils/yield-utils';
import {
  computeRemainingUpscaleFactors,
  planIntermediateDownscale,
  planChainGeometryPreview,
  isSuppressedIndex,
  DEFAULT_MAX_INTERMEDIATE_PIXELS,
  type ChainGeometryLimits,
  type PipelineCtor,
  type RestoreSuppression,
} from './effect-chain';

/**
 * Stable HUD label for a materialized two-stage epilogue node (e.g. the
 * `ClampHighlightsApply` stage produced by `ClampHighlights.getDeferredPipeline`).
 */
export const DEFERRED_APPLY_LABEL = 'ClampHighlightsApply';

/** One compiled effect step, as returned by a caller's `compileEffect`. */
export interface ChainEffectStep {
  pipeline: DestroyablePipeline;
  label: string;
  scaleApplied: boolean;
  postDimensions: Dimensions;
}

/** Arguments handed to a caller's `compileEffect` callback. */
export interface CompileChainEffectArgs {
  effect: EnhancementEffect;
  index: number;
  inputTexture: GPUTexture;
  currentDimensions: Dimensions;
  targetDimensions: Dimensions;
}

/** Per-effect compiler callback. Returning `null` skips the effect (keep the chain). */
export type CompileChainEffect = (
  args: CompileChainEffectArgs,
) => ChainEffectStep | null | Promise<ChainEffectStep | null>;

/** Parameters for {@link compileEffectChain}. */
export interface CompileEffectChainParams {
  device: GPUDevice;
  inputTexture: GPUTexture;
  sourceDimensions: Dimensions;
  targetDimensions: Dimensions;
  effects: EnhancementEffect[];
  /** Per-effect upscale factor in encode order (registry descriptor scale or legacy `upscaleFactor`). Caller computes it. */
  upscaleFactors: readonly number[];
  /** `anime4kModule.Downscale`, or null when the caller determined no Downscale is needed. */
  downscaleCtor: PipelineCtor | null;
  limits?: ChainGeometryLimits;
  /**
   * Per-effect `descriptor.category === 'restore'` flags, in encode order.
   * Derived by the caller from the resolved descriptors (this module must not
   * import the library). Absent → no restore is suppressed.
   */
  restoreFlags?: readonly boolean[];
  /**
   * Per-effect flag; when true the effect is NOT compiled in the main loop but
   * compiled after all deferred epilogues (used for color grading, which must
   * run after `ClampHighlightsApply`). Mirrors the `restoreFlags` pattern —
   * booleans supplied by the caller so this module stays library-free.
   */
  postEpilogueFlags?: readonly boolean[];
  /** Restore-suppression policy. Defaults to `'trailing'` (V2). */
  restoreSuppression?: RestoreSuppression;
  compileEffect: CompileChainEffect;
  onEffectStart?: (index: number, total: number) => void;
  isStale?: () => boolean;
}

/** Result of {@link compileEffectChain}. */
export interface CompileEffectChainResult {
  pipelines: DestroyablePipeline[];
  labels: string[];
  outputDimensions: Dimensions;
  /** True when `isStale` fired after the walk; `pipelines`/`labels` are empty. */
  superseded: boolean;
}

/**
 * Destroy every pipeline built during a (possibly superseded) compile attempt
 * exactly once, ignoring individual failures.
 *
 * Centralizes the superseded-build cleanup: a stale build's pipelines each own
 * an output texture, so dropping the array without destroying its members leaks
 * GPU textures. Both the chain compiler's stale returns and the renderer's
 * superseded-build result path go through this helper.
 */
export function destroyPipelines(pipelines: readonly DestroyablePipeline[]): void {
  for (const pipeline of pipelines) {
    try {
      pipeline.destroy?.();
    } catch {
      // Ignore individual pipeline destruction errors.
    }
  }
}

/**
 * Build the ordered pipeline list for an effect chain.
 *
 * Reproduces the renderer pipeline builder's Phase 1 loop: geometry pre-pass,
 * safe-geometry suppression, intermediate and final Downscales, deferred
 * epilogue materialization, and per-step yielding. See the module doc for the
 * full walk. The caller injects per-effect compilation via `compileEffect`.
 */
export async function compileEffectChain(
  params: CompileEffectChainParams,
): Promise<CompileEffectChainResult> {
  const {
    device,
    inputTexture,
    sourceDimensions,
    targetDimensions,
    effects,
    upscaleFactors,
    downscaleCtor,
    restoreFlags,
    postEpilogueFlags,
    restoreSuppression,
    compileEffect,
    onEffectStart,
    isStale,
  } = params;

  const limits: ChainGeometryLimits = params.limits ?? {
    maxDimension: device.limits.maxTextureDimension2D,
    maxIntermediatePixels: DEFAULT_MAX_INTERMEDIATE_PIXELS,
  };

  const remainingUpscaleFactors = computeRemainingUpscaleFactors(
    upscaleFactors.map((upscaleFactor) => ({ upscaleFactor })),
  );
  const geometryPreview = planChainGeometryPreview({
    sourceDimensions,
    targetDimensions,
    upscaleFactors,
    limits,
    restoreFlags,
    restoreSuppression,
  });
  const suppressActive = geometryPreview.suppressFromIndex !== null;

  const pipelines: DestroyablePipeline[] = [];
  const labels: string[] = [];
  let currentTexture = inputTexture;
  let curWidth = sourceDimensions.width;
  let curHeight = sourceDimensions.height;

  /**
   * A stale build must not hand its partially built pipelines to the caller
   * (the contract is an empty list), but those pipelines own output textures and
   * must be destroyed rather than dropped. Centralizing both stale returns here
   * guarantees every created pipeline is destroyed exactly once.
   */
  const supersededResult = (): CompileEffectChainResult => {
    destroyPipelines(pipelines);
    return {
      pipelines: [],
      labels: [],
      outputDimensions: { width: curWidth, height: curHeight },
      superseded: true,
    };
  };

  // Deferred two-stage epilogues (ClampHighlights -> apply), recorded in append
  // order and materialized once the geometry is final after the loop.
  const deferredFactories: Array<(tail: GPUTexture) => DestroyablePipeline | null> = [];

  for (let i = 0; i < effects.length; i++) {
    // Safe-geometry suppression: later upscalers are skipped entirely (never
    // constructed). Non-upscaling effects still run normally, preserving order,
    // labels and the per-iteration yield cadence.
    if (isSuppressedIndex(geometryPreview, upscaleFactors, i)) {
      // A limit-guard preview anchors its single final Downscale at the
      // suppressed upscaler's slot. Emit it from the pre-upscale texture (the
      // effect is skipped, so `currentTexture` is unchanged) before continuing.
      if (
        geometryPreview.finalDownscale
        && geometryPreview.finalDownscaleAfterIndex === i
        && downscaleCtor
      ) {
        const finalDownscale = new downscaleCtor({
          device,
          inputTexture: currentTexture,
          targetDimensions: geometryPreview.finalDownscale,
        });
        pipelines.push(finalDownscale);
        labels.push('Downscale');
        currentTexture = finalDownscale.getOutputTexture();
        curWidth = geometryPreview.finalDownscale.width;
        curHeight = geometryPreview.finalDownscale.height;
      }
      await yieldToMain();
      continue;
    }

    // Post-epilogue effects (e.g. color grading) are compiled after the deferred
    // epilogues below so they run last — otherwise ClampHighlightsApply clamps
    // their output back to pre-grading luma stats. They are scale-1 and can never
    // be the final-Downscale anchor, so skipping the anchor check is safe.
    if (postEpilogueFlags?.[i]) {
      await yieldToMain();
      continue;
    }

    onEffectStart?.(i, effects.length);

    const effect = effects[i];
    const step = await compileEffect({
      effect,
      index: i,
      inputTexture: currentTexture,
      currentDimensions: { width: curWidth, height: curHeight },
      targetDimensions,
    });

    // A failed/null step still falls through to the anchored-final-Downscale
    // check and the per-iteration yield, exactly as the builder does.
    if (step) {
      const stepPipeline = step.pipeline;
      pipelines.push(stepPipeline);
      labels.push(step.label);

      // Two-stage effects (e.g. ClampHighlights) expose a deferred epilogue that
      // must run once at the very end of the chain. Record its bound factory in
      // append order, mirroring the library's PipelineChain.append().
      if (typeof stepPipeline.getDeferredPipeline === 'function') {
        const deferred = stepPipeline.getDeferredPipeline.bind(stepPipeline);
        deferredFactories.push((tail) => deferred(tail));
      }

      currentTexture = stepPipeline.getOutputTexture();

      let postDimensions = step.postDimensions;
      if (step.scaleApplied && downscaleCtor && !suppressActive) {
        const intermediate = planIntermediateDownscale({
          curWidth: postDimensions.width,
          curHeight: postDimensions.height,
          targetDimensions,
          remainingFactor: remainingUpscaleFactors[i],
        });
        if (intermediate) {
          const intermediateDownscale = new downscaleCtor({
            device,
            inputTexture: currentTexture,
            targetDimensions: intermediate,
          });
          pipelines.push(intermediateDownscale);
          labels.push('Downscale');

          currentTexture = intermediateDownscale.getOutputTexture();
          postDimensions = intermediate;
        }
      }

      curWidth = postDimensions.width;
      curHeight = postDimensions.height;
    }

    // Safe-geometry suppression emits exactly one final Downscale immediately
    // after the last retained upscaling effect, before any trailing scale-1
    // effects, so those run at the target resolution.
    if (
      geometryPreview.finalDownscale
      && geometryPreview.finalDownscaleAfterIndex === i
      && downscaleCtor
    ) {
      const finalDownscale = new downscaleCtor({
        device,
        inputTexture: currentTexture,
        targetDimensions: geometryPreview.finalDownscale,
      });
      pipelines.push(finalDownscale);
      labels.push('Downscale');
      currentTexture = finalDownscale.getOutputTexture();
      curWidth = geometryPreview.finalDownscale.width;
      curHeight = geometryPreview.finalDownscale.height;
    }

    // Yield to let the browser process input events between synchronous GPU
    // operations.
    await yieldToMain();
  }

  if (isStale?.()) {
    // Discard everything; destroy the partially built pipelines (they own
    // output textures) and keep the caller's `labels` out-param consistent with
    // the empty pipeline list.
    return supersededResult();
  }

  // --- Deferred epilogue ---
  // After any final Downscale and all trailing scale-1 effects, thread the
  // final tail texture through the recorded factories in order. Each apply node
  // is appended last (in order) and becomes the chain output.
  for (const createDeferred of deferredFactories) {
    const deferredNode = createDeferred(currentTexture);
    if (!deferredNode) continue;
    pipelines.push(deferredNode);
    labels.push(DEFERRED_APPLY_LABEL);
    currentTexture = deferredNode.getOutputTexture();
  }

  // --- Post-epilogue effects ---
  // Compiled after the deferred epilogues so post-processing (color grading)
  // is applied to the fully enhanced + clamped frame. Preserves effect order.
  for (let i = 0; i < effects.length; i++) {
    if (!postEpilogueFlags?.[i]) continue;
    // Honor the same safe-geometry suppression guard the main loop applies, so a
    // flagged effect that would have been skipped there is not compiled here.
    // Suppression is therefore honored exactly once for both passes.
    if (isSuppressedIndex(geometryPreview, upscaleFactors, i)) {
      await yieldToMain();
      continue;
    }
    onEffectStart?.(i, effects.length);
    const step = await compileEffect({
      effect: effects[i],
      index: i,
      inputTexture: currentTexture,
      currentDimensions: { width: curWidth, height: curHeight },
      targetDimensions,
    });
    if (step) {
      pipelines.push(step.pipeline);
      labels.push(step.label);
      currentTexture = step.pipeline.getOutputTexture();
      curWidth = step.postDimensions.width;
      curHeight = step.postDimensions.height;
    }
    await yieldToMain();
  }

  if (isStale?.()) {
    return supersededResult();
  }

  return {
    pipelines,
    labels,
    outputDimensions: { width: curWidth, height: curHeight },
    superseded: false,
  };
}
