/**
 * Revisioned settings snapshot store.
 *
 * Holds the last merged `Anime4KWebExtSettings` value produced by `getSettings`
 * together with a monotonically increasing `revision`. A relevant
 * `chrome.storage` area change invalidates the snapshot; the next publish bumps
 * the revision with a fresh merged value.
 *
 * The store is deliberately decoupled from `settings.ts`: it knows nothing about
 * how the value is built, it only stores the latest value and tracks staleness.
 * `settings.ts` pushes values in via `setSnapshot` and asks `isStale` whether the
 * cached snapshot can still be trusted.
 */

import type { Anime4KWebExtSettings } from '../types';

/** A point-in-time merged settings value with its revision number. */
export interface SettingsSnapshot {
  /** Monotonically increasing revision; strictly greater after each publish. */
  readonly revision: number;
  /** The merged settings value at this revision. */
  readonly value: Anime4KWebExtSettings;
}

let snapshot: SettingsSnapshot | null = null;
let revisionCounter = 0;
let stale = false;

type StorageChangedListener = (
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
) => void;

let storageChangedListener: StorageChangedListener | null = null;
let storageListenerAttached = false;

/**
 * Attach the `chrome.storage.onChanged` listener that invalidates the snapshot
 * when the `'sync'` or `'local'` areas change.
 *
 * Feature-detected and wrapped in a try/catch so importing/using this module
 * never throws in environments where the extension APIs are unavailable
 * (unit tests, plain pages, Firefox variants without the API, ...).
 */
function ensureStorageListener(): void {
  if (storageListenerAttached) return;
  storageListenerAttached = true;

  if (typeof chrome === 'undefined' || !chrome.storage?.onChanged?.addListener) {
    return;
  }

  try {
    storageChangedListener = (_changes, areaName) => {
      if (areaName === 'sync' || areaName === 'local') {
        invalidate();
      }
    };
    chrome.storage.onChanged.addListener(storageChangedListener);
  } catch {
    storageChangedListener = null;
  }
}

/**
 * Mark the current snapshot as stale. Does not change the stored value or its
 * revision; the revision advances on the next `setSnapshot` (i.e. the next
 * settings read). Calling this repeatedly while already stale is a no-op so that
 * multiple storage-area changes cannot re-invalidate.
 */
export function invalidate(): void {
  if (stale) return;
  stale = true;
}

/** Whether the snapshot has been invalidated since it was last published. */
export function isStale(): boolean {
  return stale;
}

/**
 * Publish a freshly merged settings value. Bumps the revision and clears the
 * stale flag.
 *
 * @returns the newly published snapshot.
 */
export function setSnapshot(value: Anime4KWebExtSettings): SettingsSnapshot {
  ensureStorageListener();
  revisionCounter += 1;
  snapshot = { revision: revisionCounter, value };
  stale = false;
  return snapshot;
}

/**
 * Read the current snapshot (or `null` if nothing has been published yet).
 * This is a pure read: it never mutates state or bumps the revision.
 */
export function getSnapshot(): SettingsSnapshot | null {
  return snapshot;
}
