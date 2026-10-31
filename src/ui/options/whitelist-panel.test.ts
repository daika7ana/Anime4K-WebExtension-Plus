/**
 * Regression tests for the whitelist import path: a valid file merges into the
 * existing rules (existing-first, no duplicates) and an invalid file is
 * rejected without touching stored settings.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Anime4KWebExtSettings } from '@/types';

const { saveSettingsMock, showToastMock } = vi.hoisted(() => ({
  saveSettingsMock: vi.fn(async () => {}),
  showToastMock: vi.fn(),
}));

vi.mock('@utils/settings', () => ({
  getSettings: vi.fn(async () => ({})),
  saveSettings: saveSettingsMock,
}));
vi.mock('../common/toast', () => ({ showToast: showToastMock }));

import { initWhitelistPanel } from './whitelist-panel';

function makeState(): Anime4KWebExtSettings {
  return {
    whitelist: [{ pattern: 'a.com/*', enabled: true }],
    whitelistEnabled: true,
    autoEnableOnWhitelist: false,
    autoEnableSettleMs: 300,
  } as Anime4KWebExtSettings;
}

function setup(state: Anime4KWebExtSettings): HTMLButtonElement {
  const importBtn = document.createElement('button');
  const panel = initWhitelistPanel(
    { getState: () => state, getTier: () => 'balanced', setTier: vi.fn(), notifyUpdate: vi.fn() },
    document.createElement('div'),
    document.createElement('button'),
    document.createElement('button'),
    importBtn,
    document.createElement('input'),
    document.createElement('input'),
    document.createElement('input'),
  );
  panel.render();
  return importBtn;
}

let fileInput: HTMLInputElement | null = null;

async function importFile(importBtn: HTMLButtonElement, contents: unknown): Promise<void> {
  // openFile() creates a detached <input type=file> and clicks it, so capture
  // that element from the prototype click hook instead of the DOM.
  const clickSpy = vi
    .spyOn(HTMLInputElement.prototype, 'click')
    .mockImplementation(function (this: HTMLInputElement) {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      fileInput = this;
    });
  importBtn.click();
  clickSpy.mockRestore();

  const input = fileInput;
  if (!input) throw new Error('openFile() did not create a file input');
  Object.defineProperty(input, 'files', {
    value: [{ text: async () => JSON.stringify(contents) }],
    configurable: true,
  });
  input.dispatchEvent(new Event('change'));
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('whitelist panel import', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    fileInput = null;
    saveSettingsMock.mockClear();
    showToastMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('merges a valid file into the existing whitelist (existing-first, no duplicates)', async () => {
    const state = makeState();
    const importBtn = setup(state);

    await importFile(importBtn, [
      { pattern: 'a.com/*', enabled: true },
      { pattern: 'b.com/*', enabled: true },
    ]);

    expect(saveSettingsMock).toHaveBeenCalledTimes(1);
    expect(saveSettingsMock).toHaveBeenCalledWith({
      whitelist: [
        { pattern: 'a.com/*', enabled: true },
        { pattern: 'b.com/*', enabled: true },
      ],
    });
    expect(state.whitelist.map(rule => rule.pattern)).toEqual(['a.com/*', 'b.com/*']);
    expect(showToastMock).toHaveBeenCalledWith(expect.any(String), 'success');
  });

  it('rejects the whole file when any pattern is invalid', async () => {
    const state = makeState();
    const importBtn = setup(state);

    // Internal whitespace survives normalisation (only the scheme and the
    // query/fragment are stripped), so this stays a genuine rejection.
    await importFile(importBtn, [{ pattern: 'x.com/a b', enabled: true }]);

    expect(saveSettingsMock).not.toHaveBeenCalled();
    expect(state.whitelist).toEqual([{ pattern: 'a.com/*', enabled: true }]);
    expect(showToastMock).toHaveBeenCalledWith(expect.any(String), 'error');
  });
});
