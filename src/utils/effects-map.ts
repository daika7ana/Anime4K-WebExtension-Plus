import type { EffectDescriptor } from 'anime4k-webgpu-async';
import { EnhancementEffect } from '../types';
import { descriptorToLegacyEffect, getEffectDescriptorById } from './effect-registry';

/**
 * Catalog of all available enhancement effects.
 *
 * This is the single source of truth for the user-selectable effects in the
 * system. It is a DERIVED view of the engine seam: an explicit, ordered
 * allowlist of effect ids is resolved through `getEffectDescriptorById` and
 * mapped to the legacy leaf shape via `descriptorToLegacyEffect`.
 *
 * id: Unique identifier used for storage and identification.
 * name: User-friendly display name shown in the UI.
 * className: Corresponds to the class exported by the `anime4k-webgpu-async`
 *   library, used for dynamic instantiation.
 * backendId/key: Engine backend that owns the effect (additive seam metadata).
 *
 * Note: System-only effects like ColorAdjust (color grading) are intentionally
 * excluded from this allowlist. They are registered in the core backend and
 * injected programmatically by video-enhancer.ts — not available for users to
 * add to custom effect chains.
 */
export const AVAILABLE_EFFECT_IDS = [
  // Sharpen Effects
  'anime4k/Sharpen/CAS',

  // Helper Effect
  // Note: `Downscale` is handled automatically by the extension based on resolution, not available as a user-selectable effect.
  'anime4k/Helper/ClampHighlights',

  // Debanding Effects
  'anime4k/Debanding/Debanding',

  // Deblur Effects
  'anime4k/Deblur/DoG',

  // Denoise Effects
  'anime4k/Denoise/BilateralMean',

  // Restore Effects
  'anime4k/Restore/CNNM',
  'anime4k/Restore/CNNSoftM',
  'anime4k/Restore/CNNSoftVL',
  'anime4k/Restore/CNNVL',
  'anime4k/Restore/CNNUL',
  'anime4k/Restore/GANUUL',

  // Upscale Effects
  'anime4k/Upscale/CNNx2M',
  'anime4k/Upscale/CNNx2VL',
  'anime4k/Upscale/DenoiseCNNx2VL',
  'anime4k/Upscale/CNNx2UL',
  'anime4k/Upscale/GANx3L',
  'anime4k/Upscale/GANx4UUL',
] as const;

/**
 * Catalog default params for descriptors that do not (yet) declare a
 * `paramsSchema` — currently the library-provided Anime4K catalog. Values
 * mirror the pre-seam literal catalog exactly.
 */
const LEGACY_DEFAULT_PARAMS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  'anime4k/Deblur/DoG': { strength: 4 },
  'anime4k/Denoise/BilateralMean': { strength: 0.2, strength2: 2 },
};

/** Numeric defaults declared by a descriptor's `paramsSchema`, if any. */
function schemaDefaultParams(
  descriptor: EffectDescriptor,
): Record<string, number> | undefined {
  if (!descriptor.paramsSchema) return undefined;
  const params: Record<string, number> = {};
  for (const [key, schema] of Object.entries(descriptor.paramsSchema)) {
    if (typeof schema.defaultValue === 'number') params[key] = schema.defaultValue;
  }
  return Object.keys(params).length > 0 ? params : undefined;
}

/** Default params for a descriptor: schema first, legacy literal fallback second. */
function descriptorDefaultParams(
  descriptor: EffectDescriptor,
): Record<string, number> | undefined {
  const fromSchema = schemaDefaultParams(descriptor);
  if (fromSchema) return fromSchema;
  const fallback = LEGACY_DEFAULT_PARAMS[descriptor.id];
  return fallback ? { ...fallback } : undefined;
}

/**
 * Convert a backend descriptor into the legacy catalog shape used throughout
 * persistence, validation and the renderer, enriching it with the catalog
 * default params (descriptor `paramsSchema` first, legacy fallback second).
 */
export function descriptorToCatalogEffect(descriptor: EffectDescriptor): EnhancementEffect {
  const effect = descriptorToLegacyEffect(descriptor);
  const params = descriptorDefaultParams(descriptor);
  if (params) effect.params = params;
  return effect;
}

/**
 * The user-selectable effect catalog, derived from the engine seam in the
 * frozen allowlist order. Adding/removing an effect is an allowlist change;
 * its metadata comes from the backend descriptor.
 */
export const AVAILABLE_EFFECTS: EnhancementEffect[] = AVAILABLE_EFFECT_IDS
  .map((id) => getEffectDescriptorById(id))
  .filter((descriptor): descriptor is EffectDescriptor => descriptor !== undefined)
  .map((descriptor) => descriptorToCatalogEffect(descriptor));
