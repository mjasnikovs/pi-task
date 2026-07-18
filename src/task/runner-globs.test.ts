import {describe, expect, test} from 'bun:test'
import {
    assessRunnerGlobs,
    parsePathIgnorePatterns,
    parseTestDir,
    parseTestMatch,
    runnerGlobContractLine,
    runnerGlobVerifyFindings
} from './runner-globs.js'

/** The mx5 run-13 scripts, verbatim (the shape that collided in runs 7 AND 13). */
const MX5_SCRIPTS = {
    lint: 'prettier --write . && eslint --fix .',
    test: 'AGENT=1 bun test',
    'test:ct': 'bunx playwright test --config=playwright-ct.config.ts',
    dev: 'bun run --watch src/server/index.ts',
    build: 'bun build.ts'
}

/** mx5's playwright-ct.config.ts, reduced to the fields the assessor reads. */
const MX5_PW_CONFIG = `
export default defineConfig({
  testDir: './src/client/pages',
  use: {ctPort: 3100},
})
`

/** bunfig.toml as it stood at HEAD when run 13 ended — no exclusion. */
const MX5_BUNFIG_HEAD = '[test]\nenvFile = ".env.test"\n'
/** bunfig.toml as the stranded (uncommitted) fix left it. */
const MX5_BUNFIG_FIXED =
    '[test]\nenvFile = ".env.test"\npathIgnorePatterns = ["**/*.spec.*", "src/client/**/*.test.*"]\n'

describe('the mx5 run-13 collision', () => {
    test('flags the collision at HEAD, where `bun run test` was broken', () => {
        const a = assessRunnerGlobs({
            scripts: MX5_SCRIPTS,
            bunfig: MX5_BUNFIG_HEAD,
            playwrightConfig: MX5_PW_CONFIG
        })
        expect(a.status).toBe('collision')
        expect(a.scanningScripts).toEqual(['test'])
        expect(a.otherScripts).toEqual(['test:ct'])
        expect(a.detail).toContain('testDir: src/client/pages')
        expect(a.detail).toContain('pathIgnorePatterns')
    })

    test('accepts the tree once the stranded bunfig fix is applied', () => {
        const a = assessRunnerGlobs({
            scripts: MX5_SCRIPTS,
            bunfig: MX5_BUNFIG_FIXED,
            playwrightConfig: MX5_PW_CONFIG
        })
        expect(a.status).toBe('disjoint')
        expect(a.detail).toContain('excludes the playwright spec files')
    })
})

describe('the two accepted forms of disjointness', () => {
    test('EXCLUSION — bunfig ignores the specs by suffix', () => {
        for (const patterns of ['["**/*.spec.*"]', '[\n  "**/*.spec.ts",\n  "**/*.spec.tsx"\n]']) {
            const a = assessRunnerGlobs({
                scripts: MX5_SCRIPTS,
                bunfig: `[test]\npathIgnorePatterns = ${patterns}\n`,
                playwrightConfig: MX5_PW_CONFIG
            })
            expect(a.status).toBe('disjoint')
        }
    })

    test('EXCLUSION — bunfig ignores the playwright testDir by path', () => {
        const a = assessRunnerGlobs({
            scripts: MX5_SCRIPTS,
            bunfig: '[test]\npathIgnorePatterns = ["e2e/**"]\n',
            playwrightConfig: "export default {testDir: './e2e'}"
        })
        expect(a.status).toBe('disjoint')
    })

    test('an exclusion that misses the actual testDir is NOT disjointness', () => {
        // `e2e/**` excludes nothing when the specs live in src/client/pages.
        const a = assessRunnerGlobs({
            scripts: MX5_SCRIPTS,
            bunfig: '[test]\npathIgnorePatterns = ["e2e/**"]\n',
            playwrightConfig: MX5_PW_CONFIG
        })
        expect(a.status).toBe('collision')
    })

    test('NAMING — playwright testMatch uses a suffix bun does not claim', () => {
        const a = assessRunnerGlobs({
            scripts: MX5_SCRIPTS,
            bunfig: MX5_BUNFIG_HEAD,
            playwrightConfig: "export default {testMatch: '**/*.e2e.ts'}"
        })
        expect(a.status).toBe('disjoint')
        expect(a.detail).toContain('outside bun test')
    })

    test('a testMatch that still claims *.spec.* is NOT disjointness', () => {
        const a = assessRunnerGlobs({
            scripts: MX5_SCRIPTS,
            bunfig: MX5_BUNFIG_HEAD,
            playwrightConfig: "export default {testMatch: '**/*.spec.ts'}"
        })
        expect(a.status).toBe('collision')
    })
})

describe('unknown steps aside', () => {
    test('one runner only — nothing can collide', () => {
        expect(
            assessRunnerGlobs({
                scripts: {test: 'bun test'},
                bunfig: null,
                playwrightConfig: null
            }).status
        ).toBe('unknown')
        expect(
            assessRunnerGlobs({
                scripts: {'test:e2e': 'playwright test'},
                bunfig: null,
                playwrightConfig: null
            }).status
        ).toBe('unknown')
    })

    test('no runners at all', () => {
        expect(
            assessRunnerGlobs({scripts: {build: 'tsc'}, bunfig: null, playwrightConfig: null})
                .status
        ).toBe('unknown')
    })

    test('a missing bunfig with both runners declared is still a collision', () => {
        // No bunfig means no exclusion — bun's default scan is in force.
        const a = assessRunnerGlobs({
            scripts: MX5_SCRIPTS,
            bunfig: null,
            playwrightConfig: MX5_PW_CONFIG
        })
        expect(a.status).toBe('collision')
    })
})

describe('runner detection', () => {
    test('recognises the real invocation forms', () => {
        const a = assessRunnerGlobs({
            scripts: {
                test: 'cross-env AGENT=1 bun test --isolate src/',
                'test:ct': 'bunx playwright test --config=x.ts',
                'test:e2e': 'npx playwright test',
                lint: 'eslint .'
            },
            bunfig: null,
            playwrightConfig: null
        })
        expect(a.scanningScripts).toEqual(['test'])
        expect(a.otherScripts).toEqual(['test:ct', 'test:e2e'])
    })

    test('does not mistake `bun run test` (a delegation) for the bun runner', () => {
        const a = assessRunnerGlobs({
            scripts: {ci: 'bun run test && bun run lint'},
            bunfig: null,
            playwrightConfig: null
        })
        expect(a.scanningScripts).toEqual([])
    })
})

describe('config parsing', () => {
    test('parsePathIgnorePatterns distinguishes absent from empty', () => {
        expect(parsePathIgnorePatterns(null)).toBeNull()
        expect(parsePathIgnorePatterns('[test]\nenvFile = ".env"')).toBeNull()
        expect(parsePathIgnorePatterns('pathIgnorePatterns = []')).toEqual([])
        expect(parsePathIgnorePatterns('pathIgnorePatterns = ["a", "b"]')).toEqual(['a', 'b'])
    })

    test('parseTestDir normalises the leading ./ and trailing /', () => {
        expect(parseTestDir("testDir: './src/client/pages'")).toBe('src/client/pages')
        expect(parseTestDir('testDir: "e2e/"')).toBe('e2e')
        expect(parseTestDir(null)).toBeNull()
        expect(parseTestDir('no test dir here')).toBeNull()
    })

    test('parseTestMatch handles string and array forms', () => {
        expect(parseTestMatch("testMatch: '**/*.e2e.ts'")).toEqual(['**/*.e2e.ts'])
        expect(parseTestMatch('testMatch: ["a.e2e.ts", "b.e2e.ts"]')).toEqual([
            'a.e2e.ts',
            'b.e2e.ts'
        ])
        expect(parseTestMatch('no match key')).toBeNull()
    })
})

describe('rendering', () => {
    test('verify findings appear only for a collision', () => {
        const collision = assessRunnerGlobs({
            scripts: MX5_SCRIPTS,
            bunfig: MX5_BUNFIG_HEAD,
            playwrightConfig: MX5_PW_CONFIG
        })
        expect(runnerGlobVerifyFindings(collision)).toHaveLength(1)
        const fixed = assessRunnerGlobs({
            scripts: MX5_SCRIPTS,
            bunfig: MX5_BUNFIG_FIXED,
            playwrightConfig: MX5_PW_CONFIG
        })
        expect(runnerGlobVerifyFindings(fixed)).toEqual([])
    })

    test('the contract line states the invariant whenever both runners exist', () => {
        // Recorded even when currently disjoint — the invariant is what later
        // slices must preserve, not a report of today's state.
        const fixed = assessRunnerGlobs({
            scripts: MX5_SCRIPTS,
            bunfig: MX5_BUNFIG_FIXED,
            playwrightConfig: MX5_PW_CONFIG
        })
        expect(runnerGlobContractLine(fixed)).toContain('MUST be disjoint')
        expect(runnerGlobContractLine(fixed)).toContain('pathIgnorePatterns')
        // ...and not at all when only one runner is declared.
        const single = assessRunnerGlobs({
            scripts: {test: 'bun test'},
            bunfig: null,
            playwrightConfig: null
        })
        expect(runnerGlobContractLine(single)).toBe('')
    })
})
