/**
 * Color Adjustment — Custom WebGPU compute pipeline.
 *
 * Applies per-pixel color grading adjustments: brightness, gamma, contrast,
 * saturation, vibrance, and exposure.
 * Always applied as the last stage in the enhancement pipeline (color grading).
 *
 * Uses BT.709 luminance coefficients for HD/UHD content.
 *
 * Shader math:
 * 1. Exposure: multiplicative (2^stops)
 * 2. Brightness: additive offset
 * 3. Contrast: scale around 0.5 pivot
 * 4. Gamma: power curve (gamma > 1 brightens midtones, < 1 darkens)
 * 5. Saturation: uniform color channel scaling around luminance
 * 6. Vibrance: selective saturation boost (less-saturated pixels get more boost)
 */

import COLOR_ADJUST_SHADER from '@shaders/color-adjust.wgsl';

/**
 * ColorAdjust pipeline implementing the Anime4KPipeline interface.
 *
 * Uses two uniform buffers (WebGPU requires 256-byte alignment for buffer offsets,
 * so a single buffer with offset-based sub-regions is not practical here):
 *  - binding 2 (vec4<f32>, 16 bytes): brightness, gamma, contrast, vibrance
 *  - binding 3 (vec2<f32>, 8 bytes): saturation, exposure
 *
 * Usage:
 *   const colorAdjust = new ColorAdjust({ device, inputTexture, brightness: 0, gamma: 1, ... });
 *   colorAdjust.pass(encoder);
 *   const output = colorAdjust.getOutputTexture();
 */
export class ColorAdjust {
  private device: GPUDevice;
  private pipeline: GPUComputePipeline;
  private bindGroup: GPUBindGroup;
  private outputTexture: GPUTexture;
  private paramsBuffer: GPUBuffer;   // vec4<f32>: brightness, gamma, contrast, vibrance
  private params2Buffer: GPUBuffer;  // vec2<f32>: saturation, exposure
  private brightness: number;
  private gamma: number;
  private contrast: number;
  private saturation: number;
  private vibrance: number;
  private exposure: number;

  constructor(descriptor: {
    device: GPUDevice;
    inputTexture: GPUTexture;
    brightness?: number;
    gamma?: number;
    contrast?: number;
    saturation?: number;
    vibrance?: number;
    exposure?: number;
  }) {
    this.device = descriptor.device;
    this.brightness = descriptor.brightness ?? 0;
    this.gamma = descriptor.gamma ?? 1;
    this.contrast = descriptor.contrast ?? 1;
    this.saturation = descriptor.saturation ?? 1;
    this.vibrance = descriptor.vibrance ?? 0;
    this.exposure = descriptor.exposure ?? 0;

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

    // Create uniform buffer for primary params (vec4<f32> = 16 bytes)
    this.paramsBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create uniform buffer for secondary params (vec2<f32> = 8 bytes)
    this.params2Buffer = this.device.createBuffer({
      size: 8,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.writeParams();

    // Create shader module
    const shaderModule = this.device.createShaderModule({
      code: COLOR_ADJUST_SHADER,
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
        { binding: 3, resource: { buffer: this.params2Buffer } },
      ],
    });
  }

  /** Update a param at runtime. */
  updateParam(param: string, value: unknown): void {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    switch (param) {
      case 'brightness':
        this.brightness = Math.max(-1, Math.min(1, value));
        break;
      case 'gamma':
        this.gamma = Math.max(0.1, Math.min(4, value));
        break;
      case 'contrast':
        this.contrast = Math.max(0, Math.min(2, value));
        break;
      case 'saturation':
        this.saturation = Math.max(0, Math.min(2, value));
        break;
      case 'vibrance':
        this.vibrance = Math.max(-1, Math.min(1, value));
        break;
      case 'exposure':
        this.exposure = Math.max(-3, Math.min(3, value));
        break;
      default:
        return;
    }
    this.writeParams();
  }

  private writeParams(): void {
    this.device.queue.writeBuffer(
      this.paramsBuffer,
      0,
      new Float32Array([this.brightness, this.gamma, this.contrast, this.vibrance]),
    );
    this.device.queue.writeBuffer(
      this.params2Buffer,
      0,
      new Float32Array([this.saturation, this.exposure]),
    );
  }

  /** Record color adjust compute pass into the command encoder */
  pass(encoder: GPUCommandEncoder): Promise<void> {
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    const workgroupsX = Math.ceil(this.outputTexture.width / 8);
    const workgroupsY = Math.ceil(this.outputTexture.height / 8);
    pass.dispatchWorkgroups(workgroupsX, workgroupsY);
    pass.end();
    return Promise.resolve();
  }

  /** Get the color-adjusted output texture */
  getOutputTexture(): GPUTexture {
    return this.outputTexture;
  }

  /** Clean up GPU resources */
  destroy(): void {
    this.outputTexture.destroy();
    this.paramsBuffer.destroy();
    this.params2Buffer.destroy();
  }
}
