
// eslint.config.js
const sonarjs = require('eslint-plugin-sonarjs');
const tseslint = require('typescript-eslint');
const js = require('@eslint/js');

module.exports = tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  sonarjs.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: './tsconfig.json', // adjust if needed
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      // Optional: override rules from any of the above presets
      // 'sonarjs/no-duplicate-string': 'warn',
    },
  },
  {
    ignores: ['node_modules/', 'dist/', 'build/', '*.config.js'],
  }
);
