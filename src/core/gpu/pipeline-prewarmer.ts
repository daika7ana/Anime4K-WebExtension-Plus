/**
 * Speculative pipeline pre-warming.
 *
 * WebGPU drivers (Dawn in Chrome/Edge, wgpu in Firefox, Metal in Safari) cache
 * compiled shader modules internally per-device. When `createComputePipeline()`
 * is called with a descriptor whose shader was already compiled, the driver skips
 * recompilation and returns nearly instantly (~1-3ms vs ~25ms).
 *
 * This module exploits that by pre-constructing dummy pipelines (with 1×1 textures)
 * during idle time (page load, settings change). When the real pipelines are
 * constructed later, the shader cache hits make them near-instant.
 *
 * The pre-warmer is engine-agnostic: it never imports the Anime4K library or
 * resolves `className` → class itself. The caller (the pipeline builder) supplies
 * a `compileDummy` callback that knows how to compile one effect through its
 * engine backend. The dummy pipelines are destroyed immediately after
 * construction — the compiled shaders remain cached in the driver.
 */

import type { DestroyablePipeline, DisposablePipeline } from '@/types';
import { yieldToMain } from '@core/utils/yield-utils';

/** Engine-agnostic identity of one effect to pre-warm. */
export interface PreWarmEffectRef {
  backendId?: string;
  key: string;
  className: string;
}

/**
 * Optional descriptor capabilities governing whether an effect may be pre-warmed.
 * When `prewarmable === false` or `loadsAssets === true` the effect is skipped.
 */
export interface PreWarmCapabilities {
  prewarmable?: boolean;
  loadsAssets?: boolean;
}

/** One pre-warm unit: the effect identity plus optional descriptor capabilities. */
export interface PreWarmTarget {
  ref: PreWarmEffectRef;
  capabilities?: PreWarmCapabilities;
}

/**
 * Compile a dummy pipeline for one effect against the supplied 1×1 texture.
 * Returns `null` when the effect cannot be compiled (unknown class/backend).
 */
export type CompileDummy = (
  ref: PreWarmEffectRef,
  device: GPUDevice,
  dummyTexture: GPUTexture,
) => DestroyablePipeline | null | Promise<DestroyablePipeline | null>;

/** Stable dedupe key for one target: `backendId:key` when resolvable, else `className`. */
function targetIdentity(target: PreWarmTarget): string {
  const { backendId, key, className } = target.ref;
  return backendId ? `${backendId}:${key}` : className;
}

function shouldSkip(target: PreWarmTarget): boolean {
  const capabilities = target.capabilities;
  return capabilities?.prewarmable === false || capabilities?.loadsAssets === true;
}

export class PipelinePreWarmer {
  private warmedSignatures: Set<string> = new Set();
  private currentWarmId: symbol = Symbol('initial');

  /**
   * Pre-warm pipelines for a given effect chain.
   * Safe to call multiple times — only warms new/changed chains.
   *
   * @param device - The GPU device to use for pipeline creation
   * @param targets - The effect identities (and capabilities) to pre-warm
   * @param compileDummy - Compiles one dummy pipeline; supplied by the caller so
   *   the pre-warmer stays engine-agnostic.
   */
  async warm(
    device: GPUDevice,
    targets: readonly PreWarmTarget[],
    compileDummy: CompileDummy,
  ): Promise<void> {
    // Deduplicate: only warm if the engine-identity chain has changed. Params are
    // deliberately ignored — construction defaults are what gets compiled.
    const signature = JSON.stringify(targets.map(targetIdentity));
    if (this.warmedSignatures.has(signature)) return;

    // Cancel any in-progress warm
    const warmId = Symbol('warm');
    this.currentWarmId = warmId;

    let dummyTexture: GPUTexture | null = null;
    try {
      // Create minimal dummy texture (1×1 is enough to trigger shader compilation)
      dummyTexture = device.createTexture({
        size: [1, 1],
        format: 'rgba8unorm',
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.STORAGE_BINDING,
      });

      // Construct each pipeline with the dummy texture.
      // Each constructor calls createComputePipeline() internally,
      // which triggers shader compilation and caching in the driver.
      for (const target of targets) {
        // Check if this warm was superseded
        if (this.currentWarmId !== warmId) return; // finally handles cleanup

        // Engine payloads are not pre-warmed (skip fetching/decoding assets).
        if (shouldSkip(target)) {
          await yieldToMain();
          continue;
        }

        try {
          const dummyPipeline = await compileDummy(target.ref, device, dummyTexture);

          if (dummyPipeline) {
            // Destroy the dummy pipeline to free GPU memory.
            // The compiled shaders remain cached in the driver.
            this.safeDestroy(dummyPipeline);
          }
        } catch (e) {
          console.warn(`[PipelinePreWarmer] Failed to pre-warm ${target.ref.key}:`, e);
        }

        // Yield between top-level pipelines to avoid blocking during pre-warm
        await yieldToMain();
      }

      this.warmedSignatures.add(signature);
      console.log(`[PipelinePreWarmer] Pre-warm complete for: ${signature}`);
    } catch (e) {
      console.warn('[PipelinePreWarmer] Pre-warm failed:', e);
    } finally {
      dummyTexture?.destroy();
    }
  }

  /**
   * Invalidate the warm cache (e.g., when device is lost/recreated).
   */
  invalidate(): void {
    this.warmedSignatures.clear();
    this.currentWarmId = Symbol('invalidated');
  }

  private safeDestroy(pipeline: unknown, seen?: WeakSet<object>): void {
    if (!pipeline || typeof pipeline !== 'object') return;
    const seenSet = seen ?? new WeakSet<object>();
    if (seenSet.has(pipeline)) return;
    seenSet.add(pipeline);

    try {
      const p = pipeline as DisposablePipeline;
      // Destroy children first to avoid double-destroy
      if (Array.isArray(p.pipelines)) {
        for (const sub of p.pipelines) {
          this.safeDestroy(sub, seenSet);
        }
      }
      if (typeof p.destroy === 'function') {
        p.destroy();
      }
      if (p.outputTexture?.destroy) {
        p.outputTexture.destroy();
      }
    } catch {
      // Best-effort cleanup
    }
  }
}
