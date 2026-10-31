import { describe, it, expect, vi, afterEach } from 'vitest';
import { waitForMediaEvent } from './media-events';

function createVideo(): HTMLVideoElement {
  return document.createElement('video');
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('waitForMediaEvent', () => {
  it('resolves when the target event fires', async () => {
    const video = createVideo();
    const promise = waitForMediaEvent(video, 'loadeddata', new Error('timeout'));

    video.dispatchEvent(new Event('loadeddata'));

    await expect(promise).resolves.toBeUndefined();
  });

  it('rejects with the timeout error after timeoutMs', async () => {
    vi.useFakeTimers();
    const video = createVideo();
    const timeoutError = new Error('too slow');
    const promise = waitForMediaEvent(video, 'loadeddata', timeoutError, 5000);
    const assertion = expect(promise).rejects.toBe(timeoutError);

    await vi.advanceTimersByTimeAsync(5000);

    await assertion;
  });

  it('rejects immediately when the video emits error', async () => {
    const video = createVideo();
    const promise = waitForMediaEvent(video, 'loadeddata', new Error('timeout'));

    video.dispatchEvent(new Event('error'));

    await expect(promise).rejects.toThrow('Video failed to load.');
  });

  it('removes both listeners and clears the timer on settle', async () => {
    vi.useFakeTimers();
    const video = createVideo();
    const removeSpy = vi.spyOn(video, 'removeEventListener');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');

    const promise = waitForMediaEvent(video, 'loadeddata', new Error('timeout'), 1000);
    video.dispatchEvent(new Event('loadeddata'));
    await promise;

    expect(removeSpy).toHaveBeenCalledWith('loadeddata', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('error', expect.any(Function));
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });

  it('does not settle a second time after the first settle', async () => {
    vi.useFakeTimers();
    const video = createVideo();
    let rejections = 0;
    const promise = waitForMediaEvent(video, 'loadeddata', new Error('timeout'), 1000);
    promise.catch(() => { rejections += 1; });

    video.dispatchEvent(new Event('loadeddata'));
    await promise;

    // The cleared timer must not fire, and the removed listeners must not react.
    await vi.advanceTimersByTimeAsync(5000);
    video.dispatchEvent(new Event('error'));

    expect(rejections).toBe(0);
  });
});
