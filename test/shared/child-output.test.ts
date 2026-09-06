import {describe, expect, test} from 'bun:test'
import {isExcerptInContent, verifyExcerpt, formatResultText} from '../../src/shared/child-output.js'

describe('verifyExcerpt (PROMPT-3 item 4 diagnostics)', () => {
    test('verdict is identical to isExcerptInContent — the verifier is NOT loosened', () => {
        const content = 'The `router.route(url, handler)` method intercepts requests.'
        for (const excerpt of [
            'router.route(url, handler)', // present
            'router.intercept()', // absent
            '', // empty
            'ROUTER.ROUTE' // case differs — must stay false, no loosening
        ]) {
            expect(verifyExcerpt(excerpt, content).verified).toBe(
                isExcerptInContent(excerpt, content)
            )
        }
    })

    test('a whitespace-only excerpt is unverified in BOTH — one predicate, no disagreement', () => {
        const content = 'the actual page text'
        for (const blank of ['   ', '\n', '\t \n ', '']) {
            // A citation with no characters in it is not evidence. The trap is
            // `content.includes('')`, which is TRUE for every content: a guard on the
            // RAW excerpt would pass "   " (length 3), then search for its normalised
            // form — the empty string — and match anything at all. So the emptiness
            // test has to run on the NORMALISED excerpt, and both functions have to
            // agree, which the third assertion pins.
            expect(isExcerptInContent(blank, content)).toBe(false)
            expect(verifyExcerpt(blank, content).verified).toBe(false)
            expect(verifyExcerpt(blank, content).verified).toBe(isExcerptInContent(blank, content))
        }
    })

    test('whitespace-normalised match still verifies', () => {
        const v = verifyExcerpt('a   b\nc', 'x a b c y')
        expect(v.verified).toBe(true)
        expect(v.normalisedExcerpt).toBe('a b c')
    })

    test('retains a stable hash + length of the normalised content checked', () => {
        const a = verifyExcerpt('foo', 'the  foo   bar')
        const b = verifyExcerpt('bar', 'the foo bar')
        // Same normalised content ⇒ same hash, regardless of what was searched for.
        expect(a.contentSha256).toBe(b.contentSha256)
        expect(a.contentSha256).toMatch(/^[0-9a-f]{64}$/)
        expect(a.contentLength).toBe('the foo bar'.length)
    })

    test('a fabricated excerpt is diagnosable: false verdict but evidence retained', () => {
        const v = verifyExcerpt('nowhere near this', 'the actual page text')
        expect(v.verified).toBe(false)
        expect(v.normalisedExcerpt).toBe('nowhere near this')
        expect(v.contentLength).toBeGreaterThan(0)
    })
})

// Defect 18. `verified === false` prepends "may have paraphrased or hallucinated"
// to the text the CALLING worker reads, on 20% of all docs answers — and over
// every unverified excerpt with a replayable corpus, 21 of 21, not one word was
// missing from the source. They are STITCHED, which is what the extraction prompt
// produces. The verdict stays; the claim about it does not.
describe('a stitched excerpt is not a fabricated one', () => {
    const SOURCE =
        'export interface Context { status: (s: StatusCode) => void; }\n'
        + 'export interface JSONRespond { <T>(object: T): Response; }\n'
        + 'export declare class Hono { get: HandlerInterface; }'

    test('every word covered by verbatim spans reports the stitching, not a lie', () => {
        const check = verifyExcerpt(
            'status: (s: StatusCode) => void; ... get: HandlerInterface;',
            SOURCE
        )
        expect(check.verified).toBe(false)
        expect(check.verbatimSpans).toBe(2)
        expect(check.absent).toEqual([])
        const text = formatResultText('h', {answer: 'a', excerpt: 'e'}, check)
        expect(text).not.toMatch(/hallucinated/)
        expect(text).toMatch(/stitched from 2 separate spans/)
    })

    test('text the source does not have keeps the hallucination warning', () => {
        const check = verifyExcerpt('status: (s: StatusCode) => Elephant;', SOURCE)
        expect(check.verified).toBe(false)
        expect(check.absent).toContain('Elephant;')
        expect(formatResultText('h', {answer: 'a', excerpt: 'e'}, check)).toMatch(/hallucinated/)
    })

    test('a contiguous excerpt is one span and warns about nothing', () => {
        const check = verifyExcerpt('export interface JSONRespond', SOURCE)
        expect(check.verified).toBe(true)
        expect(check.verbatimSpans).toBe(1)
        const text = formatResultText('h', {answer: 'a', excerpt: 'e'}, check)
        expect(text).not.toMatch(/hallucinated|stitched/)
    })

    test('an unchecked excerpt still warns about nothing', () => {
        expect(formatResultText('h', {answer: 'a', excerpt: 'e'}, undefined)).not.toMatch(
            /hallucinated|stitched/
        )
    })

    test('the elision marker the child writes is not counted as absent', () => {
        expect(verifyExcerpt('export interface Context { ... } ... Hono', SOURCE).absent).toEqual(
            []
        )
    })
})
