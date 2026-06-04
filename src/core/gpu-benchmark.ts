/**
 * GPU performance benchmark module
 * Tests using real Anime4K effects
 */

import type { PerformanceTier, GPUBenchmarkResult, EnhancementEffect } from '../types';
import { resolveEffectChain } from '../utils/effect-chain-templates';

// Test configuration
const TEST_TIMEOUT_MS = 20000; // Individual test timeout
const TEST_WIDTH = 1920;  // Test input width (1080p)
const TEST_HEIGHT = 1080; // Test input height
const TARGET_WIDTH = 3840;  // Target 4K
const TARGET_HEIGHT = 2160;
const TARGET_FRAME_TIME_24FPS = 1000 / 24; // ~41.67ms

export interface BenchmarkProgress {
    tier: string;
    progress: number;
    completed: boolean;
    error?: string;
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
async function safeDestroyPipelines(device: GPUDevice, pipelines: any[]): Promise<void> {
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
    const tiers: PerformanceTier[] = ['performance', 'balanced', 'quality', 'ultra'];
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

    let recommendedTier: PerformanceTier = 'performance';

    // Dynamically import anime4k-webgpu module
    console.log('[GPUBenchmark] Loading anime4k-webgpu module...');
    const Anime4K = await import('anime4k-webgpu');

    console.log('[GPUBenchmark] Starting benchmark...');

    // Global warmup phase: run multiple frames with performance effect chain to warm up GPU
    console.log('[GPUBenchmark] Global warmup phase...');
    {
        const warmupTexture = device.createTexture({
            size: [TEST_WIDTH, TEST_HEIGHT],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        device.queue.writeTexture(
            { texture: warmupTexture },
            testData,
            { bytesPerRow: TEST_WIDTH * 4, rowsPerImage: TEST_HEIGHT },
            [TEST_WIDTH, TEST_HEIGHT]
        );
        await device.queue.onSubmittedWorkDone();

        const warmupEffects = resolveEffectChain('A+A', 'performance');
        await runEffectChainTest(device, warmupTexture, warmupEffects, Anime4K);
        warmupTexture.destroy();
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

        // Create independent input texture for each tier test
        let inputTexture: GPUTexture;
        try {
            inputTexture = device.createTexture({
                size: [TEST_WIDTH, TEST_HEIGHT],
                format: 'rgba8unorm',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
            });
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
            const { avgTime, maxTime } = await runWithTimeout(
                runEffectChainTest(device, inputTexture, effects, Anime4K),
                TEST_TIMEOUT_MS
            );

            // Clear crash flag
            await chrome.storage.local.remove('_benchmarkInProgress');

            scores[tier] = avgTime;
            maxScores[tier] = maxTime;
            console.log(`[GPUBenchmark] ${tier}: avg=${avgTime.toFixed(2)}ms, max=${maxTime.toFixed(2)}ms per frame`);

            // If it can sustain 24fps stably, this tier is usable
            // Requirement: max frame time < target frame time, avg frame time < target * 0.9
            if (maxTime < TARGET_FRAME_TIME_24FPS && avgTime < TARGET_FRAME_TIME_24FPS * 0.9) {
                recommendedTier = tier;
            }

            // Safely destroy texture
            try {
                await device.queue.onSubmittedWorkDone();
                inputTexture.destroy();
            } catch {
                // Ignore destroy error
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
                inputTexture.destroy();
            } catch {
                // Ignore destroy error
            }

            // If the first tier (performance) fails, throw immediately
            if (i === 0) {
                intentionalDestroy = true;
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
        device.destroy();
        throw new Error('All benchmark tests failed');
    }

    // Cleanup resources
    intentionalDestroy = true;
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
 * @returns Average frame time and max frame time
 */
async function runEffectChainTest(
    device: GPUDevice,
    inputTexture: GPUTexture,
    effects: EnhancementEffect[],
    Anime4K: typeof import('anime4k-webgpu')
): Promise<{ avgTime: number; maxTime: number }> {
    // Build pipelines
    const pipelines: any[] = [];
    let currentTexture: GPUTexture = inputTexture;
    let curWidth = TEST_WIDTH;
    let curHeight = TEST_HEIGHT;

    // Get Downscale class dynamically
    const DownscaleClass = (Anime4K as Record<string, any>).Downscale;

    // Pre-calculate remaining upscale factors
    const upscaleFactors = effects.map(e => e.upscaleFactor ?? 1);
    const remainingUpscaleFactors = upscaleFactors.map((_, i) =>
        upscaleFactors.slice(i + 1).reduce((acc, val) => acc * val, 1)
    );

    for (let i = 0; i < effects.length; i++) {
        const effect = effects[i];
        try {
            const EffectClass = (Anime4K as Record<string, any>)[effect.className];
            if (!EffectClass) {
                console.warn(`[GPUBenchmark] Effect class not found: ${effect.className}`);
                continue;
            }

            const pipeline = new EffectClass({
                device,
                inputTexture: currentTexture,
                nativeDimensions: { width: curWidth, height: curHeight },
                targetDimensions: { width: TARGET_WIDTH, height: TARGET_HEIGHT },
            });
            pipelines.push(pipeline);

            // Update current texture to this pipeline's output
            currentTexture = pipeline.getOutputTexture();

            // Update dimensions
            const upscaleFactor = effect.upscaleFactor ?? 1;
            if (upscaleFactor > 1) {
                curWidth *= upscaleFactor;
                curHeight *= upscaleFactor;

                // Check if intermediate downscaling is needed (consistent with renderer.ts)
                const remainingFactor = remainingUpscaleFactors[i];
                if (DownscaleClass && remainingFactor > 1) {
                    const idealIntermediateWidth = TARGET_WIDTH / remainingFactor;
                    const idealIntermediateHeight = TARGET_HEIGHT / remainingFactor;

                    if (curWidth > idealIntermediateWidth * 1.1) {
                        const intermediateDownscale = new DownscaleClass({
                            device,
                            inputTexture: currentTexture,
                            targetDimensions: {
                                width: Math.ceil(idealIntermediateWidth),
                                height: Math.ceil(idealIntermediateHeight),
                            },
                        });
                        pipelines.push(intermediateDownscale);
                        currentTexture = intermediateDownscale.getOutputTexture();
                        curWidth = Math.ceil(idealIntermediateWidth);
                        curHeight = Math.ceil(idealIntermediateHeight);
                    }
                }
            }
        } catch (e) {
            console.warn(`[GPUBenchmark] Failed to create ${effect.className}:`, e);
        }
    }

    if (pipelines.length === 0) {
        throw new Error('No valid pipelines created');
    }

    // Warmup: run each effect individually to avoid memory pressure from running the full chain
    for (let pipelineIdx = 0; pipelineIdx < pipelines.length; pipelineIdx++) {
        const pipeline = pipelines[pipelineIdx];
        const commandEncoder = device.createCommandEncoder();
        pipeline.pass(commandEncoder);
        device.queue.submit([commandEncoder.finish()]);
        await device.queue.onSubmittedWorkDone();
    }

    // Full warmup: run the complete pipeline chain for 4 frames
    for (let warmup = 0; warmup < 4; warmup++) {
        const commandEncoder = device.createCommandEncoder();
        for (const pipeline of pipelines) {
            pipeline.pass(commandEncoder);
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
                pipeline.pass(commandEncoder);
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

    return { avgTime, maxTime };
}

/**
 * Get GPU adapter info
 */
async function getGPUAdapterInfo(): Promise<string> {
    if (!navigator.gpu) return 'WebGPU not supported';

    try {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) return 'No adapter';

        const info = (adapter as any).requestAdapterInfo
            ? await (adapter as any).requestAdapterInfo()
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
