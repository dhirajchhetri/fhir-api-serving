import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'cdk.out/**', 'coverage/**', 'node_modules/**', 'data/**'],
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      globals: { module: 'readonly', require: 'readonly', __dirname: 'readonly', __filename: 'readonly' },
    },
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
);
