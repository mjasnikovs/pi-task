import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import prettierConfig from 'eslint-config-prettier/flat'

export default tseslint.config(
    {ignores: ['dist', 'node_modules', 'test/**/__fixtures__/**']},
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
                    allowDefaultProject: ['eslint.config.mjs', '.prettierrc.cjs'],
                    defaultProject: 'tsconfig.json'
                }
            }
        },
        rules: {
            '@typescript-eslint/no-unsafe-call': 'error',
            '@typescript-eslint/no-unsafe-member-access': 'error',
            '@typescript-eslint/require-await': 'error',
            '@typescript-eslint/no-unsafe-argument': 'error',
            '@typescript-eslint/no-misused-promises': 'error',

            '@typescript-eslint/no-unused-vars': [
                'error',
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

            '@typescript-eslint/unbound-method': 'error',
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/no-explicit-any': 'error',
            'no-empty': ['error', {allowEmptyCatch: true}],
            'linebreak-style': ['error', 'unix'],
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
            'no-shadow': 0,
            '@typescript-eslint/no-shadow': [2, {allow: ['_']}],
            camelcase: 0
        }
    },
    {
        // Mocks are `async` to match the real signatures they stand in for.
        files: ['**/*.test.ts', 'test/test-utils/**/*.ts'],
        rules: {
            '@typescript-eslint/require-await': 'off'
        }
    },
    // Last, so it wins: every stylistic rule set above is switched off here.
    prettierConfig
)
