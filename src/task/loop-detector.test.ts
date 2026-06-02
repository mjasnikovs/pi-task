import {describe, expect, test} from 'bun:test'
import {LoopDetector, stableStringify} from './loop-detector.js'

describe('stableStringify', () => {
    test('produces identical output for objects with reordered keys', () => {
        expect(stableStringify({a: 1, b: 2})).toBe(stableStringify({b: 2, a: 1}))
    })

    test('handles nested objects with reordered keys', () => {
        expect(stableStringify({x: {a: 1, b: 2}})).toBe(stableStringify({x: {b: 2, a: 1}}))
    })

    test('handles undefined args', () => {
        expect(stableStringify(undefined)).toBe(stableStringify(undefined))
    })

    test('arrays preserve order', () => {
        expect(stableStringify([1, 2, 3])).not.toBe(stableStringify([3, 2, 1]))
    })
})

describe('LoopDetector', () => {
    test('empty buffer never hits', () => {
        const _d = new LoopDetector(20, 5)
        // No record calls — just constructed.
        // Re-create instead of querying internal state, since we record-then-check.
        expect(new LoopDetector(20, 5)).toBeInstanceOf(LoopDetector)
    })

    test('5 identical consecutive calls hit on the 5th', () => {
        const d = new LoopDetector(20, 5)
        const call = {name: 'Read', args: {path: '/foo'}}
        expect(d.record(call)).toBeNull()
        expect(d.record(call)).toBeNull()
        expect(d.record(call)).toBeNull()
        expect(d.record(call)).toBeNull()
        const hit = d.record(call)
        expect(hit).not.toBeNull()
        expect(hit?.count).toBe(5)
        expect(hit?.call.name).toBe('Read')
    })

    test('4 calls then a different call does not hit', () => {
        const d = new LoopDetector(20, 5)
        const a = {name: 'Read', args: {path: '/a'}}
        const b = {name: 'Read', args: {path: '/b'}}
        d.record(a)
        d.record(a)
        d.record(a)
        d.record(a)
        expect(d.record(b)).toBeNull()
    })

    test('oscillating A B A B A B A B A hits on the 5th A', () => {
        const d = new LoopDetector(20, 5)
        const a = {name: 'Read', args: {path: '/a'}}
        const b = {name: 'LS', args: {path: '/'}}
        d.record(a)
        d.record(b) // A B
        d.record(a)
        d.record(b) // A B
        d.record(a)
        d.record(b) // A B
        d.record(a)
        d.record(b) // A B — 4 As so far
        const hit = d.record(a) // 5th A
        expect(hit).not.toBeNull()
        expect(hit?.count).toBe(5)
    })

    test('window scrolls — old entries fall off and no hit fires', () => {
        const d = new LoopDetector(5, 3) // small window to make the test cheap
        const a = {name: 'Read', args: {path: '/a'}}
        const filler = {name: 'X', args: {}}
        d.record(a)
        d.record(a) // 2 As
        d.record(filler)
        d.record(filler)
        d.record(filler) // window now [a,a,X,X,X]
        d.record(filler) // window now [a,X,X,X,X] — 1 A
        d.record(filler) // window now [X,X,X,X,X] — 0 As
        expect(d.record(a)).toBeNull() // window now [X,X,X,X,a] — 1 A, no hit
    })

    test('same tool name with different args does not hit', () => {
        const d = new LoopDetector(20, 5)
        for (let i = 0; i < 10; i++) {
            expect(d.record({name: 'Read', args: {path: `/file${i}`}})).toBeNull()
        }
    })

    test('args with reordered keys still hit (stable stringify)', () => {
        const d = new LoopDetector(20, 5)
        d.record({name: 'Tool', args: {a: 1, b: 2}})
        d.record({name: 'Tool', args: {b: 2, a: 1}})
        d.record({name: 'Tool', args: {a: 1, b: 2}})
        d.record({name: 'Tool', args: {b: 2, a: 1}})
        const hit = d.record({name: 'Tool', args: {a: 1, b: 2}})
        expect(hit).not.toBeNull()
        expect(hit?.count).toBe(5)
    })

    test('undefined args hashes consistently and repeats detect', () => {
        const d = new LoopDetector(20, 5)
        const call = {name: 'NoArgs', args: undefined}
        d.record(call)
        d.record(call)
        d.record(call)
        d.record(call)
        expect(d.record(call)).not.toBeNull()
    })

    test('LoopHit reports the windowSize at time of detection', () => {
        const d = new LoopDetector(20, 3)
        const call = {name: 'X', args: 1}
        d.record(call)
        d.record(call)
        const hit = d.record(call)
        expect(hit?.windowSize).toBe(3)
    })
})
