/**
 * Tests for the extension's composed backend registry.
 */
import { describe, it, expect } from 'vitest';
import { createExtensionBackendRegistry } from './registry';

describe('createExtensionBackendRegistry', () => {
  it('lists 18 descriptors (15 anime4k + 3 core)', () => {
    const registry = createExtensionBackendRegistry();
    const all = registry.listEffects({ includeHidden: true });

    expect(all).toHaveLength(18);
    expect(all.filter((d) => d.backendId === 'anime4k')).toHaveLength(15);
    expect(all.filter((d) => d.backendId === 'core')).toHaveLength(3);
  });

  it('registers no duplicate descriptor ids', () => {
    const ids = createExtensionBackendRegistry()
      .listEffects({ includeHidden: true })
      .map((d) => d.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('resolves anime4k/Sharpen/CAS to the core backend', () => {
    const descriptor = createExtensionBackendRegistry()
      .getDescriptorById('anime4k/Sharpen/CAS');

    expect(descriptor).toBeDefined();
    expect(descriptor?.backendId).toBe('core');
    expect(descriptor?.key).toBe('CAS');
  });

  it('does not let the anime4k backend advertise the core effects', () => {
    const anime4k = createExtensionBackendRegistry().getBackend('anime4k');
    expect(anime4k).toBeDefined();

    const keys = anime4k!.listEffects().map((d) => d.key);
    expect(keys).not.toContain('CAS');
    expect(keys).not.toContain('Debanding');
    expect(keys).not.toContain('ColorAdjust');
  });

  it('resolves eagerly-registered backends through getBackendAsync', async () => {
    const registry = createExtensionBackendRegistry();

    await expect(registry.getBackendAsync('core')).resolves.toBe(registry.getBackend('core'));
    await expect(registry.getBackendAsync('anime4k')).resolves.toBe(
      registry.getBackend('anime4k'),
    );
  });
});
