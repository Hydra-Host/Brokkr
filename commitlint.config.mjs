export default {
  extends: ['@commitlint/config-conventional'],
  ignores: [(message) => message.trim() === 'Dev deploy.'],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert'],
    ],
    'header-max-length': [2, 'always', 100],
  },
};
