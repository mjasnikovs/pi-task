import {test, expect, describe} from 'bun:test'
import {extractSeeUrls, docsCacheable} from '../../src/workers/pi-worker-docs.js'

/**
 * The two type-only pieces wired at the docs-tool seam: pulling the `@see` pointer
 * out of retrieved text, and the cacheability predicate that stops a non-answer
 * being memoised.
 *
 * The detector itself — `isTypeOnlyAnswer` — has its own suite in
 * test/task/type-only-answer.test.ts.
 */

describe('extractSeeUrls — the free pointer (F-2d)', () => {
    test('pulls the URL out of a real JSDoc @see {@link …} block', () => {
        // The shape the pointer arrives in: a JSDoc block above the declaration, so it
        // is already inside the excerpt the retriever hands back.
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

// The shipped predicate itself, not a local copy of the rule.
const cacheable = docsCacheable

// The rule is about answer QUALITY only. Whether there IS an answer is the
// outcome's `kind`, and `makeWorkerTool` refuses an `unavailable` before this
// runs (workers/shared.ts). Process health must not enter: runChild reports a
// killed child as `code ?? 0`, so any rule keyed on exit code would read a
// SIGTERMed lookup as a clean one and memoise its aborted text.
describe('cacheable — a poor answer must never be memoised (F-2e)', () => {
    test('a real answer is cached', () => {
        expect(cacheable({excerptVerified: true}, 'Per hono@4: hc takes …')).toBe(true)
    })

    test('"unclear from this package" is NOT cached', () => {
        // A cached abstention is served to every later asker, so the miss never
        // recurs and nothing ever re-triggers an escalation.
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
