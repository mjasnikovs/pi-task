import {describe, expect, test} from 'bun:test'
import {delivered, mcnemarExact, repoPath, scorePaths} from './adhoc-clock-score.js'

/**
 * The category rules are lifted from `phase-path-axis-audit.ts`, which exists
 * because this exact axis was once REJECTED for scoring known-good output at
 * 56.2%. Every exclusion below is a span that audit found being counted as an
 * invented path when it was never a repo-path claim at all.
 */
describe('repoPath — what is really a claim about a path in this repo', () => {
    test('accepts a repo-relative path or directory', () => {
        expect(repoPath('src/workers/foo.ts')).toBe('src/workers/foo.ts')
        expect(repoPath('src/client')).toBe('src/client')
        expect(repoPath('src/client/')).toBe('src/client')
    })

    test('rejects the categories that are not repo paths', () => {
        expect(repoPath('db.ts')).toBeNull() // a bare filename, not a path
        expect(repoPath('hono/client')).toBeNull() // npm subpath specifier
        expect(repoPath('@hono/zod-validator')).toBeNull() // scoped package
        expect(repoPath('./util.js')).toBeNull() // relative import specifier
        expect(repoPath('../util.js')).toBeNull()
        expect(repoPath('/etc/passwd')).toBeNull() // absolute, not repo-relative
        expect(repoPath('hono.dev/docs/guides')).toBeNull() // a URL
        expect(repoPath('application/json')).toBeNull() // a MIME type
        expect(repoPath('image/png')).toBeNull()
    })

    test('a dotted code expression is not a path', () => {
        // `c.var.user` was one of the spans that sank the earlier axis. It has no
        // slash, so the bare-filename rule already excludes it — pinned so a later
        // loosening of that rule cannot quietly let it back in.
        expect(repoPath('c.var.user')).toBeNull()
    })
})

describe('scorePaths', () => {
    const tree = new Set(['src', 'src/workers', 'src/workers/foo.ts', 'src/index.ts'])

    test('counts only backticked spans, and dedupes', () => {
        const f = scorePaths('see `src/workers/foo.ts` and `src/workers/foo.ts`', tree)
        expect(f.cited).toBe(1)
        expect(f.strictReal).toBe(1)
    })

    test('an invented path lands in unfound', () => {
        const f = scorePaths('`src/workers/nope.ts` is where it lives', tree)
        expect(f.cited).toBe(1)
        expect(f.strictReal).toBe(0)
        expect(f.unfound).toEqual(['src/workers/nope.ts'])
    })

    test('SUFFIX accepts `src/` prefix elision, STRICT does not', () => {
        // The one residual `phase-path-axis-audit.ts` named and did not fix: a
        // worker writing `workers/foo.ts` for `src/workers/foo.ts`.
        const f = scorePaths('`workers/foo.ts`', tree)
        expect(f.strictReal).toBe(0)
        expect(f.suffixReal).toBe(1)
        expect(f.unfound).toEqual([])
    })

    test('the suffix rung is segment-anchored, so it cannot match mid-name', () => {
        // Without the leading slash, `oo.ts` would "match" `foo.ts`. A loose
        // scorer is as fatal as a strict one.
        const f = scorePaths('`kers/oo.ts`', tree)
        expect(f.suffixReal).toBe(0)
    })

    test('prose with no backticked paths scores nothing rather than crashing', () => {
        expect(scorePaths('I found no violations.', tree)).toEqual({
            cited: 0,
            strictReal: 0,
            suffixReal: 0,
            unfound: []
        })
    })
})

describe('delivered — the win side of the ledger', () => {
    test('a real answer counts', () => {
        expect(delivered('The component is in src/index.ts.')).toBe(true)
    })

    test('every shape of nothing does not', () => {
        expect(delivered('')).toBe(false)
        expect(delivered('   \n ')).toBe(false)
        expect(delivered('(no output)')).toBe(false)
        expect(delivered('Worker aborted.')).toBe(false)
        // 0.38.26 replaced the collapsed message with a named cause; the scorer
        // has to recognise the NEW text too or a timeout would count as delivered.
        expect(delivered('Worker ran out of time before answering, on every attempt.')).toBe(false)
    })
})

describe('mcnemarExact — the statistic must match the matched design', () => {
    test('no discordant pairs is no evidence', () => {
        expect(mcnemarExact(0, 0)).toBe(1)
    })

    test('known exact values', () => {
        // all 5 discordant pairs one way: 2 * 0.5^5
        expect(mcnemarExact(0, 5)).toBeCloseTo(0.0625, 6)
        // 1 vs 4: 2 * (C(5,0)+C(5,1)) / 32
        expect(mcnemarExact(1, 4)).toBeCloseTo(0.375, 6)
        expect(mcnemarExact(0, 10)).toBeCloseTo(0.001953125, 8)
    })

    test('symmetric — direction is the caller\'s to read, not the p-value\'s', () => {
        expect(mcnemarExact(2, 7)).toBeCloseTo(mcnemarExact(7, 2), 12)
    })

    test('an even split is never significant', () => {
        expect(mcnemarExact(5, 5)).toBeGreaterThan(0.9)
    })

    test('it never exceeds 1', () => {
        for (const [b, c] of [[1, 1], [2, 2], [3, 3], [1, 2]]) {
            expect(mcnemarExact(b!, c!)).toBeLessThanOrEqual(1)
        }
    })
})
