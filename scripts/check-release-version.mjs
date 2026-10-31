#!/usr/bin/env node
/* global console, process, URL */
// A2: Release version consistency check.
//
// Asserts that the version matches across:
//   - package.json
//   - manifest.json
//   - built dist manifests (dist-chrome/manifest.json, dist-firefox/manifest.json)
//     when those directories have been built
// and, optionally, a release tag passed as `--tag vX.Y.Z`.
//
// Usage:
//   node scripts/check-release-version.mjs [--tag vX.Y.Z]
//
// Exit codes:
//   0  every version matches
//   1  a version mismatch was found

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function readJson(relPath) {
  return JSON.parse(readFileSync(path.join(rootDir, relPath), 'utf8'));
}

function parseArgs(argv) {
  const args = { tag: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--tag') {
      args.tag = argv[i + 1];
      if (!args.tag) throw new Error('--tag requires a value, e.g. --tag v0.7.0');
      i += 1;
    } else if (arg.startsWith('--tag=')) {
      const value = arg.slice('--tag='.length);
      if (!value) throw new Error('--tag requires a value, e.g. --tag v0.7.0');
      args.tag = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

const pkg = readJson('package.json');
const version = pkg.version;
if (!version) {
  console.error('package.json is missing a "version" field.');
  process.exit(1);
}

const errors = [];
const checked = [];
checked.push(`package.json -> ${version}`);

const manifest = readJson('manifest.json');
if (manifest.version !== version) {
  errors.push(`manifest.json version ${manifest.version} != package.json version ${version}`);
} else {
  checked.push(`manifest.json -> ${manifest.version}`);
}

const distManifests = ['dist-chrome/manifest.json', 'dist-firefox/manifest.json'];
for (const rel of distManifests) {
  if (!existsSync(path.join(rootDir, rel))) {
    console.log(`  (skip) ${rel} not built`);
    continue;
  }
  const distManifest = readJson(rel);
  if (distManifest.version !== version) {
    errors.push(`${rel} version ${distManifest.version} != package.json version ${version}`);
  } else {
    checked.push(`${rel} -> ${distManifest.version}`);
  }
}

if (args.tag) {
  const tagVersion = args.tag.replace(/^v/, '');
  if (tagVersion !== version) {
    errors.push(`release tag ${args.tag} (${tagVersion}) != package.json version ${version}`);
  } else {
    checked.push(`tag ${args.tag} -> ${tagVersion}`);
  }
}

console.log('Version consistency check:');
for (const line of checked) console.log(`  ok   ${line}`);

if (errors.length > 0) {
  console.error('\nVersion inconsistency detected:');
  for (const err of errors) console.error(`  x    ${err}`);
  process.exit(1);
}

console.log('\nAll versions are consistent.');
