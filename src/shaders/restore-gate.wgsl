// Restore gate — WGSL Compute Shader
//
// Compile-time wrapper for the restore-policy `gate` mode. It keeps the inner
// restore's full-strength residual but only applies it where the local 3x3
// encoded-domain Rec.709 luma amplitude exceeds `gate.low`, ramping in over
// `[low, high]` and scaled by `gate.strength`:
//
//   m = smoothstep(low, high, max9 - min9) * clamp(strength, 0, 1)
//   out = mix(input, restoreOut, m)
//
// Bindings and the entry point are a FIXED contract shared with the e2e harness.

@group(0) @binding(0) var tex_in: texture_2d<f32>;            // pre-restore input
@group(0) @binding(1) var tex_restore: texture_2d<f32>;       // inner restore output
@group(0) @binding(2) var tex_out: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var<uniform> gate: vec4<f32>;           // x=low, y=high, z=strength, w=unused

fn luma709(c: vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let size = textureDimensions(tex_in);
  let pos = vec2<i32>(i32(gid.x), i32(gid.y));

  if (pos.x >= i32(size.x) || pos.y >= i32(size.y)) {
    return;
  }

  // Clamped 3x3 neighborhood (edge texels replicate the border).
  let x0 = max(pos.x - 1, 0);
  let x1 = min(pos.x + 1, i32(size.x) - 1);
  let y0 = max(pos.y - 1, 0);
  let y1 = min(pos.y + 1, i32(size.y) - 1);

  var lo = 1.0e9;
  var hi = -1.0e9;
  for (var yy = y0; yy <= y1; yy = yy + 1) {
    for (var xx = x0; xx <= x1; xx = xx + 1) {
      let l = luma709(textureLoad(tex_in, vec2<i32>(xx, yy), 0).rgb);
      lo = min(lo, l);
      hi = max(hi, l);
    }
  }

  let m = smoothstep(gate.x, gate.y, hi - lo) * clamp(gate.z, 0.0, 1.0);
  let base = textureLoad(tex_in, pos, 0);
  let restored = textureLoad(tex_restore, pos, 0);
  textureStore(tex_out, pos, mix(base, restored, m));
}
