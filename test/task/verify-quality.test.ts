import {describe, expect, test} from 'bun:test'
import {
    findGrepOnlyVerify,
    grepOnlyVerifyDefectText,
    GREP_THEATER_RETRY_HINT
} from '../../src/task/verify-quality.js'

const spec = (cmds: string[]): string =>
    ['GOAL', 'Create build.ts.', '', 'VERIFY:', '```bash', ...cmds, '```'].join('\n')

/** A VERIFY block that typechecks and greps the build script, but never runs it. */
const MX5_VERIFY = spec([
    'bunx tsc --noEmit',
    "grep -q 'Bun\\.mkdirSync.*dist.*recursive' build.ts",
    "grep -q 'Bun\\.build' build.ts",
    "grep -q 'outdir.*dist' build.ts"
])

describe('findGrepOnlyVerify', () => {
    test('fires on the real run-13 shape: all-static block grep-asserting a build script', () => {
        const findings = findGrepOnlyVerify(MX5_VERIFY)
        expect(findings).toHaveLength(1)
        expect(findings[0].target).toBe('build.ts')
        expect(findings[0].lines).toHaveLength(3)
    })

    test('steps aside when any command executes something', () => {
        const s = spec(["grep -q 'Bun\\.build' build.ts", 'bun build.ts', 'test -f dist/main.js'])
        expect(findGrepOnlyVerify(s)).toEqual([])
    })

    test('bun run / bun test / node / curl count as execution', () => {
        for (const exec of ['bun run build', 'bun test', 'node build.js', 'curl -sf http://x']) {
            expect(findGrepOnlyVerify(spec(['grep -q x build.ts', exec]))).toEqual([])
        }
    })

    test('bunx tsc / bunx eslint stay static (they do not run the deliverable)', () => {
        const s = spec(['bunx tsc --noEmit', 'bunx eslint .', 'grep -q export src/server.ts'])
        expect(findGrepOnlyVerify(s)).toHaveLength(1)
    })

    test('does not fire when no runnable source is inspected (docs/config task)', () => {
        const s = spec(["grep -q 'Usage' README.md", 'test -f docs/setup.md', 'bunx tsc --noEmit'])
        expect(findGrepOnlyVerify(s)).toEqual([])
    })

    test('does not fire without a VERIFY block', () => {
        expect(findGrepOnlyVerify('GOAL\nDo a thing.')).toEqual([])
    })

    test('quoted pattern tokens ending in an extension are not targets', () => {
        const s = spec(["grep -q 'main.js' README.md", 'bunx tsc --noEmit'])
        expect(findGrepOnlyVerify(s)).toEqual([])
    })

    test('pipeline segments are classified individually', () => {
        // cat source | grep — still pure inspection ⇒ fires
        const s = spec(["cat build.ts | grep -q 'Bun.build'"])
        expect(findGrepOnlyVerify(s)).toHaveLength(1)
        // grep joined by `&&` to an executing segment ⇒ steps aside
        const s2 = spec(['grep -q x build.ts && bun build.ts'])
        expect(findGrepOnlyVerify(s2)).toEqual([])
    })

    test('shell-control shapes (if/then/fi, `{ echo; exit 1; }`) are not execution', () => {
        // Greps wrapped in OK/FAIL guards, and one inside an if/then/fi.
        const s = spec([
            'tsc --noEmit',
            'grep -q \'import\\.meta\\.main\' build.ts && echo "OK" || { echo "FAIL"; exit 1; }',
            'if grep -q \'"bunx"\' build.ts; then',
            '  exit 1',
            'fi',
            'echo "OK: no bunx"'
        ])
        const findings = findGrepOnlyVerify(s)
        expect(findings).toHaveLength(1)
        expect(findings[0].target).toBe('build.ts')
    })

    test('env-var prefixes and timeout are skipped when resolving the head', () => {
        const s = spec(['NODE_ENV=production timeout 60 bun run build', 'grep -q x build.ts'])
        expect(findGrepOnlyVerify(s)).toEqual([])
    })
})

describe('GREP_THEATER_RETRY_HINT', () => {
    test('is a SYSTEM NOTE demanding execution with an observable outcome', () => {
        expect(GREP_THEATER_RETRY_HINT).toStartWith('[SYSTEM NOTE:')
        expect(GREP_THEATER_RETRY_HINT).toContain('execute the')
        expect(GREP_THEATER_RETRY_HINT).toContain('observable outcome')
    })
})

describe('grepOnlyVerifyDefectText', () => {
    test('names the inspected file and demands execution with an observable outcome', () => {
        const text = grepOnlyVerifyDefectText(findGrepOnlyVerify(MX5_VERIFY))
        expect(text).toContain('build.ts')
        expect(text).toContain('EXECUTES')
        expect(text).toContain('OBSERVABLE OUTCOME')
    })
})
