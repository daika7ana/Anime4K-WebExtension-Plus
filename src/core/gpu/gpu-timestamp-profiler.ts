/**
 * GPU timestamp-query profiler for the renderer's top-level effect chain.
 *
 * ## Why marker passes?
 * The external `anime4k-webgpu-async` pipelines open their own compute passes
 * internally and are intentionally not modified. `GPUCommandEncoder.writeTimestamp`
 * does not exist in `@webgpu/types@0.1.72`, so this profiler cannot drop bare
 * timestamp commands between library-owned passes. Instead the *renderer* emits
 * its own zero-work 1x1 "marker" render passes around the effect chain. Each
 * marker pass writes one begin/end timestamp pair, and the time spent between
 * two markers is attributed to the effect encoded in that gap:
 *
 * ```
 * gpu(effect i) = ts[mark_i.begin] - ts[mark_{i-1}.end]
 * gpu(blit)     = ts[blit.end]    - ts[blit.begin]
 * totalGpu      = ts[blit.end]    - ts[mark_0.end]
 * ```
 *
 * `mark_0` is a baseline marker emitted by `beginFrame` itself before the
 * renderer encodes any pipeline. It is never surfaced as a HUD label; it only
 * establishes the frame start so the first effect is sampled and `totalGpu`
 * spans the whole chain. The final blit is timed by passing the pair from
 * {@link GpuFrameRecorder.writesFor} to the caller's own render pass.
 *
 * ## Two-buffer readback
 * WebGPU forbids combining `MAP_READ` with any usage other than `COPY_DST`
 * (Dawn rejects such a `createBuffer` asynchronously and hands back an invalid
 * buffer). Each ring slot therefore owns two buffers: a
 * `QUERY_RESOLVE | COPY_SRC` buffer that `resolveQuerySet` writes, and a
 * `MAP_READ | COPY_DST` staging buffer that receives a `copyBufferToBuffer` and
 * is mapped for the CPU. Mixing the flags on one buffer previously resolved into
 * an invalid buffer, invalidating the entire command encoder and silently
 * dropping the presentation blit.
 *
 * ## Non-blocking readback
 * A ring of `ringSize` readback slots is cycled through a
 * `free | pending | reading` state machine. `beginFrame` only claims a `free`
 * slot; when every slot is in flight it returns `null` and the frame simply
 * runs unprofiled. `afterSubmit` kicks `mapAsync` and never awaits, so the
 * render loop never stalls. A slot is recycled only after its samples have been
 * parsed and the buffer unmapped. `abortFrame()` releases a claimed slot when a
 * frame throws between `beginFrame` and `endFrame`.
 *
 * ## Failure isolation
 * Profiler failures must never reach the render loop, so a profiler is only
 * activated after {@link GpuTimestampProfiler.verify} proves its resources and a
 * probe command actually work. `create()` is the only factory and returns `null`
 * when timestamp queries are unavailable; resource construction failures yield
 * an instance with `status: 'unsupported'`. `verify()` wraps an offscreen probe
 * (marker pass -> resolveQuerySet -> copyBufferToBuffer -> submit -> mapAsync) in
 * a validation error scope and destroys the profiler on any error. On an active
 * profiler, `mapAsync` rejections and encode/resolve errors drop the sample and
 * increment a consecutive-failure counter; after three consecutive failures the
 * profiler reports `degraded` and stops emitting markers. `reset()` re-arms a
 * degraded profiler and clears its accumulated statistics. `destroy()` is
 * idempotent.
 *
 * ## Timestamp units
 * Chrome/Dawn report timestamps in nanoseconds with roughly 100 µs
 * quantization. Samples are converted to milliseconds with {@link NS_PER_MS}
 * and fed to {@link RollingStats}; high-percentile values are therefore useful
 * for spotting multi-millisecond stalls, not sub-100 µs detail. Deltas that are
 * non-positive or non-finite (e.g. after a timestamp-counter reset) are
 * discarded rather than poisoning the statistics.
 *
 * ## Sizing
 * A frame needs `2 * (pipelineCount + 1) + 2` queries (N+1 markers including the
 * baseline, plus the blit pair). Because the number of `mark()`/`writesFor()`
 * calls is only known while encoding, the query set is sized from a default for
 * ~{@link DEFAULT_PIPELINE_COUNT} pipelines and grows lazily to the largest
 * frame seen so far once every ring slot is free.
 */

import { RollingStats } from '@core/perf/performance-statistics';

/** Possible lifecycle states of a profiler. */
export type ProfilerStatus = 'active' | 'unsupported' | 'degraded' | 'destroyed';

/** Per-label timings surfaced to the HUD. Optional fields are omitted until sampled. */
export interface PassTiming {
    label: string;
    cpuP50?: number;
    cpuP95?: number;
    gpuP50?: number;
    gpuP95?: number;
    gpuP99?: number;
    gpuLast?: number;
}

/** Point-in-time profiler snapshot. */
export interface ProfilerSnapshot {
    status: ProfilerStatus;
    /** Number of frames whose timestamps were successfully parsed. */
    framesSampled: number;
    totalGpuP50: number | null;
    totalGpuP95: number | null;
    /** Per-label timings, ordered as encoded. */
    passes: PassTiming[];
}

/** Options accepted by {@link GpuTimestampProfiler.create}. */
export interface GpuTimestampProfilerOptions {
    ringSize?: number;
    windowSize?: number;
}

/** Timestamp writes returned by {@link GpuFrameRecorder.writesFor}. */
export type TimestampWrites = GPUComputePassTimestampWrites | GPURenderPassTimestampWrites;

/** Nanoseconds per millisecond (Chrome/Dawn timestamps are nanoseconds). */
const NS_PER_MS = 1e6;

/**
 * Whether a millisecond delta is usable: strictly positive and finite.
 * Non-positive deltas (e.g. after a timestamp-counter reset) and non-finite
 * values are discarded so they cannot poison {@link RollingStats}.
 */
export function isPositiveFinite(ms: number): boolean {
    return ms > 0 && Number.isFinite(ms);
}

const DEFAULT_RING_SIZE = 3;
const DEFAULT_WINDOW_SIZE = 120;
/** Typical Anime4K top-level effect count used to pre-size the query set. */
const DEFAULT_PIPELINE_COUNT = 12;
/** Queries needed by one frame with ~{@link DEFAULT_PIPELINE_COUNT} pipelines. */
const DEFAULT_QUERIES_PER_FRAME = 2 * (DEFAULT_PIPELINE_COUNT + 1) + 2;
/** Consecutive failures before the profiler degrades and stops emitting markers. */
const MAX_CONSECUTIVE_FAILURES = 3;
/** Reserved baseline marker label; never registered, so it never becomes a HUD row. */
const BASELINE_LABEL = '__baseline__';
/** Upper bound on the verification probe's readback before it is treated as failed. */
const VERIFY_TIMEOUT_MS = 2000;

type SlotState = 'free' | 'pending' | 'reading';

/** One timestamp pair written by a marker pass or a `writesFor` pass. */
interface QueryPair {
    label: string;
    begin: number;
    end: number;
}

/**
 * Per-slot readback pair. `resolve` is written by `resolveQuerySet` and copied
 * into `read`, which is the only buffer carrying `MAP_READ`.
 */
interface ReadbackSlot {
    resolve: GPUBuffer;
    read: GPUBuffer;
}

/** State captured while a frame is being recorded, used later during readback. */
interface FrameRecording {
    slot: number;
    /** Per-frame query stride in force when the frame started. */
    capacity: number;
    /** Absolute query index of relative index 0 for this frame. */
    base: number;
    /** Number of query slots consumed so far (relative). */
    nextQueries: number;
    marks: QueryPair[];
    writes: QueryPair[];
    overflowed: boolean;
    failed: boolean;
}

/**
 * Recording handle for a single frame.
 *
 * A recorder is only valid until its frame is submitted/ended; after that its
 * methods become safe no-ops. It never throws, even after the profiler is
 * destroyed.
 */
export interface GpuFrameRecorder {
    /**
     * Emit one empty 1x1 marker render pass and record its timestamp pair.
     * No-op when the profiler is inactive or the frame already overflowed.
     */
    mark(label: string): void;

    /** Convenience passthrough for CPU-side timing (works without a GPU sample). */
    recordCpu(label: string, ms: number): void;

    /**
     * Timestamp writes to attach to the caller's own pass (typically the final
     * blit), or `undefined` when the profiler is not actively recording.
     */
    writesFor(label: string): TimestampWrites | undefined;
}

/**
 * Per-device GPU timestamp profiler for the renderer's top-level effect chain.
 *
 * Obtain an instance with {@link GpuTimestampProfiler.create}; it returns `null`
 * when the device cannot do timestamp queries. Call {@link verify} before using
 * it so a broken profiler can never invalidate the presentation path. See the
 * module header for the measurement model and failure semantics.
 */
export class GpuTimestampProfiler {
    private readonly device: GPUDevice;
    private readonly ringSize: number;
    private readonly windowSize: number;

    private state: ProfilerStatus = 'active';

    private markerTexture: GPUTexture | null = null;
    private markerView: GPUTextureView | null = null;
    private querySet: GPUQuerySet | null = null;
    private readSlots: ReadbackSlot[] = [];
    private slots: SlotState[] = [];

    /** Per-frame query stride currently allocated into {@link querySet}/{@link readSlots}. */
    private queriesPerFrame = DEFAULT_QUERIES_PER_FRAME;
    /** Largest per-frame query need observed so far; drives lazy growth. */
    private maxQueriesSeen = 0;

    private currentFrame: FrameRecording | null = null;
    private submittedFrame: FrameRecording | null = null;

    private framesSampled = 0;
    private consecutiveFailures = 0;

    private readonly gpuStats = new Map<string, RollingStats>();
    private readonly cpuStats = new Map<string, RollingStats>();
    private readonly totalStats: RollingStats;
    private readonly lastGpu = new Map<string, number>();
    /** Labels in encode order (first-seen union across frames). */
    private labels: string[] = [];

    private constructor(device: GPUDevice, opts: GpuTimestampProfilerOptions = {}) {
        this.device = device;
        this.ringSize = Math.max(1, Math.floor(opts.ringSize ?? DEFAULT_RING_SIZE));
        this.windowSize = Math.max(1, Math.floor(opts.windowSize ?? DEFAULT_WINDOW_SIZE));
        this.totalStats = new RollingStats(this.windowSize);
    }

    /**
     * Create a profiler for `device`, or `null` when timestamp queries are not
     * supported. Resource-construction failures are caught and produce an
     * instance with `status: 'unsupported'` instead of throwing. The caller must
     * still await {@link verify} before activating the instance.
     */
    static create(
        device: GPUDevice,
        opts?: GpuTimestampProfilerOptions,
    ): GpuTimestampProfiler | null {
        if (typeof device.createQuerySet !== 'function') return null;
        if (!device.features?.has('timestamp-query')) return null;

        let profiler: GpuTimestampProfiler | null = null;
        try {
            profiler = new GpuTimestampProfiler(device, opts);
            profiler.initialize();
        } catch {
            if (profiler) {
                profiler.state = 'unsupported';
                return profiler;
            }
            return null;
        }
        return profiler;
    }

    /** Current lifecycle state. */
    get status(): ProfilerStatus {
        return this.state;
    }

    /**
     * Probe that the profiler's resources and encode/readback path actually work
     * on this device. Encodes a single offscreen marker pass, resolves, copies
     * into the staging buffer, submits, and maps it back, all inside a
     * validation error scope. Destroys the profiler and returns `false` on any
     * error or non-clean scope; never throws.
     */
    async verify(): Promise<boolean> {
        if (this.state !== 'active') return false;

        const querySet = this.querySet;
        const view = this.markerView;
        const slot = this.readSlots[0];
        if (!querySet || !view || !slot) {
            this.destroy();
            return false;
        }

        let scopePushed = false;
        try {
            this.device.pushErrorScope('validation');
            scopePushed = true;

            const encoder = this.device.createCommandEncoder();
            const pass = encoder.beginRenderPass({
                colorAttachments: [
                    {
                        view,
                        clearValue: { r: 0, g: 0, b: 0, a: 0 },
                        loadOp: 'clear',
                        storeOp: 'discard',
                    },
                ],
                timestampWrites: {
                    querySet,
                    beginningOfPassWriteIndex: 0,
                    endOfPassWriteIndex: 1,
                },
            });
            pass.end();
            encoder.resolveQuerySet(querySet, 0, 2, slot.resolve, 0);
            encoder.copyBufferToBuffer(slot.resolve, 0, slot.read, 0, 16);
            this.device.queue.submit([encoder.finish()]);

            const mapped = await this.awaitMap(slot.read);
            if (mapped) {
                try {
                    slot.read.unmap();
                } catch {
                    // Best-effort: the device may already be lost.
                }
            }

            const validationError = await this.device.popErrorScope();
            scopePushed = false;

            if (validationError || !mapped) {
                this.destroy();
                return false;
            }
            return true;
        } catch {
            if (scopePushed) {
                try {
                    await this.device.popErrorScope();
                } catch {
                    // Best-effort.
                }
            }
            this.destroy();
            return false;
        }
    }

    /**
     * Begin recording a frame. Returns `null` when the profiler is inactive or
     * no readback slot is free; in both cases the render path is otherwise
     * unchanged. Emits the baseline marker immediately so `marks[0]` anchors the
     * frame.
     */
    beginFrame(encoder: GPUCommandEncoder): GpuFrameRecorder | null {
        if (this.state !== 'active') return null;

        // Defensively reclaim the slot of a frame that was never ended/aborted.
        if (this.currentFrame) this.abortFrame();

        this.maybeGrow();

        const slot = this.acquireSlot();
        if (slot < 0) return null;

        const frame: FrameRecording = {
            slot,
            capacity: this.queriesPerFrame,
            base: slot * this.queriesPerFrame,
            nextQueries: 0,
            marks: [],
            writes: [],
            overflowed: false,
            failed: false,
        };

        this.slots[slot] = 'pending';
        this.currentFrame = frame;

        // Baseline marker: reserves the first query pair and anchors the frame so
        // the first pipeline is sampled and totalGpu spans the whole chain. It is
        // not registered, so it never appears as a HUD pass row.
        this.markFrame(frame, encoder, BASELINE_LABEL, false);

        return {
            mark: (label) => this.markFrame(frame, encoder, label),
            recordCpu: (label, ms) => this.recordCpu(label, ms),
            writesFor: (label) => this.writesForFrame(frame, label),
        };
    }

    /**
     * Record per-CPU timing for `label`. Works even when no recorder/GPU sample
     * is available (e.g. skipped or slot-busy frames). Uses the same rolling
     * window under a `cpu:` namespace.
     */
    recordCpu(label: string, ms: number): void {
        if (this.state === 'destroyed') return;
        this.statsFor(this.cpuStats, `cpu:${label}`).push(ms);
        this.registerLabel(label);
    }

    /**
     * Resolve the frame's query range into its slot's resolve buffer and copy it
     * into the MAP_READ staging buffer. Must be called before `encoder.finish()`;
     * never throws.
     */
    endFrame(encoder: GPUCommandEncoder): void {
        const frame = this.currentFrame;
        if (!frame) return;
        this.currentFrame = null;
        this.submittedFrame = frame;

        this.maxQueriesSeen = Math.max(this.maxQueriesSeen, frame.nextQueries);

        const used = Math.min(frame.nextQueries, frame.capacity);
        if (this.state !== 'active' || used <= 0 || frame.overflowed) return;

        const querySet = this.querySet;
        const slot = this.readSlots[frame.slot];
        if (!querySet || !slot) return;

        try {
            encoder.resolveQuerySet(querySet, frame.base, used, slot.resolve, 0);
            encoder.copyBufferToBuffer(slot.resolve, 0, slot.read, 0, 8 * used);
        } catch {
            frame.failed = true;
            this.noteFailure();
        }
    }

    /**
     * Kick off asynchronous readback for the just-submitted frame. Must be
     * called immediately after `queue.submit()`; never awaits.
     */
    afterSubmit(): void {
        const frame = this.submittedFrame;
        this.submittedFrame = null;
        if (!frame) return;

        const slot = this.readSlots[frame.slot];

        if (
            !slot ||
            frame.failed ||
            frame.overflowed ||
            this.state !== 'active'
        ) {
            this.releaseSlot(frame.slot);
            return;
        }

        try {
            slot.read.mapAsync(GPUMapMode.READ).then(
                () => this.onMapped(frame, slot.read),
                () => {
                    this.releaseSlot(frame.slot);
                    this.noteFailure();
                },
            );
        } catch {
            this.releaseSlot(frame.slot);
            this.noteFailure();
        }
    }

    /**
     * Abandon the in-progress frame without resolving its queries, releasing any
     * claimed slot. Called when the renderer throws between `beginFrame()` and
     * `endFrame()` so the ring cannot leak. Safe to call with no frame pending.
     */
    abortFrame(): void {
        const current = this.currentFrame;
        if (current) {
            this.currentFrame = null;
            this.releaseSlot(current.slot);
        }
        const submitted = this.submittedFrame;
        if (submitted) {
            this.submittedFrame = null;
            this.releaseSlot(submitted.slot);
        }
    }

    /** Snapshot the accumulated GPU/CPU statistics and total frame time. */
    snapshot(): ProfilerSnapshot {
        const total = this.totalStats.summary();
        const passes: PassTiming[] = [];

        for (const label of this.labels) {
            const gpu = this.gpuStats.get(label);
            const cpu = this.cpuStats.get(`cpu:${label}`);
            const gpuSummary = gpu?.summary();
            const cpuSummary = cpu?.summary();
            const hasGpu = gpuSummary !== undefined && gpuSummary.count > 0;
            const hasCpu = cpuSummary !== undefined && cpuSummary.count > 0;
            if (!hasGpu && !hasCpu) continue;

            const timing: PassTiming = { label };
            if (hasCpu && cpuSummary) {
                timing.cpuP50 = cpuSummary.p50;
                timing.cpuP95 = cpuSummary.p95;
            }
            if (hasGpu && gpuSummary) {
                timing.gpuP50 = gpuSummary.p50;
                timing.gpuP95 = gpuSummary.p95;
                timing.gpuP99 = gpuSummary.p99;
                const last = this.lastGpu.get(label);
                if (last !== undefined) timing.gpuLast = last;
            }
            passes.push(timing);
        }

        return {
            status: this.state,
            framesSampled: this.framesSampled,
            totalGpuP50: total.count > 0 ? total.p50 : null,
            totalGpuP95: total.count > 0 ? total.p95 : null,
            passes,
        };
    }

    /**
     * Clear accumulated labels/statistics after a pipeline rebuild or
     * resolution change. Re-arms a degraded profiler so a transient failure can
     * recover; a destroyed or unsupported profiler is left as-is.
     */
    reset(): void {
        // Reclaim any in-flight ring slot before dropping the frame records.
        // beginFrame() marks the slot 'pending', so nulling currentFrame alone
        // would strand it as permanently busy and silently stop profiling after
        // ringSize such resets. abortFrame() releases the slot and clears both
        // frame records; it is a no-op when nothing is in flight.
        this.abortFrame();
        this.gpuStats.clear();
        this.cpuStats.clear();
        this.totalStats.clear();
        this.lastGpu.clear();
        this.labels = [];
        this.framesSampled = 0;
        this.consecutiveFailures = 0;
        if (this.state === 'degraded') this.state = 'active';
    }

    /**
     * Destroy GPU resources and stop profiling. Safe to call repeatedly.
     */
    destroy(): void {
        if (this.state === 'destroyed') return;
        this.state = 'destroyed';
        this.currentFrame = null;
        this.submittedFrame = null;
        this.slots = [];
        this.destroyResources();
    }

    // ─── Resource lifecycle ───

    private initialize(): void {
        this.markerTexture = this.device.createTexture({
            size: [1, 1],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
            label: 'anime4k-timestamp-marker',
        });
        this.markerView = this.markerTexture.createView();
        this.querySet = this.device.createQuerySet({
            type: 'timestamp',
            count: this.ringSize * this.queriesPerFrame,
            label: 'anime4k-timestamp-queries',
        });
        this.readSlots = this.createReadSlots(this.queriesPerFrame);
        this.slots = new Array<SlotState>(this.ringSize).fill('free');
    }

    /**
     * Create one resolve + MAP_READ staging buffer per ring slot. The two usages
     * are kept separate because `MAP_READ` may only be combined with `COPY_DST`.
     */
    private createReadSlots(queriesPerFrame: number): ReadbackSlot[] {
        const byteSize = 8 * queriesPerFrame;
        return Array.from({ length: this.ringSize }, (_, index) => ({
            resolve: this.device.createBuffer({
                size: byteSize,
                usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
                label: `anime4k-timestamp-resolve-${index}`,
            }),
            read: this.device.createBuffer({
                size: byteSize,
                usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
                label: `anime4k-timestamp-readback-${index}`,
            }),
        }));
    }

    private destroyResources(): void {
        const querySet = this.querySet;
        const slots = this.readSlots;
        const texture = this.markerTexture;
        this.querySet = null;
        this.readSlots = [];
        this.markerTexture = null;
        this.markerView = null;

        try {
            querySet?.destroy();
        } catch {
            // Best-effort: the device may already be lost.
        }
        for (const slot of slots) {
            try {
                slot.resolve.destroy();
            } catch {
                // Best-effort.
            }
            try {
                slot.read.destroy();
            } catch {
                // Best-effort.
            }
        }
        try {
            texture?.destroy();
        } catch {
            // Best-effort.
        }
    }

    /**
     * Recreate the query set and readback slots when a previously recorded
     * frame needed more queries than are currently allocated. Growth is only
     * safe once every slot is free (buffers may still be mapped otherwise); it
     * is deferred to a later frame when they are not.
     */
    private maybeGrow(): void {
        if (this.maxQueriesSeen <= this.queriesPerFrame) return;
        if (this.slots.some((slot) => slot !== 'free')) return;

        const target = this.maxQueriesSeen;
        try {
            const querySet = this.device.createQuerySet({
                type: 'timestamp',
                count: this.ringSize * target,
                label: 'anime4k-timestamp-queries',
            });
            const slots = this.createReadSlots(target);

            const oldQuerySet = this.querySet;
            const oldSlots = this.readSlots;
            this.querySet = querySet;
            this.readSlots = slots;
            this.queriesPerFrame = target;

            try {
                oldQuerySet?.destroy();
            } catch {
                // Best-effort.
            }
            for (const slot of oldSlots) {
                try {
                    slot.resolve.destroy();
                } catch {
                    // Best-effort.
                }
                try {
                    slot.read.destroy();
                } catch {
                    // Best-effort.
                }
            }
        } catch {
            this.noteFailure();
        }
    }

    // ─── Recording ───

    /**
     * Emit one marker render pass for `label`, reserving a query pair. `register`
     * is false for the baseline marker so it never becomes a HUD row.
     */
    private markFrame(
        frame: FrameRecording,
        encoder: GPUCommandEncoder,
        label: string,
        register = true,
    ): void {
        if (this.state !== 'active' || this.currentFrame !== frame) return;
        if (frame.overflowed) return;

        const begin = frame.nextQueries;
        const end = begin + 1;
        frame.nextQueries += 2;
        if (begin + 2 > frame.capacity) {
            frame.overflowed = true;
            return;
        }

        const querySet = this.querySet;
        const view = this.markerView;
        if (!querySet || !view) return;

        try {
            const pass = encoder.beginRenderPass({
                colorAttachments: [
                    {
                        view,
                        clearValue: { r: 0, g: 0, b: 0, a: 0 },
                        loadOp: 'clear',
                        storeOp: 'discard',
                    },
                ],
                timestampWrites: {
                    querySet,
                    beginningOfPassWriteIndex: frame.base + begin,
                    endOfPassWriteIndex: frame.base + end,
                },
            });
            pass.end();
        } catch {
            frame.failed = true;
            this.noteFailure();
            return;
        }

        frame.marks.push({ label, begin, end });
        if (register) this.registerLabel(label);
    }

    private writesForFrame(frame: FrameRecording, label: string): TimestampWrites | undefined {
        if (this.state !== 'active' || this.currentFrame !== frame) return undefined;
        if (frame.overflowed) return undefined;

        const begin = frame.nextQueries;
        const end = begin + 1;
        frame.nextQueries += 2;
        if (begin + 2 > frame.capacity) {
            frame.overflowed = true;
            return undefined;
        }

        const querySet = this.querySet;
        if (!querySet) return undefined;

        frame.writes.push({ label, begin, end });
        this.registerLabel(label);
        return {
            querySet,
            beginningOfPassWriteIndex: frame.base + begin,
            endOfPassWriteIndex: frame.base + end,
        };
    }

    // ─── Readback ───

    private onMapped(frame: FrameRecording, buffer: GPUBuffer): void {
        if (this.state === 'destroyed') {
            this.releaseSlot(frame.slot);
            return;
        }

        let parsed = false;
        try {
            this.slots[frame.slot] = 'reading';
            const range = buffer.getMappedRange();
            this.consume(frame, new BigUint64Array(range));
            parsed = true;
        } catch {
            // Malformed/failed readback: fall through to the failure path below.
        } finally {
            try {
                buffer.unmap();
            } catch {
                // Best-effort: the device may already be lost/destroyed.
            }
            this.releaseSlot(frame.slot);
        }

        if (parsed) {
            this.consecutiveFailures = 0;
        } else {
            this.noteFailure();
        }
    }

    /**
     * Convert raw nanosecond timestamps into per-label millisecond samples.
     * Non-positive or non-finite deltas are discarded.
     */
    private consume(frame: FrameRecording, timestamps: BigUint64Array): void {
        if (frame.overflowed) return;

        const marks = frame.marks;
        for (let i = 1; i < marks.length; i++) {
            const previous = marks[i - 1];
            const current = marks[i];
            if (!previous || !current) continue;
            const delta = timestamps[current.begin] - timestamps[previous.end];
            const ms = Number(delta) / NS_PER_MS;
            if (isPositiveFinite(ms)) this.pushGpu(current.label, ms);
        }

        const firstWrite = frame.writes[0];
        for (const write of frame.writes) {
            const delta = timestamps[write.end] - timestamps[write.begin];
            const ms = Number(delta) / NS_PER_MS;
            if (isPositiveFinite(ms)) this.pushGpu(write.label, ms);
        }

        if (firstWrite && marks[0]) {
            const total = timestamps[firstWrite.end] - timestamps[marks[0].end];
            const ms = Number(total) / NS_PER_MS;
            if (isPositiveFinite(ms)) this.totalStats.push(ms);
        }

        this.framesSampled++;
    }

    // ─── Helpers ───

    private acquireSlot(): number {
        for (let i = 0; i < this.slots.length; i++) {
            if (this.slots[i] === 'free') return i;
        }
        return -1;
    }

    private releaseSlot(slot: number): void {
        const state = this.slots[slot];
        if (state === 'pending' || state === 'reading') {
            this.slots[slot] = 'free';
        }
    }

    private noteFailure(): void {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && this.state === 'active') {
            this.state = 'degraded';
        }
    }

    /** Await `buffer.mapAsync`, returning false on rejection or timeout. */
    private async awaitMap(buffer: GPUBuffer): Promise<boolean> {
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        try {
            return await Promise.race([
                buffer.mapAsync(GPUMapMode.READ).then(
                    () => true,
                    () => false,
                ),
                new Promise<boolean>((resolve) => {
                    timeoutId = setTimeout(() => resolve(false), VERIFY_TIMEOUT_MS);
                }),
            ]);
        } catch {
            return false;
        } finally {
            if (timeoutId !== null) clearTimeout(timeoutId);
        }
    }

    private statsFor(map: Map<string, RollingStats>, key: string): RollingStats {
        let stats = map.get(key);
        if (!stats) {
            stats = new RollingStats(this.windowSize);
            map.set(key, stats);
        }
        return stats;
    }

    private pushGpu(label: string, ms: number): void {
        this.statsFor(this.gpuStats, label).push(ms);
        this.lastGpu.set(label, ms);
        this.registerLabel(label);
    }

    private registerLabel(label: string): void {
        if (!this.labels.includes(label)) this.labels.push(label);
    }
}
