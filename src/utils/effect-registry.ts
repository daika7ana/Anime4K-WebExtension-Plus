/**
 * Effect reference resolution / normalization (C1a seam).
 *
 * Single resolution point for persisted {@link EnhancementEffect} entries. It
 * resolves against the extension-side static descriptor table
 * (`core/engines/descriptors`) so the UI/persistence path never pulls the
 * monolithic `anime4k-webgpu-async` UMD bundle — the real backends/monolithic
 * library remain behind the builder's dynamic import.
 *
 * Resolution precedence (design §4.1):
 *  1. descriptor by exact `id`;
 *  2. `backendId` + `key` pair (`key` defaults to `className`);
 *  3. `className` → Anime4K backend key, then the core alias table;
 *  4. a well-formed new-style reference (`backendId` present) that resolves to
 *     nothing → `unresolved` (callers MUST preserve it, never drop it);
 *  5. a legacy entry with unknown id AND unknown className → `unknown`.
 */
import type { EffectDescriptor, EffectReference } from 'anime4k-webgpu-async';
import type { EnhancementEffect } from '../types';
import { extensionEffectDescriptors } from '../core/engines/descriptors';

export interface ResolvedEffect {
  descriptor: EffectDescriptor;
  reference: EffectReference;
}

export type EffectResolution =
  | { status: 'resolved'; effect: ResolvedEffect }
  | { status: 'unresolved'; reference: EffectReference } // well-formed new-style ref, backend not registered
  | { status: 'unknown' }; // legacy entry with unknown id/className

/**
 * Backend-local keys of the extension-owned core effects, keyed by legacy
 * className. A `Map` (not a plain object) so untrusted classNames such as
 * `'__proto__'`/`'constructor'` cannot consult `Object.prototype`.
 */
const CORE_CLASS_ALIASES = new Map<string, string>([
  ['CAS', 'CAS'],
  ['Debanding', 'Debanding'],
  ['ColorAdjust', 'ColorAdjust'],
]);

const ANIME4K_BACKEND_ID = 'anime4k';
const CORE_BACKEND_ID = 'core';

/** Descriptor indices over the static table (ids and keys are unique). */
const DESCRIPTORS_BY_ID = new Map<string, EffectDescriptor>(
  extensionEffectDescriptors.map((descriptor) => [descriptor.id, descriptor]),
);
const DESCRIPTORS_BY_BACKEND_KEY = new Map<string, EffectDescriptor>(
  extensionEffectDescriptors.map((descriptor) => [
    `${descriptor.backendId}:${descriptor.key}`,
    descriptor,
  ]),
);
const VISIBLE_DESCRIPTORS = extensionEffectDescriptors.filter((descriptor) => !descriptor.hidden);
const KNOWN_BACKEND_IDS = new Set(
  extensionEffectDescriptors.map((descriptor) => descriptor.backendId),
);

export function listEffectDescriptors(
  opts?: { includeHidden?: boolean },
): readonly EffectDescriptor[] {
  return (opts?.includeHidden ?? false) ? extensionEffectDescriptors : VISIBLE_DESCRIPTORS;
}

export function getEffectDescriptorById(id: string): EffectDescriptor | undefined {
  return DESCRIPTORS_BY_ID.get(id);
}

/** Whether a backend id is one the extension currently knows about. */
export function isKnownBackendId(backendId: string): boolean {
  return KNOWN_BACKEND_IDS.has(backendId);
}

function buildReference(
  effect: EnhancementEffect,
  descriptor: EffectDescriptor,
): EffectReference {
  const reference: EffectReference = {
    id: descriptor.id,
    backendId: descriptor.backendId,
    key: descriptor.key,
  };
  if (effect.params) {
    reference.params = { ...effect.params };
  }
  return reference;
}

function buildUnresolvedReference(
  effect: EnhancementEffect,
  backendId: string,
): EffectReference {
  const reference: EffectReference = {
    id: effect.id,
    backendId,
    key: effect.key ?? effect.className,
  };
  if (effect.params) {
    reference.params = { ...effect.params };
  }
  return reference;
}

function resolved(
  descriptor: EffectDescriptor,
  effect: EnhancementEffect,
): EffectResolution {
  return {
    status: 'resolved',
    effect: {
      descriptor,
      reference: buildReference(effect, descriptor),
    },
  };
}

export function resolveEffectReference(effect: EnhancementEffect): EffectResolution {
  // 1. Descriptor by exact id.
  const byId = DESCRIPTORS_BY_ID.get(effect.id);
  if (byId) return resolved(byId, effect);

  // 2. Explicit backendId + key pair (key defaults to className).
  if (effect.backendId) {
    const byPair = DESCRIPTORS_BY_BACKEND_KEY.get(
      `${effect.backendId}:${effect.key ?? effect.className}`,
    );
    if (byPair) return resolved(byPair, effect);
  }

  // 3. Legacy className → Anime4K key, then the core alias table.
  const byAnime4k = DESCRIPTORS_BY_BACKEND_KEY.get(`${ANIME4K_BACKEND_ID}:${effect.className}`);
  if (byAnime4k) return resolved(byAnime4k, effect);

  const coreKey = CORE_CLASS_ALIASES.get(effect.className);
  if (coreKey) {
    const byCore = DESCRIPTORS_BY_BACKEND_KEY.get(`${CORE_BACKEND_ID}:${coreKey}`);
    if (byCore) return resolved(byCore, effect);
  }

  // 4. Well-formed new-style reference that resolved to nothing: preserve it.
  if (effect.backendId) {
    return {
      status: 'unresolved',
      reference: buildUnresolvedReference(effect, effect.backendId),
    };
  }

  // 5. Legacy entry with unknown id and unknown className.
  return { status: 'unknown' };
}

export function descriptorToLegacyEffect(descriptor: EffectDescriptor): EnhancementEffect {
  const legacy: EnhancementEffect = {
    id: descriptor.id,
    name: descriptor.name,
    className: descriptor.key,
    backendId: descriptor.backendId,
    key: descriptor.key,
  };
  if (descriptor.dimensionBehavior.kind === 'scale') {
    legacy.upscaleFactor = descriptor.dimensionBehavior.scale;
  }
  return legacy;
}
