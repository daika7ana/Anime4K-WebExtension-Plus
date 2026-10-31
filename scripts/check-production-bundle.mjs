#!/usr/bin/env node
/* global console, process, URL */
// A2: Production bundle scan.
//
// Verifies that the built extension bundles (dist-chrome / dist-firefox)
// contain the expected manifest + entry points and that no test-only tokens
// leaked into the shipped JavaScript.
//
// Usage:
//   node scripts/check-production-bundle.mjs
//
// Exit codes:
//   0  bundles are complete and clean
//   1  a missing file or leaked forbidden token was found

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const DIST_TARGETS = ['dist-chrome', 'dist-firefox'];

// --- Forbidden test-only tokens -------------------------------------------
// Any of these appearing in shipped JavaScript means test/dev-only code has
// leaked into the production bundle. Matching is case-insensitive and
// word-boundary anchored so the tokens cannot false-positive inside unrelated
// identifiers (e.g. `vitest` inside `myvitestHelper`).
const FORBIDDEN_TOKENS = [
  'vitest',
  'playwright',
  'webgpu-mock',
  'test-setup',
  '__tests__',
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const FORBIDDEN_TOKEN_PATTERNS = FORBIDDEN_TOKENS.map((token) => ({
  token,
  pattern: new RegExp(`\\b${escapeRegExp(token)}\\b`, 'i'),
}));
// --------------------------------------------------------------------------

// Entry points emitted by webpack plus the copied manifest/rules and the
// native CSS extracted for each UI entry point.
const REQUIRED_FILES = [
  'manifest.json',
  'background.js',
  'content.js',
  'popup.js',
  'popup.html',
  'popup.css',
  'options.js',
  'options.html',
  'options.css',
  'onboarding.js',
  'onboarding.html',
  'onboarding.css',
  'rules.json',
];

function walkFiles(dir, predicate) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      out.push(...walkFiles(abs, predicate));
    } else if (predicate(abs)) {
      out.push(abs);
    }
  }
  return out;
}

const problems = [];

for (const target of DIST_TARGETS) {
  const distDir = path.join(rootDir, target);
  if (!existsSync(distDir)) {
    problems.push(`Missing build output: ${target}/ - run "pnpm build:chrome" / "pnpm build:firefox" first.`);
    continue;
  }

  for (const required of REQUIRED_FILES) {
    if (!existsSync(path.join(distDir, required))) {
      problems.push(`${target}/${required} is missing from the production bundle.`);
    }
  }

  // Code-split chunks (e.g. the bundled Anime4K library) are fetched at runtime
  // by the content script through chrome.runtime.getURL. That only works while
  // they are web-accessible - deleting this block breaks enhancement with no
  // visible error, so guard it here.
  const manifestPath = path.join(distDir, 'manifest.json');
  if (existsSync(manifestPath)) {
    let manifest = null;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      problems.push(`${target}/manifest.json is not valid JSON: ${error.message}`);
    }
    const servesJs = (manifest?.web_accessible_resources ?? []).some((entry) =>
      (entry.resources ?? []).some((pattern) => pattern.endsWith('.js')),
    );
    if (manifest && !servesJs) {
      problems.push(
        `${target}/manifest.json must keep web_accessible_resources for "*.js": ` +
          'webpack async chunks are loaded via chrome.runtime.getURL and enhancement fails without it.',
      );
    }
  }

  // Scan every shipped text asset, not just JS: a leaked test hook in HTML or
  // CSS is just as visible to a page.
  const scannedFiles = walkFiles(
    distDir,
    (abs) => abs.endsWith('.js') || abs.endsWith('.html') || abs.endsWith('.css'),
  );
  for (const file of scannedFiles) {
    const content = readFileSync(file, 'utf8');
    for (const { token, pattern } of FORBIDDEN_TOKEN_PATTERNS) {
      const match = pattern.exec(content);
      if (match) {
        const index = match.index;
        const before = content.slice(0, index);
        const line = before.split('\n').length;
        const column = index - before.lastIndexOf('\n');
        problems.push(
          `${path.relative(rootDir, file)}:${line}:${column} contains forbidden test-only token "${token}".`,
        );
      }
    }
  }
  console.log(`Scanned ${scannedFiles.length} bundle file(s) in ${target}/.`);
}

if (problems.length > 0) {
  console.error('\nProduction bundle check failed:');
  for (const problem of problems) console.error(`  x    ${problem}`);
  process.exit(1);
}

console.log('Production bundles look clean: expected files present, no test-only tokens.');
