/**
 * Stream-watchdog integration: a child whose model stream goes SILENT.
 *
 * A real model cannot be asked to hang, and the child is a `pi` PROCESS rather
 * than an HTTP client this code owns, so the only seam a test can drive is the
 * child's event stream. Every child below is a fake `pi` that emits some json
 * events and then produces nothing, ever, closing only when killed: no error,
 * no exit, nothing for a promise to settle on.
 *
 * What these tests pin is that the watchdog aborts at the configured
 * inactivity and the retry path re-spawns.
 */

import {describe, expect, test} from 'bun:test'
import {EventEmitter} from 'node:events'
import {
    runChild as runChildUnified,
    type ProcLike,
    type SpawnFn
} from '../../src/shared/child-process.js'
import {runPhaseChild} from '../../src/task/child-runner.js'
import {runWorker} from '../../src/workers/pi-worker-core.js'
import {getConfig} from '../../src/config/config.js'
import {makeProc, agentEndResponse} from '../test-utils/fake-spawn.js'

/** A short window, so the guard is exercised in milliseconds, not at its default. */
const WINDOW_MS = 120

/**
 * Fake `pi` children, one per queued script. `hang: true` emits the events and then
 * goes mute forever, closing only on kill. It closes with 143, the code a shell
 * reports for a SIGTERM'd child.
 */
function scriptedSpawn(
    scripts: ReadonlyArray<{events: ReadonlyArray<Record<string, unknown>>; hang?: boolean}>
): {spawn: SpawnFn; spawns: number; prompts: string[]} {
    const state = {spawn: undefined as unknown as SpawnFn, spawns: 0, prompts: [] as string[]}
    state.spawn = ((): ProcLike => {
        const script = scripts[Math.min(state.spawns, scripts.length - 1)]!
        state.spawns++
        const p = makeProc()
        p.kill = () => {
            if (p.killed) return true
            p.killed = true
            p.emit('close', 143)
            return true
        }
        const streams = p as EventEmitter & {stdout: EventEmitter; stderr: EventEmitter}
        queueMicrotask(() => {
            state.prompts.push(p.stdinData)
            for (const evt of script.events) {
                streams.stdout.emit('data', Buffer.from(JSON.stringify(evt) + '\n'))
            }
            if (!script.hang) p.emit('close', 0)
        })
        return p
    }) as unknown as SpawnFn
    return state as {spawn: SpawnFn; spawns: number; prompts: string[]}
}

const THINKING = {type: 'message_update', assistantMessageEvent: {type: 'thinking_start'}}
const TEXT = (delta: string) => ({
    type: 'message_update',
    assistantMessageEvent: {type: 'text_delta', delta}
})

describe('runChild stream-inactivity guard', () => {
    test('kills a child that streams events then goes silent, and says why', async () => {
        const s = scriptedSpawn([{events: [THINKING, TEXT('partial ans')], hang: true}])
        const started = Date.now()
        const r = await runChildUnified(
            s.spawn,
            {command: 'pi', args: [], stdin: 'do the thing'},
            '/tmp',
            undefined,
            {mode: 'json-events', streamInactivityMs: WINDOW_MS}
        )
        expect(r.kill?.by).toBe('stream-stall')
        expect(r.kill?.by === 'stream-stall' && r.kill.idleMs).toBeGreaterThanOrEqual(WINDOW_MS)
        expect(r.aborted).toBe(true)
        // The partial text survives — the caller decides what to do with it.
        expect(r.text).toBe('partial ans')
        expect(Date.now() - started).toBeLessThan(WINDOW_MS * 12)
    })

    // A tool call is the one legitimate reason for a long silent stream. Killing
    // there would make every real build/test run a false positive.
    test('does NOT kill while a tool is executing', async () => {
        const s = scriptedSpawn([
            {
                events: [
                    THINKING,
                    {type: 'tool_execution_start', toolName: 'bash', args: {command: 'bun test'}}
                ],
                hang: true
            }
        ])
        let settled = false
        const run = runChildUnified(
            s.spawn,
            {command: 'pi', args: [], stdin: 'p'},
            '/tmp',
            undefined,
            {mode: 'json-events', streamInactivityMs: WINDOW_MS}
        ).then(r => {
            settled = true
            return r
        })
        await new Promise(r => setTimeout(r, WINDOW_MS * 4))
        expect(settled).toBe(false)

        // Prove the guard is merely SUSPENDED, not disarmed: end the tool and the
        // same silence now counts again.
        const ctrl = new AbortController()
        const rearmed = runChildUnified(
            scriptedSpawn([
                {
                    events: [
                        {type: 'tool_execution_start', toolName: 'bash', args: {}},
                        {
                            type: 'tool_execution_end',
                            toolName: 'bash',
                            result: {content: [{type: 'text', text: 'ok'}]}
                        }
                    ],
                    hang: true
                }
            ]).spawn,
            {command: 'pi', args: [], stdin: 'p'},
            '/tmp',
            ctrl.signal,
            {mode: 'json-events', streamInactivityMs: WINDOW_MS}
        )
        expect((await rearmed).kill?.by).toBe('stream-stall')

        // Release the still-hanging first child so the test doesn't leak it.
        ctrl.abort()
        const first = await Promise.race([
            run,
            new Promise(r => setTimeout(() => r(null), WINDOW_MS * 4))
        ])
        expect(first).toBeNull()
    })

    test('off (0) leaves the old behaviour: the silent child is never killed', async () => {
        const s = scriptedSpawn([{events: [THINKING], hang: true}])
        let settled = false
        void runChildUnified(s.spawn, {command: 'pi', args: [], stdin: 'p'}, '/tmp', undefined, {
            mode: 'json-events',
            streamInactivityMs: 0
        }).then(() => (settled = true))
        await new Promise(r => setTimeout(r, WINDOW_MS * 6))
        expect(settled).toBe(false)
    })
})

describe('gate/worker child A/B: hang then restart', () => {
    test('runWorker restarts a stream-stalled attempt with an honest hint', async () => {
        const s = scriptedSpawn([
            {events: [THINKING], hang: true},
            {events: agentEndResponse('WORKER DONE').events}
        ])
        const r = await runWorker({
            prompt: 'inspect the repo',
            profile: 'adhoc',
            contextWindow: 'unknown',
            override: {
                'worker-timeout': {timeoutMs: 0, progressCeilingMs: null, fanout: null},
                'stream-stall': WINDOW_MS,
                stalled: false
            },
            cwd: '/tmp',
            spawn: s.spawn
        })
        expect(r.text).toBe('WORKER DONE')
        expect(s.spawns).toBe(2)
        // The restarted child is told what happened — and is NOT blamed for it.
        expect(s.prompts[1]).toMatch(/model stream stopped producing output/)
        expect(s.prompts[1]).toMatch(/not a mistake you made/)
        // A successful restart is not a failure: the flag reports the FINAL attempt.
        expect(r.streamStalled).toBeUndefined()
    })

    test('an attempt that keeps stalling surfaces streamStalled instead of hanging', async () => {
        const s = scriptedSpawn([{events: [THINKING], hang: true}])
        const r = await runWorker({
            prompt: 'inspect the repo',
            profile: 'adhoc',
            contextWindow: 'unknown',
            override: {
                'worker-timeout': {timeoutMs: 0, progressCeilingMs: null, fanout: null},
                'stream-stall': WINDOW_MS,
                stalled: false
            },
            cwd: '/tmp',
            spawn: s.spawn
        })
        expect(r.streamStalled).toBeDefined()
        // Restart budget spent, then reported — never an unbounded wait.
        expect(s.spawns).toBe(3)
    })
})

describe('phase child A/B: hang then retry', () => {
    test('a hung stream is retried and the retry succeeds', async () => {
        const cfg = getConfig()
        const prev = cfg.streamInactivityMs
        cfg.streamInactivityMs = WINDOW_MS
        try {
            const s = scriptedSpawn([
                {events: [THINKING, TEXT('half an ans')], hang: true},
                {events: agentEndResponse('FINAL ANSWER').events}
            ])
            const logs: string[] = []
            const text = await runPhaseChild(
                {
                    cwd: '/tmp',
                    taskId: 'TASK_TEST',
                    signal: new AbortController().signal,
                    spawn: s.spawn,
                    sleepFor: async () => {},
                    logDebug: m => logs.push(m)
                },
                'refine',
                'read',
                'do the thing'
            )
            expect(text).toBe('FINAL ANSWER')
            expect(s.spawns).toBe(2)
            // Honest logging: the trail must name the stall, not just "retry".
            expect(logs.join('\n')).toMatch(/stream inactivity/)
            // The retry re-sends the ORIGINAL prompt behind the stall hint (the
            // child is stateless and nothing it did was durable), never a
            // duplicated half-turn.
            expect(s.prompts[1]).toEndWith(s.prompts[0])
            expect(s.prompts[1]).toContain('stream stopped producing output')
        } finally {
            cfg.streamInactivityMs = prev
        }
    })
})
