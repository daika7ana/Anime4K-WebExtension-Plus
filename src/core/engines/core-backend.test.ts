/**
 * Tests for the extension-owned core backend (CAS / Debanding / ColorAdjust).
 *
 * Param-schema bounds/defaults are asserted against the values registered in
 * `src/ui/options/param-sliders.ts` and `src/utils/validation.ts`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installGPUMock, removeGPUMock, createMockGPUTexture } from '@/test/webgpu-mock';
import type { MockGPUObjects } from '@/test/webgpu-mock';
import type { CompileEffectContext } from 'anime4k-webgpu-async';

// ─── Mock WGSL shader files ───
vi.mock('@shaders/cas.wgsl', () => ({ default: '// mock CAS shader' }));
vi.mock('@shaders/debanding.wgsl', () => ({ default: '// mock debanding shader' }));
vi.mock('@shaders/color-adjust.wgsl', () => ({ default: '// mock color-adjust shader' }));

import { coreEffectDescriptors, createCoreBackend } from './core-backend';

function descriptorByKey(key: string) {
  const descriptor = coreEffectDescriptors.find((d) => d.key === key);
  expect(descriptor, `missing core descriptor for key "${key}"`).toBeDefined();
  return descriptor!;
}

describe('coreEffectDescriptors', () => {
  it('exposes exactly the three core effects with the legacy ids', () => {
    expect(coreEffectDescriptors.map((d) => d.id)).toEqual([
      'anime4k/Sharpen/CAS',
      'anime4k/Debanding/Debanding',
      'anime4k/ColorGrading/ColorAdjust',
    ]);
    for (const descriptor of coreEffectDescriptors) {
      expect(descriptor.backendId).toBe('core');
      expect(descriptor.dimensionBehavior).toEqual({ kind: 'same' });
    }
  });

  it('CAS mirrors the param-sliders/validation bounds', () => {
    const descriptor = descriptorByKey('CAS');
    expect(descriptor.category).toBe('sharpen');
    expect(descriptor.hidden).toBeUndefined();
    expect(descriptor.paramsSchema?.sharpness).toEqual({
      type: 'number',
      min: 0,
      max: 1,
      step: 0.01,
      defaultValue: 0.5,
      labelKey: 'sharpness',
      labelFallback: 'Sharpness',
    });
  });

  it('Debanding mirrors the param-sliders/validation bounds', () => {
    const descriptor = descriptorByKey('Debanding');
    expect(descriptor.category).toBe('deband');
    expect(descriptor.hidden).toBeUndefined();
    expect(descriptor.paramsSchema?.strength).toEqual({
      type: 'number',
      min: 0,
      max: 1,
      step: 0.01,
      defaultValue: 0.5,
      labelKey: 'debandingStrength',
      labelFallback: 'Debanding',
    });
    expect(descriptor.paramsSchema?.bandThreshold).toEqual({
      type: 'number',
      min: 0,
      max: 1,
      step: 0.01,
      defaultValue: 0.08,
      labelKey: 'debandingThreshold',
      labelFallback: 'Threshold',
    });
  });

  it('marks ColorAdjust hidden with the color-grading bounds/defaults', () => {
    const descriptor = descriptorByKey('ColorAdjust');
    expect(descriptor.category).toBe('color');
    expect(descriptor.hidden).toBe(true);

    const schema = descriptor.paramsSchema!;
    expect(schema.brightness).toMatchObject({ min: -1, max: 1, defaultValue: 0 });
    expect(schema.gamma).toMatchObject({ min: 0.1, max: 4, defaultValue: 1 });
    expect(schema.contrast).toMatchObject({ min: 0, max: 2, defaultValue: 1 });
    expect(schema.saturation).toMatchObject({ min: 0, max: 2, defaultValue: 1 });
    expect(schema.vibrance).toMatchObject({ min: -1, max: 1, defaultValue: 0 });
    expect(schema.exposure).toMatchObject({ min: -3, max: 3, defaultValue: 0 });
  });
});

describe('createCoreBackend().compileEffect', () => {
  let gpu: MockGPUObjects;

  beforeEach(() => {
    gpu = installGPUMock();
  });

  afterEach(() => {
    removeGPUMock();
  });

  function makeContext(
    params?: Record<string, number>,
  ): CompileEffectContext {
    return {
      device: gpu.device as unknown as GPUDevice,
      inputTexture: createMockGPUTexture(64, 48) as unknown as GPUTexture,
      sourceDimensions: { width: 64, height: 48 },
      currentDimensions: { width: 64, height: 48 },
      targetDimensions: { width: 128, height: 96 },
      params,
    };
  }

  it('constructs CAS and reports the core label/output', async () => {
    const backend = createCoreBackend();
    const ctx = makeContext({ sharpness: 0.8 });

    const node = await backend.compileEffect(
      { id: 'anime4k/Sharpen/CAS', backendId: 'core', key: 'CAS', params: { sharpness: 0.8 } },
      ctx,
    );

    expect(node.profileLabel).toBe('CAS');
    expect(node.pipeline.getOutputTexture()).toBe(node.outputTexture);
    expect(node.outputDimensions).toEqual(ctx.currentDimensions);
    // The descriptor builder propagated the supplied sharpness into the shader.
    const written = gpu.device.queue.writeBuffer.mock.calls[0]?.[2] as Float32Array;
    expect(written[0]).toBeCloseTo(0.8, 5);
  });

  it('constructs Debanding and reports the core label/output', async () => {
    const backend = createCoreBackend();
    const ctx = makeContext({ strength: 0.4, bandThreshold: 0.1 });

    const node = await backend.compileEffect(
      {
        id: 'anime4k/Debanding/Debanding',
        backendId: 'core',
        key: 'Debanding',
        params: { strength: 0.4, bandThreshold: 0.1 },
      },
      ctx,
    );

    expect(node.profileLabel).toBe('Debanding');
    expect(node.pipeline.getOutputTexture()).toBe(node.outputTexture);
    expect(node.outputDimensions).toEqual(ctx.currentDimensions);
    const written = gpu.device.queue.writeBuffer.mock.calls[0]?.[2] as Float32Array;
    expect(written[0]).toBeCloseTo(0.4, 5);
    expect(written[1]).toBeCloseTo(0.1, 5);
  });

  it('constructs the hidden ColorAdjust effect and reports the core label/output', async () => {
    const backend = createCoreBackend();
    const ctx = makeContext({ brightness: 0.25, gamma: 1.2 });

    const node = await backend.compileEffect(
      {
        id: 'anime4k/ColorGrading/ColorAdjust',
        backendId: 'core',
        key: 'ColorAdjust',
        params: { brightness: 0.25, gamma: 1.2 },
      },
      ctx,
    );

    expect(node.profileLabel).toBe('ColorAdjust');
    expect(node.pipeline.getOutputTexture()).toBe(node.outputTexture);
    expect(node.outputDimensions).toEqual(ctx.currentDimensions);
    // vec4<f32>: brightness, gamma, contrast, vibrance.
    const primary = gpu.device.queue.writeBuffer.mock.calls[0]?.[2] as Float32Array;
    expect(primary[0]).toBeCloseTo(0.25, 5);
    expect(primary[1]).toBeCloseTo(1.2, 5);
    expect(primary[2]).toBeCloseTo(1, 5);
    expect(primary[3]).toBeCloseTo(0, 5);
    // vec2<f32>: saturation, exposure default when not supplied.
    const secondary = gpu.device.queue.writeBuffer.mock.calls[1]?.[2] as Float32Array;
    expect(secondary[0]).toBeCloseTo(1, 5);
    expect(secondary[1]).toBeCloseTo(0, 5);
  });

  it('applies CAS descriptor defaults when params are absent', async () => {
    const backend = createCoreBackend();
    const node = await backend.compileEffect(
      { id: 'anime4k/Sharpen/CAS', backendId: 'core', key: 'CAS' },
      makeContext(),
    );

    expect(node.profileLabel).toBe('CAS');
    const written = gpu.device.queue.writeBuffer.mock.calls[0]?.[2] as Float32Array;
    expect(written[0]).toBeCloseTo(0.5, 5);
  });

  it('applies Debanding descriptor defaults when params are absent', async () => {
    const backend = createCoreBackend();
    const node = await backend.compileEffect(
      { id: 'anime4k/Debanding/Debanding', backendId: 'core', key: 'Debanding' },
      makeContext(),
    );

    expect(node.profileLabel).toBe('Debanding');
    const written = gpu.device.queue.writeBuffer.mock.calls[0]?.[2] as Float32Array;
    expect(written[0]).toBeCloseTo(0.5, 5);
    expect(written[1]).toBeCloseTo(0.08, 5);
  });

  it('applies ColorAdjust descriptor defaults when params are absent', async () => {
    const backend = createCoreBackend();
    const node = await backend.compileEffect(
      { id: 'anime4k/ColorGrading/ColorAdjust', backendId: 'core', key: 'ColorAdjust' },
      makeContext(),
    );

    expect(node.profileLabel).toBe('ColorAdjust');
    // vec4<f32>: brightness, gamma, contrast, vibrance.
    const primary = gpu.device.queue.writeBuffer.mock.calls[0]?.[2] as Float32Array;
    expect(Array.from(primary)).toEqual([0, 1, 1, 0]);
    // vec2<f32>: saturation, exposure.
    const secondary = gpu.device.queue.writeBuffer.mock.calls[1]?.[2] as Float32Array;
    expect(Array.from(secondary)).toEqual([1, 0]);
  });

  it('throws a clear error for an unknown key', async () => {
    const backend = createCoreBackend();
    const ctx = makeContext();

    await expect(
      backend.compileEffect({ id: 'core/Nope', backendId: 'core', key: 'Nope' }, ctx),
    ).rejects.toThrow(/Unknown effect key "Nope"/);
  });
});
