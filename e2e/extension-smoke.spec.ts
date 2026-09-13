import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * C2 — Playwright e2e smoke (non-GPU).
 *
 * Loads the production unpacked Chrome extension, waits for the MV3 background
 * service worker, then opens the extension's own pages and asserts they render
 * without uncaught errors. It never touches a real site and never drives video
 * enhancement, so it runs on GPU-less machines/CI.
 */

function collectPageErrors(page: Page): Error[] {
  const errors: Error[] = [];
  page.on('pageerror', (error) => errors.push(error));
  return errors;
}

function expectNoPageErrors(errors: Error[], label: string): void {
  expect(
    errors.map((error) => error.message),
    `Uncaught page error(s) on ${label}`,
  ).toEqual([]);
}

test.describe('extension smoke (no GPU)', () => {
  test('background service worker boots and yields a valid extension id', async ({ extensionId }) => {
    // Chromium extension ids are 32 chars from the a-p alphabet.
    expect(extensionId).toMatch(/^[a-p]{32}$/);
  });

  test('options page loads and renders its containers without page errors', async ({ context, extensionId }) => {
    const page = await context.newPage();
    const errors = collectPageErrors(page);

    await page.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded' });

    await expect(page.locator('#sidebar')).toBeVisible();
    await expect(page.locator('#main-content')).toBeVisible();
    await expect(page.locator('#general-section')).toBeVisible();
    await expect(page.locator('#modes-container')).toBeAttached();
    await expect(page.locator('#rules-container')).toBeAttached();
    await expect(page.locator('#color-grading-sliders')).toBeAttached();

    // Async init populates the version from the manifest; proves the script ran.
    await expect(page.locator('#version-number')).not.toBeEmpty();

    expectNoPageErrors(errors, 'options.html');
    await page.close();
  });

  test('popup page loads and renders its containers without page errors', async ({ context, extensionId }) => {
    const page = await context.newPage();
    const errors = collectPageErrors(page);

    await page.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });

    await expect(page.locator('.card')).toBeVisible();
    await expect(page.locator('#status-badge')).toBeVisible();
    await expect(page.locator('#mode-select')).toBeAttached();
    await expect(page.locator('#resolution-select')).toBeAttached();
    await expect(page.locator('#save-settings')).toBeVisible();
    await expect(page.locator('#open-settings')).toBeVisible();

    expectNoPageErrors(errors, 'popup.html');
    await page.close();
  });
});
