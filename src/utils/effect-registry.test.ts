/**
 * Tests for the effect reference resolution / normalization layer.
 */
import { describe, it, expect } from 'vitest';
import type { EffectDescriptor } from 'anime4k-webgpu-async';
import {
  descriptorToLegacyEffect,
  getEffectDescriptorById,
  listEffectDescriptors,
  resolveEffectReference,
} from './effect-registry';

function expectResolved(idOrEffect: Parameters<typeof resolveEffectReference>[0]) {
  const result = resolveEffectReference(idOrEffect);
  expect(result.status).toBe('resolved');
  if (result.status !== 'resolved') throw new Error('unreachable');
  return result.effect;
}

describe('resolveEffectReference', () => {
  it('resolves by exact id (anime4k and core ids)', () => {
    const anime4k = expectResolved({
      id: 'anime4k/Restore/CNNVL',
      name: 'Restore CNN (VL)',
      className: 'CNNVL',
    });
    expect(anime4k.descriptor.id).toBe('anime4k/Restore/CNNVL');
    expect(anime4k.descriptor.backendId).toBe('anime4k');
    expect(anime4k.reference).toMatchObject({
      id: 'anime4k/Restore/CNNVL',
      backendId: 'anime4k',
      key: 'CNNVL',
    });

    const core = expectResolved({
      id: 'anime4k/Sharpen/CAS',
      name: 'Contrast Adaptive Sharpening (CAS)',
      className: 'CAS',
      params: { sharpness: 0.3 },
    });
    expect(core.descriptor.backendId).toBe('core');
    expect(core.reference.params).toEqual({ sharpness: 0.3 });
  });

  it('resolves by backendId + key pair', () => {
    const resolved = expectResolved({
      id: 'opaque/persisted/id',
      name: 'Anything',
      className: 'not-the-key',
      backendId: 'core',
      key: 'CAS',
    });

    expect(resolved.descriptor.id).toBe('anime4k/Sharpen/CAS');
    expect(resolved.reference).toMatchObject({ backendId: 'core', key: 'CAS' });
  });

  it('defaults a missing key to className for the backendId + key lookup', () => {
    const resolved = expectResolved({
      id: 'opaque/persisted/id',
      name: 'Anything',
      className: 'CAS',
      backendId: 'core',
    });

    expect(resolved.descriptor.id).toBe('anime4k/Sharpen/CAS');
  });

  it('resolves a legacy className through the anime4k backend key', () => {
    const resolved = expectResolved({
      id: 'legacy/unknown-id',
      name: 'Upscale CNN x2 (VL)',
      className: 'CNNx2VL',
    });

    expect(resolved.descriptor.id).toBe('anime4k/Upscale/CNNx2VL');
    expect(resolved.descriptor.backendId).toBe('anime4k');
  });

  it('resolves a legacy className through the core alias table', () => {
    const resolved = expectResolved({
      id: 'legacy/unknown-id',
      name: 'Debanding',
      className: 'Debanding',
    });

    expect(resolved.descriptor.id).toBe('anime4k/Debanding/Debanding');
    expect(resolved.descriptor.backendId).toBe('core');
  });

  it('preserves a well-formed new-style reference that resolves to nothing', () => {
    const result = resolveEffectReference({
      id: 'artcnn/ArtCNN/C4F16',
      name: 'ArtCNN C4F16',
      className: 'C4F16',
      backendId: 'artcnn',
      key: 'C4F16',
      params: { variant: 1 },
    });

    expect(result.status).toBe('unresolved');
    if (result.status !== 'unresolved') throw new Error('unreachable');
    expect(result.reference).toEqual({
      id: 'artcnn/ArtCNN/C4F16',
      backendId: 'artcnn',
      key: 'C4F16',
      params: { variant: 1 },
    });
  });

  it('returns unknown for a legacy entry with unknown id and className', () => {
    expect(
      resolveEffectReference({ id: 'nope/does/not/exist', name: 'Nope', className: 'Nope' }),
    ).toEqual({ status: 'unknown' });
  });

  // PRE-3: the className alias lookup must be prototype-safe. A plain-object
  // table would return inherited `Object.prototype` members (truthy functions /
  // objects) for these names instead of `undefined`.
  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
    'does not consult Object.prototype for className %s',
    (className) => {
      // Legacy entry (no backendId): unknown id + unknown className → unknown.
      const legacy = resolveEffectReference({
        id: 'legacy/unknown-id',
        name: 'Prototype probe',
        className,
      });
      expect(legacy.status).toBe('unknown');

      // New-style entry: the same className must not be taken as a core alias,
      // so it is preserved as `unresolved`.
      const newStyle = resolveEffectReference({
        id: 'probe/Prototype/Probe',
        name: 'Prototype probe',
        className,
        backendId: 'probe',
        key: className,
      });
      expect(newStyle.status).toBe('unresolved');
      if (newStyle.status !== 'unresolved') throw new Error('unreachable');
      expect(newStyle.reference).toEqual({
        id: 'probe/Prototype/Probe',
        backendId: 'probe',
        key: className,
      });
    },
  );
});

describe('descriptorToLegacyEffect', () => {
  it('round-trips id/name/className/key/backendId and omits upscaleFactor for same-size effects', () => {
    const descriptor = getEffectDescriptorById('anime4k/Restore/CNNVL')!;
    expect(descriptorToLegacyEffect(descriptor)).toEqual({
      id: 'anime4k/Restore/CNNVL',
      name: 'Restore CNN (VL)',
      className: 'CNNVL',
      backendId: 'anime4k',
      key: 'CNNVL',
    });
  });

  const scaleCases: Array<[string, number]> = [
    ['anime4k/Upscale/CNNx2VL', 2],
    ['anime4k/Upscale/GANx3L', 3],
    ['anime4k/Upscale/GANx4UUL', 4],
  ];

  for (const [id, scale] of scaleCases) {
    it(`round-trips scale descriptor ${id} → ${scale}`, () => {
      const descriptor = getEffectDescriptorById(id)!;
      const legacy = descriptorToLegacyEffect(descriptor);

      expect(legacy.id).toBe(id);
      expect(legacy.className).toBe(descriptor.key);
      expect(legacy.key).toBe(descriptor.key);
      expect(legacy.upscaleFactor).toBe(scale);
    });
  }
});

describe('catalog helpers', () => {
  it('includes hidden ColorAdjust only when includeHidden is set', () => {
    const visibleIds = listEffectDescriptors().map((d) => d.id);
    expect(visibleIds).not.toContain('anime4k/ColorGrading/ColorAdjust');
    expect(visibleIds).toHaveLength(17);

    const allIds = listEffectDescriptors({ includeHidden: true }).map((d) => d.id);
    expect(allIds).toContain('anime4k/ColorGrading/ColorAdjust');
    expect(allIds).toHaveLength(18);
  });

  it('returns descriptors by id', () => {
    expect(getEffectDescriptorById('anime4k/Debanding/Debanding')?.backendId).toBe('core');
    expect(getEffectDescriptorById('artcnn/ArtCNN/C4F16')).toBeUndefined();
  });

  it('exposes a stable static descriptor list (no runtime registry)', () => {
    expect(listEffectDescriptors({ includeHidden: true })).toBe(
      listEffectDescriptors({ includeHidden: true }),
    );
  });

  it('exposes descriptors typed as the library contract', () => {
    const descriptor: EffectDescriptor = listEffectDescriptors()[0]!;
    expect(typeof descriptor.id).toBe('string');
    expect(typeof descriptor.backendId).toBe('string');
  });
});
