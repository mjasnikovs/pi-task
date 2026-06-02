import {test, expect} from 'bun:test'
import * as path from 'node:path'
import type {AgentToolResult} from '@earendil-works/pi-agent-core'
import {registerPiWorkerDocs, type PiWorkerDocsInternals} from './pi-worker-docs.js'
import {openCache} from './docs-cache.js'
import {fakeSpawnSimple, fakeSpawnByPrompt} from '../test-utils/fake-spawn.js'

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
