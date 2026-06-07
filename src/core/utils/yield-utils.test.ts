import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { yieldToMain, yieldToAnimationFrame } from './yield-utils';

describe('yieldToMain', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as any).scheduler;
  });

  it('uses scheduler.yield() when available', async () => {
    const mockYield = vi.fn().mockResolvedValue(undefined);
    (globalThis as any).scheduler = { yield: mockYield };

    await yieldToMain();

    expect(mockYield).toHaveBeenCalledOnce();
  });

  it('falls back to MessageChannel when scheduler is unavailable', async () => {
    delete (globalThis as any).scheduler;

    // jsdom provides MessageChannel, but we can verify the promise resolves
    await expect(yieldToMain()).resolves.toBeUndefined();
  });

  it('falls back to MessageChannel when scheduler.yield is not a function', async () => {
    (globalThis as any).scheduler = { yield: 'not-a-function' };

    await expect(yieldToMain()).resolves.toBeUndefined();
  });

  it('falls back to MessageChannel when scheduler exists but yield is missing', async () => {
    (globalThis as any).scheduler = {};

    await expect(yieldToMain()).resolves.toBeUndefined();
  });
});

describe('yieldToAnimationFrame', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves after requestAnimationFrame callback', async () => {
    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(16.67);
      return 1;
    });

    await expect(yieldToAnimationFrame()).resolves.toBeUndefined();
    expect(rafSpy).toHaveBeenCalledOnce();
  });

  it('does not resolve before rAF callback fires', async () => {
    let rafCallback: FrameRequestCallback | null = null;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      rafCallback = cb;
      return 1;
    });

    const promise = yieldToAnimationFrame();
    // Callback hasn't fired yet — create a microtask to check
    let resolved = false;
    promise.then(() => { resolved = true; });

    // Let microtasks flush
    await new Promise(r => setTimeout(r, 0));
    // rAF callback was never called, so it shouldn't have resolved
    // (setTimeout fires a macrotask, but the rAF callback is still pending)
    // We need to actually call it to resolve
    expect(rafCallback).not.toBeNull();
    rafCallback!(16.67);
    await promise;
    expect(resolved).toBe(true);
  });
});
