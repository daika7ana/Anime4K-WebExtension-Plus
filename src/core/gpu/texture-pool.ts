/**
 * Per-device GPU texture pool with a fixed byte budget and LRU eviction.
 *
 * Long-lived renderer/effect output textures are allocated once at
 * pipeline-build time and are intentionally NOT pooled here. This pool targets
 * short-lived, repeatedly created/destroyed textures — currently the benchmark's
 * per-tier input textures — so consecutive consumers can recycle the same
 * `GPUTexture` instead of paying the allocation/destruction cost on every
 * iteration. (The pre-warmer creates and destroys its own dummy texture; it is
 * not pooled.)
 *
 * ## Identity
 * Textures are pooled by an identity key derived from `width`, `height`,
 * `format`, `usage`, `sampleCount`, `mipLevelCount` and `label`. The `label`
 * acts as the "label group": changing it yields a distinct pool entry even when
 * every GPU-relevant field matches.
 *
 * ## Byte accounting
 * `bytes = bytesPerPixel(format) * width * height * sampleCount`.
 * `mipLevelCount` participates in the identity key but is not counted in the
 * byte estimate (all current call sites use the default of 1). See
 * {@link BYTES_PER_PIXEL} for the supported format mapping; unrecognized
 * formats are estimated at 4 bytes/pixel.
 *
 * ## In-flight safety
 * A texture that is checked out is never handed out again until it is released.
 * If the budget is exceeded only by checked-out textures the pool cannot evict
 * them, so `bytes` may temporarily exceed `budgetBytes`; this is intentional.
 *
 * ## release() semantics
 * `release()` is safe for foreign (never-allocated) or already-released
 * textures: those calls are silent no-ops. This keeps benchmark/teardown error
 * paths simple and idempotent. A double-release can never destroy a texture
 * twice because ownership is tracked in the `checkedOut` map.
 *
 * ## Device loss
 * Destroying the device invalidates every pooled texture. Callers MUST call
 * `dispose()` when the device is lost or torn down, then discard the pool.
 */

/** Descriptor accepted by {@link TexturePool.acquire}. */
export interface TexturePoolDescriptor {
    width: number;
    height: number;
    format: GPUTextureFormat;
    usage: GPUTextureUsageFlags;
    /** Debug label. Also participates in the pool identity ("label group"). */
    label?: string;
    /** MSAA sample count. Defaults to 1. Multiplies the byte estimate. */
    sampleCount?: number;
    /** Mip level count. Defaults to 1. Part of the identity key. */
    mipLevelCount?: number;
}

/** Default pool budget: 256 MiB. */
const DEFAULT_BUDGET_BYTES = 256 * 1024 * 1024;

/**
 * Bytes-per-pixel estimate per texture format. Only these formats have an
 * exact value; any other format is estimated at {@link DEFAULT_BYTES_PER_PIXEL}.
 */
const BYTES_PER_PIXEL: Readonly<Record<string, number>> = {
    r8unorm: 1,
    r8snorm: 1,
    r8uint: 1,
    r8sint: 1,
    rg8unorm: 2,
    rg8snorm: 2,
    rg8uint: 2,
    rg8sint: 2,
    rgba8unorm: 4,
    'rgba8unorm-srgb': 4,
    bgra8unorm: 4,
    'bgra8unorm-srgb': 4,
    rgb10a2unorm: 4,
    rg11b10ufloat: 4,
    r16float: 2,
    r16uint: 2,
    r16sint: 2,
    rg16float: 4,
    rg16uint: 4,
    rg16sint: 4,
    rgba16float: 8,
    rgba16uint: 8,
    rgba16sint: 8,
    r32float: 4,
    r32uint: 4,
    r32sint: 4,
    rg32float: 8,
    rg32uint: 8,
    rg32sint: 8,
    rgba32float: 16,
    rgba32uint: 16,
    rgba32sint: 16,
    depth16unorm: 2,
    depth24plus: 4,
    'depth24plus-stencil8': 4,
    depth32float: 4,
    'depth32float-stencil8': 8,
};

/** Fallback bytes/pixel for formats not listed in {@link BYTES_PER_PIXEL}. */
const DEFAULT_BYTES_PER_PIXEL = 4;

interface PoolEntry {
    key: string;
    bytes: number;
}

/**
 * Estimate the VRAM footprint of a texture in bytes. Sample count multiplies
 * the base size; mip levels are intentionally not counted (see module docs).
 */
function estimateBytes(descriptor: TexturePoolDescriptor): number {
    const bytesPerPixel =
        BYTES_PER_PIXEL[descriptor.format] ?? DEFAULT_BYTES_PER_PIXEL;
    const sampleCount = descriptor.sampleCount ?? 1;
    return bytesPerPixel * descriptor.width * descriptor.height * sampleCount;
}

/** Build the identity key used to match free textures to acquire requests. */
function buildKey(descriptor: TexturePoolDescriptor): string {
    const sampleCount = descriptor.sampleCount ?? 1;
    const mipLevelCount = descriptor.mipLevelCount ?? 1;
    return [
        `${descriptor.width}x${descriptor.height}`,
        descriptor.format,
        `${descriptor.usage >>> 0}`,
        `s${sampleCount}`,
        `m${mipLevelCount}`,
        descriptor.label ?? '',
    ].join('|');
}

/**
 * Recycles `GPUTexture` instances per device within a fixed byte budget.
 *
 * @example
 * ```ts
 * const pool = new TexturePool(device);
 * const tex = pool.acquire({ width: 1920, height: 1080, format: 'rgba8unorm', usage });
 * // ... use tex ...
 * pool.release(tex);
 * // On device teardown:
 * pool.dispose();
 * ```
 */
export class TexturePool {
    private readonly device: GPUDevice;
    private readonly budgetBytes: number;

    /** Free textures grouped by identity key; each list is used LIFO. */
    private readonly freeByKey = new Map<string, GPUTexture[]>();
    /** Free textures in LRU order (Map insertion order, oldest first). */
    private readonly freeEntries = new Map<GPUTexture, PoolEntry>();
    /** Textures currently checked out, with the accounting metadata to restore on release. */
    private readonly checkedOut = new Map<GPUTexture, PoolEntry>();

    /** Total bytes held by the pool (free + checked out). */
    private bytes = 0;

    constructor(device: GPUDevice, budgetBytes: number = DEFAULT_BUDGET_BYTES) {
        this.device = device;
        this.budgetBytes = budgetBytes;
    }

    /**
     * Acquire a texture matching `descriptor`.
     *
     * Returns a free pooled texture with an identical identity key when one is
     * available (a "hit"); otherwise allocates a new texture (a "miss"). The
     * returned texture is marked checked out and will not be handed out again
     * until {@link release} is called.
     */
    acquire(descriptor: TexturePoolDescriptor): GPUTexture {
        const key = buildKey(descriptor);
        const list = this.freeByKey.get(key);

        if (list && list.length > 0) {
            const texture = list.pop();
            if (texture) {
                if (list.length === 0) this.freeByKey.delete(key);
                this.freeEntries.delete(texture);
                this.checkedOut.set(texture, {
                    key,
                    bytes: estimateBytes(descriptor),
                });
                return texture;
            }
        }

        const texture = this.createTexture(descriptor);
        this.checkedOut.set(texture, {
            key,
            bytes: estimateBytes(descriptor),
        });
        this.bytes += estimateBytes(descriptor);
        return texture;
    }

    /**
     * Return a checked-out texture to the free pool.
     *
     * Releasing a foreign (never-acquired) texture or a texture that has
     * already been released is a safe no-op — no error is thrown. After a
     * successful release the pool evicts least-recently-used free textures
     * (calling `.destroy()`) until `bytes <= budgetBytes`.
     */
    release(texture: GPUTexture): void {
        const entry = this.checkedOut.get(texture);
        if (!entry) return; // foreign or already-released texture: no-op

        this.checkedOut.delete(texture);
        this.addFree(texture, entry);
        this.evictIfNeeded();
    }

    /**
     * Destroy every free pooled texture and reset all state.
     * Checked-out textures are left untouched (callers still own them) but are
     * forgotten, so any later `release()` for them becomes a no-op. The pool is
     * reusable after `dispose()`.
     */
    dispose(): void {
        for (const texture of [...this.freeEntries.keys()]) {
            this.destroyFree(texture);
        }
        this.freeByKey.clear();
        this.freeEntries.clear();
        this.checkedOut.clear();
        this.bytes = 0;
    }

    private createTexture(descriptor: TexturePoolDescriptor): GPUTexture {
        const gpuDescriptor: GPUTextureDescriptor = {
            size: [descriptor.width, descriptor.height],
            format: descriptor.format,
            usage: descriptor.usage,
        };
        if (descriptor.sampleCount !== undefined) {
            gpuDescriptor.sampleCount = descriptor.sampleCount;
        }
        if (descriptor.mipLevelCount !== undefined) {
            gpuDescriptor.mipLevelCount = descriptor.mipLevelCount;
        }
        if (descriptor.label !== undefined) {
            gpuDescriptor.label = descriptor.label;
        }
        return this.device.createTexture(gpuDescriptor);
    }

    private addFree(texture: GPUTexture, entry: PoolEntry): void {
        const list = this.freeByKey.get(entry.key);
        if (list) {
            list.push(texture);
        } else {
            this.freeByKey.set(entry.key, [texture]);
        }
        // delete + set moves the entry to the end of the Map iteration order
        // so it is treated as most-recently-used.
        this.freeEntries.delete(texture);
        this.freeEntries.set(texture, entry);
    }

    private evictIfNeeded(): void {
        while (this.bytes > this.budgetBytes) {
            const oldest = this.freeEntries.keys().next();
            if (oldest.done) return; // nothing free to evict (all checked out)
            this.destroyFree(oldest.value);
        }
    }

    private destroyFree(texture: GPUTexture): void {
        const entry = this.freeEntries.get(texture);
        if (!entry) return;

        this.freeEntries.delete(texture);

        const list = this.freeByKey.get(entry.key);
        if (list) {
            const idx = list.indexOf(texture);
            if (idx !== -1) list.splice(idx, 1);
            if (list.length === 0) this.freeByKey.delete(entry.key);
        }

        this.bytes -= entry.bytes;

        try {
            texture.destroy();
        } catch {
            // Best-effort: the device may already be lost/destroyed.
        }
    }
}
