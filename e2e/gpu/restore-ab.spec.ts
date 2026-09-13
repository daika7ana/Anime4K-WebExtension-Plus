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
 * RESTORE ABLATION — leading-restore A/B at 1080p -> 2K.
 *
 * Production A+A ultra at a 2560x1440 target with 'Fast mode — Preserve detail'
 * ON runs `CNNUL (1080p) -> CNNx2UL (x2) -> Downscale (2560x1440)` plus the
 * injected `ClampHighlights` head/`ClampHighlightsApply` tail. The leading 1080p
 * `CNNUL` restore is both the biggest face sharpener and the biggest wing-contour
 * loss. This diagnostic swaps that leading restore for gentler ones (or removes
 * it entirely) and dumps the final PNG so the trade-off can be scored.
 *
 * Variants (all target 2560x1440, production ON geometry = one final Downscale):
 *   on-cnnvl     : CNNVL     -> CNNx2UL (x2) -> Downscale
 *   on-cnnsoftvl : CNNSoftVL -> CNNx2UL (x2) -> Downscale
 *   on-cnnm      : CNNM      -> CNNx2UL (x2) -> Downscale
 *   on-norestore : CNNx2UL (x2) -> Downscale
 * The production `CNNUL` chain is the pre-existing
 * `videoframe_497385_toggle-on/A+A-ultra` dump; it is NOT re-run here.
 *
 * Output: `${repo}/videoframe_497385_ab/<variant>/`
 *   `00-source.png`, one PNG per stage, `manifest.json`, `passes.txt`.
 * `ClampHighlights` is injected at the head (pass-through stats capture) and its
 * deferred apply is dumped as the final `ClampHighlightsApply` stage.
 *
 * This is a diagnostic, not a gate: it is grouped with the chain-ablation
 * experiments (see `playwright.gpu.ablation.config.ts`) and never runs in the
 * default GPU suite.
 *
 * Env overrides:
 *   RESTORE_AB_INPUT    input PNG (default `<repo>/e2e/testdata/videoframe_497385.png`)
 *   RESTORE_AB_VARIANTS comma list of variant ids (default all four)
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const TARGET = { width: 2560, height: 1440 };

interface Dimensions {
  width: number;
  height: number;
}

/** A variant's leading restore effect key, or `null` for no restore. */
interface VariantDef {
  id: string;
  restore: string | null;
}

const VARIANTS: readonly VariantDef[] = [
  { id: 'on-cnnvl', restore: 'CNNVL' },
  { id: 'on-cnnsoftvl', restore: 'CNNSoftVL' },
  { id: 'on-cnnm', restore: 'CNNM' },
  { id: 'on-norestore', restore: null },
];

/** Build the production ON geometry for a variant: [restore?] -> CNNx2UL -> Downscale. */
function buildStages(restore: string | null): RealChainStageSpec[] {
  const stages: RealChainStageSpec[] = [];
  const addEffect = (key: string, scale: number | null): void => {
    const index = stages.length;
    stages.push({
      kind: 'effect',
      label: `${key}#${index}`,
      key,
      behavior: scale === null ? { kind: 'same' } : { kind: 'scale', scale },
    });
  };

  if (restore !== null) addEffect(restore, null);
  addEffect('CNNx2UL', 2);
  stages.push({
    kind: 'downscale',
    label: 'Downscale',
    width: TARGET.width,
    height: TARGET.height,
  });
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
      `[restore-ab] preflight OK; adapter=${preflight.adapterInfo} software=${preflight.software}`,
    );
  } else {
    console.warn(`[restore-ab] preflight FAILED (${preflight.kind}): ${preflight.error}`);
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

test('dump leading-restore ablation variants to PNG', async ({ browser }) => {
  // Several minutes per 4K CNN chain under SwiftShader; four variants.
  test.setTimeout(3_600_000);

  guardGpu(preflight, 'restore ablation dump');

  const inputPath = path.resolve(
    process.env.RESTORE_AB_INPUT ?? path.join(REPO_ROOT, 'e2e', 'testdata', 'videoframe_497385.png'),
  );
  if (!existsSync(inputPath)) throw new Error(`input PNG not found: ${inputPath}`);

  const requested = (process.env.RESTORE_AB_VARIANTS ?? VARIANTS.map((v) => v.id).join(','))
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const knownIds = VARIANTS.map((variant) => variant.id).join(', ');
  const variants = requested.map((id) => {
    const variant = VARIANTS.find((candidate) => candidate.id === id);
    if (!variant) throw new Error(`unknown RESTORE_AB_VARIANTS id "${id}" (expected ${knownIds})`);
    return variant;
  });

  const inputBuffer = readFileSync(inputPath);
  const source = readPngSize(inputBuffer);
  const srcPngBase64 = inputBuffer.toString('base64');
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const abortDir = path.join(REPO_ROOT, `${baseName}_ab`);

  console.log(
    `[restore-ab] input=${inputPath} source=${source.width}x${source.height} `
    + `target=${TARGET.width}x${TARGET.height} variants=${variants.map((v) => v.id).join('|')}`,
  );

  for (const variant of variants) {
    const stages = buildStages(variant.restore);
    const outDir = path.join(abortDir, variant.id);
    mkdirSync(outDir, { recursive: true });
    // Pass 0 is the decoded source itself, byte-identical to the input file.
    writeFileSync(path.join(outDir, '00-source.png'), inputBuffer);

    console.log(`[restore-ab] ${variant.id}: ${stages.length} stages -> ${outDir}`);

    // A fresh page per variant: closing it releases the variant's GPUDevice and
    // every adapter texture before the next variant allocates, keeping peak
    // memory to a single variant (the machine has ~3-4 GB usable).
    const page = await browser.newPage();
    try {
      await page.goto(origin, { waitUntil: 'domcontentloaded' });

      let counter = 0;
      const sinked: GpuPngDumpStageMeta[] = [];
      const result = await runGpuRealChainPngDump(
        page,
        { srcPngBase64, stages, clampHighlights: true },
        async (meta, pngBase64) => {
          counter += 1;
          const name = `${String(counter).padStart(2, '0')}-${fileLabel(meta)}-`
            + `${meta.width}x${meta.height}.png`;
          writeFileSync(path.join(outDir, name), Buffer.from(pngBase64, 'base64'));
          sinked.push(meta);
        },
      );

      if (!result.ok) {
        throw new Error(`[restore-ab] ${variant.id} failed (${result.kind}): ${result.error}`);
      }

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
            ? { kind: 'effect', label: stage.label, key: stage.key, behavior: stage.behavior }
            : { kind: 'downscale', label: stage.label, width: stage.width, height: stage.height }
        )),
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

      console.log(`[restore-ab] ${variant.id} wrote ${dumped.length} entries`);
      // `clampHighlights: true` appends one deferred `ClampHighlightsApply`
      // output after the base stages.
      expect(sinked.length, `${variant.id}: dumped stage count`).toBe(stages.length + 1);
    } finally {
      await page.close();
    }
  }
});
