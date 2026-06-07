// Full-screen textured quad vertex shader
// Defines vertex positions and UV coordinates for rendering a full-screen texture

struct VertexOutput {
  @builtin(position) Position : vec4<f32>,
  @location(0) fragUV : vec2<f32>,
}

@vertex
fn vert_main(@builtin(vertex_index) VertexIndex : u32) -> VertexOutput {
  const pos = array(
    vec2( 1.0,  1.0),  // Top-right
    vec2( 1.0, -1.0),  // Bottom-right
    vec2(-1.0, -1.0),  // Bottom-left
    vec2( 1.0,  1.0),  // Top-right (duplicate)
    vec2(-1.0, -1.0),  // Bottom-left (duplicate)
    vec2(-1.0,  1.0),  // Top-left
  );

  const uv = array(
    vec2(1.0, 0.0),  // Top-right UV
    vec2(1.0, 1.0),  // Bottom-right UV
    vec2(0.0, 1.0),  // Bottom-left UV
    vec2(1.0, 0.0),  // Top-right UV (duplicate)
    vec2(0.0, 1.0),  // Bottom-left UV (duplicate)
    vec2(0.0, 0.0),  // Top-left UV
  );

  var output : VertexOutput;
  output.Position = vec4(pos[VertexIndex], 0.0, 1.0);
  output.fragUV = uv[VertexIndex];
  return output;
}
