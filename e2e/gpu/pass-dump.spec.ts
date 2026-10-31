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
import {
  DEFAULT_MAX_INTERMEDIATE_PIXELS,
  computeRemainingUpscaleFactors,
  isSuppressedIndex,
  planChainGeometryPreview,
  planIntermediateDownscale,
  type ChainGeometryPreview,
} from '../../src/core/gpu/effect-chain';

/**
 * PASS DUMP — run a mode's real Anime4K chain over a still PNG and write one
 * PNG per pass so each stage can be inspected by eye.
 *
 * This is a diagnostic, not a gate: it is grouped with the chain-ablation
 * experiments (see `playwright.gpu.ablation.config.ts`) and never runs in the
 * default GPU suite.
 *
 * For every mode/policy it writes, next to the input:
 *   `<basename>_toggle-on/<mode>/00-source.png`, `01-<pass>.png`, ... `manifest.json`
 *   `<basename>_toggle-off/<mode>/...`
 *   `<basename>_legacy/<mode>/...` (diagnostic only)
 *
 * Policies model the production restore policy. The always-on geometry
 * suppression is active in every shipped policy; the policy only selects the
 * restore suppression:
 *   - `on`  (restorePolicy 'trailing'): real planner, `restoreSuppression: 'trailing'`.
 *   - `off` (restorePolicy 'off'): real planner, `restoreSuppression: 'off'`.
 *   - `legacy` (diagnostic): the pre-fix forced no-suppression preview (all
 *     geometry fields `null`), i.e. neither geometry nor restore suppression.
 * The `ClampHighlights` head is a pass-through capture and is not dumped; its
 * deferred `ClampHighlightsApply` epilogue is.
 *
 * Env overrides:
 *   PASS_DUMP_INPUT   input PNG (default `<repo>/e2e/testdata/videoframe_497385.png`)
 *   PASS_DUMP_TARGET  render target WxH (default `3840x2160`)
 *   PASS_DUMP_MODES   comma list of mode keys (default `C+A-ultra,A+A-ultra`)
 *   PASS_DUMP_POLICIES comma list of `on,off,legacy` (default `on,off`)
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');

interface Dimensions {
  width: number;
  height: number;
}

interface EffectSpec {
  key: string;
  scale: number;
  restore: boolean;
}

/**
 * Mode templates (mirrors `src/utils/effect-chain-templates.ts`; the
 * `ClampHighlights` head is implicit — the harness injects it). Ultra tier.
 */
const MODE_EFFECTS: Record<string, EffectSpec[]> = {
  // C+A ultra: DenoiseCNNx2VL -> CNNUL -> CNNx2UL
  'C+A-ultra': [
    { key: 'DenoiseCNNx2VL', scale: 2, restore: false },
    { key: 'CNNUL', scale: 1, restore: true },
    { key: 'CNNx2UL', scale: 2, restore: false },
  ],
  // A+A ultra: CNNUL -> CNNx2UL -> CNNUL -> CNNx2UL -> CNNUL -> CNNx2VL
  'A+A-ultra': [
    { key: 'CNNUL', scale: 1, restore: true },
    { key: 'CNNx2UL', scale: 2, restore: false },
    { key: 'CNNUL', scale: 1, restore: true },
    { key: 'CNNx2UL', scale: 2, restore: false },
    { key: 'CNNUL', scale: 1, restore: true },
    { key: 'CNNx2VL', scale: 2, restore: false },
  ],
};

type Policy = 'on' | 'off' | 'legacy';

/** Policy -> output-folder tag (`<basename>_<tag>/<mode>/`). */
const POLICY_TAGS: Record<Policy, string> = {
  on: 'toggle-on',
  off: 'toggle-off',
  legacy: 'legacy',
};

/** Read PNG pixel dimensions from the IHDR chunk (bytes 16..24, big-endian). */
function readPngSize(buffer: Buffer): Dimensions {
  const signature = buffer.subarray(0, 8).toString('latin1');
  if (signature !== '\x89PNG\r\n\x1a\n') {
    throw new Error('input is not a PNG (bad signature)');
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/**
 * Rebuild the exact `compileEffectChain` stage list for a policy, without a GPU.
 *
 * Mirrors `src/core/gpu/effect-chain-compiler.ts`:
 *  - `on` / `off` use the real `planChainGeometryPreview` (always-on geometry
 *    suppression + the adapter limit pass); the toggle only selects the restore
 *    policy (`'trailing'` for `on`, `'off'` for `off`);
 *  - `legacy` is the pre-fix diagnostic chain: forced no geometry suppression
 *    (`suppressFromIndex: null`) with every restore retained.
 * The returned list excludes the `ClampHighlights` head (injected by the
 * harness) and its deferred `ClampHighlightsApply` tail (also harness-injected).
 */
function buildStages(
  effects: readonly EffectSpec[],
  source: Dimensions,
  target: Dimensions,
  policy: Policy,
): RealChainStageSpec[] {
  const upscaleFactors = effects.map((effect) => effect.scale);
  const restoreFlags = effects.map((effect) => effect.restore);
  const remaining = computeRemainingUpscaleFactors(
    upscaleFactors.map((upscaleFactor) => ({ upscaleFactor })),
  );

  let preview: ChainGeometryPreview;
  if (policy === 'legacy') {
    preview = { suppressFromIndex: null, finalDownscale: null, finalDownscaleAfterIndex: null };
  } else {
    preview = planChainGeometryPreview({
      sourceDimensions: source,
      targetDimensions: target,
      upscaleFactors,
      restoreFlags,
      restoreSuppression: policy === 'on' ? 'trailing' : 'off',
      // The renderer derives these from the device; the CPU reference run uses
      // the same conservative ceilings. For the 1080p->4K chains these do not
      // fire, but keeping them makes the policy faithful to production.
      limits: { maxDimension: 8192, maxIntermediatePixels: DEFAULT_MAX_INTERMEDIATE_PIXELS },
    });
  }
  const suppressActive = preview.suppressFromIndex !== null;

  const stages: RealChainStageSpec[] = [];
  let curWidth = source.width;
  let curHeight = source.height;

  const emitFinalDownscale = (): void => {
    if (!preview.finalDownscale) return;
    stages.push({
      kind: 'downscale',
      label: 'Downscale',
      width: preview.finalDownscale.width,
      height: preview.finalDownscale.height,
    });
    curWidth = preview.finalDownscale.width;
    curHeight = preview.finalDownscale.height;
  };

  for (let i = 0; i < effects.length; i += 1) {
    if (isSuppressedIndex(preview, upscaleFactors, i)) {
      // A limit-guard preview anchors its final Downscale at the suppressed
      // upscaler's slot; emit it from the pre-upscale texture.
      if (preview.finalDownscaleAfterIndex === i) emitFinalDownscale();
      continue;
    }

    const effect = effects[i];
    const scale = effect.scale;
    const outWidth = Math.round(curWidth * scale);
    const outHeight = Math.round(curHeight * scale);
    stages.push({
      kind: 'effect',
      label: `${effect.key}#${i}`,
      key: effect.key,
      behavior: scale === 1 ? { kind: 'same' } : { kind: 'scale', scale },
    });

    let postWidth = outWidth;
    let postHeight = outHeight;
    if (scale > 1 && !suppressActive) {
      const intermediate = planIntermediateDownscale({
        curWidth: postWidth,
        curHeight: postHeight,
        targetDimensions: target,
        remainingFactor: remaining[i],
      });
      if (intermediate) {
        stages.push({
          kind: 'downscale',
          label: 'Downscale',
          width: intermediate.width,
          height: intermediate.height,
        });
        postWidth = intermediate.width;
        postHeight = intermediate.height;
      }
    }
    curWidth = postWidth;
    curHeight = postHeight;

    if (preview.finalDownscaleAfterIndex === i) emitFinalDownscale();
  }

  return stages;
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

function parseDimensions(value: string, label: string): Dimensions {
  const match = /^(\d+)x(\d+)$/.exec(value.trim());
  if (!match) throw new Error(`invalid ${label} "${value}" (expected WIDTHxHEIGHT)`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

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
      `[passdump] preflight OK; adapter=${preflight.adapterInfo} software=${preflight.software}`,
    );
  } else {
    console.warn(`[passdump] preflight FAILED (${preflight.kind}): ${preflight.error}`);
  }
});

test.afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve) => {
      server!.close(() => resolve());
    });
  }
});

test('dump every pass of the requested modes to PNG', async ({ page }) => {
  // Several minutes per 4K CNN chain under SwiftShader; not a gate.
  test.setTimeout(3_600_000);

  guardGpu(preflight, 'pass dump');

  const inputPath = path.resolve(
    process.env.PASS_DUMP_INPUT ?? path.join(REPO_ROOT, 'e2e', 'testdata', 'videoframe_497385.png'),
  );
  if (!existsSync(inputPath)) throw new Error(`input PNG not found: ${inputPath}`);
  const target = parseDimensions(process.env.PASS_DUMP_TARGET ?? '3840x2160', 'PASS_DUMP_TARGET');
  const modes = (process.env.PASS_DUMP_MODES ?? 'C+A-ultra,A+A-ultra')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const policies = (process.env.PASS_DUMP_POLICIES ?? 'on,off')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean) as Policy[];

  const inputBuffer = readFileSync(inputPath);
  const source = readPngSize(inputBuffer);
  const srcPngBase64 = inputBuffer.toString('base64');
  const baseName = path.basename(inputPath, path.extname(inputPath));

  console.log(
    `[passdump] input=${inputPath} source=${source.width}x${source.height} `
    + `target=${target.width}x${target.height} modes=${modes.join('|')} policies=${policies.join('|')}`,
  );

  await page.goto(origin, { waitUntil: 'domcontentloaded' });

  for (const policy of policies) {
    for (const mode of modes) {
      const effects = MODE_EFFECTS[mode];
      if (!effects) throw new Error(`unknown mode "${mode}"`);

      const stages = buildStages(effects, source, target, policy);
      const outDir = path.join(REPO_ROOT, `${baseName}_${POLICY_TAGS[policy]}`, mode);
      mkdirSync(outDir, { recursive: true });
      // Pass 0 is the decoded source itself, byte-identical to the input file.
      writeFileSync(path.join(outDir, '00-source.png'), inputBuffer);

      console.log(`[passdump] ${policy}/${mode}: ${stages.length} stages -> ${outDir}`);

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
        throw new Error(
          `[passdump] ${policy}/${mode} failed (${result.kind}): ${result.error}`,
        );
      }

      const manifest = {
        mode,
        tier: 'ultra',
        policy,
        togglePreserveDetail: policy === 'legacy' ? null : policy === 'on',
        geometrySuppression: policy === 'legacy' ? 'none' : 'planner',
        restoreSuppression: policy === 'on' ? 'trailing' : 'off',
        source,
        target,
        adapter: result.adapterInfo,
        software: result.software,
        clampHighlightsHead: 'pass-through (stats capture); pixels equal 00-source.png',
        stages: stages.map((stage) => (
          stage.kind === 'effect'
            ? { kind: 'effect', label: stage.label, key: stage.key, behavior: stage.behavior }
            : { kind: 'downscale', label: stage.label, width: stage.width, height: stage.height }
        )),
        dumped: [
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
        ],
      };
      writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

      const listing = manifest.dumped
        .map((entry) => (
          `pass ${String(entry.pass).padStart(2, '0')}  ${entry.file}  `
          + `${entry.width}x${entry.height}  ${entry.key}`
        ))
        .join('\n');
      writeFileSync(path.join(outDir, 'passes.txt'), `${listing}\n`);

      console.log(`[passdump] ${policy}/${mode} wrote ${manifest.dumped.length} entries`);
      // `clampHighlights: true` appends one deferred `ClampHighlightsApply`
      // output after the base stages; the head stats capture is pass-through and
      // is not dumped separately.
      expect(sinked.length, `${policy}/${mode}: dumped stage count`).toBe(stages.length + 1);
    }
  }
});
