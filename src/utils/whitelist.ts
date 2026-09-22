/**
 * Whitelist management module
 * Provides whitelist rule matching, validation, and persistence
 */
import { getSettings, saveSettings } from './settings';
import { sendMessage } from './messaging';
import type { WhitelistRule } from '../types';

/**
 * Validate whitelist rule syntax
 * @param pattern Wildcard pattern
 */
export function validateRulePattern(pattern: string): boolean {
  // Simple validation: must not be empty and contain at least one valid character
  return pattern.trim().length > 0;
}

/**
 * Get every enabled whitelist rule whose wildcard pattern matches the URL.
 *
 * Matching semantics are identical to the previous `isUrlWhitelisted`
 * implementation: protocol and query string are stripped, patterns are
 * case-insensitive, and `*` is the only wildcard.
 *
 * @param url The URL to check
 * @param rules Whitelist rules (may be null/undefined)
 * @returns The enabled rules that match; empty for no rules or an invalid URL
 */
export function getMatchingWhitelistRules(
  url: string,
  rules: WhitelistRule[] | null | undefined,
): WhitelistRule[] {
  if (!rules || rules.length === 0) return [];

  try {
    const parsedUrl = new URL(url);
    // Remove protocol and query parameters
    const baseUrl = parsedUrl.hostname + parsedUrl.pathname;

    return rules.filter(rule => {
      if (!rule.enabled) return false;

      // Convert wildcard pattern to regular expression
      // Escape all regex metacharacters, then convert wildcards to regex equivalents
      const regexPattern = rule.pattern
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')  // Escape all regex special chars
        .replace(/\*/g, '.*');                     // Then convert wildcards to .*

      // Create a case-insensitive, fully anchored regular expression
      const regex = new RegExp(`^${regexPattern}$`, 'i');
      return regex.test(baseUrl);
    });
  } catch (error) {
    console.error('[Whitelist] URL matching failed:', error);
    return [];
  }
}

/**
 * Check if a URL matches any enabled whitelist rule
 * @param url The URL to check
 * @param rules Array of whitelist rules
 */
export function isUrlWhitelisted(url: string, rules: WhitelistRule[]): boolean {
  return getMatchingWhitelistRules(url, rules).length > 0;
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

  const existingRule = newWhitelist.find(r => r.pattern === pattern);

  if (existingRule) {
    // Already enabled — nothing to do.
    if (existingRule.enabled) return;

    // Re-enable the previously disabled rule and persist the change.
    existingRule.enabled = true;
    await saveSettings({ whitelist: newWhitelist });

    // Notify that the whitelist has been updated
    sendMessage({ type: 'WHITELIST_UPDATED' });
    return;
  }

  newWhitelist.push(newRule);
  await saveSettings({ whitelist: newWhitelist });

  // Notify that the whitelist has been updated
  sendMessage({ type: 'WHITELIST_UPDATED' });
}

/**
 * Remove several whitelist rules in a single persist + notification.
 *
 * @param patterns Rule patterns to remove. If empty, or if no stored rule
 *   matches, this is a no-op.
 */
export async function removeWhitelistRules(patterns: string[]): Promise<void> {
  if (patterns.length === 0) return;

  const { whitelist } = await getSettings();
  if (!whitelist || whitelist.length === 0) return;

  const patternSet = new Set(patterns);
  const newWhitelist = whitelist.filter(r => !patternSet.has(r.pattern));

  // Nothing matched — avoid a pointless save/notification
  if (newWhitelist.length === whitelist.length) return;

  await saveSettings({ whitelist: newWhitelist });

  // Notify that the whitelist has been updated
  sendMessage({ type: 'WHITELIST_UPDATED' });
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
      sendMessage({ type: 'WHITELIST_UPDATED' });
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