/**
 * Unit tests for the STAGE 2 scoring predicates.
 *
 * These decide a verdict, so they are tested against REAL recorded strings wherever one
 * exists: the queries below are verbatim from Stage 1's run (~/tmp/apis-stopping-point) and
 * from run 15's research cache, not invented shapes that happen to match the regex.
 */
import {describe, expect, test} from 'bun:test'
import {countSemantics, isBehaviourPackageQuery, packageQueryKinds, sectionLines} from './apis-semantics.js'

describe('isBehaviourPackageQuery — the PRIMARY metric unit', () => {
    test('a real Stage-1 signature query about a package does NOT count', () => {
        // Verbatim shape of the run-15 query that shipped the fatal bug.
        expect(
            isBehaviourPackageQuery({
                module: 'hono/client',
                query: 'hc factory function signature base url parameter types exported from hono/client'
            })
        ).toBe(false)
    })

    test('a behaviour question about a package counts', () => {
        expect(
            isBehaviourPackageQuery({
                module: 'hono/client',
                query: 'what does the baseUrl argument to hc MEAN — an origin or a mount prefix — and how is it joined to each route path?'
            })
        ).toBe(true)
    })

    test('PROJECT SOURCE is excluded even when the question is behavioural', () => {
        // 66 of Stage 1's 127 queries are `.`; no documentation lever can act on them, so
        // leaving them in the denominator would dilute the only population the lever moves.
        expect(
            isBehaviourPackageQuery({module: '.', query: 'how does requireAuth behave when the session is missing?'})
        ).toBe(false)
    })

    test('the committed classifier is used as-is: a signature cue alone is not behaviour', () => {
        expect(isBehaviourPackageQuery({module: 'wouter', query: 'useLocation return type'})).toBe(false)
    })
})

describe('packageQueryKinds', () => {
    test('splits package queries by the committed classifier and drops project source', () => {
        const k = packageQueryKinds([
            {module: '.', query: 'route handlers in server/index.ts'},
            {module: 'hono', query: 'Hono app types and exports'},
            {module: 'hono/client', query: 'what does hc baseUrl mean'},
            {module: 'wouter', query: 'all exported components'}
        ])
        expect(k.total).toBe(3)
        expect(k.behaviour).toBe(1)
        expect(k.signatureOnly).toBe(1)
        expect(k.neither).toBe(1)
    })
})

describe('countSemantics — the output-side counter', () => {
    test('a Stage-1-shaped section with no semantics field scores zero', () => {
        const section = [
            'hc  hc<AppType>(baseUrl: Prefix, options?: ClientRequestOptions)',
            'useLocation  () => [string, (to: string) => void]'
        ].join('\n')
        const c = countSemantics(section)
        expect(c.entries).toBe(2)
        expect(c.withSemantics).toBe(0)
        expect(c.unverified).toBe(0)
    })

    test('counts a filled clause and the mandatory UNVERIFIED abstention separately', () => {
        const section = [
            'hc  hc<AppType>(baseUrl, options?)  — SEMANTICS: baseUrl is an ORIGIN; the route path is appended to it',
            'sql  sql`…` tagged template  — SEMANTICS: UNVERIFIED: are DDL statements sent as bind parameters?',
            'Route  <Route path=… />'
        ].join('\n')
        const c = countSemantics(section)
        expect(c.entries).toBe(3)
        expect(c.withSemantics).toBe(2)
        expect(c.unverified).toBe(1)
        expect(c.answered).toBe(1)
    })

    test('tolerates separator and case drift, which a weak model produces', () => {
        const section = 'hc  hc(baseUrl)  - semantics: it is a mount prefix'
        expect(countSemantics(section).withSemantics).toBe(1)
    })

    test('prose containing the word semantics without a colon does NOT score', () => {
        // Otherwise the lever could be credited for an entry that merely discusses semantics.
        const section = 'hc  the semantics of this call are subtle'
        expect(countSemantics(section).withSemantics).toBe(0)
    })

    test('scores the WHOLE line, not the parsed remainder', () => {
        // parseApisEntries splits the head at the first `: ` — scoring `rest` alone would drop
        // the field on this shape and silently under-count the treatment arm.
        const section = 'hc: hc(baseUrl) — SEMANTICS: an origin'
        expect(countSemantics(section).withSemantics).toBe(1)
    })
})

describe('sectionLines', () => {
    test('drops blank lines and trims, so counters and entries share a denominator', () => {
        expect(sectionLines('a  x\n\n  b  y  \n')).toEqual(['a  x', 'b  y'])
    })
})
