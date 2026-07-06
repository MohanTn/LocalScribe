
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
      // No parserOptions.project: only the non-type-aware recommended presets
      // are enabled, and this repo has no root tsconfig.json (it splits into
      // tsconfig.node.json / tsconfig.web.json).
    },
    rules: {
      // Optional: override rules from any of the above presets
      // 'sonarjs/no-duplicate-string': 'warn',
    },
  },
  {
    // Node ESM utility scripts (run directly via `node scripts/...`), not
    // bundled app code — give them the Node globals they actually have.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
    },
  },
  {
    ignores: ['node_modules/', 'dist/', 'build/', 'out/', 'release/', '*.config.js'],
  }
);
