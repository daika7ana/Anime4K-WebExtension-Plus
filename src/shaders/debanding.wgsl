// Debanding — WGSL Compute Shader
// Removes banding artifacts via gradient detection + dithering

@group(0) @binding(0) var inputTex: texture_2d<f32>;
@group(0) @binding(1) var outputTex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> params: vec2<f32>; // x = strength (0.0–1.0), y = bandThreshold (0.0–1.0)

// 4x4 Bayer ordered dither. Returns a deterministic value in [0, 1].
// Preferable to per-pixel white noise for debanding: distributes quantization
// energy across spatial frequencies in a way the eye perceives as less "grainy".
fn bayer4(x: i32, y: i32) -> f32 {
  // Standard 4x4 Bayer matrix (flattened row-major):
  //   0  8  2 10
  //  12  4 14  6
  //   3 11  1  9
  //  15  7 13  5
  let xm = x & 3;
  let ym = y & 3;
  let idx = ym * 4 + xm;
  let lookup = array<f32, 16>(
     0.0,  8.0,  2.0, 10.0,
    12.0,  4.0, 14.0,  6.0,
     3.0, 11.0,  1.0,  9.0,
    15.0,  7.0, 13.0,  5.0
  );
  return (lookup[idx] + 0.5) / 16.0;
}

// Convert RGB to approximate perceptual luminance
fn luminance(c: vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let size = textureDimensions(inputTex);
  let pos = vec2<i32>(i32(gid.x), i32(gid.y));

  if (pos.x >= i32(size.x) || pos.y >= i32(size.y)) {
    return;
  }

  let strength = params.x;
  let bandThreshold = params.y;
  let e = textureLoad(inputTex, pos, 0).rgb;

  // Sample cross-pattern neighbors at radius 1 and 2 (9 texels) to detect banding
  let x0 = max(pos.x - 1, 0);
  let x1 = min(pos.x + 1, i32(size.x) - 1);
  let x2 = max(pos.x - 2, 0);
  let x3 = min(pos.x + 2, i32(size.x) - 1);
  let y0 = max(pos.y - 1, 0);
  let y1 = min(pos.y + 1, i32(size.y) - 1);
  let y2 = max(pos.y - 2, 0);
  let y3 = min(pos.y + 2, i32(size.y) - 1);

  // Sample neighbors at radius 1 (cross pattern)
  let n1 = textureLoad(inputTex, vec2<i32>(x0, pos.y), 0).rgb;
  let n2 = textureLoad(inputTex, vec2<i32>(x1, pos.y), 0).rgb;
  let n3 = textureLoad(inputTex, vec2<i32>(pos.x, y0), 0).rgb;
  let n4 = textureLoad(inputTex, vec2<i32>(pos.x, y1), 0).rgb;

  // Sample neighbors at radius 2 (cross pattern)
  let n5 = textureLoad(inputTex, vec2<i32>(x2, pos.y), 0).rgb;
  let n6 = textureLoad(inputTex, vec2<i32>(x3, pos.y), 0).rgb;
  let n7 = textureLoad(inputTex, vec2<i32>(pos.x, y2), 0).rgb;
  let n8 = textureLoad(inputTex, vec2<i32>(pos.x, y3), 0).rgb;

  // Compute average of neighbors
  let avg = (n1 + n2 + n3 + n4 + n5 + n6 + n7 + n8) / 8.0;

  // Compute local contrast (max difference between center and neighbors)
  let lumE = luminance(e);
  let lumAvg = luminance(avg);
  let diff = abs(lumE - lumAvg);

  // Detect banding: low contrast + smooth gradient = likely banded
  // The threshold controls sensitivity: lower = more aggressive detection
  let bandMask = 1.0 - smoothstep(0.0, bandThreshold, diff);

  // Ordered dither based on pixel position — consistent across frames (no temporal
  // flicker). Bayer is monochromatic, applied to all channels with the same pattern.
  let dither = bayer4(pos.x, pos.y) * 2.0 - 1.0; // -1 to 1
  let noise = vec3<f32>(dither, dither, dither);

  // Constant noise amplitude — bandMask already gates noise to banded regions,
  // so a gradient multiplier would be double-counting (the previous scaling produced
  // LESS noise in flat areas, where banding actually lives).
  let noiseScale = strength * 0.015;

  // Apply noise only in banded regions
  let debanded = e + noise * noiseScale * bandMask;

  // Clamp to valid range
  let result = clamp(debanded, vec3<f32>(0.0), vec3<f32>(1.0));
  textureStore(outputTex, pos, vec4<f32>(result, 1.0));
}
