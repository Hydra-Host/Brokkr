import path from 'path';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    setupFiles: ['test/setup/mock-redis-bullmq.ts'],
    include: [
      'src/**/*.spec.ts',
      'src/**/*.test.ts',
      'test/parity/**/*.spec.ts',
      'test/integration/**/*.spec.ts',
      'test/property/**/*.spec.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', 'src/_example/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
  plugins: [
    swc.vite({
      module: { type: 'es6' },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      src: path.resolve(__dirname, './src'),
    },
  },
});
