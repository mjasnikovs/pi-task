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
    restarts: string[]
    modelError?: string
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
    expect(r.details.restarts).toEqual(['connection-error', 'connection-error'])
})

test('a discarded attempt behind an empty final answer is visible in details', async () => {
    const r = await runTool([agentErrorResponse('Connection error.'), emptyClean])
    expect(r.details.attempts).toBe(2)
    expect(r.details.restarts).toEqual(['connection-error'])
    expect(r.text).toContain('connection-error')
})
