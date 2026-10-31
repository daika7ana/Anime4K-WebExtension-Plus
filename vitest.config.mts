import { defineConfig } from 'vitest/config';
import path from 'path';

// Plugin to handle .wgsl shader files as raw text
function wgslPlugin(): { name: string; transform: (code: string, id: string) => { code: string; map: null } | undefined } {
  return {
    name: 'wgsl-loader',
    transform(code: string, id: string) {
      if (id.endsWith('.wgsl')) {
        return {
          code: `export default ${JSON.stringify(code)};`,
          map: null,
        };
      }
    },
  };
}

export default defineConfig({
  plugins: [wgslPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@core': path.resolve(import.meta.dirname, 'src/core'),
      '@core/video': path.resolve(import.meta.dirname, 'src/core/video'),
      '@core/gpu': path.resolve(import.meta.dirname, 'src/core/gpu'),
      '@core/effects': path.resolve(import.meta.dirname, 'src/core/effects'),
      '@core/ui': path.resolve(import.meta.dirname, 'src/core/ui'),
      '@core/utils': path.resolve(import.meta.dirname, 'src/core/utils'),
      '@utils': path.resolve(import.meta.dirname, 'src/utils'),
      '@shaders': path.resolve(import.meta.dirname, 'src/shaders'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      enabled: false,
      include: ['src/**'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
        'src/**/*.d.ts',
        'src/**/*.html',
        'src/test-setup.ts',
      ],
      reporter: ['text', 'text-summary', 'json-summary', 'html'],
      // Thresholds are intentionally conservative (~5-8 points below the
      // coverage observed with `include: ['src/**']`) so that in-flight test
      // and source additions cannot turn the gate red. Raise these once
      // coverage stabilises.
      thresholds: {
        statements: 42,
        branches: 35,
        functions: 35,
        lines: 42,
      },
    },
  },
});
