// Ambient module declarations for WGSL shader imports.
// Webpack's asset/source loader imports these as raw strings at build time.
declare module '*.wgsl' {
  const value: string;
  export default value;
}
