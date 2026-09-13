import { defineConfig } from '@playwright/test';
import baseConfig from './playwright.gpu.config';

/**
 * Heavy chain-ablation experiments, split out of the default GPU gate.
 *
 * These run the real Anime4K CNN chains with per-stage readback and take several
 * minutes each; they are diagnostic, not pass/fail gates. Run them on demand:
 *
 *   pnpm test:gpu:ablation
 *   pnpm test:gpu:ablation e2e/gpu/chain-ablation-wing.spec.ts
 *   pnpm test:gpu:ablation e2e/gpu/pass-dump.spec.ts
 */
export default defineConfig({
  ...baseConfig,
  testIgnore: [],
  testMatch: [
    '**/chain-ablation*.spec.ts',
    '**/pass-dump.spec.ts',
    '**/restore-ab.spec.ts',
    '**/restore-sweep.spec.ts',
    '**/restore-gate.spec.ts',
  ],
});
