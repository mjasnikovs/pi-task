import {describe, expect, test} from 'bun:test'
import {runChild, summarizeToolArgs} from './child-process.js'
import {
    fakeSpawnSimple,
    fakeSpawnQueue,
    agentEndResponse,
    makeProc
} from '../test-utils/fake-spawn.js'
import type {LoopHit, SpawnFn} from './child-process.js'

const noopInvocation = {command: 'pi', args: ['--print']}

/** Spawn fake that emits each given raw string as its own stdout 'data' chunk,
 *  then closes. Lets tests control exactly where chunk boundaries fall. */
function fakeSpawnChunks(chunks: string[], exitCode = 0): SpawnFn {
    return (() => {
        const p = makeProc()
        queueMicrotask(() => {
            for (const c of chunks) p.stdout!.emit('data', Buffer.from(c))
            p.emit('close', exitCode)
        })
        return p
    }) as unknown as SpawnFn
}

describe('runChild text mode', () => {
    test('collects stdout, stderr, exitCode', async () => {
        const spawn = fakeSpawnSimple('hello world', 0, 'warn')
        const result = await runChild(spawn, noopInvocation, '/tmp', undefined, {mode: 'text'})
        expect(result.stdout).toBe('hello world')
        expect(result.stderr).toBe('warn')
        expect(result.exitCode).toBe(0)
        expect(result.aborted).toBe(false)
        expect(result.text).toBeUndefined()
    })

    test('reports non-zero exit', async () => {
        const spawn = fakeSpawnSimple('output', 42)
        const result = await runChild(spawn, noopInvocation, '/tmp', undefined, {mode: 'text'})
        expect(result.exitCode).toBe(42)
        expect(result.stdout).toBe('output')
    })

    test('fires onFirstByte exactly once on the first stdout chunk', async () => {
        let fired = 0
        const spawn = fakeSpawnSimple('hello world')
        await runChild(spawn, noopInvocation, '/tmp', undefined, {
            mode: 'text',
            onFirstByte: () => fired++
        })
        expect(fired).toBe(1)
    })

    test('does not fire onFirstByte when stdout is empty', async () => {
        let fired = 0
        const spawn = fakeSpawnSimple('', 0, 'stderr-only')
        await runChild(spawn, noopInvocation, '/tmp', undefined, {
            mode: 'text',
            onFirstByte: () => fired++
        })
        expect(fired).toBe(0)
    })
})

describe('runChild json-events mode', () => {
    test('returns final assistant text from agent_end', async () => {
        const spawn = fakeSpawnSimple(
            JSON.stringify(agentEndResponse('the answer').events[0]) + '\n'
        )
        const result = await runChild(spawn, noopInvocation, '/tmp', undefined, {
            mode: 'json-events'
        })
        expect(result.text).toBe('the answer')
    })

    test('falls back to text_delta accumulation', async () => {
        const events = [
            {type: 'message_update', assistantMessageEvent: {type: 'text_start'}},
            {type: 'message_update', assistantMessageEvent: {type: 'text_delta', delta: 'hello '}},
            {type: 'message_update', assistantMessageEvent: {type: 'text_delta', delta: 'world'}}
        ]
        const stdout = events.map(e => JSON.stringify(e) + '\n').join('')
        const spawn = fakeSpawnSimple(stdout)
        const result = await runChild(spawn, noopInvocation, '/tmp', undefined, {
            mode: 'json-events'
        })
        expect(result.text).toBe('hello world')
    })

    test('emits onLine on text_start', async () => {
        const events = [{type: 'message_update', assistantMessageEvent: {type: 'text_start'}}]
        const stdout = events.map(e => JSON.stringify(e) + '\n').join('')
        const spawn = fakeSpawnSimple(stdout)
        const lines: string[] = []
        await runChild(spawn, noopInvocation, '/tmp', undefined, {
            mode: 'json-events',
            onLine: l => lines.push(l)
        })
        expect(lines).toContain('writing answer…')
    })

    test('emits onLine on tool_execution_start with summary', async () => {
        const events = [{type: 'tool_execution_start', toolName: 'bash', args: {command: 'ls -la'}}]
        const stdout = events.map(e => JSON.stringify(e) + '\n').join('')
        const spawn = fakeSpawnSimple(stdout)
        const lines: string[] = []
        await runChild(spawn, noopInvocation, '/tmp', undefined, {
            mode: 'json-events',
            onLine: l => lines.push(l)
        })
        expect(lines).toContain('bash: ls -la')
    })

    test('emits onContextUsage on context_usage event', async () => {
        const events = [{type: 'context_usage', tokens: 1000, contextWindow: 200000, percent: 0.5}]
        const stdout = events.map(e => JSON.stringify(e) + '\n').join('')
        const spawn = fakeSpawnSimple(stdout)
        const snapshots: Array<{tokens: number; contextWindow: number; percent: number}> = []
        await runChild(spawn, noopInvocation, '/tmp', undefined, {
            mode: 'json-events',
            onContextUsage: s => snapshots.push(s)
        })
        expect(snapshots).toHaveLength(1)
        expect(snapshots[0].tokens).toBe(1000)
        expect(snapshots[0].contextWindow).toBe(200000)
    })

    test('parses an event whose JSON is split across two data chunks', async () => {
        const line = JSON.stringify(agentEndResponse('split answer').events[0]) + '\n'
        const mid = Math.floor(line.length / 2)
        const spawn = fakeSpawnChunks([line.slice(0, mid), line.slice(mid)])
        const result = await runChild(spawn, noopInvocation, '/tmp', undefined, {
            mode: 'json-events'
        })
        expect(result.text).toBe('split answer')
    })

    test('flushes a final event that is not newline-terminated', async () => {
        // No trailing '\n' — the event only completes at close.
        const line = JSON.stringify(agentEndResponse('no newline').events[0])
        const spawn = fakeSpawnChunks([line])
        const result = await runChild(spawn, noopInvocation, '/tmp', undefined, {
            mode: 'json-events'
        })
        expect(result.text).toBe('no newline')
    })

    test('does not buffer the raw stream into stdout (prevents string-length overflow)', async () => {
        // A large multi-chunk json-events stream must not accumulate in stdout.
        const deltas = Array.from({length: 50}, (_, i) => ({
            type: 'message_update',
            assistantMessageEvent: {type: 'text_delta', delta: `x${i} `}
        }))
        const chunks = [
            JSON.stringify({type: 'message_update', assistantMessageEvent: {type: 'text_start'}})
                + '\n',
            ...deltas.map(e => JSON.stringify(e) + '\n')
        ]
        const spawn = fakeSpawnChunks(chunks)
        const result = await runChild(spawn, noopInvocation, '/tmp', undefined, {
            mode: 'json-events'
        })
        // Text is still assembled from the deltas…
        expect(result.text).toContain('x0')
        expect(result.text).toContain('x49')
        // …but the raw event bytes were dropped, not buffered.
        expect(result.stdout).toBe('')
    })

    test('onToolCall returning a LoopHit triggers process kill and sets aborted', async () => {
        const events = [
            {type: 'tool_execution_start', toolName: 'bash', args: {command: 'echo hi'}}
        ]
        const stdout = events.map(e => JSON.stringify(e) + '\n').join('')
        const spawn = fakeSpawnSimple(stdout)
        const hit: LoopHit = {
            call: {name: 'bash', args: {command: 'echo hi'}},
            count: 5,
            windowSize: 5
        }
        const result = await runChild(spawn, noopInvocation, '/tmp', undefined, {
            mode: 'json-events',
            onToolCall: () => hit
        })
        expect(result.aborted).toBe(true)
    })

    test('falls back to stderr when no text events are produced (exit 0)', async () => {
        // Simulates a model API error that exits 0 with no assistant text but
        // an error message on stderr. The stderr should surface as the text so
        // the caller sees the real error instead of "child produced no output".
        const spawn = fakeSpawnSimple('', 0, 'model backend error: connection reset')
        const result = await runChild(spawn, noopInvocation, '/tmp', undefined, {
            mode: 'json-events'
        })
        expect(result.text).toBe('model backend error: connection reset')
        expect(result.exitCode).toBe(0)
    })

    test('text_delta accumulation takes precedence over stderr', async () => {
        // When both text_delta and stderr exist, text_delta wins.
        const spawn = fakeSpawnQueue([
            {
                events: [
                    {type: 'message_update', assistantMessageEvent: {type: 'text_start'}},
                    {type: 'message_update', assistantMessageEvent: {type: 'text_delta', delta: 'real output'}}
                ],
                stderr: 'some warning'
            }
        ])
        const result = await runChild(spawn, noopInvocation, '/tmp', undefined, {
            mode: 'json-events'
        })
        expect(result.text).toBe('real output')
    })
})

describe('summarizeToolArgs', () => {
    test('bash command joined to single line', () => {
        expect(summarizeToolArgs('bash', {command: 'ls  -la\n/tmp'})).toBe('ls -la /tmp')
    })

    test('file_path field', () => {
        expect(summarizeToolArgs('read', {file_path: '/src/foo.ts'})).toBe('/src/foo.ts')
    })

    test('pattern field', () => {
        expect(summarizeToolArgs('grep', {pattern: 'runChild'})).toBe('runChild')
    })

    test('returns empty string when no recognised field', () => {
        expect(summarizeToolArgs('unknown', {data: 'xyz'})).toBe('')
    })
})
