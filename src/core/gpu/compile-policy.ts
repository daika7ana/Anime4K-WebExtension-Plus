/**
 * Compile policy shared by the renderer pipeline builder and the GPU benchmark.
 *
 * Both call sites resolve each {@link EnhancementEffect} against the static
 * descriptor table and then:
 *
 *  1. derive the per-effect upscale factors and the geometry role flags
 *     (`restoreFlags`, `postEpilogueFlags`) the library-free chain compiler
 *     consumes, and
 *  2. compile each retained effect through its engine backend, projecting the
 *     backend node into a {@link ChainEffectStep}.
 *
 * This module is the single home for that policy. It is pure and
 * library-free at runtime: the only import from `anime4k-webgpu-async` is
 * type-only (erased by esbuild-loader), so it never inlines the monolithic
 * library. Logging text stays at each call site via {@link EffectCompilerLogging}
 * because the renderer and the benchmark intentionally use different prefixes.
 */
import type { Dimensions, EnhancementEffect } from '@/types';
import type { BackendRegistry, GpuResourceCacheLike } from 'anime4k-webgpu-async';
import type { EffectResolution } from '@utils/effect-registry';
import type {
  ChainEffectStep,
  CompileChainEffect,
  CompileChainEffectArgs,
} from './effect-chain-compiler';

/**
 * Compute the per-effect upscale factor in encode order. The resolved
 * descriptor's declared scale is authoritative; unresolved entries fall back to
 * the effect's own `upscaleFactor` so their geometry slot is still planned.
 */
export function deriveUpscaleFactors(
  effects: readonly EnhancementEffect[],
  resolutions: readonly EffectResolution[],
): number[] {
  return effects.map((effect, i) => {
    const resolution = resolutions[i];
    if (resolution.status === 'resolved') {
      return resolution.effect.descriptor.dimensionBehavior.scale ?? 1;
    }
    return effect.upscaleFactor ?? 1;
  });
}

/**
 * Per-effect `descriptor.category === 'restore'` flags, in encode order.
 * Helpers (e.g. ClampHighlights → 'helper') are never misclassified.
 */
export function deriveRestoreFlags(resolutions: readonly EffectResolution[]): boolean[] {
  return resolutions.map(
    (resolution) =>
      resolution.status === 'resolved'
      && resolution.effect.descriptor.category === 'restore',
  );
}

/**
 * Per-effect `descriptor.category === 'color'` flags, in encode order. Color
 * grading must run AFTER the deferred ClampHighlightsApply epilogue.
 */
export function derivePostEpilogueFlags(resolutions: readonly EffectResolution[]): boolean[] {
  return resolutions.map(
    (resolution) =>
      resolution.status === 'resolved'
      && resolution.effect.descriptor.category === 'color',
  );
}

/**
 * Call-site logging hooks. The compile flow is identical across callers; only
 * the emitted text (and the benchmark's extra catch-all) differs.
 */
export interface EffectCompilerLogging {
  /** A resolved effect's backend compile threw. */
  registryFailure(effect: EnhancementEffect, backendId: string, error: unknown): void;
  /** A resolved effect was skipped because it is unresolved/unknown. */
  skipped(effect: EnhancementEffect, status: 'unresolved' | 'unknown'): void;
  /**
   * An unexpected error escaped the per-effect compile. When omitted (renderer)
   * errors propagate; when supplied (benchmark) it is logged and swallowed.
   */
  unexpected?(effect: EnhancementEffect, error: unknown): void;
}

/** Options for {@link createEffectCompiler}. */
export interface EffectCompilerOptions {
  device: GPUDevice;
  registry: BackendRegistry;
  /** Per-effect resolutions, parallel to the effect chain. */
  resolutions: readonly EffectResolution[];
  /** Shared GPU resource cache handed to every backend compile. */
  resources?: GpuResourceCacheLike;
  /** Source dimensions handed to every backend compile. */
  sourceDimensions: Dimensions;
  /** Chain-level stale check forwarded to every backend compile. */
  isStale: () => boolean;
  logging: EffectCompilerLogging;
}

/**
 * Build the per-effect compiler callback injected into
 * {@link import('./effect-chain-compiler').compileEffectChain}.
 *
 * The chain compiler supplies the current texture/dimensions and the chain-level
 * target dimensions; this callback resolves the effect's backend, compiles it,
 * and projects the node to the step shape the chain walk consumes. A failed or
 * unresolved effect returns `null`, which keeps the chain and skips the effect.
 */
export function createEffectCompiler(options: EffectCompilerOptions): CompileChainEffect {
  const { device, registry, resolutions, resources, sourceDimensions, isStale, logging } = options;

  const compile = async ({
    effect,
    index,
    inputTexture,
    currentDimensions,
    targetDimensions,
  }: CompileChainEffectArgs): Promise<ChainEffectStep | null> => {
    const resolution = resolutions[index];

    if (resolution.status === 'resolved') {
      const { descriptor, reference } = resolution.effect;
      try {
        const backend = await registry.getBackendAsync(descriptor.backendId);
        const node = await backend.compileEffect(reference, {
          device,
          inputTexture,
          sourceDimensions,
          currentDimensions,
          targetDimensions,
          params: effect.params,
          resources,
          isStale,
        });
        return {
          pipeline: node.pipeline,
          label: node.profileLabel,
          scaleApplied: descriptor.dimensionBehavior.kind === 'scale',
          postDimensions: node.outputDimensions,
        };
      } catch (error) {
        logging.registryFailure(effect, descriptor.backendId, error);
        return null;
      }
    }

    logging.skipped(effect, resolution.status);
    return null;
  };

  if (!logging.unexpected) return compile;

  const unexpected = logging.unexpected;
  return async (args) => {
    try {
      return await compile(args);
    } catch (error) {
      unexpected(args.effect, error);
      return null;
    }
  };
}
