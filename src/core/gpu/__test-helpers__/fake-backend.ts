/**
 * Shared fake Anime4K backend scaffolding for the GPU builder/benchmark tests.
 *
 * DEV/TEST ONLY. Imported by `*.test.ts` files and, via dynamic `import()`,
 * their `vi.mock` factories (which are hoisted above static imports). Keeping
 * the fake library classes, the construction recorder and the registry backend
 * in one module keeps the renderer and benchmark suites in lockstep.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

interface ConstructedRecord {
  effectName: string;
  descriptor: any;
  paramUpdates: Array<[string, any]>;
}

/** Every fake effect construction, in order, across all tests in a file. */
export const constructed: ConstructedRecord[] = [];

/** Mutable counters shared with the mocked registry backend. */
export const state = { backendCompiles: 0 };

/**
 * Create a fake effect class that records each construction. Mirrors the
 * surface of the real library effects (`pass`, `getOutputTexture`,
 * `updateParam`, `destroy`).
 */
function makeEffectClass(effectName: string) {
  return class MockEffect {
    static effectName = effectName;
    descriptor: any;
    paramUpdates: Array<[string, any]> = [];
    constructor(descriptor: any) {
      this.descriptor = descriptor;
      constructed.push({ effectName, descriptor, paramUpdates: this.paramUpdates });
    }
    pass() { return Promise.resolve(); }
    getOutputTexture() { return this.descriptor.inputTexture; }
    updateParam(key: string, value: any) { this.paramUpdates.push([key, value]); }
    destroy() {}
  };
}

/**
 * Two-stage epilogue node: its `getOutputTexture()` is a DISTINCT marker
 * object so tests can prove the apply stage is the new chain tail (rather than
 * the pass-through stats node's input texture).
 */
function makeApplyClass() {
  return class MockClampHighlightsApply {
    static effectName = 'ClampHighlightsApply';
    descriptor: any;
    outputTexture: { width: number; height: number; kind: string };
    constructor(descriptor: any) {
      this.descriptor = descriptor;
      this.outputTexture = {
        width: descriptor.inputTexture?.width ?? 0,
        height: descriptor.inputTexture?.height ?? 0,
        kind: 'clamp-apply',
      };
      constructed.push({ effectName: 'ClampHighlightsApply', descriptor, paramUpdates: [] });
    }
    pass() { return Promise.resolve(); }
    getOutputTexture() { return this.outputTexture; }
    updateParam() {}
    destroy() {}
  };
}

const ClampHighlightsApplyClass = makeApplyClass();

// Mirror the shipped two-stage ClampHighlights: the stats node returns the
// apply node bound to the chain's final input texture.
const ClampHighlightsClass = class extends makeEffectClass('ClampHighlights') {
  getDeferredPipeline(finalInputTexture: any) {
    return new ClampHighlightsApplyClass({ inputTexture: finalInputTexture });
  }
};

/**
 * Superset of the fake library classes, keyed by backend key. Callers look up
 * `libraryClasses[ref.key]`; unused keys are inert.
 */
export const libraryClasses: Record<string, any> = {
  ClampHighlights: ClampHighlightsClass,
  CNNM: makeEffectClass('CNNM'),
  CNNSoftM: makeEffectClass('CNNSoftM'),
  CNNSoftVL: makeEffectClass('CNNSoftVL'),
  CNNVL: makeEffectClass('CNNVL'),
  CNNUL: makeEffectClass('CNNUL'),
  GANUUL: makeEffectClass('GANUUL'),
  CNNx2M: makeEffectClass('CNNx2M'),
  CNNx2VL: makeEffectClass('CNNx2VL'),
  DenoiseCNNx2VL: makeEffectClass('DenoiseCNNx2VL'),
  CNNx2UL: makeEffectClass('CNNx2UL'),
  GANx3L: makeEffectClass('GANx3L'),
  GANx4UUL: makeEffectClass('GANx4UUL'),
  DoG: makeEffectClass('DoG'),
  BilateralMean: makeEffectClass('BilateralMean'),
  ClampHighlightsApply: ClampHighlightsApplyClass,
  ColorAdjust: makeEffectClass('ColorAdjust'),
  Downscale: makeEffectClass('Downscale'),
};

/** Fake upscale factors keyed by backend key. */
const scaleByKey: Record<string, number> = {
  CNNx2M: 2,
  CNNx2VL: 2,
  DenoiseCNNx2VL: 2,
  CNNx2UL: 2,
  GANx3L: 3,
  GANx4UUL: 4,
};

/** A minimal library effect for callers that resolve every key to one class. */
export const MockLibEffect = makeEffectClass('MockLibEffect');

/** Options for {@link createFakeAnime4kBackend}. */
export interface FakeAnime4kBackendOptions {
  displayName: string;
  /** Prefix for the "no constructor" error (e.g. `[golden-fake]`). */
  missingCtorPrefix: string;
  /** Apply `ctx.params` to the constructed pipeline via `updateParam`. */
  applyParams?: boolean;
  /** Round scaled output dimensions up (`Math.ceil`) instead of truncating. */
  ceilScaledDimensions?: boolean;
  /** Custom constructor lookup; defaults to {@link libraryClasses}[key]. */
  resolveCtor?: (key: string) => any;
}

/**
 * Build a fake Anime4K engine backend over {@link libraryClasses}. The renderer
 * and benchmark registries differ only in these options, so the compile flow
 * (constructor lookup, descriptor shape, scale math) stays byte-identical.
 */
export function createFakeAnime4kBackend(options: FakeAnime4kBackendOptions) {
  const {
    displayName,
    missingCtorPrefix,
    applyParams = false,
    ceilScaledDimensions = false,
    resolveCtor,
  } = options;

  return {
    backendId: 'anime4k',
    displayName,
    listEffects: () => [],
    async compileEffect(ref: any, ctx: any) {
      const Ctor = resolveCtor ? resolveCtor(ref.key) : libraryClasses[ref.key];
      if (!Ctor) throw new Error(`${missingCtorPrefix} no constructor for "${ref.key}"`);
      state.backendCompiles += 1;

      const pipeline = new Ctor({
        device: ctx.device,
        inputTexture: ctx.inputTexture,
        nativeDimensions: ctx.currentDimensions,
        targetDimensions: ctx.targetDimensions,
      });
      if (applyParams && ctx.params) {
        for (const [key, value] of Object.entries(ctx.params)) pipeline.updateParam(key, value);
      }

      const scale = scaleByKey[ref.key] ?? 1;
      const outputDimensions = scale > 1
        ? {
          width: ceilScaledDimensions
            ? Math.ceil(ctx.currentDimensions.width * scale)
            : ctx.currentDimensions.width * scale,
          height: ceilScaledDimensions
            ? Math.ceil(ctx.currentDimensions.height * scale)
            : ctx.currentDimensions.height * scale,
        }
        : ctx.currentDimensions;

      return {
        pipeline,
        outputTexture: pipeline.getOutputTexture(),
        outputDimensions,
        profileLabel: ref.key,
      };
    },
  };
}

/** Comparable projection of one constructed pipeline descriptor. */
export function normalizeStep(record: { effectName: string; descriptor: any }) {
  const descriptor = record.descriptor ?? {};
  return {
    effectName: record.effectName,
    nativeDimensions: descriptor.nativeDimensions ?? null,
    targetDimensions: descriptor.targetDimensions ?? null,
    inputTexture: descriptor.inputTexture
      ? { width: descriptor.inputTexture.width, height: descriptor.inputTexture.height }
      : null,
  };
}
