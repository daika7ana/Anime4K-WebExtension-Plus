import { test as base, chromium, type BrowserContext } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Loads the built unpacked Chrome extension into a persistent Chromium context
 * and exposes the derived extension id.
 *
 * Notes:
 * - `channel: 'chromium'` selects the full Chromium build (not the headless
 *   shell), which is required for extension loading in headless mode.
 * - No GPU/WebGPU flags are passed: this is a non-GPU smoke suite.
 */
export interface ExtensionFixtures {
  context: BrowserContext;
  extensionId: string;
}

const distPath = path.resolve(__dirname, '..', 'dist-chrome');

export const test = base.extend<ExtensionFixtures>({
  // Playwright requires the fixture function's first argument to be an object
  // destructuring pattern; this fixture declares no dependencies.
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const manifestPath = path.join(distPath, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error(
        `Built extension not found at ${distPath}. Run "pnpm build:chrome" before "pnpm test:e2e".`,
      );
    }

    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anime4k-e2e-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${distPath}`,
        `--load-extension=${distPath}`,
      ],
    });

    try {
      await use(context);
    } finally {
      await context.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  },

  extensionId: async ({ context }, use) => {
    let [serviceWorker] = context.serviceWorkers();
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent('serviceworker');
    }
    const id = new URL(serviceWorker.url()).host;
    await use(id);
  },
});

export { expect } from '@playwright/test';
