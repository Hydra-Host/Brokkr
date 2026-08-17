import { reactConfig } from '@repo/eslint-config/react';
import globals from 'globals';

export default [
  ...reactConfig,
  {
    files: ['**/*.{mjs,cjs}'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    ignores: ['dist/**', 'eslint.config.mjs'],
  },
];
