import { config as baseConfig } from '@repo/eslint-config/base';
import { nestJsConfig } from '@repo/eslint-config/nest-js';
import { reactConfig } from '@repo/eslint-config/react';

export default [
  ...nestJsConfig.map((config) => ({
    ...config,
    files: ['apps/api/**/*.{ts,js}'],
  })),
  ...reactConfig.map((config) => ({
    ...config,
    files: [
      'apps/web/**/*.{ts,tsx,js,jsx}',
      'packages/ui/**/*.{ts,tsx,js,jsx}',
      'packages/plugin-sdk/**/*.{ts,tsx,js,jsx}',
    ],
  })),
  ...baseConfig.map((config) => ({
    ...config,
    files: ['packages/plugins/device-monitoring/**/*.{ts,js}'],
  })),
  {
    files: ['apps/api/src/app.module.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: './admin/admin.module',
              message: 'Main app must not import AdminModule.',
            },
            {
              name: 'src/admin/admin.module',
              message: 'Main app must not import AdminModule.',
            },
          ],
        },
      ],
    },
  },
  {
    ignores: ['node_modules/**', '**/dist/**', '**/.turbo/**', '**/*.generated.ts', 'eslint.config.mjs'],
  },
];
