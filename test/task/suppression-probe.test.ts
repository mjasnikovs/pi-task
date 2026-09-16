import {describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
    compileSuppressionPatterns,
    findSuppressionWidening,
    suppressionPatternsFor,
    suppressionVerifyFindings,
    SUPPRESSION_PATTERNS
} from '../../src/task/suppression-probe.js'
import {parseDiffLines} from '../../src/task/gate-deps.js'

const fixture = (name: string): string =>
    fs.readFileSync(path.join(import.meta.dir, '__fixtures__', name), 'utf8')

const hitsIn = (diff: string, ecosystems: Parameters<typeof suppressionPatternsFor>[0]): number =>
    findSuppressionWidening(parseDiffLines(diff), suppressionPatternsFor(ecosystems)).reduce(
        (n, h) => n + h.net,
        0
    )

describe('the TASK_0034 diff — the run that shipped suppressions and passed every gate', () => {
    const diff = fixture('mx5-0034-api.diff')

    test('the sixteen the post-mortem counted, plus the blanket disable above them', () => {
        expect(hitsIn(diff, ['npm'])).toBe(17)
    })

    test('the blanket disable and the per-line errors are reported separately', () => {
        const hits = findSuppressionWidening(parseDiffLines(diff), suppressionPatternsFor(['npm']))
        expect(hits.map(h => [h.patternId, h.net])).toEqual([
            ['eslint-disable', 1],
            ['@ts-expect-error', 16]
        ])
        expect(hits.every(h => h.path === 'src/client/api.ts')).toBe(true)
        expect(suppressionVerifyFindings(hits)[0]).toBe(
            'src/client/api.ts — 1 net-new `eslint-disable` line added by this task'
        )
    })

    test('a Go project is not scanned for TypeScript suppressions', () => {
        expect(hitsIn(diff, ['go'])).toBe(0)
    })
})

describe('other ecosystems', () => {
    test('one //nolint in a Go diff', () => {
        expect(hitsIn(fixture('go-nolint.diff'), ['go'])).toBe(1)
    })

    test('one # noqa in a Python diff', () => {
        // `# noqa` carries no ecosystem row, so an empty detection still finds it —
        // a Python repo is not one of the four the docs roster knows.
        expect(hitsIn(fixture('python-noqa.diff'), [])).toBe(1)
    })
})

describe('net, not absolute', () => {
    const lines = (spec: Array<[string, boolean]>): Parameters<typeof findSuppressionWidening>[0] =>
        spec.map(([text, added]) => ({path: 'src/a.ts', text, added}))

    test('a refactor that removes more than it adds is silent', () => {
        expect(
            findSuppressionWidening(
                lines([
                    ['// @ts-ignore', false],
                    ['// @ts-ignore', false],
                    ['// @ts-ignore', true]
                ])
            )
        ).toEqual([])
    })

    test('a one-for-one move is silent', () => {
        expect(
            findSuppressionWidening(
                lines([
                    ['// @ts-ignore', true],
                    ['// @ts-ignore', false]
                ])
            )
        ).toEqual([])
    })

    test('a net gain is a finding', () => {
        expect(
            findSuppressionWidening(
                lines([
                    ['// @ts-ignore', true],
                    ['// @ts-ignore', true],
                    ['// @ts-ignore', false]
                ])
            )
        ).toEqual([{path: 'src/a.ts', patternId: '@ts-ignore', net: 1}])
    })
})

describe('the registry', () => {
    test('every shipped id is distinct', () => {
        const ids = SUPPRESSION_PATTERNS.map(p => p.id)
        expect(new Set(ids).size).toBe(ids.length)
    })

    test('a configured pattern joins the scan', () => {
        const extra = compileSuppressionPatterns(['SAFETY-OVERRIDE'])
        expect(
            findSuppressionWidening(
                [{path: 'a.rb', text: '# SAFETY-OVERRIDE: legacy', added: true}],
                suppressionPatternsFor(['npm'], extra)
            )
        ).toEqual([{path: 'a.rb', patternId: 'SAFETY-OVERRIDE', net: 1}])
    })

    test('an uncompilable configured pattern is dropped, not thrown', () => {
        expect(compileSuppressionPatterns(['(unclosed', 'ok'])).toHaveLength(1)
    })
})

describe('parseDiffLines', () => {
    test("a file's own +++ header is not an added line", () => {
        expect(
            parseDiffLines(
                [
                    'diff --git a/x.ts b/x.ts',
                    '--- a/x.ts',
                    '+++ b/x.ts',
                    '@@ -1 +1,2 @@',
                    ' keep',
                    '+added',
                    '-gone'
                ].join('\n')
            )
        ).toEqual([
            {path: 'x.ts', text: 'added', added: true},
            {path: 'x.ts', text: 'gone', added: false}
        ])
    })
})
