#!/usr/bin/env node
/* global console, process, URL, navigator */
// A1: Verify every hand-written WGSL shader compiles in headless Chromium.
//
// Walks src/**/*.wgsl, creates a headless Chromium page with WebGPU enabled
// (SwiftShader/software fallback), creates a GPUDevice, and calls
// `createShaderModule` + `getCompilationInfo()` for each shader. Any
// error-level compilation message fails the check with file + line.
//
// Notes:
// - `navigator.gpu` is only exposed on secure origins, and `about:blank` does
//   not qualify, so a tiny page is served over http://127.0.0.1 (a loopback
//   origin, which Chromium treats as secure).
// - Playwright's headless *shell* does not expose WebGPU; the full Chromium
//   build is selected via `channel: 'chromium'`.
//
// Usage:
//   node scripts/verify-wgsl-compilation.mjs [--allow-skip]
//
// Prerequisite:
//   pnpm exec playwright install chromium
//
// Exit codes:
//   0  all shaders compiled (or --allow-skip was set and WebGPU is unavailable)
//   1  at least one shader failed to compile
//   2  Chromium / WebGPU could not be initialised in this environment

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const rootDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const shaderRoot = path.join(rootDir, 'src');
const allowSkip = process.argv.includes('--allow-skip');

// Chromium flags required to expose WebGPU in headless mode. SwiftShader is a
// CPU fallback so the check still works on GPU-less CI runners.
const CHROMIUM_ARGS = [
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-angle=swiftshader',
  '--use-vulkan=swiftshader',
  '--enable-unsafe-swiftshader',
  '--disable-vulkan-surface',
  '--no-sandbox',
];

const PAGE_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>wgsl-verify</title></head><body></body></html>';

function walkWgsl(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) {
      out.push(...walkWgsl(abs));
    } else if (entry.endsWith('.wgsl')) {
      out.push(abs);
    }
  }
  return out;
}

function reportUnavailable(reason) {
  const message =
    `WebGPU unavailable in this environment: ${reason}\n` +
    'Ensure Chromium is installed (`pnpm exec playwright install chromium`) and\n' +
    'retry on a machine/CI runner that can expose WebGPU. SwiftShader is used as\n' +
    'a software fallback, but some sandboxes still refuse to initialise a device.';
  if (allowSkip) {
    console.log(`SKIP: ${message}`);
    return 0;
  }
  console.error(message);
  return 2;
}

function startServer() {
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(PAGE_HTML);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, origin: `http://127.0.0.1:${address.port}/` });
    });
  });
}

async function main() {
  const shaderFiles = walkWgsl(shaderRoot).sort();
  if (shaderFiles.length === 0) {
    console.log('No .wgsl files found under src/ - nothing to verify.');
    return 0;
  }
  console.log(`Verifying ${shaderFiles.length} WGSL shader(s) with headless Chromium...`);

  const shaders = shaderFiles.map((abs) => ({
    relPath: path.relative(rootDir, abs).split(path.sep).join('/'),
    code: readFileSync(abs, 'utf8'),
  }));

  let server;
  let origin;
  try {
    ({ server, origin } = await startServer());
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return reportUnavailable(`failed to start local verification server (${reason})`);
  }

  let browser;
  try {
    try {
      browser = await chromium.launch({ headless: true, channel: 'chromium', args: CHROMIUM_ARGS });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return reportUnavailable(`failed to launch Chromium (${reason})`);
    }

    const page = await browser.newPage();
    try {
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return reportUnavailable(`failed to load local verification page (${reason})`);
    }

    const outcome = await page.evaluate(async (entries) => {
      if (typeof globalThis.navigator?.gpu === 'undefined') {
        return { unavailable: 'navigator.gpu is not defined' };
      }

      let adapter;
      try {
        adapter = await navigator.gpu.requestAdapter();
      } catch (err) {
        return { unavailable: `requestAdapter() threw: ${err.message}` };
      }
      if (!adapter) {
        return { unavailable: 'requestAdapter() returned null' };
      }

      let device;
      try {
        device = await adapter.requestDevice();
      } catch (err) {
        return { unavailable: `requestDevice() threw: ${err.message}` };
      }

      const results = [];
      for (const entry of entries) {
        try {
          const module = device.createShaderModule({ code: entry.code, label: entry.relPath });
          const info = await module.getCompilationInfo();
          results.push({
            relPath: entry.relPath,
            messages: info.messages.map((m) => ({
              type: m.type,
              message: m.message,
              lineNum: m.lineNum,
              linePos: m.linePos,
            })),
          });
        } catch (err) {
          results.push({
            relPath: entry.relPath,
            messages: [
              {
                type: 'error',
                message: String(err && err.message ? err.message : err),
                lineNum: 0,
                linePos: 0,
              },
            ],
          });
        }
      }
      return { results };
    }, shaders);

    if (outcome.unavailable) {
      return reportUnavailable(outcome.unavailable);
    }

    let errorCount = 0;
    for (const result of outcome.results) {
      for (const msg of result.messages) {
        if (msg.type === 'error') {
          errorCount += 1;
          console.error(`${result.relPath}:${msg.lineNum}:${msg.linePos} error: ${msg.message}`);
        }
      }
    }

    if (errorCount > 0) {
      console.error(`\n${errorCount} WGSL compilation error(s) found.`);
      return 1;
    }
    console.log('All WGSL shaders compiled successfully.');
    return 0;
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

process.exitCode = await main();
