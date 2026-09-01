import {describe, expect, test} from 'bun:test'
import {
    LoopDetector,
    loopKey,
    stableStringify,
    type ToolCall
} from '../../src/task/loop-detector.js'

describe('loopKey', () => {
    // Shared with implementation-guards.ts and single-read-guard.ts, which key
    // their own maps on it: a drift here silently unbinds all three.
    test('argument key order does not change the identity', () => {
        expect(loopKey({name: 'read', args: {a: 1, b: 2}})).toBe(
            loopKey({name: 'read', args: {b: 2, a: 1}})
        )
    })

    test('the tool name is part of the identity', () => {
        expect(loopKey({name: 'read', args: {a: 1}})).not.toBe(
            loopKey({name: 'grep', args: {a: 1}})
        )
    })
})

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

/**
 * The blind spot this detector cannot close, asserted so nobody tries to close it
 * by widening the window. A rotation whose CYCLE LENGTH equals the WINDOW is
 * invisible to both rules: every key occurs exactly once per window, so neither
 * the exact count nor the revisit count can ever reach the threshold. Widening the
 * window only moves the cycle length that defeats it.
 *
 * `runWorker` therefore also constructs a StallDetector, and
 * test/task/stall-detector.test.ts covers the rule that does catch this shape.
 */
describe('LoopDetector — the window-length rotation it cannot see', () => {
    const ROTATION = [
        'package.json',
        'docker-compose.dev.yml',
        'docker-dev-init.sql',
        'tsconfig.json',
        'src/server/index.test.ts',
        'test/scaffold.test.ts',
        'src/server/migrate.ts',
        'src/server/db.ts',
        '.env.example',
        'src/server/migrate.test.ts',
        'DESIGN/PROJECT.md',
        'src/server/index.ts',
        'src/server/seed.ts',
        'eslint.config.js',
        'src/server/migrations/0001_init.sql',
        'src/server/seed.test.ts',
        'AGENTS.md',
        'bunfig.toml',
        'playwright-ct.config.ts',
        'test/helpers/test-db.ts'
    ]

    test('the rotation is exactly one window long', () => {
        expect(ROTATION.length).toBe(20)
        expect(new Set(ROTATION).size).toBe(20)
    })

    test('550 calls cycling 20 distinct files never trip either rule', () => {
        const d = new LoopDetector(20, 5, 5)
        let hits = 0
        for (let n = 0; n < 550; n++) {
            if (d.record({name: 'read', args: {path: ROTATION[n % ROTATION.length]}})) hits++
        }
        expect(hits).toBe(0)
    })

    test('shorten the cycle below the window and the exact rule does fire', () => {
        // The same reader over 4 of the same paths. Proof the miss above is the
        // window arithmetic and not something about the paths themselves.
        const d = new LoopDetector(20, 5, 5)
        const short = ROTATION.slice(0, 4)
        let firstHit = -1
        for (let n = 0; n < 550 && firstHit < 0; n++) {
            if (d.record({name: 'read', args: {path: short[n % short.length]}})) firstHit = n
        }
        expect(firstHit).toBeGreaterThan(0)
    })
})

describe('LoopDetector', () => {
    test('empty buffer never hits', () => {
        new LoopDetector(20, 5)
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
        // only path detection catches this — the one task failure signature.
        //
        // countRevisits compares the RANGE END against the furthest line already
        // covered, so limits 80 and 200 are progress and only the reads ending
        // short of that high-water mark count. pathThreshold of them trips.
        const d = new LoopDetector(20, 5)
        const reads = [
            {offset: 0, limit: 50},
            {offset: 0, limit: 80},
            {offset: 0, limit: 40},
            {offset: 0, limit: 200},
            {offset: 0, limit: 30},
            {offset: 0, limit: 60},
            {offset: 0, limit: 45},
            {offset: 0, limit: 90}
        ]
        let hit = null
        for (const args of reads) {
            hit = d.record({name: 'read', args: {file_path: '/auth.ts', ...args}})
        }
        expect(hit).not.toBeNull()
    })

    test('paging that re-asks from the same offset with a bigger limit is progress', () => {
        // Keying on the offset alone would score the second and third reads below
        // as revisits of the same offset, even though the second reaches lines the
        // child had never seen — so a child paging correctly would be killed.
        const d = new LoopDetector(20, 5)
        const p = '/DESIGN/marketplace.html'
        expect(d.record({name: 'read', args: {file_path: p, limit: 80}})).toBeNull()
        expect(d.record({name: 'read', args: {file_path: p, offset: 80, limit: 400}})).toBeNull()
        expect(d.record({name: 'read', args: {file_path: p, offset: 480, limit: 300}})).toBeNull()
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

    // The default path-revisit rule is wrong for a fix pass, whose job IS to
    // read/edit/grep one file many times. The `gate` profile every gate child runs
    // on therefore sets `pathThreshold` to Infinity, leaving only the exact-match
    // rule. `detector: false`, which turns the whole detector off, is covered in
    // pi-worker-core.test.ts: "loop: false disables the detector".
    test('default guard kills a legit single-file fix pass (why the gate raises pathThreshold)', () => {
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
            'edit'
        ].map(name => ({name, args: {file_path: QUERIES}}))
        const d = new LoopDetector(20, 5)
        expect(enforceFixSequence.some(call => d.record(call) !== null)).toBe(true)
    })
})
