import { nestJsConfig } from '@repo/eslint-config/nest-js';

const noLocalErrorMessageHelper = {
  selector:
    'FunctionDeclaration[id.name=/^(getErrorMessage|errorMessage|getMessage)$/], VariableDeclarator[id.name=/^(getErrorMessage|errorMessage|getMessage)$/]:matches([init.type="ArrowFunctionExpression"], [init.type="FunctionExpression"])',
  message: 'Do not re-declare an error-message helper. Import { getErrorMessage } from src/common/error-utils instead.',
};

export default [
  ...nestJsConfig,
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', noLocalErrorMessageHelper],
    },
  },
  {
    files: ['src/common/error-utils.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
  {
    ignores: ['dist/**', 'eslint.config.mjs', '.swcrc'],
  },
];
