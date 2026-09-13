/**
 * GPU performance benchmark module
 * Tests using real Anime4K effects
 */

import type { PerformanceTier, GPUBenchmarkResult, EnhancementEffect, BenchmarkProgress, DestroyablePipeline, GPUAdapterWithInfo, Dimensions } from '@/types';
import type { BackendRegistry } from 'anime4k-webgpu-async';
import { resolveEffectChain } from '@utils/effect-chain-templates';
import { resolveEffectReference, type EffectResolution } from '@utils/effect-registry';
import { gpuResourceCache } from '@core/gpu/gpu-resource-cache';
import { TexturePool } from './texture-pool';
import { compileEffectChain } from './effect-chain-compiler';
import { createEffectCompiler, derivePostEpilogueFlags, deriveRestoreFlags, deriveUpscaleFactors } from './compile-policy';
import { selectGatedRestoreOptions } from '@core/effects/gated-restore';

// Test configuration
const TEST_TIMEOUT_MS = 20000; // Individual test timeout
const TEST_WIDTH = 1920;  // Test input width (1080p)
const TEST_HEIGHT = 1080; // Test input height
const TARGET_WIDTH = 3840;  // Target 4K
const TARGET_HEIGHT = 2160;

/**
 * Cached engine backend registry for the benchmark's registry path. Loaded
 * lazily (dynamic `import`) so the monolithic library is never inlined into the
 * benchmark's module graph.
 */
let cachedBenchmarkRegistry: BackendRegistry | null = null;

/** Default target frame rate for the sustainability budget (24fps ≈ 41.67ms/frame). */
const DEFAULT_BENCHMARK_FPS_TARGET = 24;
const TARGET_FRAME_TIME_24FPS = 1000 / DEFAULT_BENCHMARK_FPS_TARGET; // ~41.67ms

/**
 * ── Benchmark → performance-tier policy ─────────────────────────────────
 *
 * The benchmark measures per-frame GPU time (ms) for each performance tier.
 * A tier is considered sustainable at the target frame rate when BOTH hold:
 *
 *   1. every measured frame fits the frame budget:  max(samples) < budget
 *   2. the average frame keeps 10% headroom:        avg(samples) < 0.9 * budget
 *
 *   where budget = 1000 / fpsTarget   (default fpsTarget = 24 → ≈ 41.67 ms)
 *
 * Both inequalities are strict: a tier whose max frame time equals the budget
 * exactly, or whose average equals 0.9 * budget exactly, is rejected.
 *
 * `recommendTierFromSamples` returns the heaviest qualifying tier (see
 * `PERFORMANCE_TIER_ORDER`). When no tested tier qualifies — e.g. every tier is
 * too slow, or no finite positive samples were recorded — it returns `null`.
 * Callers must then fall back to `FALLBACK_PERFORMANCE_TIER`, the lightest
 * (safest) tier, which preserves the historical default of recommending the
 * `performance` tier when nothing better is sustainable.
 *
 * Non-finite (NaN / ±Infinity) and non-positive samples are ignored before
 * aggregation so a single bad timing cannot disqualify an otherwise
 * sustainable tier (and empty / all-invalid sets never qualify).
 * ────────────────────────────────────────────────────────────────────────
 */

/**
 * Ordered performance tiers from lightest → heaviest. This is the single
 * source of truth for tier ordering, shared by the benchmark loop and the
 * pure recommendation policy.
 */
export const PERFORMANCE_TIER_ORDER = [
    'performance',
    'balanced',
    'quality',
    'ultra',
] as const satisfies readonly PerformanceTier[];

/** Deterministic fallback used when no tier satisfies the budget policy. */
export const FALLBACK_PERFORMANCE_TIER: PerformanceTier = 'performance';

/** Fraction of the frame budget the average frame time must stay below. */
export const AVG_FRAME_BUDGET_RATIO = 0.9;

/** Options for the benchmark → tier policy. */
export interface TierRecommendationOptions {
    /** Target frames per second. Defaults to 24. Non-positive/non-finite values fall back to the default. */
    fpsTarget?: number;
}

/** Per-frame timing samples (ms) keyed by the tier that produced them. Tiers may be omitted when untested. */
export type TierFrameSamples = Partial<Record<PerformanceTier, readonly number[]>>;

/**
 * Compute the per-frame time budget in milliseconds.
 * @param opts Optional `fpsTarget` override.
 * @returns `1000 / fpsTarget`, defaulting to 24fps (≈ 41.67 ms) for invalid input.
 */
export function computeFrameBudget(opts?: TierRecommendationOptions): number {
    const fpsTarget = opts?.fpsTarget;
    const target =
        typeof fpsTarget === 'number' && Number.isFinite(fpsTarget) && fpsTarget > 0
            ? fpsTarget
            : DEFAULT_BENCHMARK_FPS_TARGET;
    return 1000 / target;
}

/**
 * Filter out samples that cannot contribute to a meaningful average: non-finite
 * (NaN, ±Infinity) and non-positive (<= 0) values are dropped.
 */
export function sanitizeFrameSamples(samples: readonly number[]): number[] {
    return samples.filter((sample) => Number.isFinite(sample) && sample > 0);
}

/**
 * Pure predicate: does one tier's sample set satisfy both budget conditions?
 * @returns `false` when no valid samples remain.
 */
export function tierMeetsBudget(
    samples: readonly number[],
    opts?: TierRecommendationOptions
): boolean {
    const valid = sanitizeFrameSamples(samples);
    if (valid.length === 0) return false;

    const budget = computeFrameBudget(opts);
    let max = -Infinity;
    let sum = 0;
    for (const sample of valid) {
        if (sample > max) max = sample;
        sum += sample;
    }
    const avg = sum / valid.length;

    return max < budget && avg < AVG_FRAME_BUDGET_RATIO * budget;
}

/**
 * Recommend a performance tier from benchmark samples.
 *
 * Returns the heaviest tier (ultra → performance) whose samples satisfy BOTH
 * `max(samples) < 1000 / fpsTarget` and `avg(samples) < 0.9 * 1000 / fpsTarget`.
 * Returns `null` when no tested tier qualifies; callers should use
 * `FALLBACK_PERFORMANCE_TIER`.
 *
 * @param samplesByTier Per-frame timings keyed by tier. Missing/empty tiers are skipped.
 * @param opts Optional `fpsTarget` override (default 24).
 */
export function recommendTierFromSamples(
    samplesByTier: TierFrameSamples,
    opts?: TierRecommendationOptions
): PerformanceTier | null {
    for (let i = PERFORMANCE_TIER_ORDER.length - 1; i >= 0; i--) {
        const tier = PERFORMANCE_TIER_ORDER[i];
        const samples = samplesByTier[tier];
        if (samples && tierMeetsBudget(samples, opts)) {
            return tier;
        }
    }
    return null;
}

/**
 * Check if the GPU device is still valid
 */
function isDeviceValid(device: GPUDevice): boolean {
    // Check if the device has been lost
    // device.lost is a Promise that resolves if the device is lost
    // We verify by checking basic device operations
    try {
        // Try to create a minimal command encoder to verify device state
        const encoder = device.createCommandEncoder();
        encoder.finish();
        return true;
    } catch {
        return false;
    }
}

/**
 * Safely destroy pipeline array
 */
async function safeDestroyPipelines(device: GPUDevice, pipelines: DestroyablePipeline[]): Promise<void> {
    // First wait for the GPU queue to complete
    try {
        await device.queue.onSubmittedWorkDone();
    } catch {
        // Ignore error
    }

    // Then destroy pipelines
    for (const pipeline of pipelines) {
        try {
            pipeline.destroy?.();
        } catch {
            // Ignore individual pipeline destroy errors
        }
    }
}

/**
 * Run GPU performance benchmark
 * Test processing time for each tier using real Anime4K effects
 */
export async function runGPUBenchmark(
    onProgress?: (progress: BenchmarkProgress) => void
): Promise<GPUBenchmarkResult> {
    const tiers = PERFORMANCE_TIER_ORDER;
    const samplesByTier: TierFrameSamples = {};
    const scores: Record<PerformanceTier, number> = {
        performance: Infinity,
        balanced: Infinity,
        quality: Infinity,
        ultra: Infinity,
    };
    const maxScores: Record<PerformanceTier, number> = {
        performance: Infinity,
        balanced: Infinity,
        quality: Infinity,
        ultra: Infinity,
    };

    // Get GPU info
    const adapterInfo = await getGPUAdapterInfo();

    // Initialize WebGPU
    if (!navigator.gpu) {
        throw new Error('WebGPU not supported');
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
        throw new Error('No GPU adapter available');
    }

    // Request higher maxBufferSize based on adapter-supported limits for high-resolution testing
    const adapterLimits = adapter.limits;
    const device = await adapter.requestDevice({
        requiredLimits: {
            maxBufferSize: adapterLimits.maxBufferSize,
            maxStorageBufferBindingSize: adapterLimits.maxStorageBufferBindingSize,
        },
    });

    // Listen for device lost events (distinguish intentional destroy from unexpected loss)
    let deviceLost = false;
    let intentionalDestroy = false;
    device.lost.then((info) => {
        if (!intentionalDestroy) {
            console.warn(`[GPUBenchmark] Device lost: ${info.reason} - ${info.message}`);
        }
        deviceLost = true;
    });

    // Per-device texture pool. The benchmark's input texture has an identical
    // descriptor for every tier, so consecutive tiers recycle the same texture
    // instead of allocating/destroying one per tier.
    const texturePool = new TexturePool(device);
    const inputTextureDescriptor = {
        width: TEST_WIDTH,
        height: TEST_HEIGHT,
        format: 'rgba8unorm' as const,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    };

    // Pre-generate test data (reused across all tiers)
    const testData = new Uint8Array(TEST_WIDTH * TEST_HEIGHT * 4);
    // crypto.getRandomValues has a 65536 byte limit, fill in chunks
    const CRYPTO_CHUNK = 65536;
    for (let offset = 0; offset < testData.length; offset += CRYPTO_CHUNK) {
        const end = Math.min(offset + CRYPTO_CHUNK, testData.length);
        crypto.getRandomValues(testData.subarray(offset, end));
    }
    // Ensure alpha channel is 255
    for (let j = 3; j < testData.length; j += 4) {
        testData[j] = 255;
    }

    // Dynamically import anime4k-webgpu-async module
    console.log('[GPUBenchmark] Loading anime4k-webgpu-async module...');
    const Anime4K = await import('anime4k-webgpu-async');

    console.log('[GPUBenchmark] Starting benchmark...');

    // Global warmup phase: run multiple frames with performance effect chain to warm up GPU
    console.log('[GPUBenchmark] Global warmup phase...');
    {
        const warmupTexture = texturePool.acquire(inputTextureDescriptor);
        device.queue.writeTexture(
            { texture: warmupTexture },
            testData,
            { bytesPerRow: TEST_WIDTH * 4, rowsPerImage: TEST_HEIGHT },
            [TEST_WIDTH, TEST_HEIGHT]
        );
        await device.queue.onSubmittedWorkDone();

        const warmupEffects = resolveEffectChain('A+A', 'performance');
        await runEffectChainTest(device, warmupTexture, warmupEffects, Anime4K);
        texturePool.release(warmupTexture);
        console.log('[GPUBenchmark] Global warmup complete');
    }

    // Progressive testing: from performance to ultra
    for (let i = 0; i < tiers.length; i++) {
        const tier = tiers[i];

        // Check if the device is still valid
        if (deviceLost || !isDeviceValid(device)) {
            console.warn(`[GPUBenchmark] Device lost before ${tier} test, stopping benchmark`);
            break;
        }

        onProgress?.({
            tier,
            progress: (i + 0.5) / tiers.length,
            completed: false,
        });

        // Acquire the input texture for this tier test from the pool. Every tier
        // uses the same descriptor, so after the first tier this is a pool hit.
        let inputTexture: GPUTexture;
        try {
            inputTexture = texturePool.acquire(inputTextureDescriptor);
            device.queue.writeTexture(
                { texture: inputTexture },
                testData,
                { bytesPerRow: TEST_WIDTH * 4, rowsPerImage: TEST_HEIGHT },
                [TEST_WIDTH, TEST_HEIGHT]
            );
            // Wait for texture write to complete
            await device.queue.onSubmittedWorkDone();
        } catch (error) {
            console.warn(`[GPUBenchmark] Failed to create texture for ${tier}:`, error);
            break;
        }

        try {
            // Set crash recovery flag
            await chrome.storage.local.set({ _benchmarkInProgress: true });

            // Get the Mode A+A effect chain for this tier
            const effects = resolveEffectChain('A+A', tier);

            // Run the test
            const { avgTime, maxTime, samples } = await runWithTimeout(
                runEffectChainTest(device, inputTexture, effects, Anime4K),
                TEST_TIMEOUT_MS
            );

            // Clear crash flag
            await chrome.storage.local.remove('_benchmarkInProgress');

            scores[tier] = avgTime;
            maxScores[tier] = maxTime;
            samplesByTier[tier] = samples;
            console.log(`[GPUBenchmark] ${tier}: avg=${avgTime.toFixed(2)}ms, max=${maxTime.toFixed(2)}ms per frame`);

            // Return the texture to the pool for reuse by the next tier
            try {
                await device.queue.onSubmittedWorkDone();
                texturePool.release(inputTexture);
            } catch {
                // Ignore cleanup error
            }

            // If current tier is too slow, skip heavier tiers
            if (avgTime > TARGET_FRAME_TIME_24FPS * 2) {
                console.log(`[GPUBenchmark] ${tier} too slow (${avgTime.toFixed(2)}ms), skipping heavier tiers`);
                break;
            }

        } catch (error) {
            console.warn(`[GPUBenchmark] ${tier} failed:`, error);
            await chrome.storage.local.remove('_benchmarkInProgress');

            try {
                texturePool.release(inputTexture);
            } catch {
                // Ignore cleanup error
            }

            // If the first tier (performance) fails, throw immediately
            if (i === 0) {
                intentionalDestroy = true;
                texturePool.dispose();
                device.destroy();
                throw error;
            }
            // Otherwise use the tiers that succeeded
            break;
        }

        onProgress?.({
            tier,
            progress: (i + 1) / tiers.length,
            completed: false,
        });
    }

    // If no tier succeeded (all scores are Infinity), throw
    if (scores.performance === Infinity) {
        intentionalDestroy = true;
        texturePool.dispose();
        device.destroy();
        throw new Error('All benchmark tests failed');
    }

    // Apply the formal benchmark → tier policy (see recommendTierFromSamples).
    // `null` means no tested tier met the budget; fall back to the lightest tier.
    const recommendedTier: PerformanceTier =
        recommendTierFromSamples(samplesByTier) ?? FALLBACK_PERFORMANCE_TIER;

    // Cleanup resources
    intentionalDestroy = true;
    texturePool.dispose();
    device.destroy();

    const result: GPUBenchmarkResult = {
        tier: recommendedTier,
        scores,
        maxScores,
        timestamp: Date.now(),
        adapterInfo,
    };

    onProgress?.({
        tier: 'done',
        progress: 1,
        completed: true,
    });

    return result;
}

/**
 * Run effect chain test
 * @returns Average frame time, max frame time, and the raw stable per-frame samples
 */
export async function runEffectChainTest(
    device: GPUDevice,
    inputTexture: GPUTexture,
    effects: EnhancementEffect[],
    Anime4K: typeof import('anime4k-webgpu-async'),
    /** Source/input dimensions. Defaults to the benchmark's 1080p test input. */
    sourceDimensions: Dimensions = { width: TEST_WIDTH, height: TEST_HEIGHT },
): Promise<{ avgTime: number; maxTime: number; samples: number[] }> {
    // Build pipelines through the shared effect-chain compiler (lockstep with
    // the renderer's pipeline builder). The benchmark's device, warmup, batching
    // and discard-window policy below are untouched.
    // Get Downscale class dynamically
    const DownscaleClass = Anime4K.Downscale;

    const targetDimensions = { width: TARGET_WIDTH, height: TARGET_HEIGHT };
    const resolutions: EffectResolution[] = effects.map((effect) =>
        resolveEffectReference(effect),
    );

    if (!cachedBenchmarkRegistry) {
        // Explicit `.js` specifier (TS node16 dynamic-import resolution); webpack's
        // extensionAlias maps it to the `.ts`. Must stay dynamic so the library
        // is not inlined into the benchmark's module graph.
        const { getBackendRegistry } = await import('@core/engines/registry.js');
        cachedBenchmarkRegistry = getBackendRegistry();
    }
    const registry = cachedBenchmarkRegistry;

    const upscaleFactors = deriveUpscaleFactors(effects, resolutions);

    // Benchmark geometry uses the same restore policy as the renderer's
    // new default ('gate'): the trailing drop set, with retained restores gated
    // by the same resolution-dependent profile. The role flags come from the
    // resolved descriptor category (helpers are never restores).
    const restoreFlags = deriveRestoreFlags(resolutions);

    // Color-category effects (color grading) must run AFTER the deferred
    // ClampHighlightsApply epilogue, exactly as the renderer's pipeline builder
    // derives it, so benchmark and renderer share the same ordering.
    const postEpilogueFlags = derivePostEpilogueFlags(resolutions);

    const result = await compileEffectChain({
        device,
        inputTexture,
        sourceDimensions,
        targetDimensions,
        effects,
        upscaleFactors,
        downscaleCtor: DownscaleClass,
        restoreFlags,
        postEpilogueFlags,
        restoreSuppression: 'gate',
        compileEffect: createEffectCompiler({
            device,
            registry,
            resolutions,
            resources: gpuResourceCache,
            sourceDimensions,
            isStale: () => false,
            gating: selectGatedRestoreOptions(targetDimensions),
            logging: {
                registryFailure: (effect, _backendId, error) => {
                    console.warn(`[GPUBenchmark] Registry compile failed for ${effect.className}:`, error);
                },
                skipped: (effect, status) => {
                    console.warn(`[GPUBenchmark] ${status === 'unresolved' ? 'Unresolved' : 'Unknown'} effect "${effect.className}"; skipping.`);
                },
                unexpected: (effect, error) => {
                    console.warn(`[GPUBenchmark] Failed to create ${effect.className}:`, error);
                },
            },
        }),
    });

    const pipelines = result.pipelines;

    if (pipelines.length === 0) {
        throw new Error('No valid pipelines created');
    }

    // Warmup: run each effect individually to avoid memory pressure from running the full chain
    for (let pipelineIdx = 0; pipelineIdx < pipelines.length; pipelineIdx++) {
        const pipeline = pipelines[pipelineIdx];
        const commandEncoder = device.createCommandEncoder();
        await pipeline.pass(commandEncoder);
        device.queue.submit([commandEncoder.finish()]);
        await device.queue.onSubmittedWorkDone();
    }

    // Full warmup: run the complete pipeline chain for 4 frames
    for (let warmup = 0; warmup < 4; warmup++) {
        const commandEncoder = device.createCommandEncoder();
        for (const pipeline of pipelines) {
            await pipeline.pass(commandEncoder);
        }
        device.queue.submit([commandEncoder.finish()]);
        await device.queue.onSubmittedWorkDone();
    }


    // Actual test: run 120 frames, record per-frame time
    const testFrames = 120;
    const frameTimes: number[] = [];

    // To avoid the huge overhead of single-frame sync (onSubmittedWorkDone) on Firefox,
    // and to avoid TDR (timeout detection) crashes from submitting too many frames at once,
    // we use a micro-batching strategy.
    const BATCH_SIZE = 6;

    for (let frame = 0; frame < testFrames; frame += BATCH_SIZE) {
        const batchStart = performance.now();
        const framesInBatch = Math.min(BATCH_SIZE, testFrames - frame);

        for (let i = 0; i < framesInBatch; i++) {
            const commandEncoder = device.createCommandEncoder();
            for (const pipeline of pipelines) {
                await pipeline.pass(commandEncoder);
            }
            device.queue.submit([commandEncoder.finish()]);
        }

        // Wait for the current batch to complete
        await device.queue.onSubmittedWorkDone();

        const batchDuration = performance.now() - batchStart;
        const avgFrameTime = batchDuration / framesInBatch;

        // Use the average frame time as the score for each frame in this batch
        for (let i = 0; i < framesInBatch; i++) {
            frameTimes.push(avgFrameTime);
        }
    }

    // Discard the first 24 frames to eliminate warmup bias (shader compilation latency, GPU frequency ramp-up, etc.)
    const WARMUP_DISCARD_FRAMES = 24;
    const stableFrameTimes = frameTimes.slice(WARMUP_DISCARD_FRAMES);
    const totalTime = stableFrameTimes.reduce((a, b) => a + b, 0);
    const avgTime = totalTime / stableFrameTimes.length;
    const maxTime = Math.max(...stableFrameTimes);

    // Safely cleanup pipelines (wait for sync before destroying)
    await safeDestroyPipelines(device, pipelines);

    return { avgTime, maxTime, samples: stableFrameTimes };
}

/**
 * Get GPU adapter info
 */
async function getGPUAdapterInfo(): Promise<string> {
    if (!navigator.gpu) return 'WebGPU not supported';

    try {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) return 'No adapter';

        const gpuAdapter = adapter as unknown as GPUAdapterWithInfo;
        const info = gpuAdapter.requestAdapterInfo
            ? await gpuAdapter.requestAdapterInfo()
            : { vendor: '', architecture: '', device: '', description: '' };

        return JSON.stringify({
            vendor: info.vendor || 'unknown',
            architecture: info.architecture || 'unknown',
            device: info.device || 'unknown',
            description: info.description || 'unknown',
        });
    } catch {
        return 'Error getting adapter info';
    }
}

/**
 * Promise with timeout
 */
function runWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error('Timeout')), timeoutMs)
        ),
    ]);
}
