import {test, expect} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type {AgentToolResult} from '@earendil-works/pi-agent-core'
import {
    registerPiWorkerDocs,
    packageRootOf,
    docsCacheKey,
    type PiWorkerDocsInternals
} from '../../src/workers/pi-worker-docs.js'
import {openCache} from '../../src/workers/docs-cache.js'
import {ResolveError} from '../../src/workers/docs-resolve.js'
import {fakeSpawnSimple, fakeSpawnByPrompt} from '../test-utils/fake-spawn.js'
import {readTypeOnlyLog, TYPEONLY_LOG_ENV} from '../../src/workers/typeonly-log.js'
import {PROJECT_DOCS_BUDGET_ENV} from '../../src/task/research-fanout-budget.js'

const FIXTURES = path.resolve(__dirname, '__fixtures__')

interface RegisteredTool {
    execute: (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: unknown,
        ctx?: unknown
    ) => Promise<AgentToolResult<unknown>>
}

function makePi(): {
    registered: RegisteredTool[]
    api: {registerTool: (t: RegisteredTool) => void}
} {
    const registered: RegisteredTool[] = []
    return {registered, api: {registerTool: (t: RegisteredTool) => registered.push(t)}}
}

async function runTool(
    internals: PiWorkerDocsInternals,
    params: {module: string; query: string; ecosystem?: 'npm' | 'cargo' | 'hackage'},
    cwd: string = FIXTURES
): Promise<AgentToolResult<unknown>> {
    const {registered, api} = makePi()
    registerPiWorkerDocs(api as unknown as Parameters<typeof registerPiWorkerDocs>[0], internals)
    return registered[0].execute('id', params, undefined, undefined, {cwd})
}

test('pi-worker-docs runs full pipeline and returns formatted answer + excerpt', async () => {
    const cache = openCache(':memory:')
    let promptSeen = ''
    const result = await runTool(
        {
            openCache: () => cache,
            npmVersionLookup: async () => null,
            spawn: fakeSpawnByPrompt(args => {
                promptSeen = args[args.length - 1]
                return {
                    stdout: '<answer>Use UserService.list() to enumerate.</answer>\n<excerpt>class UserService</excerpt>'
                }
            })
        },
        {module: 'tiny-pkg', query: 'how do I list users?'}
    )

    const text = (result.content[0] as {type: 'text'; text: string}).text
    expect(text).toContain('Per tiny-pkg@1.0.0:')
    expect(text).toContain('UserService')
    expect(text).toContain('Source excerpt:')
    expect(promptSeen).toContain('<package>tiny-pkg@1.0.0</package>')
    expect(promptSeen).toContain('<question>how do I list users?</question>')
    const details = result.details as {
        hitCache?: boolean
        excerptVerified?: boolean
        chunksRetrieved?: number
    }
    expect(details.hitCache).toBe(false)
    expect(details.chunksRetrieved).toBeGreaterThan(0)
    expect(details.excerptVerified).toBe(true)
    cache.close()
})

test('pi-worker-docs hits cache on second call for same package version', async () => {
    const cache = openCache(':memory:')
    let calls = 0
    const internals: PiWorkerDocsInternals = {
        openCache: () => cache,
        npmVersionLookup: async () => null,
        spawn: fakeSpawnByPrompt(_args => {
            calls++
            return {stdout: '<answer>ok</answer>\n<excerpt>greet</excerpt>'}
        })
    }
    await runTool(internals, {module: 'tiny-pkg', query: 'greet'})
    const second = await runTool(internals, {module: 'tiny-pkg', query: 'greet'})
    const details = second.details as {hitCache?: boolean}
    expect(details.hitCache).toBe(true)
    expect(calls).toBe(2) // both calls spawn the child; only ingestion is skipped
    cache.close()
})

test('pi-worker-docs flags unverified excerpt with WARNING', async () => {
    const cache = openCache(':memory:')
    const result = await runTool(
        {
            openCache: () => cache,
            npmVersionLookup: async () => null,
            spawn: fakeSpawnSimple(
                '<answer>fabricated</answer>\n<excerpt>this string is not in any chunk</excerpt>'
            )
        },
        {module: 'tiny-pkg', query: 'anything'}
    )
    const text = (result.content[0] as {type: 'text'; text: string}).text
    expect(text).toMatch(/WARNING: cited excerpt not found/)
    const details = result.details as {excerptVerified?: boolean}
    expect(details.excerptVerified).toBe(false)
    cache.close()
})

test('pi-worker-docs returns clear error for un-installed package', async () => {
    const cache = openCache(':memory:')
    const result = await runTool(
        {
            openCache: () => cache,
            npmVersionLookup: async () => null,
            // The package does not resolve, so acquirePackage runs
            // `npm install --ignore-scripts …` first. This makes that install fail.
            spawn: fakeSpawnSimple('', 1, 'npm ERR! 404 Not Found')
        },
        {module: 'does-not-exist', query: 'q'}
    )
    const text = (result.content[0] as {type: 'text'; text: string}).text
    expect(text).toMatch(/not installed/)
    const details = result.details as {resolveError?: string}
    expect(details.resolveError).toBe('not_installed')
    cache.close()
})

test('pi-worker-docs returns invalid_name error for bad module name', async () => {
    const cache = openCache(':memory:')
    const result = await runTool(
        {
            openCache: () => cache,
            npmVersionLookup: async () => null,
            spawn: () => {
                throw new Error('should not be called')
            }
        },
        {module: '../etc/passwd', query: 'q'}
    )
    const text = (result.content[0] as {type: 'text'; text: string}).text
    expect(text).toMatch(/Invalid module name/)
    const details = result.details as {resolveError?: string}
    expect(details.resolveError).toBe('invalid_name')
    cache.close()
})

test('pi-worker-docs surfaces child non-zero exit', async () => {
    const cache = openCache(':memory:')
    const result = await runTool(
        {
            openCache: () => cache,
            npmVersionLookup: async () => null,
            spawn: fakeSpawnSimple('', 1, 'kaboom')
        },
        {module: 'tiny-pkg', query: 'q'}
    )
    const text = (result.content[0] as {type: 'text'; text: string}).text
    expect(text).toMatch(/Worker exited 1/)
    expect(text).toMatch(/kaboom/)
    cache.close()
})

test('pi-worker-docs reports indexedFiles:0 for package with no .d.ts and no README', async () => {
    const cache = openCache(':memory:')
    const result = await runTool(
        {
            openCache: () => cache,
            npmVersionLookup: async () => null,
            spawn: fakeSpawnSimple('<answer>nothing to read</answer>\n<excerpt>nothing</excerpt>')
        },
        {module: 'empty-pkg', query: 'q'}
    )
    const text = (result.content[0] as {type: 'text'; text: string}).text
    expect(text).toMatch(/no \.d\.ts files or README/)
    const details = result.details as {indexedFiles?: number}
    expect(details.indexedFiles).toBe(0)
    cache.close()
})

test('pi-worker-docs prepends live npm version block and surfaces it in details', async () => {
    const cache = openCache(':memory:')
    const result = await runTool(
        {
            openCache: () => cache,
            npmVersionLookup: async pkg => ({
                pkg,
                latest: '19.0.0',
                recent: ['19.0.0', '18.3.1'],
                publishedAt: '2026-04-10T00:00:00.000Z'
            }),
            spawn: fakeSpawnSimple(
                '<answer>UserService.list()</answer>\n<excerpt>class UserService</excerpt>'
            )
        },
        {module: 'tiny-pkg', query: 'enumerate users'}
    )
    const text = (result.content[0] as {type: 'text'; text: string}).text
    // Position, not just presence: the npm block is the first thing in the text.
    expect(text.indexOf('### npm: tiny-pkg')).toBe(0)
    expect(text).toContain('latest: 19.0.0 (published 2026-04-10)')
    expect(text).toContain('Per tiny-pkg@1.0.0:')
    const details = result.details as {npmLatest?: string; npmPublishedAt?: string}
    expect(details.npmLatest).toBe('19.0.0')
    expect(details.npmPublishedAt).toBe('2026-04-10T00:00:00.000Z')
    cache.close()
})

test('pi-worker-docs falls back to no-cache mode when openCache throws', async () => {
    let promptSeen = ''
    const result = await runTool(
        {
            openCache: () => {
                throw new Error('disk full')
            },
            npmVersionLookup: async () => null,
            spawn: fakeSpawnByPrompt(args => {
                promptSeen = args[args.length - 1]
                return {stdout: '<answer>ok</answer>\n<excerpt>interface User</excerpt>'}
            })
        },
        {module: 'tiny-pkg', query: 'User'}
    )
    const text = (result.content[0] as {type: 'text'; text: string}).text
    expect(text).toContain('Per tiny-pkg@1.0.0:')
    expect(promptSeen).toContain('// index.d.ts') // file header from no-cache concat
    const details = result.details as {cacheError?: string; hitCache?: boolean}
    expect(details.cacheError).toMatch(/disk full/)
    expect(details.hitCache).toBe(false)
})

test('packageRootOf maps a subpath specifier to its package.json key', () => {
    expect(packageRootOf('hono')).toBe('hono')
    expect(packageRootOf('hono/client')).toBe('hono')
    expect(packageRootOf('@scope/name')).toBe('@scope/name')
    expect(packageRootOf('@scope/name/sub/deep')).toBe('@scope/name')
    expect(packageRootOf('  react/jsx-runtime  ')).toBe('react')
})

/**
 * The `module: "."` branch returns before the package path's `logDocsAnswer` call,
 * so it needs its own. Without one, the sink's last row is not the worker's last
 * answer whenever that answer came from this branch.
 *
 * The row must also say the type-only detector was NOT applied here, because it is
 * not: a sink that recorded an invented verdict would let anything counted off it
 * include answers the detector never reaches.
 */
test('a project-source lookup is recorded in the PI_TASK_TYPEONLY_LOG sink', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-project-log-'))
    fs.writeFileSync(
        path.join(dir, 'svc.ts'),
        'export class UserService {\n  list(): string[] {\n    return []\n  }\n}\n',
        'utf8'
    )
    const sink = path.join(dir, 'answers.jsonl')
    const saved = process.env[TYPEONLY_LOG_ENV]
    process.env[TYPEONLY_LOG_ENV] = sink
    const cache = openCache(':memory:')
    try {
        await runTool(
            {
                openCache: () => cache,
                npmVersionLookup: async () => null,
                spawn: fakeSpawnSimple(
                    '<answer>unclear from this project</answer>\n<excerpt>class UserService</excerpt>'
                )
            },
            {module: '.', query: 'what does UserService expose?'},
            dir
        )
        const rows = readTypeOnlyLog(fs.readFileSync(sink, 'utf8'))
        expect(rows.length).toBe(1)
        expect(rows[0].module).toBe('.')
        // The project wording of the honest non-answer must score as unclear, not as valid.
        expect(rows[0].unclear).toBe(true)
        expect(rows[0].typeOnly).toBe(false)
        expect(rows[0].reason).toMatch(/detector is not applied/i)
    } finally {
        cache.close()
        if (saved === undefined) delete process.env[TYPEONLY_LOG_ENV]
        else process.env[TYPEONLY_LOG_ENV] = saved
        fs.rmSync(dir, {recursive: true, force: true})
    }
})

/**
 * The project-docs budget is off unless PI_TASK_PROJECT_DOCS_BUDGET is set
 * (task/research-fanout-budget.ts), so this test sets it.
 *
 * The property that matters is WHERE the refusal happens: before the child spawn.
 * The cost the budget exists to remove is the summarising model pass each
 * project-source lookup runs, so a refusal that still spawns saves nothing.
 */
test('a project-docs budget refuses further "." lookups without spawning', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-budget-'))
    fs.writeFileSync(path.join(dir, 'svc.ts'), 'export class UserService {}\n', 'utf8')
    const saved = process.env[PROJECT_DOCS_BUDGET_ENV]
    process.env[PROJECT_DOCS_BUDGET_ENV] = '2'
    const cache = openCache(':memory:')
    let spawns = 0
    try {
        const {registered, api} = makePi()
        registerPiWorkerDocs(api as unknown as Parameters<typeof registerPiWorkerDocs>[0], {
            openCache: () => cache,
            npmVersionLookup: async () => null,
            spawn: fakeSpawnByPrompt(() => {
                spawns++
                return {
                    stdout: '<answer>it exposes list()</answer>\n<excerpt>class UserService</excerpt>'
                }
            })
        })
        const call = (query: string, module = '.'): Promise<AgentToolResult<unknown>> =>
            registered[0].execute('id', {module, query}, undefined, undefined, {cwd: dir})
        const textOf = (r: AgentToolResult<unknown>): string =>
            (r.content[0] as {type: 'text'; text: string}).text

        expect(textOf(await call('q1'))).toContain('UserService')
        expect(textOf(await call('q2'))).toContain('UserService')
        const third = await call('q3')
        expect(textOf(third)).toContain('BUDGET SPENT')
        expect((third.details as {budgetSpent?: boolean}).budgetSpent).toBe(true)
        // The refusal cost nothing: the two allowed calls each spawned once, the
        // refused one did not spawn at all.
        expect(spawns).toBe(2)
    } finally {
        cache.close()
        if (saved === undefined) delete process.env[PROJECT_DOCS_BUDGET_ENV]
        else process.env[PROJECT_DOCS_BUDGET_ENV] = saved
        fs.rmSync(dir, {recursive: true, force: true})
    }
})

test('the budget counts ONLY project-source lookups — package docs are untouched', async () => {
    const saved = process.env[PROJECT_DOCS_BUDGET_ENV]
    process.env[PROJECT_DOCS_BUDGET_ENV] = '1'
    const cache = openCache(':memory:')
    try {
        const {registered, api} = makePi()
        registerPiWorkerDocs(api as unknown as Parameters<typeof registerPiWorkerDocs>[0], {
            openCache: () => cache,
            npmVersionLookup: async () => null,
            spawn: fakeSpawnByPrompt(() => ({
                stdout: '<answer>Use UserService.list().</answer>\n<excerpt>class UserService</excerpt>'
            }))
        })
        const call = (module: string): Promise<AgentToolResult<unknown>> =>
            registered[0].execute(
                'id',
                {module, query: 'how do I list users?'},
                undefined,
                undefined,
                {
                    cwd: FIXTURES
                }
            )
        for (let i = 0; i < 3; i++) {
            const text = ((await call('tiny-pkg')).content[0] as {type: 'text'; text: string}).text
            expect(text).toContain('Per tiny-pkg@1.0.0:')
        }
    } finally {
        cache.close()
        if (saved === undefined) delete process.env[PROJECT_DOCS_BUDGET_ENV]
        else process.env[PROJECT_DOCS_BUDGET_ENV] = saved
    }
})

test('a docs ERROR still reports the auto-install provenance its siblings report', async () => {
    // `docsRaw` sets `autoInstallPin` on the error returns that follow an
    // auto-install, and all three arms — `ok`, `no_chunks` and `error` — flatten it
    // into details through `pinDetails`. Without it on the error arm, a package
    // auto-installed AT A DECLARED RANGE and then failed loses the
    // `versionSource`/`declaredRange` saying which range was pulled — on the one
    // path where that is the explanation.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-docs-pin-'))
    fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({name: 'host', dependencies: {'never-installed-pkg': '^2.3.4'}})
    )
    try {
        const result = await runTool(
            {
                openCache: () => openCache(':memory:'),
                npmVersionLookup: async () => null,
                resolvePackage: () => {
                    throw new ResolveError('not_installed', 'not installed')
                },
                // The install attempt fails, so docsRaw returns its `install`-stage
                // error — which carries the pin it read from package.json.
                spawn: fakeSpawnSimple('', 1, 'E404 Not Found')
            },
            {module: 'never-installed-pkg', query: 'anything?'},
            dir
        )

        const details = result.details as Record<string, unknown>
        expect(details.resolveError).toBe('not_installed')
        expect(details.declaredRange).toBe('^2.3.4')
        expect(details.versionSource).toBeDefined()
    } finally {
        fs.rmSync(dir, {recursive: true, force: true})
    }
})

test('the description keeps the A/B-validated imperatives verbatim', () => {
    const {registered, api} = makePi()
    registerPiWorkerDocs(api as unknown as Parameters<typeof registerPiWorkerDocs>[0], {})
    const d = (registered[0] as unknown as {description: string}).description
    for (const line of [
        'USE THIS BEFORE ANSWERING',
        'Do NOT answer package APIs from memory',
        'do NOT run `npm view`/bash to get a package version',
        'do NOT web-search for an installed package'
    ]) {
        expect(d).toContain(line)
    }
})

test('the description names the manifests it reads and says it refuses otherwise', () => {
    const {registered, api} = makePi()
    registerPiWorkerDocs(api as unknown as Parameters<typeof registerPiWorkerDocs>[0], {})
    const d = (registered[0] as unknown as {description: string}).description
    expect(d).toContain(
        'SUPPORTED ECOSYSTEMS: npm (package.json), cargo (Cargo.toml), hackage (*.cabal)'
    )
    expect(d).toContain('REFUSES and installs nothing')
})

test('a directory with no manifest is refused, and nothing is spawned or fetched', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-no-manifest-'))
    fs.writeFileSync(path.join(dir, 'foo.txt'), 'not a manifest', 'utf8')
    let spawns = 0
    let versionCalls = 0
    const result = await runTool(
        {
            openCache: () => {
                throw new Error('cache must not open')
            },
            npmVersionLookup: async () => {
                versionCalls++
                return null
            },
            spawn: fakeSpawnByPrompt(() => {
                spawns++
                return {stdout: ''}
            })
        },
        {module: 'aeson', query: 'decode a ByteString'},
        dir
    )
    const details = result.details as {resolveError?: string}
    expect(details.resolveError).toBe('unsupported_ecosystem')
    const text = (result.content[0] as {type: 'text'; text: string}).text
    expect(text).toContain('package.json')
    expect(text).toContain('pi-worker-search')
    expect(spawns).toBe(0)
    expect(versionCalls).toBe(0)
    fs.rmSync(dir, {recursive: true, force: true})
})

test('an ecosystem the directory does not hold is refused by name', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-not-detected-'))
    let spawns = 0
    const result = await runTool(
        {
            npmVersionLookup: async () => null,
            spawn: fakeSpawnByPrompt(() => {
                spawns++
                return {stdout: ''}
            })
        },
        {module: 'zod', query: 'z.object', ecosystem: 'npm'},
        dir
    )
    const details = result.details as {resolveError?: string}
    expect(details.resolveError).toBe('unsupported_ecosystem')
    expect((result.content[0] as {type: 'text'; text: string}).text).toContain('No npm project')
    expect(spawns).toBe(0)
    fs.rmSync(dir, {recursive: true, force: true})
})

test('naming the ecosystem scopes the cache key; letting the manifest decide does not', () => {
    expect(docsCacheKey({module: 'zod', query: 'Z Object'})).toBe('zod::z object')
    expect(docsCacheKey({module: 'zod', query: 'Z Object', ecosystem: 'npm'})).toBe(
        'npm::zod::z object'
    )
})
