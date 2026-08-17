import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.spec.ts'],
  },
  resolve: {
    alias: {
      '@hydrahost/plugin-sdk': path.resolve(__dirname, '../plugin-sdk/src/index.ts'),
    },
  },
});
