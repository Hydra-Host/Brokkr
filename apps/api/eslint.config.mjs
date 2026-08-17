import { nestJsConfig } from '@repo/eslint-config/nest-js';

export default [
  ...nestJsConfig,
  {
    ignores: ['.prettierrc.mjs', 'eslint.config.mjs', 'src/prisma/fixtures.d.ts'],
  },
];
