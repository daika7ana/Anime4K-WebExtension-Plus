/**
 * Tests for {@link GpuTimestampProfiler}.
 *
 * The profiler is exercised against a LOCAL fake device/encoder defined below
 * (the shared `@/test/webgpu-mock` is intentionally not used or modified). The
 * fake provides a controllable `mapAsync` promise and a `getMappedRange` that
 * exposes a writable `BigUint64Array` so nanosecond timestamps can be injected
 * deterministically.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GpuTimestampProfiler, isPositiveFinite } from './gpu-timestamp-profiler';

// ─── Local fake WebGPU objects ───

class FakeBuffer {
    readonly descriptor: GPUBufferDescriptor;
    readonly usage: number;
    readonly data: BigUint64Array;
    private resolveMap: (() => void) | null = null;
    private rejectMap: ((error: unknown) => void) | null = null;

    readonly mapAsync = vi.fn(
        (_mode: number) =>
            new Promise<void>((resolve, reject) => {
                this.resolveMap = resolve;
                this.rejectMap = reject;
            }),
    );
    readonly getMappedRange = vi.fn(() => this.data.buffer as ArrayBuffer);
    readonly unmap = vi.fn();
    readonly destroy = vi.fn();

    constructor(descriptor: GPUBufferDescriptor) {
        this.descriptor = descriptor;
        this.usage = Number(descriptor.usage);
        this.data = new BigUint64Array(Number(descriptor.size) / 8);
    }

    settleMap(): void {
        this.resolveMap?.();
        this.resolveMap = null;
    }

    rejectMapWith(error: unknown): void {
        this.rejectMap?.(error);
        this.rejectMap = null;
    }
}

class FakeTexture {
    readonly createView = vi.fn(() => ({ __markerView: true }));
    readonly destroy = vi.fn();
}

class FakeQuerySet {
    readonly destroy = vi.fn();

    constructor(readonly descriptor: GPUQuerySetDescriptor) {}
}

class FakeDevice {
    readonly features: Set<string>;
    readonly querySets: FakeQuerySet[] = [];
    readonly buffers: FakeBuffer[] = [];
    readonly textures: FakeTexture[] = [];
    readonly queue = { submit: vi.fn() };
    readonly pushErrorScope = vi.fn();
    readonly popErrorScope = vi.fn(async () => null as unknown);

    createQuerySet = vi.fn((descriptor: GPUQuerySetDescriptor) => {
        const querySet = new FakeQuerySet(descriptor);
        this.querySets.push(querySet);
        return querySet;
    });

    createTexture = vi.fn((_descriptor: GPUTextureDescriptor) => {
        const texture = new FakeTexture();
        this.textures.push(texture);
        return texture;
    });

    createBuffer = vi.fn((descriptor: GPUBufferDescriptor) => {
        const buffer = new FakeBuffer(descriptor);
        this.buffers.push(buffer);
        return buffer;
    });

    createCommandEncoder = vi.fn(() => new FakeEncoder());

    constructor(withFeature = true) {
        this.features = new Set(withFeature ? ['timestamp-query'] : []);
    }

    asDevice(): GPUDevice {
        return this as unknown as GPUDevice;
    }
}

class FakeEncoder {
    readonly passes: GPURenderPassDescriptor[] = [];
    readonly resolves: unknown[][] = [];
    readonly copies: unknown[][] = [];

    beginRenderPass = vi.fn((descriptor: GPURenderPassDescriptor) => {
        this.passes.push(descriptor);
        return { end: vi.fn() } as unknown as GPURenderPassEncoder;
    });

    resolveQuerySet = vi.fn((...args: unknown[]) => {
        this.resolves.push(args);
    });

    copyBufferToBuffer = vi.fn((...args: unknown[]) => {
        this.copies.push(args);
    });

    finish = vi.fn(() => ({ label: 'command-buffer' }));

    asEncoder(): GPUCommandEncoder {
        return this as unknown as GPUCommandEncoder;
    }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function createProfiler(device: FakeDevice, opts?: Parameters<typeof GpuTimestampProfiler.create>[1]) {
    const profiler = GpuTimestampProfiler.create(device.asDevice(), opts);
    if (!profiler) throw new Error('expected profiler to be created');
    return profiler;
}

/** The MAP_READ staging buffer for `slot` (resolve is created first, read second). */
function readBuffer(device: FakeDevice, slot = 0): FakeBuffer {
    return device.buffers[slot * 2 + 1];
}

describe('GpuTimestampProfiler', () => {
    beforeEach(() => {
        vi.stubGlobal('GPUBufferUsage', { MAP_READ: 1, COPY_DST: 2, COPY_SRC: 4, QUERY_RESOLVE: 512 });
        vi.stubGlobal('GPUTextureUsage', { RENDER_ATTACHMENT: 16 });
        vi.stubGlobal('GPUMapMode', { READ: 1 });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    // ── Unsupported devices ──

    it('returns null when the timestamp-query feature is absent', () => {
        const device = new FakeDevice(false);
        expect(GpuTimestampProfiler.create(device.asDevice())).toBeNull();
    });

    it('returns null when createQuerySet is unavailable', () => {
        const device = new FakeDevice();
        delete (device as unknown as Record<string, unknown>)['createQuerySet'];
        expect(GpuTimestampProfiler.create(device.asDevice())).toBeNull();
    });

    it('returns an unsupported instance when createQuerySet throws', () => {
        const device = new FakeDevice();
        device.createQuerySet = vi.fn(() => {
            throw new Error('boom');
        });

        const profiler = GpuTimestampProfiler.create(device.asDevice());
        expect(profiler).not.toBeNull();
        expect(profiler?.status).toBe('unsupported');
        expect(profiler?.beginFrame(new FakeEncoder().asEncoder())).toBeNull();
        expect(() => profiler?.destroy()).not.toThrow();
    });

    // ── Buffer usage / two-buffer readback ──

    it('separates resolve and MAP_READ staging buffers with valid usages', () => {
        const device = new FakeDevice();
        createProfiler(device, { ringSize: 2 });

        expect(device.buffers).toHaveLength(4);
        const resolve0 = device.buffers[0];
        const read0 = device.buffers[1];
        expect(resolve0.usage).toBe(GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC);
        expect(read0.usage).toBe(GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);

        // No buffer may combine MAP_READ with a forbidden flag.
        for (const buffer of device.buffers) {
            const hasMapRead = (buffer.usage & GPUBufferUsage.MAP_READ) !== 0;
            const forbidden = buffer.usage & ~(GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
            expect(hasMapRead && forbidden !== 0).toBe(false);
        }

        expect(resolve0.usage & GPUBufferUsage.MAP_READ).toBe(0);
        expect(read0.usage & GPUBufferUsage.QUERY_RESOLVE).toBe(0);
    });

    it('resolves into the resolve buffer and copies into the MAP_READ buffer', () => {
        const device = new FakeDevice();
        const profiler = createProfiler(device, { ringSize: 1 });
        const encoder = new FakeEncoder();

        const recorder = profiler.beginFrame(encoder.asEncoder())!;
        recorder.mark('effect-0');
        recorder.writesFor('blit');
        profiler.endFrame(encoder.asEncoder());

        const resolve = device.buffers[0];
        const read = device.buffers[1];
        expect(encoder.resolves).toHaveLength(1);
        expect(encoder.resolves[0][3]).toBe(resolve);
        expect(encoder.resolves[0][2]).toBe(6); // baseline + effect-0 + blit

        expect(encoder.copies).toHaveLength(1);
        expect(encoder.copies[0][0]).toBe(resolve);
        expect(encoder.copies[0][2]).toBe(read);
        expect(encoder.copies[0][4]).toBe(8 * 6);
    });

    // ── Happy path ──

    it('converts nanoseconds to milliseconds and attributes per-pass time', () => {
        const device = new FakeDevice();
        const profiler = createProfiler(device, { ringSize: 1 });
        const encoder = new FakeEncoder();

        const recorder = profiler.beginFrame(encoder.asEncoder())!;
        recorder.mark('effect-0');
        const blitWrites = recorder.writesFor('blit');
        expect(blitWrites).toBeDefined();

        profiler.endFrame(encoder.asEncoder());
        profiler.afterSubmit();

        // Layout: baseline (0,1), effect-0 (2,3), blit (4,5).
        const buffer = readBuffer(device);
        buffer.data[0] = 1_000_000n;
        buffer.data[1] = 2_000_000n;
        buffer.data[2] = 5_000_000n;
        buffer.data[3] = 6_000_000n;
        buffer.data[4] = 7_000_000n;
        buffer.data[5] = 9_000_000n;
        buffer.settleMap();
        return flush().then(() => {
            const snapshot = profiler.snapshot();

            expect(snapshot.status).toBe('active');
            expect(snapshot.framesSampled).toBe(1);
            expect(snapshot.totalGpuP50).toBeCloseTo(7, 5);
            expect(snapshot.passes.map((pass) => pass.label)).toEqual(['effect-0', 'blit']);

            const effect = snapshot.passes.find((pass) => pass.label === 'effect-0')!;
            // 5_000_000 - 2_000_000 = 3_000_000 ns = 3 ms
            expect(effect.gpuP50).toBeCloseTo(3, 5);
            expect(effect.gpuLast).toBeCloseTo(3, 5);

            const blit = snapshot.passes.find((pass) => pass.label === 'blit')!;
            // 9_000_000 - 7_000_000 = 2_000_000 ns = 2 ms
            expect(blit.gpuP50).toBeCloseTo(2, 5);
        });
    });

    it('emits a baseline marker so the first pipeline is sampled and totalGpu spans it', () => {
        const device = new FakeDevice();
        const profiler = createProfiler(device, { ringSize: 1 });
        const encoder = new FakeEncoder();

        const recorder = profiler.beginFrame(encoder.asEncoder())!;
        recorder.mark('first-effect');

        // The baseline is pass 0, emitted by beginFrame before any user mark.
        expect(encoder.passes).toHaveLength(2);
        expect(encoder.passes[0].timestampWrites?.beginningOfPassWriteIndex).toBe(0);
        expect(encoder.passes[0].timestampWrites?.endOfPassWriteIndex).toBe(1);
        expect(encoder.passes[1].timestampWrites?.beginningOfPassWriteIndex).toBe(2);

        recorder.writesFor('blit');
        profiler.endFrame(encoder.asEncoder());
        profiler.afterSubmit();

        const buffer = readBuffer(device);
        buffer.data[1] = 1_000_000n; // baseline end
        buffer.data[2] = 4_000_000n; // first-effect begin
        buffer.data[3] = 5_000_000n;
        buffer.data[4] = 5_000_000n; // blit begin
        buffer.data[5] = 8_000_000n; // blit end
        buffer.settleMap();

        return flush().then(() => {
            const snapshot = profiler.snapshot();
            const first = snapshot.passes.find((pass) => pass.label === 'first-effect')!;
            expect(first.gpuP50).toBeCloseTo(3, 5);
            // The reserved baseline label must never surface as a HUD row.
            expect(snapshot.passes.some((pass) => pass.label.includes('baseline'))).toBe(false);
            // Total spans baseline end -> blit end.
            expect(snapshot.totalGpuP50).toBeCloseTo(7, 5);
        });
    });

    it('emits one marker render pass per mark with discard/clear state', () => {
        const device = new FakeDevice();
        const profiler = createProfiler(device, { ringSize: 1 });
        const encoder = new FakeEncoder();

        const recorder = profiler.beginFrame(encoder.asEncoder())!;
        recorder.mark('start');
        recorder.mark('effect-0');

        expect(encoder.passes).toHaveLength(3);
        const attachment = encoder.passes[0].colorAttachments;
        expect(attachment).toBeDefined();
        const first = Array.from(attachment as GPURenderPassColorAttachment[])[0];
        expect(first.loadOp).toBe('clear');
        expect(first.storeOp).toBe('discard');
        expect(first.clearValue).toEqual({ r: 0, g: 0, b: 0, a: 0 });
        expect(encoder.passes[0].timestampWrites?.beginningOfPassWriteIndex).toBe(0);
        expect(encoder.passes[0].timestampWrites?.endOfPassWriteIndex).toBe(1);
        expect(encoder.passes[1].timestampWrites?.beginningOfPassWriteIndex).toBe(2);
    });

    it('sizes the query set for the ring and default pipeline budget', () => {
        const device = new FakeDevice();
        createProfiler(device, { ringSize: 2 });
        // 2 * (12 + 1) + 2 = 28 queries per frame; two buffers per slot.
        expect(device.querySets[0].descriptor.count).toBe(2 * 28);
        expect(device.buffers).toHaveLength(4);
        expect(Number(readBuffer(device, 0).data.length)).toBe(28);
        expect(Number(device.buffers[0].data.length)).toBe(28);
    });

    // ── Slot state machine / abandonment ──

    it('returns null for a frame while the only ring slot is busy', () => {
        const device = new FakeDevice();
        const profiler = createProfiler(device, { ringSize: 1 });
        const encoder = new FakeEncoder();

        const first = profiler.beginFrame(encoder.asEncoder())!;
        expect(first).not.toBeNull();
        profiler.endFrame(encoder.asEncoder());
        profiler.afterSubmit();

        expect(profiler.beginFrame(encoder.asEncoder())).toBeNull();

        readBuffer(device).settleMap();
        return flush().then(() => {
            expect(profiler.beginFrame(encoder.asEncoder())).not.toBeNull();
        });
    });

    it('abortFrame() releases the claimed slot without resolving', () => {
        const device = new FakeDevice();
        const profiler = createProfiler(device, { ringSize: 1 });
        const encoder = new FakeEncoder();

        const first = profiler.beginFrame(encoder.asEncoder());
        expect(first).not.toBeNull();
        profiler.abortFrame();

        // The only slot is immediately reusable and nothing was resolved.
        const second = profiler.beginFrame(encoder.asEncoder());
        expect(second).not.toBeNull();
        expect(encoder.resolves).toHaveLength(0);
    });

    it('beginFrame() reclaims a slot abandoned by a frame that was never ended', () => {
        const device = new FakeDevice();
        const profiler = createProfiler(device, { ringSize: 1 });
        const encoder = new FakeEncoder();

        const abandoned = profiler.beginFrame(encoder.asEncoder())!;
        const replacement = profiler.beginFrame(encoder.asEncoder());
        expect(replacement).not.toBeNull();

        // The abandoned recorder can no longer record into the new frame.
        const passesBefore = encoder.passes.length;
        abandoned.mark('late');
        expect(encoder.passes).toHaveLength(passesBefore);
    });

    // ── Degradation ──

    it('degrades after three consecutive mapAsync failures and stops marking', async () => {
        const device = new FakeDevice();
        const profiler = createProfiler(device, { ringSize: 1 });
        const encoder = new FakeEncoder();

        for (let i = 0; i < 3; i++) {
            const recorder = profiler.beginFrame(encoder.asEncoder())!;
            recorder.mark('start');
            recorder.mark('effect');
            profiler.endFrame(encoder.asEncoder());
            profiler.afterSubmit();
            readBuffer(device).rejectMapWith(new Error('map failed'));
            await flush();
        }

        expect(profiler.status).toBe('degraded');
        expect(profiler.beginFrame(encoder.asEncoder())).toBeNull();
        expect(profiler.snapshot().framesSampled).toBe(0);
    });

    // ── Delta guards ──

    it('discards non-positive deltas (timestamp reset) and keeps positive ones', () => {
        const device = new FakeDevice();
        const profiler = createProfiler(device, { ringSize: 1 });
        const encoder = new FakeEncoder();

        const recorder = profiler.beginFrame(encoder.asEncoder())!;
        recorder.mark('zero');
        recorder.mark('negative');
        recorder.mark('positive');
        recorder.writesFor('blit');
        profiler.endFrame(encoder.asEncoder());
        profiler.afterSubmit();

        // Layout: baseline(0,1) zero(2,3) negative(4,5) positive(6,7) blit(8,9).
        const buffer = readBuffer(device);
        buffer.data[1] = 5_000_000n;   // baseline end
        buffer.data[2] = 5_000_000n;   // zero delta
        buffer.data[3] = 8_000_000n;
        buffer.data[4] = 6_000_000n;   // negative delta
        buffer.data[5] = 9_000_000n;
        buffer.data[6] = 12_000_000n;  // positive delta (3 ms)
        buffer.data[7] = 12_000_000n;
        buffer.data[8] = 12_000_000n;
        buffer.data[9] = 14_000_000n;  // blit 2 ms
        buffer.settleMap();

        return flush().then(() => {
            const snapshot = profiler.snapshot();
            expect(snapshot.passes.map((pass) => pass.label)).toEqual(['positive', 'blit']);
            expect(snapshot.passes[0].gpuP50).toBeCloseTo(3, 5);
            // total = blit end (9) - baseline end (1) = 9 ms
            expect(snapshot.totalGpuP50).toBeCloseTo(9, 5);
        });
    });

    it('isPositiveFinite() rejects zero, negative, and non-finite values', () => {
        expect(isPositiveFinite(1)).toBe(true);
        expect(isPositiveFinite(0)).toBe(false);
        expect(isPositiveFinite(-1)).toBe(false);
        expect(isPositiveFinite(Infinity)).toBe(false);
        expect(isPositiveFinite(-Infinity)).toBe(false);
        expect(isPositiveFinite(Number.NaN)).toBe(false);
    });

    // ── Verification self-test ──

    it('verify() succeeds when the probe maps cleanly', async () => {
        const device = new FakeDevice();
        const profiler = createProfiler(device, { ringSize: 1 });
        readBuffer(device).mapAsync.mockResolvedValue(undefined);

        await expect(profiler.verify()).resolves.toBe(true);
        expect(profiler.status).toBe('active');
        expect(device.queue.submit).toHaveBeenCalledTimes(1);
    });

    it('verify() fails and destroys the profiler when mapAsync rejects', async () => {
        const device = new FakeDevice();
        const profiler = createProfiler(device, { ringSize: 1 });
        readBuffer(device).mapAsync.mockRejectedValue(new Error('map failed'));

        await expect(profiler.verify()).resolves.toBe(false);
        expect(profiler.status).toBe('destroyed');
    });

    it('verify() fails and destroys the profiler when the validation scope is dirty', async () => {
        const device = new FakeDevice();
        device.popErrorScope.mockResolvedValue({ message: 'invalid resource' });
        const profiler = createProfiler(device, { ringSize: 1 });
        readBuffer(device).mapAsync.mockResolvedValue(undefined);

        await expect(profiler.verify()).resolves.toBe(false);
        expect(profiler.status).toBe('destroyed');
    });

    // ── Sizing / growth ──

    it('grows the query set lazily to the largest frame seen so far', () => {
        const device = new FakeDevice();
        const profiler = createProfiler(device, { ringSize: 1 });
        const encoder = new FakeEncoder();

        // First frame overflows the default 28-query budget (14 marks + baseline + blit = 32).
        const recorder = profiler.beginFrame(encoder.asEncoder())!;
        for (let i = 0; i < 14; i++) recorder.mark(`effect-${i}`);
        recorder.writesFor('blit');
        profiler.endFrame(encoder.asEncoder());
        profiler.afterSubmit();

        // Next frame's beginFrame sees the larger requirement and grows.
        profiler.beginFrame(encoder.asEncoder());
        expect(device.querySets).toHaveLength(2);
        expect(device.querySets[1].descriptor.count).toBe(30);
    });

    // ── sampleEvery ──

    it('sampleEvery skips all but every nth frame', () => {
        const device = new FakeDevice();
        const profiler = createProfiler(device, { ringSize: 3, sampleEvery: 2 });
        const encoder = new FakeEncoder();

        const emitted = profiler.beginFrame(encoder.asEncoder())!;
        expect(emitted).not.toBeNull();
        profiler.endFrame(encoder.asEncoder());
        profiler.afterSubmit();

        expect(profiler.beginFrame(encoder.asEncoder())).toBeNull();
        expect(profiler.beginFrame(encoder.asEncoder())).not.toBeNull();
    });

    // ── CPU timings ──

    it('recordCpu works without a recorder and surfaces in the snapshot', () => {
        const device = new FakeDevice();
        const profiler = createProfiler(device, { ringSize: 1 });

        profiler.recordCpu('cpu-effect', 4);
        profiler.recordCpu('cpu-effect', 6);

        const snapshot = profiler.snapshot();
        expect(snapshot.passes.map((pass) => pass.label)).toEqual(['cpu-effect']);
        expect(snapshot.passes[0].cpuP50).toBeCloseTo(5, 5);
        expect(snapshot.passes[0].gpuP50).toBeUndefined();
    });

    // ── reset ──

    it('reset() clears accumulated labels and stats', async () => {
        const device = new FakeDevice();
        const profiler = createProfiler(device, { ringSize: 1 });
        const encoder = new FakeEncoder();

        const recorder = profiler.beginFrame(encoder.asEncoder())!;
        recorder.mark('effect-0');
        recorder.writesFor('blit');
        profiler.endFrame(encoder.asEncoder());
        profiler.afterSubmit();

        const buffer = readBuffer(device);
        buffer.data[1] = 1_000_000n;
        buffer.data[2] = 4_000_000n;
        buffer.settleMap();
        await flush();

        expect(profiler.snapshot().passes.length).toBeGreaterThan(0);

        profiler.reset();
        const snapshot = profiler.snapshot();
        expect(snapshot.status).toBe('active');
        expect(snapshot.framesSampled).toBe(0);
        expect(snapshot.totalGpuP50).toBeNull();
        expect(snapshot.totalGpuP95).toBeNull();
        expect(snapshot.passes).toEqual([]);
    });

    it('reset() reclaims an in-flight slot so profiling does not stall', () => {
        const device = new FakeDevice();
        const profiler = createProfiler(device, { ringSize: 1 });
        const encoder = new FakeEncoder();

        // Claim the only ring slot and deliberately never end the frame.
        const first = profiler.beginFrame(encoder.asEncoder());
        expect(first).not.toBeNull();

        profiler.reset();

        // The slot must have been reclaimed: a later beginFrame() still gets a
        // slot instead of permanently returning null because one stayed
        // 'pending' forever.
        const second = profiler.beginFrame(encoder.asEncoder());
        expect(second).not.toBeNull();
        expect(second).not.toBe(first);
    });

    it('reset() re-arms a degraded profiler', async () => {
        const device = new FakeDevice();
        const profiler = createProfiler(device, { ringSize: 1 });
        const encoder = new FakeEncoder();

        for (let i = 0; i < 3; i++) {
            const recorder = profiler.beginFrame(encoder.asEncoder())!;
            recorder.mark('start');
            recorder.mark('effect');
            profiler.endFrame(encoder.asEncoder());
            profiler.afterSubmit();
            readBuffer(device).rejectMapWith(new Error('map failed'));
            await flush();
        }
        expect(profiler.status).toBe('degraded');

        profiler.reset();
        expect(profiler.status).toBe('active');
        expect(profiler.beginFrame(encoder.asEncoder())).not.toBeNull();
    });

    // ── destroy ──

    it('destroy() is idempotent and releases both buffers per slot once', () => {
        const device = new FakeDevice();
        const profiler = createProfiler(device, { ringSize: 1 });

        profiler.destroy();
        expect(() => profiler.destroy()).not.toThrow();

        expect(profiler.status).toBe('destroyed');
        expect(device.querySets[0].destroy).toHaveBeenCalledTimes(1);
        expect(device.buffers[0].destroy).toHaveBeenCalledTimes(1);
        expect(device.buffers[1].destroy).toHaveBeenCalledTimes(1);
        expect(device.textures[0].destroy).toHaveBeenCalledTimes(1);
        expect(profiler.beginFrame(new FakeEncoder().asEncoder())).toBeNull();
    });

    it('stale recorder methods never throw after destroy', () => {
        const device = new FakeDevice();
        const profiler = createProfiler(device, { ringSize: 1 });
        const encoder = new FakeEncoder();

        const recorder = profiler.beginFrame(encoder.asEncoder())!;
        profiler.destroy();

        expect(() => recorder.mark('late')).not.toThrow();
        expect(recorder.writesFor('blit')).toBeUndefined();
        expect(() => recorder.recordCpu('late-cpu', 1)).not.toThrow();
        expect(profiler.beginFrame(encoder.asEncoder())).toBeNull();
    });
});
