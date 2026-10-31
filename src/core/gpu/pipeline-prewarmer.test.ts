/**
 * Tests for PipelinePreWarmer — engine-agnostic, callback-driven shader pre-warming.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installGPUMock, removeGPUMock } from '@/test/webgpu-mock';
import type { MockGPUObjects } from '@/test/webgpu-mock';
import type { DestroyablePipeline } from '@/types';

// ─── Mock yieldToMain ───
vi.mock('@core/utils/yield-utils', () => ({
  yieldToMain: vi.fn().mockResolvedValue(undefined),
}));

import { PipelinePreWarmer } from './pipeline-prewarmer';
import type { PreWarmTarget, PreWarmEffectRef, CompileDummy } from './pipeline-prewarmer';
import { yieldToMain } from '@core/utils/yield-utils';

// ─── Helpers ───

function target(
  className: string,
  opts?: {
    backendId?: string;
    key?: string;
    prewarmable?: boolean;
    loadsAssets?: boolean;
  },
): PreWarmTarget {
  const result: PreWarmTarget = {
    ref: { backendId: opts?.backendId, key: opts?.key ?? className, className },
  };
  if (opts && (opts.prewarmable !== undefined || opts.loadsAssets !== undefined)) {
    result.capabilities = {
      prewarmable: opts.prewarmable,
      loadsAssets: opts.loadsAssets,
    };
  }
  return result;
}

function makeDummy(onDestroy?: () => void): DestroyablePipeline {
  return {
    pass: () => Promise.resolve(),
    getOutputTexture: () => ({ destroy: vi.fn() } as unknown as GPUTexture),
    updateParam: () => {},
    destroy: () => onDestroy?.(),
  };
}

describe('PipelinePreWarmer', () => {
  let mock: MockGPUObjects;
  let prewarmer: PipelinePreWarmer;

  beforeEach(() => {
    mock = installGPUMock();
    prewarmer = new PipelinePreWarmer();
  });

  afterEach(() => {
    removeGPUMock();
  });

  // ── Deduplication by engine identity ──

  it('deduplicates: second warm of the same engine-identity chain returns immediately', async () => {
    const device = mock.device as unknown as GPUDevice;
    const targets = [target('DoG', { backendId: 'anime4k', key: 'DoG' })];
    const compile: CompileDummy = () => makeDummy();

    await prewarmer.warm(device, targets, compile);
    const callCountAfterFirst = mock.device.createTexture.mock.calls.length;

    await prewarmer.warm(device, targets, compile);
    expect(mock.device.createTexture).toHaveBeenCalledTimes(callCountAfterFirst);
  });

  it('warms again when the chain changes', async () => {
    const device = mock.device as unknown as GPUDevice;
    const compile: CompileDummy = () => makeDummy();

    await prewarmer.warm(device, [target('DoG', { backendId: 'anime4k', key: 'DoG' })], compile);
    const callsAfterFirst = mock.device.createTexture.mock.calls.length;

    await prewarmer.warm(device, [target('CNNM', { backendId: 'anime4k', key: 'CNNM' })], compile);
    expect(mock.device.createTexture.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it('builds the dedupe key from backendId:key when resolvable', async () => {
    const device = mock.device as unknown as GPUDevice;
    const compile: CompileDummy = () => makeDummy();

    // Same className, different engine identity → distinct signatures → re-warm.
    await prewarmer.warm(device, [target('Shared', { backendId: 'anime4k', key: 'CNNM' })], compile);
    const afterFirst = mock.device.createTexture.mock.calls.length;

    await prewarmer.warm(device, [target('Shared', { backendId: 'core', key: 'CAS' })], compile);
    expect(mock.device.createTexture.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it('dedupes on backendId:key even when className differs', async () => {
    const device = mock.device as unknown as GPUDevice;
    const compile: CompileDummy = () => makeDummy();

    await prewarmer.warm(device, [target('Alpha', { backendId: 'anime4k', key: 'CNNM' })], compile);
    const afterFirst = mock.device.createTexture.mock.calls.length;

    // Same `anime4k:CNNM` identity with a different display className → same signature.
    await prewarmer.warm(device, [target('Beta', { backendId: 'anime4k', key: 'CNNM' })], compile);
    expect(mock.device.createTexture).toHaveBeenCalledTimes(afterFirst);
  });

  it('falls back to className in the dedupe key when no backendId is present', async () => {
    const device = mock.device as unknown as GPUDevice;
    const constructed: string[] = [];
    const compile: CompileDummy = (ref) => {
      constructed.push(ref.className);
      return makeDummy();
    };

    await prewarmer.warm(device, [target('LegacyDoG')], compile);
    const afterFirst = constructed.length;

    // Same className, no backendId → same signature → skipped.
    await prewarmer.warm(device, [target('LegacyDoG')], compile);
    expect(constructed.length).toBe(afterFirst);
  });

  // ── Dummy texture creation ──

  it('creates a 1×1 texture with correct format and usage', async () => {
    const device = mock.device as unknown as GPUDevice;
    await prewarmer.warm(device, [target('DoG')], () => makeDummy());

    expect(mock.device.createTexture).toHaveBeenCalled();
    const callArg = mock.device.createTexture.mock.calls[0][0];
    expect(callArg.size).toEqual([1, 1]);
    expect(callArg.format).toBe('rgba8unorm');
    // usage: TEXTURE_BINDING | COPY_DST | RENDER_ATTACHMENT | STORAGE_BINDING = 1 | 2 | 4 | 8 = 15
    expect(callArg.usage).toBe(15);
  });

  // ── Callback-driven compilation (both modes) ──

  it('drives the callback for a legacy (no backendId) target', async () => {
    const device = mock.device as unknown as GPUDevice;
    const seen: PreWarmEffectRef[] = [];
    const textures: GPUTexture[] = [];

    await prewarmer.warm(
      device,
      [target('DoG')],
      (ref, dev, tex) => {
        seen.push(ref);
        textures.push(tex);
        return makeDummy();
      },
    );

    expect(seen).toEqual([{ backendId: undefined, key: 'DoG', className: 'DoG' }]);
    expect(textures).toHaveLength(1);
    expect(textures[0]).toBe(mock.device.createTexture.mock.results[0].value);
  });

  it('drives the callback for a registry (backendId + key) target', async () => {
    const device = mock.device as unknown as GPUDevice;
    const seen: PreWarmEffectRef[] = [];

    await prewarmer.warm(
      device,
      [target('CAS', { backendId: 'core', key: 'CAS' })],
      (ref) => {
        seen.push(ref);
        return makeDummy();
      },
    );

    expect(seen).toEqual([{ backendId: 'core', key: 'CAS', className: 'CAS' }]);
  });

  it('supports an async compileDummy callback', async () => {
    const device = mock.device as unknown as GPUDevice;
    const destroyed: string[] = [];

    await prewarmer.warm(
      device,
      [target('CNNM', { backendId: 'anime4k', key: 'CNNM' })],
      async () => makeDummy(() => destroyed.push('CNNM')),
    );

    expect(destroyed).toEqual(['CNNM']);
  });

  it('destroys each constructed dummy pipeline', async () => {
    const device = mock.device as unknown as GPUDevice;
    const destroyed: string[] = [];

    await prewarmer.warm(
      device,
      [target('A'), target('B')],
      (ref) => makeDummy(() => destroyed.push(ref.className)),
    );

    expect(destroyed).toEqual(['A', 'B']);
  });

  it('treats a null callback result as "nothing to warm"', async () => {
    const device = mock.device as unknown as GPUDevice;
    await expect(
      prewarmer.warm(device, [target('Unknown')], () => null),
    ).resolves.toBeUndefined();
  });

  // ── Capability gating ──

  it('skips effects with prewarmable === false', async () => {
    const device = mock.device as unknown as GPUDevice;
    const compile = vi.fn(() => makeDummy());

    await prewarmer.warm(device, [target('Asset', { prewarmable: false })], compile);

    expect(compile).not.toHaveBeenCalled();
    // A dummy texture is still created for the warm pass.
    expect(mock.device.createTexture).toHaveBeenCalled();
  });

  it('skips effects with loadsAssets === true', async () => {
    const device = mock.device as unknown as GPUDevice;
    const compile = vi.fn(() => makeDummy());

    await prewarmer.warm(device, [target('Asset', { loadsAssets: true })], compile);

    expect(compile).not.toHaveBeenCalled();
  });

  it('warms effects whose capabilities allow it', async () => {
    const device = mock.device as unknown as GPUDevice;
    const compile = vi.fn(() => makeDummy());

    await prewarmer.warm(
      device,
      [target('Fast', { prewarmable: true, loadsAssets: false })],
      compile,
    );

    expect(compile).toHaveBeenCalledTimes(1);
  });

  it('skips only the gated effect in a mixed chain', async () => {
    const device = mock.device as unknown as GPUDevice;
    const compiled: string[] = [];

    await prewarmer.warm(
      device,
      [
        target('Keep', { backendId: 'anime4k', key: 'CNNM' }),
        target('Skip', { backendId: 'artcnn', key: 'C4F16', loadsAssets: true }),
        target('AlsoKeep', { backendId: 'core', key: 'CAS' }),
      ],
      (ref) => {
        compiled.push(ref.key);
        return makeDummy();
      },
    );

    expect(compiled).toEqual(['CNNM', 'CAS']);
  });

  // ── Invalidate clears cache ──

  it('invalidate() clears the warm cache', async () => {
    const device = mock.device as unknown as GPUDevice;
    const targets = [target('DoG', { backendId: 'anime4k', key: 'DoG' })];
    const compile: CompileDummy = () => makeDummy();

    await prewarmer.warm(device, targets, compile);
    const callsAfterFirst = mock.device.createTexture.mock.calls.length;

    prewarmer.invalidate();

    await prewarmer.warm(device, targets, compile);
    expect(mock.device.createTexture.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  // ── Cancellation on supersede ──

  it('cancels in-progress warm when superseded by a new warm() call', async () => {
    const device = mock.device as unknown as GPUDevice;

    const warm1 = prewarmer.warm(
      device,
      [target('CNNM', { backendId: 'anime4k', key: 'CNNM' })],
      () => makeDummy(),
    );
    const warm2 = prewarmer.warm(
      device,
      [target('DoG', { backendId: 'anime4k', key: 'DoG' })],
      () => makeDummy(),
    );

    await Promise.all([warm1, warm2]);
    // Both resolve without error; the first may have been cancelled mid-way.
  });

  // ── Yield between pipelines ──

  it('yields to main thread after each effect', async () => {
    const device = mock.device as unknown as GPUDevice;
    vi.mocked(yieldToMain).mockClear();

    await prewarmer.warm(device, [target('A'), target('B')], () => makeDummy());

    expect(yieldToMain).toHaveBeenCalledTimes(2);
  });

  // ── Error isolation ──

  it('continues to the next effect when one callback throws', async () => {
    const device = mock.device as unknown as GPUDevice;
    const compiled: string[] = [];

    await prewarmer.warm(
      device,
      [target('Bad'), target('Good')],
      (ref) => {
        if (ref.className === 'Bad') throw new Error('Boom!');
        compiled.push(ref.className);
        return makeDummy();
      },
    );

    expect(compiled).toEqual(['Good']);
  });

  it('completes even when all callbacks throw', async () => {
    const device = mock.device as unknown as GPUDevice;
    await expect(
      prewarmer.warm(device, [target('Boom1'), target('Boom2')], () => {
        throw new Error('Boom!');
      }),
    ).resolves.toBeUndefined();
  });
});
