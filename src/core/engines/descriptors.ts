/**
 * Static descriptor metadata for the extension's effect backends.
 *
 * The 15 Anime4K descriptors are imported from the library's dependency-free
 * ESM catalog subpath (`anime4k-webgpu-async/engines/anime4k/catalog`). That
 * module is a standalone `anime4kEffectDescriptors` export with no pipeline or
 * WGSL imports, so the persistence/validation seam can consume it without
 * inlining the ~3.3 MiB library into the UI entry chunks.
 *
 * Do NOT import the package root or the `engines` / `engines/anime4k` barrels
 * here: those eagerly pull the Anime4K backend, constructors and pipelines and
 * would inline the whole library. `seam-bundle-purity.test.ts` enforces this.
 *
 * The extension-owned core effects (CAS / Debanding / ColorAdjust) are defined
 * here (metadata only) so this module has no runtime dependency on the GPU
 * pipeline builder; `./core-backend` imports {@link coreEffectDescriptors}
 * from here.
 *
 * The library catalog declares no `paramsSchema` for DoG / BilateralMean, so
 * their schemas are supplied extension-side (see
 * {@link ANIME4K_PARAM_SCHEMA_OVERLAY}) rather than duplicated in the slider
 * and validation tables. Sliders and validation bounds are both derived from
 * these schemas.
 */
import type { EffectDescriptor, EffectParamSchema } from 'anime4k-webgpu-async';
import { anime4kEffectDescriptors } from 'anime4k-webgpu-async/engines/anime4k/catalog';

const SAME = { kind: 'same' } as const;

function numberParam(
  min: number,
  max: number,
  step: number,
  defaultValue: number,
  labelKey?: string,
  labelFallback?: string,
): EffectParamSchema {
  return {
    type: 'number',
    min,
    max,
    step,
    defaultValue,
    ...(labelKey !== undefined ? { labelKey } : {}),
    ...(labelFallback !== undefined ? { labelFallback } : {}),
  };
}

/**
 * Catalog of the extension-owned effects (backend `core`).
 *
 * `paramsSchema` is the single source of truth for slider bounds/defaults
 * (`src/ui/options/param-sliders.ts`) and validation bounds
 * (`src/utils/validation.ts`, `EFFECT_PARAM_BOUNDS`). Defined here (metadata
 * only) so the persistence/validation path never pulls the GPU pipeline
 * builder; `./core-backend` imports this for compilation.
 */
export const coreEffectDescriptors: readonly EffectDescriptor[] = [
  {
    id: 'anime4k/Sharpen/CAS',
    backendId: 'core',
    key: 'CAS',
    name: 'Contrast Adaptive Sharpening (CAS)',
    category: 'sharpen',
    dimensionBehavior: SAME,
    paramsSchema: {
      sharpness: numberParam(0, 1, 0.01, 0.5, 'sharpness', 'Sharpness'),
    },
  },
  {
    id: 'anime4k/Debanding/Debanding',
    backendId: 'core',
    key: 'Debanding',
    name: 'Debanding',
    category: 'deband',
    dimensionBehavior: SAME,
    paramsSchema: {
      strength: numberParam(0, 1, 0.01, 0.5, 'debandingStrength', 'Debanding'),
      bandThreshold: numberParam(0, 1, 0.01, 0.08, 'debandingThreshold', 'Threshold'),
    },
  },
  {
    id: 'anime4k/ColorGrading/ColorAdjust',
    backendId: 'core',
    key: 'ColorAdjust',
    name: 'Color Grading',
    category: 'color',
    dimensionBehavior: SAME,
    hidden: true,
    paramsSchema: {
      brightness: numberParam(-1, 1, 0.01, 0),
      gamma: numberParam(0.1, 4, 0.01, 1),
      contrast: numberParam(0, 2, 0.01, 1),
      saturation: numberParam(0, 2, 0.01, 1),
      vibrance: numberParam(-1, 1, 0.01, 0),
      exposure: numberParam(-3, 3, 0.1, 0),
    },
  },
];

/**
 * Extension-side `paramsSchema` overlay for library Anime4K descriptors whose
 * catalog entries declare none. Keyed by descriptor id; the overlay is merged
 * onto the imported descriptor (only for ids present here) so sliders and
 * validation bounds stay descriptor-driven.
 */
const ANIME4K_PARAM_SCHEMA_OVERLAY: Readonly<
  Record<string, Readonly<Record<string, EffectParamSchema>>>
> = {
  'anime4k/Deblur/DoG': {
    strength: numberParam(1, 10, 0.1, 4, 'strength', 'Strength'),
  },
  'anime4k/Denoise/BilateralMean': {
    strength: numberParam(0, 1, 0.01, 0.2, 'intensitySigma', 'Intensity σ'),
    strength2: numberParam(0.5, 5, 0.1, 2, 'spatialSigma', 'Spatial σ'),
  },
};

/**
 * All static descriptors known to the seam, in backend-registration order:
 * the 15 library Anime4K effects (from the catalog-only subpath, with the
 * DoG / BilateralMean schemas overlaid above) followed by the 3 extension core
 * effects. (18 total, of which ColorAdjust is hidden.)
 */
export const extensionEffectDescriptors: readonly EffectDescriptor[] = [
  ...anime4kEffectDescriptors.map((descriptor) => {
    const overlay = ANIME4K_PARAM_SCHEMA_OVERLAY[descriptor.id];
    return overlay ? { ...descriptor, paramsSchema: overlay } : descriptor;
  }),
  ...coreEffectDescriptors,
];
