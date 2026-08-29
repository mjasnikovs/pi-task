import {describe, expect, test} from 'bun:test'
import {isExcerptInContent, verifyExcerpt} from '../../src/shared/child-output.js'

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
            // `content.includes('')`, which is true for every content — so the raw-string
            // emptiness guard used to let "   " verify against anything, while verifyExcerpt
            // (testing the NORMALISED length) called the identical input unverified.
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
