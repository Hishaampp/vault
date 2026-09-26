// Lints the whole codebase: TypeScript rules everywhere, strict accessibility rules
// for the React UI (eslint-plugin-jsx-a11y), and the rules of hooks.
import globals from 'globals';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'node_modules', '.vault-data'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['log', 'error'] }],
      'prefer-const': 'error',
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [jsxA11y.flatConfigs.strict],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: globals.browser, parserOptions: { ecmaFeatures: { jsx: true } } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // scrollable regions and logs must be focusable so keyboard users can scroll them (axe: scrollable-region-focusable)
      'jsx-a11y/no-noninteractive-tabindex': ['error', { roles: ['tabpanel', 'region', 'log'] }],
    },
  },
  {
    files: ['server/**/*.ts', 'vite.config.ts', 'eslint.config.js'],
    languageOptions: { globals: globals.node },
  },
  {
    // Test files use non-null assertions to keep expectations short.
    files: ['**/__tests__/**'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);