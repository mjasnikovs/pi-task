import {describe, expect, test} from 'bun:test'
import {
    CONTEXT_CHURN_FACTOR,
    NO_PROGRESS_LIMIT,
    StallDetector,
    formatStallHint
} from '../../src/task/stall-detector.js'

const read = (path: string, offset?: number) => ({
    name: 'read',
    args: offset === undefined ? {path} : {path, offset}
})

describe('StallDetector — no-new-ground rule', () => {
    test('forward paging through one big file never trips, however many pages', () => {
        const d = new StallDetector()
        // The shape this must not kill: a file too big to read whole, paged
        // forward. Every page returns bytes the child has not seen.
        for (let n = 0; n < 200; n++) {
            expect(d.record(read('DESIGN/marketplace.html', n * 100 + 1))).toBeNull()
            d.noteResult(`page ${n}`)
        }
    })

    test('re-reading files that return what it already has trips at the limit', () => {
        const d = new StallDetector()
        d.record(read('a.md'))
        d.noteResult('contents of a')
        d.record(read('b.md'))
        d.noteResult('contents of b')
        let hit = null
        // One more than the limit: a call is judged on the results BEFORE it, so
        // the streak is always one behind the number of dead results.
        for (let n = 0; n <= NO_PROGRESS_LIMIT; n++) {
            const p = n % 2 === 0 ? 'a.md' : 'b.md'
            hit = d.record(read(p, n)) // varied args, so the exact key differs
            d.noteResult(n % 2 === 0 ? 'contents of a' : 'contents of b')
        }
        expect(hit).not.toBeNull()
        expect(hit!.stall).toBe('no-new-ground')
    })

    test('a refused read is dead ground however the offset varies', () => {
        // A guard that refuses the read returns the SAME text at every offset.
        // By arguments this is textbook forward paging; noteResult sees one
        // identical refusal after another.
        const d = new StallDetector()
        const refusal =
            'You already read a.md earlier in this run — its contents are in your context.'
        let hit = null
        for (let n = 1; n <= NO_PROGRESS_LIMIT + 2; n++) {
            hit = d.record(read('a.md', n * 40))
            d.noteResult(refusal)
        }
        expect(hit?.stall).toBe('no-new-ground')
    })

    test('an error result is dead ground even when its text is new each time', () => {
        const d = new StallDetector()
        let hit = null
        for (let n = 1; n <= NO_PROGRESS_LIMIT + 1; n++) {
            hit = d.record(read(`missing-${n}.md`))
            d.noteResult(`ENOENT: no such file, access 'missing-${n}.md'`, true)
        }
        expect(hit?.stall).toBe('no-new-ground')
    })

    test('one genuinely new result resets the streak', () => {
        const d = new StallDetector()
        for (let n = 0; n < NO_PROGRESS_LIMIT - 1; n++) {
            d.record(read('a.md', n))
            d.noteResult('same bytes')
        }
        d.record(read('b.md'))
        d.noteResult('brand new bytes')
        for (let n = 0; n < NO_PROGRESS_LIMIT - 1; n++) {
            expect(d.record(read('a.md', 900 + n))).toBeNull()
            d.noteResult('same bytes')
        }
    })

    test('a verbatim repeated call is dead ground with no result reported at all', () => {
        // Fallback for a transport that reports calls but not results: the exact
        // key alone still has to bound the run.
        const d = new StallDetector()
        expect(d.record({name: 'grep', args: {pattern: 'foo'}})).toBeNull()
        let hit = null
        for (let n = 0; n < NO_PROGRESS_LIMIT; n++) {
            hit = d.record({name: 'grep', args: {pattern: 'foo'}})
        }
        expect(hit?.stall).toBe('no-new-ground')
    })
})

describe('StallDetector — context-churn rule', () => {
    test('never trips before the child reports a context window', () => {
        const d = new StallDetector()
        d.noteResult('x'.repeat(50_000_000))
        // No window reported yet, so there is nothing to be a multiple OF.
        expect(d.record(read('a.md', 1))).toBeNull()
    })

    test('trips once pulled tool output passes the factor times the window', () => {
        const d = new StallDetector()
        d.noteContext(120_064)
        // Under the bound: forward paging, so the no-new-ground rule stays quiet.
        d.noteResult('x'.repeat(120_064 * 4 * CONTEXT_CHURN_FACTOR - 4))
        expect(d.record(read('a.md', 1))).toBeNull()
        d.noteResult('xxxxxxxx')
        const hit = d.record(read('a.md', 2))
        expect(hit?.stall).toBe('context-churn')
        expect(hit!.windowSize).toBe(120_064)
    })

    test('the allowance scales with the model, not with a constant', () => {
        const small = new StallDetector()
        small.noteContext(8_000)
        small.noteResult('x'.repeat(8_000 * 4 * CONTEXT_CHURN_FACTOR + 8))
        expect(small.record(read('a.md', 1))?.stall).toBe('context-churn')

        const big = new StallDetector()
        big.noteContext(1_000_000)
        big.noteResult('x'.repeat(8_000 * 4 * CONTEXT_CHURN_FACTOR + 8))
        expect(big.record(read('a.md', 1))).toBeNull()
    })
})

describe('formatStallHint', () => {
    test('names the actual mistake and never tells a slow model to hurry', () => {
        const ground = formatStallHint('no-new-ground')
        expect(ground).toContain('already read')
        expect(ground.toLowerCase()).not.toContain('time')

        const churn = formatStallHint('context-churn')
        expect(churn).toContain('context window')
        expect(churn.toLowerCase()).not.toContain('time')
    })
})

/**
 * A rotation whose cycle length equals LoopDetector's window is invisible to
 * it: every key occurs exactly once per window, so neither of its rules can
 * count a repeat. `loop-detector.test.ts` asserts that directly — a
 * `LoopDetector(20, 5, 5)` returns null for every call of a 20-file cycle.
 *
 * This detector is not fooled that way: the second lap returns bytes the child
 * has already been handed, and dead ground is dead ground whatever path it
 * came from.
 */
describe('StallDetector — the window-length rotation LoopDetector cannot see', () => {
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

    test('kills the rotation early in the second lap', () => {
        const d = new StallDetector()
        let killedAt = -1
        for (let n = 0; n < 550 && killedAt < 0; n++) {
            const path = ROTATION[n % ROTATION.length]!
            if (d.record(read(path))) killedAt = n
            // A file re-read returns the same bytes. That is the whole signal.
            else d.noteResult(`contents of ${path}`)
        }
        // The first lap is all new ground, so the kill can only land in the
        // second — NO_PROGRESS_LIMIT calls into it.
        expect(killedAt).toBeGreaterThanOrEqual(ROTATION.length)
        expect(killedAt).toBeLessThan(ROTATION.length + NO_PROGRESS_LIMIT + 2)
    })

    test('names the rule so the restart hint can be the right one', () => {
        const d = new StallDetector()
        let hit = null
        for (let n = 0; n < 550 && !hit; n++) {
            const path = ROTATION[n % ROTATION.length]!
            hit = d.record(read(path))
            if (!hit) d.noteResult(`contents of ${path}`)
        }
        expect(hit?.stall).toBe('no-new-ground')
    })

    test('a rotation that keeps returning NEW bytes is never killed', () => {
        // The false positive to guard against: 20 files legitimately re-read
        // after edits, each returning something different every time.
        const d = new StallDetector()
        for (let n = 0; n < 550; n++) {
            const path = ROTATION[n % ROTATION.length]!
            expect(d.record(read(path, n))).toBeNull()
            d.noteResult(`revision ${n} of ${path}`)
        }
    })
})
