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
 * The dummy pipelines are destroyed immediately after construction — the compiled
 * shaders remain cached in the driver.
 */

import type { EnhancementEffect } from '@/types';
import { yieldToMain } from '@core/utils/yield-utils';

export class PipelinePreWarmer {
  private warmedSignatures: Set<string> = new Set();
  private currentWarmId: symbol = Symbol('initial');
  private cachedAnime4KModule: typeof import('anime4k-webgpu') | null = null;

  /**
   * Pre-warm pipelines for a given effect chain.
   * Safe to call multiple times — only warms new/changed chains.
   *
   * @param device - The GPU device to use for pipeline creation
   * @param effects - The effect chain to pre-warm
   * @param customEffectHandler - Optional handler for custom effects (e.g., CAS).
   *   Returns the effect class and its constructor descriptor, or null if not a custom effect.
   */
  async warm(
    device: GPUDevice,
    effects: EnhancementEffect[],
    customEffectHandler?: (className: string, device: GPUDevice, dummyTexture: GPUTexture) => { EffectClass: any; descriptor: Record<string, unknown> } | null
  ): Promise<void> {
    // Deduplicate: only warm if the chain has changed
    const signature = JSON.stringify(effects.map(e => e.className));
    if (this.warmedSignatures.has(signature)) return;

    // Cancel any in-progress warm
    const warmId = Symbol('warm');
    this.currentWarmId = warmId;

    let dummyTexture: GPUTexture | null = null;
    try {
      if (!this.cachedAnime4KModule) {
        this.cachedAnime4KModule = await import('anime4k-webgpu');
      }
      const anime4kModule = this.cachedAnime4KModule;

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
      for (const effect of effects) {
        // Check if this warm was superseded
        if (this.currentWarmId !== warmId) return; // finally handles cleanup

        try {
          let EffectClass: any;
          let descriptor: Record<string, unknown> | null = null;

          // Check for custom effects first
          if (customEffectHandler) {
            const result = customEffectHandler(effect.className, device, dummyTexture);
            if (result) {
              EffectClass = result.EffectClass;
              descriptor = result.descriptor;
            }
          }

          if (!EffectClass) {
            EffectClass = (anime4kModule as Record<string, any>)[effect.className];
            // Default descriptor for anime4k-webgpu library effects
            descriptor = {
              device,
              inputTexture: dummyTexture,
              nativeDimensions: { width: 1, height: 1 },
              targetDimensions: { width: 1, height: 1 },
            };
          }

          if (EffectClass && descriptor) {
            // Constructor triggers createComputePipeline() calls internally.
            // The 1×1 texture means output textures are also 1×1 — minimal memory.
            const dummyPipeline = new EffectClass(descriptor);

            // Destroy the dummy pipeline to free GPU memory.
            // The compiled shaders remain cached in the driver.
            this.safeDestroy(dummyPipeline);
          }
        } catch (e) {
          console.warn(`[PipelinePreWarmer] Failed to pre-warm ${effect.className}:`, e);
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
      const p = pipeline as any;
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
