import { describe, it, expect } from 'vitest';
import { AVAILABLE_EFFECTS } from './effects-map';
import { resolveEffectReference } from './effect-registry';

describe('AVAILABLE_EFFECTS', () => {
  // ── Catalog size ──────────────────────────────────────────────
  it('has exactly 17 effects in the catalog', () => {
    // 1 CAS + 1 ClampHighlights + 1 Debanding + 1 DoG + 1 BilateralMean
    // + 6 Restore + 6 Upscale = 17
    expect(AVAILABLE_EFFECTS).toHaveLength(17);
  });

  // ── ID uniqueness ─────────────────────────────────────────────
  it('has unique IDs for every effect', () => {
    const ids = AVAILABLE_EFFECTS.map(e => e.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  // ── className uniqueness ──────────────────────────────────────
  it('has unique classNames for every effect', () => {
    const classNames = AVAILABLE_EFFECTS.map(e => e.className);
    const uniqueClassNames = new Set(classNames);
    expect(uniqueClassNames.size).toBe(classNames.length);
  });

  // ── Required fields ───────────────────────────────────────────
  it('every effect has all required fields (id, name, className)', () => {
    for (const effect of AVAILABLE_EFFECTS) {
      expect(effect.id).toBeTruthy();
      expect(effect.name).toBeTruthy();
      expect(effect.className).toBeTruthy();
      expect(typeof effect.id).toBe('string');
      expect(typeof effect.name).toBe('string');
      expect(typeof effect.className).toBe('string');
    }
  });

  // ── Key effects present ───────────────────────────────────────
  describe('key effects exist', () => {
    const findById = (id: string) =>
      AVAILABLE_EFFECTS.find(e => e.id === id);

    it('includes CAS (sharpen)', () => {
      expect(findById('anime4k/Sharpen/CAS')).toBeDefined();
    });

    it('includes ClampHighlights (helper)', () => {
      expect(findById('anime4k/Helper/ClampHighlights')).toBeDefined();
    });

    it('includes Debanding', () => {
      expect(findById('anime4k/Debanding/Debanding')).toBeDefined();
    });

    it('includes DoG (deblur)', () => {
      expect(findById('anime4k/Deblur/DoG')).toBeDefined();
    });

    it('includes BilateralMean (denoise)', () => {
      expect(findById('anime4k/Denoise/BilateralMean')).toBeDefined();
    });

    it('includes all 6 Restore effects', () => {
      const restoreEffects = AVAILABLE_EFFECTS.filter(e => e.id.startsWith('anime4k/Restore/'));
      expect(restoreEffects).toHaveLength(6);
      expect(findById('anime4k/Restore/CNNM')).toBeDefined();
      expect(findById('anime4k/Restore/CNNSoftM')).toBeDefined();
      expect(findById('anime4k/Restore/CNNSoftVL')).toBeDefined();
      expect(findById('anime4k/Restore/CNNVL')).toBeDefined();
      expect(findById('anime4k/Restore/CNNUL')).toBeDefined();
      expect(findById('anime4k/Restore/GANUUL')).toBeDefined();
    });

    it('includes all 6 Upscale effects', () => {
      const upscaleEffects = AVAILABLE_EFFECTS.filter(e => e.id.startsWith('anime4k/Upscale/'));
      expect(upscaleEffects).toHaveLength(6);
      expect(findById('anime4k/Upscale/CNNx2M')).toBeDefined();
      expect(findById('anime4k/Upscale/CNNx2VL')).toBeDefined();
      expect(findById('anime4k/Upscale/DenoiseCNNx2VL')).toBeDefined();
      expect(findById('anime4k/Upscale/CNNx2UL')).toBeDefined();
      expect(findById('anime4k/Upscale/GANx3L')).toBeDefined();
      expect(findById('anime4k/Upscale/GANx4UUL')).toBeDefined();
    });
  });

  // ── Upscale factors ───────────────────────────────────────────
  describe('upscaleFactor', () => {
    it('upscale effects have the correct upscaleFactor', () => {
      const upscaleEffects = AVAILABLE_EFFECTS.filter(e => e.upscaleFactor !== undefined);

      // x2 effects
      for (const e of ['CNNx2M', 'CNNx2VL', 'DenoiseCNNx2VL', 'CNNx2UL']) {
        const effect = upscaleEffects.find(ue => ue.className === e);
        expect(effect).toBeDefined();
        expect(effect!.upscaleFactor).toBe(2);
      }

      // x3 effect
      const gan3 = upscaleEffects.find(ue => ue.className === 'GANx3L');
      expect(gan3).toBeDefined();
      expect(gan3!.upscaleFactor).toBe(3);

      // x4 effect
      const gan4 = upscaleEffects.find(ue => ue.className === 'GANx4UUL');
      expect(gan4).toBeDefined();
      expect(gan4!.upscaleFactor).toBe(4);
    });

    it('non-upscale effects have no upscaleFactor', () => {
      const nonUpscaleEffects = AVAILABLE_EFFECTS.filter(
        e => !e.id.startsWith('anime4k/Upscale/')
      );
      expect(nonUpscaleEffects.length).toBeGreaterThan(0);
      for (const effect of nonUpscaleEffects) {
        expect(effect.upscaleFactor).toBeUndefined();
      }
    });
  });

  // ── Effect parameter defaults ─────────────────────────────────
  describe('parameter defaults', () => {
    it('CAS has default sharpness of 0.5', () => {
      const cas = AVAILABLE_EFFECTS.find(e => e.className === 'CAS')!;
      expect(cas.params).toBeDefined();
      expect(cas.params!.sharpness).toBe(0.5);
    });

    it('Debanding has default strength of 0.5 and bandThreshold of 0.08', () => {
      const debanding = AVAILABLE_EFFECTS.find(e => e.className === 'Debanding')!;
      expect(debanding.params).toBeDefined();
      expect(debanding.params!.strength).toBe(0.5);
      expect(debanding.params!.bandThreshold).toBe(0.08);
    });

    it('DoG has default strength of 4', () => {
      const dog = AVAILABLE_EFFECTS.find(e => e.className === 'DoG')!;
      expect(dog.params).toBeDefined();
      expect(dog.params!.strength).toBe(4);
    });

    it('BilateralMean has default strength of 0.2 and strength2 of 2', () => {
      const bm = AVAILABLE_EFFECTS.find(e => e.className === 'BilateralMean')!;
      expect(bm.params).toBeDefined();
      expect(bm.params!.strength).toBe(0.2);
      expect(bm.params!.strength2).toBe(2);
    });
  });
});

/**
 * Golden parity: the derived catalog must stay byte-identical to the pre-seam
 * literal in id/name/className/upscaleFactor and order. This is the guard that
 * lets persistence/validation switch to the engine seam without a migration.
 */
describe('AVAILABLE_EFFECTS parity with the engine seam', () => {
  // Frozen expected sequence: [id, name, className].
  const EXPECTED_SEQUENCE: ReadonlyArray<readonly [string, string, string]> = [
    ['anime4k/Sharpen/CAS', 'Contrast Adaptive Sharpening (CAS)', 'CAS'],
    ['anime4k/Helper/ClampHighlights', 'Clamp Highlights', 'ClampHighlights'],
    ['anime4k/Debanding/Debanding', 'Debanding', 'Debanding'],
    ['anime4k/Deblur/DoG', 'Deblur (DoG)', 'DoG'],
    ['anime4k/Denoise/BilateralMean', 'Denoise (Bilateral Mean)', 'BilateralMean'],
    ['anime4k/Restore/CNNM', 'Restore CNN (M)', 'CNNM'],
    ['anime4k/Restore/CNNSoftM', 'Restore CNN Soft (M)', 'CNNSoftM'],
    ['anime4k/Restore/CNNSoftVL', 'Restore CNN Soft (VL)', 'CNNSoftVL'],
    ['anime4k/Restore/CNNVL', 'Restore CNN (VL)', 'CNNVL'],
    ['anime4k/Restore/CNNUL', 'Restore CNN (UL)', 'CNNUL'],
    ['anime4k/Restore/GANUUL', 'Restore GAN (UUL)', 'GANUUL'],
    ['anime4k/Upscale/CNNx2M', 'Upscale CNN x2 (M)', 'CNNx2M'],
    ['anime4k/Upscale/CNNx2VL', 'Upscale CNN x2 (VL)', 'CNNx2VL'],
    ['anime4k/Upscale/DenoiseCNNx2VL', 'Upscale & Denoise CNN x2 (VL)', 'DenoiseCNNx2VL'],
    ['anime4k/Upscale/CNNx2UL', 'Upscale CNN x2 (UL)', 'CNNx2UL'],
    ['anime4k/Upscale/GANx3L', 'Upscale GAN x3 (L)', 'GANx3L'],
    ['anime4k/Upscale/GANx4UUL', 'Upscale GAN x4 (UUL)', 'GANx4UUL'],
  ];

  it('preserves the frozen id/name/className sequence and length', () => {
    expect(AVAILABLE_EFFECTS).toHaveLength(EXPECTED_SEQUENCE.length);
    expect(
      AVAILABLE_EFFECTS.map(e => [e.id, e.name, e.className]),
    ).toEqual(EXPECTED_SEQUENCE.map(e => [...e]));
  });

  it('preserves the frozen upscaleFactor sequence', () => {
    expect(AVAILABLE_EFFECTS.map(e => e.upscaleFactor)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      2,
      2,
      2,
      2,
      3,
      4,
    ]);
  });

  it('resolves every entry through the seam with matching backend metadata', () => {
    for (const effect of AVAILABLE_EFFECTS) {
      const resolution = resolveEffectReference(effect);
      expect(resolution.status).toBe('resolved');
      if (resolution.status !== 'resolved') continue;

      expect(resolution.effect.descriptor.id).toBe(effect.id);
      expect(resolution.effect.descriptor.key).toBe(effect.className);
      expect(effect.backendId).toBe(resolution.effect.descriptor.backendId);
      expect(effect.key).toBe(resolution.effect.descriptor.key);
    }
  });

  it('derives params from descriptor schema or the legacy fallback', () => {
    const paramsById = new Map(AVAILABLE_EFFECTS.map(e => [e.id, e.params]));

    // Schema-backed core descriptors.
    expect(paramsById.get('anime4k/Sharpen/CAS')).toEqual({ sharpness: 0.5 });
    expect(paramsById.get('anime4k/Debanding/Debanding')).toEqual({
      strength: 0.5,
      bandThreshold: 0.08,
    });
    // No-schema library descriptors keep their legacy defaults.
    expect(paramsById.get('anime4k/Deblur/DoG')).toEqual({ strength: 4 });
    expect(paramsById.get('anime4k/Denoise/BilateralMean')).toEqual({
      strength: 0.2,
      strength2: 2,
    });
  });
});
