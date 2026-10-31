/**
 * Catalog composition guard.
 *
 * `anime4kEffectDescriptors` from the dependency-free
 * `anime4k-webgpu-async/engines/anime4k/catalog` subpath is now the single
 * source of truth for the 15 Anime4K descriptors, so there is no extension-side
 * mirror left to drift. This test pins the composed seam catalog instead: 18
 * descriptors in registration order (15 library + 3 extension-owned core) with
 * the expected ids and metadata.
 */
import { describe, it, expect } from 'vitest';
import { anime4kEffectDescriptors } from 'anime4k-webgpu-async/engines/anime4k/catalog';
import { coreEffectDescriptors, extensionEffectDescriptors } from './descriptors';

/** Exact expected id order of the composed 18-descriptor seam catalog. */
const EXPECTED_IDS = [
  // 15 Anime4K descriptors (library catalog, ascending registration order)
  'anime4k/Helper/ClampHighlights',
  'anime4k/Deblur/DoG',
  'anime4k/Denoise/BilateralMean',
  'anime4k/Restore/CNNM',
  'anime4k/Restore/CNNSoftM',
  'anime4k/Restore/CNNSoftVL',
  'anime4k/Restore/CNNVL',
  'anime4k/Restore/CNNUL',
  'anime4k/Restore/GANUUL',
  'anime4k/Upscale/CNNx2M',
  'anime4k/Upscale/CNNx2VL',
  'anime4k/Upscale/DenoiseCNNx2VL',
  'anime4k/Upscale/CNNx2UL',
  'anime4k/Upscale/GANx3L',
  'anime4k/Upscale/GANx4UUL',
  // 3 extension-owned core descriptors
  'anime4k/Sharpen/CAS',
  'anime4k/Debanding/Debanding',
  'anime4k/ColorGrading/ColorAdjust',
] as const;

describe('extensionEffectDescriptors composition', () => {
  it('has 18 descriptors in the expected registration order', () => {
    expect(extensionEffectDescriptors).toHaveLength(18);
    expect(extensionEffectDescriptors.map((descriptor) => descriptor.id)).toEqual(EXPECTED_IDS);
  });

  it('starts with the 15 library Anime4K descriptors, with only DoG/BilateralMean schemas overlaid', () => {
    expect(anime4kEffectDescriptors).toHaveLength(15);
    const overlaid = extensionEffectDescriptors.slice(0, 15);

    // Order is preserved; every descriptor is byte-identical except the two
    // library effects whose paramsSchema is supplied extension-side.
    expect(overlaid.map((descriptor) => descriptor.id)).toEqual(
      anime4kEffectDescriptors.map((descriptor) => descriptor.id),
    );

    const overlaidIds = new Set(['anime4k/Deblur/DoG', 'anime4k/Denoise/BilateralMean']);
    anime4kEffectDescriptors.forEach((base, index) => {
      const composed = overlaid[index];
      if (overlaidIds.has(base.id)) {
        expect(composed.paramsSchema).toBeDefined();
        const { paramsSchema: _baseSchema, ...baseRest } = base;
        const { paramsSchema: _composedSchema, ...composedRest } = composed;
        expect(composedRest).toEqual(baseRest);
      } else {
        expect(composed).toEqual(base);
      }
    });
  });

  it('appends exactly the 3 extension-owned core descriptors', () => {
    expect(coreEffectDescriptors).toHaveLength(3);
    expect(extensionEffectDescriptors.slice(15)).toEqual(coreEffectDescriptors);
  });

  it('classifies exactly the Restore catalog descriptors as category "restore"', () => {
    // The restore rule in `effect-chain` keys off `category === 'restore'`, so a
    // catalog category regression must fail here directly. The catalog currently
    // defines six Restore/* descriptors.
    const expectedRestoreIds = [
      'anime4k/Restore/CNNM',
      'anime4k/Restore/CNNSoftM',
      'anime4k/Restore/CNNSoftVL',
      'anime4k/Restore/CNNVL',
      'anime4k/Restore/CNNUL',
      'anime4k/Restore/GANUUL',
    ];
    expect(
      extensionEffectDescriptors.filter((d) => d.category === 'restore').map((d) => d.id),
    ).toEqual(expectedRestoreIds);
    // And no non-Restore descriptor is mislabeled as a restore.
    expect(
      extensionEffectDescriptors
        .filter((d) => d.id.startsWith('anime4k/Restore/'))
        .every((d) => d.category === 'restore'),
    ).toBe(true);
  });

  it('keeps backend ownership intact (anime4k first, then core)', () => {
    expect(extensionEffectDescriptors.slice(0, 15).every((d) => d.backendId === 'anime4k')).toBe(
      true,
    );
    expect(extensionEffectDescriptors.slice(15).every((d) => d.backendId === 'core')).toBe(true);
  });

  it('supplies the DoG / BilateralMean paramsSchema overlays', () => {
    const dog = extensionEffectDescriptors.find((d) => d.id === 'anime4k/Deblur/DoG');
    expect(dog?.paramsSchema).toEqual({
      strength: {
        type: 'number',
        min: 1,
        max: 10,
        step: 0.1,
        defaultValue: 4,
        labelKey: 'strength',
        labelFallback: 'Strength',
      },
    });

    const bilateral = extensionEffectDescriptors.find(
      (d) => d.id === 'anime4k/Denoise/BilateralMean',
    );
    expect(bilateral?.paramsSchema).toEqual({
      strength: {
        type: 'number',
        min: 0,
        max: 1,
        step: 0.01,
        defaultValue: 0.2,
        labelKey: 'intensitySigma',
        labelFallback: 'Intensity σ',
      },
      strength2: {
        type: 'number',
        min: 0.5,
        max: 5,
        step: 0.1,
        defaultValue: 2,
        labelKey: 'spatialSigma',
        labelFallback: 'Spatial σ',
      },
    });
  });
});
