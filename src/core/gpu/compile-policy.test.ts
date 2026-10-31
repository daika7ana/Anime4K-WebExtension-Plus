/**
 * Tests for the gate wiring in {@link createEffectCompiler}: only resolved
 * restore descriptors are wrapped under the `gate` policy, and the wrapper
 * preserves the node's label/geometry while owning a distinct output texture.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  installGPUMock,
  removeGPUMock,
  createMockGPUTexture,
  type MockGPUObjects,
} from '@/test/webgpu-mock';
import type { EnhancementEffect } from '@/types';
import type { EffectResolution } from '@utils/effect-registry';
import { createEffectCompiler } from './compile-policy';
import { GatedRestore, GATED_RESTORE_DEFAULTS } from '@core/effects/gated-restore';

vi.mock('@shaders/restore-gate.wgsl', () => ({ default: 'mock-restore-gate-shader' }));

/** A fake compiled backend node with a distinguishable output texture. */
function fakeNode() {
  const outputTexture = createMockGPUTexture(16, 16);
  const pipeline = {
    pass: vi.fn().mockResolvedValue(undefined),
    getOutputTexture: vi.fn(() => outputTexture),
    updateParam: vi.fn(),
    destroy: vi.fn(),
  };
  return {
    outputTexture,
    pipeline,
    node: {
      pipeline,
      outputTexture,
      outputDimensions: { width: 16, height: 16 },
      profileLabel: 'RestoreCNN',
    },
  };
}

function resolved(
  backendId: string,
  key: string,
  category: string,
): EffectResolution {
  return {
    status: 'resolved',
    effect: {
      descriptor: {
        id: `${backendId}/${key}`,
        backendId,
        key,
        category,
        dimensionBehavior: { kind: 'identity' },
        capabilities: {},
      },
      reference: { id: `${backendId}/${key}`, backendId, key },
    },
  } as unknown as EffectResolution;
}

const EFFECT: EnhancementEffect = {
  id: 'anime4k/Restore/CNNUL',
  name: 'Restore CNN (UL)',
  className: 'CNNUL',
};

describe('createEffectCompiler gating', () => {
  let mock: MockGPUObjects;
  let inputTexture: ReturnType<typeof createMockGPUTexture>;

  beforeEach(() => {
    mock = installGPUMock();
    inputTexture = createMockGPUTexture(16, 16);
  });

  afterEach(() => {
    removeGPUMock();
  });

  function compilerFor(
    resolutions: EffectResolution[],
    node: unknown,
    gating: typeof GATED_RESTORE_DEFAULTS | null,
  ) {
    const registry = {
      getBackendAsync: vi.fn().mockResolvedValue({
        compileEffect: vi.fn().mockResolvedValue(node),
      }),
    };
    return createEffectCompiler({
      device: mock.device as unknown as GPUDevice,
      registry: registry as never,
      resolutions,
      sourceDimensions: { width: 16, height: 16 },
      isStale: () => false,
      gating,
      logging: { registryFailure: vi.fn(), skipped: vi.fn() },
    });
  }

  const compileArgs = () => ({
    effect: EFFECT,
    index: 0,
    inputTexture: inputTexture as unknown as GPUTexture,
    currentDimensions: { width: 16, height: 16 },
    targetDimensions: { width: 16, height: 16 },
  });

  it('returns the backend node unchanged when gating is null', async () => {
    const { node, pipeline } = fakeNode();
    const compile = compilerFor([resolved('anime4k', 'CNNUL', 'restore')], node, null);

    const step = await compile(compileArgs());

    expect(step).not.toBeNull();
    expect(step!.pipeline).toBe(pipeline);
    expect(step!.label).toBe('RestoreCNN');
  });

  it('wraps a resolved restore node when gating is set', async () => {
    const { node, pipeline, outputTexture } = fakeNode();
    const compile = compilerFor(
      [resolved('anime4k', 'CNNUL', 'restore')],
      node,
      GATED_RESTORE_DEFAULTS,
    );

    const step = await compile(compileArgs());

    expect(step).not.toBeNull();
    expect(step!.pipeline).toBeInstanceOf(GatedRestore);
    expect(step!.pipeline).not.toBe(pipeline);
    // Label/geometry are preserved from the inner node.
    expect(step!.label).toBe('RestoreCNN');
    expect(step!.postDimensions).toEqual({ width: 16, height: 16 });
    // The wrapper owns a distinct output texture.
    expect(step!.pipeline.getOutputTexture()).not.toBe(outputTexture);

    // `pass` delegates to the inner restore before gating.
    const encoder = { beginComputePass: vi.fn(() => ({
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      dispatchWorkgroups: vi.fn(),
      end: vi.fn(),
    })) } as unknown as GPUCommandEncoder;
    await step!.pipeline.pass(encoder);
    expect(pipeline.pass).toHaveBeenCalledTimes(1);
  });

  it('leaves a non-restore node unchanged when gating is set', async () => {
    const { node, pipeline } = fakeNode();
    const compile = compilerFor(
      [resolved('anime4k', 'CNNx2UL', 'upscale')],
      node,
      GATED_RESTORE_DEFAULTS,
    );

    const step = await compile(compileArgs());

    expect(step).not.toBeNull();
    expect(step!.pipeline).toBe(pipeline);
  });
});
