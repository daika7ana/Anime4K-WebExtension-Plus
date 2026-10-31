/** Default cap for waiting on media readiness events (ms). */
export const MEDIA_READY_TIMEOUT_MS = 20_000;

/**
 * Resolve when `event` fires on `video`; reject with `timeoutError` after
 * `timeoutMs`; reject immediately if the video emits `error`.
 * Listeners and timer are always cleaned up exactly once.
 */
export function waitForMediaEvent(
  video: HTMLVideoElement,
  event: string,
  timeoutError: Error,
  timeoutMs: number = MEDIA_READY_TIMEOUT_MS,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Cleanup disarms every other path: it clears the timer and removes both
    // listeners, so only one of the three can ever settle the promise.
    const cleanup = (): void => {
      clearTimeout(timer);
      video.removeEventListener(event, onReady);
      video.removeEventListener('error', onError);
    };

    const onReady = (): void => { cleanup(); resolve(); };
    const onError = (): void => { cleanup(); reject(new Error('Video failed to load.')); };

    const timer = setTimeout(() => { cleanup(); reject(timeoutError); }, timeoutMs);

    video.addEventListener(event, onReady, { once: true });
    video.addEventListener('error', onError, { once: true });
  });
}
