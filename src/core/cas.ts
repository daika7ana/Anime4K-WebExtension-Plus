/**
 * Contrast Adaptive Sharpening (CAS) — Custom WebGPU compute pipeline.
 *
 * Based on AMD FidelityFX CAS v1.0.2 (MIT License).
 * Ported from GLSL to WGSL for WebGPU compute shaders.
 *
 * This is a single-pass adaptive sharpening filter that uses local min/max
 * luminance to modulate sharpening intensity. It enhances edges and details
 * without amplifying noise in flat regions.
 *
 * Original GLSL implementation:
 * https://github.com/BenjaminWegener/AMD-fidelityFX-SuperResolution-webGL
 */

import CAS_SHADER from '../shaders/cas.wgsl';

/**
 * CAS (Contrast Adaptive Sharpening) pipeline implementing the Anime4KPipeline interface.
 *
 * Usage:
 *   const cas = new CAS({ device, inputTexture, sharpness: 0.5 });
 *   cas.pass(encoder);
 *   const output = cas.getOutputTexture();
 */
export class CAS {
  private device: GPUDevice;
  private pipeline: GPUComputePipeline;
  private bindGroup: GPUBindGroup;
  private outputTexture: GPUTexture;
  private paramsBuffer: GPUBuffer;
  private sharpness: number;

  constructor(descriptor: {
    device: GPUDevice;
    inputTexture: GPUTexture;
    sharpness?: number;
  }) {
    this.device = descriptor.device;
    this.sharpness = descriptor.sharpness ?? 0.5;

    const inputSize = {
      width: descriptor.inputTexture.width,
      height: descriptor.inputTexture.height,
    };

    // Create output texture (same dimensions as input)
    this.outputTexture = this.device.createTexture({
      size: inputSize,
      format: 'rgba8unorm',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });

    // Create uniform buffer for parameters
    this.paramsBuffer = this.device.createBuffer({
      size: 8, // vec2<f32>
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.paramsBuffer, 0, new Float32Array([this.sharpness, 0]));

    // Create shader module
    const shaderModule = this.device.createShaderModule({
      code: CAS_SHADER,
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

  /** Update sharpness at runtime (0.0 = no sharpening, 1.0 = maximum) */
  updateParam(param: string, value: unknown): void {
    if (param === 'sharpness' && typeof value === 'number' && Number.isFinite(value)) {
      this.sharpness = Math.max(0, Math.min(1, value));
      this.device.queue.writeBuffer(this.paramsBuffer, 0, new Float32Array([this.sharpness, 0]));
    }
  }

  /** Record CAS compute pass into the command encoder */
  pass(encoder: GPUCommandEncoder): void {
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    const workgroupsX = Math.ceil(this.outputTexture.width / 8);
    const workgroupsY = Math.ceil(this.outputTexture.height / 8);
    pass.dispatchWorkgroups(workgroupsX, workgroupsY);
    pass.end();
  }

  /** Get the sharpened output texture */
  getOutputTexture(): GPUTexture {
    return this.outputTexture;
  }

  /** Clean up GPU resources */
  destroy(): void {
    this.outputTexture.destroy();
    this.paramsBuffer.destroy();
  }
}
