import {describe, expect, test} from 'bun:test'
import {runChild, summarizeToolArgs} from './child-process.js'
import {fakeSpawnSimple, fakeSpawnQueue, agentEndResponse} from '../test-utils/fake-spawn.js'
import type {LoopHit} from './child-process.js'

const noopInvocation = {command: 'pi', args: ['--print']}

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
