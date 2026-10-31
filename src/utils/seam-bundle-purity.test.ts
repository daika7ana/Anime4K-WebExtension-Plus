/**
 * Bundle-purity guard: the UI/persistence seam must not pull the monolithic
 * `anime4k-webgpu-async` library (or the composed backend registry) into the
 * UI entry chunks.
 *
 * The ONLY runtime import of the library allowed from the seam is the
 * dependency-free, catalog-only subpath:
 *
 *     anime4k-webgpu-async/engines/anime4k/catalog
 *
 * That module exports just `anime4kEffectDescriptors` and imports no
 * backend / constructor / preset / pipeline / WGSL code, so it is safe to
 * inline. Every other library specifier — the package root and the `engines`
 * / `engines/anime4k` barrels in particular — eagerly pulls the Anime4K
 * backends, constructors and pipelines (~3.3 MiB) and must stay behind the
 * builder's dynamic import. `import type { ... } from 'anime4k-webgpu-async'`
 * stays allowed because esbuild-loader erases it.
 *
 * `core/engines/registry` (the composed backend registry) must likewise never
 * be imported at runtime from the seam.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const LIBRARY_PACKAGE = 'anime4k-webgpu-async';
/** The one dependency-free library subpath the seam may import at runtime. */
const ALLOWED_LIBRARY_SPECIFIER = 'anime4k-webgpu-async/engines/anime4k/catalog';
/** Library barrels/entry points that pull the real pipelines; never allowed. */
const FORBIDDEN_LIBRARY_SPECIFIERS = [
  'anime4k-webgpu-async',
  'anime4k-webgpu-async/engines',
  'anime4k-webgpu-async/engines/anime4k',
];
const REGISTRY_MODULE = 'core/engines/registry';

// Paths are relative to the vitest working directory (the repo root).
const SEAM_FILES = [
  'src/utils/effect-registry.ts',
  'src/utils/effects-map.ts',
  'src/core/engines/descriptors.ts',
];

/**
 * Files that may *dynamically* import the registry/library to create an async
 * chunk, but must never statically import them (which would inline the library
 * into the content chunk). These modules are imported statically by the
 * renderer/content graph, so any library/registry reference must be a
 * type-only import or a dynamic `import()`.
 */
const LAZY_IMPORT_FILES = [
  'src/core/gpu/pipeline-builder.ts',
  'src/core/gpu/pipeline-prewarmer.ts',
  'src/core/gpu/gpu-benchmark.ts',
];

/**
 * Import policy for the UI/persistence seam.
 *
 * - Only the dependency-free catalog subpath is an allowed runtime library
 *   import; any other `anime4k-webgpu-async[/...]` specifier is forbidden.
 * - The composed backend registry is forbidden.
 * - `.js` suffixes are normalized away before matching.
 */
function isForbiddenSpecifier(specifier: string): boolean {
  const normalized = specifier.replace(/\.js$/, '');

  if (
    normalized === LIBRARY_PACKAGE ||
    normalized.startsWith(`${LIBRARY_PACKAGE}/`)
  ) {
    return normalized !== ALLOWED_LIBRARY_SPECIFIER;
  }

  // Match `core/engines/registry` and its aliases (`@core/engines/registry`,
  // `src/core/engines/registry`), with or without a `.js` suffix.
  const segments = normalized.split('/');
  const length = segments.length;
  if (
    length >= 3 &&
    segments[length - 1] === 'registry' &&
    segments[length - 2] === 'engines' &&
    (segments[length - 3] === 'core' || segments[length - 3] === '@core')
  ) {
    return true;
  }

  return false;
}

/** Static (non-type-only) imports of a forbidden module. Dynamic imports allowed. */
function findStaticForbiddenImports(source: string): string[] {
  const violations: string[] = [];
  const lines = source.split('\n');

  let buffer = '';
  for (const line of lines) {
    const trimmed = line.trim();

    if (buffer === '') {
      if (!trimmed.startsWith('import')) continue;

      // Side-effect import: `import 'module';`
      const sideEffect = trimmed.match(/^import\s+['"]([^'"]+)['"]\s*;?$/);
      if (sideEffect) {
        if (isForbiddenSpecifier(sideEffect[1])) violations.push(trimmed);
        continue;
      }

      buffer = line;
    } else {
      buffer += `\n${line}`;
    }

    const fromMatch = buffer.match(/\bfrom\s*['"]([^'"]+)['"]/);
    if (!fromMatch) continue;

    const moduleName = fromMatch[1];
    const isTypeOnly = /^import\s+type\b/.test(buffer.trim());
    if (isForbiddenSpecifier(moduleName) && !isTypeOnly) violations.push(buffer.trim());
    buffer = '';
  }

  return violations;
}

/**
 * Return the runtime (non-type-only, non-dynamic-erased) imports of a forbidden
 * module. Static `import type { ... } from '...'` is allowed because it is
 * erased at build time; everything else is a violation.
 */
function findRuntimeForbiddenImports(source: string): string[] {
  const violations = findStaticForbiddenImports(source);

  // Dynamic `import('module')` / `require('module')` are always runtime.
  for (const match of source.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (isForbiddenSpecifier(match[1])) {
      violations.push(`dynamic import/require of ${match[1]}`);
    }
  }

  return violations;
}

describe('library import policy', () => {
  it('allows the dependency-free catalog-only subpath', () => {
    expect(isForbiddenSpecifier(ALLOWED_LIBRARY_SPECIFIER)).toBe(false);
    expect(isForbiddenSpecifier(`${ALLOWED_LIBRARY_SPECIFIER}.js`)).toBe(false);
  });

  it.each(FORBIDDEN_LIBRARY_SPECIFIERS)('forbids the library specifier %s', (specifier) => {
    expect(isForbiddenSpecifier(specifier)).toBe(true);
  });

  it('forbids arbitrary (future) non-catalog library subpaths', () => {
    expect(isForbiddenSpecifier('anime4k-webgpu-async/dist/pipelines/index.js')).toBe(true);
  });

  it('forbids the composed backend registry', () => {
    expect(isForbiddenSpecifier(REGISTRY_MODULE)).toBe(true);
    expect(isForbiddenSpecifier('@core/engines/registry.js')).toBe(true);
  });

  it('flags a static barrel import but not a static catalog import', () => {
    const catalogSource =
      "import { anime4kEffectDescriptors } from 'anime4k-webgpu-async/engines/anime4k/catalog';";
    const barrelSource =
      "import { anime4kEffectDescriptors } from 'anime4k-webgpu-async/engines/anime4k';";

    expect(findStaticForbiddenImports(catalogSource)).toEqual([]);
    expect(findStaticForbiddenImports(barrelSource)).not.toEqual([]);
  });
});

describe('UI/persistence seam bundle purity', () => {
  for (const relativePath of SEAM_FILES) {
    it(`${relativePath} has no runtime import of the library or backend registry`, () => {
      const source = readFileSync(relativePath, 'utf8');
      const violations = findRuntimeForbiddenImports(source);

      expect(violations, `Runtime imports found:\n${violations.join('\n')}`).toEqual([]);
    });
  }
});

describe('content-chunk bundle purity (lazy imports allowed)', () => {
  for (const relativePath of LAZY_IMPORT_FILES) {
    it(`${relativePath} has no static import of the library or backend registry`, () => {
      const source = readFileSync(relativePath, 'utf8');
      const violations = findStaticForbiddenImports(source);

      expect(
        violations,
        `Static runtime imports found (use import type or import()):\n${violations.join('\n')}`,
      ).toEqual([]);
    });
  }
});
