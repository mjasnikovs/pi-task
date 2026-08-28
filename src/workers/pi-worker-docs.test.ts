import {test, expect} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type {AgentToolResult} from '@earendil-works/pi-agent-core'
import {registerPiWorkerDocs, packageRootOf, type PiWorkerDocsInternals} from './pi-worker-docs.js'
import {openCache} from './docs-cache.js'
import {ResolveError} from './docs-resolve.js'
import {fakeSpawnSimple, fakeSpawnByPrompt} from '../test-utils/fake-spawn.js'
import {readTypeOnlyLog, TYPEONLY_LOG_ENV} from './typeonly-log.js'
import {PROJECT_DOCS_BUDGET_ENV} from '../task/research-fanout-budget.js'

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
    params: {module: string; query: string},
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
            // autoInstall will attempt `npm install does-not-exist`; simulate failure
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
    // npm block leads the output so the agent sees live registry data first.
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
 * INSTRUMENTATION COVERAGE for the project-source branch.
 *
 * `module: "."` is the MAJORITY of what worker:apis asks — 13 of 17 docs calls in run 15's
 * fatal task, 7 of 12 in the first live termination-diagnostic rep — and that branch returns
 * long before the package path's logDocsAnswer call. With it uninstrumented, "the last docs
 * answer before the worker stopped" was unanswerable: the sink's last row was routinely not
 * the worker's last answer, and every project-source abstention scored as a valid answer.
 *
 * The record must also say that the type-only detector was NOT applied here, because it is
 * not: inventing a verdict on this path would let a firing rate computed off this sink count
 * answers the PROMPT 2 lever never reaches.
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
 * CAP arm of nexttask 5B (src/task/research-fanout-budget.ts) — UNWIRED: the
 * budget is off unless PI_TASK_PROJECT_DOCS_BUDGET is set, which only
 * scripts/live-research-fanout-budget-ab.ts does.
 *
 * The property that matters is where the refusal happens: BEFORE the child spawn.
 * The cost this lever exists to remove is the summarising model pass each
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
    // BUG FIX. `docsRaw` records `autoInstallPin` on three of its five error
    // returns, and both the `no_chunks` and `ok` arms flatten it into details —
    // the error arm did not. So a package that was auto-installed AT A DECLARED
    // RANGE and then failed lost the `versionSource`/`declaredRange` that says
    // which range was pulled: the provenance the last defect in this area was
    // about, missing on the one path where it explains the failure.
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
