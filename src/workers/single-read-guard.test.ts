import {describe, expect, test} from 'bun:test'
import {SingleReadGuard, singleReadReason} from './single-read-guard.js'

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
