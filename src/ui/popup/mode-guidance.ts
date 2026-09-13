/**
 * mode-guidance.ts — Source-type descriptions for the popup's mode picker.
 *
 * One consolidated description per built-in mode, so a mode can be picked by
 * source type rather than by its letter alone. The doubled modes (A+A / B+B /
 * C+A) fold the 2× guidance into that same message instead of showing a second
 * stacked caution: they are meant for 2× or higher, and at lower targets they
 * can oversharpen and degrade the image.
 *
 * This is guidance only — nothing here disables or blocks selecting a mode.
 */
import type { BaseMode } from '@/types';
import { BUILTIN_MODES } from '@utils/settings';
import { t } from '@utils/i18n';

/** Concise, source-oriented copy for each built-in mode. */
export const MODE_DESCRIPTIONS: Record<BaseMode, { key: string; fallback: string }> = {
  'A': {
    key: 'modeDescA',
    fallback: 'For most 1080p anime, older 720p, and blurry or heavily compressed SD.',
  },
  'B': {
    key: 'modeDescB',
    fallback: 'For most 720p and 1080p→720p downscales with ringing or aliasing.',
  },
  'C': {
    key: 'modeDescC',
    fallback: 'For clean, undegraded sources: digital art, wallpapers, and 1080p→480p downscales.',
  },
  'A+A': {
    key: 'modeDescAA',
    fallback:
      'For the same sources as Mode A, with extra detail. Doubled modes are meant for 2× or higher; at lower targets they can oversharpen, so a single mode is recommended.',
  },
  'B+B': {
    key: 'modeDescBB',
    fallback:
      'For the same sources as Mode B, with extra detail. Doubled modes are meant for 2× or higher; at lower targets they can oversharpen, so a single mode is recommended.',
  },
  'C+A': {
    key: 'modeDescCA',
    fallback:
      'For clean C-class sources that look too soft. Doubled modes are meant for 2× or higher; at lower targets they can oversharpen, so a single mode is recommended.',
  },
};

export function getModeDescription(baseMode: BaseMode): string {
  const entry = MODE_DESCRIPTIONS[baseMode];
  return t(entry.key, entry.fallback);
}

/**
 * Keep the description in sync with the selected mode. Returns an `update`
 * function so callers can refresh after populating the select programmatically
 * (which does not fire a change event). Custom modes have no description and
 * hide the element.
 */
export function initModeGuidance(opts: {
  modeSelect: HTMLSelectElement;
  descriptionEl?: HTMLElement | null;
}): { update: () => void } {
  const { modeSelect, descriptionEl } = opts;

  const selectedBaseMode = (): BaseMode | null =>
    BUILTIN_MODES.find(mode => mode.id === modeSelect.value)?.baseMode ?? null;

  const update = (): void => {
    const baseMode = selectedBaseMode();
    const description = baseMode ? getModeDescription(baseMode) : '';
    if (descriptionEl) {
      descriptionEl.textContent = description;
      descriptionEl.hidden = description === '';
    }
  };

  modeSelect.addEventListener('change', update);

  return { update };
}
