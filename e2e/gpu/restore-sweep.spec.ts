import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  guardGpu,
  runGpuCase,
  runGpuRealChainPngDump,
  startSecureOrigin,
  type GpuPngDumpStageMeta,
  type RealChainStageSpec,
} from './downscale-harness';

/**
 * RESTORE SWEEP — decoupling the leading restore from a trailing sharpener.
 *
 * At the production 'Fast mode — Preserve detail' ON geometry for a 2560x1440
 * target (1080p source: no intermediate downscale, one final Downscale, the
 * `ClampHighlights` head/`ClampHighlightsApply` tail are harness-injected), the
 * leading 1080p restore trades face sharpening against wing-contour loss. This
 * sweep dumps variants that drop the leading restore and compensate with a
 * trailing `DoG` deblur (strength 2 / 4) or a `CAS` post-pass (sharpness 0.3 /
 * 0.6), plus CNNM + trailing DoG combinations, so the tradeoff curve can be
 * scored against the two already-dumped references.
 *
 * Existing dumps reused by the scorer (NOT re-run here):
 *   r0-cnnul = videoframe_497385_toggle-on/A+A-ultra   (CNNUL -> CNNx2UL -> Downscale)
 *   r1-cnnm  = videoframe_497385_ab/on-cnnm            (CNNM  -> CNNx2UL -> Downscale)
 *
 * New variants (all target 2560x1440):
 *   r2a-norestore-dog2   : CNNx2UL -> Downscale -> DoG(strength=2)
 *   r2b-norestore-dog4   : CNNx2UL -> Downscale -> DoG(strength=4)
 *   r3a-norestore-cas0.3 : CNNx2UL -> Downscale + CAS(sharpness=0.3)
 *   r3b-norestore-cas0.6 : CNNx2UL -> Downscale + CAS(sharpness=0.6)
 *   r4a-cnnm-dog2        : CNNM -> CNNx2UL -> Downscale -> DoG(strength=2)
 *   r4b-cnnm-dog4        : CNNM -> CNNx2UL -> Downscale -> DoG(strength=4)
 *
 * Output: `${repo}/videoframe_497385_sweep/<variant>/`
 *   `00-source.png`, one PNG per stage, `manifest.json`, `passes.txt`.
 *
 * Diagnostic, not a gate: grouped with the chain-ablation experiments (see
 * `playwright.gpu.ablation.config.ts`) and never runs in the default GPU suite.
 *
 * Env overrides:
 *   SWEEP_INPUT    input PNG (default `<repo>/e2e/testdata/videoframe_497385.png`)
 *   SWEEP_VARIANTS comma list of variant ids (default all six)
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const TARGET = { width: 2560, height: 1440 };

/** The extension's SHIPPED CAS shader; passed as text so the harness stays src-free. */
const CAS_WGSL = readFileSync(path.join(REPO_ROOT, 'src', 'shaders', 'cas.wgsl'), 'utf8');

interface Dimensions {
  width: number;
  height: number;
}

interface VariantDef {
  id: string;
  restore: string | null;
  dogStrength: number | null;
  casSharpness: number | null;
}

const VARIANTS: readonly VariantDef[] = [
  { id: 'r2a-norestore-dog2', restore: null, dogStrength: 2, casSharpness: null },
  { id: 'r2b-norestore-dog4', restore: null, dogStrength: 4, casSharpness: null },
  { id: 'r3a-norestore-cas0.3', restore: null, dogStrength: null, casSharpness: 0.3 },
  { id: 'r3b-norestore-cas0.6', restore: null, dogStrength: null, casSharpness: 0.6 },
  { id: 'r4a-cnnm-dog2', restore: 'CNNM', dogStrength: 2, casSharpness: null },
  { id: 'r4b-cnnm-dog4', restore: 'CNNM', dogStrength: 4, casSharpness: null },
];

/**
 * Build the production ON geometry for a variant:
 * `[restore?] -> CNNx2UL (x2) -> Downscale [-> DoG]`.
 */
function buildStages(variant: VariantDef): RealChainStageSpec[] {
  const stages: RealChainStageSpec[] = [];
  const addEffect = (
    key: string,
    scale: number | null,
    params?: Record<string, number>,
  ): void => {
    const index = stages.length;
    stages.push({
      kind: 'effect',
      label: `${key}#${index}`,
      key,
      behavior: scale === null ? { kind: 'same' } : { kind: 'scale', scale },
      ...(params ? { params } : {}),
    });
  };

  if (variant.restore !== null) addEffect(variant.restore, null);
  addEffect('CNNx2UL', 2);
  stages.push({
    kind: 'downscale',
    label: 'Downscale',
    width: TARGET.width,
    height: TARGET.height,
  });
  if (variant.dogStrength !== null) addEffect('DoG', null, { strength: variant.dogStrength });
  return stages;
}

/** Read PNG pixel dimensions from the IHDR chunk (bytes 16..24, big-endian). */
function readPngSize(buffer: Buffer): Dimensions {
  const signature = buffer.subarray(0, 8).toString('latin1');
  if (signature !== '\x89PNG\r\n\x1a\n') {
    throw new Error('input is not a PNG (bad signature)');
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** Sanitize a pass label for use in a filename. */
function fileLabel(meta: GpuPngDumpStageMeta): string {
  const base = meta.key === 'ClampHighlightsApply' ? 'ClampHighlightsApply' : meta.label;
  return base.replace(/[^A-Za-z0-9._+-]+/g, '-');
}

const IDENTITY_PREFLIGHT_WGSL = `
@group(0) @binding(0) var tex_in: texture_2d<f32>;
@group(0) @binding(1) var tex_out: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8, 8)
fn computeMain(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(tex_out);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }
  textureStore(tex_out, vec2i(gid.xy), textureLoad(tex_in, vec2i(gid.xy), 0));
}
`;

let server: Server | undefined;
let origin = '';
let preflight: Awaited<ReturnType<typeof runGpuCase>> | null = null;

test.beforeAll(async ({ browser }) => {
  const started = await startSecureOrigin();
  server = started.server;
  origin = started.origin;

  const page = await browser.newPage();
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    preflight = await runGpuCase(page, {
      wgsl: IDENTITY_PREFLIGHT_WGSL,
      srcWidth: 2,
      srcHeight: 2,
      outWidth: 2,
      outHeight: 2,
      pixels: [32, 64, 96, 255, 128, 160, 192, 255, 200, 210, 220, 255, 45, 90, 135, 255],
    });
  } finally {
    await page.close();
  }

  if (preflight.ok) {
    console.log(
      `[sweep] preflight OK; adapter=${preflight.adapterInfo} software=${preflight.software}`,
    );
  } else {
    console.warn(`[sweep] preflight FAILED (${preflight.kind}): ${preflight.error}`);
  }
});

test.afterAll(async () => {
  const active = server;
  if (active) {
    await new Promise<void>((resolve) => {
      active.close(() => resolve());
    });
  }
});

test('dump trailing-sharpener sweep variants to PNG', async ({ browser }) => {
  // Several minutes per GPU CNN chain under SwiftShader; six variants.
  test.setTimeout(3_600_000);

  guardGpu(preflight, 'restore sweep dump');

  const inputPath = path.resolve(
    process.env.SWEEP_INPUT ?? path.join(REPO_ROOT, 'e2e', 'testdata', 'videoframe_497385.png'),
  );
  if (!existsSync(inputPath)) throw new Error(`input PNG not found: ${inputPath}`);

  const requested = (process.env.SWEEP_VARIANTS ?? VARIANTS.map((v) => v.id).join(','))
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const knownIds = VARIANTS.map((variant) => variant.id).join(', ');
  const variants = requested.map((id) => {
    const variant = VARIANTS.find((candidate) => candidate.id === id);
    if (!variant) throw new Error(`unknown SWEEP_VARIANTS id "${id}" (expected ${knownIds})`);
    return variant;
  });

  const inputBuffer = readFileSync(inputPath);
  const source = readPngSize(inputBuffer);
  const srcPngBase64 = inputBuffer.toString('base64');
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const sweepDir = path.join(REPO_ROOT, `${baseName}_sweep`);

  console.log(
    `[sweep] input=${inputPath} source=${source.width}x${source.height} `
    + `target=${TARGET.width}x${TARGET.height} variants=${variants.map((v) => v.id).join('|')}`,
  );

  for (const variant of variants) {
    const stages = buildStages(variant);
    const postSharpen = variant.casSharpness === null
      ? undefined
      : { kind: 'cas' as const, sharpness: variant.casSharpness, wgsl: CAS_WGSL };
    const outDir = path.join(sweepDir, variant.id);
    mkdirSync(outDir, { recursive: true });
    // Pass 0 is the decoded source itself, byte-identical to the input file.
    writeFileSync(path.join(outDir, '00-source.png'), inputBuffer);

    console.log(
      `[sweep] ${variant.id}: ${stages.length} stages`
      + `${postSharpen ? ` + CAS(${variant.casSharpness})` : ''} -> ${outDir}`,
    );

    // A fresh page per variant: closing it releases the variant's GPUDevice and
    // every adapter texture before the next variant allocates.
    const page = await browser.newPage();
    try {
      await page.goto(origin, { waitUntil: 'domcontentloaded' });

      let counter = 0;
      const sinked: GpuPngDumpStageMeta[] = [];
      const result = await runGpuRealChainPngDump(
        page,
        { srcPngBase64, stages, clampHighlights: true, postSharpen },
        async (meta, pngBase64) => {
          counter += 1;
          const name = `${String(counter).padStart(2, '0')}-${fileLabel(meta)}-`
            + `${meta.width}x${meta.height}.png`;
          writeFileSync(path.join(outDir, name), Buffer.from(pngBase64, 'base64'));
          sinked.push(meta);
        },
      );

      if (!result.ok) {
        throw new Error(`[sweep] ${variant.id} failed (${result.kind}): ${result.error}`);
      }

      const expectedCount = stages.length + 1 + (postSharpen ? 1 : 0);
      expect(sinked.length, `${variant.id}: dumped stage count`).toBe(expectedCount);

      const dumped = [
        { pass: 0, file: '00-source.png', label: 'source', key: 'source', ...source },
        ...sinked.map((meta, index) => ({
          pass: index + 1,
          file: `${String(index + 1).padStart(2, '0')}-${fileLabel(meta)}-`
            + `${meta.width}x${meta.height}.png`,
          label: meta.label,
          key: meta.key,
          width: meta.width,
          height: meta.height,
        })),
      ];
      const manifest = {
        variant: variant.id,
        leadingRestore: variant.restore,
        dogStrength: variant.dogStrength,
        casSharpness: variant.casSharpness,
        mode: 'A+A-ultra',
        tier: 'ultra',
        policy: 'on',
        togglePreserveDetail: true,
        geometry: 'production ON (no intermediate downscale; one final Downscale)',
        source,
        target: TARGET,
        adapter: result.adapterInfo,
        software: result.software,
        clampHighlightsHead: 'pass-through (stats capture); pixels equal 00-source.png',
        stages: stages.map((stage) => (
          stage.kind === 'effect'
            ? {
                kind: 'effect',
                label: stage.label,
                key: stage.key,
                behavior: stage.behavior,
                params: stage.params ?? null,
              }
            : { kind: 'downscale', label: stage.label, width: stage.width, height: stage.height }
        )),
        postSharpen: postSharpen
          ? { kind: postSharpen.kind, sharpness: postSharpen.sharpness }
          : null,
        dumped,
      };
      writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

      const listing = dumped
        .map((entry) => (
          `pass ${String(entry.pass).padStart(2, '0')}  ${entry.file}  `
          + `${entry.width}x${entry.height}  ${entry.key}`
        ))
        .join('\n');
      writeFileSync(path.join(outDir, 'passes.txt'), `${listing}\n`);

      console.log(`[sweep] ${variant.id} wrote ${dumped.length} entries`);
    } finally {
      await page.close();
    }
  }
});
