import {describe, expect, test} from 'bun:test'
import {LoopDetector, stableStringify, type ToolCall} from '../../src/task/loop-detector.js'

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
 * The mx5-n 2026-08-27 shape, and the reason StallDetector had to be wired into
 * runWorker: a rotation whose CYCLE LENGTH equals the detector's WINDOW is
 * invisible to both rules, because every key occurs exactly once per window and
 * neither count can ever reach the threshold.
 *
 * Observed: worker:tooling made 550 tool calls over 20 distinct files, ~36 reads
 * each, read -> answer -> read -> answer, for 20 minutes. Neither the exact rule
 * nor the path rule fired. It died on the absolute progress ceiling having done
 * 25s of useful work. This test is the blind spot, asserted, so nobody "fixes"
 * it by widening the window — a wider window just moves the cycle that defeats
 * it. See stall-detector.test.ts for the guard that does catch it.
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
        // The same reader, 19 files instead of 20. Proof the miss above is the
        // window arithmetic and not something about the paths.
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
        // only path detection catches this — the TASK_0017 failure signature.
        //
        // Counted on the RANGE: a bigger limit from the same offset does reach
        // lines the child had not seen, so 80 and 200 are progress and only the
        // reads that end short of the furthest line already covered are revisits.
        // Five of those are needed to trip.
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
        // Measured on a real decompose run: {limit:80}, then {offset:80,
        // limit:400}, then {offset:80, limit:300}. The first two reach 320 lines
        // the child had never seen. Scoring them as revisits (offset alone did)
        // killed a child that was paging correctly through a 743-line file.
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

    // Why the /task-auto enforcement child runs UNGUARDED (loop: false). Real
    // loop-kill captured on mx5 TASK_0002 (enforce-debug.log): the fix pass
    // read/edited/grepped queries.ts ~23× — its actual job — and the default
    // path-revisit detector killed it at 5. This documents that the default guard
    // is wrong for a single-file fix pass; the enforce path disables it entirely
    // (covered in pi-worker-core.test.ts: "loop: false disables the detector").
    test('default guard kills a legit single-file fix pass (why enforce runs unguarded)', () => {
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
