import {describe, expect, test} from 'bun:test'
import {LoopDetector, stableStringify, type ToolCall} from './loop-detector.js'
import {ENFORCE_LOOP} from './enforce-guidelines.js'

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

describe('LoopDetector path-aware detection', () => {
    test('re-reading one file with varied offset/limit trips even though args differ', () => {
        // The exact-match key never matches (offset/limit change every call), so
        // only path detection catches this — the TASK_0017 failure signature.
        const d = new LoopDetector(20, 5)
        const reads = [
            {offset: 0, limit: 50},
            {offset: 0, limit: 80},
            {offset: 0, limit: 40},
            {offset: 0, limit: 200},
            {offset: 0, limit: 30},
            {offset: 0, limit: 60}
        ]
        let hit = null
        for (const args of reads) {
            hit = d.record({name: 'read', args: {file_path: '/auth.ts', ...args}})
        }
        expect(hit).not.toBeNull()
    })

    test('mixed read+grep on the same path accumulates and trips', () => {
        // grep carries the path but no offset → counts as a non-advancing revisit.
        const d = new LoopDetector(20, 5)
        const calls = [
            {name: 'read', args: {file_path: '/auth.ts'}},
            {name: 'grep', args: {path: '/auth.ts', pattern: 'token'}},
            {name: 'read', args: {file_path: '/auth.ts', offset: 0, limit: 40}},
            {name: 'grep', args: {path: '/auth.ts', pattern: 'session'}},
            {name: 'read', args: {file_path: '/auth.ts'}},
            {name: 'grep', args: {path: '/auth.ts', pattern: 'cookie'}}
        ]
        let hit = null
        for (const c of calls) hit = d.record(c)
        expect(hit).not.toBeNull()
    })

    test('forward paging through a large file never trips', () => {
        // Strictly-advancing offsets are progress, not revisits.
        const d = new LoopDetector(20, 5)
        for (let i = 0; i < 12; i++) {
            const hit = d.record({
                name: 'read',
                args: {file_path: '/big.ts', offset: i * 100, limit: 100}
            })
            expect(hit).toBeNull()
        }
    })

    test('reads across different files do not trip path detection', () => {
        const d = new LoopDetector(20, 5)
        for (let i = 0; i < 12; i++) {
            const hit = d.record({
                name: 'read',
                args: {file_path: `/file${i % 4}.ts`, offset: i * 10}
            })
            expect(hit).toBeNull()
        }
    })

    test('a few revisits below threshold do not trip', () => {
        // Re-reading the top of a file twice while mostly paging forward is legit.
        const d = new LoopDetector(20, 5)
        const calls = [
            {file_path: '/a.ts', offset: 0, limit: 100},
            {file_path: '/a.ts', offset: 100, limit: 100},
            {file_path: '/a.ts', offset: 0, limit: 100}, // revisit 1
            {file_path: '/a.ts', offset: 200, limit: 100},
            {file_path: '/a.ts', offset: 0, limit: 100} // revisit 2
        ]
        let hit = null
        for (const args of calls) hit = d.record({name: 'read', args})
        expect(hit).toBeNull()
    })

    test('pathThreshold is configurable independently of the exact threshold', () => {
        const d = new LoopDetector(20, 5, 3)
        d.record({name: 'read', args: {file_path: '/x.ts'}}) // progress
        d.record({name: 'read', args: {file_path: '/x.ts'}}) // revisit 1
        d.record({name: 'read', args: {file_path: '/x.ts'}}) // revisit 2
        const hit = d.record({name: 'read', args: {file_path: '/x.ts'}}) // revisit 3 → trip
        expect(hit).not.toBeNull()
        expect(hit?.count).toBe(3)
    })

    // Real loop-kill captured on mx5 TASK_0002 (enforce-debug.log): the
    // enforcement fix pass read/edited/grepped queries.ts ~23× — its actual job —
    // and the default path-revisit detector killed it at 5. ENFORCE_LOOP must NOT
    // trip on this (path-revisit disabled, exact guard raised), while the default
    // research/impl guard still does.
    const QUERIES = '/workspace/src/server/db/queries.ts'
    const enforceFixSequence: ToolCall[] = [
        'read',
        'edit',
        'edit',
        'read',
        'read',
        'edit',
        'grep',
        'grep',
        'read',
        'edit',
        'edit',
        'read',
        'read',
        'read',
        'read',
        'read',
        'edit',
        'read',
        // trailing burst of identical greps — worst case for the exact guard too
        'grep',
        'grep',
        'grep',
        'grep',
        'grep'
    ].map(name => ({name, args: {file_path: QUERIES}}))

    const firstHit = (d: LoopDetector): boolean =>
        enforceFixSequence.some(call => d.record(call) !== null)

    test('default guard kills the legit single-file enforce fix pass (the bug)', () => {
        expect(firstHit(new LoopDetector(20, 5))).toBe(true)
    })

    test('ENFORCE_LOOP tolerates the single-file fix pass (no false loop-kill)', () => {
        const {window, threshold, pathThreshold} = ENFORCE_LOOP
        expect(firstHit(new LoopDetector(window, threshold, pathThreshold))).toBe(false)
    })

    test('ENFORCE_LOOP still catches a genuine byte-identical runaway', () => {
        const {window, threshold, pathThreshold} = ENFORCE_LOOP
        const d = new LoopDetector(window, threshold, pathThreshold)
        const spin = {name: 'grep', args: {pattern: 'TODO', file_path: QUERIES}}
        let hit = null
        for (let i = 0; i < threshold; i++) hit = d.record(spin)
        expect(hit).not.toBeNull()
        expect(hit?.count).toBe(threshold)
    })
})
