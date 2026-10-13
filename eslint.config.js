import js from '@eslint/js';
import globals from 'globals';

export default [
    {
        ignores: ['dist/**', 'node_modules/**', 'src/content/generated/**', 'content/**', 'public/**', '.wrangler/**'],
    },
    js.configs.recommended,
    {
        files: ['src/**/*.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: { ...globals.browser },
        },
    },
    {
        files: ['src/services/hint-worker.js'],
        languageOptions: { globals: { ...globals.worker } },
    },
    {
        files: ['tools/**/*.mjs', 'tests/**/*.mjs', '*.js', '*.mjs'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: { ...globals.node, ...globals.browser },
        },
    },
    {
        rules: {
            'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
            'no-empty': ['error', { allowEmptyCatch: true }],
            'prefer-const': 'error',
            eqeqeq: ['error', 'smart'],
        },
    },
];
