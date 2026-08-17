import { config as baseConfig } from '@repo/eslint-config/base';

export default [
  ...baseConfig,
  {
    ignores: ['dist/**', 'eslint.config.mjs', 'test-vectors/auth-dh-v1.json'],
  },
];
