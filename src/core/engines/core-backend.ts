/**
 * Core backend — the extension-owned custom effects (CAS, Debanding, ColorAdjust).
 *
 * Owns the per-effect constructors and descriptor builders for the extension's
 * custom WebGPU effects, so these effects participate in the engine contract
 * without depending on the GPU pipeline builder. Descriptors reuse the legacy ids
 * (`anime4k/...`) even though the backend id is `core`, so no storage migration
 * is required.
 */
import type {
  AlgorithmBackend,
  CompileEffectContext,
  CompiledEffectNode,
  EffectReference,
} from 'anime4k-webgpu-async';
import type { DestroyablePipeline, EffectClassDescriptor } from '@/types';
import { CAS } from '@core/effects/cas';
import { ColorAdjust } from '@core/effects/color-adjust';
import { Debanding } from '@core/effects/debanding';
import { coreEffectDescriptors } from './descriptors';

// Re-exported for existing consumers. The descriptors are defined in
// `./descriptors` (metadata only) so the persistence/validation path never
// pulls the GPU pipeline classes that this module imports for construction.
export { coreEffectDescriptors };

/** One constructable core effect: its constructor plus its descriptor builder. */
interface CoreEffectEntry {
  EffectClass: new (descriptor: EffectClassDescriptor) => DestroyablePipeline;
  getDescriptor: (
    device: GPUDevice,
    inputTexture: GPUTexture,
    params?: Record<string, number>,
  ) => EffectClassDescriptor;
}

/**
 * Core effect constructors + descriptor builders keyed by backend-local key.
 *
 * Adding a new core effect is a one-entry change here. The descriptor builder
 * receives the live effect params so per-effect values (e.g. strength,
 * threshold) flow through uniformly; each param falls back to the default used
 * by the corresponding descriptor schema.
 */
const CORE_EFFECTS: Record<string, CoreEffectEntry> = {
  CAS: {
    EffectClass: CAS,
    getDescriptor: (device, inputTexture, params) => ({
      device,
      inputTexture,
      sharpness: params?.sharpness ?? 0.5,
    }),
  },
  Debanding: {
    EffectClass: Debanding,
    getDescriptor: (device, inputTexture, params) => ({
      device,
      inputTexture,
      strength: params?.strength ?? 0.5,
      bandThreshold: params?.bandThreshold ?? 0.08,
    }),
  },
  ColorAdjust: {
    EffectClass: ColorAdjust,
    getDescriptor: (device, inputTexture, params) => ({
      device,
      inputTexture,
      brightness: params?.brightness ?? 0,
      gamma: params?.gamma ?? 1,
      contrast: params?.contrast ?? 1,
      saturation: params?.saturation ?? 1,
      vibrance: params?.vibrance ?? 0,
      exposure: params?.exposure ?? 0,
    }),
  },
};

export function createCoreBackend(): AlgorithmBackend {
  return {
    backendId: 'core',
    displayName: 'Core',
    listEffects: () => coreEffectDescriptors,
    async compileEffect(
      ref: EffectReference,
      ctx: CompileEffectContext,
    ): Promise<CompiledEffectNode> {
      const core = CORE_EFFECTS[ref.key];
      if (!core) {
        throw new Error(`[core] Unknown effect key "${ref.key}" (id "${ref.id}").`);
      }

      // Core effects only expose numeric params; `getDescriptor` narrows each
      // param to its default when absent.
      const params = ctx.params as Record<string, number> | undefined;
      const pipeline = new core.EffectClass(
        core.getDescriptor(ctx.device, ctx.inputTexture, params),
      );

      return {
        pipeline,
        outputTexture: pipeline.getOutputTexture(),
        outputDimensions: ctx.currentDimensions,
        profileLabel: ref.key,
      };
    },
  };
}
