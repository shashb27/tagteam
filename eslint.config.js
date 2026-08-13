import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    files: ['web/**/*.js'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    ignores: ['node_modules/**', 'test/e2e/**', 'docs/**', 'scripts/**'],
  },
  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
