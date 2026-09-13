/**
 * Gated restore — compile-time wrapper for the restore-policy `gate` mode.
 *
 * Keeps the inner restore pipeline in the chain at full strength but gates its
 * residual by the local 3x3 encoded-domain Rec.709 luma amplitude:
 *
 *   out = mix(input, restoreOut, m)
 *   m   = smoothstep(gateLow, gateHigh, max9 - min9) * clamp(gateStrength, 0, 1)
 *
 * The wrapper is intentionally a thin, self-contained node: it owns only its
 * output texture and uniform buffer, delegates the actual restore dispatch to
 * the inner pipeline, and never forwards `updateParam` to it (library restores
 * expose no tunable params; forwarding would silently kill the effect).
 *
 * This module must not statically import `anime4k-webgpu-async` (seam purity):
 * `DestroyablePipeline` is a type-only import and the shader is a raw asset.
 */
import RESTORE_GATE_SHADER from '@shaders/restore-gate.wgsl';
import { gpuResourceCache } from '@core/gpu/gpu-resource-cache';
import type { DestroyablePipeline } from '@/types';

/** Tunable parameters of the {@link GatedRestore} wrapper. */
export interface GatedRestoreOptions {
  /** Lower luma-amplitude edge of the smoothstep ramp. */
  gateLow: number;
  /** Upper luma-amplitude edge of the smoothstep ramp. */
  gateHigh: number;
  /** Global multiplier applied to the gate mask, clamped to `[0, 1]`. */
  gateStrength: number;
}

/**
 * Sub-4K `gate` profile. Used when the chain emits a target-exact final
 * Downscale, so the trailing restores are dropped and only the leading restore
 * is gated (running at the scaled-up intermediate). Calibrated on the real
 * frame under the GPU ROI gate: the wide ramp keeps the wing contour at the
 * no-restore ceiling (lineContrast 1.000x, midRMS 0.951x of a no-restore chain)
 * while face fine detail (1.003x) and whole-frame high-frequency energy
 * (1.009x) match the shipped trailing chain.
 */
export const GATED_RESTORE_DEFAULTS: GatedRestoreOptions = Object.freeze({
  gateLow: 0.006,
  gateHigh: 0.030,
  gateStrength: 1.0,
});

/**
 * ≥4K `gate` profile. Used when no final Downscale is emitted, so every restore
 * is retained and gated at the render target.
 *
 * The looser ramp is calibrated on the real frame under the 4K GPU ROI gate:
 * the restores are fully bypassed on the faint wing contour (lineContrast and
 * midRMS both reach the no-restore ceiling, 1.000x) while face fine detail
 * (0.985x) and high-frequency energy (0.967x whole-frame) stay at the shipped
 * chain's level. A tighter ramp cannot reach the 4K wing target because the
 * contour amplitude sits above a narrow ramp's upper edge.
 */
export const GATED_RESTORE_4K_DEFAULTS: GatedRestoreOptions = Object.freeze({
  gateLow: 0.030,
  gateHigh: 0.060,
  gateStrength: 1.0,
});

/** Target height (px) at/above which the ≥4K gate profile is selected. */
export const GATED_RESTORE_4K_HEIGHT_THRESHOLD = 2160;

/**
 * Select the `gate` profile for a render target.
 *
 * The split tracks whether the restores run at the render target: ≥4K
 * (equal-upscale) targets emit no final Downscale, so every restore is gated at
 * the target, while sub-4K targets drop the trailing restores and gate only the
 * leading one. 2160 is the practical proxy for that split.
 *
 * Returns the shared, frozen profile constant (not a per-call copy); callers
 * must treat it as read-only.
 */
export function selectGatedRestoreOptions(
  targetDimensions: { width: number; height: number },
): GatedRestoreOptions {
  return targetDimensions.height >= GATED_RESTORE_4K_HEIGHT_THRESHOLD
    ? GATED_RESTORE_4K_DEFAULTS
    : GATED_RESTORE_DEFAULTS;
}

/**
 * Wrap a compiled restore pipeline so its residual is applied only where the
 * local luma amplitude passes the gate.
 *
 * Usage mirrors a library effect:
 *   const gated = new GatedRestore({ device, inputTexture, restore });
 *   await gated.pass(encoder);
 *   const output = gated.getOutputTexture();
 */
export class GatedRestore implements DestroyablePipeline {
  private readonly device: GPUDevice;
  private readonly restore: DestroyablePipeline;
  private readonly pipeline: GPUComputePipeline;
  private readonly bindGroup: GPUBindGroup;
  private readonly outputTexture: GPUTexture;
  private readonly uniformBuffer: GPUBuffer;
  private gateLow: number;
  private gateHigh: number;
  private gateStrength: number;

  constructor(descriptor: {
    device: GPUDevice;
    inputTexture: GPUTexture;
    restore: DestroyablePipeline;
    options?: GatedRestoreOptions;
  }) {
    const options = descriptor.options ?? GATED_RESTORE_DEFAULTS;
    this.device = descriptor.device;
    this.restore = descriptor.restore;
    this.gateLow = options.gateLow;
    this.gateHigh = options.gateHigh;
    this.gateStrength = options.gateStrength;

    // Same-size rgba16float output, matching the chain's intermediate format.
    this.outputTexture = this.device.createTexture({
      size: {
        width: descriptor.inputTexture.width,
        height: descriptor.inputTexture.height,
      },
      format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });

    // 16 bytes: vec4<f32> = [low, high, strength, unused].
    this.uniformBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.writeUniform();

    const shaderModule = gpuResourceCache.getShaderModule(
      this.device,
      RESTORE_GATE_SHADER,
      'restore-gate',
    );
    this.pipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: { module: shaderModule, entryPoint: 'main' },
    });

    this.bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: descriptor.inputTexture.createView() },
        { binding: 1, resource: this.restore.getOutputTexture().createView() },
        { binding: 2, resource: this.outputTexture.createView() },
        { binding: 3, resource: { buffer: this.uniformBuffer } },
      ],
    });
  }

  private writeUniform(): void {
    this.device.queue.writeBuffer(
      this.uniformBuffer,
      0,
      new Float32Array([this.gateLow, this.gateHigh, this.gateStrength, 0]),
    );
  }

  /** Accepts only `gateLow | gateHigh | gateStrength`; never forwards to the inner restore. */
  updateParam(param: string, value: unknown): void {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    const clamped = Math.max(0, Math.min(1, value));
    switch (param) {
      case 'gateLow':
        this.gateLow = clamped;
        break;
      case 'gateHigh':
        this.gateHigh = clamped;
        break;
      case 'gateStrength':
        this.gateStrength = clamped;
        break;
      default:
        return;
    }
    this.writeUniform();
  }

  /** Run the inner restore, then gate its residual into this node's output. */
  async pass(encoder: GPUCommandEncoder): Promise<void> {
    await this.restore.pass(encoder);

    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.dispatchWorkgroups(
      Math.ceil(this.outputTexture.width / 8),
      Math.ceil(this.outputTexture.height / 8),
    );
    pass.end();
  }

  getOutputTexture(): GPUTexture {
    return this.outputTexture;
  }

  destroy(): void {
    this.outputTexture.destroy();
    this.uniformBuffer.destroy();
    this.restore.destroy?.();
  }
}
