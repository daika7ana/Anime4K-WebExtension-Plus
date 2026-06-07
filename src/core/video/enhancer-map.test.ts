import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  associateEnhancer,
  getEnhancer,
  hasEnhancer,
  dissociateEnhancer,
  getAllManagedVideos,
  clearAll,
} from './enhancer-map';

// Minimal mock VideoEnhancer — just enough to be a Map value
const mockEnhancer = { destroy: vi.fn(), detach: vi.fn() } as any;

function makeVideo(): HTMLVideoElement {
  return document.createElement('video') as HTMLVideoElement;
}

describe('enhancer-map', () => {
  // Each test gets a fresh module state via clearAll
  beforeEach(() => {
    clearAll();
    vi.clearAllMocks();
  });

  it('starts empty', () => {
    expect(getAllManagedVideos()).toEqual([]);
  });

  it('associate + get + has round-trip', () => {
    const v = makeVideo();
    associateEnhancer(v, mockEnhancer);

    expect(hasEnhancer(v)).toBe(true);
    expect(getEnhancer(v)).toBe(mockEnhancer);
    expect(getAllManagedVideos()).toEqual([v]);
  });

  it('getEnhancer returns undefined for unknown video', () => {
    expect(getEnhancer(makeVideo())).toBeUndefined();
  });

  it('hasEnhancer returns false for unknown video', () => {
    expect(hasEnhancer(makeVideo())).toBe(false);
  });

  it('dissociateEnhancer removes the mapping', () => {
    const v = makeVideo();
    associateEnhancer(v, mockEnhancer);
    dissociateEnhancer(v);

    expect(hasEnhancer(v)).toBe(false);
    expect(getEnhancer(v)).toBeUndefined();
    expect(getAllManagedVideos()).toEqual([]);
  });

  it('dissociateEnhancer is safe for unknown video (no-op)', () => {
    expect(() => dissociateEnhancer(makeVideo())).not.toThrow();
  });

  it('clearAll removes all entries', () => {
    const v1 = makeVideo();
    const v2 = makeVideo();
    associateEnhancer(v1, mockEnhancer);
    associateEnhancer(v2, { destroy: vi.fn() } as any);

    clearAll();

    expect(getAllManagedVideos()).toEqual([]);
    expect(hasEnhancer(v1)).toBe(false);
    expect(hasEnhancer(v2)).toBe(false);
  });

  it('multiple videos tracked independently', () => {
    const v1 = makeVideo();
    const v2 = makeVideo();
    const e1 = { destroy: vi.fn(), id: 'e1' } as any;
    const e2 = { destroy: vi.fn(), id: 'e2' } as any;

    associateEnhancer(v1, e1);
    associateEnhancer(v2, e2);

    expect(getEnhancer(v1)).toBe(e1);
    expect(getEnhancer(v2)).toBe(e2);
    expect(getAllManagedVideos()).toHaveLength(2);
  });

  it('re-associating same video replaces old enhancer', () => {
    const v = makeVideo();
    const e1 = { destroy: vi.fn() } as any;
    const e2 = { destroy: vi.fn() } as any;

    associateEnhancer(v, e1);
    associateEnhancer(v, e2);

    expect(getEnhancer(v)).toBe(e2);
    expect(getAllManagedVideos()).toHaveLength(1);
  });
});
