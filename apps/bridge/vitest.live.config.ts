import path from 'path';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Live-sim verification specs: run against a running local sim (real Redis with
// zone_crypto, compiled dist). No mock-redis setup file — these need real ioredis.
export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/live/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
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
