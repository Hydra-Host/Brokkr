import { reactConfig } from '@repo/eslint-config/react';
import globals from 'globals';

export default [
  ...reactConfig,
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    ignores: ['dist/**', 'eslint.config.mjs'],
  },
];
