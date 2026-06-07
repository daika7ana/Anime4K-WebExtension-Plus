/**
 * Whitelist management module
 * Provides whitelist rule matching, validation, and persistence
 */
import { getSettings, saveSettings } from './settings';
import type { WhitelistRule } from '../types';

/**
 * Validate whitelist rule syntax
 * @param pattern Wildcard pattern
 */
export function validateRulePattern(pattern: string): boolean {
  try {
    // Simple validation: must not be empty and contain at least one valid character
    return pattern.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Check if a URL matches any whitelist rule
 * @param url The URL to check
 * @param rules Array of whitelist rules
 */
export function isUrlWhitelisted(url: string, rules: WhitelistRule[]): boolean {
  if (!rules || rules.length === 0) return false;

  try {
    const parsedUrl = new URL(url);
    // Remove protocol and query parameters
    const baseUrl = parsedUrl.hostname + parsedUrl.pathname;

    const result = rules.some(rule => {
      if (!rule.enabled) return false;

      // Convert wildcard pattern to regular expression
      // Escape all regex metacharacters, then convert wildcards to regex equivalents
      const regexPattern = rule.pattern
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')  // Escape all regex special chars
        .replace(/\*/g, '.*');                     // Then convert wildcards to .*

      // Create a case-insensitive regular expression
      const regex = new RegExp(regexPattern, 'i');
      const matchResult = regex.test(baseUrl);

      return matchResult;
    });

    return result;
  } catch (error) {
    console.error('[Whitelist] URL matching failed:', error);
    return false;
  }
}

/**
 * Add a new rule to the whitelist
 * @param pattern Wildcard pattern
 * @param enabled Whether the rule is enabled
 */
export async function addWhitelistRule(pattern: string, enabled: boolean = true): Promise<void> {
  const { whitelist } = await getSettings();
  const newRule: WhitelistRule = { pattern, enabled };

  const newWhitelist = whitelist || [];

  // Avoid duplicate entries
  if (!newWhitelist.some(r => r.pattern === pattern)) {
    newWhitelist.push(newRule);
    await saveSettings({ whitelist: newWhitelist });

    // Notify that the whitelist has been updated
    chrome.runtime.sendMessage({ type: 'WHITELIST_UPDATED' });
  }
}

/**
 * Remove a whitelist rule
 * @param pattern The rule pattern to remove
 */
export async function removeWhitelistRule(pattern: string): Promise<void> {
  const { whitelist } = await getSettings();

  if (whitelist) {
    const newWhitelist = whitelist.filter(r => r.pattern !== pattern);
    await saveSettings({ whitelist: newWhitelist });

    // Notify that the whitelist has been updated
    chrome.runtime.sendMessage({ type: 'WHITELIST_UPDATED' });
  }
}

/**
 * Update a whitelist rule
 * @param oldPattern The rule pattern to update
 * @param update The update (either a new enabled state or a new pattern)
 */
export async function updateWhitelistRule(oldPattern: string, update: boolean | string): Promise<void> {
  const { whitelist } = await getSettings();

  if (whitelist) {
    const ruleIndex = whitelist.findIndex(r => r.pattern === oldPattern);
    if (ruleIndex !== -1) {
      if (typeof update === 'boolean') {
        // Update enabled state
        whitelist[ruleIndex].enabled = update;
      } else {
        // Update pattern string
        whitelist[ruleIndex].pattern = update;
      }
      await saveSettings({ whitelist });

      // Notify that the whitelist has been updated
      chrome.runtime.sendMessage({ type: 'WHITELIST_UPDATED' });
    }
  }
}

/**
 * Get all current whitelist rules
 */
export async function getWhitelistRules(): Promise<WhitelistRule[]> {
  const settings = await getSettings();
  return settings.whitelist || [];
}

/**
 * Set default whitelist rules
 */
export async function setDefaultWhitelist(): Promise<void> {
  const defaultRules = [
    { pattern: 'ani.gamer.com.tw/animeVideo.php', enabled: true },
    { pattern: 'www.bilibili.com/bangumi/play/*', enabled: true }
  ];

  await saveSettings({
    whitelist: defaultRules,
    whitelistEnabled: false
  });
}