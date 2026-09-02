import {describe, expect, test} from 'bun:test'
import {
    runPhaseChild,
    prependHint,
    runWithEmphasisRetry,
    ChildFailureError,
    isFatalChildCause,
    USER_CANCELLED
} from '../../src/task/child-runner.js'
import {childArgs} from '../../src/workers/pi-worker-core.js'
import {isConnectionError, connectionRetryBackoffMs} from '../../src/shared/connection-error.js'
import {workerPolicy} from '../../src/workers/worker-profiles.js'
import {LOOP_THRESHOLD} from '../../src/task/loop-detector.js'
import {
    fakeSpawnSimple,
    agentEndResponse,
    agentErrorResponse,
    fakeSpawnQueue,
    fakeSpawnByPrompt,
    loopResponse,
    makeProc,
    fakeSpawnKillable,
    type SpawnResponse,
    type SpawnResponseJsonEvents
} from '../test-utils/fake-spawn.js'
import type {ContextSnapshot, ProcLike, SpawnFn} from '../../src/shared/child-process.js'
import {withTmpTaskDir} from '../test-utils/tmp-task-dir.js'
import {writeTaskFile, readSection} from '../../src/task/task-io.js'
import {EventEmitter} from 'node:events'
import {getConfig} from '../../src/config/config.js'
import {MAX_LEAK_RETRIES} from '../../src/shared/leaked-tool-call.js'

function depsWith(spawn: SpawnFn) {
    return {
        cwd: '/tmp',
        taskId: 'TASK_TEST',
        signal: new AbortController().signal,
        spawn,
        // No-op backoff so connection-error retries don't actually sleep in tests.
        sleepFor: async () => {}
    }
}

describe('childArgs', () => {
    // pi defaults to PLAIN-TEXT output. Drop `--mode json` and the json-events
    // parser receives no JSON, so every phase fails with "X child produced no
    // output" — a refactor can lose this flag and break everything while looking
    // like a move. Keep this test even though it looks trivial: it is the only
    // thing pinning the spawn flags to the parser mode runChild expects.
    test('includes --mode json so the child emits the event stream the parser expects', () => {
        const args = childArgs('read')
        const i = args.indexOf('--mode')
        expect(i).toBeGreaterThanOrEqual(0)
        expect(args[i + 1]).toBe('json')
    })

    test('includes --print and --tools <tools>, and never carries the prompt (stdin-delivered)', () => {
        const args = childArgs('read,bash')
        expect(args).toContain('--print')
        const t = args.indexOf('--tools')
        expect(t).toBeGreaterThanOrEqual(0)
        expect(args[t + 1]).toBe('read,bash')
        // The prompt must NOT be an argv element. A single argv element past
        // ~128 KiB fails the spawn outright with E2BIG, and a phase prompt with
        // an inlined spec clears that easily, so it goes over stdin instead.
        expect(args).not.toContain('do the thing')
    })

    test('an empty tools string emits --no-tools instead of --tools', () => {
        const args = childArgs('')
        expect(args).toContain('--no-tools')
        expect(args).not.toContain('--tools')
        // Still json mode.
        const i = args.indexOf('--mode')
        expect(args[i + 1]).toBe('json')
    })
})

/** Spawn fake that captures the args every invocation was launched with. */
function capturingSpawn(response: () => void): {
    spawn: SpawnFn
    calls: Array<ReadonlyArray<string>>
} {
    const calls: Array<ReadonlyArray<string>> = []
    const spawn = ((_cmd: string, args: ReadonlyArray<string>) => {
        calls.push(args)
        const p = new EventEmitter() as EventEmitter & ProcLike
        p.stdout = new EventEmitter()
        p.stderr = new EventEmitter()
        p.killed = false
        p.kill = () => {
            p.killed = true
            return true
        }
        queueMicrotask(() => {
            response()
            p.stdout?.emit(
                'data',
                Buffer.from(
                    JSON.stringify({
                        type: 'agent_end',
                        messages: [{role: 'assistant', content: [{type: 'text', text: 'ok'}]}]
                    }) + '\n'
                )
            )
            p.emit('close', 0)
        })
        return p
    }) as unknown as SpawnFn
    return {spawn, calls}
}

describe('runPhaseChild spawn contract', () => {
    test('passes --mode json to the actual spawn call', async () => {
        const {spawn, calls} = capturingSpawn(() => {})
        await runPhaseChild(
            {
                cwd: '/tmp',
                taskId: 'TASK_TEST',
                signal: new AbortController().signal,
                spawn
            },
            'refine',
            'read',
            'whatever'
        )
        expect(calls.length).toBe(1)
        const args = calls[0]
        const i = args.indexOf('--mode')
        expect(i).toBeGreaterThanOrEqual(0)
        expect(args[i + 1]).toBe('json')
    })

    test('plain-text child output (e.g. forgot --mode json) surfaces as "no output"', async () => {
        // The real pi binary emits plain text when --mode json is missing. The
        // json-events parser produces no finalText for those lines, so the
        // empty-output guard fires. This test pins that behaviour — it would
        // have screamed when the flag was first dropped.
        await expect(
            runPhaseChild(
                {
                    cwd: '/tmp',
                    taskId: 'TASK_TEST',
                    signal: new AbortController().signal,
                    spawn: fakeSpawnSimple('GOAL\n  some refined goal\n\nCONSTRAINTS\n  - foo\n', 0)
                },
                'refine',
                'read',
                'prompt'
            )
        ).rejects.toThrow(/refine child produced no output/)
    })
})

describe('runPhaseChild', () => {
    test('returns assistant text from a json-events agent_end on success', async () => {
        const out = await runPhaseChild(
            depsWith(fakeSpawnQueue([agentEndResponse('hello world')])),
            'refine',
            'read',
            'prompt'
        )
        expect(out).toBe('hello world')
    })

    test('throws "child produced no output" when text is empty and exitCode is 0', async () => {
        await expect(
            runPhaseChild(depsWith(fakeSpawnSimple('')), 'refine', 'read', 'prompt')
        ).rejects.toThrow(/refine child produced no output/)
    })

    test('throws "child produced no output" when text is whitespace-only', async () => {
        await expect(
            runPhaseChild(
                depsWith(fakeSpawnQueue([agentEndResponse('   \n\n  ')])),
                'refine',
                'read',
                'prompt'
            )
        ).rejects.toThrow(/refine child produced no output/)
    })

    test('throws "child failed" with stderr when exitCode is non-zero', async () => {
        await expect(
            runPhaseChild(depsWith(fakeSpawnSimple('', 1, 'kaboom')), 'refine', 'read', 'prompt')
        ).rejects.toThrow(/refine child failed.*kaboom/)
    })

    test('throws ModelError (fail-fast, no retry) on a NON-connection model error', async () => {
        // A non-transient model/provider failure (bad request, context overflow,
        // auth) arrives as a stopReason "error" agent_end with empty text. The
        // second queued response would only be reached on a retry; getting
        // ModelError proves we fail fast — re-spawning won't fix a real fault.
        const spawn = fakeSpawnQueue([
            agentErrorResponse('400 context length exceeded'),
            agentEndResponse('should not be reached')
        ])
        const p = runPhaseChild(depsWith(spawn), 'refine', 'read', 'prompt')
        await expect(p).rejects.toMatchObject({failure: {kind: 'model-error'}})
        await expect(p).rejects.toThrow(/model error — 400 context length exceeded/)
    })

    test('retries a connection-class model error and returns the later clean output', async () => {
        // One dropped socket to a single-slot local server surfaces as
        // "Connection error.". It is transient and the re-spawn succeeds, so
        // failing fast here would kill a whole task over one blip.
        const {spawn, prompts} = capturingQueue([{error: 'Connection error.'}, 'recovered output'])
        const out = await runPhaseChild(depsWith(spawn), 'grill-gen', 'read', 'ORIGINAL PROMPT')
        expect(out).toBe('recovered output')
        expect(prompts.length).toBe(2)
        // A connection retry carries no correction hint — bare prompt is re-sent.
        expect(prompts[1]).toBe('ORIGINAL PROMPT')
    })

    test('throws ModelError when every attempt hits a connection error', async () => {
        // The endpoint stays unreachable for the whole budget — after exhausting
        // the retries we surface the real cause so the user knows to restart it.
        const spawn = fakeSpawnQueue([
            agentErrorResponse('Connection error.'),
            agentErrorResponse('socket hang up'),
            agentErrorResponse('ECONNREFUSED')
        ])
        const p = runPhaseChild(depsWith(spawn), 'grill-gen', 'read', 'prompt')
        await expect(p).rejects.toMatchObject({failure: {kind: 'model-error'}})
        await expect(p).rejects.toThrow(/model error — ECONNREFUSED/)
    })

    test('retries an empty completion and returns the clean output from a later attempt', async () => {
        // First spawn produces no assistant text (transient empty turn), the
        // retry succeeds. Without the empty-output retry this would fail the phase.
        const {spawn, prompts} = capturingQueue(['', 'recovered output'])
        const out = await runPhaseChild(depsWith(spawn), 'refine', 'read', 'ORIGINAL PROMPT')
        expect(out).toBe('recovered output')
        expect(prompts.length).toBe(2)
        // Empty output carries no correction hint — the re-spawn uses the bare prompt.
        expect(prompts[1]).toBe('ORIGINAL PROMPT')
    })
})

describe('isConnectionError', () => {
    test('matches the exact provider string the user hit', () => {
        // The literal errorMessage pi surfaces for a dropped connection.
        expect(isConnectionError('Connection error.')).toBe(true)
    })

    test('matches the transient connection family (case-insensitive)', () => {
        for (const cause of [
            'socket hang up',
            'fetch failed',
            'ECONNRESET',
            'ECONNREFUSED',
            'read ECONNRESET',
            'connection reset by peer',
            'connection refused',
            'ETIMEDOUT',
            'network timeout at: http://127.0.0.1:8080/v1',
            'Premature close',
            'terminated'
        ]) {
            expect(isConnectionError(cause)).toBe(true)
        }
    })

    test('does NOT match real, non-transient faults (still fail-fast)', () => {
        for (const cause of [
            '400 context length exceeded',
            'invalid request: messages too long',
            'model not found',
            '401 unauthorized',
            // Load classes moved OUT of this list — see PROVIDER_LOAD_RE. 53f0488's
            // own message names only context overflow, bad request and auth as
            // fail-fast; a throttle rode along in a list written for a local server.
            'insufficient_quota',
            '429 GoUsageLimitError'
        ]) {
            expect(isConnectionError(cause)).toBe(false)
        }
    })
})

describe('connectionRetryBackoffMs', () => {
    test('grows exponentially from 500ms', () => {
        expect(connectionRetryBackoffMs(0)).toBe(500)
        expect(connectionRetryBackoffMs(1)).toBe(1000)
        expect(connectionRetryBackoffMs(2)).toBe(2000)
    })
})

describe('prependHint', () => {
    test('returns prompt unchanged when hint is null', () => {
        expect(prependHint(null, 'do thing')).toBe('do thing')
    })

    test('prepends hint with a blank line separator', () => {
        expect(prependHint('NOTE', 'do thing')).toBe('NOTE\n\ndo thing')
    })
})

/** Serve a queue of SpawnResponses in order while capturing each call's full
 *  argv — so a test can assert which `--tools` / `--no-tools` flag each spawn ran
 *  with (the degrade attempt must be `--no-tools`). */
function capturingResponseQueue(responses: ReadonlyArray<SpawnResponse>): {
    spawn: SpawnFn
    calls: Array<ReadonlyArray<string>>
} {
    const calls: Array<ReadonlyArray<string>> = []
    let i = 0
    const spawn = fakeSpawnByPrompt(args => {
        calls.push(args)
        const r = responses[Math.min(i, responses.length - 1)]
        i++
        return r
    })
    return {spawn, calls}
}

function loopEvents(
    toolName: string,
    args: unknown,
    repeats: number
): Array<Record<string, unknown>> {
    const events: Array<Record<string, unknown>> = []
    for (let i = 0; i < repeats; i++) {
        events.push({type: 'tool_execution_start', toolName, args})
    }
    return events
}

describe('runPhaseChild — the restart-verb call sites (was runPhaseWithLoopGuard)', () => {
    test('restarts with hint when 5 identical tool calls hit within window', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'refine',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )
            const {spawn, prompts} = ladderSpawn([
                {events: loopEvents('Read', {path: '/foo'}, 5)},
                agentEndResponse('refined content')
            ])
            const out = await runPhaseChild(
                {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                'refine',
                'read',
                'PROMPT',
                {verb: 'restart'}
            )
            expect(out).toBe('refined content')
            expect(prompts.length).toBe(2)
            expect(prompts[0]).toBe('PROMPT')
            expect(prompts[1]).toContain('SYSTEM NOTE')
            expect(prompts[1]).toContain('Read')
        })
    })

    test('restarts on an empty completion and returns the clean output from a later strike', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'refine',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )
            // First strike yields no assistant text — a transient empty turn —
            // and the re-spawn succeeds.
            const {spawn, prompts} = ladderSpawn([
                agentEndResponse(''),
                agentEndResponse('refined content')
            ])
            const out = await runPhaseChild(
                {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                'refine',
                'read',
                'PROMPT',
                {verb: 'restart'}
            )
            expect(out).toBe('refined content')
            expect(prompts.length).toBe(2)
            // Empty output carries no hint — the restart re-sends the bare prompt.
            expect(prompts[1]).toBe('PROMPT')
        })
    })

    test('throws ModelError (fail-fast) on a NON-connection model error', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'refine',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )
            // A real fault (bad request / context overflow). The second response
            // would only be reached on a restart — ModelError proves we fail fast
            // rather than burning the strike budget on something re-spawn can't fix.
            const spawn = fakeSpawnQueue([
                agentErrorResponse('invalid request: messages too long'),
                agentEndResponse('should not be reached')
            ])
            const p = runPhaseChild(
                {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                'refine',
                'read',
                'PROMPT',
                {verb: 'restart'}
            )
            await expect(p).rejects.toMatchObject({failure: {kind: 'model-error'}})
            await expect(p).rejects.toThrow(/model error — invalid request/)
        })
    })

    test('restarts a connection-class model error and returns the later clean output', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'grill',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )
            // A single "Connection error." against a single-slot local server.
            // Transient — the restart succeeds.
            const {spawn, prompts} = ladderSpawn([
                agentErrorResponse('Connection error.'),
                agentEndResponse('grilled questions')
            ])
            const out = await runPhaseChild(
                {
                    cwd,
                    taskId: 'TASK_0001',
                    signal: new AbortController().signal,
                    spawn,
                    sleepFor: async () => {}
                },
                'grill-gen',
                'read',
                'PROMPT',
                {verb: 'restart'}
            )
            expect(out).toBe('grilled questions')
            expect(prompts.length).toBe(2)
            // A connection restart carries no correction hint — same bare prompt.
            expect(prompts[1]).toBe('PROMPT')
        })
    })

    test('throws ModelError when every strike hits a connection error', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'grill',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )
            // Endpoint unreachable for the whole strike budget — surface the cause.
            const spawn = fakeSpawnQueue([
                agentErrorResponse('Connection error.'),
                agentErrorResponse('Connection error.'),
                agentErrorResponse('Connection error.')
            ])
            const p = runPhaseChild(
                {
                    cwd,
                    taskId: 'TASK_0001',
                    signal: new AbortController().signal,
                    spawn,
                    sleepFor: async () => {}
                },
                'grill-gen',
                'read',
                'PROMPT',
                {verb: 'restart'}
            )
            await expect(p).rejects.toMatchObject({failure: {kind: 'model-error'}})
            await expect(p).rejects.toThrow(/model error — Connection error/)
        })
    })

    test('throws "produced no output" when every strike yields an empty completion', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'refine',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )
            const spawn = fakeSpawnQueue([agentEndResponse('')])
            await expect(
                runPhaseChild(
                    {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                    'refine',
                    'read',
                    'PROMPT',
                    {verb: 'restart'}
                )
            ).rejects.toThrow(/refine child produced no output/)
        })
    })

    test('throws a loop failure after MAX_LOOP_RESTARTS+1 strikes', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'refine',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )
            const spawn = fakeSpawnQueue([
                {events: loopEvents('Read', {path: '/foo'}, 5)},
                {events: loopEvents('Read', {path: '/foo'}, 5)},
                {events: loopEvents('Read', {path: '/foo'}, 5)}
            ])
            await expect(
                runPhaseChild(
                    {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                    'refine',
                    'read',
                    'PROMPT',
                    {verb: 'restart'}
                )
            ).rejects.toMatchObject({failure: {kind: 'loop'}})
        })
    })

    // ─── Context window reaches the child ───────────────────────────────────
    //
    // pi's `--mode json` stream carries NO context window: the string
    // `context_usage` occurs nowhere in the installed pi packages, and none of
    // the events docs/json.md documents carries one (see
    // shared/json-event-sink.test.ts). So the window is something the PARENT must
    // hand down. Without that every snapshot reports `contextWindow: 0`, and
    // everything gated on a positive window is silently inert.

    test('the caller-supplied context window reaches the onContextUsage snapshot', async () => {
        const seen: ContextSnapshot[] = []
        const spawn = fakeSpawnQueue([
            {
                events: [
                    {
                        type: 'message_end',
                        message: {
                            role: 'assistant',
                            usage: {input: 900, cacheRead: 100, cacheWrite: 0, output: 0}
                        }
                    },
                    {
                        type: 'agent_end',
                        messages: [{role: 'assistant', content: [{type: 'text', text: 'ok'}]}]
                    }
                ]
            }
        ])
        const text = await runPhaseChild(
            {
                cwd: '/tmp',
                taskId: 'TASK_TEST',
                signal: new AbortController().signal,
                spawn,
                contextWindow: 10_000,
                onContextUsage: snap => void seen.push(snap)
            },
            'refine',
            'read',
            'PROMPT'
        )
        expect(text).toBe('ok')
        expect(seen).toEqual([{tokens: 1000, contextWindow: 10_000, percent: 10}])
    })

    // StallDetector's CONTEXT CHURN rule (stall-detector.ts rule 2) is gated on
    // a positive window — `churnTripped` returns false otherwise — so fed only
    // zeros it can never fire, and the backstop for a child re-reading a window
    // it cannot hold does nothing. The bound here: window 1000 tokens ×
    // CONTEXT_CHURN_FACTOR (2) × CHARS_PER_TOKEN (4) = 8000 chars of tool output
    // before it must trip.
    test('the context-churn stall rule arms once the child knows its window', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'refine',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )
            // Every call reads a DIFFERENT path returning DIFFERENT bytes, so
            // rule 1 (no-new-ground) and the LoopDetector both stay silent —
            // only the churn rule can explain a kill here.
            const events: Array<Record<string, unknown>> = []
            for (let i = 0; i < 4; i++) {
                events.push({
                    type: 'tool_execution_start',
                    toolName: 'read',
                    args: {path: `/f${i}.ts`}
                })
                events.push({
                    type: 'tool_execution_end',
                    toolName: 'read',
                    isError: false,
                    result: {content: [{type: 'text', text: `${i}`.repeat(4000)}]}
                })
            }
            const debug: string[] = []
            const spawn = fakeSpawnQueue([{events}])
            await expect(
                runPhaseChild(
                    {
                        cwd,
                        taskId: 'TASK_0001',
                        signal: new AbortController().signal,
                        spawn,
                        contextWindow: 1000,
                        logDebug: (msg: string) => void debug.push(msg)
                    },
                    'refine',
                    'read',
                    'PROMPT'
                )
            ).rejects.toMatchObject({failure: {kind: 'loop'}})
            expect(debug.some(l => l.includes('stalled (context-churn)'))).toBe(true)
        })
    })

    // ─── degradeOnExhaustion ────────────────────────────────────────────────
    // A refine phase against a large existing codebase can spend its whole loop
    // budget over-exploring — re-reading source hunting for an implementation —
    // and a hard fail there kills the /task-auto run on every resume. But refine's
    // deliverable is a text rewrite that never needed a successful read. So a
    // budget-exhausted phase does ONE no-tools final attempt instead of throwing.
    describe('degradeOnExhaustion', () => {
        test('runs a no-tools final attempt after the budget is spent and returns its text', async () => {
            await withTmpTaskDir(async cwd => {
                await writeTaskFile(
                    cwd,
                    {
                        id: 'TASK_0001',
                        state: 'in_progress',
                        phase: 'refine',
                        created_at: '2026-01-01T00:00:00Z',
                        updated_at: '2026-01-01T00:00:00Z',
                        title: 't'
                    },
                    '\n'
                )
                // 3 strikes all loop, then the degrade attempt produces the spec.
                const {spawn, calls} = capturingResponseQueue([
                    {events: loopEvents('Read', {path: '/foo'}, 5)},
                    {events: loopEvents('Read', {path: '/foo'}, 5)},
                    {events: loopEvents('Read', {path: '/foo'}, 5)},
                    agentEndResponse('GOAL\n  a degraded but complete spec')
                ])
                const out = await runPhaseChild(
                    {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                    'refine',
                    'read',
                    'PROMPT',
                    {degradeOnExhaustion: true, verb: 'restart'}
                )
                expect(out).toBe('GOAL\n  a degraded but complete spec')
                // 4 spawns: 3 strikes + 1 degrade attempt.
                expect(calls.length).toBe(4)
                // The first three carry `--tools read`; the degrade carries `--no-tools`.
                for (const c of calls.slice(0, 3)) expect(c).toContain('--tools')
                expect(calls[3]).toContain('--no-tools')
                expect(calls[3]).not.toContain('--tools')
                // The degrade prompt was built with the terminal "NO tools" hint.
                const degradePrompt = String(calls[3]![calls[3]!.length - 1])
                expect(degradePrompt).toContain('SYSTEM NOTE')
                expect(degradePrompt).toContain('NO tools')
                expect(degradePrompt).toContain('PROMPT')
            })
        })

        test('the degrade attempt runs under the same wall clock as the strikes', async () => {
            // The degrade attempt must run under the SAME timeout the strikes ran
            // under. Hand it `deps.signal` raw instead — the drift that comes of
            // writing bare `undefined`s to reach later argument slots — and the
            // one attempt made after a loop budget is spent becomes the only
            // attempt that can hang forever.
            const procs: Array<ReturnType<typeof makeProc>> = []
            let i = 0
            const spawn = (() => {
                const p = makeProc()
                procs.push(p)
                const strike = i++ < 3
                p.kill = () => {
                    if (p.killed) return true
                    p.killed = true
                    p.emit('close', 143)
                    return true
                }
                queueMicrotask(() => {
                    if (strike) {
                        for (let n = 0; n < 5; n++) {
                            p.stdout!.emit(
                                'data',
                                Buffer.from(
                                    JSON.stringify({
                                        type: 'tool_execution_start',
                                        toolName: 'Read',
                                        args: {path: '/foo'}
                                    }) + '\n'
                                )
                            )
                        }
                        p.emit('close', 0)
                        return
                    }
                    // The degrade attempt: deliberately never closes.
                })
                return p
            }) as unknown as SpawnFn

            // And it reports the cause it ACTUALLY hit. A wall-clock kill is not a
            // loop: reporting one as a loop failure hands the reader a loop
            // history that did not cause the failure.
            await expect(
                runPhaseChild({...depsWith(spawn), timeoutMs: 100}, 'refine', 'read', 'PROMPT', {
                    degradeOnExhaustion: true,
                    verb: 'restart'
                })
            ).rejects.toMatchObject({failure: {kind: 'worker-timeout'}})

            expect(procs.length).toBe(4)
            expect(procs[3]!.killed).toBe(true)
        }, 2000)

        test('records the degrade outcome (not "phase failed") in the loop events section', async () => {
            await withTmpTaskDir(async cwd => {
                await writeTaskFile(
                    cwd,
                    {
                        id: 'TASK_0001',
                        state: 'in_progress',
                        phase: 'refine',
                        created_at: '2026-01-01T00:00:00Z',
                        updated_at: '2026-01-01T00:00:00Z',
                        title: 't'
                    },
                    '\n'
                )
                const spawn = fakeSpawnQueue([
                    {events: loopEvents('Read', {path: '/foo'}, 5)},
                    {events: loopEvents('Read', {path: '/foo'}, 5)},
                    {events: loopEvents('Read', {path: '/foo'}, 5)},
                    agentEndResponse('GOAL\n  spec\n')
                ])
                await runPhaseChild(
                    {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                    'refine',
                    'read',
                    'PROMPT',
                    {degradeOnExhaustion: true, verb: 'restart'}
                )
                const events = (await readSection(cwd, 'TASK_0001', 'loop events')) ?? ''
                expect(events).toContain('degraded — no-tools final attempt')
                expect(events).not.toContain('phase failed')
            })
        })

        test('still throws a loop failure when even the no-tools attempt yields no output', async () => {
            await withTmpTaskDir(async cwd => {
                await writeTaskFile(
                    cwd,
                    {
                        id: 'TASK_0001',
                        state: 'in_progress',
                        phase: 'refine',
                        created_at: '2026-01-01T00:00:00Z',
                        updated_at: '2026-01-01T00:00:00Z',
                        title: 't'
                    },
                    '\n'
                )
                const spawn = fakeSpawnQueue([
                    {events: loopEvents('Read', {path: '/foo'}, 5)},
                    {events: loopEvents('Read', {path: '/foo'}, 5)},
                    {events: loopEvents('Read', {path: '/foo'}, 5)},
                    agentEndResponse('') // degrade attempt is also empty → honest fail
                ])
                await expect(
                    runPhaseChild(
                        {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                        'refine',
                        'read',
                        'PROMPT',
                        {degradeOnExhaustion: true, verb: 'restart'}
                    )
                ).rejects.toMatchObject({failure: {kind: 'loop'}})
            })
        })

        test('without degradeOnExhaustion the budget-exhausted phase still hard-fails (default)', async () => {
            await withTmpTaskDir(async cwd => {
                await writeTaskFile(
                    cwd,
                    {
                        id: 'TASK_0001',
                        state: 'in_progress',
                        phase: 'refine',
                        created_at: '2026-01-01T00:00:00Z',
                        updated_at: '2026-01-01T00:00:00Z',
                        title: 't'
                    },
                    '\n'
                )
                // A clean 4th response is queued but must NEVER be reached: the
                // default path throws on the 3rd strike without a degrade attempt.
                const {spawn, calls} = capturingResponseQueue([
                    {events: loopEvents('Read', {path: '/foo'}, 5)},
                    {events: loopEvents('Read', {path: '/foo'}, 5)},
                    {events: loopEvents('Read', {path: '/foo'}, 5)},
                    agentEndResponse('should not be reached')
                ])
                await expect(
                    runPhaseChild(
                        {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                        'refine',
                        'read',
                        'PROMPT',
                        {verb: 'restart'}
                    )
                ).rejects.toMatchObject({failure: {kind: 'loop'}})
                expect(calls.length).toBe(3) // no 4th (degrade) spawn
            })
        })
    })
})

// A tool call the child model wrote as plain text (wrong dialect) instead of
// invoking — never executed, leaked into the assistant answer.
const LEAKED = [
    'Let me check the file.',
    '<tool_call>',
    '<function=bash>',
    '<parameter=command>grep -n "z.object" src/Auth.tsx</parameter>',
    '</function>',
    '</tool_call>'
].join('\n')

/** Queue agent_end texts in order while capturing each call's final prompt arg. */
/** A queued response is either clean assistant text or a `{error}` — a
 *  stopReason "error" agent_end carrying that cause (an empty/connection turn). */
type QueuedResponse = string | {error: string}

function capturingQueue(responses: ReadonlyArray<QueuedResponse>): {
    spawn: SpawnFn
    prompts: string[]
} {
    const prompts: string[] = []
    let i = 0
    const spawn = ((_cmd: string, _args: ReadonlyArray<string>) => {
        const r = responses[Math.min(i, responses.length - 1)]
        i++
        const assistant =
            typeof r === 'string' ?
                {role: 'assistant', content: [{type: 'text', text: r}]}
            :   {
                    role: 'assistant',
                    content: [{type: 'text', text: ''}],
                    stopReason: 'error',
                    errorMessage: r.error
                }
        const p = new EventEmitter() as EventEmitter & ProcLike
        p.stdout = new EventEmitter()
        p.stderr = new EventEmitter()
        // The prompt is delivered on stdin now; capture it on end() to assert on it.
        let stdinData = ''
        p.stdin = {
            write: (chunk: string) => {
                stdinData += chunk
                return true
            },
            end: () => {
                prompts.push(stdinData)
            }
        }
        p.killed = false
        p.kill = () => {
            p.killed = true
            return true
        }
        queueMicrotask(() => {
            p.stdout?.emit(
                'data',
                Buffer.from(JSON.stringify({type: 'agent_end', messages: [assistant]}) + '\n')
            )
            p.emit('close', 0)
        })
        return p
    }) as unknown as SpawnFn
    return {spawn, prompts}
}

describe('leaked tool-call guard', () => {
    test('the one loop restarts with a correction hint when the child leaks a call', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'refine',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )
            const {spawn, prompts} = ladderSpawn([
                agentEndResponse(LEAKED),
                agentEndResponse('clean refined content')
            ])
            const out = await runPhaseChild(
                {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                'refine',
                'read',
                'PROMPT',
                {verb: 'restart'}
            )
            expect(out).toBe('clean refined content')
            expect(prompts.length).toBe(2)
            expect(prompts[0]).toBe('PROMPT')
            expect(prompts[1]).toContain('SYSTEM NOTE')
            expect(prompts[1]).toMatch(/tool call/i)
        })
    })

    test('the one loop throws LeakedToolCallError when every attempt leaks', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'refine',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )
            const spawn = fakeSpawnQueue([
                agentEndResponse(LEAKED),
                agentEndResponse(LEAKED),
                agentEndResponse(LEAKED)
            ])
            await expect(
                runPhaseChild(
                    {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                    'refine',
                    'read',
                    'PROMPT',
                    {verb: 'restart'}
                )
            ).rejects.toMatchObject({failure: {kind: 'leaked-tool-call'}})
        })
    })

    test('runPhaseChild re-prompts with the hint appended and returns the clean retry', async () => {
        const {spawn, prompts} = capturingQueue([LEAKED, 'clean tooling output'])
        const out = await runPhaseChild(
            depsWith(spawn),
            'verify-tooling',
            'read',
            'ORIGINAL PROMPT'
        )
        expect(out).toBe('clean tooling output')
        expect(prompts.length).toBe(2)
        expect(prompts[0]).toBe('ORIGINAL PROMPT')
        expect(prompts[1]).toContain('SYSTEM NOTE')
        expect(prompts[1]).toContain('ORIGINAL PROMPT')
    })

    test('runPhaseChild throws LeakedToolCallError when every attempt leaks', async () => {
        await expect(
            runPhaseChild(
                depsWith(
                    fakeSpawnQueue([
                        agentEndResponse(LEAKED),
                        agentEndResponse(LEAKED),
                        agentEndResponse(LEAKED)
                    ])
                ),
                'verify-tooling',
                'read',
                'prompt'
            )
        ).rejects.toMatchObject({failure: {kind: 'leaked-tool-call'}})
    })
})

describe('runWithEmphasisRetry', () => {
    test('second attempt receives prior problem string in builder', async () => {
        const spawn = fakeSpawnQueue([
            agentEndResponse('first-bad'),
            agentEndResponse('second-good')
        ])
        const builds: Array<string | null> = []
        const result = await runWithEmphasisRetry(
            {cwd: '/tmp', taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
            'compose',
            'read',
            problem => {
                builds.push(problem)
                return 'PROMPT'
            },
            text =>
                text === 'first-bad' ? {ok: false, problem: 'looks bad'} : {ok: true, value: text},
            problem => new Error(`compose_invalid: ${problem}`)
        )
        expect(result).toBe('second-good')
        expect(builds).toEqual([null, 'looks bad'])
    })

    test('throws caller-built error after two failed attempts', async () => {
        const spawn = fakeSpawnQueue([agentEndResponse('bad-1'), agentEndResponse('bad-2')])
        await expect(
            runWithEmphasisRetry(
                {cwd: '/tmp', taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                'compose',
                'read',
                () => 'PROMPT',
                () => ({ok: false, problem: 'still bad'}),
                problem => new Error(`compose_invalid: ${problem}`)
            )
        ).rejects.toThrow(/compose_invalid: still bad/)
    })
})

// ─── Shared error-triage ladder ──────────────────────────────────────────────

/** Serve a queue of SpawnResponses in order while capturing the PROMPT each
 *  spawn was fed on stdin — so a test can assert what the re-prompt carried
 *  (a correction hint, or the bare original prompt). */
function ladderSpawn(responses: ReadonlyArray<SpawnResponse>): {
    spawn: SpawnFn
    prompts: string[]
} {
    const prompts: string[] = []
    let i = 0
    const spawn = fakeSpawnByPrompt(args => {
        prompts.push(String(args[args.length - 1]))
        const r = responses[Math.min(i, responses.length - 1)]!
        i++
        return r
    })
    return {spawn, prompts}
}

/**
 * The two option sets that share the ladder, driven identically. Both are handed
 * the SAME literal prompt and the same queued child responses, so any rung that
 * behaved differently between them would show up as a diff in `prompts` or in
 * the thrown error. `verb` is the caller's own word in the debug log — the
 * single externally visible difference the collapse deliberately preserved, and
 * the only reason `PhaseChildOptions.verb` exists.
 */
const LADDER_CALL_SITES = [
    {
        label: 'runPhaseChild (default verb)',
        verb: 'retry',
        otherVerb: 'restart',
        run: (deps: Parameters<typeof runPhaseChild>[0], name: string) =>
            runPhaseChild(deps, name, 'read', 'ORIGINAL PROMPT')
    },
    {
        label: "runPhaseChild ({verb: 'restart'})",
        verb: 'restart',
        otherVerb: 'retry',
        run: (deps: Parameters<typeof runPhaseChild>[0], name: string) =>
            runPhaseChild(deps, name, 'read', 'ORIGINAL PROMPT', {verb: 'restart'})
    }
] as const

describe('shared error-triage ladder', () => {
    // Two byte-identical copies of this ladder, one per call site, would let a fix
    // to one silently miss the other. There is one loop; these tests run all four
    // rungs through BOTH option sets so the one externally visible difference
    // stays the only one.
    for (const site of LADDER_CALL_SITES) {
        describe(site.label, () => {
            const depsFor = (spawn: SpawnFn, debug?: string[]) => ({
                cwd: '/tmp',
                taskId: 'TASK_TEST',
                signal: new AbortController().signal,
                spawn,
                sleepFor: async () => {},
                logDebug: debug ? (msg: string) => void debug.push(msg) : undefined
            })

            test('rung 1: a non-zero exit throws immediately, without re-spawning', async () => {
                const {spawn, prompts} = ladderSpawn([
                    {...agentEndResponse('', 3), stderr: 'kaboom'},
                    agentEndResponse('should not be reached')
                ])
                await expect(site.run(depsFor(spawn), 'refine')).rejects.toThrow(
                    /refine child failed.*kaboom/
                )
                // A dead child is not transient — no budget is spent on it.
                expect(prompts.length).toBe(1)
            })

            test('rung 2: a connection-class model error backs off, re-sends the bare prompt, and logs its own verb', async () => {
                const debug: string[] = []
                const {spawn, prompts} = ladderSpawn([
                    agentErrorResponse('Connection error.'),
                    agentEndResponse('recovered output')
                ])
                const out = await site.run(depsFor(spawn, debug), 'grill-gen')
                expect(out).toBe('recovered output')
                expect(prompts.length).toBe(2)
                // Nothing to correct: the re-spawn gets the untouched prompt.
                expect(prompts[1]).toBe('ORIGINAL PROMPT')
                // The verb is the only way to tell from a debug log WHICH wrapper
                // ran the ladder — it must survive the collapse, per call site.
                const line = debug.find(l => l.includes('connection error'))
                expect(line).toContain(`— ${site.verb} 1/2`)
                expect(line).not.toContain(site.otherVerb)
            })

            test('rung 2: a NON-connection model error fails fast with ModelError', async () => {
                const {spawn, prompts} = ladderSpawn([
                    agentErrorResponse('400 context length exceeded'),
                    agentEndResponse('should not be reached')
                ])
                const p = site.run(depsFor(spawn), 'refine')
                await expect(p).rejects.toMatchObject({failure: {kind: 'model-error'}})
                await expect(p).rejects.toThrow(/model error — 400 context length exceeded/)
                expect(prompts.length).toBe(1)
            })

            test('rung 3: an empty completion re-spawns with the bare prompt', async () => {
                const {spawn, prompts} = ladderSpawn([
                    agentEndResponse(''),
                    agentEndResponse('recovered output')
                ])
                expect(await site.run(depsFor(spawn), 'refine')).toBe('recovered output')
                expect(prompts.length).toBe(2)
                expect(prompts[1]).toBe('ORIGINAL PROMPT')
            })

            test('rung 4: a leaked tool call re-spawns with a correction hint prepended', async () => {
                const {spawn, prompts} = ladderSpawn([
                    agentEndResponse(LEAKED),
                    agentEndResponse('clean output')
                ])
                expect(await site.run(depsFor(spawn), 'verify-tooling')).toBe('clean output')
                expect(prompts.length).toBe(2)
                expect(prompts[0]).toBe('ORIGINAL PROMPT')
                expect(prompts[1]).toContain('SYSTEM NOTE')
                expect(prompts[1]).toContain('ORIGINAL PROMPT')
            })

            test('spends the same budget — 3 attempts — before giving up', async () => {
                // MAX_LEAK_RETRIES (leaked-tool-call.ts) and MAX_LOOP_RESTARTS
                // (loop-detector.ts) are separate budgets that happen to agree at
                // 2, so each cause alone allows THREE attempts; this pins that
                // arithmetic — budget + 1 — for both verbs.
                const empty = ladderSpawn([agentEndResponse('')])
                await expect(site.run(depsFor(empty.spawn), 'refine')).rejects.toThrow(
                    /refine child produced no output/
                )
                expect(empty.prompts.length).toBe(3)

                const leak = ladderSpawn([agentEndResponse(LEAKED)])
                await expect(site.run(depsFor(leak.spawn), 'verify-tooling')).rejects.toMatchObject(
                    {failure: {kind: 'leaked-tool-call'}}
                )
                expect(leak.prompts.length).toBe(3)

                const conn = ladderSpawn([agentErrorResponse('socket hang up')])
                await expect(site.run(depsFor(conn.spawn), 'grill-gen')).rejects.toMatchObject({
                    failure: {kind: 'model-error'}
                })
                expect(conn.prompts.length).toBe(3)
            })
        })
    }
})

// ─── Planning children need their own guards ─────────────────────────────────
//
// A /task-auto planning child — decompose, say — can run indefinitely without
// returning, re-reading design files it has already read to refill a context
// window pi keeps compacting. From the host that is invisible: the process is
// alive, the stream is busy, and the plan-debug log simply stops gaining lines.
//
// Neither existing guard catches it. Pass `undefined` for runChild's
// `onToolCall` and no LoopDetector is constructed at all. And
// `streamInactivityMs` fires only on SILENCE, while a child thrashing through
// reads is the opposite of silent. Research workers carry both a loop guard and
// a wall clock (RESEARCH_WORKER_TIMEOUT_MS, workers/worker-profiles.ts) for
// exactly this failure.
//
// The two tests below are the contract the planning seam has to satisfy.
describe('runPhaseChild — planning-child runaway guards', () => {
    test('restarts a planning child that repeats one identical tool call', async () => {
        const {spawn, prompts} = ladderSpawn([
            // A decompose child stuck on the same read, which then answers
            // anyway — so the empty-completion rung of the ladder cannot be what
            // rescues this. Only loop detection can.
            loopResponse('read', {path: 'DESIGN/marketplace.html'}, LOOP_THRESHOLD, {
                trailingText: 'thrashed answer'
            }),
            agentEndResponse('clean answer')
        ])
        const out = await runPhaseChild(depsWith(spawn), 'auto-decompose', 'read', 'DECOMPOSE')
        expect(prompts.length).toBe(2)
        expect(prompts[1]).toContain('SYSTEM NOTE')
        expect(prompts[1]).toContain('read')
        expect(out).toBe('clean answer')
    })

    test('kills a planning child that outlives its wall-clock budget', async () => {
        const prompts: string[] = []
        const procs: Array<ReturnType<typeof makeProc>> = []
        let i = 0
        // Attempt 1 thrashes with VARIED args — the shape an exact-match loop
        // detector cannot see — and never closes on its own, which is what a
        // child burning its context window on re-reads looks like from here.
        // Attempt 2 answers. Only a wall-clock cap gets us from one to two.
        const spawn = (() => {
            const p = makeProc()
            procs.push(p)
            const first = i++ === 0
            p.kill = () => {
                if (p.killed) return true
                p.killed = true
                p.emit('close', 143)
                return true
            }
            queueMicrotask(() => {
                prompts.push(p.stdinData)
                if (first) {
                    for (let n = 0; n < 40; n++) {
                        p.stdout!.emit(
                            'data',
                            Buffer.from(
                                JSON.stringify({
                                    type: 'tool_execution_start',
                                    toolName: 'read',
                                    args: {path: 'DESIGN/marketplace.html', offset: n * 50 + 1}
                                }) + '\n'
                            )
                        )
                    }
                    return // deliberately no close: the child is still "working"
                }
                p.stdout!.emit(
                    'data',
                    Buffer.from(
                        JSON.stringify({
                            type: 'agent_end',
                            messages: [
                                {
                                    role: 'assistant',
                                    content: [{type: 'text', text: 'clean answer'}]
                                }
                            ]
                        }) + '\n'
                    )
                )
                p.emit('close', 0)
            })
            return p
        }) as unknown as SpawnFn

        const out = await runPhaseChild(
            {...depsWith(spawn), timeoutMs: 100},
            'auto-decompose',
            'read',
            'DECOMPOSE'
        )
        expect(procs[0]!.killed).toBe(true)
        expect(prompts.length).toBe(2)
        // A timeout must read as "you ran out of time", not as the bare
        // "child failed" that SIGTERM's exit 143 would otherwise produce.
        expect(prompts[1]).toContain('SYSTEM NOTE')
        expect(out).toBe('clean answer')
    }, 2000)

    // The wall clock above is OFF in production — the `phase` row arms none
    // (worker-profiles.ts). A healthy decompose and a runaway one occupy the same
    // range of elapsed times, so any cap that catches the runaway also kills good
    // work. The StallDetector replaces it, and this pins that it kills the same
    // runaway with NO clock armed at all.
    test('kills a thrashing planning child with no wall clock armed', async () => {
        const prompts: string[] = []
        const procs: Array<ReturnType<typeof makeProc>> = []
        let i = 0
        const spawn = (() => {
            const p = makeProc()
            procs.push(p)
            const first = i++ === 0
            p.kill = () => {
                if (p.killed) return true
                p.killed = true
                p.emit('close', 143)
                return true
            }
            queueMicrotask(() => {
                prompts.push(p.stdinData)
                if (first) {
                    // Five files cycled over and over. In any 20-call window each
                    // path appears at most 4 times, and LoopDetector's threshold
                    // is 5 (loop-detector.ts:102), so neither of its rules ever
                    // trips — yet across the whole run nothing new is read. The
                    // cycle length equals the window, which is what hides it.
                    const paths = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md']
                    for (let n = 0; n < 40; n++) {
                        p.stdout!.emit(
                            'data',
                            Buffer.from(
                                JSON.stringify({
                                    type: 'tool_execution_start',
                                    toolName: 'read',
                                    args: {path: paths[n % paths.length]}
                                }) + '\n'
                            )
                        )
                    }
                    return
                }
                p.stdout!.emit(
                    'data',
                    Buffer.from(
                        JSON.stringify({
                            type: 'agent_end',
                            messages: [
                                {role: 'assistant', content: [{type: 'text', text: 'clean answer'}]}
                            ]
                        }) + '\n'
                    )
                )
                p.emit('close', 0)
            })
            return p
        }) as unknown as SpawnFn

        const out = await runPhaseChild(depsWith(spawn), 'auto-decompose', 'read', 'DECOMPOSE')
        expect(procs[0]!.killed).toBe(true)
        expect(prompts.length).toBe(2)
        // The hint must name the mistake it actually made — re-reading — and must
        // not tell a model that was merely slow to hurry up.
        expect(prompts[1]).toContain('already read')
        expect(out).toBe('clean answer')
    }, 2000)
})

describe('childArgs in-run guard extensions', () => {
    // The nudge beats the kill: pi turns a tool_call block into an error tool
    // result, so the child keeps its context instead of being re-spawned from
    // nothing. Planning children opt in via PhaseDeps.childExtensions
    // (auto-orchestrator), which lands here.
    test('loads each requested extension with -e, ahead of the base args', () => {
        const args = childArgs('read', ['/x/single-read-extension.js'])
        const i = args.indexOf('-e')
        expect(i).toBeGreaterThanOrEqual(0)
        expect(args[i + 1]).toBe('/x/single-read-extension.js')
        expect(args).toContain('--no-extensions')
    })

    test('a no-tools child carries no guard extension — it cannot make a tool call', () => {
        expect(childArgs('', ['/x/single-read-extension.js'])).not.toContain('-e')
    })

    test('no extensions requested leaves argv unchanged', () => {
        expect(childArgs('read')).not.toContain('-e')
    })
})

describe('PhaseDeps.runChild seam', () => {
    // The child's NAME is what a caller branches on, so the seam has to carry it
    // through to `spawn`. Discard it and a phase test can only recover the name
    // by matching prompt PROSE against prompts.ts — coupling the suite's routing
    // to copy that gets reworded all the time.
    const noSpawn: SpawnFn = () => {
        throw new Error('spawned a real child despite deps.runChild')
    }

    test('runPhaseChild delegates, and is handed the name it was called with', async () => {
        const seen: Array<{name: string; tools: string; prompt: string}> = []
        const out = await runPhaseChild(
            {
                cwd: '/tmp',
                taskId: 'TASK_TEST',
                signal: new AbortController().signal,
                spawn: noSpawn,
                runChild: (name, tools, prompt) => {
                    seen.push({name, tools, prompt})
                    return Promise.resolve(`answer for ${name}`)
                }
            },
            'refine',
            'read',
            'the prompt'
        )
        expect(out).toBe('answer for refine')
        expect(seen).toEqual([{name: 'refine', tools: 'read', prompt: 'the prompt'}])
    })

    test('a restart-verb caller delegates with the same clean prompt', async () => {
        const seen: string[] = []
        const out = await runPhaseChild(
            {
                cwd: '/tmp',
                taskId: 'TASK_TEST',
                signal: new AbortController().signal,
                spawn: noSpawn,
                runChild: (name, _tools, prompt) => {
                    seen.push(`${name}:${prompt}`)
                    return Promise.resolve('done')
                }
            },
            'grill-gen',
            'read',
            'clean prompt',
            {verb: 'restart', degradeOnExhaustion: true}
        )
        expect(out).toBe('done')
        // The substitute stands in for the whole guarded run: no loop hit has
        // happened, so it sees the prompt with no hint in front of it — and the
        // options are the loop's, invisible to a caller that replaced the loop.
        expect(seen).toEqual(['grill-gen:clean prompt'])
    })

    test('absent → the real wrappers run, so the ladder still owns the verdict', async () => {
        // The seam must not weaken the guards it stands in front of: with no
        // substitute, an empty completion is still the ladder's failure.
        await expect(
            runPhaseChild(
                {
                    cwd: '/tmp',
                    taskId: 'TASK_TEST',
                    signal: new AbortController().signal,
                    spawn: fakeSpawnSimple('', 0)
                },
                'refine',
                'read',
                'prompt'
            )
        ).rejects.toThrow(/refine child produced no output/)
    })
})

/**
 * Before the `phase` row was wired in, a hung command in verify-tooling
 * (`read,bash`) could not be ended by anything but a user ESC.
 *
 * The second test carries the weight: a kill reports exit 0, so one that is not
 * mapped to a named cause is returned as a SUCCESSFUL answer with truncated text.
 */
describe('runPhaseChild — a guard kill on the no-tools degrade attempt', () => {
    /**
     * The degrade is the one spawn path that is not the strike loop, and it is
     * reached only after the budget is spent. `runChild` arms commandWatch from
     * the profile with no reference to `tools` and calls onStart before it checks
     * for a handler, so the watchdog is live here despite `--no-tools`.
     *
     * The PARTIAL TEXT is what makes this able to fail: with no text the mutant
     * falls through to the loop failure, which still rejects.
     */
    test('a command kill on the degrade is thrown, never returned as the answer', async () => {
        const original = getConfig().requestTimeoutMs
        getConfig().requestTimeoutMs = 30
        try {
            const argvs: Array<ReadonlyArray<string>> = []
            const spawn = ((_cmd: string, args: ReadonlyArray<string>) => {
                const p = makeProc()
                argvs.push(args)
                if (args.includes('--no-tools')) {
                    p.kill = () => {
                        if (p.killed) return true
                        p.killed = true
                        p.emit('close', 143)
                        return true
                    }
                    queueMicrotask(() => {
                        p.stdout!.emit(
                            'data',
                            Buffer.from(
                                JSON.stringify(agentEndResponse('HALF A SPEC').events[0]) + '\n'
                            )
                        )
                        p.stdout!.emit(
                            'data',
                            Buffer.from(
                                JSON.stringify({
                                    type: 'tool_execution_start',
                                    toolCallId: 'c1',
                                    toolName: 'bash',
                                    args: {command: 'bun run dev'}
                                }) + '\n'
                            )
                        )
                    })
                } else {
                    queueMicrotask(() => {
                        for (const e of loopEvents('Read', {path: '/foo'}, LOOP_THRESHOLD)) {
                            p.stdout!.emit('data', Buffer.from(JSON.stringify(e) + '\n'))
                        }
                        p.emit('close', 0)
                    })
                }
                return p
            }) as unknown as SpawnFn

            const outcome = await runPhaseChild(
                {cwd: '/tmp', taskId: 'TASK_TEST', signal: new AbortController().signal, spawn},
                'refine',
                'read',
                'PROMPT',
                {degradeOnExhaustion: true, verb: 'restart'}
            ).then(
                text => ({returned: text}),
                (e: unknown) => ({threw: e})
            )

            expect(argvs.length).toBe(MAX_LEAK_RETRIES + 2)
            expect(argvs[MAX_LEAK_RETRIES + 1]).toContain('--no-tools')
            expect('returned' in outcome).toBe(false)
            // The CLASS, not just "it rejected" — that is what the earlier
            // attempt got wrong.
            expect((outcome as {threw: unknown}).threw).toMatchObject({
                failure: {kind: 'command-timeout'}
            })
        } finally {
            getConfig().requestTimeoutMs = original
        }
    })
})

describe('runPhaseChild — command watchdog', () => {
    /** A child that starts a tool call and then blocks forever, emitting no end. */
    const hung = (command: string): SpawnResponseJsonEvents => ({
        events: [
            {type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash', args: {command}}
        ],
        exitCode: 0
    })

    // The ceiling is the user's own `requestTimeoutMs`, so a test drives it the
    // same way test/task/command-watchdog.test.ts already does.
    const withCeiling = async (ms: number, run: () => Promise<void>): Promise<void> => {
        const original = getConfig().requestTimeoutMs
        getConfig().requestTimeoutMs = ms
        try {
            await run()
        } finally {
            getConfig().requestTimeoutMs = original
        }
    }

    test('kills a hung command instead of hanging the phase forever', async () => {
        await withCeiling(30, async () => {
            const prompts: string[] = []
            // fakeSpawnKillable never closes on its own: if the watchdog fails to
            // fire this test HANGS rather than fails, which is the production
            // symptom exactly.
            const deps = depsWith(fakeSpawnKillable([hung('bun run dev')], p => prompts.push(p)))
            await expect(
                runPhaseChild(deps, 'verify-tooling', 'read,bash', 'go')
            ).rejects.toMatchObject({
                failure: {kind: 'command-timeout'}
            })
            // Initial attempt plus the leak/restart budget, same as any other
            // restartable phase cause.
            expect(prompts.length).toBe(MAX_LEAK_RETRIES + 1)
        })
    })

    test('a watchdog kill is NEVER returned as a successful answer', async () => {
        await withCeiling(30, async () => {
            const deps = depsWith(fakeSpawnKillable([hung('bun run dev')]))
            const outcome = await runPhaseChild(deps, 'verify-tooling', 'read,bash', 'go').then(
                text => ({returned: text}),
                (e: unknown) => ({threw: e})
            )
            // The whole point: no branch may hand this back as phase output.
            expect('returned' in outcome).toBe(false)
            expect(outcome).toHaveProperty('threw')
        })
    })

    test('the restart hint names the command, so the retry can bound it', async () => {
        await withCeiling(30, async () => {
            const prompts: string[] = []
            const deps = depsWith(fakeSpawnKillable([hung('bun run dev')], p => prompts.push(p)))
            await runPhaseChild(deps, 'verify-tooling', 'read,bash', 'go').catch(() => {})
            expect(prompts[1]).toContain('bun run dev')
        })
    })

    test('the hint warns about surviving side effects only for a bash child', async () => {
        await withCeiling(30, async () => {
            const bashPrompts: string[] = []
            await runPhaseChild(
                depsWith(fakeSpawnKillable([hung('bun run build')], p => bashPrompts.push(p))),
                'verify-tooling',
                'read,bash',
                'go'
            ).catch(() => {})
            // verify-tooling is the ONLY phase child with bash, and a command kill
            // is by construction a bash overrun — a half-written node_modules or a
            // still-listening server survives the kill.
            expect(bashPrompts[1]).toMatch(/still in the working tree/)
        })
    })

    test('off means off: a 0 ceiling arms no watchdog', async () => {
        await withCeiling(0, async () => {
            const deps = depsWith(
                fakeSpawnSimple(
                    agentEndResponse('answered')
                        .events!.map(e => JSON.stringify(e))
                        .join('\n')
                )
            )
            // A healthy child is unaffected either way; this pins that resolving the
            // policy did not make the guard unconditional.
            expect(workerPolicy('phase', {commandTimeoutMs: 0}).guards['command-timeout']).toBe(0)
            await runPhaseChild(deps, 'refine', 'read', 'go').catch(() => {})
        })
    })
})

describe('isConnectionError — the transport classes pi retries', () => {
    /**
     * The pattern REPRODUCES the transport half of pi's `isRetryableAssistantError`
     * (@earendil-works/pi-ai, `dist/utils/retry.js`) rather than importing it —
     * pi-ai is in none of the three dependency lists, the reason
     * shared/reasoning-capability.ts records. A reproduction stays honest only by
     * re-comparison, so these cases ARE the comparison.
     *
     * MEASURED: everything from `The operation timed out.` down was a MISS before
     * this. Each is a REMOTE-provider failure, which is why a local llama.cpp setup
     * never surfaced the gap.
     *
     * NOT reproduced, deliberately: pi also retries the provider-LOAD family (429,
     * 5xx, rate limit, overloaded). `does NOT match real, non-transient faults`
     * below states the opposite policy for this repo, and this backoff starts at
     * 500ms — too fast to answer a throttle with. That disagreement is open.
     */
    const retryable = [
        'connection refused',
        'fetch failed',
        'socket hang up',
        'ECONNREFUSED 127.0.0.1:8080',
        'The operation timed out.',
        'getaddrinfo ENOTFOUND api.anthropic.com',
        'upstream connect error',
        'reset before headers',
        'socket connection was closed',
        'Anthropic stream ended before message_stop',
        'stream ended without a terminal event',
        'websocket closed'
    ]
    test('every transport class pi retries is retried here', () => {
        for (const c of retryable) expect([c, isConnectionError(c)]).toEqual([c, true])
    })
})

describe('isFatalChildCause', () => {
    test('a dead backend and a user cancel are fatal', () => {
        expect(isFatalChildCause(new ChildFailureError('refine', {kind: 'stalled'}))).toBe(true)
        expect(isFatalChildCause(new Error(USER_CANCELLED))).toBe(true)
    })

    test('a child that merely answered badly is not', () => {
        // These are what the best-effort catches exist to absorb.
        expect(isFatalChildCause(new Error('refine child produced no output'))).toBe(false)
        expect(
            isFatalChildCause(
                new ChildFailureError('t', {
                    kind: 'command-timeout',
                    toolName: 'bash',
                    timeoutMs: 1
                })
            )
        ).toBe(false)
        expect(isFatalChildCause(undefined)).toBe(false)
        expect(isFatalChildCause('a bare string')).toBe(false)
    })
})
