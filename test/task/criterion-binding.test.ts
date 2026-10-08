/**
 * criterion-binding — every ACCEPTANCE bullet names, at spec time, what will
 * observe it. mx5-n 0.42.47 TASK_0039: "guarded routes show a loading state —
 * never a premature redirect" had no test, the verifier passed it, and the
 * sign-in bounce it allowed reached the final gate 13 tasks later.
 */
import {describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {tmpDir} from '../test-utils/tmp-dir.js'
import {
    bindingOf,
    declaredTestsOfReason,
    missingDeclaredTests,
    missingTestsReason,
    unboundAcceptance
} from '../../src/task/criterion-binding.js'

const spec = (...acceptance: string[]): string =>
    [
        'GOAL',
        'x',
        '',
        'CONSTRAINTS',
        '- none',
        '',
        'ACCEPTANCE',
        ...acceptance.map(a => `- ${a}`),
        '',
        'VERIFY:',
        '```sh',
        'bun test',
        '```'
    ].join('\n')

describe('bindingOf', () => {
    test('reads the three tags', () => {
        expect(
            bindingOf(
                'guards wait for the session [test: ct/main.spec.tsx "waits for the session"]'
            )
        ).toEqual({
            kind: 'test',
            path: 'ct/main.spec.tsx',
            title: 'waits for the session'
        })
        expect(bindingOf('the bundle builds [cmd: bun run build]')).toEqual({
            kind: 'cmd',
            command: 'bun run build'
        })
        expect(bindingOf('`src/client/api.ts` exports `client` [static]')).toEqual({kind: 'static'})
    })

    test('a bullet with no tag, or a malformed one, is unbound', () => {
        expect(bindingOf('it works')).toBeNull()
        expect(bindingOf('it works [test: ct/x.spec.tsx]')).toBeNull()
        expect(bindingOf('it works [from: spec]')).toBeNull()
    })

    test('a tag on a wrapped continuation line still binds the bullet', () => {
        expect(bindingOf('guards wait\nfor the session [test: ct/a.spec.tsx "waits"]')?.kind).toBe(
            'test'
        )
    })
})

test('unboundAcceptance lists the bullets with no tag', () => {
    const s = spec(
        'it builds [cmd: bun run build]',
        'guards never redirect early',
        'a file exists [static]'
    )
    expect(unboundAcceptance(s)).toEqual(['guards never redirect early'])
})

describe('missingDeclaredTests', () => {
    const repo = (): string => {
        const dir = tmpDir('criterion-binding-')
        fs.mkdirSync(path.join(dir, 'ct'))
        fs.writeFileSync(
            path.join(dir, 'ct', 'main.spec.tsx'),
            "test('guarded route waits for the in-flight session', async () => {})\n"
        )
        return dir
    }

    test('a declared test that exists under its exact title is bound', () => {
        const s = spec(
            'guards wait [test: ct/main.spec.tsx "guarded route waits for the in-flight session"]'
        )
        expect(missingDeclaredTests(s, repo())).toEqual([])
    })

    test('a missing file and a missing title are each reported', () => {
        const dir = repo()
        const s = spec(
            'guards wait [test: ct/guards.spec.tsx "waits"]',
            'redirects after load [test: ct/main.spec.tsx "redirects only after /me settles"]'
        )
        expect(missingDeclaredTests(s, dir).map(m => [m.path, m.title, m.why])).toEqual([
            ['ct/guards.spec.tsx', 'waits', 'no file'],
            ['ct/main.spec.tsx', 'redirects only after /me settles', 'no title']
        ])
    })

    test('a path outside the project never counts as the test', () => {
        const s = spec('x [test: ../outside.spec.ts "x"]')
        expect(missingDeclaredTests(s, repo()).map(m => m.why)).toEqual(['no file'])
    })

    test('cmd and static bindings, and untagged bullets, ask nothing of the tree', () => {
        const s = spec('it builds [cmd: bun run build]', 'exists [static]', 'untagged')
        expect(missingDeclaredTests(s, repo())).toEqual([])
    })
})

// Shapes compose writes and source spells that a literal match missed: a quoted
// path, a path with a space, and a title whose apostrophe the source escapes.
// Each read as "no test" forever, and the task spent its autofix budget on it.
describe('declared tests as written in real specs', () => {
    test('a backticked path, with or without spaces, is the path', () => {
        expect(bindingOf('x [test: `ct/a.spec.tsx` "t"]')).toEqual({
            kind: 'test',
            path: 'ct/a.spec.tsx',
            title: 't'
        })
        expect(bindingOf('x [test: `ct/my dir/a.spec.tsx` "t"]')).toEqual({
            kind: 'test',
            path: 'ct/my dir/a.spec.tsx',
            title: 't'
        })
    })

    test("a title with an apostrophe matches the source's escaped spelling", () => {
        const dir = tmpDir('criterion-binding-')
        fs.mkdirSync(path.join(dir, 'test'))
        fs.writeFileSync(
            path.join(dir, 'test', 'b.test.ts'),
            "test('a banned seller\\'s listings are hidden', () => {})\n"
        )
        const s = spec('hidden [test: test/b.test.ts "a banned seller\'s listings are hidden"]')
        expect(missingDeclaredTests(s, dir)).toEqual([])
    })
})

// The reason a missing test mints is the one the debt re-check reads back.
test('a missing-test reason names every test, and reads back', () => {
    const reason = missingTestsReason([
        {bullet: 'b', path: 'ct/a.spec.tsx', title: 'waits', why: 'no file'},
        {bullet: 'c', path: 'test/b.test.ts', title: 'redirects', why: 'no title'}
    ])
    expect(declaredTestsOfReason(`acceptance untested: ${reason}`)).toEqual([
        {path: 'ct/a.spec.tsx', title: 'waits'},
        {path: 'test/b.test.ts', title: 'redirects'}
    ])
})
