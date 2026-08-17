import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // only run the TS sources; never the compiled dist output (CommonJS, can't import vitest)
    include: ['src/**/*.test.ts'],
  },
});
