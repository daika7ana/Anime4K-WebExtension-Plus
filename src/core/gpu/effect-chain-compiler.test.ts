/**
 * Ordering tests for {@link compileEffectChain}'s post-epilogue pass.
 *
 * Color-grading effects are flagged via `postEpilogueFlags` so they compile
 * AFTER the deferred `ClampHighlightsApply` epilogues. Otherwise the deferred
 * apply clamps the graded frame back to the pre-grading luma stats, making the
 * color effect appear to do nothing. These tests stub the per-effect compiler
 * (no GPU mock) and assert the emitted pipeline order plus the texture threaded
 * into the post effect.
 */
import { describe, it, expect, vi } from 'vitest';
import type { DestroyablePipeline, EnhancementEffect } from '@/types';
import {
  compileEffectChain,
  DEFERRED_APPLY_LABEL,
  type CompileChainEffectArgs,
  type ChainEffectStep,
} from './effect-chain-compiler';
import type { PipelineCtor } from './effect-chain';

/** Minimal effect; only identity fields matter to the compiler. */
function effect(className: string): EnhancementEffect {
  return { id: className, name: className, className, upscaleFactor: 1 };
}

/** Placeholder texture; identity is all the assertions need. */
function texture(label: string): GPUTexture {
  return { label } as unknown as GPUTexture;
}

describe('compileEffectChain post-epilogue ordering', () => {
  it('compiles post-epilogue effects after the deferred epilogue, threading the deferred output', async () => {
    const firstOutput = texture('first-output');
    const deferredOutput = texture('deferred-output');
    const postOutput = texture('post-output');

    const deferredPipeline = {
      getOutputTexture: () => deferredOutput,
    } as unknown as DestroyablePipeline;

    const firstPipeline = {
      getOutputTexture: () => firstOutput,
      getDeferredPipeline: () => deferredPipeline,
    } as unknown as DestroyablePipeline;

    const postPipeline = {
      getOutputTexture: () => postOutput,
    } as unknown as DestroyablePipeline;

    let postInputTexture: GPUTexture | undefined;
    const compileOrder: number[] = [];

    const compileEffect = async (
      args: CompileChainEffectArgs,
    ): Promise<ChainEffectStep | null> => {
      compileOrder.push(args.index);
      if (args.index === 0) {
        return {
          pipeline: firstPipeline,
          label: 'first',
          scaleApplied: false,
          postDimensions: { width: 32, height: 24 },
        };
      }
      postInputTexture = args.inputTexture;
      return {
        pipeline: postPipeline,
        label: 'post',
        scaleApplied: false,
        postDimensions: { width: 16, height: 12 },
      };
    };

    const result = await compileEffectChain({
      device: { limits: { maxTextureDimension2D: 8192 } } as unknown as GPUDevice,
      inputTexture: texture('input'),
      sourceDimensions: { width: 16, height: 12 },
      targetDimensions: { width: 16, height: 12 },
      effects: [effect('First'), effect('Post')],
      upscaleFactors: [1, 1],
      restoreFlags: [false, false],
      postEpilogueFlags: [false, true],
      downscaleCtor: null,
      compileEffect,
    });

    expect(result.superseded).toBe(false);
    expect(result.labels).toEqual(['first', DEFERRED_APPLY_LABEL, 'post']);
    expect(result.pipelines).toEqual([firstPipeline, deferredPipeline, postPipeline]);
    // The post effect must consume the deferred apply's output, not `firstOutput`.
    expect(postInputTexture).toBe(deferredOutput);
    // The deferred epilogue must not compile the post effect in the main loop.
    expect(compileOrder).toEqual([0, 1]);
    // Final dimensions come from the last (post) step.
    expect(result.outputDimensions).toEqual({ width: 16, height: 12 });
  });

  it('does not compile a suppressed post-epilogue effect in the second pass', async () => {
    const downscaleOutput = texture('downscale-output');

    class FakeDownscale {
      private output = downscaleOutput;
      constructor(_descriptor: unknown) {}
      getOutputTexture() {
        return this.output;
      }
    }

    const compileOrder: number[] = [];
    const compileEffect = async (
      args: CompileChainEffectArgs,
    ): Promise<ChainEffectStep | null> => {
      compileOrder.push(args.index);
      // Index 1 is BOTH post-epilogue (`category: 'color'`) and suppressible:
      // with `upscaleFactors: [2, 2]` and a shrinking/equal target, only the
      // first upscaler is retained (`suppressFromIndex === 0`), so index 1 is
      // suppressed by the main loop and must stay suppressed in pass 2.
      return {
        pipeline: {
          getOutputTexture: () => texture(`step-${args.index}-output`),
        } as unknown as DestroyablePipeline,
        label: args.index === 0 ? 'upscale' : 'suppressed-color',
        scaleApplied: args.index === 0,
        postDimensions: { width: 2560, height: 1440 },
      };
    };

    const result = await compileEffectChain({
      device: { limits: { maxTextureDimension2D: 8192 } } as unknown as GPUDevice,
      inputTexture: texture('input'),
      sourceDimensions: { width: 1920, height: 1080 },
      targetDimensions: { width: 1280, height: 720 },
      effects: [effect('Upscale'), effect('Color')],
      upscaleFactors: [2, 2],
      restoreFlags: [false, false],
      postEpilogueFlags: [false, true],
      downscaleCtor: FakeDownscale as unknown as PipelineCtor,
      compileEffect,
    });

    expect(result.superseded).toBe(false);
    // Pass 1 compiles the retained upscaler and anchors the single final
    // Downscale at its slot; the suppressed post-epilogue effect is never
    // compiled, so the final-Downscale ordering is unchanged.
    expect(compileOrder).toEqual([0]);
    expect(result.labels).toEqual(['upscale', 'Downscale']);
    expect(result.labels).not.toContain('suppressed-color');
    // `outputDimensions` must describe the post-final-Downscale texture, not the
    // retained upscaler's intermediate size (2560x1440).
    expect(result.outputDimensions).toEqual({ width: 1280, height: 720 });
  });

  it('reports the post-final-Downscale size when the Downscale is anchored at a suppressed upscaler', async () => {
    const downscaleOutput = texture('downscale-output');

    class FakeDownscale {
      private output = downscaleOutput;
      constructor(_descriptor: unknown) {}
      getOutputTexture() {
        return this.output;
      }
    }

    const compileOrder: number[] = [];
    const compileEffect = async (
      args: CompileChainEffectArgs,
    ): Promise<ChainEffectStep | null> => {
      compileOrder.push(args.index);
      return {
        pipeline: {
          getOutputTexture: () => texture(`step-${args.index}-output`),
        } as unknown as DestroyablePipeline,
        label: `step-${args.index}`,
        scaleApplied: false,
        postDimensions: args.currentDimensions,
      };
    };

    const result = await compileEffectChain({
      device: { limits: { maxTextureDimension2D: 8192 } } as unknown as GPUDevice,
      inputTexture: texture('input'),
      sourceDimensions: { width: 1920, height: 1080 },
      targetDimensions: { width: 1280, height: 720 },
      effects: [effect('First'), effect('Upscale')],
      upscaleFactors: [1, 2],
      restoreFlags: [false, false],
      // A budget the retained 2x (-> 3840x2160 = 8.29 MP) exceeds, so the limit
      // pass suppresses it inclusively and anchors the final Downscale at its
      // slot — the suppression-branch emission.
      limits: { maxDimension: 8192, maxIntermediatePixels: 2_000_000 },
      downscaleCtor: FakeDownscale as unknown as PipelineCtor,
      compileEffect,
    });

    expect(result.superseded).toBe(false);
    expect(compileOrder).toEqual([0]);
    expect(result.labels).toEqual(['step-0', 'Downscale']);
    // Only the scale-1 first step set the dimensions (1920x1080) before the
    // suppressed upscaler emitted the final Downscale; the result must reflect
    // the Downscale target.
    expect(result.outputDimensions).toEqual({ width: 1280, height: 720 });
  });
});

describe('compileEffectChain superseded cleanup', () => {
  /**
   * Build a step whose pipeline records destruction, so tests can prove a stale
   * compile destroys every pipeline it created (each owns an output texture).
   */
  function trackedStep(index: number, track: Array<ReturnType<typeof vi.fn>>): ChainEffectStep {
    const destroy = vi.fn();
    track.push(destroy);
    return {
      pipeline: {
        getOutputTexture: () => texture(`step-${index}-output`),
        destroy,
      } as unknown as DestroyablePipeline,
      label: `step-${index}`,
      scaleApplied: false,
      postDimensions: { width: 16, height: 12 },
    };
  }

  it('destroys every pipeline built before the post-loop stale check fires', async () => {
    const destroys: Array<ReturnType<typeof vi.fn>> = [];

    const result = await compileEffectChain({
      device: { limits: { maxTextureDimension2D: 8192 } } as unknown as GPUDevice,
      inputTexture: texture('input'),
      sourceDimensions: { width: 16, height: 12 },
      targetDimensions: { width: 16, height: 12 },
      effects: [effect('A'), effect('B'), effect('C')],
      upscaleFactors: [1, 1, 1],
      restoreFlags: [false, false, false],
      downscaleCtor: null,
      compileEffect: async (args) => trackedStep(args.index, destroys),
      // Stale as soon as the main loop completes: the freshly built pipelines
      // must be destroyed, never handed back or dropped alive.
      isStale: () => true,
    });

    expect(result.superseded).toBe(true);
    expect(result.pipelines).toEqual([]);
    expect(result.labels).toEqual([]);
    // Exactly three pipelines were built, and each was destroyed exactly once.
    expect(destroys).toHaveLength(3);
    for (const destroy of destroys) {
      expect(destroy).toHaveBeenCalledTimes(1);
    }
  });

  it('destroys the deferred epilogue nodes materialized before the post-pass stale check', async () => {
    const mainDestroy = vi.fn();
    const deferredDestroy = vi.fn();

    const deferredPipeline = {
      getOutputTexture: () => texture('deferred-output'),
      destroy: deferredDestroy,
    } as unknown as DestroyablePipeline;

    const mainPipeline = {
      getOutputTexture: () => texture('main-output'),
      getDeferredPipeline: () => deferredPipeline,
      destroy: mainDestroy,
    } as unknown as DestroyablePipeline;

    // First stale check (after the main loop) passes; the deferred epilogue is
    // materialized; the second stale check then fires.
    let staleChecks = 0;
    const result = await compileEffectChain({
      device: { limits: { maxTextureDimension2D: 8192 } } as unknown as GPUDevice,
      inputTexture: texture('input'),
      sourceDimensions: { width: 16, height: 12 },
      targetDimensions: { width: 16, height: 12 },
      effects: [effect('First')],
      upscaleFactors: [1],
      restoreFlags: [false],
      downscaleCtor: null,
      compileEffect: async () => ({
        pipeline: mainPipeline,
        label: 'first',
        scaleApplied: false,
        postDimensions: { width: 16, height: 12 },
      }),
      isStale: () => ++staleChecks > 1,
    });

    expect(result.superseded).toBe(true);
    expect(result.pipelines).toEqual([]);
    expect(mainDestroy).toHaveBeenCalledTimes(1);
    expect(deferredDestroy).toHaveBeenCalledTimes(1);
  });
});
