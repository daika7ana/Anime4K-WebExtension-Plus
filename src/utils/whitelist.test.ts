import { describe, it, expect } from 'vitest';
import { validateRulePattern, isUrlWhitelisted } from './whitelist';
import type { WhitelistRule } from '../types';

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

  it('wildcard at start of pattern can match prefix of hostname', () => {
    // Pattern "example.com/*" becomes regex ".*example\.com/.*" which matches any prefix
    const rules = makeRules('example.com/*');
    expect(isUrlWhitelisted('https://notexample.com/page', rules)).toBe(true);
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
