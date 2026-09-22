import { defineConfig } from '@playwright/test';

/**
 * C2 — Playwright e2e smoke configuration.
 *
 * This suite is intentionally GPU-free: it only loads the production Chrome
 * build as an unpacked MV3 extension and checks that the background service
 * worker plus extension pages (options/popup) boot cleanly. Real video
 * enhancement / WebGPU is covered by `pnpm verify:wgsl` on a capable runner.
 *
 * The actual browser is launched with `chromium.launchPersistentContext()` from
 * `e2e/fixtures.ts` because Chromium only loads extensions from a persistent
 * profile. The project below exists so the runner has a chromium target; it
 * deliberately adds no GPU/channel flags of its own.
 */
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: './e2e',

  // The WebGPU correctness gate lives in e2e/gpu and is run separately via
  // `pnpm test:gpu` (playwright.gpu.config.ts). Excluding it here keeps this
  // suite GPU-free, as its header and .github/workflows/e2e.yml promise.
  testIgnore: '**/gpu/**',

  // Extensions share one persistent profile per test; never parallelise them.
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
      name: 'chromium-extension',
      use: { browserName: 'chromium' },
    },
  ],
});
