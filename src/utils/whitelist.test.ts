import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the persistence + messaging seams so the removal helper can be tested
// in isolation. Full-body `vi.fn()`s are returned inline (factories are hoisted)
// and configured per-test via `vi.mocked(...)`.
vi.mock('./settings', () => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
}));
vi.mock('./messaging', () => ({
  sendMessage: vi.fn(),
}));

import { validateRulePattern, isUrlWhitelisted, getMatchingWhitelistRules, removeWhitelistRules, addWhitelistRule } from './whitelist';
import { getSettings, saveSettings } from './settings';
import { sendMessage } from './messaging';
import type { WhitelistRule, Anime4KWebExtSettings } from '../types';

describe('validateRulePattern', () => {
  it('returns true for a valid non-empty pattern', () => {
    expect(validateRulePattern('example.com')).toBe(true);
  });

  it('returns true for a pattern with wildcards', () => {
    expect(validateRulePattern('*.example.com/*')).toBe(true);
  });

  it('returns false for an empty string', () => {
    expect(validateRulePattern('')).toBe(false);
  });

  it('returns false for whitespace-only string', () => {
    expect(validateRulePattern('   ')).toBe(false);
  });

  it('returns true for a single character', () => {
    expect(validateRulePattern('a')).toBe(true);
  });
});

describe('isUrlWhitelisted', () => {
  const makeRules = (...patterns: string[]): WhitelistRule[] =>
    patterns.map(p => ({ pattern: p, enabled: true }));

  it('returns false when rules array is empty', () => {
    expect(isUrlWhitelisted('https://example.com', [])).toBe(false);
  });

  it('returns false when rules is null/undefined', () => {
    expect(isUrlWhitelisted('https://example.com', null as any)).toBe(false);
    expect(isUrlWhitelisted('https://example.com', undefined as any)).toBe(false);
  });

  it('matches exact hostname + pathname', () => {
    const rules = makeRules('www.bilibili.com/bangumi/play/123');
    expect(isUrlWhitelisted('https://www.bilibili.com/bangumi/play/123', rules)).toBe(true);
  });

  it('matches wildcard in pathname', () => {
    const rules = makeRules('www.bilibili.com/bangumi/play/*');
    expect(isUrlWhitelisted('https://www.bilibili.com/bangumi/play/12345', rules)).toBe(true);
    expect(isUrlWhitelisted('https://www.bilibili.com/bangumi/play/', rules)).toBe(true);
  });

  it('does not match different hostname', () => {
    const rules = makeRules('www.bilibili.com/bangumi/play/*');
    expect(isUrlWhitelisted('https://www.youtube.com/bangumi/play/123', rules)).toBe(false);
  });

  it('ignores disabled rules', () => {
    const rules: WhitelistRule[] = [
      { pattern: 'example.com/*', enabled: false },
    ];
    expect(isUrlWhitelisted('https://example.com/page', rules)).toBe(false);
  });

  it('matches when at least one rule is enabled', () => {
    const rules: WhitelistRule[] = [
      { pattern: 'example.com/*', enabled: false },
      { pattern: 'example.com/page', enabled: true },
    ];
    expect(isUrlWhitelisted('https://example.com/page', rules)).toBe(true);
  });

  it('is case-insensitive', () => {
    const rules = makeRules('Example.COM/Path');
    expect(isUrlWhitelisted('https://example.com/Path', rules)).toBe(true);
    expect(isUrlWhitelisted('https://EXAMPLE.COM/path', rules)).toBe(true);
  });

  it('anchors matching to the full hostname + pathname', () => {
    // Pattern "example.com/*" is anchored, so a different hostname must not match
    const rules = makeRules('example.com/*');
    expect(isUrlWhitelisted('https://notexample.com/page', rules)).toBe(false);
  });

  it('does not match a URL whose path merely starts with the pattern path', () => {
    const rules = makeRules('example.com/watch/123');
    expect(isUrlWhitelisted('https://example.com/watch/123456', rules)).toBe(false);
  });

  it('anchored wildcard still matches a full wildcard URL', () => {
    const rules = makeRules('example.com/*');
    expect(isUrlWhitelisted('https://example.com/anything', rules)).toBe(true);
  });

  it('handles the default bilibili rule', () => {
    const rules = makeRules('www.bilibili.com/bangumi/play/*');
    expect(isUrlWhitelisted('https://www.bilibili.com/bangumi/play/ep123456', rules)).toBe(true);
    expect(isUrlWhitelisted('https://www.bilibili.com/video/BV1xx411c7mD', rules)).toBe(false);
  });

  it('handles the default gamer rule', () => {
    const rules = makeRules('ani.gamer.com.tw/animeVideo.php');
    expect(isUrlWhitelisted('https://ani.gamer.com.tw/animeVideo.php?sn=12345', rules)).toBe(true);
  });

  it('strips query parameters from URL before matching', () => {
    const rules = makeRules('example.com/page');
    expect(isUrlWhitelisted('https://example.com/page?foo=bar', rules)).toBe(true);
  });

  it('handles invalid URL gracefully', () => {
    const rules = makeRules('example.com/*');
    expect(isUrlWhitelisted('not-a-url', rules)).toBe(false);
  });

  it('handles regex special characters in pattern', () => {
    // Parentheses in pattern get escaped; URL spaces get percent-encoded
    const rules = makeRules('example.com/path%20(test)/*');
    expect(isUrlWhitelisted('https://example.com/path%20(test)/foo', rules)).toBe(true);
  });
});

describe('getMatchingWhitelistRules', () => {
  const makeRules = (...patterns: string[]): WhitelistRule[] =>
    patterns.map(p => ({ pattern: p, enabled: true }));

  it('returns every matching enabled rule', () => {
    const rules = makeRules('youtube.com/*', 'youtube.com/watch*', 'example.com/*');
    const matches = getMatchingWhitelistRules('https://youtube.com/watch?v=1', rules);
    expect(matches.map(r => r.pattern)).toEqual(['youtube.com/*', 'youtube.com/watch*']);
  });

  it('excludes disabled rules that would otherwise match', () => {
    const rules: WhitelistRule[] = [
      { pattern: 'example.com/*', enabled: false },
      { pattern: 'example.com/page', enabled: true },
    ];
    const matches = getMatchingWhitelistRules('https://example.com/page', rules);
    expect(matches.map(r => r.pattern)).toEqual(['example.com/page']);
  });

  it('returns an empty array when nothing matches', () => {
    expect(getMatchingWhitelistRules('https://example.com', makeRules('other.com/*'))).toEqual([]);
  });

  it('returns an empty array for an invalid URL', () => {
    expect(getMatchingWhitelistRules('not-a-url', makeRules('example.com/*'))).toEqual([]);
  });

  it('returns an empty array for empty, null, or undefined rules', () => {
    expect(getMatchingWhitelistRules('https://example.com', [])).toEqual([]);
    expect(getMatchingWhitelistRules('https://example.com', null)).toEqual([]);
    expect(getMatchingWhitelistRules('https://example.com', undefined)).toEqual([]);
  });

  it('matches case-insensitively and honours wildcards', () => {
    const rules = makeRules('Example.COM/Path/*');
    expect(getMatchingWhitelistRules('https://example.com/Path/Video', rules)).toHaveLength(1);
  });
});

describe('addWhitelistRule', () => {
  beforeEach(() => {
    vi.mocked(getSettings).mockReset();
    vi.mocked(saveSettings).mockReset();
    vi.mocked(sendMessage).mockReset();
    vi.mocked(saveSettings).mockResolvedValue(undefined);
  });

  it('appends a new rule and notifies', async () => {
    vi.mocked(getSettings).mockResolvedValue({
      whitelist: [{ pattern: 'example.com/*', enabled: true }],
    } as Anime4KWebExtSettings);

    await addWhitelistRule('other.com/page');

    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(saveSettings).toHaveBeenCalledWith({
      whitelist: [
        { pattern: 'example.com/*', enabled: true },
        { pattern: 'other.com/page', enabled: true },
      ],
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({ type: 'WHITELIST_UPDATED' });
  });

  it('is a no-op when the rule already exists and is enabled', async () => {
    vi.mocked(getSettings).mockResolvedValue({
      whitelist: [{ pattern: 'example.com/*', enabled: true }],
    } as Anime4KWebExtSettings);

    await addWhitelistRule('example.com/*');

    expect(saveSettings).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('re-enables and persists an existing disabled rule', async () => {
    vi.mocked(getSettings).mockResolvedValue({
      whitelist: [{ pattern: 'example.com/page', enabled: false }],
    } as Anime4KWebExtSettings);

    await addWhitelistRule('example.com/page');

    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(saveSettings).toHaveBeenCalledWith({
      whitelist: [{ pattern: 'example.com/page', enabled: true }],
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({ type: 'WHITELIST_UPDATED' });
  });
});

describe('removeWhitelistRules', () => {
  beforeEach(() => {
    vi.mocked(getSettings).mockReset();
    vi.mocked(saveSettings).mockReset();
    vi.mocked(sendMessage).mockReset();
    vi.mocked(saveSettings).mockResolvedValue(undefined);
  });

  it('removes all listed patterns in one save and sends one WHITELIST_UPDATED', async () => {
    vi.mocked(getSettings).mockResolvedValue({
      whitelist: [
        { pattern: 'youtube.com/*', enabled: true },
        { pattern: 'youtube.com/watch*', enabled: true },
        { pattern: 'example.com/*', enabled: true },
      ],
    } as Anime4KWebExtSettings);

    await removeWhitelistRules(['youtube.com/*', 'youtube.com/watch*']);

    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(saveSettings).toHaveBeenCalledWith({
      whitelist: [{ pattern: 'example.com/*', enabled: true }],
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({ type: 'WHITELIST_UPDATED' });
  });

  it('does nothing when given no patterns', async () => {
    await removeWhitelistRules([]);

    expect(getSettings).not.toHaveBeenCalled();
    expect(saveSettings).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does nothing when no stored rule matches', async () => {
    vi.mocked(getSettings).mockResolvedValue({
      whitelist: [{ pattern: 'example.com/*', enabled: true }],
    } as Anime4KWebExtSettings);

    await removeWhitelistRules(['nope.com/*']);

    expect(saveSettings).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
