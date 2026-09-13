/**
 * Issue #19: a child that exits 0 with an empty answer and a `modelError`
 * rendered as the literal `(no output)`, and the evidence runWorker had in hand
 * (`modelError`, `attempts`, `restarts`) never reached the caller.
 */
import {test, expect} from 'bun:test'
import type {AgentToolResult} from '@earendil-works/pi-agent-core'
import {registerPiWorker, type PiWorkerInternals} from '../../src/workers/pi-worker.js'
import {
    agentEndResponse,
    agentErrorResponse,
    fakeSpawnQueue,
    type SpawnResponse
} from '../test-utils/fake-spawn.js'

interface RegisteredTool {
    execute: (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: unknown,
        ctx?: unknown
    ) => Promise<AgentToolResult<unknown>>
}

interface Details {
    exitCode: number
    attempts: number
    restarts: Array<{reason: string; detail?: string}>
    modelError?: string
    stderr?: string
}

async function runTool(responses: SpawnResponse[]): Promise<{text: string; details: Details}> {
    const registered: RegisteredTool[] = []
    const api = {registerTool: (t: RegisteredTool) => registered.push(t)}
    const internals: PiWorkerInternals = {
        spawn: fakeSpawnQueue(responses),
        sleepFor: () => Promise.resolve()
    }
    registerPiWorker(api as unknown as Parameters<typeof registerPiWorker>[0], internals)
    const r = await registered[0].execute('id', {prompt: 'q'}, undefined, undefined, {cwd: '/tmp'})
    return {text: (r.content[0] as {text: string}).text, details: r.details as Details}
}

const emptyClean: SpawnResponse = {
    events: [{type: 'agent_end', messages: [{role: 'assistant', content: []}]}],
    exitCode: 0
}

test('a healthy child answers', async () => {
    const r = await runTool([agentEndResponse('REAL CHILD ANSWER')])
    expect(r.text).toBe('REAL CHILD ANSWER')
    expect(r.details.attempts).toBe(1)
})

test('a model error with no text is named, not rendered as "(no output)"', async () => {
    const r = await runTool([agentErrorResponse('AI_APICallError: 429 rate limit exceeded')])
    expect(r.text).not.toBe('(no output)')
    expect(r.text).toContain('429 rate limit exceeded')
    expect(r.details.modelError).toBe('AI_APICallError: 429 rate limit exceeded')
    // A 429 is retried on the connection budget, so the spawns it cost are on record.
    expect(r.details.attempts).toBe(3)
    expect(r.details.restarts.map(x => x.reason)).toEqual(['connection-error', 'connection-error'])
})

test('a discarded attempt behind an empty final answer is visible in details', async () => {
    const r = await runTool([agentErrorResponse('Connection error.'), emptyClean])
    expect(r.details.attempts).toBe(2)
    expect(r.details.restarts.map(x => x.reason)).toEqual(['connection-error'])
    expect(r.text).toContain('connection-error')
})

test('a discarded attempt keeps its OWN error text — modelError/stderr describe the final attempt only', async () => {
    // runWorker records the discarded cause in WorkerRestart.detail; the reason
    // tag alone ('connection-error') is not the 503 body or the auth failure.
    const r = await runTool([agentErrorResponse('Connection error.'), emptyClean])
    expect(r.details.modelError).toBeUndefined()
    expect(r.details.restarts[0]).toMatchObject({
        reason: 'connection-error',
        detail: expect.stringContaining('Connection error.')
    })
})

test('a model error that survives next to text is NOT returned as an answer', async () => {
    // The sink keeps a modelError only when the error came AFTER the last text,
    // so this fragment is a run the provider cut mid-sentence. The dispatching
    // model must not receive it as a finished conclusion.
    const r = await runTool([
        {
            events: [
                {
                    type: 'agent_end',
                    messages: [
                        {
                            role: 'assistant',
                            content: [{type: 'text', text: 'The handler is in src/'}]
                        },
                        {
                            role: 'assistant',
                            content: [{type: 'text', text: ''}],
                            stopReason: 'error',
                            errorMessage: 'AI_APICallError: 503'
                        }
                    ]
                }
            ],
            exitCode: 0
        }
    ])
    expect(r.text).not.toBe('The handler is in src/')
    expect(r.text).toContain('503')
    expect(r.details.modelError).toBe('AI_APICallError: 503')
})

test('a child that never wrote a byte is named as dead, not "(no output)"', async () => {
    // sawOutput false: died at startup. The stderr tail is the only evidence,
    // and it has to reach the TEXT — details never reach the model.
    const r = await runTool([{events: [], exitCode: 0, stderr: 'error: unknown model "nope"'}])
    expect(r.text).not.toBe('(no output)')
    expect(r.text).toContain('never wrote')
    expect(r.text).toContain('unknown model "nope"')
})
