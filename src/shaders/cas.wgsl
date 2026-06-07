// Contrast Adaptive Sharpening — WGSL Compute Shader
// Based on AMD FidelityFX CAS v1.0.2 (MIT License)

@group(0) @binding(0) var inputTex: texture_2d<f32>;
@group(0) @binding(1) var outputTex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> params: vec2<f32>; // x = sharpness (0.0–1.0), y = unused

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let size = textureDimensions(inputTex);
  let pos = vec2<i32>(i32(gid.x), i32(gid.y));

  if (pos.x >= i32(size.x) || pos.y >= i32(size.y)) {
    return;
  }

  let sharpness = params.x;

  // Fetch 3x3 neighborhood:
  //  a b c
  //  d e f
  //  g h i
  let e = textureLoad(inputTex, pos, 0).rgb;

  // Clamp to valid coordinates
  let x0 = max(pos.x - 1, 0);
  let x1 = min(pos.x + 1, i32(size.x) - 1);
  let y0 = max(pos.y - 1, 0);
  let y1 = min(pos.y + 1, i32(size.y) - 1);

  let a = textureLoad(inputTex, vec2<i32>(x0, y0), 0).rgb;
  let b = textureLoad(inputTex, vec2<i32>(pos.x, y0), 0).rgb;
  let c = textureLoad(inputTex, vec2<i32>(x1, y0), 0).rgb;
  let d = textureLoad(inputTex, vec2<i32>(x0, pos.y), 0).rgb;
  let f = textureLoad(inputTex, vec2<i32>(x1, pos.y), 0).rgb;
  let g = textureLoad(inputTex, vec2<i32>(x0, y1), 0).rgb;
  let h = textureLoad(inputTex, vec2<i32>(pos.x, y1), 0).rgb;
  let i = textureLoad(inputTex, vec2<i32>(x1, y1), 0).rgb;

  // Soft min and max using cross (+) and diagonal (x) patterns
  // Cross pattern: b, d, e, f, h
  var mnRGB = min(min(min(d, e), min(f, b)), h);
  // Full 3x3 min
  let mnRGB2 = min(mnRGB, min(min(a, c), min(g, i)));
  mnRGB += mnRGB2;

  // Cross pattern max
  var mxRGB = max(max(max(d, e), max(f, b)), h);
  // Full 3x3 max
  let mxRGB2 = max(mxRGB, max(max(a, c), max(g, i)));
  mxRGB += mxRGB2;

  // Smooth minimum distance to signal limit divided by smooth max
  let rcpMRGB = 1.0 / mxRGB;
  var ampRGB = clamp(min(mnRGB, 2.0 - mxRGB) * rcpMRGB, vec3<f32>(0.0), vec3<f32>(1.0));

  // Shaping amount of sharpening
  ampRGB = inverseSqrt(ampRGB);

  // Peak value derived from sharpness parameter (maps 0..1 to 8..5)
  let peak = -3.0 * sharpness + 8.0;
  let wRGB = -(1.0 / (ampRGB * peak));

  let rcpWeightRGB = 1.0 / (4.0 * wRGB + 1.0);

  // Filter shape:
  //   0 w 0
  //   w 1 w
  //   0 w 0
  let window = (b + d) + (f + h);
  let outColor = clamp((window * wRGB + e) * rcpWeightRGB, vec3<f32>(0.0), vec3<f32>(1.0));

  // Mix original and sharpened based on sharpness intensity
  let result = mix(e, outColor, sharpness);
  textureStore(outputTex, pos, vec4<f32>(result, 1.0));
}
