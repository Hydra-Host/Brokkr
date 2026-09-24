import { reactConfig } from '@repo/eslint-config/react';

export default [
  ...reactConfig,
  {
    files: ['**/*.{ts,tsx,js,jsx}'],
    ignores: ['**/*.{spec,test}.{ts,tsx,js}', '**/__test__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@hydrahost/plugin-sdk/testing',
              message: 'plugin-sdk testing helpers are spec-only.',
            },
          ],
        },
      ],
    },
  },
  {
    ignores: ['dist/**', 'eslint.config.mjs'],
  },
];
