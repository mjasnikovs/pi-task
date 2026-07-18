import {describe, expect, test} from 'bun:test'
import {
    findScriptEscapes,
    findScriptEscapesInManifest,
    findScriptEscapesInText,
    judgeScript,
    scriptEscapeDefectText,
    scriptEscapeVerifyFindings
} from './script-escape.js'

/** The verbatim mx5 run-13 lint script — the true positive this module exists for. */
const MX5_LINT =
    "prettier --log-level warn --write --no-error-on-unmatched-pattern 'src/**/*.{ts,tsx}' "
    + '&& eslint --fix --no-error-on-unmatched-pattern . '
    + "&& (tsc --noEmit 2>&1 | grep -qv 'TS18003' || true)"

describe('the real mx5 run-13 true positive', () => {
    test('flags the neutered lint script for BOTH shapes', () => {
        const f = judgeScript('lint', MX5_LINT)
        expect(f).not.toBeNull()
        // A: the `|| true` tail survives the closing paren.
        expect(f!.reason).toContain('`|| true`')
        expect(f!.reason).toContain('exits 0 whatever the check reports')
        // B: the inverted grep laundering.
        expect(f!.reason).toContain('INVERTED grep')
    })

    test('is found through the manifest text, as shipped', () => {
        const manifest = JSON.stringify({
            name: 'mx5',
            scripts: {
                lint: MX5_LINT,
                test: 'AGENT=1 bun test',
                'test:ct': 'bunx playwright test --config=playwright-ct.config.ts',
                dev: 'bun run --watch src/server/index.ts & bunx tailwindcss --watch',
                build: 'bun build.ts',
                migrate: 'bun src/server/migrate.ts',
                seed: 'bun src/server/seed.ts'
            }
        })
        const f = findScriptEscapesInManifest(manifest)
        expect(f).toHaveLength(1)
        expect(f[0].name).toBe('lint')
    })
})

describe('shape A — always-zero tail', () => {
    test('flags every tail that forces exit 0', () => {
        for (const [body, want] of [
            ['tsc --noEmit || true', '`|| true`'],
            ['tsc --noEmit || :', '`|| :`'],
            ['tsc --noEmit || exit 0', '`|| exit 0`'],
            ['tsc --noEmit; true', '`; true`'],
            ['tsc --noEmit; exit 0', '`; exit 0`'],
            ['tsc --noEmit || echo "no worries"', 'trailing `|| echo …` fallback']
        ] as const) {
            const f = judgeScript('lint', body)
            expect(f).not.toBeNull()
            expect(f!.reason).toContain(want)
        }
    })

    test('sees through trailing subshell closers and separators', () => {
        expect(judgeScript('check', '(tsc --noEmit || true)')).not.toBeNull()
        expect(judgeScript('check', '(tsc --noEmit || true) ;')).not.toBeNull()
        expect(judgeScript('check', '((tsc --noEmit || true))')).not.toBeNull()
    })

    test('`|| exit 1` is a HARDENING, never an escape', () => {
        // Verbatim from aiz-server's real package.json.
        expect(
            judgeScript('build', 'npm run build || exit 1 && node ./dist/src/index.js')
        ).toBeNull()
        expect(judgeScript('test', 'tsc --noEmit || exit 2')).toBeNull()
    })

    test('a mid-script `|| true` that is not the tail does not force exit 0', () => {
        // The last command still decides the status, so the check is live.
        expect(judgeScript('test', 'rm -rf dist || true && bun test')).toBeNull()
    })
})

describe('shape B — inverted-grep laundering', () => {
    test('flags inverted grep in either flag order', () => {
        expect(judgeScript('lint', "tsc --noEmit | grep -qv 'TS18003'")).not.toBeNull()
        expect(judgeScript('lint', "tsc --noEmit | grep -vq 'TS18003'")).not.toBeNull()
        expect(judgeScript('lint', "tsc --noEmit | grep -v 'TS18003'")).not.toBeNull()
    })

    test('a plain `grep -q` is a real assertion on output, not laundering', () => {
        expect(judgeScript('verify', 'curl -s localhost:3000 | grep -q "<title>"')).toBeNull()
    })

    test('formatters and reporters are not laundering', () => {
        // Verbatim shape from aiz-server's real `tape` pipeline.
        expect(
            judgeScript('test', 'node ./node_modules/tape/bin/tape ./dist/**/*.js | tap-spec')
        ).toBeNull()
        expect(judgeScript('test', 'bun test | tee test.log')).toBeNull()
    })
})

describe('scope — only check-class scripts', () => {
    test('a teardown `|| true` in a non-check script is correct and common', () => {
        for (const name of ['clean', 'dev', 'start', 'copy-fonts', 'prepublishOnly', 'bump']) {
            expect(judgeScript(name, 'rm -rf dist || true')).toBeNull()
        }
    })

    test('suffixed check scripts are in scope', () => {
        for (const name of ['test:ct', 'lint:fix', 'check-types', 'test_unit', 'build:prod']) {
            expect(judgeScript(name, 'tsc --noEmit || true')).not.toBeNull()
        }
    })

    test('an empty or non-string body is not a finding', () => {
        expect(judgeScript('lint', '')).toBeNull()
        expect(judgeScript('lint', '   ')).toBeNull()
        expect(findScriptEscapes({lint: 42})).toEqual([])
    })
})

describe('zero-FP on the real corpus', () => {
    // Verbatim `scripts` from the real local repos. None may fire.
    const CORPORA: Record<string, Record<string, string>> = {
        'pi-task': {
            build: 'tsc -p tsconfig.build.json',
            lint: "prettier --log-level warn --write 'src/**/*.ts' && eslint --fix . && tsc --noEmit",
            test: 'cross-env AGENT=1 bun test --isolate src/',
            prepublishOnly: 'bun run build'
        },
        'aiz-server': {
            lint: "prettier --log-level warn --write 'src/**/*.{ts,tsx}' && eslint --fix src && npx tsc --noEmit",
            start: 'node --enable-source-maps ./dist/src/index.js',
            build: 'rm -rf ./dist && npm run codegen && npx tsc && npm run copy-fonts',
            'compile-and-run': 'npm run build || exit 1 && node ./dist/src/index.js',
            test: 'npm run build && npm run tape',
            tape: 'node ./node_modules/tape/bin/tape ./dist/test/**/*.js | tap-spec',
            'copy-fonts': 'cp -r ./src/routing/pdf/*.ttf ./dist/src/routing/pdf/'
        },
        'aiz-client': {
            dev: 'vite',
            build: 'tsc && vite build',
            bump: 'npm version patch && node versionBump.js',
            lint: "prettier --write 'src/**/*.{ts,tsx}' && eslint --fix --quiet src && tsc --noEmit",
            preview: 'vite preview'
        },
        gofer: {
            lint: "prettier --write 'src/**/*.ts' 'ingest/*.ts' && eslint --fix . && tsc --noEmit",
            test: 'bun run scripts/rerank-box.ts bun run test:evals',
            'test:evals': 'bun run eval:retrieval && bun run eval:coverage',
            'eval:coverage:lowercase': 'bun run scripts/eval-coverage.ts --lowercase'
        }
    }

    for (const [repo, scripts] of Object.entries(CORPORA)) {
        test(`${repo}: no findings`, () => {
            expect(findScriptEscapes(scripts)).toEqual([])
        })
    }
})

describe('findScriptEscapesInText — the spec-time (critique) channel', () => {
    test('extracts a dictated script from spec prose', () => {
        const spec = [
            'GOAL',
            'Set up the toolchain.',
            '',
            'Add to package.json:',
            '```json',
            '  "lint": "eslint . && tsc --noEmit || true",',
            '  "dev": "vite"',
            '```'
        ].join('\n')
        const f = findScriptEscapesInText(spec)
        expect(f).toHaveLength(1)
        expect(f[0].name).toBe('lint')
        expect(f[0].body).toBe('eslint . && tsc --noEmit || true')
    })

    test('unescapes JSON string bodies so shell operators read normally', () => {
        const f = findScriptEscapesInText('"test": "bun test 2>&1 | grep -qv \\"warn\\" || true"')
        expect(f).toHaveLength(1)
        expect(f[0].body).toContain('| grep -qv "warn"')
    })

    test('prose describing a script extracts nothing', () => {
        expect(findScriptEscapesInText('The lint script should tolerate TS18003 errors.')).toEqual(
            []
        )
    })

    test('a healthy dictated script is not a finding', () => {
        expect(findScriptEscapesInText('"lint": "eslint . && tsc --noEmit"')).toEqual([])
    })

    test('the same pair repeated is reported once', () => {
        const t = '"lint": "tsc || true"\nand again: "lint": "tsc || true"'
        expect(findScriptEscapesInText(t)).toHaveLength(1)
    })
})

describe('manifest parsing', () => {
    test('invalid JSON yields no findings rather than a guess', () => {
        expect(findScriptEscapesInManifest('{not json')).toEqual([])
        expect(findScriptEscapesInManifest('')).toEqual([])
        expect(findScriptEscapesInManifest('[]')).toEqual([])
    })

    test('a manifest with no scripts yields no findings', () => {
        expect(findScriptEscapesInManifest('{"name":"x"}')).toEqual([])
    })
})

describe('rendering', () => {
    test('verify findings name script, body, and reason', () => {
        const [line] = scriptEscapeVerifyFindings([judgeScript('lint', MX5_LINT)!])
        expect(line).toContain('`lint`')
        expect(line).toContain('grep -qv')
        expect(line).toContain('INVERTED grep')
    })

    test('defect text carries a numbered entry per finding', () => {
        const text = scriptEscapeDefectText([judgeScript('lint', 'tsc --noEmit || true')!])
        expect(text).toContain('NEUTERED CHECK SCRIPT')
        expect(text).toContain('1. "lint"')
        expect(text).toMatch(/suppress THAT diagnostic in the\s+checker's own config/)
    })

    test('empty findings render an empty verify block', () => {
        expect(scriptEscapeVerifyFindings([])).toEqual([])
    })
})
