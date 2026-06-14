import {test, expect, describe} from 'bun:test'
import {gatherExternalContext, type ExternalContextDeps} from './external-context.js'

const deps = {cwd: '/tmp', signal: new AbortController().signal}

function docsOk(pkg: string, content: string, npmLatest?: string): ExternalContextDeps['docsRaw'] {
    return async () => ({
        kind: 'ok',
        pkg: {name: pkg, version: '1.0.0', root: '/tmp', entryDts: null, readme: null},
        chunks: [{filePath: 'x', kind: 'dts', content, rank: 0}],
        hitCache: true,
        ...(npmLatest ? {npmVersion: {pkg, latest: npmLatest, recent: [npmLatest]}} : {})
    })
}

describe('gatherExternalContext', () => {
    test('returns empty string when the refined spec has no targets', async () => {
        let recorded = false
        const out = await gatherExternalContext('just plain prose, nothing to enrich', {
            ...deps,
            recordSubStep: () => (recorded = true)
        })
        expect(out).toBe('')
        // No fan-out happened, so no enrichment timing was recorded.
        expect(recorded).toBe(false)
    })

    test('assembles npm version + docs blocks for a backtick package', async () => {
        const recorded: string[] = []
        const out = await gatherExternalContext(
            'use `zod` for validation',
            {...deps, recordSubStep: label => recorded.push(label)},
            {docsRaw: docsOk('zod', 'zod docs body', '3.23.8')}
        )
        expect(out.startsWith('EXTERNAL CONTEXT\n')).toBe(true)
        expect(out).toContain('### npm: zod')
        expect(out).toContain('latest: 3.23.8')
        expect(out).toContain('### docs: zod')
        expect(out).toContain('zod docs body')
        expect(out.endsWith('\n\n')).toBe(true)
        expect(recorded).toContain('enrichment')
    })

    test('assembles a url block from fetchRaw', async () => {
        const out = await gatherExternalContext('see https://example.com/guide for details', deps, {
            fetchRaw: async ({url}) => ({
                markdown: 'page markdown here',
                finalUrl: url,
                title: 'Guide'
            })
        })
        expect(out).toContain('### url: https://example.com/guide')
        expect(out).toContain('page markdown here')
    })

    test('emits a service block on a search hit', async () => {
        const out = await gatherExternalContext(
            'EXTERNAL-DEPENDENCIES\n- Stripe  payment intents api\n',
            deps,
            {
                searchFn: async () => ({
                    kind: 'ok',
                    results: [{title: 'Stripe Docs', url: 'https://stripe.com', description: 'pay'}]
                })
            }
        )
        expect(out).toContain('### service: Stripe')
        expect(out).toContain('Stripe Docs')
    })

    test('emits the freshness-skipped block when search has no key', async () => {
        const out = await gatherExternalContext(
            'EXTERNAL-DEPENDENCIES\n- Stripe  payment intents api\n',
            deps,
            {searchFn: async () => ({kind: 'no_key', message: 'no key'})}
        )
        expect(out).toContain('### freshness-check skipped')
        expect(out).toContain('- Stripe')
    })

    test('tolerates a failing lookup and yields no block for it', async () => {
        const out = await gatherExternalContext('use `zod` for validation', deps, {
            docsRaw: async () => {
                throw new Error('lookup blew up')
            }
        })
        // The package was a target, but its lookup failed -> nothing to assemble.
        expect(out).toBe('')
    })
})
