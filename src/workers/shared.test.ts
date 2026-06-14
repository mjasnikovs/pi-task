import {test, expect} from 'bun:test'
import {Type} from '@sinclair/typebox'
import {Text} from '@earendil-works/pi-tui'
import {formatChildFailure, makeWorkerTool} from './shared.js'

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
