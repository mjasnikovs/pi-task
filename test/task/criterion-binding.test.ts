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
    missingDeclaredTests,
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
