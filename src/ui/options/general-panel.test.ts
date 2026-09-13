/**
 * Regression tests for the General panel's restore-policy select.
 *
 * The options page does not receive its own cross-context `SETTINGS_UPDATED`
 * message, so the select must explicitly refresh the modes panel to keep the
 * restore-policy note in sync with the saved setting.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { saveLocalSettings, getLocalSettings, saveSettings } = vi.hoisted(() => ({
  saveLocalSettings: vi.fn().mockResolvedValue(undefined),
  getLocalSettings: vi.fn().mockResolvedValue({}),
  saveSettings: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@utils/settings', () => ({
  saveLocalSettings: (...args: unknown[]) => saveLocalSettings(...args),
  getLocalSettings: (...args: unknown[]) => getLocalSettings(...args),
  saveSettings: (...args: unknown[]) => saveSettings(...args),
}));

vi.mock('../theme-manager', () => ({
  themeManager: { getTheme: () => 'auto', setTheme: vi.fn() },
}));

vi.mock('./color-grading-panel', () => ({
  renderColorGradingSliders: vi.fn(),
  setColorGradingSlidersEnabled: vi.fn(),
}));

import { initGeneralPanel } from './general-panel';
import type { AppContext } from './modes-panel';

function createElements() {
  const restorePolicySelect = document.createElement('select');
  for (const value of ['off', 'gate', 'trailing', 'leading']) {
    const option = document.createElement('option');
    option.value = value;
    restorePolicySelect.appendChild(option);
  }
  return {
    crossOriginFixToggle: document.createElement('input'),
    themeSelect: document.createElement('select'),
    tierSelect: document.createElement('select'),
    colorGradingToggle: document.createElement('input'),
    colorGradingSliders: document.createElement('div'),
    versionNumberSpan: document.createElement('span'),
    enableHotkeyToggle: document.createElement('input'),
    diagnosticsToggle: document.createElement('input'),
    restorePolicySelect,
    diagnosticsDetailSelect: document.createElement('select'),
  };
}

function createContext(overrides: Partial<AppContext> = {}): AppContext {
  return {
    getState: () => ({ colorGrading: { enabled: true } }) as unknown as ReturnType<AppContext['getState']>,
    getTier: () => 'balanced',
    setTier: vi.fn(),
    refresh: vi.fn().mockResolvedValue(undefined),
    notifyUpdate: vi.fn(),
    ...overrides,
  };
}

function initWithElements(ctx: AppContext, els: ReturnType<typeof createElements>): void {
  initGeneralPanel(
    ctx,
    els.crossOriginFixToggle,
    els.themeSelect,
    els.tierSelect,
    els.colorGradingToggle,
    els.colorGradingSliders,
    els.versionNumberSpan,
    els.enableHotkeyToggle,
    els.diagnosticsToggle,
    els.restorePolicySelect,
    els.diagnosticsDetailSelect,
  );
}

describe('initGeneralPanel — restore policy select', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    saveLocalSettings.mockClear();
    getLocalSettings.mockClear();
    saveSettings.mockClear();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('saves the setting, refreshes the modes panel, and notifies on change', async () => {
    const els = createElements();
    const refreshModesPanel = vi.fn();
    const notifyUpdate = vi.fn();
    const ctx = createContext({ refreshModesPanel, notifyUpdate });

    initWithElements(ctx, els);

    els.restorePolicySelect.value = 'trailing';
    els.restorePolicySelect.dispatchEvent(new Event('change'));
    await Promise.resolve();
    await Promise.resolve();

    expect(saveLocalSettings).toHaveBeenCalledWith({ restorePolicy: 'trailing' });
    expect(refreshModesPanel).toHaveBeenCalledTimes(1);
    expect(notifyUpdate).toHaveBeenCalledTimes(1);
  });

  it('ignores an unknown policy value', async () => {
    const els = createElements();
    const ctx = createContext();

    initWithElements(ctx, els);

    els.restorePolicySelect.value = 'bogus';
    els.restorePolicySelect.dispatchEvent(new Event('change'));
    await Promise.resolve();
    await Promise.resolve();

    expect(saveLocalSettings).not.toHaveBeenCalled();
  });

  it('does not throw when no modes-panel refresher has been registered', async () => {
    const els = createElements();
    const ctx = createContext();

    initWithElements(ctx, els);

    els.restorePolicySelect.value = 'off';
    expect(() => els.restorePolicySelect.dispatchEvent(new Event('change'))).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(saveLocalSettings).toHaveBeenCalledWith({ restorePolicy: 'off' });
  });
});
