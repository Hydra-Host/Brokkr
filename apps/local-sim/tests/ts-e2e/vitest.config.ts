import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['**/*.test.ts'],
    testTimeout: 1_800_000,
    hookTimeout: 300_000,
  },
  resolve: {
    alias: {
      '@repo/database': path.resolve(__dirname, '../../../../packages/database/generated/client'),
      '@repo/api-client/schemas/common': path.resolve(
        __dirname,
        '../../../../packages/api-client/src/schemas/common.ts',
      ),
    },
  },
});
