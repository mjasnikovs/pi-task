import {describe, expect, test} from 'bun:test'
import {commandCeilingForAttempt, runWorker} from './pi-worker-core.js'
import {commandTimeoutHint} from '../shared/command-watchdog.js'
import {
    agentEndResponse,
    fakeSpawnKillable,
    fakeSpawnQueue,
    type SpawnResponseJsonEvents
} from '../test-utils/fake-spawn.js'
import {DEFAULT_LOOP_DETECTOR, DEFAULT_LOOP_PROGRESS} from './worker-profiles.js'

/**
 * CHILD-side command watchdog (the gate-child half of shared/command-watchdog.ts).
 *
 * The regression these cover: the watchdog shipped in v0.18.26 hooks host
 * extension events, but every child pi runs `--no-extensions`, so a hung command
 * inside a verify / lint-fix / recommend / final-fix child was unguarded. Proven
 * live before the fix — a gate child ran a never-returning `./verify.sh` and was
 * still running 240s later with `timedOut=false stalled=false`, killed only by
 * the harness's own outer cap (scripts/hung-command-gate-probe.ts).
 *
 * The hung-command cases use fakeSpawnKillable, whose child never closes on its
 * own — so if the watchdog fails to fire, the test hangs rather than fails.
 * That is the production symptom exactly, and unmistakable. The negative cases
 * use fakeSpawnQueue, whose child exits normally.
 */

/** A child that starts a tool call and then blocks forever, emitting no end. */
function hungCommand(command: string, toolCallId = 'call-1'): SpawnResponseJsonEvents {
    return {
        events: [{type: 'tool_execution_start', toolCallId, toolName: 'bash', args: {command}}],
        exitCode: 0
    }
}

describe('commandCeilingForAttempt', () => {
    test('halves per PRIOR HANG, so a repeat hang cannot spend the full ceiling again', () => {
        const base = 15 * 60_000
        // The counter is watchdog kills specifically, NOT total restarts: runWorker
        // keeps a separate hangKills counter, so a child restarted for LOOPING (which
        // never saw the bound-your-command hint) still gets the full ceiling on its
        // first hang. Only a hang after a hang shortens the rope.
        expect(commandCeilingForAttempt(base, 0)).toBe(base)
        expect(commandCeilingForAttempt(base, 1)).toBe(base / 2)
        expect(commandCeilingForAttempt(base, 2)).toBe(base / 4)
        // The point of the halving: bound the worst case well under 3× the
        // ceiling, which is what a model ignoring the hint would otherwise cost.
        const worstCase = [0, 1, 2].reduce((t, n) => t + commandCeilingForAttempt(base, n), 0)
        expect(worstCase).toBeLessThan(base * 2)
    })

    test('never shrinks below 30s — a floor no real command should miss', () => {
        expect(commandCeilingForAttempt(60_000, 5)).toBe(30_000)
    })

    test('the floor never RAISES a ceiling the caller deliberately set low', () => {
        // Clamping to 30s unconditionally would turn a 10s ceiling into 30s —
        // silently overriding the caller (and making the guard untestable at
        // millisecond scale).
        expect(commandCeilingForAttempt(10_000, 0)).toBe(10_000)
        expect(commandCeilingForAttempt(10_000, 3)).toBe(10_000)
    })

    test('off stays off', () => {
        expect(commandCeilingForAttempt(0, 0)).toBe(0)
        expect(commandCeilingForAttempt(0, 2)).toBe(0)
    })
})

describe('command watchdog — child side', () => {
    test('kills a hung command, then reports it after the restart budget', async () => {
        const prompts: string[] = []
        const r = await runWorker({
            prompt: 'verify the task',
            // as the gate children run: unbounded worker
            profile: 'adhoc',
            contextWindow: 'unknown',
            override: {
                'worker-timeout': {timeoutMs: 0, progressCeilingMs: null, fanout: null},
                'command-timeout': 30,
                stalled: false
            },
            cwd: '/tmp',
            tools: 'read,bash',
            spawn: fakeSpawnKillable([hungCommand('bun run dev')], p => prompts.push(p))
        })

        expect(r.commandTimedOut).toEqual({toolName: 'bash', timeoutMs: 30})
        // The whole-worker cap is off, so nothing else could have ended this.
        expect(r.timedOut).toBeUndefined()
        expect(r.stalled).toBeUndefined()
        // Initial attempt + MAX_LOOP_RESTARTS re-spawns.
        expect(prompts.length).toBe(3)
    })

    test('the restart hint names the command and the timeout parameter', async () => {
        const prompts: string[] = []
        await runWorker({
            prompt: 'verify the task',
            profile: 'adhoc',
            contextWindow: 'unknown',
            override: {
                'worker-timeout': {timeoutMs: 0, progressCeilingMs: null, fanout: null},
                'command-timeout': 30,
                stalled: false
            },
            cwd: '/tmp',
            tools: 'read,bash',
            spawn: fakeSpawnKillable([hungCommand('bun run dev')], p => prompts.push(p))
        })

        // First attempt is unhinted; every restart carries the correction.
        expect(prompts[0]).not.toContain('[SYSTEM NOTE:')
        const hinted = prompts[1]!
        expect(hinted).toContain('bun run dev')
        expect(hinted).toContain('`timeout` parameter')
        // The anti-fabrication clause: a killed command produced nothing.
        expect(hinted).toContain('produced NO result')
        // NOT the generic worker-timeout hint — that misdiagnoses a hung command
        // as over-exploration and never mentions bounding the command.
        expect(hinted).not.toContain('exploring too long')
        // The child had bash, so nothing guarantees the tree is clean: the hint
        // must warn that the killed attempt's side effects survive, not claim
        // the attempt was wholesale discarded (only its conversation was).
        expect(hinted).toContain('still in the working tree')
        expect(hinted).not.toContain('seeing this task again from the start')
    })

    test('the hint claims a clean slate ONLY for a child that could not write', () => {
        // Pure-function check of both phrasings. Write-capable (runWorker passes
        // editsMayPersist for edit/bash/write tools): partial edits and command
        // side effects persist across the restart — nothing reverts the tree
        // between attempts — so "discarded from the start" would be a lie the
        // fresh child acts on (re-applying edits, misreading tree state).
        const writeCapable = commandTimeoutHint('bash', 60_000, {
            commandDetail: 'bun run migrate',
            editsMayPersist: true
        })
        expect(writeCapable).toContain('still in the working tree')
        expect(writeCapable).toContain('bun run migrate')
        expect(writeCapable).not.toContain('seeing this task again from the start')

        // Read-only child: no side effects possible, the simpler framing stands.
        const readOnly = commandTimeoutHint('fetch', 60_000)
        expect(readOnly).toContain('seeing this task again from the start')
        expect(readOnly).not.toContain('still in the working tree')
    })

    test('a loop restart then a hang: both hints delivered, hang still restartable', async () => {
        // Mixed-cause path: attempt 1 is killed by the LOOP detector, attempt 2
        // by the command watchdog. The two share one restart budget but carry
        // different hints — and the hang after a loop is the child's FIRST hang,
        // so it must still get the command hint (not be starved of budget) and,
        // per commandCeilingForAttempt, the full ceiling. (The halving magnitude
        // itself is untestable at ms scale — the 30s floor suppresses it — so
        // that part lives in the pure-function tests above.)
        const prompts: string[] = []
        const r = await runWorker({
            prompt: 'verify the task',
            profile: 'adhoc',
            contextWindow: 'unknown',
            override: {
                'worker-timeout': {timeoutMs: 0, progressCeilingMs: null, fanout: null},
                'command-timeout': 40,
                stalled: false,
                loop: {
                    detector: {
                        ...DEFAULT_LOOP_DETECTOR,
                        window: 4,
                        threshold: 2,
                        pathThreshold: Number.POSITIVE_INFINITY
                    },
                    progress: {...DEFAULT_LOOP_PROGRESS}
                }
            },
            cwd: '/tmp',
            tools: 'read,bash',
            spawn: fakeSpawnKillable(
                [
                    // Two identical calls trip LoopDetector(4, 2) → loop kill.
                    {
                        events: [
                            {
                                type: 'tool_execution_start',
                                toolCallId: 'c1',
                                toolName: 'read',
                                args: {path: 'a.ts'}
                            },
                            {
                                type: 'tool_execution_start',
                                toolCallId: 'c2',
                                toolName: 'read',
                                args: {path: 'a.ts'}
                            }
                        ],
                        exitCode: 0
                    },
                    // Fresh child hangs on an unbounded command (repeats as last).
                    hungCommand('bun run dev')
                ],
                p => prompts.push(p)
            )
        })

        expect(prompts.length).toBe(3)
        expect(prompts[1]).toContain('stuck in a loop')
        expect(prompts[2]).toContain('`timeout` parameter')
        // Budget exhausted on the final hang → reported, not mislabeled.
        expect(r.commandTimedOut).toEqual({toolName: 'bash', timeoutMs: 40})
    })

    test('a command that finishes in time is never killed', async () => {
        const r = await runWorker({
            prompt: 'verify the task',
            profile: 'adhoc',
            contextWindow: 'unknown',
            override: {
                'worker-timeout': {timeoutMs: 0, progressCeilingMs: null, fanout: null},
                'command-timeout': 60_000,
                stalled: false
            },
            cwd: '/tmp',
            tools: 'read,bash',
            spawn: fakeSpawnQueue([
                {
                    events: [
                        {
                            type: 'tool_execution_start',
                            toolCallId: 'c1',
                            toolName: 'bash',
                            args: {command: 'bun test'}
                        },
                        {
                            type: 'tool_execution_end',
                            toolCallId: 'c1',
                            toolName: 'bash',
                            result: {content: [{type: 'text', text: 'ok'}]}
                        },
                        ...agentEndResponse('WORK-VERIFIED:PASS').events
                    ],
                    exitCode: 0
                }
            ])
        })

        expect(r.commandTimedOut).toBeUndefined()
        expect(r.text).toBe('WORK-VERIFIED:PASS')
    })

    test('off by default: no ceiling is applied unless a caller asks for one', async () => {
        const r = await runWorker({
            prompt: 'research the thing',
            profile: 'adhoc',
            contextWindow: 'unknown',
            override: {
                stalled: false
            },
            cwd: '/tmp',
            spawn: fakeSpawnQueue([
                {
                    events: [
                        {
                            type: 'tool_execution_start',
                            toolCallId: 'c1',
                            toolName: 'read',
                            args: {path: 'a.ts'}
                        },
                        ...agentEndResponse('done').events
                    ],
                    exitCode: 0
                }
            ])
        })

        expect(r.commandTimedOut).toBeUndefined()
        expect(r.text).toBe('done')
    })

    test('pairs start with end when the stream carries no toolCallId', async () => {
        // Older pi / hand-rolled streams omit toolCallId; the fallback slot must
        // still disarm on end, or a finished command would be killed retroactively.
        const r = await runWorker({
            prompt: 'verify',
            profile: 'adhoc',
            contextWindow: 'unknown',
            override: {
                'worker-timeout': {timeoutMs: 0, progressCeilingMs: null, fanout: null},
                'command-timeout': 40,
                stalled: false
            },
            cwd: '/tmp',
            tools: 'read,bash',
            spawn: fakeSpawnQueue([
                {
                    events: [
                        {type: 'tool_execution_start', toolName: 'bash', args: {command: 'ls'}},
                        {
                            type: 'tool_execution_end',
                            toolName: 'bash',
                            result: {content: [{type: 'text', text: 'a.ts'}]}
                        },
                        ...agentEndResponse('WORK-VERIFIED:PASS').events
                    ],
                    exitCode: 0
                }
            ])
        })

        expect(r.commandTimedOut).toBeUndefined()
        expect(r.text).toBe('WORK-VERIFIED:PASS')
    })

    test('a caller onToolResult still fires when the watchdog is wired in', async () => {
        // The sink only emits tool_execution_end if a handler exists, so the
        // watchdog wraps the caller's — which must not swallow it (the gate debug
        // log depends on it to record tool OUTPUTS, not just commands).
        const seen: string[] = []
        await runWorker({
            prompt: 'verify',
            profile: 'adhoc',
            contextWindow: 'unknown',
            override: {
                'worker-timeout': {timeoutMs: 0, progressCeilingMs: null, fanout: null},
                'command-timeout': 60_000,
                stalled: false
            },
            cwd: '/tmp',
            tools: 'read,bash',
            onToolResult: ({name, text}) => seen.push(`${name}:${text}`),
            spawn: fakeSpawnQueue([
                {
                    events: [
                        {
                            type: 'tool_execution_start',
                            toolCallId: 'c1',
                            toolName: 'bash',
                            args: {command: 'bun test'}
                        },
                        {
                            type: 'tool_execution_end',
                            toolCallId: 'c1',
                            toolName: 'bash',
                            result: {content: [{type: 'text', text: 'ok'}]}
                        },
                        ...agentEndResponse('done').events
                    ],
                    exitCode: 0
                }
            ])
        })

        expect(seen).toEqual(['bash:ok'])
    })
})
