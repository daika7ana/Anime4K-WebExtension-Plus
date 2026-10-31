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
 * RESTORE GATE — end-to-end dump of the production `gate` restore policy.
 *
 * At a 2560x1440 target the A+A-ultra chain (after the injected ClampHighlights
 * head) is `CNNUL, CNNx2UL, Downscale(2560x1440), CNNUL, CNNUL`. The production
 * `gate` policy keeps every restore but wraps each in the shipped
 * `src/shaders/restore-gate.wgsl` amplitude mask:
 *
 *   m = smoothstep(low, high, max9-min9 of encoded Rec.709 luma) * strength
 *   out = mix(input, restoreOut, m)
 *
 * Variants:
 *   ref-off          : CNNUL, CNNx2UL, Downscale                     (R reference)
 *   ref-norestore    : CNNx2UL, Downscale                            (N ceiling)
 *   gate-narrow      : gated CNNUL(0.010,0.014,1.0), CNNx2UL, Downscale,
 *                      gated CNNUL(0.010,0.014,1.0), gated CNNUL(0.010,0.014,1.0)
 *   gate-wide        : same chain, gate (0.006,0.030,1.0)
 *   gate-strength0   : same chain, gate (0.010,0.014,0.0) — wiring sanity; the
 *                      output should equal `ref-norestore`
 *   gate-trailing-narrow : gated CNNUL(0.010,0.014,1.0), CNNx2UL, Downscale
 *   gate-trailing-wide   : same, gate (0.006,0.030,1.0)
 *   off-2k               : CNNUL, CNNx2UL, Downscale, CNNUL, CNNUL   (2K keep-all ref)
 *   gate-keepall-narrow-2k: same, every restore gated (0.006,0.030,1.0)
 *   gate-keepall-loose-2k : same, every restore gated (0.030,0.060,1.0)
 *
 * The `gate-trailing-*` variants are the hybrid under test: gate ONLY the
 * leading restore that the `trailing` suppression policy retains, i.e. the
 * production chain is exactly `ref-off` with its leading CNNUL gated (no
 * trailing 2K restores).
 *
 * 2560x1440 target, keep-every-restore (`gate2`) — 2K now uses the same chain
 * shape as 4K, i.e. both trailing 1440p restores are kept and gated:
 *   off-2k              : CNNUL, CNNx2UL, Downscale, CNNUL, CNNUL   (ungated; face/hpRMS ref)
 *   gate-keepall-narrow-2k: same chain, every restore gated (0.006,0.030,1.0)
 *   gate-keepall-loose-2k : same chain, every restore gated (0.030,0.060,1.0)
 * The wing ceiling N is the existing `ref-norestore` 2K dump (CNNx2UL,
 * Downscale) in `videoframe_497385_gate/`.
 *
 * 3840x2160 target (same 1080p source): no final Downscale is emitted, so the
 * `gate` policy retains all three restores and wraps each (production defaults
 * `gateLow=0.006, gateHigh=0.030, strength=1.0`):
 *   ref4-4k        : CNNUL, CNNx2UL, CNNUL, CNNUL          (R4: all ungated)
 *   gate4-4k       : gated CNNUL(0.006,0.030,1.0), CNNx2UL,
 *                    gated CNNUL(...), gated CNNUL(...)     (G4 wide)
 *   gate4-narrow-4k: same chain, gate (0.010,0.014,1.0)
 *   gate4-tight-4k : same chain, gate (0.004,0.008,1.0)
 *   gate4-loose-4k : same chain, gate (0.030,0.060,1.0)     (higher = bypass more)
 *   gate4-loose2-4k: same chain, gate (0.020,0.050,1.0)
 *   norestore4-4k  : CNNx2UL                                (N4 wing ceiling)
 *
 * Output: `${repo}/videoframe_497385_gate/<variant>/` (legacy 2K) or
 *         `${repo}/videoframe_497385_gate2/<variant>/` (2K keep-all) or
 *         `${repo}/videoframe_497385_gate4/<variant>/` (4K)
 *   `00-source.png`, one PNG per stage, `manifest.json`, `passes.txt`.
 *
 * Diagnostic, not a gate: grouped with the chain-ablation experiments (see
 * `playwright.gpu.ablation.config.ts`) and never runs in the default GPU suite.
 *
 * Env overrides:
 *   GATE_INPUT    input PNG (default `<repo>/e2e/testdata/videoframe_497385.png`)
 *   GATE_VARIANTS comma list of variant ids to dump (default all). Use
 *                 `gate-trailing-narrow,gate-trailing-wide` or
 *                 `ref4-4k,gate4-4k,norestore4-4k` to dump only a subset and
 *                 reuse the existing dumps for the rest.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const TARGET = { width: 2560, height: 1440 };
const TARGET_4K = { width: 3840, height: 2160 };

/** The shipped production gate shader; passed as text so the harness stays src-free. */
const GATE_WGSL = readFileSync(path.join(REPO_ROOT, 'src', 'shaders', 'restore-gate.wgsl'), 'utf8');

interface Dimensions {
  width: number;
  height: number;
}

interface GateDef {
  low: number;
  high: number;
  strength: number;
}

type Part =
  | { kind: 'effect'; key: string; scale: number | null; gate?: GateDef }
  | { kind: 'downscale' };

interface VariantDef {
  id: string;
  stages: RealChainStageSpec[];
  gate: GateDef | null;
  /** Render target; defaults to the 2K `TARGET`. */
  target?: Dimensions;
  /** Output dir suffix (`videoframe_497385_<suffix>`); defaults to `gate`. */
  dirSuffix?: string;
  geometry?: string;
}

const variantTarget = (variant: VariantDef): Dimensions => variant.target ?? TARGET;
const variantDirSuffix = (variant: VariantDef): string => variant.dirSuffix ?? 'gate';
const variantGeometry = (variant: VariantDef): string =>
  variant.geometry ?? 'production ON (no intermediate downscale; one final Downscale)';

/** Build a stage list from compact parts, numbering effect labels by position. */
function chain(parts: readonly Part[]): RealChainStageSpec[] {
  return parts.map((part, index) => {
    if (part.kind === 'downscale') {
      return {
        kind: 'downscale',
        label: 'Downscale',
        width: TARGET.width,
        height: TARGET.height,
      };
    }
    return {
      kind: 'effect',
      label: `${part.key}#${index}`,
      key: part.key,
      behavior: part.scale === null ? { kind: 'same' } : { kind: 'scale', scale: part.scale },
      ...(part.gate ? { gate: { wgsl: GATE_WGSL, ...part.gate } } : {}),
    };
  });
}

const GATE_NARROW: GateDef = { low: 0.01, high: 0.014, strength: 1.0 };
const GATE_WIDE: GateDef = { low: 0.006, high: 0.03, strength: 1.0 };
const GATE_TIGHT: GateDef = { low: 0.004, high: 0.008, strength: 1.0 };
const GATE_LOOSE: GateDef = { low: 0.03, high: 0.06, strength: 1.0 };
const GATE_LOOSE2: GateDef = { low: 0.02, high: 0.05, strength: 1.0 };
const GATE_STRENGTH0: GateDef = { low: 0.01, high: 0.014, strength: 0.0 };

/** The full gated chain: gated CNNUL -> CNNx2UL -> Downscale -> gated CNNUL x2. */
const gatedChain = (gate: GateDef): Part[] => [
  { kind: 'effect', key: 'CNNUL', scale: null, gate },
  { kind: 'effect', key: 'CNNx2UL', scale: 2 },
  { kind: 'downscale' },
  { kind: 'effect', key: 'CNNUL', scale: null, gate },
  { kind: 'effect', key: 'CNNUL', scale: null, gate },
];

/**
 * The hybrid chain: gate only the leading restore the `trailing` policy keeps;
 * `ref-off` with its leading CNNUL gated, no trailing 2K restores.
 */
const gatedTrailingChain = (gate: GateDef): Part[] => [
  { kind: 'effect', key: 'CNNUL', scale: null, gate },
  { kind: 'effect', key: 'CNNx2UL', scale: 2 },
  { kind: 'downscale' },
];

/**
 * The 4K gated chain: at 3840x2160 from the 1080p source no final Downscale is
 * emitted, so the gate policy retains all three restores and wraps each.
 * gated CNNUL (1080p) -> CNNx2UL (4K) -> gated CNNUL (4K) -> gated CNNUL (4K).
 */
const gated4kChain = (gate: GateDef): Part[] => [
  { kind: 'effect', key: 'CNNUL', scale: null, gate },
  { kind: 'effect', key: 'CNNx2UL', scale: 2 },
  { kind: 'effect', key: 'CNNUL', scale: null, gate },
  { kind: 'effect', key: 'CNNUL', scale: null, gate },
];

const VARIANTS: readonly VariantDef[] = [
  {
    id: 'ref-off',
    gate: null,
    stages: chain([
      { kind: 'effect', key: 'CNNUL', scale: null },
      { kind: 'effect', key: 'CNNx2UL', scale: 2 },
      { kind: 'downscale' },
    ]),
  },
  {
    id: 'ref-norestore',
    gate: null,
    stages: chain([
      { kind: 'effect', key: 'CNNx2UL', scale: 2 },
      { kind: 'downscale' },
    ]),
  },
  { id: 'gate-narrow', gate: GATE_NARROW, stages: chain(gatedChain(GATE_NARROW)) },
  { id: 'gate-wide', gate: GATE_WIDE, stages: chain(gatedChain(GATE_WIDE)) },
  { id: 'gate-strength0', gate: GATE_STRENGTH0, stages: chain(gatedChain(GATE_STRENGTH0)) },
  {
    id: 'gate-trailing-narrow',
    gate: GATE_NARROW,
    stages: chain(gatedTrailingChain(GATE_NARROW)),
  },
  {
    id: 'gate-trailing-wide',
    gate: GATE_WIDE,
    stages: chain(gatedTrailingChain(GATE_WIDE)),
  },
  // --- 2560x1440 target, keep every restore (2K now mirrors the 4K chain shape) ---
  {
    id: 'off-2k',
    gate: null,
    dirSuffix: 'gate2',
    geometry: '2K keep-all, ungated (full chain: both trailing 1440p restores kept)',
    stages: chain([
      { kind: 'effect', key: 'CNNUL', scale: null },
      { kind: 'effect', key: 'CNNx2UL', scale: 2 },
      { kind: 'downscale' },
      { kind: 'effect', key: 'CNNUL', scale: null },
      { kind: 'effect', key: 'CNNUL', scale: null },
    ]),
  },
  {
    id: 'gate-keepall-narrow-2k',
    gate: GATE_WIDE,
    dirSuffix: 'gate2',
    geometry: '2K keep-all, every restore gated (0.006/0.030/1.0)',
    stages: chain(gatedChain(GATE_WIDE)),
  },
  {
    id: 'gate-keepall-loose-2k',
    gate: GATE_LOOSE,
    dirSuffix: 'gate2',
    geometry: '2K keep-all, every restore gated (0.030/0.060/1.0)',
    stages: chain(gatedChain(GATE_LOOSE)),
  },
  // --- 3840x2160 target (no final Downscale; gate retains all three restores) ---
  {
    id: 'ref4-4k',
    gate: null,
    target: TARGET_4K,
    dirSuffix: 'gate4',
    geometry: 'production trailing at 4K (no final Downscale; all restores ungated)',
    stages: chain([
      { kind: 'effect', key: 'CNNUL', scale: null },
      { kind: 'effect', key: 'CNNx2UL', scale: 2 },
      { kind: 'effect', key: 'CNNUL', scale: null },
      { kind: 'effect', key: 'CNNUL', scale: null },
    ]),
  },
  {
    id: 'gate4-4k',
    gate: GATE_WIDE,
    target: TARGET_4K,
    dirSuffix: 'gate4',
    geometry: 'production gate at 4K (no final Downscale; all three restores gated 0.006/0.030/1.0)',
    stages: chain(gated4kChain(GATE_WIDE)),
  },
  {
    id: 'gate4-narrow-4k',
    gate: GATE_NARROW,
    target: TARGET_4K,
    dirSuffix: 'gate4',
    geometry: 'gate sweep at 4K (narrow 0.010/0.014/1.0; all three restores gated)',
    stages: chain(gated4kChain(GATE_NARROW)),
  },
  {
    id: 'gate4-tight-4k',
    gate: GATE_TIGHT,
    target: TARGET_4K,
    dirSuffix: 'gate4',
    geometry: 'gate sweep at 4K (tight 0.004/0.008/1.0; all three restores gated)',
    stages: chain(gated4kChain(GATE_TIGHT)),
  },
  {
    id: 'gate4-loose-4k',
    gate: GATE_LOOSE,
    target: TARGET_4K,
    dirSuffix: 'gate4',
    geometry: 'gate sweep at 4K (loose 0.030/0.060/1.0; all three restores gated)',
    stages: chain(gated4kChain(GATE_LOOSE)),
  },
  {
    id: 'gate4-loose2-4k',
    gate: GATE_LOOSE2,
    target: TARGET_4K,
    dirSuffix: 'gate4',
    geometry: 'gate sweep at 4K (loose2 0.020/0.050/1.0; all three restores gated)',
    stages: chain(gated4kChain(GATE_LOOSE2)),
  },
  {
    id: 'norestore4-4k',
    gate: null,
    target: TARGET_4K,
    dirSuffix: 'gate4',
    geometry: 'no restore at 4K (CNNx2UL only)',
    stages: chain([{ kind: 'effect', key: 'CNNx2UL', scale: 2 }]),
  },
];

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
      `[gate] preflight OK; adapter=${preflight.adapterInfo} software=${preflight.software}`,
    );
  } else {
    console.warn(`[gate] preflight FAILED (${preflight.kind}): ${preflight.error}`);
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

test('dump restore-gate policy variants to PNG', async ({ browser }) => {
  // Several minutes per GPU CNN chain under SwiftShader; five variants.
  test.setTimeout(3_600_000);

  guardGpu(preflight, 'restore gate dump');

  const inputPath = path.resolve(
    process.env.GATE_INPUT ?? path.join(REPO_ROOT, 'e2e', 'testdata', 'videoframe_497385.png'),
  );
  if (!existsSync(inputPath)) throw new Error(`input PNG not found: ${inputPath}`);

  const inputBuffer = readFileSync(inputPath);
  const source = readPngSize(inputBuffer);
  const srcPngBase64 = inputBuffer.toString('base64');
  const baseName = path.basename(inputPath, path.extname(inputPath));

  const knownIds = VARIANTS.map((variant) => variant.id).join(', ');
  const requested = (process.env.GATE_VARIANTS ?? VARIANTS.map((variant) => variant.id).join(','))
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const variants = requested.map((id) => {
    const variant = VARIANTS.find((candidate) => candidate.id === id);
    if (!variant) throw new Error(`unknown GATE_VARIANTS id "${id}" (expected ${knownIds})`);
    return variant;
  });

  console.log(
    `[gate] input=${inputPath} source=${source.width}x${source.height} `
    + `variants=${variants.map((v) => `${v.id}@${variantTarget(v).width}x${variantTarget(v).height}`).join('|')}`,
  );

  for (const variant of variants) {
    const target = variantTarget(variant);
    const outDir = path.join(
      REPO_ROOT,
      `${baseName}_${variantDirSuffix(variant)}`,
      variant.id,
    );
    mkdirSync(outDir, { recursive: true });
    // Pass 0 is the decoded source itself, byte-identical to the input file.
    writeFileSync(path.join(outDir, '00-source.png'), inputBuffer);

    console.log(
      `[gate] ${variant.id}: ${variant.stages.length} stages`
      + ` target=${target.width}x${target.height}`
      + `${variant.gate ? ` (gate ${variant.gate.low}/${variant.gate.high}/${variant.gate.strength})` : ''}`
      + ` -> ${outDir}`,
    );

    // A fresh page per variant: closing it releases the variant's GPUDevice and
    // every adapter texture before the next variant allocates.
    const page = await browser.newPage();
    const startedAt = Date.now();
    try {
      await page.goto(origin, { waitUntil: 'domcontentloaded' });

      let counter = 0;
      const sinked: GpuPngDumpStageMeta[] = [];
      const result = await runGpuRealChainPngDump(
        page,
        { srcPngBase64, stages: variant.stages, clampHighlights: true },
        async (meta, pngBase64) => {
          counter += 1;
          const name = `${String(counter).padStart(2, '0')}-${fileLabel(meta)}-`
            + `${meta.width}x${meta.height}.png`;
          writeFileSync(path.join(outDir, name), Buffer.from(pngBase64, 'base64'));
          sinked.push(meta);
        },
      );

      if (!result.ok) {
        throw new Error(`[gate] ${variant.id} failed (${result.kind}): ${result.error}`);
      }

      const expectedCount = variant.stages.length + 1; // + deferred ClampHighlightsApply
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
        mode: 'A+A-ultra',
        tier: 'ultra',
        policy: variant.gate ? 'gate' : 'off',
        gate: variant.gate,
        geometry: variantGeometry(variant),
        source,
        target,
        adapter: result.adapterInfo,
        software: result.software,
        clampHighlightsHead: 'pass-through (stats capture); pixels equal 00-source.png',
        stages: variant.stages.map((stage) => (
          stage.kind === 'effect'
            ? {
                kind: 'effect',
                label: stage.label,
                key: stage.key,
                behavior: stage.behavior,
                gate: stage.gate
                  ? { low: stage.gate.low, high: stage.gate.high, strength: stage.gate.strength }
                  : null,
              }
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

      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(`[gate] ${variant.id} wrote ${dumped.length} entries in ${seconds}s`);
    } finally {
      await page.close();
    }
  }
});
