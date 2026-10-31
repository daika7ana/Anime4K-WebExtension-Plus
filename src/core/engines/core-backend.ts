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

const CORE_PARAM_DEFAULTS = Object.fromEntries(
  coreEffectDescriptors.map((descriptor) => [
    descriptor.key,
    Object.fromEntries(
      Object.entries(descriptor.paramsSchema ?? {}).map(([name, schema]) => [name, schema.defaultValue]),
    ),
  ]),
) as Record<string, Record<string, number>>;

/**
 * Core effect constructors + descriptor builders keyed by backend-local key.
 *
 * Adding a new core effect is a one-entry change here. The descriptor builder
 * receives the live effect params so per-effect values (e.g. strength,
 * threshold) flow through uniformly; each param falls back to the descriptor
 * schema default (the single source of truth for defaults/bounds).
 */
const CORE_EFFECTS: Record<string, CoreEffectEntry> = {
  CAS: {
    EffectClass: CAS,
    getDescriptor: (device, inputTexture, params) => ({
      device,
      inputTexture,
      sharpness: params?.sharpness ?? CORE_PARAM_DEFAULTS.CAS.sharpness,
    }),
  },
  Debanding: {
    EffectClass: Debanding,
    getDescriptor: (device, inputTexture, params) => ({
      device,
      inputTexture,
      strength: params?.strength ?? CORE_PARAM_DEFAULTS.Debanding.strength,
      bandThreshold: params?.bandThreshold ?? CORE_PARAM_DEFAULTS.Debanding.bandThreshold,
    }),
  },
  ColorAdjust: {
    EffectClass: ColorAdjust,
    getDescriptor: (device, inputTexture, params) => ({
      device,
      inputTexture,
      brightness: params?.brightness ?? CORE_PARAM_DEFAULTS.ColorAdjust.brightness,
      gamma: params?.gamma ?? CORE_PARAM_DEFAULTS.ColorAdjust.gamma,
      contrast: params?.contrast ?? CORE_PARAM_DEFAULTS.ColorAdjust.contrast,
      saturation: params?.saturation ?? CORE_PARAM_DEFAULTS.ColorAdjust.saturation,
      vibrance: params?.vibrance ?? CORE_PARAM_DEFAULTS.ColorAdjust.vibrance,
      exposure: params?.exposure ?? CORE_PARAM_DEFAULTS.ColorAdjust.exposure,
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
