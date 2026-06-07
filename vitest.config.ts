import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@core': path.resolve(__dirname, 'src/core'),
      '@core/video': path.resolve(__dirname, 'src/core/video'),
      '@core/gpu': path.resolve(__dirname, 'src/core/gpu'),
      '@core/effects': path.resolve(__dirname, 'src/core/effects'),
      '@core/ui': path.resolve(__dirname, 'src/core/ui'),
      '@core/utils': path.resolve(__dirname, 'src/core/utils'),
      '@utils': path.resolve(__dirname, 'src/utils'),
      '@shaders': path.resolve(__dirname, 'src/shaders'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    // Mock .wgsl shader files as empty strings
    server: {
      deps: {
        inline: [/\.wgsl$/],
      },
    },
  },
});
