/**
 * Tests for the popup's mode guidance: one consolidated source-type
 * description per built-in mode, with the 2× guidance folded into the doubled
 * modes' own copy.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { BaseMode } from '@/types';
import { getModeDescription, initModeGuidance } from './mode-guidance';

const ALL_MODES: BaseMode[] = ['A', 'B', 'C', 'A+A', 'B+B', 'C+A'];
const SINGLE_MODES: BaseMode[] = ['A', 'B', 'C'];
const DOUBLED_MODES: BaseMode[] = ['A+A', 'B+B', 'C+A'];

describe('mode descriptions', () => {
  // Force `t()` to fall back to the canonical source copy so assertions read
  // the fallback text rather than the key returned by the chrome.i18n stub.
  const originalGetMessage = chrome.i18n.getMessage;

  beforeEach(() => {
    chrome.i18n.getMessage = vi.fn(() => '');
  });

  afterEach(() => {
    chrome.i18n.getMessage = originalGetMessage;
  });

  it('has a non-empty fallback for every built-in mode', () => {
    for (const mode of ALL_MODES) {
      expect(getModeDescription(mode).length).toBeGreaterThan(0);
    }
  });

  it('folds the 2× guidance into the doubled modes only', () => {
    for (const mode of DOUBLED_MODES) {
      expect(getModeDescription(mode)).toContain('2×');
    }
    for (const mode of SINGLE_MODES) {
      expect(getModeDescription(mode)).not.toContain('2×');
    }
  });

  it('keeps single-mode copy free of the doubled-mode message', () => {
    for (const mode of SINGLE_MODES) {
      expect(getModeDescription(mode)).not.toContain('Doubled modes');
    }
  });
});

describe('initModeGuidance', () => {
  function setup() {
    const modeSelect = document.createElement('select');
    for (const id of ['builtin-mode-a', 'builtin-mode-aa', 'custom-1']) {
      const opt = document.createElement('option');
      opt.value = id;
      modeSelect.appendChild(opt);
    }
    const descriptionEl = document.createElement('p');
    const guidance = initModeGuidance({ modeSelect, descriptionEl });
    return { modeSelect, descriptionEl, guidance };
  }

  it('shows the selected built-in mode description', () => {
    const { modeSelect, descriptionEl, guidance } = setup();
    modeSelect.value = 'builtin-mode-a';
    guidance.update();
    expect(descriptionEl.hidden).toBe(false);
    expect(descriptionEl.textContent).toBe('modeDescA');
  });

  it('shows the consolidated doubled-mode description without a second message', () => {
    const { modeSelect, descriptionEl, guidance } = setup();
    modeSelect.value = 'builtin-mode-aa';
    guidance.update();
    expect(descriptionEl.hidden).toBe(false);
    expect(descriptionEl.textContent).toBe('modeDescAA');
  });

  it('hides the description for custom modes', () => {
    const { modeSelect, descriptionEl, guidance } = setup();
    modeSelect.value = 'custom-1';
    guidance.update();
    expect(descriptionEl.hidden).toBe(true);
    expect(descriptionEl.textContent).toBe('');
  });

  it('keeps the description in sync on change without blocking selection', () => {
    const { modeSelect, descriptionEl } = setup();
    modeSelect.value = 'builtin-mode-aa';
    modeSelect.dispatchEvent(new Event('change'));
    expect(descriptionEl.hidden).toBe(false);
    expect(descriptionEl.textContent).toBe('modeDescAA');

    // Selection is never disabled or intercepted; the copy simply follows it.
    modeSelect.value = 'builtin-mode-a';
    const changeEvent = new Event('change', { cancelable: true });
    modeSelect.dispatchEvent(changeEvent);
    expect(changeEvent.defaultPrevented).toBe(false);
    expect(modeSelect.disabled).toBe(false);
    expect(modeSelect.value).toBe('builtin-mode-a');
    expect(descriptionEl.textContent).toBe('modeDescA');
  });
});
