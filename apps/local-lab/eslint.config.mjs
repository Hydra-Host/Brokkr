import { nestJsConfig } from '@repo/eslint-config/nest-js';

export default [
  ...nestJsConfig,
  {
    rules: {
      // steer new code toward parsing/guards over `as` casts; warn (not error) so the pre-existing
      // sites don't fail lint while they're migrated.
      '@typescript-eslint/consistent-type-assertions': ['warn', { assertionStyle: 'never' }],
    },
  },
  {
    ignores: ['dist/**', 'eslint.config.mjs', 'scripts/**'],
  },
];
