/**
 * Tests for {@link TexturePool}: reuse, in-flight tracking, LRU budget
 * eviction, dispose, and release-safety.
 *
 * Uses the shared WebGPU mock from `@/test/webgpu-mock` (which provides
 * `createTexture` textures with spy-able `destroy`) — it is not modified here.
 * Assertions observe allocation/reuse via the `createTexture` spy and eviction
 * via `destroy` calls (the pool exposes no statistics API).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installGPUMock, removeGPUMock } from '@/test/webgpu-mock';
import type { MockGPUObjects, MockGPUTexture } from '@/test/webgpu-mock';
import { TexturePool } from './texture-pool';
import type { TexturePoolDescriptor } from './texture-pool';

function makeDescriptor(
    overrides: Partial<TexturePoolDescriptor> = {},
): TexturePoolDescriptor {
    return {
        width: 10,
        height: 10,
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        ...overrides,
    };
}

function destroySpy(texture: GPUTexture): ReturnType<typeof vi.fn> {
    return (texture as unknown as MockGPUTexture).destroy;
}

/** The device's `createTexture` spy (used to observe allocations/reuse). */
function createTextureSpy(device: GPUDevice): ReturnType<typeof vi.fn> {
    return device.createTexture as unknown as ReturnType<typeof vi.fn>;
}

describe('TexturePool', () => {
    let mock: MockGPUObjects;
    let device: GPUDevice;

    beforeEach(() => {
        mock = installGPUMock();
        device = mock.device as unknown as GPUDevice;
    });

    afterEach(() => {
        removeGPUMock();
    });

    // ── Reuse / hit behavior ──

    it('returns the SAME texture after acquire → release → acquire without reallocating', () => {
        const pool = new TexturePool(device);
        const descriptor = makeDescriptor();
        const createTexture = createTextureSpy(device);

        const first = pool.acquire(descriptor);
        expect(createTexture).toHaveBeenCalledTimes(1);

        pool.release(first);

        const second = pool.acquire(descriptor);
        expect(second).toBe(first);
        // A reuse must not allocate a second texture.
        expect(createTexture).toHaveBeenCalledTimes(1);
    });

    it('treats label as part of the identity (label group)', () => {
        const pool = new TexturePool(device);
        const createTexture = createTextureSpy(device);

        const unlabelled = pool.acquire(makeDescriptor());
        const labelled = pool.acquire(makeDescriptor({ label: 'tier-input' }));

        expect(labelled).not.toBe(unlabelled);
        expect(createTexture).toHaveBeenCalledTimes(2);
    });

    // ── Distinct descriptors ──

    it('allocates distinct textures for size, format, usage and sampleCount differences', () => {
        const pool = new TexturePool(device);
        const createTexture = createTextureSpy(device);

        const base = pool.acquire(makeDescriptor());
        const bigger = pool.acquire(makeDescriptor({ width: 20 }));
        const otherFormat = pool.acquire(makeDescriptor({ format: 'bgra8unorm' }));
        const otherUsage = pool.acquire(
            makeDescriptor({ usage: GPUTextureUsage.TEXTURE_BINDING }),
        );
        const multisampled = pool.acquire(makeDescriptor({ sampleCount: 4 }));

        expect(new Set([base, bigger, otherFormat, otherUsage, multisampled]).size).toBe(5);
        expect(createTexture).toHaveBeenCalledTimes(5);
    });

    // ── In-flight safety ──

    it('never hands out a texture that is still checked out', () => {
        const pool = new TexturePool(device);
        const descriptor = makeDescriptor();
        const createTexture = createTextureSpy(device);

        const first = pool.acquire(descriptor);
        const second = pool.acquire(descriptor);

        expect(second).not.toBe(first);
        expect(createTexture).toHaveBeenCalledTimes(2);
    });

    // ── LRU eviction under budget ──

    it('evicts the least-recently-used free texture (not the newest) and preserves the budget', () => {
        const pool = new TexturePool(device, 900); // each 10×10 rgba8 = 400 bytes
        const x = pool.acquire(makeDescriptor({ label: 'x' }));
        const y = pool.acquire(makeDescriptor({ label: 'y' }));

        pool.release(x);
        pool.release(y);
        // 800 bytes is within the 900-byte budget → nothing evicted yet.
        expect(destroySpy(x)).not.toHaveBeenCalled();
        expect(destroySpy(y)).not.toHaveBeenCalled();

        // A third, distinct 400-byte texture pushes the total to 1200 (> budget)
        // while x and y remain free. Releasing it must evict the OLDEST free
        // texture (x), not the texture that was just released.
        const z = pool.acquire(makeDescriptor({ label: 'z' }));
        pool.release(z);

        expect(destroySpy(x)).toHaveBeenCalledTimes(1);
        expect(destroySpy(y)).not.toHaveBeenCalled();
        expect(destroySpy(z)).not.toHaveBeenCalled();
    });

    it('evicts free textures in LRU order until within budget', () => {
        const pool = new TexturePool(device, 500); // room for a single 400-byte texture
        const descriptor = makeDescriptor();

        const a = pool.acquire(descriptor);
        const b = pool.acquire(descriptor);
        const c = pool.acquire(descriptor);
        pool.release(a);
        pool.release(b);
        pool.release(c);

        expect(destroySpy(a)).toHaveBeenCalledTimes(1);
        expect(destroySpy(b)).toHaveBeenCalledTimes(1);
        expect(destroySpy(c)).not.toHaveBeenCalled();
    });

    // ── dispose ──

    it('dispose destroys all free textures', () => {
        const pool = new TexturePool(device);
        const descriptor = makeDescriptor();

        const a = pool.acquire(descriptor);
        const b = pool.acquire(descriptor);
        pool.release(a);
        pool.release(b);

        pool.dispose();

        expect(destroySpy(a)).toHaveBeenCalledTimes(1);
        expect(destroySpy(b)).toHaveBeenCalledTimes(1);
    });

    it('dispose leaves checked-out textures untouched and forgets them', () => {
        const pool = new TexturePool(device);
        const texture = pool.acquire(makeDescriptor());

        pool.dispose();

        expect(destroySpy(texture)).not.toHaveBeenCalled();

        // A release after dispose is a safe no-op (ownership was forgotten).
        expect(() => pool.release(texture)).not.toThrow();
        expect(destroySpy(texture)).not.toHaveBeenCalled();
    });

    // ── release safety ──

    it('treats double-release and foreign-release as no-ops', () => {
        const pool = new TexturePool(device);
        const descriptor = makeDescriptor();

        const owned = pool.acquire(descriptor);
        const foreign = device.createTexture({
            size: [1, 1],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING,
        });

        expect(() => pool.release(foreign)).not.toThrow();

        pool.release(owned);
        // The released texture is immediately reusable.
        expect(pool.acquire(descriptor)).toBe(owned);
        pool.release(owned);

        expect(() => pool.release(owned)).not.toThrow();

        expect(destroySpy(owned)).not.toHaveBeenCalled();
        expect(destroySpy(foreign)).not.toHaveBeenCalled();
    });
});
