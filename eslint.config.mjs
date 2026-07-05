import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
    {ignores: ['dist', 'node_modules']},
    {
        extends: [js.configs.recommended, ...tseslint.configs.recommended],
        files: ['**/*.ts'],
        languageOptions: {
            sourceType: 'module',
            ecmaVersion: 2020,
            globals: {
                ...globals.node,
                Bun: 'readonly'
            },

            parserOptions: {
                tsconfigRootDir: import.meta.dirname,
                projectService: {
                    allowDefaultProject: [
                        'eslint.config.mjs',
                        '.prettierrc.cjs',
                        'scripts/*.ts'
                    ],
                    defaultProject: 'tsconfig.json'
                }
            }
        },
        rules: {
            '@typescript-eslint/no-unsafe-call': 'warn',
            '@typescript-eslint/no-unsafe-member-access': 'warn',
            '@typescript-eslint/require-await': 'warn',
            '@typescript-eslint/no-unsafe-argument': 'warn',
            '@typescript-eslint/no-misused-promises': 'warn',

            '@typescript-eslint/no-unused-vars': [
                'warn',
                {
                    args: 'all',
                    argsIgnorePattern: '^_',
                    caughtErrors: 'all',
                    caughtErrorsIgnorePattern: '^_',
                    destructuredArrayIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    ignoreRestSiblings: true
                }
            ],

            '@typescript-eslint/unbound-method': 'warn',
            '@typescript-eslint/no-floating-promises': 'warn',
            '@typescript-eslint/no-explicit-any': 'error',
            'no-empty': ['error', {allowEmptyCatch: true}],
            'linebreak-style': ['error', 'unix'],
            // avoidEscape lets a string keep double quotes when it contains a
            // single quote (e.g. "couldn't"). Without it, eslint --fix rewrites
            // prettier's double-quoted form to single-quoted-with-backslash,
            // which prettier then re-flags — so `prettier --write && eslint --fix`
            // never converges and lint silently leaves files dirty.
            quotes: ['error', 'single', {allowTemplateLiterals: true, avoidEscape: true}],
            semi: ['error', 'never'],
            'no-tabs': 0,
            'object-curly-spacing': [2, 'never'],
            'array-bracket-spacing': [2, 'never'],
            'computed-property-spacing': [2, 'never'],
            'brace-style': [2, '1tbs'],
            'keyword-spacing': [2],
            'eol-last': [2],
            'no-trailing-spaces': [2],
            'no-redeclare': 2,
            'no-shadow': [2, {allow: ['_']}],
            properties: 0,
            camelcase: 0
        }
    },
    {
        // Test mocks deliberately mark methods `async` to match the real
        // async signatures they stand in for, even when the fake body has
        // no `await`. That's intentional, so don't flag it here.
        files: ['**/*.test.ts', 'src/test-utils/**/*.ts'],
        rules: {
            '@typescript-eslint/require-await': 'off'
        }
    }
)
