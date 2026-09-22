/**
 * Runtime validation / normalization for user data that crosses a trust boundary:
 * imported custom-mode JSON and settings read back from `chrome.storage`.
 *
 * The validator is intentionally dependency-free (no DOM, no i18n, no settings
 * imports) so it can be reused by the options UI, unit tests, and any future
 * import path without pulling UI code into the background/content bundles.
 *
 * Public contract: every strict validator returns a `ValidationResult<T>` —
 * either `{ ok: true, value }` with a normalized value, or `{ ok: false, issues }`
 * with a structured list of problems. Callers must not apply a failed result.
 */

import type { EffectDescriptor, EffectParamSchema } from 'anime4k-webgpu-async';
import type {
  ColorGradingSettings,
  CustomMode,
  EnhancementEffect,
  GPUBenchmarkResult,
  PerformanceTier,
  WhitelistRule,
} from '../types';
import { descriptorToCatalogEffect } from './effects-map';
import {
  getEffectDescriptorById,
  isKnownBackendId,
  listEffectDescriptors,
  resolveEffectReference,
} from './effect-registry';

// ===== Result types =====

/** A single problem found while validating untrusted data. */
export interface ValidationIssue {
  /** Dotted path to the offending field, e.g. `modes[0].effects[1].params.sharpness`. */
  readonly path: string;
  /** Human-readable description of the problem. */
  readonly message: string;
}

/** Either a normalized value or a non-empty list of validation issues. */
export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

// ===== Effect parameter metadata =====

/**
 * Bounds for a single effect parameter.
 *
 * The ranges are read from each descriptor's `paramsSchema` (the same metadata
 * that drives `src/ui/options/param-sliders.ts`). Values outside these bounds
 * cannot be produced by the UI and must therefore be rejected when they arrive
 * through an import.
 */
export interface EffectParamBound {
  readonly min: number;
  readonly max: number;
  readonly defaultValue: number;
}

/** Extract numeric bounds from one schema entry; undefined when it is not numeric. */
function numericParamBound(param: EffectParamSchema | undefined): EffectParamBound | undefined {
  if (
    !param ||
    param.type !== 'number' ||
    typeof param.min !== 'number' ||
    typeof param.max !== 'number' ||
    typeof param.defaultValue !== 'number'
  ) {
    return undefined;
  }
  return { min: param.min, max: param.max, defaultValue: param.defaultValue };
}

/**
 * Numeric bound for one effect param, or undefined when absent.
 *
 * Hidden/system descriptors (ColorAdjust) are excluded: they are not part of the
 * selectable catalog and their params are not validated on import.
 */
function effectParamBound(
  descriptor: EffectDescriptor,
  key: string,
): EffectParamBound | undefined {
  return descriptor.hidden ? undefined : numericParamBound(descriptor.paramsSchema?.[key]);
}

// ===== Color grading metadata =====

/** Default color-grading configuration (matches `DEFAULT_SYNCED_SETTINGS`). */
export const DEFAULT_COLOR_GRADING: ColorGradingSettings = {
  enabled: false,
  brightness: 0,
  gamma: 1,
  contrast: 1,
  saturation: 1,
  vibrance: 0,
  exposure: 0,
};

/**
 * Numeric color-grading keys, and the schema they are bounded by.
 *
 * `paramsSchema` is the documented source of truth, so the bounds are read from
 * the metadata-only ColorAdjust descriptor rather than duplicated here.
 */
const COLOR_GRADING_KEYS = [
  'brightness',
  'gamma',
  'contrast',
  'saturation',
  'vibrance',
  'exposure',
] as const;

const COLOR_GRADING_SCHEMA = getEffectDescriptorById(
  'anime4k/ColorGrading/ColorAdjust',
)?.paramsSchema;

// ===== Shared primitives =====

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Every registered effect (including hidden/system ones such as ColorAdjust),
 * keyed by id. Derived from the composed engine registry so validation accepts
 * exactly what the engine seam can resolve.
 */
const DESCRIPTORS_BY_ID = new Map<string, EffectDescriptor>(
  listEffectDescriptors({ includeHidden: true }).map((descriptor) => [descriptor.id, descriptor]),
);

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function warn(message: string): void {
  console.warn(`[Validation] ${message}`);
}

// ===== Custom mode validation (strict / atomic) =====

function collectEffectIssues(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: 'Effect must be an object' });
    return;
  }

  const id = value.id;
  if (typeof id !== 'string' || id.length === 0) {
    issues.push({ path: `${path}.id`, message: 'Effect is missing a valid id' });
    return;
  }

  const descriptor = DESCRIPTORS_BY_ID.get(id);
  if (!descriptor) {
    issues.push({ path: `${path}.id`, message: `Unknown effect id: ${id}` });
    return;
  }

  // A well-formed new-style reference must name a backend this build knows about.
  if (
    typeof value.backendId === 'string' &&
    value.backendId.length > 0 &&
    !isKnownBackendId(value.backendId)
  ) {
    issues.push({
      path: `${path}.backendId`,
      message: `Unknown effect backend: ${value.backendId}`,
    });
    return;
  }

  const params = value.params;
  if (params === undefined || params === null) return;

  if (!isRecord(params)) {
    issues.push({ path: `${path}.params`, message: 'Effect params must be an object' });
    return;
  }

  for (const [key, raw] of Object.entries(params)) {
    if (!isFiniteNumber(raw)) {
      issues.push({
        path: `${path}.params.${key}`,
        message: `Parameter "${key}" must be a finite number`,
      });
      continue;
    }
    const bound = effectParamBound(descriptor, key);
    if (!bound) {
      issues.push({
        path: `${path}.params.${key}`,
        message: `Unknown parameter "${key}" for effect ${descriptor.key}`,
      });
      continue;
    }
    if (raw < bound.min || raw > bound.max) {
      issues.push({
        path: `${path}.params.${key}`,
        message: `Parameter "${key}" must be between ${bound.min} and ${bound.max}`,
      });
    }
  }
}

function collectModeIssues(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: 'Mode must be an object' });
    return;
  }

  if (typeof value.name !== 'string' || value.name.trim() === '') {
    issues.push({ path: `${path}.name`, message: 'Mode name is required' });
  }

  if (!Array.isArray(value.effects)) {
    issues.push({ path: `${path}.effects`, message: 'Mode effects must be an array' });
    return;
  }

  value.effects.forEach((effect, index) => {
    collectEffectIssues(effect, `${path}.effects[${index}]`, issues);
  });
}

function buildCatalogEffect(
  catalog: EnhancementEffect,
  rawParams: unknown,
): EnhancementEffect {
  if (!catalog.params) {
    return { ...catalog };
  }
  const params: Record<string, number> = { ...catalog.params };
  if (isRecord(rawParams)) {
    for (const [key, value] of Object.entries(rawParams)) {
      if (isFiniteNumber(value)) params[key] = value;
    }
  }
  return { ...catalog, params };
}

function createImportedModeId(): string {
  return `custom-${crypto.randomUUID()}`;
}

function toImportedMode(mode: Record<string, unknown>): CustomMode {
  const rawEffects = (mode.effects as unknown[]) ?? [];
  const effects = rawEffects.reduce<EnhancementEffect[]>((acc, rawEffect) => {
    if (!isRecord(rawEffect) || typeof rawEffect.id !== 'string') return acc;
    const descriptor = DESCRIPTORS_BY_ID.get(rawEffect.id);
    if (!descriptor) return acc;
    acc.push(buildCatalogEffect(descriptorToCatalogEffect(descriptor), rawEffect.params));
    return acc;
  }, []);

  return {
    id: createImportedModeId(),
    name: mode.name as string,
    isBuiltIn: false,
    effects,
  };
}

/**
 * Validate an imported custom-modes payload.
 *
 * Accepted shapes:
 * - `CustomMode[]` — the legacy/historical export format (treated as v1).
 * - `{ version: number, modes: CustomMode[] }` — versioned envelope.
 *
 * Validation is atomic: if a single issue is found the whole payload is
 * rejected and no value is returned, so callers can never partially apply a
 * malformed import. On success mode ids are regenerated to avoid collisions
 * with the user's existing modes.
 */
export function validateModesImport(input: unknown): ValidationResult<CustomMode[]> {
  const issues: ValidationIssue[] = [];
  let rawModes: unknown;

  if (Array.isArray(input)) {
    rawModes = input;
  } else if (isRecord(input)) {
    if (!('version' in input)) {
      issues.push({ path: 'version', message: 'Missing schema version' });
    } else if (input.version !== 1) {
      issues.push({
        path: 'version',
        message: `Unsupported version: ${String(input.version)} (expected 1)`,
      });
    }
    if (!('modes' in input)) {
      issues.push({ path: 'modes', message: 'Missing modes array' });
    }
    rawModes = input.modes;
  } else {
    return {
      ok: false,
      issues: [{ path: '', message: 'Expected a modes array or a { version, modes } object' }],
    };
  }

  if (!Array.isArray(rawModes)) {
    issues.push({ path: 'modes', message: 'Modes must be an array' });
    return { ok: false, issues };
  }

  rawModes.forEach((mode, index) => {
    collectModeIssues(mode, `modes[${index}]`, issues);
  });

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const value = rawModes.map((mode) => toImportedMode(mode as Record<string, unknown>));
  return { ok: true, value };
}

/**
 * Parse a JSON string and validate it as a custom-modes import.
 * JSON syntax errors are returned as a structured issue rather than thrown.
 */
export function parseAndValidateModesImport(json: string): ValidationResult<CustomMode[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown parse error';
    return { ok: false, issues: [{ path: '', message: `Import is not valid JSON: ${message}` }] };
  }
  return validateModesImport(parsed);
}

/**
 * Render validation issues into a concise single-line message for toasts/logs.
 */
export function formatValidationIssues(issues: readonly ValidationIssue[]): string {
  if (issues.length === 0) return 'Unknown validation error';
  const shown = issues
    .slice(0, 3)
    .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message));
  const remaining = issues.length - shown.length;
  return remaining > 0 ? `${shown.join('; ')} (+${remaining} more)` : shown.join('; ');
}

// ===== Custom mode normalization (lenient / storage read) =====

function sanitizeParams(
  descriptor: EffectDescriptor,
  rawParams: unknown,
): Record<string, number> | undefined {
  const catalog = descriptorToCatalogEffect(descriptor);
  if (!catalog.params) {
    if (rawParams !== undefined && rawParams !== null) {
      warn(`Ignoring params for effect ${catalog.className} which exposes no parameters.`);
    }
    return undefined;
  }

  const params: Record<string, number> = { ...catalog.params };
  if (rawParams === undefined || rawParams === null) return params;
  if (!isRecord(rawParams)) {
    warn(`Invalid params for effect ${catalog.className}; using catalog defaults.`);
    return params;
  }

  for (const [key, value] of Object.entries(rawParams)) {
    if (!isFiniteNumber(value)) {
      warn(`Ignoring non-numeric param ${catalog.className}.${key}.`);
      continue;
    }
    const bound = effectParamBound(descriptor, key);
    if (!bound) {
      warn(`Ignoring unknown param ${catalog.className}.${key}.`);
      continue;
    }
    if (value < bound.min || value > bound.max) {
      warn(
        `Param ${catalog.className}.${key}=${value} out of range [${bound.min}, ${bound.max}]; using default.`,
      );
      continue;
    }
    params[key] = value;
  }
  return params;
}

/**
 * Lenient normalization for custom modes read back from storage.
 *
 * Invalid modes/effects are dropped and invalid params fall back to catalog
 * defaults instead of poisoning the GPU pipeline. Valid input passes through
 * structurally unchanged (ids and effect order preserved).
 */
export function sanitizeCustomModes(input: unknown): CustomMode[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    warn(`customModes is ${describeType(input)}, not an array; using defaults.`);
    return [];
  }

  const modes: CustomMode[] = [];
  input.forEach((rawMode, modeIndex) => {
    if (!isRecord(rawMode)) {
      warn(`Skipping customModes[${modeIndex}] (${describeType(rawMode)}), not an object.`);
      return;
    }
    if (typeof rawMode.name !== 'string' || rawMode.name.trim() === '') {
      warn(`Skipping customModes[${modeIndex}] without a valid name.`);
      return;
    }
    if (!Array.isArray(rawMode.effects)) {
      warn(`Skipping customModes[${modeIndex}] without an effects array.`);
      return;
    }

    const effects: EnhancementEffect[] = [];
    rawMode.effects.forEach((rawEffect, effectIndex) => {
      if (!isRecord(rawEffect) || typeof rawEffect.id !== 'string') {
        warn(`Skipping customModes[${modeIndex}].effects[${effectIndex}] with no valid id.`);
        return;
      }

      const resolution = resolveEffectReference(rawEffect as unknown as EnhancementEffect);

      // Forward-compat: a well-formed new-style reference for a backend that is
      // not registered on this device is preserved verbatim, never dropped, so
      // a cross-device sync is not silently destructive.
      if (resolution.status === 'unresolved') {
        effects.push({ ...(rawEffect as unknown as EnhancementEffect) });
        return;
      }

      if (resolution.status === 'unknown') {
        warn(
          `Skipping customModes[${modeIndex}].effects[${effectIndex}]: unknown effect ${rawEffect.id}.`,
        );
        return;
      }

      const descriptor = resolution.effect.descriptor;
      const catalog = descriptorToCatalogEffect(descriptor);
      const params = sanitizeParams(descriptor, rawEffect.params);
      effects.push(params ? { ...catalog, params } : { ...catalog });
    });

    const id =
      typeof rawMode.id === 'string' && rawMode.id.length > 0
        ? rawMode.id
        : createImportedModeId();

    modes.push({ id, name: rawMode.name, isBuiltIn: false, effects });
  });

  return modes;
}

// ===== Settings field validators =====

const PERFORMANCE_TIERS: readonly PerformanceTier[] = [
  'performance',
  'balanced',
  'quality',
  'ultra',
];

export function isPerformanceTier(value: unknown): value is PerformanceTier {
  return typeof value === 'string' && (PERFORMANCE_TIERS as readonly string[]).includes(value);
}

const RESOLUTION_SETTINGS: readonly string[] = [
  'x2',
  'x4',
  'x8',
  '720p',
  '1080p',
  '2k',
  '4k',
  'native',
  'display',
];

export function isValidResolutionSetting(value: unknown): value is string {
  return typeof value === 'string' && RESOLUTION_SETTINGS.includes(value);
}

/** Lenient normalization of color grading; invalid fields fall back to defaults. */
export function sanitizeColorGrading(input: unknown): ColorGradingSettings {
  if (!isRecord(input)) {
    if (input !== undefined && input !== null) {
      warn(`colorGrading is ${describeType(input)}, not an object; using defaults.`);
    }
    return { ...DEFAULT_COLOR_GRADING };
  }

  const result: ColorGradingSettings = { ...DEFAULT_COLOR_GRADING };
  if (typeof input.enabled === 'boolean') {
    result.enabled = input.enabled;
  } else if (input.enabled !== undefined && input.enabled !== null) {
    warn('Ignoring non-boolean colorGrading.enabled; using default.');
  }

  for (const key of COLOR_GRADING_KEYS) {
    const raw = input[key];
    if (raw === undefined || raw === null) continue;
    const bound = numericParamBound(COLOR_GRADING_SCHEMA?.[key]);
    if (!bound) continue;
    if (isFiniteNumber(raw) && raw >= bound.min && raw <= bound.max) {
      result[key] = raw;
    } else {
      warn(
        `Ignoring invalid colorGrading.${key}=${String(raw)}; using default ${DEFAULT_COLOR_GRADING[key]}.`,
      );
    }
  }
  return result;
}

/** Lenient normalization of whitelist rules read from storage; invalid rules are dropped. */
export function sanitizeWhitelist(input: unknown): WhitelistRule[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    warn(`whitelist is ${describeType(input)}, not an array; using defaults.`);
    return [];
  }
  const rules: WhitelistRule[] = [];
  for (const rule of input) {
    if (
      isRecord(rule) &&
      typeof rule.pattern === 'string' &&
      rule.pattern.trim() !== '' &&
      typeof rule.enabled === 'boolean'
    ) {
      rules.push({ pattern: rule.pattern, enabled: rule.enabled });
    } else {
      warn('Skipping invalid whitelist rule.');
    }
  }
  return rules;
}

/** Validate a stored GPU benchmark result (or null). */
export function validateGPUBenchmarkResult(
  input: unknown,
): ValidationResult<GPUBenchmarkResult | null> {
  if (input === null || input === undefined) {
    return { ok: true, value: null };
  }
  if (!isRecord(input)) {
    return { ok: false, issues: [{ path: 'gpuBenchmarkResult', message: 'Must be an object or null' }] };
  }

  const issues: ValidationIssue[] = [];
  if (!isPerformanceTier(input.tier)) {
    issues.push({ path: 'gpuBenchmarkResult.tier', message: 'Invalid performance tier' });
  }
  for (const scoreKey of ['scores', 'maxScores'] as const) {
    const scores = input[scoreKey];
    if (!isRecord(scores)) {
      issues.push({ path: `gpuBenchmarkResult.${scoreKey}`, message: 'Must be an object' });
      continue;
    }
    for (const tier of PERFORMANCE_TIERS) {
      const value = scores[tier];
      if (typeof value !== 'number' || Number.isNaN(value)) {
        issues.push({
          path: `gpuBenchmarkResult.${scoreKey}.${tier}`,
          message: 'Must be a number',
        });
      }
    }
  }
  if (typeof input.timestamp !== 'number' || !Number.isFinite(input.timestamp)) {
    issues.push({ path: 'gpuBenchmarkResult.timestamp', message: 'Must be a finite number' });
  }
  if (typeof input.adapterInfo !== 'string') {
    issues.push({ path: 'gpuBenchmarkResult.adapterInfo', message: 'Must be a string' });
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: input as unknown as GPUBenchmarkResult };
}
