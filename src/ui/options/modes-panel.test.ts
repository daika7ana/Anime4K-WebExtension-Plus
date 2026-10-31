/**
 * Regression test: adding the same catalog effect to two custom modes (or
 * twice to one mode) must store independent objects. `AVAILABLE_EFFECTS` is
 * module-level shared state, so pushing it directly made slider edits bleed
 * between modes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Anime4KWebExtSettings, CustomMode, EnhancementMode } from '@/types';

vi.mock('@utils/settings', () => ({
  getEffectsForMode: (mode: EnhancementMode) => (mode.isBuiltIn ? [] : mode.effects),
  getLocalSettings: async () => ({ restorePolicy: 'off' }),
  saveSettings: vi.fn(async () => {}),
  synchronizeEffectsForCustomModes: (modes: unknown) => modes,
}));

import { initModesPanel } from './modes-panel';
import { AVAILABLE_EFFECTS } from '@utils/effects-map';
import { saveSettings } from '@utils/settings';

function makeState(): Anime4KWebExtSettings {
  const custom: CustomMode = { id: 'custom-1', name: 'Mine', isBuiltIn: false, effects: [] };
  return {
    selectedModeId: 'custom-1',
    targetResolutionSetting: 'x2',
    whitelistEnabled: false,
    whitelist: [],
    customModes: [custom],
    enableCrossOriginFix: false,
    autoEnableOnWhitelist: false,
    autoEnableSettleMs: 300,
    enableHotkey: true,
    colorGrading: {
      enabled: false,
      brightness: 0,
      gamma: 1,
      contrast: 1,
      saturation: 1,
      vibrance: 0,
      exposure: 0,
    },
    performanceTier: 'balanced',
    enhancementModes: [
      { id: 'builtin-mode-a', baseMode: 'A', name: 'Mode A', isBuiltIn: true },
      custom,
    ],
  };
}

describe('modes panel: add effect', () => {
  let container: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  it('pushes an independent copy of the catalog effect', async () => {
    const state = makeState();
    const panel = initModesPanel(
      {
        getState: () => state,
        getTier: () => 'balanced',
        setTier: () => {},
        notifyUpdate: () => {},
      },
      container,
      document.createElement('button'),
      document.createElement('button'),
      document.createElement('button'),
    );
    panel.render();

    const cas = AVAILABLE_EFFECTS.find(e => e.className === 'CAS')!;
    const select = container.querySelector<HTMLSelectElement>('.add-effect-container select')!;
    select.value = cas.id;
    select.dispatchEvent(new Event('change'));
    await new Promise(resolve => setTimeout(resolve, 0));

    const secondSelect = container.querySelector<HTMLSelectElement>('.add-effect-container select')!;
    secondSelect.value = cas.id;
    secondSelect.dispatchEvent(new Event('change'));
    await new Promise(resolve => setTimeout(resolve, 0));

    const effects = state.customModes[0].effects;
    expect(effects).toHaveLength(2);
    expect(effects[0]).not.toBe(effects[1]);
    expect(effects[0]).not.toBe(cas);
    expect(effects[0].params).not.toBe(effects[1].params);

    effects[0].params!.sharpness = 0.9;
    expect(effects[1].params!.sharpness).toBe(0.5);
    expect(cas.params!.sharpness).toBe(0.5);
  });

  it('surfaces a toast instead of an unhandled rejection when the save fails', async () => {
    const state = makeState();
    vi.mocked(saveSettings).mockRejectedValueOnce(
      new Error('QUOTA_BYTES_PER_ITEM quota exceeded'),
    );

    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const panel = initModesPanel(
        {
          getState: () => state,
          getTier: () => 'balanced',
          setTier: () => {},
          notifyUpdate: () => {},
        },
        container,
        document.createElement('button'),
        document.createElement('button'),
        document.createElement('button'),
      );
      panel.render();

      const name = Array.from(container.querySelectorAll('h2')).find(
        el => el.textContent === 'Mine',
      )!;
      name.textContent = 'Renamed';
      name.dispatchEvent(new Event('blur'));
      await new Promise(resolve => setTimeout(resolve, 0));
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(unhandled).not.toHaveBeenCalled();
      const toast = document.querySelector('.anime4k-toast.toast-error');
      expect(toast).not.toBeNull();
      expect(toast!.textContent).toContain('saveFailed');
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('only lets custom modes be dragged', () => {
    const state = makeState();
    const panel = initModesPanel(
      {
        getState: () => state,
        getTier: () => 'balanced',
        setTier: () => {},
        notifyUpdate: () => {},
      },
      container,
      document.createElement('button'),
      document.createElement('button'),
      document.createElement('button'),
    );
    panel.render();

    const cards = Array.from(container.querySelectorAll<HTMLElement>('.mode-card'));
    const builtIn = cards.find(card => card.dataset.modeId === 'builtin-mode-a')!;
    const custom = cards.find(card => card.dataset.modeId === 'custom-1')!;

    // Built-ins always render first and their order is never persisted, so
    // dragging one would reorder the page only until the next reload.
    expect(builtIn.draggable).toBe(false);
    expect(custom.draggable).toBe(true);
  });
});
