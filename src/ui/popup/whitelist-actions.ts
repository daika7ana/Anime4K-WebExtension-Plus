// whitelist-actions.ts — Whitelist toggle, add-rule, and remove-rule handlers
import { getSettings, saveSettings } from '@utils/settings';
import { addWhitelistRule, getMatchingWhitelistRules, removeWhitelistRules } from '@utils/whitelist';
import { showToast } from '../common/toast';
import { t } from '@utils/i18n';
import type { WhitelistRule } from '../../types';

export interface WhitelistActions {
  /**
   * Swap between the three add buttons and the single remove button based on
   * whether the given URL is covered by the given rules.
   * @returns true when the remove button is shown (URL is whitelisted).
   */
  renderWhitelistControls: (url: string, rules: WhitelistRule[] | null | undefined) => boolean;
}

export function initWhitelistActions(opts: {
  whitelistToggle: HTMLInputElement;
  addCurrentPageBtn: HTMLButtonElement;
  addCurrentDomainBtn: HTMLButtonElement;
  addParentPathBtn: HTMLButtonElement;
  removeFromWhitelistBtn: HTMLButtonElement;
  whitelistButtons: HTMLElement;
}): WhitelistActions {
  const {
    whitelistToggle,
    addCurrentPageBtn,
    addCurrentDomainBtn,
    addParentPathBtn,
    removeFromWhitelistBtn,
    whitelistButtons,
  } = opts;

  // Show the remove button and hide the add buttons when the URL is whitelisted.
  const renderWhitelistControls: WhitelistActions['renderWhitelistControls'] = (url, rules) => {
    const isWhitelisted = getMatchingWhitelistRules(url, rules).length > 0;
    whitelistButtons.hidden = isWhitelisted;
    removeFromWhitelistBtn.hidden = !isWhitelisted;
    return isWhitelisted;
  };

  // After a successful add, re-evaluate from the rule we just persisted rather
  // than re-reading settings: getSettings() has a short TTL cache and the
  // storage.onChanged invalidation may not have fired yet in the same tick.
  const refreshAfterAdd = (url: string, pattern: string): void => {
    renderWhitelistControls(url, [{ pattern, enabled: true }]);
  };

  // Whitelist enable/disable toggle change handler
  whitelistToggle.addEventListener('change', async () => {
    try {
      await saveSettings({ whitelistEnabled: whitelistToggle.checked });
      console.log('Whitelist enabled:', whitelistToggle.checked);
    } catch (error) {
      console.error('Error saving whitelist toggle:', error);
    }
  });

  // "Add to whitelist" button event handlers
  addCurrentPageBtn.addEventListener('click', async () => {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabUrl = tabs[0]?.url;
      if (tabUrl) {
        const url = new URL(tabUrl);
        const cleanUrl = url.hostname + url.pathname;
        await addWhitelistRule(cleanUrl);
        showToast(t('pageAdded', 'URL added to whitelist'), 'success');
        refreshAfterAdd(tabUrl, cleanUrl);
      }
    } catch (error) {
      console.error('Error adding current URL:', error);
      showToast('Failed to add URL to whitelist', 'error');
    }
  });

  addCurrentDomainBtn.addEventListener('click', async () => {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabUrl = tabs[0]?.url;
      if (tabUrl) {
        const url = new URL(tabUrl);
        const pattern = `${url.hostname}/*`;
        await addWhitelistRule(pattern);
        showToast(t('domainAdded', 'Domain added to whitelist'), 'success');
        refreshAfterAdd(tabUrl, pattern);
      }
    } catch (error) {
      console.error('Error adding current domain:', error);
      showToast('Failed to add domain to whitelist', 'error');
    }
  });

  addParentPathBtn.addEventListener('click', async () => {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabUrl = tabs[0]?.url;
      if (tabUrl) {
        const url = new URL(tabUrl);
        const pathParts = url.pathname.split('/').filter(p => p);
        const parentPath = pathParts.length > 1 ? pathParts.slice(0, -1).join('/') : '';
        const pattern = `${url.hostname}/${parentPath}/*`;
        await addWhitelistRule(pattern);
        showToast(t('parentPathAdded', 'Parent path added to whitelist'), 'success');
        refreshAfterAdd(tabUrl, pattern);
      }
    } catch (error) {
      console.error('Error adding parent path:', error);
      showToast('Failed to add parent path to whitelist', 'error');
    }
  });

  // "Remove from whitelist" button handler. Removes every enabled rule that
  // covers the current page in one save, then swaps back to the add buttons.
  removeFromWhitelistBtn.addEventListener('click', async () => {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabUrl = tabs[0]?.url;
      if (!tabUrl) return;

      const { whitelist } = await getSettings();
      const patterns = getMatchingWhitelistRules(tabUrl, whitelist).map(rule => rule.pattern);

      if (patterns.length === 0) {
        // Stale view — nothing actually matches anymore, restore add buttons.
        renderWhitelistControls(tabUrl, whitelist);
        return;
      }

      await removeWhitelistRules(patterns);
      showToast(t('removedFromWhitelist', 'Removed from whitelist'), 'success');
      renderWhitelistControls(tabUrl, []);
    } catch (error) {
      console.error('Error removing from whitelist:', error);
      showToast('Failed to remove from whitelist', 'error');
    }
  });

  return { renderWhitelistControls };
}
