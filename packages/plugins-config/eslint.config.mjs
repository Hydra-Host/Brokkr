import { nestJsConfig } from '@repo/eslint-config/nest-js';

export default [
  ...nestJsConfig,
  {
    ignores: ['dist/**', 'eslint.config.mjs', 'scripts/**'],
  },
];
