import {test, expect, describe} from 'bun:test'
import {
    buildExternalContext,
    gatherExternalContext,
    type ExternalContextLookups
} from '../../src/task/external-context.js'
import type {PhaseDeps} from '../../src/task/child-runner.js'

const deps = {cwd: '/tmp', signal: new AbortController().signal}

function docsOk(pkg: string, content: string, npmLatest?: string): PhaseDeps['docsRaw'] {
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
        const out = await gatherExternalContext('use `zod` for validation', {
            ...deps,
            recordSubStep: label => recorded.push(label),
            docsRaw: docsOk('zod', 'zod docs body', '3.23.8')
        })
        expect(out.startsWith('EXTERNAL CONTEXT\n')).toBe(true)
        expect(out).toContain('### npm: zod')
        expect(out).toContain('latest: 3.23.8')
        expect(out).toContain('### docs: zod')
        expect(out).toContain('zod docs body')
        expect(out.endsWith('\n\n')).toBe(true)
        expect(recorded).toContain('enrichment')
    })

    test('gives EVERY named dep a live npm version block, not just the docs-capped 3', async () => {
        // Six named runtime deps — the real one task shape. The heavy docs
        // fetch still caps at 3, but a version block must exist for all six so a
        // later "which version?" question is grounded for tailwindcss too (the bug:
        // deps past the cap fell back to the model's stale training-data version).
        const docsCalls: string[] = []
        const versionCalls: string[] = []
        const out = await gatherExternalContext(
            'add `hono`, `zod`, `react`, `react-dom`, `wouter`, and `tailwindcss`',
            {
                ...deps,
                docsRaw: async ({pkg}) => {
                    docsCalls.push(pkg)
                    return {
                        kind: 'ok',
                        pkg: {
                            name: pkg,
                            version: '1.0.0',
                            root: '/tmp',
                            entryDts: null,
                            readme: null
                        },
                        chunks: [{filePath: 'x', kind: 'dts', content: `${pkg} docs`, rank: 0}],
                        hitCache: true,
                        npmVersion: {pkg, latest: `9.9.9-${pkg}`, recent: []}
                    }
                },
                npmVersionLookup: async pkg => {
                    versionCalls.push(pkg)
                    return {pkg, latest: `4.1.0-${pkg}`, recent: []}
                }
            }
        )
        // Heavy docs fetch only for the first 3; the rest get a cheap version lookup.
        expect(docsCalls.length).toBe(3)
        expect(versionCalls).toEqual(['react-dom', 'wouter', 'tailwindcss'])
        // A live npm block exists for ALL six — including tailwindcss.
        for (const pkg of ['hono', 'zod', 'react', 'react-dom', 'wouter', 'tailwindcss']) {
            expect(out).toContain(`### npm: ${pkg}`)
        }
        expect(out).toContain('latest: 4.1.0-tailwindcss')
    })

    test('assembles a url block from fetchRaw', async () => {
        const out = await gatherExternalContext('see https://example.com/guide for details', {
            ...deps,
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
            {
                ...deps,
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
            {...deps, searchFn: async () => ({kind: 'no_key', message: 'no key'})}
        )
        expect(out).toContain('### freshness-check skipped')
        expect(out).toContain('- Stripe')
    })

    test('tolerates a failing lookup and yields no block for it', async () => {
        const out = await gatherExternalContext('use `zod` for validation', {
            ...deps,
            docsRaw: async () => {
                throw new Error('lookup blew up')
            }
        })
        // The package was a target, but its lookup failed -> nothing to assemble.
        expect(out).toBe('')
    })
})

// The policy knobs are the whole reason there is ONE builder instead of two
// near-duplicate ones: `gatherExternalContext` (research) and phaseAutoAnswer
// (grill) disagree only here. Each test pins one knob's OFF and ON behaviour so
// a future edit cannot silently give one call path the other's policy.
describe('buildExternalContext policy', () => {
    const lookups = (calls: {docs: string[]; url: string[]; search: string[]}) =>
        ({
            docs: async pkg => {
                calls.docs.push(pkg)
                return {npmVersion: {pkg, latest: '1.0.0', recent: []}, body: `${pkg} body`}
            },
            url: async url => {
                calls.url.push(url)
                return {body: `${url} body`}
            },
            search: async input => {
                calls.search.push(input.query)
                return {
                    kind: 'ok',
                    results: [{title: 'T', url: 'https://x.example', description: 'd'}]
                }
            }
        }) satisfies ExternalContextLookups

    const newCalls = (): {docs: string[]; url: string[]; search: string[]} => ({
        docs: [],
        url: [],
        search: []
    })

    const SERVICES = 'EXTERNAL-DEPENDENCIES\n- Stripe  a\n- Twilio  b\n- Sendgrid  c\n'

    test('targetCap spends its budget on packages before urls', async () => {
        const calls = newCalls()
        await buildExternalContext(
            'use `zod`, `hono` and see https://a.example/x',
            deps,
            lookups(calls),
            {targetCap: 2}
        )
        expect(calls.docs).toEqual(['zod', 'hono'])
        expect(calls.url).toEqual([])
    })

    test('targetCap falls through to urls once packages are exhausted', async () => {
        const calls = newCalls()
        await buildExternalContext(
            'use `zod`; see https://a.example/x and https://b.example/y',
            deps,
            lookups(calls),
            {targetCap: 2}
        )
        expect(calls.docs).toEqual(['zod'])
        expect(calls.url).toEqual(['https://a.example/x'])
    })

    test('no targetCap fans out to every extracted target', async () => {
        const calls = newCalls()
        await buildExternalContext(
            'use `zod`, `hono` and see https://a.example/x',
            deps,
            lookups(calls)
        )
        expect(calls.docs).toEqual(['zod', 'hono'])
        expect(calls.url).toEqual(['https://a.example/x'])
    })

    test('serviceCap bounds the search fan-out; omitting it does not', async () => {
        const capped = newCalls()
        await buildExternalContext(SERVICES, deps, lookups(capped), {serviceCap: 2})
        expect(capped.search).toEqual(['Stripe a', 'Twilio b'])

        const uncapped = newCalls()
        await buildExternalContext(SERVICES, deps, lookups(uncapped))
        expect(uncapped.search).toEqual(['Stripe a', 'Twilio b', 'Sendgrid c'])
    })

    test('versionLookup is off unless supplied, and then covers only non-docs deps', async () => {
        const text = 'add `hono`, `zod`, `react`, `react-dom`, `wouter`'
        const off = newCalls()
        const withoutVersions = await buildExternalContext(text, deps, lookups(off))
        expect(withoutVersions).not.toContain('4.1.0-')

        const on = newCalls()
        const asked: string[] = []
        const withVersions = await buildExternalContext(text, deps, lookups(on), {
            versionLookup: async pkg => {
                asked.push(pkg)
                return {pkg, latest: `4.1.0-${pkg}`, recent: []}
            }
        })
        // The three docs targets carry their own version; only the extras are looked up.
        expect(asked).toEqual(['react-dom', 'wouter'])
        expect(withVersions).toContain('### npm: wouter')
    })

    test('subStepLabel is what records timing — omitting it records nothing', async () => {
        const recorded: string[] = []
        const record = {...deps, recordSubStep: (label: string) => recorded.push(label)}
        await buildExternalContext('use `zod`', record, lookups(newCalls()))
        expect(recorded).toEqual([])
        await buildExternalContext('use `zod`', record, lookups(newCalls()), {
            subStepLabel: 'enrichment'
        })
        expect(recorded).toEqual(['enrichment'])
    })

    test('earlyReturnOnNoTargets only skips the fan-out; both settings return an empty block', async () => {
        const eager = newCalls()
        const eagerOut = await buildExternalContext('plain prose', deps, lookups(eager))
        const early = newCalls()
        const earlyOut = await buildExternalContext('plain prose', deps, lookups(early), {
            earlyReturnOnNoTargets: true
        })
        expect(eagerOut).toBe('')
        expect(earlyOut).toBe('')
        // With nothing extracted there is nothing to call either way — the knob's
        // only observable effect is on versionLookup and the timing sub-step.
        expect(eager).toEqual(early)
    })

    test('earlyReturnOnNoTargets suppresses the version lookup a bare version list would get', async () => {
        // No docs/url/service targets at all. The research path deliberately
        // returns '' before spending a single registry GET.
        const asked: string[] = []
        const versionLookup = async (
            pkg: string
        ): Promise<{pkg: string; latest: string; recent: string[]}> => {
            asked.push(pkg)
            return {pkg, latest: '1.0.0', recent: []}
        }
        const out = await buildExternalContext('no targets here', deps, lookups(newCalls()), {
            versionLookup,
            earlyReturnOnNoTargets: true
        })
        expect(out).toBe('')
        expect(asked).toEqual([])
    })

    test('a rejected lookup drops that target and keeps the rest', async () => {
        const out = await buildExternalContext(
            'use `zod` and `hono`',
            deps,
            {
                docs: async pkg => {
                    if (pkg === 'zod') throw new Error('boom')
                    return {body: `${pkg} body`}
                },
                url: async () => null
            },
            {}
        )
        expect(out).not.toContain('### docs: zod')
        expect(out).toContain('### docs: hono')
    })
})
