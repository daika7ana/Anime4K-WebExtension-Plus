/**
 * Debanding — Custom WebGPU compute pipeline.
 *
 * Removes banding artifacts (visible color banding in smooth gradients) by
 * detecting banded regions and applying perceptually-weighted dithering.
 *
 * Algorithm:
 * 1. Sample a neighborhood around each pixel to estimate local gradient
 * 2. Detect banding: look for smooth gradients with hard quantization edges
 * 3. Apply deterministic noise (based on pixel coordinates) to break up bands
 * 4. Blend with original based on strength parameter
 *
 * Inspired by f3kdb (Flash3kyuu Deband) and mpv's deband shader.
 */

import DEBANDING_SHADER from '@shaders/debanding.wgsl';

/**
 * Debanding pipeline implementing the Anime4KPipeline interface.
 *
 * Usage:
 *   const debanding = new Debanding({ device, inputTexture, strength: 0.5 });
 *   debanding.pass(encoder);
 *   const output = debanding.getOutputTexture();
 */
export class Debanding {
  private device: GPUDevice;
  private pipeline: GPUComputePipeline;
  private bindGroup: GPUBindGroup;
  private outputTexture: GPUTexture;
  private paramsBuffer: GPUBuffer;
  private strength: number;
  private bandThreshold: number;

  constructor(descriptor: {
    device: GPUDevice;
    inputTexture: GPUTexture;
    strength?: number;
    bandThreshold?: number;
  }) {
    this.device = descriptor.device;
    this.strength = descriptor.strength ?? 0.5;
    this.bandThreshold = descriptor.bandThreshold ?? 0.08;

    const inputSize = {
      width: descriptor.inputTexture.width,
      height: descriptor.inputTexture.height,
    };

    // Create output texture (same dimensions as input)
    this.outputTexture = this.device.createTexture({
      size: inputSize,
      format: 'rgba8unorm',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });

    // Create uniform buffer for parameters
    this.paramsBuffer = this.device.createBuffer({
      size: 8, // vec2<f32>
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.writeParams();

    // Create shader module
    const shaderModule = this.device.createShaderModule({
      code: DEBANDING_SHADER,
    });

    // Create compute pipeline
    this.pipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: shaderModule,
        entryPoint: 'main',
      },
    });

    // Create bind group
    this.bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: descriptor.inputTexture.createView() },
        { binding: 1, resource: this.outputTexture.createView() },
        { binding: 2, resource: { buffer: this.paramsBuffer } },
      ],
    });
  }

  /** Update a param at runtime. Recognised keys: 'strength' (0.0–1.0), 'bandThreshold' (0.0–1.0). */
  updateParam(param: string, value: unknown): void {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    if (param === 'strength') {
      this.strength = Math.max(0, Math.min(1, value));
      this.writeParams();
    } else if (param === 'bandThreshold') {
      this.bandThreshold = Math.max(0, Math.min(1, value));
      this.writeParams();
    }
  }

  private writeParams(): void {
    this.device.queue.writeBuffer(
      this.paramsBuffer,
      0,
      new Float32Array([this.strength, this.bandThreshold]),
    );
  }

  /** Record debanding compute pass into the command encoder */
  pass(encoder: GPUCommandEncoder): void {
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    const workgroupsX = Math.ceil(this.outputTexture.width / 8);
    const workgroupsY = Math.ceil(this.outputTexture.height / 8);
    pass.dispatchWorkgroups(workgroupsX, workgroupsY);
    pass.end();
  }

  /** Get the debanded output texture */
  getOutputTexture(): GPUTexture {
    return this.outputTexture;
  }

  /** Clean up GPU resources */
  destroy(): void {
    this.outputTexture.destroy();
    this.paramsBuffer.destroy();
  }
}
