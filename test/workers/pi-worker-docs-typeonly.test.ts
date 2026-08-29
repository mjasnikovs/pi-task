import {test, expect, describe} from 'bun:test'
import {extractSeeUrls, docsCacheable} from '../../src/workers/pi-worker-docs.js'

/**
 * PROMPT 2, DO items 2 and 4 at the docs-tool seam.
 *
 * DO item 1's detector has its own suite (src/task/type-only-answer.test.ts, 18 tests,
 * calibrated so exactly 1 of the 150 valid run-15 answers flags). These cover the two
 * pieces wired HERE: pulling the `@see` pointer out of retrieved text, and the cacheability
 * predicate that stops a non-answer being memoised.
 */

describe('extractSeeUrls — the free pointer (F-2d)', () => {
    test('pulls the URL out of a real JSDoc @see {@link …} block', () => {
        // The shape hono's .d.ts actually ships, and the reason F-2d exists: in run 15
        // hono.dev appeared in cache values ONLY inside excerpts like this, never fetched.
        const dts = `
/**
 * Creates a typed RPC client.
 * @see {@link https://hono.dev/docs/guides/rpc}
 */
export declare const hc: <T extends Hono>(baseUrl: string) => Client<T>
`
        expect(extractSeeUrls(dts)).toEqual(['https://hono.dev/docs/guides/rpc'])
    })

    test('handles @see @link without braces, and strips trailing punctuation', () => {
        expect(extractSeeUrls('@see @link https://bun.com/docs/runtime/sql.')).toEqual([
            'https://bun.com/docs/runtime/sql'
        ])
    })

    test('de-duplicates and preserves first-seen order', () => {
        const s = `@see {@link https://a.dev/x}
                   @see {@link https://b.dev/y}
                   @see {@link https://a.dev/x}`
        expect(extractSeeUrls(s)).toEqual(['https://a.dev/x', 'https://b.dev/y'])
    })

    test('returns nothing when there is no pointer — must not invent one', () => {
        expect(extractSeeUrls('export declare const hc: (baseUrl: string) => Client')).toEqual([])
        expect(extractSeeUrls('')).toEqual([])
    })

    test('ignores a bare URL that is not an @see pointer', () => {
        // A URL in prose is not a documentation pointer; following it would be a guess.
        expect(extractSeeUrls('See the guide at https://example.com/blog for background')).toEqual(
            []
        )
    })
})

// The SHIPPED predicate, imported. It used to be hand-retyped here under a
// "keep in sync" comment, so a change to the real rule left these six tests green.
const cacheable = docsCacheable

// The rule is about answer QUALITY only. Whether there IS an answer is the
// outcome's `kind`, and `makeWorkerTool` refuses an `unavailable` before this
// runs — see shared.test.ts. The rule used to open with `childExitCode === 0`,
// which a SIGTERM-killed child satisfies (`code ?? 0`), so `"Docs lookup
// aborted."` passed every clause and was memoised for the whole run.
describe('cacheable — a poor answer must never be memoised (F-2e)', () => {
    test('a real answer is cached', () => {
        expect(cacheable({excerptVerified: true}, 'Per hono@4: hc takes …')).toBe(true)
    })

    test('"unclear from this package" is NOT cached', () => {
        // This is the exact run-15 defect: 52 cached entries were "unclear" with
        // hitCache true, so one dead end was paid for many times and escalation could
        // never re-fire because the miss never recurred.
        expect(cacheable({}, 'unclear from this package')).toBe(false)
    })

    test('a TYPE-ONLY answer is NOT cached', () => {
        expect(cacheable({typeOnly: true}, 'hc takes two parameters…')).toBe(false)
    })

    test('an unverified excerpt is NOT cached — never memoise a suspected fabrication', () => {
        expect(cacheable({excerptVerified: false}, 'Per bun@1: …')).toBe(false)
    })

    test('excerptVerified undefined (no excerpt offered) still caches', () => {
        // Only an excerpt that FAILED verification is disqualifying; a result with no
        // excerpt at all was never a fabrication signal and must stay cacheable.
        expect(cacheable({}, 'Per zod@4: z.object(...) builds a schema')).toBe(true)
    })
})
