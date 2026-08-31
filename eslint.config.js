import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'drizzle/**', '.ci/**', 'playwright-report/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      'no-console': ['error', { allow: ['error'] }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // Config files at the repo root aren't part of the tsconfig project, so
    // they can't go through type-aware linting.
    files: ['eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
    rules: { ...tseslint.configs.disableTypeChecked.rules, 'no-console': 'off' },
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: globals.node,
    },
  },
  {
    files: ['scripts/**/*.mjs', 'scripts/**/*.ts'],
    ...tseslint.configs.disableTypeChecked,
    rules: { ...tseslint.configs.disableTypeChecked.rules, 'no-console': 'off' },
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: globals.node,
    },
  },
  {
    // k6 load scripts run in the k6 runtime, not Node — __ENV and friends are
    // k6 globals, not covered by the `globals` package.
    files: ['load/**/*.js'],
    ...tseslint.configs.disableTypeChecked,
    rules: { ...tseslint.configs.disableTypeChecked.rules, 'no-console': 'off' },
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: { __ENV: 'readonly', __ITER: 'readonly', __VU: 'readonly' },
    },
  },
);
