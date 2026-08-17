import { reactConfig } from '@repo/eslint-config/react';

export default [
  ...reactConfig,
  {
    ignores: ['dist/**', 'backend/dist/**', 'frontend/dist/**', 'eslint.config.mjs'],
  },
];
