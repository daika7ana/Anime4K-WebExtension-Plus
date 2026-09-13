import { defineConfig } from '@playwright/test';
import baseConfig, { DUMP_GPU_SPECS } from './playwright.gpu.config';

/**
 * PNG pass/restore dump diagnostics, split out of the default GPU gate.
 *
 * Each of these runs a real Anime4K CNN chain over a still frame (default
 * 1080p -> 4K) and writes every pass — or every restore variant — to PNG.
 * They produce artifacts rather than pass/fail results and take minutes each.
 * Run them on demand:
 *
 *   pnpm test:gpu:dumps
 *   pnpm test:gpu:dumps e2e/gpu/pass-dump.spec.ts
 *   PASS_DUMP_TARGET=1280x720 pnpm test:gpu:dumps e2e/gpu/pass-dump.spec.ts
 *
 * Chain-ablation experiments live in the separate `test:gpu:ablation` scope.
 */
export default defineConfig({
  ...baseConfig,
  testIgnore: [],
  testMatch: DUMP_GPU_SPECS,
});
