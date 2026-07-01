import {describe, expect, test} from 'bun:test'
import {
    runPhaseChild,
    prependHint,
    runPhaseWithLoopGuard,
    runWithEmphasisRetry,
    LoopExhaustedError,
    LeakedToolCallError,
    ModelError,
    childArgs,
    isConnectionError,
    connectionRetryBackoffMs
} from './child-runner.js'
import {
    fakeSpawnSimple,
    agentEndResponse,
    agentErrorResponse,
    fakeSpawnQueue,
    fakeSpawnByPrompt,
    type SpawnResponse
} from '../test-utils/fake-spawn.js'
import type {ProcLike, SpawnFn} from '../shared/child-process.js'
import {withTmpTaskDir} from '../test-utils/tmp-task-dir.js'
import {writeTaskFile, readSection} from './task-io.js'
import {EventEmitter} from 'node:events'

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
    // Regression: commit 4e34f96 silently dropped `--mode json` while splitting
    // the orchestrator monolith. pi defaults to plain-text output; without this
    // flag the json-events parser receives no JSON and every phase fails with
    // "X child produced no output". Keep this test even if it looks trivial —
    // it's the only thing pinning the contract between the spawn flags and the
    // runChild parser mode.
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
        // The prompt must NOT be an argv element — it goes over stdin so a large
        // prompt can't overflow the OS command line (issue #1: spawn ENAMETOOLONG).
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
        await expect(p).rejects.toBeInstanceOf(ModelError)
        await expect(p).rejects.toThrow(/model error — 400 context length exceeded/)
    })

    test('retries a connection-class model error and returns the later clean output', async () => {
        // The TASK_0012 grill-gen failure: one dropped fetch to a live single-slot
        // local server reported as "Connection error.". It's transient — the
        // re-spawn succeeds. Fail-fast here would have killed the whole task.
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
        await expect(p).rejects.toBeInstanceOf(ModelError)
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
        // This is the literal errorMessage pi surfaced on TASK_0012 grill-gen.
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
            'rate limit exceeded',
            'internal server error'
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

describe('runPhaseWithLoopGuard', () => {
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
            const spawn = fakeSpawnQueue([
                {events: loopEvents('Read', {path: '/foo'}, 5)},
                agentEndResponse('refined content')
            ])
            const builds: Array<string | null> = []
            const out = await runPhaseWithLoopGuard(
                {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                'refine',
                'read',
                hint => {
                    builds.push(hint)
                    return 'PROMPT'
                }
            )
            expect(out).toBe('refined content')
            expect(builds.length).toBe(2)
            expect(builds[0]).toBeNull()
            expect(builds[1]).toContain('SYSTEM NOTE')
            expect(builds[1]).toContain('Read')
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
            // First strike yields no assistant text (transient empty turn); the
            // re-spawn succeeds. This is the TASK_0005 refine failure mode.
            const spawn = fakeSpawnQueue([
                agentEndResponse(''),
                agentEndResponse('refined content')
            ])
            const builds: Array<string | null> = []
            const out = await runPhaseWithLoopGuard(
                {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                'refine',
                'read',
                hint => {
                    builds.push(hint)
                    return 'PROMPT'
                }
            )
            expect(out).toBe('refined content')
            expect(builds.length).toBe(2)
            // Empty output carries no hint — the restart sees a null hint, not a SYSTEM NOTE.
            expect(builds[1]).toBeNull()
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
            const p = runPhaseWithLoopGuard(
                {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                'refine',
                'read',
                () => 'PROMPT'
            )
            await expect(p).rejects.toBeInstanceOf(ModelError)
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
            // The TASK_0012 grill-gen failure: a single "Connection error." against
            // a live single-slot local server. Transient — the restart succeeds.
            const spawn = fakeSpawnQueue([
                agentErrorResponse('Connection error.'),
                agentEndResponse('grilled questions')
            ])
            const builds: Array<string | null> = []
            const out = await runPhaseWithLoopGuard(
                {
                    cwd,
                    taskId: 'TASK_0001',
                    signal: new AbortController().signal,
                    spawn,
                    sleepFor: async () => {}
                },
                'grill-gen',
                'read',
                hint => {
                    builds.push(hint)
                    return 'PROMPT'
                }
            )
            expect(out).toBe('grilled questions')
            expect(builds.length).toBe(2)
            // A connection restart carries no correction hint — same bare prompt.
            expect(builds[1]).toBeNull()
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
            const p = runPhaseWithLoopGuard(
                {
                    cwd,
                    taskId: 'TASK_0001',
                    signal: new AbortController().signal,
                    spawn,
                    sleepFor: async () => {}
                },
                'grill-gen',
                'read',
                () => 'PROMPT'
            )
            await expect(p).rejects.toBeInstanceOf(ModelError)
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
                runPhaseWithLoopGuard(
                    {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                    'refine',
                    'read',
                    () => 'PROMPT'
                )
            ).rejects.toThrow(/refine child produced no output/)
        })
    })

    test('throws LoopExhaustedError after MAX_LOOP_RESTARTS+1 strikes', async () => {
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
                runPhaseWithLoopGuard(
                    {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                    'refine',
                    'read',
                    () => 'PROMPT'
                )
            ).rejects.toBeInstanceOf(LoopExhaustedError)
        })
    })

    // ─── degradeOnExhaustion (TASK_0016 fix) ────────────────────────────────
    // refine on a "write tests" task against a large existing codebase made the
    // weak local model over-explore — re-reading source hunting for the impl
    // until the loop budget was spent — and a hard-fail there killed the whole
    // /task-auto run on every resume. The deliverable (a 4-section text rewrite)
    // never needed a successful read, so the budget-exhausted phase now does ONE
    // no-tools final attempt instead of throwing.
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
                const builds: Array<string | null> = []
                const out = await runPhaseWithLoopGuard(
                    {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                    'refine',
                    'read',
                    hint => {
                        builds.push(hint)
                        return 'PROMPT'
                    },
                    {degradeOnExhaustion: true}
                )
                expect(out).toBe('GOAL\n  a degraded but complete spec')
                // 4 spawns: 3 strikes + 1 degrade attempt.
                expect(calls.length).toBe(4)
                // The first three carry `--tools read`; the degrade carries `--no-tools`.
                for (const c of calls.slice(0, 3)) expect(c).toContain('--tools')
                expect(calls[3]).toContain('--no-tools')
                expect(calls[3]).not.toContain('--tools')
                // The degrade prompt was built with the terminal "NO tools" hint.
                expect(builds.length).toBe(4)
                expect(builds[3]).toContain('SYSTEM NOTE')
                expect(builds[3]).toContain('NO tools')
            })
        })

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
                await runPhaseWithLoopGuard(
                    {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                    'refine',
                    'read',
                    () => 'PROMPT',
                    {degradeOnExhaustion: true}
                )
                const events = (await readSection(cwd, 'TASK_0001', 'loop events')) ?? ''
                expect(events).toContain('degraded — no-tools final attempt')
                expect(events).not.toContain('phase failed')
            })
        })

        test('still throws LoopExhaustedError when even the no-tools attempt yields no output', async () => {
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
                    runPhaseWithLoopGuard(
                        {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                        'refine',
                        'read',
                        () => 'PROMPT',
                        {degradeOnExhaustion: true}
                    )
                ).rejects.toBeInstanceOf(LoopExhaustedError)
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
                    runPhaseWithLoopGuard(
                        {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                        'refine',
                        'read',
                        () => 'PROMPT'
                    )
                ).rejects.toBeInstanceOf(LoopExhaustedError)
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
    test('runPhaseWithLoopGuard restarts with a correction hint when the child leaks a call', async () => {
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
                agentEndResponse('clean refined content')
            ])
            const builds: Array<string | null> = []
            const out = await runPhaseWithLoopGuard(
                {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                'refine',
                'read',
                hint => {
                    builds.push(hint)
                    return 'PROMPT'
                }
            )
            expect(out).toBe('clean refined content')
            expect(builds.length).toBe(2)
            expect(builds[0]).toBeNull()
            expect(builds[1]).toContain('SYSTEM NOTE')
            expect(builds[1]).toMatch(/tool call/i)
        })
    })

    test('runPhaseWithLoopGuard throws LeakedToolCallError when every attempt leaks', async () => {
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
                runPhaseWithLoopGuard(
                    {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                    'refine',
                    'read',
                    () => 'PROMPT'
                )
            ).rejects.toBeInstanceOf(LeakedToolCallError)
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
        ).rejects.toBeInstanceOf(LeakedToolCallError)
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
