/**
 * Whitelist Management panel for the options page.
 *
 * Renders pattern-based whitelist rules with enable/disable toggles
 * and provides add/import/export actions.
 */
import { getSettings, saveSettings } from '@utils/settings';
import { validateRulePattern, removeWhitelistRule, updateWhitelistRule, addWhitelistRule } from '@utils/whitelist';
import type { WhitelistRule } from '@/types';
import { downloadJSON, openFile } from './import-export';
import { t } from '@utils/i18n';
import { showToast } from '../common/toast';

import type { AppContext } from './modes-panel';

export function initWhitelistPanel(
  ctx: AppContext,
  rulesContainer: HTMLElement,
  addRuleBtn: HTMLButtonElement,
  exportBtn: HTMLButtonElement,
  importBtn: HTMLButtonElement,
  autoEnableToggle: HTMLInputElement,
  autoEnableSettleInput: HTMLInputElement,
  whitelistEnabledToggle: HTMLInputElement,
): { render(): void } {

  function render() {
    const state = ctx.getState();
    whitelistEnabledToggle.checked = state.whitelistEnabled;
    autoEnableToggle.checked = state.autoEnableOnWhitelist;
    autoEnableSettleInput.value = String(state.autoEnableSettleMs);
    rulesContainer.textContent = ''; // Clear existing rules
    state.whitelist.forEach((rule) => {
      const row = document.createElement('tr');

      const patternCell = document.createElement('td');
      const patternInput = document.createElement('input');
      patternInput.type = 'text';
      patternInput.value = rule.pattern;
      patternInput.className = 'pattern-input';
      patternInput.addEventListener('change', async (e) => {
        const newPattern = (e.target as HTMLInputElement).value;
        if (validateRulePattern(newPattern)) {
          await updateWhitelistRule(rule.pattern, newPattern);
          rule.pattern = newPattern; // Update state
        } else {
          showToast(t('invalidPattern', 'Invalid pattern format'), 'error');
          (e.target as HTMLInputElement).value = rule.pattern;
        }
      });
      patternCell.appendChild(patternInput);

      const enabledCell = document.createElement('td');
      enabledCell.className = 'cell-center';
      const switchLabel = document.createElement('label');
      switchLabel.className = 'switch';
      const enabledCheckbox = document.createElement('input');
      enabledCheckbox.type = 'checkbox';
      enabledCheckbox.checked = rule.enabled;
      enabledCheckbox.addEventListener('change', async (e) => {
        const enabled = (e.target as HTMLInputElement).checked;
        await updateWhitelistRule(rule.pattern, enabled);
        rule.enabled = enabled; // Update state
      });
      const sliderSpan = document.createElement('span');
      sliderSpan.className = 'slider round';
      switchLabel.appendChild(enabledCheckbox);
      switchLabel.appendChild(sliderSpan);
      enabledCell.appendChild(switchLabel);

      const actionsCell = document.createElement('td');
      const deleteBtn = document.createElement('button');
      deleteBtn.textContent = t('delete', 'Delete');
      deleteBtn.className = 'action-btn';
      deleteBtn.addEventListener('click', async () => {
        await removeWhitelistRule(rule.pattern);
        state.whitelist = state.whitelist.filter(r => r.pattern !== rule.pattern);
        render();
      });
      actionsCell.appendChild(deleteBtn);

      row.appendChild(enabledCell);
      row.appendChild(patternCell);
      row.appendChild(actionsCell);
      rulesContainer.appendChild(row);
    });
  }

  // --- Enable Whitelist Mode Toggle ---
  whitelistEnabledToggle.addEventListener('change', async (e) => {
    const enabled = (e.target as HTMLInputElement).checked;
    ctx.getState().whitelistEnabled = enabled;
    await saveSettings({ whitelistEnabled: enabled });
    ctx.notifyUpdate();
  });

  // --- Auto-enable on Whitelist Toggle ---
  autoEnableToggle.addEventListener('change', async (e) => {
    const enabled = (e.target as HTMLInputElement).checked;
    ctx.getState().autoEnableOnWhitelist = enabled;
    await saveSettings({ autoEnableOnWhitelist: enabled });
    ctx.notifyUpdate();
  });

  // --- Auto-enable Delay (ms) ---
  // Only affects future auto-enables, so it must not trigger a reapply via
  // ctx.notifyUpdate().
  autoEnableSettleInput.addEventListener('change', async (e) => {
    const raw = Number((e.target as HTMLInputElement).value);
    const value = Number.isNaN(raw) ? 300 : Math.min(Math.max(raw, 0), 10000);
    autoEnableSettleInput.value = String(value);
    ctx.getState().autoEnableSettleMs = value;
    await saveSettings({ autoEnableSettleMs: value });
  });

  // --- Add Rule ---
  addRuleBtn.addEventListener('click', async () => {
    const newPattern = '*.example.com/*';
    const state = ctx.getState();
    if (state.whitelist.some(r => r.pattern === newPattern)) {
      showToast(t('ruleAlreadyExists', 'This rule already exists.'), 'error');
      return;
    }
    await addWhitelistRule(newPattern, true);
    // Re-fetch state to reflect changes
    state.whitelist = (await getSettings()).whitelist;
    render();
  });

  // --- Export ---
  exportBtn.addEventListener('click', () => {
    downloadJSON(ctx.getState().whitelist, 'anime4k-whitelist.json');
  });

  // --- Import ---
  importBtn.addEventListener('click', async () => {
    try {
      const json = await openFile();
      const rules = JSON.parse(json);
      if (!Array.isArray(rules)) throw new Error('Invalid format: not an array');

      const validRules: WhitelistRule[] = [];
      for (const rule of rules) {
        if (typeof rule === 'object' && rule.pattern && typeof rule.pattern === 'string' && typeof rule.enabled === 'boolean' && validateRulePattern(rule.pattern)) {
          validRules.push(rule as WhitelistRule);
        } else {
          console.warn('Skipping invalid whitelist rule on import:', rule);
        }
      }

      ctx.getState().whitelist = validRules;
      await saveSettings({ whitelist: ctx.getState().whitelist });
      render();
      showToast(t('importSuccess', 'Import successful'), 'success');
    } catch (error) {
      if (error instanceof Error && error.message === 'No file selected') {
        console.log('File import cancelled.');
        return;
      }
      console.error('Import failed:', error);
      showToast(t('importError', 'Import failed: invalid format or file error.'), 'error');
    }
  });

  return { render };
}
