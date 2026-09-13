# AGENTS.md

Manifest V3 browser extension (Chrome + Firefox) that real-time super-resolves
video via WebGPU, built with TypeScript + webpack + esbuild-loader. Package
manager is **pnpm** (CI pins pnpm 11.5.3, Node 23/24).

## Commands

- `pnpm install` — deps. `pnpm-workspace.yaml` pins `allowBuilds` (esbuild yes, core-js no).
- `pnpm build` — alias for `pnpm build:chrome`; output goes to `dist-chrome/` (or `dist-firefox/`).
- `pnpm build:chrome` / `pnpm build:firefox` — production build; `TARGET_BROWSER` selects the manifest shape.
- `pnpm dev:chrome` / `pnpm watch:chrome` — both run webpack in **watch** mode (`webpack.config.js` `watch: isDevelopment`). There is no dev server and no one-shot dev build; reload the unpacked `dist-*` dir in the browser.
- `pnpm lint` (eslint) · `pnpm typecheck` (`tsc --noEmit`) · `pnpm test` (Vitest once).
- Single unit test: `pnpm exec vitest run src/path/to/file.test.ts`
- `pnpm test:e2e` — GPU-free Playwright smoke. **Requires `pnpm build:chrome` first** (loads `dist-chrome/` unpacked).
- `pnpm test:gpu` — headless-WebGPU correctness gate (SwiftShader; full Chromium, not the headless shell).
- `pnpm test:gpu:ablation` — multi-minute diagnostic chain experiments, not pass/fail gates. Single spec: `pnpm test:gpu:ablation e2e/gpu/chain-ablation-wing.spec.ts`
- `pnpm test:gpu:dumps` — PNG pass/restore dump diagnostics (real chain, ~4K), not pass/fail gates. Single spec: `pnpm test:gpu:dumps e2e/gpu/pass-dump.spec.ts`
- `pnpm verify:wgsl` — compiles every `src/**/*.wgsl` in headless Chromium; needs `pnpm exec playwright install chromium`.
- `pnpm check:bundle` — scans `dist-chrome/` + `dist-firefox/` for required files and leaked test tokens; **requires both builds**.
- `pnpm check:version` — asserts `package.json` == `manifest.json` == built dist manifests (missing dist manifests are skipped).

CI order (`.github/workflows/quality.yml`): lint → typecheck → `vitest run --coverage` → build both targets → check:bundle → check:version → verify:wgsl → test:gpu.

## Entrypoints & wiring

Webpack entries: `popup`, `options`, `onboarding`, `content`, `background`.

- `src/background.ts` — the only privileged script: DNR ruleset toggle for the cross-origin fix, onboarding open, install/update migration (`ensureLatestConfig`, in `onInstalled`), hotkey, and relaying `SETTINGS_UPDATED` to tabs. Each startup step is failure-isolated; preserve that.
- `src/content.ts` — injected into every frame, whitelist-gated, manages per-video enhancers.
- `src/ui/{popup,options,onboarding}/*` — DOM orchestrators (options builds an `AppContext` + panels).
- `chrome.runtime.sendMessage` does not reach content scripts — background uses `chrome.tabs.sendMessage`. `src/utils/messaging.ts` wraps this.
- Message types are a discriminated union `RuntimeMessage` in `src/types.d.ts` validated against `KNOWN_MESSAGE_TYPES` in `messaging.ts`. Adding a message requires editing **both** or the guard silently drops it.

## Engine backend seam (core abstraction)

All effects run through `anime4k-webgpu-async`'s `BackendRegistry` / `AlgorithmBackend` contract.

- `src/core/engines/registry.ts` — composition root; lazy singleton merging `createAnime4kBackend()` (library, 15 effects) + `createCoreBackend()` (extension-owned CAS/Debanding/ColorAdjust).
- `src/core/engines/descriptors.ts` — metadata-only catalog (18 effects) + param schema overlay. It may runtime-import only the dependency-free `anime4k-webgpu-async/engines/anime4k/catalog` subpath, never the package root.
- `src/core/engines/core-backend.ts` — a core effect needs a `CORE_EFFECTS` entry **and** a descriptor in `coreEffectDescriptors` (descriptors.ts), plus an `AVAILABLE_EFFECT_IDS` entry if user-selectable. Core effects deliberately keep legacy `anime4k/...` ids so storage needs no migration.
- `paramsSchema` (descriptors) is the source of truth for slider bounds/defaults and validation — do not hardcode ranges in UI or validation code. DoG/BilateralMean schemas live in the extension overlay `ANIME4K_PARAM_SCHEMA_OVERLAY`, not the library catalog; `effects-map.ts` still holds shadowed `LEGACY_DEFAULT_PARAMS`.
- The persistence/UI layer resolves against static descriptors; the GPU layer compiles via the registry. Keep those two layers separate.

## Rendering pipeline invariants

- `src/core/gpu/gpu-device-manager.ts` — ref-counted shared `GPUDevice` leases (`GpuDeviceLease`), one `device.lost` listener per shared device. Pre-warm devices auto-destroy after 30s; call `invalidatePreWarm()` on loss/teardown.
- `src/core/renderer.ts` — `buildGeneration` guard: a superseded build must destroy its own result and must not clear/overwrite the winning build state. Preserve this in `buildPipelines`/`handleSourceResize`/`updateConfiguration`/`recoverFromDeviceLoss`. Default `restorePolicy` is `'gate'`; it has ImageBitmap (e.g. Firefox) and DRM canvas-2D black-frame fallbacks.
- `src/core/gpu/effect-chain-compiler.ts` `compileEffectChain` — the single ordered chain walk shared by renderer and GPU benchmark. It must stay **library-free** (type-only imports); callers inject `compileEffect`.
- `src/core/gpu/effect-chain.ts` — pure geometry + restore suppression (its `RestoreSuppression` union mirrors `RestorePolicy` from `src/types.d.ts`). Suppression markers are attached **non-enumerably** on purpose; do not convert them to plain fields.
- `pipeline-builder.ts`, `pipeline-prewarmer.ts`, `gpu-benchmark.ts` must never statically import `anime4k-webgpu-async` or the registry (use `import type` or dynamic `import()`). `src/utils/seam-bundle-purity.test.ts` enforces this, but from a hardcoded `SEAM_FILES`/`LAZY_IMPORT_FILES` list — add new seam/lazy modules there.

## Settings & persistence invariants

- Schema lives in `src/types.d.ts`: `SyncedSettings` (storage.sync) + `LocalSettings` (storage.local). `Anime4KWebExtSettings` is the runtime merge and adds runtime-only fields (`performanceTier`, `enhancementModes`) — never persist the merged object wholesale. Invalid values are coerced by normalizers in `src/utils/settings.ts`.
- Adding a setting touches all of: the interface, its `DEFAULT_*`, the normalizer, **and** the `syncKeys`/`localKeys` list in `saveSettings` — only keys in those arrays persist.
- Built-in mode chains are data: `src/utils/effect-chain-templates.ts` maps `baseMode × tier → className[]` (resolved by `getEffectsForMode`/`resolveEffectChain`); custom modes store explicit effect arrays.
- Migrations (`src/utils/migration.ts`) are an ordered, idempotent chain keyed on `_configVersion` (`CURRENT_CONFIG_VERSION = 4`). Add a `migrateVxToVy`, bump the constant, extend `ensureLatestConfig`; never mutate existing steps. Legacy `preserveDetail` is also mapped to `restorePolicy` at read time in `normalizeLocalSettings`.
- `getSettings()` caches for 2s with a revisioned snapshot (`settings-snapshot.ts`) invalidated by `chrome.storage.onChanged`.
- `src/utils/effect-registry.ts` resolution precedence must hold: exact `id` → `backendId`+`key` → legacy `className` → new-style-but-unresolved = **keep** (`'unresolved'`, cross-device forward compat) → legacy unknown = droppable.
- `src/utils/effects-map.ts` `AVAILABLE_EFFECT_IDS` is a derived allowlist; ColorAdjust is system-only and intentionally excluded.

## WGSL

- `.wgsl` files import as raw strings via webpack `asset/source` and `src/wgsl.d.ts` (`declare module '*.wgsl'`). Vitest has its own inline `wgslPlugin()` — keep both paths in sync when adding asset types.
- Compute shaders: `fn main(@builtin(global_invocation_id))`, `@group(0) @binding(0)` input texture, `@binding(1)` output storage texture, then uniforms. The final blit uses `fullscreen-textured-quad.wgsl` + `sample-external-texture.wgsl` (bindings 1 sampler / 2 texture; binding 0 unused) and must match the render bind group layout in `renderer.ts`.
- Effect shaders are created through `gpu-resource-cache.ts` (`getShaderModule`); the final-blit shader modules are built directly in `renderer.ts`.

## TypeScript / build gotchas

- Global types are ambient in `src/types.d.ts` (not `types.ts`) and available without imports; it also declares `*.css`.
- Path aliases (`@`, `@core`, `@core/video|gpu|effects|ui|utils`, `@utils`, `@shaders`) are duplicated in `tsconfig.json` `paths`, `webpack.config.js` `resolve.alias`, and `vitest.config.mts` `resolve.alias` — update all three.
- `module`/`moduleResolution` are `node20`/`node16`, so dynamic imports of local TS use an explicit `.js` specifier (e.g. `import('@core/engines/registry.js')`); webpack maps it back via `resolve.extensionAlias`. Tests mock that exact `.js` specifier.
- Production builds strip `console.log`/`console.warn` (keep `console.error`), inject `package.json` version into the emitted manifest, and transform the manifest per target (Firefox swaps `background.service_worker` for `background.scripts`).

## Tests

- Vitest + jsdom, `globals: true`, setup `src/test-setup.ts` (stubs the `chrome` global; nulls unimplemented canvas contexts). Tests sit beside sources as `*.test.ts`.
- GPU is mocked via `installGPUMock()`/`removeGPUMock()` from `@/test/webgpu-mock`. `removeGPUMock()` re-applies the chrome stub after `vi.unstubAllGlobals()` — don't replace that with a bare unstub.
- Engine/chain tests use `src/core/gpu/__test-helpers__/fake-backend.ts` with module-level `vi.mock('anime4k-webgpu-async', …)` / `vi.mock('@core/engines/registry.js', …)`; GPU specs also mock WGSL modules (`vi.mock('@shaders/*.wgsl', …)`).
- The only golden snapshot is `src/core/gpu/__snapshots__/pipeline-builder.test.ts.snap` (chain construction order/dimensions) — extend it for new chain behavior.
- New shader/effect math gets a pure-TS oracle under `src/core/effects/reference/` (test-only; production must not import it) plus a Playwright spec in `e2e/gpu/`.
- `check-production-bundle.mjs` forbids the tokens `vitest`, `playwright`, `webgpu-mock`, `test-setup`, `__tests__` in shipped JS — keep test-only code out of production import graphs.

## Docs & i18n (keep in sync)

- UI strings: `public/_locales/{en,ja,ru,zh_CN,zh_TW}/messages.json`, accessed via `src/utils/i18n.ts` (`t`, `applyI18n`) and `data-i18n` attributes. Update all five locales and the `README.*.md` translations when user-facing text changes.
- Version bumps must stay consistent across `package.json` and `manifest.json` (webpack injects the version; `pnpm check:version` enforces it).
