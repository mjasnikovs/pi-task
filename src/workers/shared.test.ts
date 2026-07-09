import {test, expect, afterEach} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {Type} from '@sinclair/typebox'
import {Text} from '@earendil-works/pi-tui'
import {formatChildFailure, makeWorkerTool} from './shared.js'
import {RESEARCH_RUN_ID_ENV} from './research-cache.js'

// ─── formatChildFailure ──────────────────────────────────────────────────────

test('formatChildFailure returns null on a clean exit', () => {
    expect(formatChildFailure({aborted: false, exitCode: 0, stderr: ''}, 'aborted')).toBeNull()
})

test('formatChildFailure returns the abort message when aborted (even on exit 0)', () => {
    expect(
        formatChildFailure({aborted: true, exitCode: 0, stderr: 'noise'}, 'Fetch aborted.')
    ).toBe('Fetch aborted.')
})

test('formatChildFailure reports a non-zero exit with a trimmed stderr tail', () => {
    const msg = formatChildFailure(
        {aborted: false, exitCode: 2, stderr: '  \n boom \n  '},
        'aborted'
    )
    expect(msg).toBe('Worker exited 2.\nboom')
})

test('formatChildFailure caps the stderr tail at 500 chars', () => {
    const msg = formatChildFailure(
        {aborted: false, exitCode: 1, stderr: 'x'.repeat(900)},
        'aborted'
    )!
    expect(msg.startsWith('Worker exited 1.\n')).toBe(true)
    expect(msg.length).toBe('Worker exited 1.\n'.length + 500)
})

test('formatChildFailure falls back to (no stderr) when empty', () => {
    expect(formatChildFailure({aborted: false, exitCode: 1, stderr: '   '}, 'aborted')).toBe(
        'Worker exited 1.\n(no stderr)'
    )
})

// ─── makeWorkerTool ──────────────────────────────────────────────────────────

interface RegisteredTool {
    name: string
    label: string
    executionMode?: string
    execute: (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: unknown,
        ctx?: unknown
    ) => Promise<{content: {type: string; text: string}[]; details: unknown}>
    renderCall?: (args: unknown, theme: unknown) => unknown
}

function makePi(): {
    registered: RegisteredTool[]
    api: {registerTool: (t: RegisteredTool) => void}
} {
    const registered: RegisteredTool[] = []
    return {registered, api: {registerTool: t => registered.push(t)}}
}

const Params = Type.Object({q: Type.String()})

test('makeWorkerTool registers a parallel tool and wraps run output in textResult', async () => {
    const {registered, api} = makePi()
    let seenCwd = ''
    makeWorkerTool<typeof Params, {n: number}>(
        api as unknown as Parameters<typeof makeWorkerTool>[0],
        {
            name: 'demo',
            label: 'Demo',
            description: 'd',
            parameters: Params,
            async run(params, _signal, ctx) {
                seenCwd = ctx.cwd
                return {text: `got ${params.q}`, details: {n: params.q.length}}
            },
            renderCall: args => new Text(args.q, 0, 0)
        }
    )

    expect(registered).toHaveLength(1)
    const tool = registered[0]
    expect(tool.name).toBe('demo')
    expect(tool.executionMode).toBe('parallel')

    const result = await tool.execute('id', {q: 'hello'}, undefined, undefined, {cwd: '/work'})
    expect(seenCwd).toBe('/work')
    expect(result.content[0]).toEqual({type: 'text', text: 'got hello'})
    expect(result.details).toEqual({n: 5})
})

test('makeWorkerTool delegates renderCall to the spec', () => {
    const {registered, api} = makePi()
    makeWorkerTool<typeof Params, unknown>(api as unknown as Parameters<typeof makeWorkerTool>[0], {
        name: 'demo',
        label: 'Demo',
        description: 'd',
        parameters: Params,
        run: async () => ({text: '', details: undefined}),
        renderCall: args => new Text(`rendered:${args.q}`, 0, 0)
    })
    const rendered = registered[0].renderCall!({q: 'x'}, {})
    expect(rendered).toBeInstanceOf(Text)
})

// ─── makeWorkerTool per-run research cache (F10) ──────────────────────────────

const savedRunId = process.env[RESEARCH_RUN_ID_ENV]
afterEach(() => {
    if (savedRunId === undefined) delete process.env[RESEARCH_RUN_ID_ENV]
    else process.env[RESEARCH_RUN_ID_ENV] = savedRunId
})

function tmpCwd(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'shared-cache-'))
}

/** A cacheable demo tool that counts run() invocations. */
function cachingTool(opts?: {
    cacheKey?: (p: {q: string}) => string | null
    cacheable?: (d: {n: number}, t: string) => boolean
}): {registered: RegisteredTool[]; calls: () => number} {
    const {registered, api} = makePi()
    let calls = 0
    makeWorkerTool<typeof Params, {n: number}>(
        api as unknown as Parameters<typeof makeWorkerTool>[0],
        {
            name: 'demo',
            label: 'Demo',
            description: 'd',
            parameters: Params,
            async run(params) {
                calls++
                return {text: `answer:${params.q}:${calls}`, details: {n: calls}}
            },
            renderCall: args => new Text(args.q, 0, 0),
            cacheKey: opts?.cacheKey ?? (p => p.q),
            cacheable: opts?.cacheable ?? (() => true)
        }
    )
    return {registered, calls: () => calls}
}

test('a second identical call in the same run is served from cache (run not re-invoked)', async () => {
    process.env[RESEARCH_RUN_ID_ENV] = 'run-1'
    const cwd = tmpCwd()
    const tool = cachingTool()
    const exec = tool.registered[0].execute

    const first = await exec('id1', {q: 'x'}, undefined, undefined, {cwd})
    expect(first.content[0].text).toBe('answer:x:1')
    const second = await exec('id2', {q: 'x'}, undefined, undefined, {cwd})
    // Identical text + details as the first call, and run() ran only once.
    expect(second.content[0].text).toBe('answer:x:1')
    expect(second.details).toEqual({n: 1})
    expect(tool.calls()).toBe(1)

    // A different query is a miss and runs again.
    const third = await exec('id3', {q: 'y'}, undefined, undefined, {cwd})
    expect(third.content[0].text).toBe('answer:y:2')
    expect(tool.calls()).toBe(2)
})

test('with no run id set, nothing is cached (each call re-runs)', async () => {
    delete process.env[RESEARCH_RUN_ID_ENV]
    const cwd = tmpCwd()
    const tool = cachingTool()
    const exec = tool.registered[0].execute
    await exec('id1', {q: 'x'}, undefined, undefined, {cwd})
    await exec('id2', {q: 'x'}, undefined, undefined, {cwd})
    expect(tool.calls()).toBe(2)
})

test('a cacheKey of null opts a call out of caching (e.g. project-source lookup)', async () => {
    process.env[RESEARCH_RUN_ID_ENV] = 'run-1'
    const cwd = tmpCwd()
    const tool = cachingTool({cacheKey: () => null})
    const exec = tool.registered[0].execute
    await exec('id1', {q: 'x'}, undefined, undefined, {cwd})
    await exec('id2', {q: 'x'}, undefined, undefined, {cwd})
    expect(tool.calls()).toBe(2)
})

test('a non-cacheable result (failure) is not stored — the next call retries', async () => {
    process.env[RESEARCH_RUN_ID_ENV] = 'run-1'
    const cwd = tmpCwd()
    const tool = cachingTool({cacheable: () => false})
    const exec = tool.registered[0].execute
    await exec('id1', {q: 'x'}, undefined, undefined, {cwd})
    await exec('id2', {q: 'x'}, undefined, undefined, {cwd})
    expect(tool.calls()).toBe(2)
})

test('a different run id does not see the prior run cache (isolation through the wrapper)', async () => {
    const cwd = tmpCwd()
    const tool = cachingTool()
    const exec = tool.registered[0].execute
    process.env[RESEARCH_RUN_ID_ENV] = 'run-A'
    await exec('id1', {q: 'x'}, undefined, undefined, {cwd})
    process.env[RESEARCH_RUN_ID_ENV] = 'run-B'
    await exec('id2', {q: 'x'}, undefined, undefined, {cwd})
    expect(tool.calls()).toBe(2)
})
