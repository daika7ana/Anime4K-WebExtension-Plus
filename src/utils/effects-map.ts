import { EnhancementEffect } from '../types';

/**
 * Catalog of all available enhancement effects.
 * This is the single source of truth for all effects in the system.
 * id: Unique identifier used for storage and identification.
 * name: User-friendly display name shown in the UI.
 * className: Corresponds to the class exported by the `anime4k-webgpu-async` library, used for dynamic instantiation.
 *
 * Note: System-only effects like ColorAdjust (color grading) are intentionally excluded.
 * They are registered in CUSTOM_EFFECTS in pipeline-builder.ts and injected programmatically
 * by video-enhancer.ts — not available for users to add to custom effect chains.
 */
export const AVAILABLE_EFFECTS: EnhancementEffect[] = [
  // Sharpen Effects
  {
    id: 'anime4k/Sharpen/CAS',
    name: 'Contrast Adaptive Sharpening (CAS)',
    className: 'CAS',
    params: { sharpness: 0.5 },
  },

  // Helper Effect
  // Note: `Downscale` is handled automatically by the extension based on resolution, not available as a user-selectable effect.
  {
    id: 'anime4k/Helper/ClampHighlights',
    name: 'Clamp Highlights',
    className: 'ClampHighlights',
  },

  // Debanding Effects
  {
    id: 'anime4k/Debanding/Debanding',
    name: 'Debanding',
    className: 'Debanding',
    params: { strength: 0.5, bandThreshold: 0.08 },
  },

  // Deblur Effects
  {
    id: 'anime4k/Deblur/DoG',
    name: 'Deblur (DoG)',
    className: 'DoG',
    params: { strength: 4 },
  },

  // Denoise Effects
  {
    id: 'anime4k/Denoise/BilateralMean',
    name: 'Denoise (Bilateral Mean)',
    className: 'BilateralMean',
    params: { strength: 0.2, strength2: 2 },
  },

  // Restore Effects
  {
    id: 'anime4k/Restore/CNNM',
    name: 'Restore CNN (M)',
    className: 'CNNM',
  },
  {
    id: 'anime4k/Restore/CNNSoftM',
    name: 'Restore CNN Soft (M)',
    className: 'CNNSoftM',
  },
  {
    id: 'anime4k/Restore/CNNSoftVL',
    name: 'Restore CNN Soft (VL)',
    className: 'CNNSoftVL',
  },
  {
    id: 'anime4k/Restore/CNNVL',
    name: 'Restore CNN (VL)',
    className: 'CNNVL',
  },
  {
    id: 'anime4k/Restore/CNNUL',
    name: 'Restore CNN (UL)',
    className: 'CNNUL',
  },
  {
    id: 'anime4k/Restore/GANUUL',
    name: 'Restore GAN (UUL)',
    className: 'GANUUL',
  },

  // Upscale Effects
  {
    id: 'anime4k/Upscale/CNNx2M',
    name: 'Upscale CNN x2 (M)',
    className: 'CNNx2M',
    upscaleFactor: 2,
  },
  {
    id: 'anime4k/Upscale/CNNx2VL',
    name: 'Upscale CNN x2 (VL)',
    className: 'CNNx2VL',
    upscaleFactor: 2,
  },
  {
    id: 'anime4k/Upscale/DenoiseCNNx2VL',
    name: 'Upscale & Denoise CNN x2 (VL)',
    className: 'DenoiseCNNx2VL',
    upscaleFactor: 2,
  },
  {
    id: 'anime4k/Upscale/CNNx2UL',
    name: 'Upscale CNN x2 (UL)',
    className: 'CNNx2UL',
    upscaleFactor: 2,
  },
  {
    id: 'anime4k/Upscale/GANx3L',
    name: 'Upscale GAN x3 (L)',
    className: 'GANx3L',
    upscaleFactor: 3,
  },
  {
    id: 'anime4k/Upscale/GANx4UUL',
    name: 'Upscale GAN x4 (UUL)',
    className: 'GANx4UUL',
    upscaleFactor: 4,
  },
];