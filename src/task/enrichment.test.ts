import {describe, expect, test} from 'bun:test'
import {extractEnrichTargets} from './enrichment.js'

describe('extractEnrichTargets', () => {
    test('finds backticked package names', () => {
        const out = extractEnrichTargets('use `zod` for validation and `@scope/lib` too')
        expect(out.packages).toEqual(['zod', '@scope/lib'])
        expect(out.urls).toEqual([])
    })

    test('filters denylist tokens', () => {
        const out = extractEnrichTargets('run `npm install` then `bun test`')
        expect(out.packages).toEqual([])
    })

    test('finds URLs and drops trailing punctuation', () => {
        const out = extractEnrichTargets('see https://example.com/foo.')
        expect(out.urls).toEqual(['https://example.com/foo'])
    })

    test('caps results at 3 each', () => {
        const text = '`a` `b` `c` `d` https://x https://y https://z https://w'
        const out = extractEnrichTargets(text)
        expect(out.packages.length).toBeLessThanOrEqual(3)
        expect(out.urls.length).toBeLessThanOrEqual(3)
    })
})

describe('extractEnrichTargets — services', () => {
    test('parses EXTERNAL-DEPENDENCIES section', () => {
        const text = [
            'GOAL',
            '  do stuff',
            '',
            'EXTERNAL-DEPENDENCIES',
            '  - Twitch  current event subscription API for receiving chat events',
            '  - Stripe  current webhook signing format'
        ].join('\n')
        const out = extractEnrichTargets(text)
        expect(out.services).toEqual([
            {name: 'Twitch', query: 'current event subscription API for receiving chat events'},
            {name: 'Stripe', query: 'current webhook signing format'}
        ])
    })

    test('preserves single-space gaps inside name; splits on 2+ spaces', () => {
        const text = ['EXTERNAL-DEPENDENCIES', '  - Twitch Helix  current REST endpoints'].join(
            '\n'
        )
        const out = extractEnrichTargets(text)
        expect(out.services).toEqual([{name: 'Twitch Helix', query: 'current REST endpoints'}])
    })

    test('caps services at ENRICH_CAP (3)', () => {
        const text = [
            'EXTERNAL-DEPENDENCIES',
            '  - A  a',
            '  - B  b',
            '  - C  c',
            '  - D  d',
            '  - E  e'
        ].join('\n')
        const out = extractEnrichTargets(text)
        expect(out.services.length).toBe(3)
        expect(out.services.map(s => s.name)).toEqual(['A', 'B', 'C'])
    })

    test('section ends at blank line', () => {
        const text = ['EXTERNAL-DEPENDENCIES', '  - A  a', '', '  - B  b'].join('\n')
        const out = extractEnrichTargets(text)
        expect(out.services.map(s => s.name)).toEqual(['A'])
    })

    test('section ends at next ALL-CAPS header', () => {
        const text = ['EXTERNAL-DEPENDENCIES', '  - A  a', 'KNOWN-UNKNOWNS', '  - B  b'].join('\n')
        const out = extractEnrichTargets(text)
        expect(out.services.map(s => s.name)).toEqual(['A'])
    })

    test('skips malformed bullets without crashing', () => {
        const text = ['EXTERNAL-DEPENDENCIES', '  - NoQueryHere', '  - Has Query  with text'].join(
            '\n'
        )
        const out = extractEnrichTargets(text)
        expect(out.services.map(s => s.name)).toEqual(['Has Query'])
    })

    test('absent section yields empty services array', () => {
        const out = extractEnrichTargets('GOAL\n  no external deps mentioned\n')
        expect(out.services).toEqual([])
    })

    test('packages + urls + services coexist', () => {
        const text = [
            'use `zod` and see https://example.com',
            '',
            'EXTERNAL-DEPENDENCIES',
            '  - Twitch  current event subscription API'
        ].join('\n')
        const out = extractEnrichTargets(text)
        expect(out.packages).toEqual(['zod'])
        expect(out.urls).toEqual(['https://example.com'])
        expect(out.services).toEqual([{name: 'Twitch', query: 'current event subscription API'}])
    })

    test('dedupes services by name (case-insensitive), keeping first query', () => {
        const text = [
            'EXTERNAL-DEPENDENCIES',
            '  - Stripe Checkout  first query',
            '  - stripe checkout  second query',
            '  - Stripe Webhooks  webhook query'
        ].join('\n')
        const out = extractEnrichTargets(text)
        expect(out.services).toEqual([
            {name: 'Stripe Checkout', query: 'first query'},
            {name: 'Stripe Webhooks', query: 'webhook query'}
        ])
    })

    test('tolerates a duplicated EXTERNAL-DEPENDENCIES header with duplicated bullets', () => {
        // Reproduces a real refine-model malformation: the section header and
        // every bullet emitted twice. A repeated header is not a terminator,
        // and duplicate bullets collapse by name — so the cap counts uniques.
        const text = [
            'EXTERNAL-DEPENDENCIES',
            'EXTERNAL-DEPENDENCIES',
            '  - Stripe Checkout  one-time payment session',
            '  - Stripe Checkout  one-time payment session',
            '  - Stripe Webhooks  signature verification',
            '  - Stripe Webhooks  signature verification',
            '  - Stripe.js  client-side integration',
            '  - Stripe.js  client-side integration'
        ].join('\n')
        const out = extractEnrichTargets(text)
        expect(out.services).toEqual([
            {name: 'Stripe Checkout', query: 'one-time payment session'},
            {name: 'Stripe Webhooks', query: 'signature verification'},
            {name: 'Stripe.js', query: 'client-side integration'}
        ])
    })

    test('cap counts unique services, not duplicate lines', () => {
        const text = [
            'EXTERNAL-DEPENDENCIES',
            '  - A  a',
            '  - A  a',
            '  - B  b',
            '  - B  b',
            '  - C  c',
            '  - C  c',
            '  - D  d'
        ].join('\n')
        const out = extractEnrichTargets(text)
        expect(out.services.map(s => s.name)).toEqual(['A', 'B', 'C'])
    })
})
