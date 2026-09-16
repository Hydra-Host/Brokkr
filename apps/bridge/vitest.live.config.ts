import path from 'path';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// test/live specs drive the real saga steps and redfish operations over an in-process fake BMC;
// they need neither the mock-redis setup file nor a running stack.
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
