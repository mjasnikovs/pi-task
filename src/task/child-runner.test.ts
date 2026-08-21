import {describe, expect, test} from 'bun:test'
import {
    runPhaseChild,
    prependHint,
    runWithEmphasisRetry,
    LoopExhaustedError,
    LeakedToolCallError,
    ModelError,
    childArgs,
    isConnectionError,
    connectionRetryBackoffMs,
    LOOP_THRESHOLD
} from './child-runner.js'
import {
    fakeSpawnSimple,
    agentEndResponse,
    agentErrorResponse,
    fakeSpawnQueue,
    fakeSpawnByPrompt,
    loopResponse,
    makeProc,
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
            // First strike yields no assistant text (transient empty turn); the
            // re-spawn succeeds. This is the TASK_0005 refine failure mode.
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
                runPhaseChild(
                    {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                    'refine',
                    'read',
                    'PROMPT',
                    {verb: 'restart'}
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
                    runPhaseChild(
                        {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                        'refine',
                        'read',
                        'PROMPT',
                        {degradeOnExhaustion: true, verb: 'restart'}
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
                    runPhaseChild(
                        {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                        'refine',
                        'read',
                        'PROMPT',
                        {verb: 'restart'}
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
    // runPhaseChild and runPhaseWithLoopGuard used to carry two byte-identical
    // copies of this ladder 166 lines apart, so a fix to one silently missed the
    // other. There is one loop now; these tests run all four rungs through BOTH
    // option sets so the one externally visible difference stays the only one.
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
                await expect(p).rejects.toBeInstanceOf(ModelError)
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
                // MAX_LEAK_RETRIES and MAX_LOOP_RESTARTS are separate policies that
                // happen to agree at 2 today. Both wrappers therefore run 3 attempts
                // total; this pins the arithmetic (budget+1) on both sides.
                const empty = ladderSpawn([agentEndResponse('')])
                await expect(site.run(depsFor(empty.spawn), 'refine')).rejects.toThrow(
                    /refine child produced no output/
                )
                expect(empty.prompts.length).toBe(3)

                const leak = ladderSpawn([agentEndResponse(LEAKED)])
                await expect(
                    site.run(depsFor(leak.spawn), 'verify-tooling')
                ).rejects.toBeInstanceOf(LeakedToolCallError)
                expect(leak.prompts.length).toBe(3)

                const conn = ladderSpawn([agentErrorResponse('socket hang up')])
                await expect(site.run(depsFor(conn.spawn), 'grill-gen')).rejects.toBeInstanceOf(
                    ModelError
                )
                expect(conn.prompts.length).toBe(3)
            })
        })
    }
})

// ─── Regression: unguarded planning children ─────────────────────────────────
//
// mx5-n, 2026-08-14. /task-auto's decompose child (the coverage-retry of round
// 1) ran for 16m23s and never returned. Measured while it was still alive:
//
//   • the child PID had been up 16m23s, and .pi-tasks/plan-debug.log had not
//     gained a line for that whole stretch — last entry "decompose-coverage
//     round 1: INCOMPLETE" at 20:28:25Z.
//   • the loader showed the child at 102k/120k, and the model server's slot
//     reported n_prompt_tokens 117,370 against a 120,064-token window for the
//     request it was serving.
//   • polled over one minute, the child's context climbed 15k → 71k tokens —
//     more tool output per minute than the whole DESIGN directory holds
//     (64 KB across four files), so it was re-reading design files it had
//     already read.
//   • the last tool line on the loader was `read: DESIGN/marketplace.html`.
//
// Nothing in the host could end it. runPhaseChild is the runner EVERY
// /task-auto planning child goes through — clarify, decompose, coverage,
// contract-extract — and it passes `undefined` for runChild's `onToolCall`, so
// no LoopDetector was ever constructed for them; only the (now deleted)
// runPhaseWithLoopGuard built one, and the planning seam did not call it. There
// is no wall-clock
// bound either: `streamInactivityMs` only fires on SILENCE, and a child
// thrashing through reads is the opposite of silent. Research workers already
// carry both guards (RESEARCH_WORKER_TIMEOUT_MS, workers/pi-worker-core.ts) for
// exactly this failure; planning children carry neither.
//
// These two tests fail today. They are the contract the fix must satisfy.
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

    // The wall clock above is OFF in production (PHASE_CHILD_TIMEOUT_MS = 0):
    // measured healthy reasoning-on decompose runs take 610-927s, so any cap that
    // catches the runaway also kills good work. The StallDetector replaces it, and
    // this pins that it kills the same runaway with NO clock armed at all.
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
                    // The live shape: five design files cycled over and over.
                    // In any 20-call window each path appears at most 4 times, so
                    // neither of LoopDetector's rules (threshold 5) ever trips —
                    // but across the WHOLE run nothing new is being read. Never
                    // closes on its own.
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
    // The child's NAME is what a caller branches on. Before this seam it was
    // discarded before reaching `spawn`, so a phase test had to recover it by
    // matching prompt PROSE against prompts.ts — coupling the suite's routing to
    // copy this codebase reworders and A/B's for a living.
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
