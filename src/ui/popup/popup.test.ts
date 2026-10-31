/**
 * Regression test: opening the popup must not write settings. Loading the popup
 * used to seed the default whitelist and flip `whitelistEnabled` off.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./popup.css', () => ({}));
vi.mock('../common-vars.css', () => ({}));
vi.mock('../common/toast.css', () => ({}));

describe('popup startup', () => {
  afterEach(() => {
    delete (chrome.runtime as any).getManifest;
    delete (chrome.tabs as any).query;
    delete (window as any).matchMedia;
    document.body.innerHTML = '';
  });

  it('opening the popup does not write settings', async () => {
    const html = readFileSync(resolve(process.cwd(), 'src/ui/popup/popup.html'), 'utf8');
    document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;

    (window as any).matchMedia = vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
    }));
    (chrome.runtime as any).getManifest = vi.fn(() => ({ version: '0.7.0' }));
    (chrome.tabs as any).query = vi.fn(async () => []);

    await import('./popup.js');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    // Liveness: the DOMContentLoaded wiring actually ran (otherwise the two
    // assertions above would pass vacuously).
    expect(document.getElementById('version-info')?.textContent).toBe('0.7.0');
  });
});
