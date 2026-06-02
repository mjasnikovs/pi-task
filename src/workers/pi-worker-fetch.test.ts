import {test, expect} from 'bun:test'
import type {AgentToolResult} from '@earendil-works/pi-agent-core'
import {registerPiWorkerFetch, type PiWorkerFetchInternals} from './pi-worker-fetch.js'
import {FetchAndCleanError} from './html-clean.js'
import type {CleanResult} from './html-clean.js'
import {fakeSpawnSimple, fakeSpawnByPrompt} from '../test-utils/fake-spawn.js'

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
    return {
        registered,
        api: {registerTool: (t: RegisteredTool) => registered.push(t)}
    }
}

async function runTool(
    internals: PiWorkerFetchInternals,
    params: {url: string; query: string}
): Promise<AgentToolResult<unknown>> {
    const {registered, api} = makePi()
    registerPiWorkerFetch(api as unknown as Parameters<typeof registerPiWorkerFetch>[0], internals)
    return registered[0].execute('id', params, undefined, undefined, {cwd: '/tmp'})
}

test('pi-worker-fetch always extracts via child pi, even for short pages', async () => {
    const cleaned: CleanResult = {
        title: 'Short',
        markdown: '# Short\n\nA tiny page.',
        finalUrl: 'https://example.com/short'
    }
    let promptSeen = ''
    const result = await runTool(
        {
            fetchAndClean: () => Promise.resolve(cleaned),
            spawn: fakeSpawnByPrompt(args => {
                promptSeen = args[args.length - 1]
                return {stdout: '<answer>A tiny page.</answer>\n<excerpt>A tiny page.</excerpt>'}
            })
        },
        {url: 'https://example.com/short', query: 'what is this?'}
    )

    const text = (result.content[0] as {type: 'text'; text: string}).text
    expect(text).toContain('A tiny page.')
    expect(text).toContain('Source excerpt:')
    expect(promptSeen).toContain('<question>what is this?</question>')
    expect(promptSeen).toContain('A tiny page.')
    const details = result.details as {answer?: string; excerpt?: string; excerptVerified?: boolean}
    expect(details.answer).toBe('A tiny page.')
    expect(details.excerpt).toBe('A tiny page.')
    expect(details.excerptVerified).toBe(true)
})

test('pi-worker-fetch parses structured output from child pi', async () => {
    const longMarkdown = `${'x'.repeat(5000)}\nThe answer is 42.\n${'y'.repeat(5000)}`
    const cleaned: CleanResult = {
        title: 'Long',
        markdown: longMarkdown,
        finalUrl: 'https://example.com/long'
    }
    let receivedArgs: ReadonlyArray<string> = []
    const result = await runTool(
        {
            fetchAndClean: () => Promise.resolve(cleaned),
            spawn: fakeSpawnByPrompt(args => {
                receivedArgs = args
                return {
                    stdout: '<answer>The answer is 42.</answer>\n<excerpt>The answer is 42.</excerpt>'
                }
            })
        },
        {url: 'https://example.com/long', query: 'what is the answer?'}
    )

    const text = (result.content[0] as {type: 'text'; text: string}).text
    expect(text).toContain('The answer is 42.')
    expect(text).toContain('Source excerpt:')
    expect(text).not.toMatch(/WARNING/)
    expect(receivedArgs).toContain('--no-tools')
    expect(receivedArgs).toContain('--print')
    const details = result.details as {excerptVerified?: boolean}
    expect(details.excerptVerified).toBe(true)
})

test('pi-worker-fetch flags excerpt not found in page text', async () => {
    const cleaned: CleanResult = {
        title: 'X',
        markdown: 'Some unrelated page content here.',
        finalUrl: 'https://example.com/x'
    }
    const result = await runTool(
        {
            fetchAndClean: () => Promise.resolve(cleaned),
            spawn: fakeSpawnSimple(
                '<answer>The page is about cats.</answer>\n<excerpt>Cats are great pets.</excerpt>'
            )
        },
        {url: 'https://example.com/x', query: 'what is this about?'}
    )

    const text = (result.content[0] as {type: 'text'; text: string}).text
    expect(text).toMatch(/WARNING: cited excerpt not found/)
    const details = result.details as {excerptVerified?: boolean}
    expect(details.excerptVerified).toBe(false)
})

test('pi-worker-fetch falls back to raw stdout when child omits tags', async () => {
    const cleaned: CleanResult = {
        title: 'X',
        markdown: 'something',
        finalUrl: 'https://example.com/x'
    }
    const result = await runTool(
        {
            fetchAndClean: () => Promise.resolve(cleaned),
            spawn: fakeSpawnSimple('plain unstructured reply')
        },
        {url: 'https://example.com/x', query: 'q'}
    )

    const text = (result.content[0] as {type: 'text'; text: string}).text
    expect(text).toBe('plain unstructured reply')
    const details = result.details as {answer?: string; excerpt?: string}
    expect(details.answer).toBe('plain unstructured reply')
    expect(details.excerpt).toBeUndefined()
})

test('pi-worker-fetch truncates oversized markdown with bookend marker', async () => {
    const huge = 'a'.repeat(40_000)
    let promptSeen = ''
    const result = await runTool(
        {
            fetchAndClean: () =>
                Promise.resolve({
                    title: 'Huge',
                    markdown: huge,
                    finalUrl: 'https://example.com/huge'
                }),
            spawn: fakeSpawnByPrompt(args => {
                promptSeen = args[args.length - 1]
                return {stdout: 'ok'}
            })
        },
        {url: 'https://example.com/huge', query: 'q'}
    )
    expect(promptSeen).toContain('[...page continues, truncated...]')
    // The prompt contains the first 25k + marker + last 5k = 30k+marker of content,
    // wrapped in a longer surrounding prompt template.
    expect(result.content[0]).toBeDefined()
})

test('pi-worker-fetch returns Invalid URL error on parse failure', async () => {
    const result = await runTool(
        {
            fetchAndClean: () => Promise.reject(new Error('should not be called')),
            spawn: () => {
                throw new Error('should not be called')
            }
        },
        {url: 'not-a-url', query: 'q'}
    )
    const text = (result.content[0] as {type: 'text'; text: string}).text
    expect(text).toMatch(/Invalid URL/)
})

test('pi-worker-fetch surfaces FetchAndCleanError text', async () => {
    const result = await runTool(
        {
            fetchAndClean: () =>
                Promise.reject(
                    new FetchAndCleanError(
                        'https://example.com/big exceeds 2.0 MB size cap. Try a more specific URL.',
                        'too-large'
                    )
                ),
            spawn: () => {
                throw new Error('should not be called')
            }
        },
        {url: 'https://example.com/big', query: 'q'}
    )
    const text = (result.content[0] as {type: 'text'; text: string}).text
    expect(text).toMatch(/exceeds.+size cap/)
})

test('pi-worker-fetch returns Worker exited message on child non-zero exit', async () => {
    const longMarkdown = 'x'.repeat(5000)
    const result = await runTool(
        {
            fetchAndClean: () =>
                Promise.resolve({
                    title: 't',
                    markdown: longMarkdown,
                    finalUrl: 'https://example.com/x'
                }),
            spawn: fakeSpawnSimple('', 1, 'something broke')
        },
        {url: 'https://example.com/x', query: 'q'}
    )
    const text = (result.content[0] as {type: 'text'; text: string}).text
    expect(text).toMatch(/Worker exited 1/)
    expect(text).toMatch(/something broke/)
})
