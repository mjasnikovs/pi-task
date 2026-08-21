import {test, expect, afterEach} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {Type} from '@sinclair/typebox'
import {Text} from '@earendil-works/pi-tui'
import {
    childFailureReason,
    formatChildFailure,
    makeWorkerTool,
    workerAnswer,
    workerUnavailable,
    type WorkerOutcome
} from './shared.js'
import {RESEARCH_RUN_ID_ENV, researchCacheFile} from './research-cache.js'

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
                return workerAnswer(`got ${params.q}`, {n: params.q.length})
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
        run: async () => workerAnswer('', undefined),
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
    cachePkg?: (p: {q: string}) => string | undefined
    /** Answer or not. Default: every call answers. */
    outcome?: (text: string, details: {n: number}) => WorkerOutcome<{n: number}>
}): {registered: RegisteredTool[]; calls: () => number} {
    const {registered, api} = makePi()
    const outcome = opts?.outcome ?? workerAnswer
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
                return outcome(`answer:${params.q}:${calls}`, {n: calls})
            },
            renderCall: args => new Text(args.q, 0, 0),
            cacheKey: opts?.cacheKey ?? (p => p.q),
            cachePkg: opts?.cachePkg,
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

test('cachePkg records package provenance on the entry, so a resume can prune per package', async () => {
    process.env[RESEARCH_RUN_ID_ENV] = 'run-1'
    const cwd = tmpCwd()
    fs.writeFileSync(
        path.join(cwd, 'package.json'),
        JSON.stringify({name: 'x', dependencies: {hono: '^4.6.0'}}),
        'utf8'
    )
    const tool = cachingTool({cachePkg: p => (p.q === 'hono-q' ? 'hono' : undefined)})
    const exec = tool.registered[0].execute
    await exec('id1', {q: 'hono-q'}, undefined, undefined, {cwd})
    await exec('id2', {q: 'search-q'}, undefined, undefined, {cwd})

    const file = JSON.parse(fs.readFileSync(researchCacheFile(cwd), 'utf8')) as {
        entries: Record<string, {pkg?: string; pkgVersion?: string}>
    }
    expect(file.entries['demo\u0000hono-q']).toMatchObject({pkg: 'hono', pkgVersion: '^4.6.0'})
    // A tool with no cachePkg stores no provenance ⇒ never pruned by a dependency move.
    expect(file.entries['demo\u0000search-q'].pkg).toBeUndefined()
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

// ─── An `unavailable` outcome is never stored ────────────────────────────────
//
// This is the rule the four `cacheable` predicates used to carry as
// `childExitCode === 0`, and got wrong: `runChild` reports `code ?? 0`, so a
// SIGTERM-killed child arrives with exit code 0, every clause passed, and
// "Docs lookup aborted." was memoised for the whole run and re-served to every
// later sibling — with escalation unable to re-fire because the miss never
// recurred. The outcome states it now, so no rule has to derive it.

test('makeWorkerTool never caches an `unavailable`, even when cacheable() says yes', async () => {
    const cwd = tmpCwd()
    process.env[RESEARCH_RUN_ID_ENV] = 'run-unavailable'
    const {registered, calls} = cachingTool({
        // The old rule, faithfully: "the child exited 0, so cache it."
        cacheable: () => true,
        outcome: (text, details) => workerUnavailable(text, details, 'aborted')
    })
    const tool = registered[0]!

    const first = await tool.execute('id', {q: 'hono'}, undefined, undefined, {cwd})
    const second = await tool.execute('id', {q: 'hono'}, undefined, undefined, {cwd})

    // Both calls ran: nothing was served from the cache…
    expect(calls()).toBe(2)
    // …and the second answer is the second run's, not a memoised first.
    expect(first.content[0]).toEqual({type: 'text', text: 'answer:hono:1'})
    expect(second.content[0]).toEqual({type: 'text', text: 'answer:hono:2'})
    // The text still reaches the caller — refusing to CACHE is not refusing to ANSWER.
    expect(await Bun.file(researchCacheFile(cwd)).exists()).toBe(false)
    fs.rmSync(cwd, {recursive: true, force: true})
})

test('an `answer` with the same tool and rule IS cached (the control)', async () => {
    const cwd = tmpCwd()
    process.env[RESEARCH_RUN_ID_ENV] = 'run-answer'
    const {registered, calls} = cachingTool({cacheable: () => true})
    const tool = registered[0]!

    await tool.execute('id', {q: 'hono'}, undefined, undefined, {cwd})
    const second = await tool.execute('id', {q: 'hono'}, undefined, undefined, {cwd})

    expect(calls()).toBe(1)
    expect(second.content[0]).toEqual({type: 'text', text: 'answer:hono:1'})
    fs.rmSync(cwd, {recursive: true, force: true})
})

test('childFailureReason names the kill through the one ordered ladder', () => {
    // A SIGTERM kill sets `aborted` and leaves exitCode 0 — the shape that made
    // the old exit-code derivation say "success".
    expect(childFailureReason({exitCode: 0, aborted: true})).toBe('aborted')
    // A specific cause outranks the generic abort it also sets.
    expect(childFailureReason({exitCode: 0, aborted: true, timedOut: true})).toBe('worker-timeout')
    expect(childFailureReason({exitCode: 3, aborted: false})).toBe('exit')
    // Nothing killed it; the caller simply has no answer to give.
    expect(childFailureReason({exitCode: 0, aborted: false})).toBe('no-answer')
})
