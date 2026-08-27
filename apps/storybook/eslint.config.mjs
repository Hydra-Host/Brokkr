import { reactConfig } from '@repo/eslint-config/react';

export default [
  ...reactConfig,
  {
    ignores: ['storybook-static/**', 'eslint.config.mjs'],
  },
];
