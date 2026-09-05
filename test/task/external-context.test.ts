import {test, expect, describe} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    buildExternalContext,
    gatherExternalContext,
    type ExternalContextLookups,
    type VersionBlock
} from '../../src/task/external-context.js'
import type {PhaseDeps} from '../../src/task/child-runner.js'

const deps = {cwd: '/tmp', signal: new AbortController().signal}

function docsOk(pkg: string, content: string, npmLatest?: string): PhaseDeps['docsRaw'] {
    return async () => ({
        kind: 'ok',
        pkg: {
            ecosystem: 'npm' as const,
            name: pkg,
            version: '1.0.0',
            root: '/tmp',
            entry: null,
            readme: null
        },
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

    test('assembles an npm version block for a backtick package', async () => {
        const recorded: string[] = []
        const out = await gatherExternalContext('use `zod` for validation', {
            ...deps,
            recordSubStep: label => recorded.push(label),
            docsRaw: docsOk('zod', 'zod docs body', '3.23.8'),
            npmVersionLookup: async pkg => ({pkg, latest: '3.23.8', recent: ['3.23.8']})
        })
        expect(out.startsWith('EXTERNAL CONTEXT\n')).toBe(true)
        expect(out).toContain('### npm: zod')
        expect(out).toContain('latest: 3.23.8')
        expect(out).not.toContain('### docs: zod')
        expect(out.endsWith('\n\n')).toBe(true)
        expect(recorded).toContain('enrichment')
    })

    test('gives EVERY named dep a live npm version block', async () => {
        // Six named runtime deps. A version block must exist for ALL six: without
        // one, a later "which version?" question about the sixth is answered from
        // training data, which can only name a version that existed when the model
        // was trained. The research path fetches no docs body at all.
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
                            ecosystem: 'npm',
                            entry: null,
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
        expect(docsCalls).toEqual([])
        expect(versionCalls).toEqual(['hono', 'zod', 'react', 'react-dom', 'wouter', 'tailwindcss'])
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

    test('a failing docs lookup yields no BODY, but still yields the version', async () => {
        // Every named dep gets a version block. A docs lookup that blew up is
        // exactly when the standalone lookup has to cover for it — dropping both
        // leaves the model told to quote a block that is not there.
        const out = await gatherExternalContext('use `zod` for validation', {
            ...deps,
            docsRaw: async () => {
                throw new Error('lookup blew up')
            },
            npmVersionLookup: async pkg => ({pkg, latest: '3.25.0', recent: ['3.25.0']})
        })
        expect(out).toContain('### npm: zod')
        expect(out).not.toContain('### docs: zod')
    })

    test('a failing docs lookup with no version either yields nothing', async () => {
        const out = await gatherExternalContext('use `zod` for validation', {
            ...deps,
            docsRaw: async () => {
                throw new Error('lookup blew up')
            },
            npmVersionLookup: async () => null
        })
        expect(out).toBe('')
    })
})

// The policy knobs are the whole reason there is ONE builder instead of two
// near-duplicate ones. The two call paths disagree in exactly three fields:
// gatherExternalContext (external-context.ts) passes versionLookup,
// subStepLabel: 'enrichment' and earlyReturnOnNoTargets: true, while
// phaseAutoAnswer (phases.ts) passes none of them — only docs, url and search.
// Each test below pins one knob OFF and ON, so an edit cannot silently give one
// call path the other's policy.
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

    test('a standalone version block is headed by the registry it was asked', async () => {
        // The docs-target blocks already carried the label; this second, cheaper
        // lookup did not — so a cargo project emitted crates.io versions under
        // "### npm:", which is the wrong-registry claim this tool exists to stop.
        const out = await buildExternalContext(
            'use `tokio` and `serde`',
            deps,
            lookups(newCalls()),
            {
                targetCap: 1,
                versionLookup: pkg =>
                    Promise.resolve({
                        info: {pkg, latest: '1.53.1', recent: []},
                        label: 'crates.io'
                    })
            }
        )
        expect(out).toContain('### crates.io: serde')
        expect(out).not.toContain('### npm: serde')
    })

    test('a docs target that came back WITHOUT a version still gets one', async () => {
        // `extraVersionPkgs` drops every docs target on the assumption the docs
        // result carries the version. In a directory with no manifest docsRaw
        // refuses before it asks any registry, so that block was silently lost.
        const asked: string[] = []
        const out = await buildExternalContext(
            'use `hono`',
            deps,
            {
                ...lookups(newCalls()),
                docs: async () => ({body: 'hono body'})
            },
            {
                versionLookup: pkg => {
                    asked.push(pkg)
                    return Promise.resolve({
                        info: {pkg, latest: '4.9.0', recent: []},
                        label: 'npm'
                    })
                }
            }
        )
        expect(asked).toContain('hono')
        expect(out).toContain('### npm: hono')
        expect(out).toContain('### docs: hono')
    })

    test('every named dep still gets a version block in a POLYGLOT repo', async () => {
        // Deciding the registry once for the whole repo made any two-manifest
        // project ambiguous, and then NO block was emitted at all — worse than
        // always-npm, because the CONTEXT prompt tells the model to quote a block
        // that would never be there. The decision belongs to each name.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-poly-'))
        fs.writeFileSync(
            path.join(dir, 'package.json'),
            JSON.stringify({
                name: 'p',
                dependencies: {
                    zod: '^3.0.0',
                    hono: '^4.0.0',
                    react: '^19.0.0',
                    'react-dom': '^19.0.0',
                    wouter: '^3.0.0',
                    clsx: '^2.0.0',
                    nanoid: '^5.0.0'
                }
            }),
            'utf8'
        )
        fs.writeFileSync(path.join(dir, 'Cargo.toml'), '[package]\nname = "p"\n', 'utf8')
        fs.writeFileSync(
            path.join(dir, 'Cargo.lock'),
            'version = 4\n\n[[package]]\nname = "tokio"\nversion = "1.53.1"\n',
            'utf8'
        )
        // More names than the docs cap, so the tail falls to the cheap standalone
        // version lookup — the path that went silent.
        const asked: string[] = []
        const source =
            'add `zod`, `hono`, `react`, `react-dom`, `wouter`, `clsx`, `nanoid` and `tokio`'
        const out = await gatherExternalContext(source, {
            cwd: dir,
            signal: new AbortController().signal,
            docsRaw: async () => ({
                kind: 'no_chunks',
                pkg: {
                    ecosystem: 'npm',
                    name: 'x',
                    version: '1',
                    root: '/',
                    entry: null,
                    readme: null
                },
                hitCache: false
            }),
            npmVersionLookup: async (pkg: string) => {
                asked.push(pkg)
                return {pkg, latest: `9.9.9-${pkg}`, recent: []}
            }
        } as never)
        // Past the docs cap, a dep package.json declares still gets its npm block.
        expect(asked.length).toBeGreaterThan(0)
        for (const pkg of asked) expect(out).toContain(`### npm: ${pkg}`)
        expect(asked.some(p => ['clsx', 'nanoid', 'wouter'].includes(p))).toBe(true)
        // tokio is pinned by Cargo.lock and by nothing npm has, so npm is never
        // asked about it — that is the wrong-registry version this branch removes.
        expect(asked).not.toContain('tokio')
        expect(out).not.toContain('### npm: tokio')
        fs.rmSync(dir, {recursive: true, force: true})
    })

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
                return {info: {pkg, latest: `4.1.0-${pkg}`, recent: []}, label: 'npm'}
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
        const versionLookup = async (pkg: string): Promise<VersionBlock> => {
            asked.push(pkg)
            return {info: {pkg, latest: '1.0.0', recent: []}, label: 'npm'}
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

describe('enrichment is gated on the project manifest', () => {
    // The unit tests above all run in /tmp, which declares nothing and so cannot
    // see this gate at all — that is how ten registry installs of `config.ts`,
    // `app.ts` and `name` shipped. This one writes a real manifest.
    test('a backticked filename in a real npm project is never fanned out', async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-gate-'))
        fs.writeFileSync(
            path.join(cwd, 'package.json'),
            JSON.stringify({name: 'p', dependencies: {zod: '^4.0.0'}})
        )
        const asked: string[] = []
        const lookups: ExternalContextLookups = {
            docs: async pkg => {
                asked.push(pkg)
                return {body: `${pkg} body`}
            },
            url: async () => null
        }
        const versionAsked: string[] = []
        const versionLookup = async (pkg: string): Promise<VersionBlock | null> => {
            versionAsked.push(pkg)
            return null
        }
        await buildExternalContext(
            'export `loadConfig` from `config.ts`, validate with `zod`, set `port` in `config.json`',
            {...deps, cwd, recordSubStep: () => {}},
            lookups,
            {versionLookup}
        )
        expect(asked).toEqual(['zod'])
        // zod is asked for a version because the docs stub returns none; the
        // point is that no filename ever reaches either registry call.
        expect(versionAsked).toEqual(['zod'])
        fs.rmSync(cwd, {recursive: true, force: true})
    })
})

describe('the research binding fetches no package docs', () => {
    // Evidence, live run 2026-09-05 (DOC_REGRESSINONS.md sections 5 and below):
    //  - the docs query was `refined.split('\n')[0]`, which is the literal word
    //    "GOAL" for every refined spec these runs produce;
    //  - hs TASK_0002 spent all three ENRICH_CAP slots on `config.json`, `name`
    //    and `port`, fetching no library at all;
    //  - no research output cites an enrichment docs body, while the model's own
    //    docs tool was called 49 times across the three runs with no bad name.
    // The version lookup is the half that earns its keep and stays.
    function projectWithZod(): string {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'research-nodocs-'))
        fs.writeFileSync(
            path.join(cwd, 'package.json'),
            JSON.stringify({name: 'p', dependencies: {zod: '4.5.4'}})
        )
        return cwd
    }

    test('a declared package gets its version block and no docs body', async () => {
        const cwd = projectWithZod()
        let docsCalls = 0
        const out = await gatherExternalContext('GOAL\n  validate with `zod`\n', {
            ...deps,
            cwd,
            recordSubStep: () => {},
            docsRaw: async input => {
                docsCalls += 1
                return docsOk('zod', 'raw d.ts chunks', '4.5.4')!(input)
            },
            npmVersionLookup: async () => ({pkg: 'zod', latest: '4.5.4', recent: ['4.5.4']})
        })
        expect(docsCalls).toBe(0)
        expect(out).not.toContain('### docs:')
        expect(out).not.toContain('raw d.ts chunks')
        expect(out).toContain('### npm: zod')
        expect(out).toContain('latest: 4.5.4')
        fs.rmSync(cwd, {recursive: true, force: true})
    })

    test('URLs are still fetched — only the package fan-out goes', async () => {
        const cwd = projectWithZod()
        const out = await gatherExternalContext('GOAL\n  see https://example.com/x\n', {
            ...deps,
            cwd,
            recordSubStep: () => {},
            fetchRaw: async () => ({
                markdown: 'page body',
                url: 'https://example.com/x',
                finalUrl: 'https://example.com/x',
                title: 'x'
            })
        })
        expect(out).toContain('### url: https://example.com/x')
        expect(out).toContain('page body')
        fs.rmSync(cwd, {recursive: true, force: true})
    })
})
