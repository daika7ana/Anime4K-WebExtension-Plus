// Color Adjustment — WGSL Compute Shader
// Applies brightness, gamma, contrast, saturation, vibrance, and exposure per-pixel.
// Always applied as the last stage in the pipeline (color grading).

@group(0) @binding(0) var inputTex: texture_2d<f32>;
@group(0) @binding(1) var outputTex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> params: vec4<f32>; // x=brightness, y=gamma, z=contrast, w=vibrance
@group(0) @binding(3) var<uniform> params2: vec2<f32>; // x=saturation, y=exposure

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let size = textureDimensions(inputTex);
  let pos = vec2<i32>(i32(gid.x), i32(gid.y));

  if (pos.x >= i32(size.x) || pos.y >= i32(size.y)) {
    return;
  }

  let brightness = params.x;
  let gamma = max(params.y, 0.0001); // Avoid division by zero
  let contrast = params.z;
  let vibrance = params.w;
  let saturation = params2.x;
  let exposure = params2.y;

  var color = textureLoad(inputTex, pos, 0).rgb;

  // 1. Exposure (multiplicative — 2^stops)
  color = color * pow(2.0, exposure);

  // 2. Brightness (additive offset)
  color = color + vec3<f32>(brightness);

  // 3. Contrast (scale around 0.5 pivot)
  color = (color - vec3<f32>(0.5)) * contrast + vec3<f32>(0.5);

  // 4. Gamma (power curve — gamma > 1 brightens midtones, < 1 darkens)
  // Clamp before pow to avoid undefined behavior with negative values
  color = clamp(color, vec3<f32>(0.0), vec3<f32>(1.0));
  color = pow(color, vec3<f32>(1.0 / gamma));

  // 5. Saturation (uniform color channel scaling around luminance)
  // Luminance coefficients — BT.709 (HD/UHD standard)
  let lum = dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
  color = mix(vec3<f32>(lum), color, saturation);

  // 6. Vibrance (selective saturation — boosts less-saturated colors more)
  // Recompute luminance after saturation adjustment so vibrance mixes toward
  // the correct target rather than the pre-saturation luminance.
  let lum2 = dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
  let sat = max(max(color.r, color.g), color.b) - min(min(color.r, color.g), color.b);
  let amount = vibrance * (1.0 - sat);
  color = mix(vec3<f32>(lum2), color, 1.0 + amount);

  // Clamp and store
  color = clamp(color, vec3<f32>(0.0), vec3<f32>(1.0));
  textureStore(outputTex, pos, vec4<f32>(color, 1.0));
}
