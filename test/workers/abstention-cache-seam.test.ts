/**
 * The abstention cache gate, tested at the seam the SHIPPED predicates see.
 *
 * `isAbstention` is anchored, and its two scoring callers hand it the child's bare
 * `<answer>`. Its two CACHE callers do not: `makeWorkerTool` passes the final tool
 * text, which leads with a provenance header (`Per zod@4.5.4:`) or an excerpt NOTE.
 * An anchored matcher scored every one of those as a real answer, so a docs dead
 * end was memoised for the whole run and re-served to every later sibling — the
 * exact failure the gate exists to prevent.
 *
 * These tests therefore assert on what the tool actually returns, never on a
 * hand-written answer string: a test that retypes the child's answer cannot see the
 * header the predicate is really given.
 */
import {test, expect} from 'bun:test'
import * as path from 'node:path'
import type {AgentToolResult} from '@earendil-works/pi-agent-core'
import {
    docsCacheable,
    registerPiWorkerDocs,
    type PiWorkerDocsInternals
} from '../../src/workers/pi-worker-docs.js'
import {
    fetchCacheable,
    registerPiWorkerFetch,
    type PiWorkerFetchInternals
} from '../../src/workers/pi-worker-fetch.js'
import {openCache} from '../../src/workers/docs-cache.js'
import {fakeSpawnSimple} from '../test-utils/fake-spawn.js'

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

async function runDocs(
    internals: PiWorkerDocsInternals,
    params: {module: string; query: string}
): Promise<AgentToolResult<unknown>> {
    const registered: RegisteredTool[] = []
    registerPiWorkerDocs(
        {registerTool: (t: RegisteredTool) => registered.push(t)} as unknown as Parameters<
            typeof registerPiWorkerDocs
        >[0],
        internals
    )
    return registered[0].execute('id', params, undefined, undefined, {cwd: FIXTURES})
}

const textOf = (r: AgentToolResult<unknown>): string =>
    (r.content[0] as {type: 'text'; text: string}).text

test('a package abstention is not cached, header and all', async () => {
    const cache = openCache(':memory:')
    const result = await runDocs(
        {
            openCache: () => cache,
            npmVersionLookup: async () => null,
            spawn: fakeSpawnSimple('<answer>unclear from this package</answer>')
        },
        {module: 'rpc-client-pkg', query: 'what does baseUrl mean?'}
    )
    const text = textOf(result)
    // The header is the whole defect: it stands between position 0 and the sentinel.
    expect(text).toMatch(/^Per /)
    expect(text).toContain('unclear from this package')
    expect(docsCacheable(result.details as Parameters<typeof docsCacheable>[0])).toBe(false)
    cache.close()
})

test('a real package answer is still cached', async () => {
    // Without this control the gate could pass by refusing everything, which costs a
    // fresh child for every sibling that asks the same question.
    const cache = openCache(':memory:')
    const result = await runDocs(
        {
            openCache: () => cache,
            npmVersionLookup: async () => null,
            spawn: fakeSpawnSimple(
                '<answer>Pass the server origin as baseUrl; it is prepended to every '
                    + 'request path.</answer>'
            )
        },
        {module: 'rpc-client-pkg', query: 'what does baseUrl mean?'}
    )
    expect(textOf(result)).toContain('baseUrl')
    expect(docsCacheable(result.details as Parameters<typeof docsCacheable>[0])).toBe(true)
    cache.close()
})

async function runFetch(
    internals: PiWorkerFetchInternals,
    params: {url: string; query: string}
): Promise<AgentToolResult<unknown>> {
    const registered: RegisteredTool[] = []
    registerPiWorkerFetch(
        {registerTool: (t: RegisteredTool) => registered.push(t)} as unknown as Parameters<
            typeof registerPiWorkerFetch
        >[0],
        internals
    )
    return registered[0].execute('id', params, undefined, undefined, {cwd: '/tmp'})
}

test('a fetch abstention behind an excerpt warning is not cached', async () => {
    // Rule 4 asks for the closest related text in <excerpt>, so an abstention's excerpt
    // routinely fails verification — and the tool text then leads with the note, not
    // with the sentinel.
    const result = await runFetch(
        {
            fetchAndClean: () =>
                Promise.resolve({
                    title: 'Client',
                    markdown: '# Client\n\nThe client posts JSON.',
                    finalUrl: 'https://example.com/client'
                }),
            spawn: fakeSpawnSimple(
                '<answer>unclear from this page</answer>'
                    + '<excerpt>retries are configured per call</excerpt>'
            )
        },
        {url: 'https://example.com/client', query: 'how are retries configured?'}
    )
    expect(textOf(result)).toMatch(/^(NOTE|WARNING):/)
    expect(fetchCacheable(result.details as Parameters<typeof fetchCacheable>[0])).toBe(false)
})

test('a fetch answer that merely mentions the phrase is still cached', () => {
    expect(
        fetchCacheable({
            answer: 'The retry count is 3. The backoff policy is unclear from this page.'
        })
    ).toBe(true)
})
