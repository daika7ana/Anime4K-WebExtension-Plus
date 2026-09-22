/**
 * Centralized internationalization helpers.
 *
 * Replaces scattered `chrome.i18n.getMessage(key) || 'fallback'` patterns
 * and repeated `[data-i18n]` DOM application blocks with a single source of truth.
 */
import type { PerformanceTier } from '@/types';

/**
 * Get a localized message with optional fallback and substitutions.
 *
 * @param key - The i18n message key (e.g. 'settingsSaved')
 * @param fallback - Fallback string if the key is missing. Defaults to the key itself.
 * @param substitutions - Optional substitution values passed to chrome.i18n.getMessage.
 * @returns The localized message, the fallback, or the key (in that order of availability).
 */
export function t(key: string, fallback?: string, substitutions?: string[]): string {
  return chrome.i18n.getMessage(key, substitutions) || fallback || key;
}

/**
 * Apply i18n to all elements with `data-i18n` and `data-i18n-title` attributes under `root`.
 *
 * - `[data-i18n]`: sets `textContent` (or `document.title` if the element is a `<title>` tag).
 *   Only sets text if a message exists for the key (empty messages are skipped).
 * - `[data-i18n-title]`: sets the `title` attribute. Only sets if a message exists.
 *
 * @param root - The root node to search within. Defaults to `document`.
 */
export function applyI18n(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach(element => {
    const key = element.getAttribute('data-i18n');
    if (key) {
      const message = chrome.i18n.getMessage(key);
      if (message) {
        if (element.tagName === 'TITLE') {
          document.title = message;
        } else {
          element.textContent = message;
        }
      }
    }
  });

  root.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach(element => {
    const key = element.getAttribute('data-i18n-title');
    if (key) {
      const message = chrome.i18n.getMessage(key);
      if (message) {
        element.setAttribute('title', message);
      }
    }
  });
}

/**
 * Shared tier presentation (emoji + localized name). Kept in one place so the
 * options tier selector, the benchmark recommendation, and onboarding all show
 * the same icon and label for a tier. Chrome's i18n messages are synchronous,
 * so evaluating this at import time is safe.
 */
export const TIER_DISPLAY: Record<PerformanceTier, { icon: string; name: string }> = {
  performance: { icon: '🚀', name: t('tierPerformance', 'Fast') },
  balanced: { icon: '⚖️', name: t('tierBalanced', 'Balanced') },
  quality: { icon: '🎨', name: t('tierQuality', 'Quality') },
  ultra: { icon: '🔬', name: t('tierUltra', 'Ultra') },
};
