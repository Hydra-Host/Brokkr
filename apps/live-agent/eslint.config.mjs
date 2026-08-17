import { nestJsConfig } from '@repo/eslint-config/nest-js';

export default [
  ...nestJsConfig,
  {
    ignores: ['dist/**', 'src/gen/**', 'eslint.config.mjs'],
  },
];
