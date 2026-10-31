import { defineConfig } from '@playwright/test';

/**
 * C3 Phase 1 — Playwright configuration for the headless-WebGPU correctness
 * gate.
 *
 * Kept separate from `playwright.config.ts` (which stays GPU-free) so the
 * normal `pnpm test:e2e` smoke suite never launches a GPU device.
 *
 * The Chromium flags below are copied verbatim from
 * `scripts/verify-wgsl-compilation.mjs` (its `CHROMIUM_ARGS`): WebGPU in
 * headless mode is only exposed with these, and SwiftShader provides a CPU
 * fallback on GPU-less runners. `channel: 'chromium'` selects the full
 * Chromium build (the headless shell does not expose WebGPU).
 */
const CHROMIUM_ARGS = [
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-angle=swiftshader',
  '--use-vulkan=swiftshader',
  '--enable-unsafe-swiftshader',
  '--disable-vulkan-surface',
  '--no-sandbox',
];

const isCI = Boolean(process.env.CI);

/**
 * Chain-ablation experiments: real-chain per-stage attribution diagnostics.
 * Multi-minute, not pass/fail gates. Run on demand with `pnpm test:gpu:ablation`.
 *
 * `playwright.gpu.ablation.config.ts` matches exactly this list.
 */
export const ABLATION_GPU_SPECS = ['**/chain-ablation*.spec.ts'];

/**
 * PNG dump diagnostics: run a real chain over a still frame and write every
 * pass (or restore variant) to PNG. Expensive (1080p -> 4K CNN chains) and not
 * pass/fail gates. Run on demand with `pnpm test:gpu:dumps`.
 *
 * `playwright.gpu.dumps.config.ts` matches exactly this list.
 */
export const DUMP_GPU_SPECS = [
  '**/pass-dump.spec.ts',
  '**/restore-ab.spec.ts',
  '**/restore-sweep.spec.ts',
  '**/restore-gate.spec.ts',
];

/** Everything excluded from the default `pnpm test:gpu` gate. */
export const HEAVY_GPU_SPECS = [...ABLATION_GPU_SPECS, ...DUMP_GPU_SPECS];

export default defineConfig({
  testDir: './e2e/gpu',

  // Keep the default GPU gate fast: diagnostics run via test:gpu:ablation
  // (chain ablations) and test:gpu:dumps (pass/restore PNG dumps).
  testIgnore: HEAVY_GPU_SPECS,

  // One GPU device at a time; the suite is a numeric gate, not a throughput test.
  fullyParallel: false,
  workers: 1,

  forbidOnly: isCI,
  retries: isCI ? 1 : 0,

  timeout: 60_000,
  expect: { timeout: 10_000 },

  reporter: isCI ? [['github'], ['list']] : [['list']],

  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    {
      name: 'chromium-webgpu',
      use: {
        browserName: 'chromium',
        channel: 'chromium',
        launchOptions: { args: CHROMIUM_ARGS },
      },
    },
  ],
});
