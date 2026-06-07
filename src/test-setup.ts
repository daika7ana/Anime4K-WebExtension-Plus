import { vi } from 'vitest';

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
    onMessage: { addListener: vi.fn() },
  },
  i18n: {
    getMessage: vi.fn((key: string) => key),
  },
});
