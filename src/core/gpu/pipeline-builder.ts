/**
 * Pipeline Builder — constructs Anime4K processing pipelines from an effect chain.
 *
 * Extracted from Renderer to isolate pipeline construction responsibilities.
 * Handles:
 *  - Engine-registry dispatch: every effect compiles through its backend
 *  - 3-phase pipeline building: shader pre-warm → pipeline creation → fire-and-forget warmup
 *  - Generation counter to prevent concurrent builds from clobbering each other
 *  - Shallow params comparison (replaces JSON.stringify)
 */
import type { Dimensions, EnhancementEffect, DestroyablePipeline, RestorePolicy } from '@/types';
import type { BackendRegistry } from 'anime4k-webgpu-async';
import { t } from '@utils/i18n';
import { gpuResourceCache } from '@core/gpu/gpu-resource-cache';
import { resolveEffectReference, type EffectResolution } from '@utils/effect-registry';
import { PipelinePreWarmer } from './pipeline-prewarmer';
import type { PreWarmEffectRef, PreWarmTarget } from './pipeline-prewarmer';
import { planChainGeometryPreview, isSuppressedIndex, DEFAULT_MAX_INTERMEDIATE_PIXELS, type ChainGeometryLimits, type RestoreSuppression } from './effect-chain';
import { compileEffectChain, destroyPipelines } from './effect-chain-compiler';
import { createEffectCompiler, derivePostEpilogueFlags, deriveRestoreFlags, deriveUpscaleFactors, wrapGatedRestore } from './compile-policy';
import { selectGatedRestoreOptions } from '@core/effects/gated-restore';

/** Cached anime4k-webgpu-async module (avoids repeated dynamic imports) */
let cachedAnime4KModule: typeof import('anime4k-webgpu-async') | null = null;

/**
 * Cached engine backend registry, loaded lazily so a static import never inlines
 * the monolithic library.
 */
let cachedBackendRegistry: BackendRegistry | null = null;

/**
 * Shallow comparison of two params objects.
 * Avoids JSON.stringify overhead and key-order sensitivity.
 */
export function paramsEqual(a?: Record<string, unknown>, b?: Record<string, unknown>): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(k => a[k] === b[k]);
}

/** Parameters for buildEffectPipelines */
interface BuildPipelinesParams {
  device: GPUDevice;
  videoFrameTexture: GPUTexture;
  video: HTMLVideoElement;
  targetDimensions: Dimensions;
  effects: EnhancementEffect[];
  /** Previously built pipelines to destroy before creating new ones */
  oldPipelines: DestroyablePipeline[];
  /** Shared PipelinePreWarmer for shader pre-warming */
  preWarmer: PipelinePreWarmer;
  /** Progress callback for UI updates */
  onProgress?: (stage: string | null, current?: number, total?: number) => void;
  /** Check if a newer build has superseded this one (generation counter) */
  isStale: () => boolean;
  /**
   * Restore-pass policy applied to every mode, built-in or custom. Defaults to
   * `'gate'` (keep every restore, gate each retained restore); `'off'` keeps
   * every restore without gating; `'trailing'`/`'leading'` drop restores as
   * documented in `effect-chain.ts`.
   */
  restorePolicy?: RestorePolicy;
  /**
   * Optional out-parameter receiving one label per built pipeline, in encode
   * order: the effect's `className` for each effect pipeline, `'Downscale'` for
   * each intermediate downscale stage, and `'passthrough'` for the empty dummy
   * pipeline. Left untouched when omitted.
   */
  labels?: string[];
}

/**
 * Builds Anime4K processing pipelines based on the current effect chain.
 *
 * This is a standalone function extracted from Renderer.buildPipelines() (C1).
 * It handles all 3 phases:
 *  - Phase 0: Speculative shader pre-warming via PipelinePreWarmer
 *  - Phase 1: Create pipeline instances (with yieldToMain between each)
 *  - Phase 2: Fire-and-forget warmup submission
 *
 * @returns Array of built pipelines, or empty array if superseded by a newer build
 */
export async function buildEffectPipelines(params: BuildPipelinesParams): Promise<DestroyablePipeline[]> {
  const {
    device, videoFrameTexture, video, targetDimensions, effects,
    oldPipelines, preWarmer: pipelinePreWarmer, onProgress, isStale, labels,
    restorePolicy = 'gate',
  } = params;

  // Wait for the GPU queue to finish before destroying old pipelines to avoid resource contention
  try {
    await device.queue.onSubmittedWorkDone();
  } catch {
    // Ignore error; the device may have been lost
  }
  if (isStale()) return []; // Superseded by a newer build

  // Safely destroy old pipelines
  for (const p of oldPipelines) {
    try {
      p.destroy?.();
    } catch {
      // Ignore individual pipeline destruction errors
    }
  }

  // Use the cached module to avoid repeated dynamic imports
  if (!cachedAnime4KModule) {
    cachedAnime4KModule = await import('anime4k-webgpu-async');
  }
  const anime4kModule = cachedAnime4KModule;

  // --- Effect resolution and per-effect geometry ---
  // Every effect is resolved against the static descriptor table and compiled
  // through its engine backend. `resolutions` mirrors `effects` one-to-one so a
  // suppressed or failed index keeps its slot.
  const resolutions: EffectResolution[] = effects.map((effect) =>
    resolveEffectReference(effect),
  );

  // Load the composed backend registry lazily: a static import would inline the
  // monolithic `anime4k-webgpu-async` into the content chunk.
  if (!cachedBackendRegistry) {
    // Explicit `.js` specifier: TypeScript's node16 dynamic-import resolution
    // requires an extension; webpack's extensionAlias maps it to the `.ts`.
    const { getBackendRegistry } = await import('@core/engines/registry.js');
    cachedBackendRegistry = getBackendRegistry();
  }
  const registry = cachedBackendRegistry;

  // --- Effect-chain geometry pre-pass ---
  // The descriptor's declared scale is the authority; unresolved entries fall
  // back to `effect.upscaleFactor` so their geometry slot is still planned.
  const upscaleFactors = deriveUpscaleFactors(effects, resolutions);
  // Restore-role flags come from the authoritative descriptor category, so
  // helpers (e.g. ClampHighlights → 'helper') are never misclassified. The
  // geometry planner stays library-free and only sees booleans.
  const restoreFlags = deriveRestoreFlags(resolutions);
  // Color-category effects (color grading) must run AFTER the deferred
  // ClampHighlightsApply epilogue; see compileEffectChain.
  const postEpilogueFlags = derivePostEpilogueFlags(resolutions);
  // The restore policy applies to every mode, built-in and custom alike:
  // `'off'` and `'gate'` keep every restore; `'trailing'` drops the trailing
  // restores, `'leading'` drops the leading ones.
  const restoreSuppression: RestoreSuppression = restorePolicy;
  // `'gate'` never drops a restore; every compiled restore is wrapped in the
  // local-luma gate. The gate profile is resolution-dependent: sub-4K targets
  // use the softer ramp, ≥4K targets the stronger one. See
  // `selectGatedRestoreOptions`.
  const gating = restorePolicy === 'gate'
    ? selectGatedRestoreOptions(targetDimensions)
    : null;
  // Device-derived intermediate-texture ceilings. The render target is already
  // clamped upstream; this keeps the *intermediates* from exceeding the
  // adapter's per-axis texture limit or the per-texture memory budget.
  const limits: ChainGeometryLimits = {
    maxDimension: device.limits.maxTextureDimension2D,
    maxIntermediatePixels: DEFAULT_MAX_INTERMEDIATE_PIXELS,
  };
  const geometryPreview = planChainGeometryPreview({
    sourceDimensions: { width: video.videoWidth, height: video.videoHeight },
    targetDimensions,
    upscaleFactors,
    limits,
    restoreFlags,
    restoreSuppression,
  });

  /** Pre-warm targets: engine identity + descriptor capabilities (resolved only). */
  const buildPrewarmTargets = (): PreWarmTarget[] =>
    effects
      .map((effect, i): PreWarmTarget | null => {
        // Suppressed later upscalers are never constructed, so they are not
        // pre-warmed either.
        if (isSuppressedIndex(geometryPreview, upscaleFactors, i)) return null;
        // Unresolved/unknown effects are never compiled, so they cannot be
        // pre-warmed.
        const resolution = resolutions[i];
        if (resolution.status !== 'resolved') return null;
        const descriptor = resolution.effect.descriptor;
        return {
          ref: {
            backendId: descriptor.backendId,
            key: descriptor.key,
            className: effect.className,
          },
          capabilities: descriptor.capabilities,
        };
      })
      .filter((target): target is PreWarmTarget => target !== null);

  /**
   * Whether a pre-warm target resolves to a restore-category descriptor. Used
   * only to decide if the gate wrapper (and therefore its mask shader) must be
   * constructed for the dummy too.
   */
  const isRestorePrewarmTarget = (ref: PreWarmEffectRef): boolean =>
    resolutions.some(
      (resolution) =>
        resolution.status === 'resolved'
        && resolution.effect.descriptor.backendId === ref.backendId
        && resolution.effect.descriptor.key === ref.key
        && resolution.effect.descriptor.category === 'restore',
    );

  /**
   * Registry dummy construction. Returns `null` when the target has no backend
   * id or its backend cannot be resolved (such effects are skipped, never
   * pre-warmed).
   */
  const compileDummy = async (
    ref: PreWarmEffectRef,
    dev: GPUDevice,
    tex: GPUTexture,
  ): Promise<DestroyablePipeline | null> => {
    if (!ref.backendId) return null;
    let backend;
    try {
      backend = await registry.getBackendAsync(ref.backendId);
    } catch {
      // Unregistered backend: skip the effect.
      return null;
    }
    const node = await backend.compileEffect(
      { id: ref.key, backendId: ref.backendId, key: ref.key },
      {
        device: dev,
        inputTexture: tex,
        sourceDimensions: { width: 1, height: 1 },
        currentDimensions: { width: 1, height: 1 },
        targetDimensions: { width: 1, height: 1 },
        resources: gpuResourceCache,
        isStale: () => false,
      },
    );
    // Under `'gate'`, build the same wrapper as the real compile so the gate
    // mask shader is warmed alongside the inner restore.
    return gating && isRestorePrewarmTarget(ref)
      ? wrapGatedRestore(node.pipeline, { device: dev, inputTexture: tex, gating })
      : node.pipeline;
  };

  // --- Phase 0: Speculative shader pre-warming ---
  // Construct dummy 1×1 pipelines to trigger driver-level shader compilation and caching.
  // The real pipeline construction in Phase 1 will then hit the cache (~1-3ms instead of ~25ms).
  // On subsequent calls (same effect chain), the pre-warmer skips via in-memory deduplication,
  // and the driver cache makes Phase 1 fast regardless.
  onProgress?.(t('warmupShadersProgress', '⏳ Compiling shaders...'));
  try {
    await pipelinePreWarmer.warm(
      device,
      buildPrewarmTargets(),
      compileDummy,
    );
  } catch (e) {
    console.warn('[Anime4KWebExt] Phase 0 pre-warm failed (non-fatal):', e);
  }
  if (isStale()) return []; // Superseded

  // --- Phase 1: Create all pipeline instances (no GPU submission) ---
  // The shared compiler owns the ordered chain walk (safe-geometry suppression,
  // intermediate/final Downscales, deferred epilogue materialization, per-step
  // yielding); this caller supplies only the per-effect compilation policy.
  const result = await compileEffectChain({
    device,
    inputTexture: videoFrameTexture,
    sourceDimensions: { width: video.videoWidth, height: video.videoHeight },
    targetDimensions,
    effects,
    upscaleFactors,
    // The compiler's geometry preview owns whether any Downscale is actually
    // emitted (intermediate rule or single final one), so the class is always
    // supplied; it is inert when the preview requests none.
    downscaleCtor: anime4kModule.Downscale,
    limits,
    restoreFlags,
    postEpilogueFlags,
    restoreSuppression,
    compileEffect: createEffectCompiler({
      device,
      registry,
      resolutions,
      resources: gpuResourceCache,
      sourceDimensions: { width: video.videoWidth, height: video.videoHeight },
      isStale,
      gating,
      logging: {
        registryFailure: (effect, backendId, error) => {
          console.warn(
            `[Anime4KWebExt] Registry compile failed for "${effect.className}" `
            + `(backend "${backendId}"); skipping effect.`,
            error,
          );
        },
        skipped: (effect, status) => {
          // New-style references for unregistered backends are preserved in
          // storage but cannot be compiled here; legacy entries unknown to the
          // catalog are equally unbuildable. Skip the effect, never crash.
          console.warn(
            `[Anime4KWebExt] ${status === 'unresolved' ? 'Unresolved new-style' : 'Unknown legacy'} `
            + `effect (id "${effect.id}", className "${effect.className}"); skipping effect.`,
          );
        },
      },
    }),
    onEffectStart: (index, total) => {
      // Report progress
      const loadingMsg = t('loadingEffect', `⏳ Loading effect ${index + 1}/${total}...`, [String(index + 1), String(total)]);
      onProgress?.(loadingMsg, index + 1, total);
    },
    isStale,
  });

  if (result.superseded) {
    // The compiler destroys its partially built pipelines on a stale return, so
    // `result.pipelines` is always empty here. Destroy defensively anyway: this
    // path must never hand back a leaked (undestroyed) pipeline if the contract
    // ever changes, and `destroyPipelines` is idempotent over an empty list.
    destroyPipelines(result.pipelines);
    // Keep `labels` consistent with the returned [].
    labels?.splice(0, labels.length);
    return []; // Superseded
  }

  // Copy labels only after a successful (non-superseded) compile so a
  // superseded build never leaves partial labels behind.
  if (labels) {
    labels.push(...result.labels);
  }
  const { pipelines } = result;

  // --- Phase 2: Fire-and-forget warmup ---
  // Submit all shader compilations as a single batch without waiting for GPU completion.
  // Shader compilation happens at createComputePipeline() time (Phase 1), not at execution
  // time. The warmup pass validates the pipeline can execute and triggers minor GPU-side
  // optimizations. By NOT waiting for onSubmittedWorkDone(), we eliminate 400-800ms of
  // UI freeze. The first real render frame will naturally wait for this to complete
  // because GPUQueue.submit() maintains ordering.
  if (pipelines.length > 1) { // Skip dummy pipeline case
    try {
      const warmupEncoder = device.createCommandEncoder();
      for (const pipeline of pipelines) {
        await pipeline.pass(warmupEncoder);
      }
      device.queue.submit([warmupEncoder.finish()]);
      // NO onSubmittedWorkDone() — let the GPU process this asynchronously.
      // The first real render frame will naturally wait for this to complete.
    } catch (e) {
      console.warn('[Anime4KWebExt] Warmup submission failed, shaders will compile on first frame:', e);
    }
  }

  if (pipelines.length === 0) {
    // If no effects are applied, create a dummy pipeline
    pipelines.push({
      pass: () => Promise.resolve(),
      getOutputTexture: () => videoFrameTexture,
      updateParam: () => { },
    } as unknown as DestroyablePipeline);
    labels?.push('passthrough');
  }

  // Notify that warmup is complete
  onProgress?.(null);

  console.log(`[Anime4KWebExt] Built ${pipelines.length} pipelines with warmup complete.`);
  return pipelines;
}
