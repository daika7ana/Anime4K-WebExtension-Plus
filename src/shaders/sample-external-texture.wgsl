// Texture sampling fragment shader
// Samples color values from a texture and outputs them to the screen

@group(0) @binding(1) var mySampler: sampler;
@group(0) @binding(2) var myTexture: texture_2d<f32>;

@fragment
fn main(@location(0) fragUV : vec2f) -> @location(0) vec4f {
  // Sample texture with base edge clamping
  return textureSampleBaseClampToEdge(myTexture, mySampler, fragUV);
}
