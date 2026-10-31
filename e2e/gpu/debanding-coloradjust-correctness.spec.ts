import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { referenceCas } from '../../src/core/effects/reference/cas';
import {
  referenceColorAdjust,
  type ColorAdjustParams,
} from '../../src/core/effects/reference/color-adjust';
import { referenceDebanding } from '../../src/core/effects/reference/debanding';
import { compareRgba, formatComparison } from '../../src/core/effects/reference/compare';
import {
  guardGpu,
  startSecureOrigin,
  writeArtifacts,
  type GpuFailure,
  type GpuResult,
} from './downscale-harness';
import { colorSweep, hardEdge, hardGradient, type RgbaImage } from './fixtures-effects';

/**
 * C3 — headless-WebGPU numeric correctness gate for the two remaining
 * extension-owned effects, `src/shaders/debanding.wgsl` and
 * `src/shaders/color-adjust.wgsl`, plus a multi-effect chain case.
 *
 * Runs the real local shaders on a GPU (SwiftShader fallback) via a secure
 * loopback origin, threads the intermediate `rgba8unorm` storage texture
 * between stages, reads the final output back and compares it against the
 * independent pure-TS oracles in `src/core/effects/reference/`.
 *
 * The chain cases apply the oracles sequentially to the same input: because
 * the oracles return RGBA8 buffers, the intermediate 8-bit quantization is
 * modelled exactly, so the comparison validates both the texture threading and
 * the composition of the effects.
 *
 * Launched with `playwright.gpu.config.ts`; kept out of the GPU-free smoke
 * suite.
 */

interface StageRequest {
  wgsl: string;
  entryPoint: string;
  workgroupX: number;
  workgroupY: number;
  /** Extra uniform buffers at bindings 2, 3, ... (input=0, output=1). */
  uniforms: number[][];
}

interface GpuRequest {
  width: number;
  height: number;
  pixels: number[];
  stages: StageRequest[];
}

type Oracle = (input: Uint8Array, width: number, height: number) => Uint8Array;

interface EffectStage {
  effect: StageRequest;
  oracle: Oracle;
}

interface EffectCase {
  name: string;
  image: RgbaImage;
  stages: EffectStage[];
  exact: boolean;
}

const DEBANDING_WGSL = readFileSync(
  path.resolve(__dirname, '..', '..', 'src', 'shaders', 'debanding.wgsl'),
  'utf8',
);
const COLOR_ADJUST_WGSL = readFileSync(
  path.resolve(__dirname, '..', '..', 'src', 'shaders', 'color-adjust.wgsl'),
  'utf8',
);
const CAS_WGSL = readFileSync(
  path.resolve(__dirname, '..', '..', 'src', 'shaders', 'cas.wgsl'),
  'utf8',
);

// Trivial passthrough used only to probe that this environment can create a
// device, dispatch compute, copy to a buffer and map it back. Binding 2 exists
// so the chain bind-group shape (input/output + uniforms) is exercised.
const PREFLIGHT_WGSL = `
@group(0) @binding(0) var inputTex: texture_2d<f32>;
@group(0) @binding(1) var outputTex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> params: vec2<f32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let size = textureDimensions(inputTex);
  if (gid.x >= size.x || gid.y >= size.y) {
    return;
  }
  let pos = vec2<i32>(i32(gid.x), i32(gid.y));
  // At params.x = 0 this is a no-op: max(sample, 0) == sample.
  textureStore(outputTex, pos, max(textureLoad(inputTex, pos, 0), vec4<f32>(params.x)));
}
`;

const PAGE_HTML =
  '<!doctype html><html><head><meta charset="utf-8">'
  + '<title>gpu-debanding-coloradjust-correctness</title></head><body></body></html>';

/** Neutral ("no grading") ColorAdjust parameters. */
const NEUTRAL_COLOR: ColorAdjustParams = {
  brightness: 0,
  gamma: 1,
  contrast: 1,
  saturation: 1,
  vibrance: 0,
  exposure: 0,
};

/** Effect factory: Debanding (workgroup 8x8, entry `main`, vec2 uniform). */
function debanding(strength: number, bandThreshold: number): EffectStage {
  return {
    effect: {
      wgsl: DEBANDING_WGSL,
      entryPoint: 'main',
      workgroupX: 8,
      workgroupY: 8,
      uniforms: [[strength, bandThreshold]],
    },
    oracle: (input, width, height) =>
      referenceDebanding(input, width, height, { strength, bandThreshold }),
  };
}

/** Effect factory: ColorAdjust (workgroup 8x8, entry `main`, vec4 + vec2). */
function colorAdjust(params: ColorAdjustParams): EffectStage {
  return {
    effect: {
      wgsl: COLOR_ADJUST_WGSL,
      entryPoint: 'main',
      workgroupX: 8,
      workgroupY: 8,
      uniforms: [
        [params.brightness, params.gamma, params.contrast, params.vibrance],
        [params.saturation, params.exposure],
      ],
    },
    oracle: (input, width, height) => referenceColorAdjust(input, width, height, params),
  };
}

/**
 * Effect factory: CAS (workgroup 8x8, entry `main`, vec2 uniform).
 *
 * Used only inside a chain to validate composition; the standalone CAS gate is
 * owned by `effect-correctness.spec.ts`.
 */
function cas(sharpness: number): EffectStage {
  return {
    effect: {
      wgsl: CAS_WGSL,
      entryPoint: 'main',
      workgroupX: 8,
      workgroupY: 8,
      uniforms: [[sharpness, 0]],
    },
    oracle: (input, width, height) => referenceCas(input, width, height, { sharpness }),
  };
}

const CHAIN_GRADE: ColorAdjustParams = {
  brightness: 0.05,
  gamma: 1.2,
  contrast: 1.1,
  saturation: 1.2,
  vibrance: 0.3,
  exposure: 0.25,
};

const CASES: EffectCase[] = [
  // Debanding: neutral is an exact identity; two strengths plus a hard-edge
  // fixture (bandMask -> 0, so mostly unchanged but exercises the edges).
  { name: 'debanding-neutral', image: hardGradient(64, 48), stages: [debanding(0, 0.08)], exact: true },
  { name: 'debanding-strength-0.5', image: hardGradient(64, 48), stages: [debanding(0.5, 0.08)], exact: false },
  { name: 'debanding-strength-1.0', image: hardGradient(64, 48), stages: [debanding(1, 0.08)], exact: false },
  { name: 'debanding-hard-edge', image: hardEdge(33, 17), stages: [debanding(1, 0.15)], exact: false },

  // ColorAdjust: neutral is exact; two grading presets plus a vibrance/exposure
  // preset on a chromatic sweep.
  { name: 'coloradjust-neutral', image: colorSweep(32, 24), stages: [colorAdjust(NEUTRAL_COLOR)], exact: true },
  {
    name: 'coloradjust-grade-a',
    image: colorSweep(32, 24),
    stages: [colorAdjust({
      brightness: 0.08,
      gamma: 1.4,
      contrast: 1.15,
      saturation: 1.3,
      vibrance: 0,
      exposure: 0,
    })],
    exact: false,
  },
  {
    name: 'coloradjust-grade-b',
    image: colorSweep(32, 24),
    stages: [colorAdjust({
      brightness: 0,
      gamma: 1,
      contrast: 1,
      saturation: 1,
      vibrance: 0.5,
      exposure: 0.5,
    })],
    exact: false,
  },

  // Chain correctness: the intermediate rgba8unorm texture must be threaded
  // from stage to stage and the composition must match the sequential oracles.
  {
    name: 'chain-debanding-coloradjust',
    image: hardGradient(64, 48),
    stages: [debanding(0.6, 0.08), colorAdjust(CHAIN_GRADE)],
    exact: false,
  },
  {
    name: 'chain-cas-coloradjust',
    image: hardGradient(64, 48),
    stages: [cas(0.5), colorAdjust(CHAIN_GRADE)],
    exact: false,
  },
];

let server: Server | undefined;
let origin = '';
let preflight: GpuResult | null = null;

/**
 * Run a chain of compute stages (input -> stage0 -> stage1 -> ...) and read
 * the final `rgba8unorm` output back, all inside the page. Each stage uses
 * `layout: 'auto'` with input at binding 0, output at binding 1 and its uniform
 * buffers at bindings 2, 3, ... — matching the effect wrappers.
 */
async function runGpuChain(page: Page, request: GpuRequest): Promise<GpuResult> {
  return page.evaluate(async (req): Promise<GpuResult> => {
    const unavailable = (message: string): GpuFailure => ({
      ok: false,
      kind: 'unavailable',
      error: message,
    });
    const validation = (message: string): GpuFailure => ({
      ok: false,
      kind: 'validation',
      error: message,
    });

    if (typeof navigator === 'undefined' || !navigator.gpu) {
      return unavailable('navigator.gpu is not defined');
    }

    // Prefer the software fallback adapter, then fall back to any adapter.
    let adapter: GPUAdapter | null = null;
    try {
      adapter = await navigator.gpu.requestAdapter({ forceFallbackAdapter: true });
    } catch {
      // Fall through to the generic adapter request below.
    }
    if (!adapter) {
      try {
        adapter = await navigator.gpu.requestAdapter();
      } catch (error) {
        return unavailable(`requestAdapter() threw: ${String(error)}`);
      }
    }
    if (!adapter) {
      return unavailable('requestAdapter() returned null');
    }

    let device: GPUDevice;
    try {
      device = await adapter.requestDevice();
    } catch (error) {
      return unavailable(`requestDevice() threw: ${String(error)}`);
    }

    const adapterInfo = JSON.stringify({
      vendor: adapter.info.vendor,
      architecture: adapter.info.architecture,
      device: adapter.info.device,
    });
    const software =
      adapter.info.isFallbackAdapter || /swiftshader|llvmpipe|software/i.test(adapterInfo);

    const { width, height } = req;
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;

    device.pushErrorScope('validation');
    let scopeOpen = true;
    let failure: GpuFailure | null = null;
    let output: number[] = [];

    try {
      const inputTexture = device.createTexture({
        size: { width, height },
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      // One output per stage; intermediate outputs are also usable as the next
      // stage's input texture and the last one is copyable for readback.
      const stageOutputs = req.stages.map(() => device.createTexture({
        size: { width, height },
        format: 'rgba8unorm',
        usage: GPUTextureUsage.STORAGE_BINDING
          | GPUTextureUsage.TEXTURE_BINDING
          | GPUTextureUsage.COPY_SRC,
      }));
      const readback = device.createBuffer({
        size: bytesPerRow * height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });

      device.queue.writeTexture(
        { texture: inputTexture },
        new Uint8Array(req.pixels),
        { bytesPerRow: width * 4, rowsPerImage: height },
        { width, height },
      );

      const pipelines = req.stages.map((stage) => device.createComputePipeline({
        layout: 'auto',
        compute: {
          module: device.createShaderModule({
            code: stage.wgsl,
            label: `chain-stage-${stage.entryPoint}`,
          }),
          entryPoint: stage.entryPoint,
        },
      }));

      const bindGroups = req.stages.map((stage, stageIndex) => {
        const input = stageIndex === 0 ? inputTexture : stageOutputs[stageIndex - 1];
        const entries: GPUBindGroupEntry[] = [
          { binding: 0, resource: input.createView() },
          { binding: 1, resource: stageOutputs[stageIndex].createView() },
        ];
        stage.uniforms.forEach((data, uniformIndex) => {
          const buffer = device.createBuffer({
            size: data.length * 4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          });
          device.queue.writeBuffer(buffer, 0, new Float32Array(data));
          entries.push({ binding: uniformIndex + 2, resource: { buffer } });
        });
        return device.createBindGroup({
          layout: pipelines[stageIndex].getBindGroupLayout(0),
          entries,
        });
      });

      const encoder = device.createCommandEncoder();
      req.stages.forEach((stage, stageIndex) => {
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipelines[stageIndex]);
        pass.setBindGroup(0, bindGroups[stageIndex]);
        pass.dispatchWorkgroups(
          Math.ceil(width / stage.workgroupX),
          Math.ceil(height / stage.workgroupY),
        );
        pass.end();
      });
      encoder.copyTextureToBuffer(
        { texture: stageOutputs[stageOutputs.length - 1] },
        { buffer: readback, bytesPerRow, rowsPerImage: height },
        { width, height },
      );
      device.queue.submit([encoder.finish()]);

      const validationError = await device.popErrorScope();
      scopeOpen = false;
      if (validationError) {
        failure = validation(validationError.message);
      } else {
        await readback.mapAsync(GPUMapMode.READ);
        const mapped = new Uint8Array(readback.getMappedRange());
        const stripped = new Uint8Array(width * height * 4);
        for (let y = 0; y < height; y++) {
          stripped.set(
            mapped.subarray(y * bytesPerRow, y * bytesPerRow + width * 4),
            y * width * 4,
          );
        }
        readback.unmap();
        output = Array.from(stripped);
      }
    } catch (error) {
      failure = validation(String(error));
    } finally {
      if (scopeOpen) {
        try {
          await device.popErrorScope();
        } catch {
          // Ignore; the device/page may already be gone.
        }
      }
    }

    if (failure) return failure;
    return { ok: true, width, height, data: output, adapterInfo, software };
  }, request);
}

/** Apply the case's oracles in order, threading the intermediate RGBA8. */
function expectedFor(effectCase: EffectCase): Uint8Array {
  let current = effectCase.image.data;
  for (const stage of effectCase.stages) {
    current = stage.oracle(current, effectCase.image.width, effectCase.image.height);
  }
  return current;
}

test.beforeAll(async ({ browser }) => {
  const started = await startSecureOrigin({ serveVendor: false, pageHtml: PAGE_HTML });
  server = started.server;
  origin = started.origin;

  const page = await browser.newPage();
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    preflight = await runGpuChain(page, {
      width: 2,
      height: 2,
      pixels: [32, 64, 96, 255, 128, 160, 192, 255, 200, 210, 220, 255, 45, 90, 135, 255],
      stages: [{
        wgsl: PREFLIGHT_WGSL,
        entryPoint: 'main',
        workgroupX: 8,
        workgroupY: 8,
        uniforms: [[0, 0]],
      }],
    });
  } finally {
    await page.close();
  }

  if (preflight.ok) {
    console.log(
      `[gpu] preflight OK; adapter=${preflight.adapterInfo} software=${preflight.software}`,
    );
  } else {
    console.warn(`[gpu] preflight FAILED (${preflight.kind}): ${preflight.error}`);
  }
});

test.afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve) => {
      server!.close(() => resolve());
    });
  }
});

for (const effectCase of CASES) {
  test(effectCase.name, async ({ page }) => {
    guardGpu(preflight, 'debanding/color-adjust compute');
    await page.goto(origin, { waitUntil: 'domcontentloaded' });

    const { image } = effectCase;
    const result = await runGpuChain(page, {
      width: image.width,
      height: image.height,
      pixels: Array.from(image.data),
      stages: effectCase.stages.map((stage) => stage.effect),
    });

    expect(
      result.ok,
      result.ok
        ? 'unexpected result shape'
        : `GPU case failed (${result.kind}): ${result.error}`,
    ).toBe(true);
    if (!result.ok) return;

    const actual = new Uint8Array(result.data);
    const expected = expectedFor(effectCase);
    const cmp = compareRgba(expected, actual);

    // Guard against a false pass where both the oracle and the GPU are no-ops.
    if (!effectCase.exact) {
      const inputVsExpected = compareRgba(image.data, expected);
      expect(
        inputVsExpected.maxAbs,
        `${effectCase.name}: oracle produced no change for this fixture/params`,
      ).toBeGreaterThan(0);
    }

    let badAlphaCount = 0;
    for (let i = 3; i < actual.length; i += 4) {
      if (actual[i] !== 255) badAlphaCount += 1;
    }

    const dimensionsOk =
      result.width === image.width
      && result.height === image.height
      && actual.length === expected.length;
    const metricsOk = effectCase.exact
      ? cmp.maxAbs === 0
      : cmp.maxAbs <= 2 && cmp.meanAbs <= 0.5 && cmp.psnr >= 40;

    if (!dimensionsOk || badAlphaCount > 0 || !metricsOk) {
      const adapter = preflight && preflight.ok ? preflight.adapterInfo : 'unknown';
      const dir = writeArtifacts('debanding-coloradjust-correctness', effectCase.name, expected, actual, {
        case: effectCase.name,
        width: image.width,
        height: image.height,
        stages: effectCase.stages.map((stage) => stage.effect.entryPoint),
        exact: effectCase.exact,
        adapter,
        software: result.software,
        comparison: cmp,
      });
      console.warn(`[gpu] ${effectCase.name} artifacts written to ${dir}`);
    }

    const summary = formatComparison(effectCase.name, cmp);
    expect(dimensionsOk, `${summary} (dimensions mismatch)`).toBe(true);
    expect(badAlphaCount, `${summary} (alpha != 255 on ${badAlphaCount} pixels)`).toBe(0);

    if (effectCase.exact) {
      expect(cmp.maxAbs, summary).toBe(0);
    } else {
      expect(cmp.maxAbs, summary).toBeLessThanOrEqual(2);
      expect(cmp.meanAbs, summary).toBeLessThanOrEqual(0.5);
      expect(cmp.psnr, summary).toBeGreaterThanOrEqual(40);
    }

    const psnr = cmp.psnr === Infinity ? 'Infinity' : `${cmp.psnr.toFixed(2)}dB`;
    console.log(
      `[gpu] ${effectCase.name} maxAbs=${cmp.maxAbs} meanAbs=${cmp.meanAbs.toFixed(4)}`
      + ` psnr=${psnr} mismatches=${cmp.mismatchCount}`,
    );
  });
}
