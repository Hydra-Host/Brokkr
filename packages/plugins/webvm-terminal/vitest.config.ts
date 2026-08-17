import { defineConfig } from 'vitest/config';

// No unplugin-swc here (unlike the NestJS-bearing plugins): this plugin is
// frontend-only with no decorators, so vitest's default esbuild transform is enough.
export default defineConfig({
  test: {
    include: ['**/__test__/**/*.spec.ts', '**/__test__/**/*.spec.tsx'],
    globals: false,
  },
});
