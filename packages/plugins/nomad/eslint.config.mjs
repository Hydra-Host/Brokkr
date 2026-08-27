import { nestJsConfig } from '@repo/eslint-config/nest-js';

/** @type {import("eslint").Linter.Config} */
export default [
  ...nestJsConfig,
  {
    ignores: ['dist/**', 'backend/dist/**', 'eslint.config.mjs'],
  },
];
