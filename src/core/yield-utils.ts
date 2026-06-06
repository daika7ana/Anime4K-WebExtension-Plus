/**
 * Yield utilities for keeping the main thread responsive during heavy work.
 *
 * `requestAnimationFrame` aligns with the display refresh cycle (~16.6ms at 60fps),
 * which is too slow for yielding between short bursts of work. These utilities
 * yield the main thread more efficiently so the browser can process input events
 * and paint between blocking operations.
 */

/**
 * Yield the main thread to allow the browser to process input events and paint.
 * Uses `scheduler.yield()` (Chrome 115+) when available for optimal input priority,
 * falls back to `MessageChannel`-based yielding which is faster than `rAF`.
 */
export async function yieldToMain(): Promise<void> {
  // Prefer scheduler.yield() — gives input events priority over animation frames
  const g = globalThis as any;
  if (typeof g.scheduler !== 'undefined' && typeof g.scheduler.yield === 'function') {
    return g.scheduler.yield();
  }
  // Fallback: MessageChannel-based yield (fires as soon as possible, not at frame boundary)
  return new Promise<void>(resolve => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      ch.port2.close();
      resolve();
    };
    ch.port2.postMessage(undefined);
  });
}

/**
 * Yield to the animation frame (aligns with display refresh).
 * Use this when you need the browser to actually paint (e.g., update button text).
 * For general responsiveness, prefer `yieldToMain()`.
 */
export async function yieldToAnimationFrame(): Promise<void> {
  return new Promise<void>(resolve => { requestAnimationFrame(() => resolve()); });
}
