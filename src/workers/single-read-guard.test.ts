import {describe, expect, test} from 'bun:test'
import {
    RepeatedCallGuard,
    SingleReadGuard,
    repeatedCallReason,
    singleReadReason
} from './single-read-guard.js'

describe('SingleReadGuard', () => {
    test('first read of a path is allowed', () => {
        const g = new SingleReadGuard()
        expect(g.check('/a.ts')).toBeNull()
    })

    test('second read of the same path is blocked with a reason', () => {
        const g = new SingleReadGuard()
        g.check('/a.ts')
        const r = g.check('/a.ts')
        expect(r?.block).toBe(true)
        expect(r?.reason).toContain('/a.ts')
    })

    test('every read after the first is blocked', () => {
        const g = new SingleReadGuard()
        g.check('/a.ts')
        expect(g.check('/a.ts')).not.toBeNull()
        expect(g.check('/a.ts')).not.toBeNull()
    })

    test('different paths are each allowed once', () => {
        const g = new SingleReadGuard()
        expect(g.check('/a.ts')).toBeNull()
        expect(g.check('/b.ts')).toBeNull()
        expect(g.check('/c.ts')).toBeNull()
    })

    test('block only affects the repeated path, not other files', () => {
        const g = new SingleReadGuard()
        g.check('/a.ts')
        expect(g.check('/a.ts')).not.toBeNull() // repeat blocked
        expect(g.check('/b.ts')).toBeNull() // first read of a different file still ok
    })

    test('reason names the blocked path and tells the model to answer', () => {
        const msg = singleReadReason('/workspace/package.json')
        expect(msg).toContain('/workspace/package.json')
        expect(msg.toLowerCase()).toContain('write your final answer')
    })
})

describe('RepeatedCallGuard', () => {
    test('first call with given args is allowed', () => {
        const g = new RepeatedCallGuard()
        expect(g.check('grep', {pattern: 'foo', path: '/a.ts'})).toBeNull()
    })

    test('identical repeat is blocked with a reason naming the tool', () => {
        const g = new RepeatedCallGuard()
        g.check('grep', {pattern: 'foo', path: '/a.ts'})
        const r = g.check('grep', {pattern: 'foo', path: '/a.ts'})
        expect(r?.block).toBe(true)
        expect(r?.reason).toContain('grep')
    })

    test('TASK_0017 regression: same brace-count grep ×5 trips after the first', () => {
        const g = new RepeatedCallGuard()
        const args = {pattern: '^\\s*}', path: '/workspace/src/types/index.ts', context: 0}
        let blocked = 0
        for (let i = 0; i < 5; i++) if (g.check('grep', args)) blocked++
        expect(blocked).toBe(4) // first allowed, the next four denied in-run
    })

    test('argument key-order does not cause a miss', () => {
        const g = new RepeatedCallGuard()
        expect(g.check('grep', {pattern: 'foo', path: '/a.ts'})).toBeNull()
        expect(g.check('grep', {path: '/a.ts', pattern: 'foo'})).not.toBeNull()
    })

    test('a different pattern on the same file is allowed', () => {
        const g = new RepeatedCallGuard()
        expect(g.check('grep', {pattern: 'foo', path: '/a.ts'})).toBeNull()
        expect(g.check('grep', {pattern: 'bar', path: '/a.ts'})).toBeNull()
    })

    test('same args under a different tool name are tracked separately', () => {
        const g = new RepeatedCallGuard()
        expect(g.check('grep', {path: '/a.ts'})).toBeNull()
        expect(g.check('find', {path: '/a.ts'})).toBeNull()
    })

    test('reason names the tool and points the model forward', () => {
        const msg = repeatedCallReason('grep')
        expect(msg).toContain('grep')
        expect(msg.toLowerCase()).toContain('write your final answer')
    })
})
