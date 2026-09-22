/**
 * Composition root for the extension's engine backends.
 *
 * Registers the library-provided Anime4K backend and the extension-owned core
 * backend (CAS/Debanding/ColorAdjust) in a single {@link BackendRegistry}.
 * Registration is eager for now; lazy loaders are a Phase 3 concern.
 */
import {
  createAnime4kBackend,
  createBackendRegistry,
  type BackendRegistry,
} from 'anime4k-webgpu-async';
import { createCoreBackend } from './core-backend';

export function createExtensionBackendRegistry(): BackendRegistry {
  const registry = createBackendRegistry();
  registry.register(createAnime4kBackend());
  registry.register(createCoreBackend());
  return registry;
}

let registrySingleton: BackendRegistry | null = null;

/** Lazily-created module singleton used by the persistence/validation layer. */
export function getBackendRegistry(): BackendRegistry {
  if (!registrySingleton) {
    registrySingleton = createExtensionBackendRegistry();
  }
  return registrySingleton;
}
