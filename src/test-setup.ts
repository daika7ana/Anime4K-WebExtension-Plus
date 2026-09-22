import { vi } from 'vitest';

// jsdom does not implement canvas rendering contexts (the optional native
// `canvas` package is not installed), so `getContext()` logs a jsdom
// "Not implemented" error for '2d'/'webgl'/'webgl2' before returning null.
// Return null directly for those ids — the same value jsdom yields — so tests
// that exercise WebGL/2D fallbacks do not spam the console. Tests that need a
// real context spy on or override this prototype method themselves.
const JSDOM_UNIMPLEMENTED_CONTEXT_IDS = new Set([
  '2d',
  'webgl',
  'webgl2',
  'experimental-webgl',
  'bitmaprenderer',
]);
const jsdomGetContext = HTMLCanvasElement.prototype.getContext;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(HTMLCanvasElement.prototype as any).getContext = function (
  this: HTMLCanvasElement,
  contextId: string,
  ...args: unknown[]
) {
  if (JSDOM_UNIMPLEMENTED_CONTEXT_IDS.has(contextId)) {
    return null;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (jsdomGetContext as any).apply(this, [contextId, ...args]);
};

// Chrome extension APIs are unavailable in Node.js test environment.
// This setup file stubs them before any source modules are imported.
vi.stubGlobal('chrome', {
  storage: {
    sync: {
      get: vi.fn((_keys: any, cb: any) => cb?.({})),
      set: vi.fn((_data: any, cb?: any) => cb?.()),
    },
    local: {
      get: vi.fn((_keys: any, cb: any) => cb?.({})),
      set: vi.fn((_data: any, cb?: any) => cb?.()),
    },
    onChanged: { addListener: vi.fn() },
  },
  runtime: {
    lastError: null,
    sendMessage: vi.fn(),
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  tabs: { sendMessage: vi.fn() },
  i18n: {
    getMessage: vi.fn((key: string) => key),
  },
});
