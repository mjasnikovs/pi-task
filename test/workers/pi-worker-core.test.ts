import {describe, expect, test} from 'bun:test'
import {
    hasAnswerContent,
    isGroundingRetrieval,
    runWorker,
    type WorkerRestart
} from '../../src/workers/pi-worker-core.js'
import type {SpawnResponseJsonEvents} from '../test-utils/fake-spawn.js'
import type {SpawnFn} from '../../src/shared/child-process.js'
import {
    agentEndResponse,
    agentErrorResponse,
    fakeSpawnByPrompt,
    fakeSpawnQueue,
    loopResponse,
    makeProc,
    pacedSpawn
} from '../test-utils/fake-spawn.js'
import {DEFAULT_LOOP_DETECTOR, DEFAULT_LOOP_PROGRESS} from '../../src/workers/worker-profiles.js'

// A tool call the model wrote as text instead of invoking — never executed.
const LEAKED =
    '<tool_call>\n<function=bash>\n<parameter=command>grep foo</parameter>\n</function>\n</tool_call>'

describe('runWorker', () => {
    test('returns text, exitCode, stderr', async () => {
        // Pure shape test — does not actually spawn pi.
        // Cancel immediately via aborted signal so this exits fast.
        const ctrl = new AbortController()
        ctrl.abort()
        const result = await runWorker({
            prompt: 'unused',
            profile: 'adhoc',
            contextWindow: 'unknown',
            cwd: process.cwd(),
            signal: ctrl.signal
        })
        expect(typeof result.text).toBe('string')
        expect(typeof result.exitCode).toBe('number')
        expect(typeof result.stderr).toBe('string')
        expect(typeof result.aborted).toBe('boolean')
    })

    test('invokes pi with CHILD_BASE_ARGS + --mode json + --tools read,grep,find,ls and prompt last', async () => {
        let receivedArgs: ReadonlyArray<string> = []
        const spawn = fakeSpawnByPrompt(args => {
            receivedArgs = args
            return agentEndResponse('ok')
        })
        const r = await runWorker({
            prompt: 'hello',
            cwd: process.cwd(),
            spawn,
            profile: 'adhoc',
            contextWindow: 'unknown'
        })
        expect(r.text).toBe('ok')
        expect(receivedArgs).toContain('--print')
        expect(receivedArgs).toContain('--no-skills')
        expect(receivedArgs).toContain('--mode')
        expect(receivedArgs[receivedArgs.indexOf('--mode') + 1]).toBe('json')
        expect(receivedArgs).toContain('--tools')
        expect(receivedArgs[receivedArgs.indexOf('--tools') + 1]).toBe('read,grep,find,ls')
        expect(receivedArgs[receivedArgs.length - 1]).toBe('hello')
    })

    test('trims surrounding whitespace from the extracted assistant text', async () => {
        const spawn = fakeSpawnByPrompt(() => agentEndResponse('   spaced   '))
        const r = await runWorker({
            prompt: 'x',
            cwd: process.cwd(),
            spawn,
            profile: 'adhoc',
            contextWindow: 'unknown'
        })
        expect(r.text).toBe('spaced')
    })

    test('returns non-negative waitMs and workMs that sum to total elapsed', async () => {
        const spawn = fakeSpawnByPrompt(() => agentEndResponse('ok'))
        const r = await runWorker({
            prompt: 'x',
            cwd: process.cwd(),
            spawn,
            profile: 'adhoc',
            contextWindow: 'unknown'
        })
        expect(r.waitMs).toBeGreaterThanOrEqual(0)
        expect(r.workMs).toBeGreaterThanOrEqual(0)
    })

    test('workMs is zero when the child never produces stdout', async () => {
        // A child that exits without emitting stdout — onFirstByte never fires,
        // so all elapsed time is bucketed as wait, not work. This is the shape
        // we want when surfacing queue-vs-generation splits later.
        const spawn = fakeSpawnByPrompt(() => ({stdout: '', stderr: 'silent', exitCode: 1}))
        const r = await runWorker({
            prompt: 'x',
            cwd: process.cwd(),
            spawn,
            profile: 'adhoc',
            contextWindow: 'unknown'
        })
        expect(r.workMs).toBe(0)
        expect(r.waitMs).toBeGreaterThanOrEqual(0)
    })

    test('re-prompts on a leaked tool call and returns the clean retry', async () => {
        const spawn = fakeSpawnQueue([agentEndResponse(LEAKED), agentEndResponse('clean output')])
        const r = await runWorker({
            prompt: 'x',
            cwd: process.cwd(),
            spawn,
            profile: 'adhoc',
            contextWindow: 'unknown'
        })
        expect(r.text).toBe('clean output')
        expect(r.leakedToolCall).toBeUndefined()
    })

    test('flags the result when every attempt leaks a tool call', async () => {
        const spawn = fakeSpawnQueue([
            agentEndResponse(LEAKED),
            agentEndResponse(LEAKED),
            agentEndResponse(LEAKED)
        ])
        const r = await runWorker({
            prompt: 'x',
            cwd: process.cwd(),
            spawn,
            profile: 'adhoc',
            contextWindow: 'unknown'
        })
        expect(r.leakedToolCall).toBeTruthy()
    })

    // ── groundingRetrievalCount — the zero-retrieval gate's handle ──────────────
    const withToolCalls = (
        toolNames: ReadonlyArray<string>,
        text = 'done'
    ): SpawnResponseJsonEvents => ({
        events: [
            ...toolNames.map(toolName => ({
                type: 'tool_execution_start',
                toolName,
                args: {}
            })),
            {type: 'agent_end', messages: [{role: 'assistant', content: [{type: 'text', text}]}]}
        ],
        exitCode: 0
    })

    test('groundingRetrievalCount counts docs/read/grep/search/fetch, not ls/find', async () => {
        const spawn = fakeSpawnByPrompt(() =>
            withToolCalls([
                'pi-worker-docs',
                'read',
                'grep',
                'pi-worker-search',
                'pi-worker-fetch',
                'ls',
                'find'
            ])
        )
        const r = await runWorker({
            prompt: 'x',
            cwd: process.cwd(),
            spawn,
            profile: 'adhoc',
            contextWindow: 'unknown'
        })
        expect(r.groundingRetrievalCount).toBe(5)
    })

    test('groundingRetrievalCount is 0 for a section written with no tool calls (the failure)', async () => {
        const spawn = fakeSpawnByPrompt(() => agentEndResponse('an APIS section from memory'))
        const r = await runWorker({
            prompt: 'x',
            cwd: process.cwd(),
            spawn,
            profile: 'adhoc',
            contextWindow: 'unknown'
        })
        expect(r.groundingRetrievalCount).toBe(0)
    })

    test('groundingRetrievalCount stays 0 for the one-trivial-ls dodge', async () => {
        // The anti-gaming property: a worker that lists a directory once and then
        // fabricates the rest has retrieved nothing an APIS signature can cite.
        const spawn = fakeSpawnByPrompt(() => withToolCalls(['ls']))
        const r = await runWorker({
            prompt: 'x',
            cwd: process.cwd(),
            spawn,
            profile: 'adhoc',
            contextWindow: 'unknown'
        })
        expect(r.groundingRetrievalCount).toBe(0)
    })

    test('groundingRetrievalCount reflects the FINAL attempt, not the sum across restarts', async () => {
        // First attempt leaks a tool call (retried); the clean retry made one docs
        // call. The count must be the retry's 1, not 1+0 accumulated.
        const spawn = fakeSpawnQueue([
            agentEndResponse(LEAKED),
            withToolCalls(['pi-worker-docs'], 'clean output')
        ])
        const r = await runWorker({
            prompt: 'x',
            cwd: process.cwd(),
            spawn,
            profile: 'adhoc',
            contextWindow: 'unknown'
        })
        expect(r.text).toBe('clean output')
        expect(r.groundingRetrievalCount).toBe(1)
    })

    test('isGroundingRetrieval: content-returning tools yes, bare enumeration no', () => {
        for (const t of ['pi-worker-docs', 'read', 'grep', 'pi-worker-search', 'pi-worker-fetch']) {
            expect(isGroundingRetrieval(t)).toBe(true)
        }
        for (const t of ['ls', 'find', 'bash', 'edit', 'write']) {
            expect(isGroundingRetrieval(t)).toBe(false)
        }
    })

    test('restarts a loop-killed worker with a hint and returns the clean retry', async () => {
        // First spawn thrashes the same grep 6× → trips LoopDetector(20,5) → the
        // unified runner SIGTERMs it. The worker must re-spawn (with a loop hint)
        // rather than surface the kill as a failure, like every other phase does.
        const spawn = fakeSpawnQueue([
            loopResponse('grep', {pattern: 'glorptube'}, 6),
            agentEndResponse('clean output')
        ])
        const r = await runWorker({
            prompt: 'x',
            cwd: process.cwd(),
            spawn,
            profile: 'adhoc',
            contextWindow: 'unknown'
        })
        expect(r.text).toBe('clean output')
        expect(r.loopHit).toBeUndefined()
    })

    test('surfaces loopHit when the worker loops through every restart', async () => {
        // 3 attempts (initial + MAX_LOOP_RESTARTS) all loop → give up, but report
        // the loop so the caller emits a precise error instead of a bare exit code.
        const spawn = fakeSpawnQueue([
            loopResponse('grep', {pattern: 'glorptube'}, 6),
            loopResponse('grep', {pattern: 'glorptube'}, 6),
            loopResponse('grep', {pattern: 'glorptube'}, 6)
        ])
        const r = await runWorker({
            prompt: 'x',
            cwd: process.cwd(),
            spawn,
            profile: 'adhoc',
            contextWindow: 'unknown'
        })
        expect(r.loopHit).toBeTruthy()
        expect(r.loopHit?.call.name).toBe('grep')
        expect(r.loopHit?.count).toBeGreaterThanOrEqual(5)
    })

    /**
     * A worker can make hundreds of tool calls over exactly
     * distinct files, ~36 reads each, for 20 minutes, and LoopDetector(20,5,5)
     * returned null on every one of them — a cycle as long as the window leaves
     * every key occurring once per window (asserted in loop-detector.test.ts).
     * It died on the absolute progress ceiling having done 25s of useful work.
     *
     * The 240s worker timeout could not save it either: with a progress ceiling
     * configured that 240s is a NO-PROGRESS deadline that re-arms on every tool
     * call, and a looping worker is calling tools the whole time.
     */
    const ROTATION_20 = [
        'package.json',
        'docker-compose.dev.yml',
        'docker-dev-init.sql',
        'tsconfig.json',
        'src/server/index.test.ts',
        'test/scaffold.test.ts',
        'src/server/migrate.ts',
        'src/server/db.ts',
        '.env.example',
        'src/server/migrate.test.ts',
        'DESIGN/PROJECT.md',
        'src/server/index.ts',
        'src/server/seed.ts',
        'eslint.config.js',
        'src/server/migrations/0001_init.sql',
        'src/server/seed.test.ts',
        'AGENTS.md',
        'bunfig.toml',
        'playwright-ct.config.ts',
        'test/helpers/test-db.ts'
    ]

    /** The recorded shape: read a file, get its bytes back, move to the next. */
    const rotationResponse = (laps: number, trailingText?: string) => {
        const events: Array<Record<string, unknown>> = []
        for (let n = 0; n < laps * ROTATION_20.length; n++) {
            const path = ROTATION_20[n % ROTATION_20.length]!
            events.push({type: 'tool_execution_start', toolName: 'read', args: {path}})
            events.push({
                type: 'tool_execution_end',
                toolName: 'read',
                result: {content: [{type: 'text', text: `contents of ${path}`}]}
            })
        }
        if (trailingText !== undefined) {
            events.push({
                type: 'agent_end',
                messages: [{role: 'assistant', content: [{type: 'text', text: trailingText}]}]
            })
        }
        return {events, exitCode: 0}
    }

    test('kills a 20-file rotation the loop detector cannot see', async () => {
        const spawn = fakeSpawnQueue([rotationResponse(28), agentEndResponse('clean output')])
        const r = await runWorker({
            prompt: 'x',
            cwd: process.cwd(),
            spawn,
            profile: 'adhoc',
            contextWindow: 'unknown'
        })
        expect(r.text).toBe('clean output')
        expect(r.restarts).toHaveLength(1)
        expect(r.restarts[0]?.reason).toBe('loop')
        // Named as a stall, not as a loop shape: a stall hit has no meaningful
        // windowSize, so a `read ×N` line would misreport why the attempt died.
        expect(r.restarts[0]?.detail).toContain('no-new-ground')
    })

    test('surfaces the stall when every attempt rotates', async () => {
        const spawn = fakeSpawnByPrompt(() => rotationResponse(28))
        const r = await runWorker({
            prompt: 'x',
            cwd: process.cwd(),
            spawn,
            profile: 'adhoc',
            contextWindow: 'unknown'
        })
        expect(r.loopHit?.stall).toBe('no-new-ground')
        expect(r.loopHit?.call.name).toBe('read')
    })

    test('a single honest lap through 20 files is never killed', async () => {
        // The false positive that would make this guard unusable: a research
        // worker legitimately reading twenty files once each.
        const spawn = fakeSpawnQueue([rotationResponse(1, 'the answer')])
        const r = await runWorker({
            prompt: 'x',
            cwd: process.cwd(),
            spawn,
            profile: 'adhoc',
            contextWindow: 'unknown'
        })
        expect(r.text).toBe('the answer')
        expect(r.loopHit).toBeUndefined()
        expect(r.restarts).toHaveLength(0)
    })

    /**
     * The gate path (task/gate-child.ts) reaches the model through runWorker, so
     * it inherits this guard. That is DELIBERATE and it closes the worst hole in
     * the tree: a gate child runs with `timeoutMs: 0` and
     * `pathThreshold: Infinity`, so before this guard existed a varied-args
     * thrash there had no bound at all — not a clock, not a path rule, and the
     * stream watchdog is suspended for the duration of every tool call.
     *
     * The reason gate-child.ts disabled the OTHER guards does not apply here.
     * They mislabelled an edit pass because they judge ARGUMENTS, and re-reading
     * one file IS the job. This one judges RESULTS: an edit
     * changes the bytes, so the read that follows it is new ground and the streak
     * resets. This test is that claim, asserted.
     *
     * The reads below carry an offset so they are DISTINCT calls. That is not
     * cosmetic: a gate child re-reading one file with byte-identical args five
     * times in a 20-call window is killed by the loop detector's EXACT rule,
     * which `pathThreshold: Infinity` does not disable. Pre-existing behaviour,
     * unrelated to this guard, and isolating it here is what makes the assertion
     * below about the stall guard rather than about that.
     */
    test('an edit pass revisiting one file is never killed by the stall guard', async () => {
        const events: Array<Record<string, unknown>> = []
        for (let n = 0; n < 60; n++) {
            // read the same file, edit it, read it back — 120 calls on one path.
            events.push({
                type: 'tool_execution_start',
                toolName: 'read',
                args: {path: 'a.ts', offset: n}
            })
            events.push({
                type: 'tool_execution_end',
                toolName: 'read',
                result: {content: [{type: 'text', text: `a.ts revision ${n}`}]}
            })
            events.push({
                type: 'tool_execution_start',
                toolName: 'edit',
                args: {path: 'a.ts', n}
            })
            events.push({
                type: 'tool_execution_end',
                toolName: 'edit',
                result: {content: [{type: 'text', text: `applied edit ${n}`}]}
            })
        }
        events.push({
            type: 'agent_end',
            messages: [{role: 'assistant', content: [{type: 'text', text: 'PASS'}]}]
        })
        const spawn = fakeSpawnQueue([{events, exitCode: 0}])
        const r = await runWorker({
            prompt: 'x',
            profile: 'adhoc',
            contextWindow: 'unknown',
            override: {
                'worker-timeout': {timeoutMs: 0, progressCeilingMs: null, fanout: null},
                loop: {
                    detector: {...DEFAULT_LOOP_DETECTOR, pathThreshold: Number.POSITIVE_INFINITY},
                    progress: {...DEFAULT_LOOP_PROGRESS}
                }
            },
            cwd: process.cwd(),
            spawn
            // The gate's own options, verbatim (gate-child.ts:178-186).
        })
        expect(r.text).toBe('PASS')
        expect(r.loopHit).toBeUndefined()
        expect(r.restarts).toHaveLength(0)
    })

    test('a gate child thrashing varied greps is now bounded, where it was not', async () => {
        // No `path` key, so the loop detector's path rule cannot participate even
        // when enabled; a varying pattern defeats the exact rule; timeoutMs 0
        // means no clock. Before the stall guard this ran forever.
        const events: Array<Record<string, unknown>> = []
        for (let n = 0; n < 200; n++) {
            events.push({
                type: 'tool_execution_start',
                toolName: 'grep',
                args: {pattern: `attempt-${n}`}
            })
            events.push({
                type: 'tool_execution_end',
                toolName: 'grep',
                isError: true,
                result: {content: [{type: 'text', text: 'no matches'}]}
            })
        }
        const spawn = fakeSpawnByPrompt(() => ({events, exitCode: 0}))
        const r = await runWorker({
            prompt: 'x',
            profile: 'adhoc',
            contextWindow: 'unknown',
            override: {
                'worker-timeout': {timeoutMs: 0, progressCeilingMs: null, fanout: null},
                loop: {
                    detector: {...DEFAULT_LOOP_DETECTOR, pathThreshold: Number.POSITIVE_INFINITY},
                    progress: {...DEFAULT_LOOP_PROGRESS}
                }
            },
            cwd: process.cwd(),
            spawn
        })
        expect(r.loopHit?.stall).toBe('no-new-ground')
    })

    test('stallGuard: false restores the old unbounded behaviour', async () => {
        const spawn = fakeSpawnByPrompt(() => rotationResponse(28, 'never killed'))
        const r = await runWorker({
            prompt: 'x',
            profile: 'adhoc',
            contextWindow: 'unknown',
            override: {
                loop: {detector: {...DEFAULT_LOOP_DETECTOR}, progress: false}
            },
            cwd: process.cwd(),
            spawn
        })
        expect(r.text).toBe('never killed')
        expect(r.loopHit).toBeUndefined()
    })

    test('loop: false disables the detector — a thrashing worker runs to completion', async () => {
        // 8 identical greps would trip LoopDetector(20,5) and get SIGTERMed; with
        // the guard off the worker is left alone and returns its own result. This
        // is what the /task-auto enforcement fix pass relies on.
        const spawn = fakeSpawnByPrompt(() =>
            loopResponse('grep', {pattern: 'glorptube'}, 8, {trailingText: 'all fixed'})
        )
        const r = await runWorker({
            prompt: 'x',
            cwd: process.cwd(),
            spawn,
            profile: 'adhoc',
            contextWindow: 'unknown',
            override: {loop: {detector: false, progress: {...DEFAULT_LOOP_PROGRESS}}}
        })
        expect(r.text).toBe('all fixed')
        expect(r.loopHit).toBeUndefined()
    })

    test('timeoutMs: 0 disables the wall-clock timeout — a slow worker still completes', async () => {
        // A 50ms-delayed close with the timeout OFF must be waited out, not aborted
        // (contrast the timeoutMs:15 test below, which aborts an 80ms close).
        const spawn = fakeSpawnByPrompt(() => ({
            ...agentEndResponse('slow but done'),
            closeDelayMs: 50
        }))
        const r = await runWorker({
            prompt: 'x',
            cwd: process.cwd(),
            spawn,
            profile: 'adhoc',
            contextWindow: 'unknown',
            override: {'worker-timeout': {timeoutMs: 0, progressCeilingMs: null, fanout: null}}
        })
        expect(r.text).toBe('slow but done')
        expect(r.timedOut).toBeUndefined()
    })

    test('restarts on a per-worker wall-clock timeout and returns the retry', async () => {
        // First spawn keeps running past the timeout (delayed close, no answer);
        // the deliberate per-worker timeout must abort it and re-spawn.
        const spawn = fakeSpawnQueue([
            {events: [], closeDelayMs: 80},
            agentEndResponse('clean output')
        ])
        const r = await runWorker({
            prompt: 'x',
            cwd: process.cwd(),
            spawn,
            profile: 'adhoc',
            contextWindow: 'unknown',
            override: {'worker-timeout': {timeoutMs: 15, progressCeilingMs: null, fanout: null}}
        })
        expect(r.text).toBe('clean output')
        expect(r.timedOut).toBeUndefined()
    })

    test('restarts on a connection-class model error and returns the retry', async () => {
        // Measured live: pi already retries a connection failure 4× over ~15s, so a
        // surfaced "Connection error." means an outage that outlasted pi's own
        // budget. A phase child re-spawns there (runPhaseChild); a research
        // worker would fail the whole task instead.
        const slept: number[] = []
        const spawn = fakeSpawnQueue([
            agentErrorResponse('Connection error.'),
            agentEndResponse('clean output')
        ])
        const r = await runWorker({
            prompt: 'x',
            profile: 'adhoc',
            contextWindow: 'unknown',
            cwd: process.cwd(),
            spawn,
            sleepFor: async ms => void slept.push(ms)
        })
        expect(r.text).toBe('clean output')
        expect(r.modelError).toBeUndefined()
        // Same backoff schedule as the phase child: 500ms, then 1s.
        expect(slept).toEqual([500])
    })

    test('surfaces the connection error after the restart budget is spent', async () => {
        const slept: number[] = []
        const spawn = fakeSpawnQueue([
            agentErrorResponse('Connection error.'),
            agentErrorResponse('Connection error.'),
            agentErrorResponse('Connection error.')
        ])
        const r = await runWorker({
            prompt: 'x',
            profile: 'adhoc',
            contextWindow: 'unknown',
            cwd: process.cwd(),
            spawn,
            sleepFor: async ms => void slept.push(ms)
        })
        expect(r.modelError).toBe('Connection error.')
        expect(r.text).toBe('')
        expect(slept).toEqual([500, 1000])
    })

    test('connectionRetries: 0 turns the retry off (the A/B harness baseline arm)', async () => {
        const spawn = fakeSpawnQueue([
            agentErrorResponse('Connection error.'),
            agentEndResponse('would have been the retry')
        ])
        const r = await runWorker({
            prompt: 'x',
            profile: 'adhoc',
            contextWindow: 'unknown',
            override: {
                'connection-error': 0
            },
            cwd: process.cwd(),
            spawn,
            sleepFor: async () => {
                throw new Error('must not back off when the budget is 0')
            }
        })
        expect(r.text).toBe('')
        expect(r.modelError).toBe('Connection error.')
    })

    test('a NON-connection model error fails fast — no restart, no backoff', async () => {
        // Auth/bad-request/context-overflow are repeatable: re-issuing the same
        // request cannot fix them, so burning the budget only delays the report.
        let spawns = 0
        const spawn = ((cmd: string, args: ReadonlyArray<string>, opts: unknown) => {
            spawns++
            return (
                fakeSpawnQueue([agentErrorResponse('401 invalid api key')]) as unknown as SpawnFn
            )(cmd, args, opts as never)
        }) as unknown as SpawnFn
        const r = await runWorker({
            prompt: 'x',
            profile: 'adhoc',
            contextWindow: 'unknown',
            cwd: process.cwd(),
            spawn,
            sleepFor: async () => {
                throw new Error('must not back off on a non-connection error')
            }
        })
        expect(r.modelError).toBe('401 invalid api key')
        expect(spawns).toBe(1)
    })

    test('surfaces timedOut when the worker times out through every restart', async () => {
        const spawn = fakeSpawnQueue([
            {events: [], closeDelayMs: 60},
            {events: [], closeDelayMs: 60},
            {events: [], closeDelayMs: 60}
        ])
        const r = await runWorker({
            prompt: 'x',
            cwd: process.cwd(),
            spawn,
            profile: 'adhoc',
            contextWindow: 'unknown',
            override: {'worker-timeout': {timeoutMs: 15, progressCeilingMs: null, fanout: null}}
        })
        expect(r.timedOut).toBe(true)
    })

    test('a stall-killed worker surfaces stalled:true, once, with no silent restart', async () => {
        let spawns = 0
        const spawn = (() => {
            spawns++
            const p = makeProc()
            // Emits nothing and never closes on its own (a child wedged on a
            // dead backend) — only the stall guard's kill closes it.
            const origKill = p.kill.bind(p)
            p.kill = (sig: string) => {
                origKill(sig)
                setTimeout(() => p.emit('close', null), 5)
                return true
            }
            return p
        }) as unknown as SpawnFn
        const r = await runWorker({
            prompt: 'x',
            profile: 'adhoc',
            contextWindow: 'unknown',
            override: {
                'worker-timeout': {timeoutMs: 0, progressCeilingMs: null, fanout: null},
                stalled: {afterMs: 50, probe: () => Promise.resolve(false)}
            },
            cwd: process.cwd(),
            spawn
        })
        expect(r.stalled).toBe(true)
        expect(spawns).toBe(1)
    })

    test('input.tools overrides the default tool set', async () => {
        let receivedArgs: ReadonlyArray<string> = []
        const spawn = fakeSpawnByPrompt(args => {
            receivedArgs = args
            return agentEndResponse('ok')
        })
        await runWorker({
            prompt: 'hello',
            profile: 'adhoc',
            contextWindow: 'unknown',
            cwd: process.cwd(),
            spawn,
            tools: 'read,grep'
        })
        expect(receivedArgs[receivedArgs.indexOf('--tools') + 1]).toBe('read,grep')
    })

    // ── restart accounting ────────────────────────────────────────
    // Wall-clock timeouts discard hours of compute, and most of the
    // 23 affected workers returning exit=0. None of it was visible from the result
    // or any log — waitMs/workMs describe the FINAL attempt only.
    describe('restart accounting', () => {
        test('a clean run reports attempts=1, no restarts, and never calls onRestart', async () => {
            const seen: unknown[] = []
            const spawn = fakeSpawnByPrompt(() => agentEndResponse('ok'))
            const r = await runWorker({
                prompt: 'x',
                profile: 'adhoc',
                contextWindow: 'unknown',
                cwd: process.cwd(),
                spawn,
                onRestart: rs => void seen.push(rs)
            })
            expect(r.attempts).toBe(1)
            expect(r.restarts).toEqual([])
            expect(seen).toEqual([])
            // The clean case is the one where the old fields must still add up.
            expect(r.totalWallMs).toBeGreaterThanOrEqual(r.waitMs + r.workMs)
        })

        test('a wall-clock timeout is reported as a discarded attempt on a clean result', async () => {
            // The exact shape: attempt 1 times out, attempt 2 answers, and
            // the caller sees exit=0 with nothing to say an attempt was thrown away.
            const spawn = fakeSpawnQueue([
                {events: [], closeDelayMs: 80},
                agentEndResponse('clean output')
            ])
            const seen: WorkerRestart[] = []
            const r = await runWorker({
                prompt: 'x',
                profile: 'adhoc',
                contextWindow: 'unknown',
                override: {
                    'worker-timeout': {timeoutMs: 15, progressCeilingMs: null, fanout: null}
                },
                cwd: process.cwd(),
                spawn,
                onRestart: rs => void seen.push(rs)
            })
            expect(r.text).toBe('clean output')
            expect(r.exitCode).toBe(0)
            expect(r.attempts).toBe(2)
            expect(r.restarts.map(x => x.reason)).toEqual(['worker-timeout'])
            expect(r.restarts[0]!.attempt).toBe(1)
            expect(r.restarts[0]!.detail).toBe('cap 15ms')
            // The discarded attempt ran the full cap, so total must exceed the
            // final attempt's own split by at least that much.
            expect(r.restarts[0]!.wallMs).toBeGreaterThanOrEqual(15)
            expect(r.totalWallMs).toBeGreaterThanOrEqual(r.waitMs + r.workMs + 15)
            // onRestart fires live, with the same records the result carries.
            expect(seen).toEqual([...r.restarts])
        })

        test('every restart is recorded when the budget is spent on timeouts', async () => {
            const spawn = fakeSpawnQueue([
                {events: [], closeDelayMs: 60},
                {events: [], closeDelayMs: 60},
                {events: [], closeDelayMs: 60}
            ])
            const r = await runWorker({
                prompt: 'x',
                cwd: process.cwd(),
                spawn,
                profile: 'adhoc',
                contextWindow: 'unknown',
                override: {'worker-timeout': {timeoutMs: 15, progressCeilingMs: null, fanout: null}}
            })
            expect(r.timedOut).toBe(true)
            expect(r.attempts).toBe(3) // MAX_LOOP_RESTARTS = 2
            expect(r.restarts.map(x => x.attempt)).toEqual([1, 2])
            expect(r.restarts.every(x => x.reason === 'worker-timeout')).toBe(true)
        })

        test('a loop restart names the offending call', async () => {
            const spawn = fakeSpawnQueue([
                loopResponse('grep', {pattern: 'glorptube'}, 8),
                agentEndResponse('recovered')
            ])
            const r = await runWorker({
                prompt: 'x',
                cwd: process.cwd(),
                spawn,
                profile: 'adhoc',
                contextWindow: 'unknown'
            })
            expect(r.text).toBe('recovered')
            expect(r.attempts).toBe(2)
            expect(r.restarts[0]!.reason).toBe('loop')
            expect(r.restarts[0]!.detail).toContain('grep')
        })

        test('a connection retry is recorded, and its backoff lands in totalWallMs only', async () => {
            const slept: number[] = []
            const spawn = fakeSpawnQueue([
                agentErrorResponse('Connection error.'),
                agentEndResponse('clean output')
            ])
            const r = await runWorker({
                prompt: 'x',
                profile: 'adhoc',
                contextWindow: 'unknown',
                cwd: process.cwd(),
                spawn,
                sleepFor: async ms => void slept.push(ms)
            })
            expect(r.attempts).toBe(2)
            expect(r.restarts.map(x => x.reason)).toEqual(['connection-error'])
            expect(r.restarts[0]!.detail).toBe('Connection error.')
            expect(slept).toEqual([500])
        })

        test('a leaked-tool-call re-prompt is a restart too', async () => {
            const spawn = fakeSpawnQueue([
                agentEndResponse(LEAKED),
                agentEndResponse('clean output')
            ])
            const r = await runWorker({
                prompt: 'x',
                cwd: process.cwd(),
                spawn,
                profile: 'adhoc',
                contextWindow: 'unknown'
            })
            expect(r.text).toBe('clean output')
            expect(r.attempts).toBe(2)
            expect(r.restarts.map(x => x.reason)).toEqual(['leaked-tool-call'])
        })
    })

    /**
     * A restart is supposed to buy another chance at an answer. Before this it
     * also THREW AWAY everything the killed attempt had produced, which is why a
     * high-fan-out worker re-read the same files against the same clock and died
     * in the same place every time.
     */
    describe('carry-forward and salvage', () => {
        /** An attempt that produces real output and is then killed by the clock. */
        const partialThenTimeout = (text: string): SpawnResponseJsonEvents => ({
            ...agentEndResponse(text),
            closeDelayMs: 200
        })

        test('a timed-out attempt hands its work to the next one', async () => {
            const prompts: string[] = []
            let call = 0
            const spawn = fakeSpawnByPrompt(args => {
                prompts.push(args.join(' '))
                return call++ === 0 ?
                        partialThenTimeout(
                            'openDb  (path: string) => Database — from src/server/db.ts\n'
                                + 'migrate  (db: Database) => void — applies pending migrations'
                        )
                    :   agentEndResponse('final answer')
            })
            const r = await runWorker({
                prompt: 'ORIGINAL TASK',
                profile: 'adhoc',
                contextWindow: 'unknown',
                override: {
                    'worker-timeout': {timeoutMs: 15, progressCeilingMs: null, fanout: null},
                    carryForward: true
                },
                cwd: process.cwd(),
                spawn
            })
            expect(r.attempts).toBe(2)
            expect(r.restarts.map(x => x.reason)).toEqual(['worker-timeout'])
            // The whole point: attempt 2 can see what attempt 1 found.
            expect(prompts[0]).not.toContain('WORK ALREADY DONE')
            expect(prompts[1]).toContain('WORK ALREADY DONE')
            expect(prompts[1]).toContain('(path: string) => Database')
            // ...without losing the task itself, and framed as unverified so a
            // half-written entry cannot be re-emitted as established fact.
            expect(prompts[1]).toContain('ORIGINAL TASK')
            expect(prompts[1]).toContain('UNVERIFIED')
            // A clean final attempt still answers for itself.
            expect(r.text).toBe('final answer')
            expect(r.salvagedFromDiscardedAttempt).toBe(false)
        })

        test('thrash is NOT carried forward', async () => {
            // A loop kill is by definition the same call repeated and a leaked
            // tool call is malformed protocol text. Replaying either would feed
            // the failure back into the attempt meant to escape it.
            const prompts: string[] = []
            let call = 0
            const spawn = fakeSpawnByPrompt(args => {
                prompts.push(args.join(' '))
                return call++ === 0 ?
                        loopResponse('grep', {pattern: 'glorptube'}, 8)
                    :   agentEndResponse('recovered')
            })
            const r = await runWorker({
                prompt: 'x',
                profile: 'adhoc',
                contextWindow: 'unknown',
                override: {
                    carryForward: true
                },
                cwd: process.cwd(),
                spawn
            })
            expect(r.restarts.map(x => x.reason)).toEqual(['loop'])
            expect(prompts[1]).not.toContain('WORK ALREADY DONE')
        })

        test('a discarded attempt is returned when the final attempt has less', async () => {
            // The shape at its worst: the budget is spent, and the attempt
            // that happens to be last is the one that got least far. Returning it
            // unconditionally reports the worst of three attempts as the answer.
            // A realistic partial section: entry-shaped lines, which is what
            // hasAnswerContent requires before salvage will keep anything.
            const long = [
                'openDb  (path: string) => Database — open the sqlite handle',
                'migrate  (db: Database) => void — apply pending migrations',
                'listingsTable  table name constant used by the query helpers'
            ].join('\n')
            const spawn = fakeSpawnQueue([
                partialThenTimeout(long),
                partialThenTimeout('short'),
                partialThenTimeout('tiny')
            ])
            const r = await runWorker({
                prompt: 'x',
                profile: 'adhoc',
                contextWindow: 'unknown',
                override: {
                    'worker-timeout': {timeoutMs: 15, progressCeilingMs: null, fanout: null},
                    carryForward: true
                },
                cwd: process.cwd(),
                spawn
            })
            expect(r.attempts).toBe(3)
            expect(r.timedOut).toBe(true)
            expect(r.text).toBe(long)
            expect(r.salvagedFromDiscardedAttempt).toBe(true)
        })

        test('a clean short final answer is NOT overridden by a longer fragment', async () => {
            // Salvage is gated on the final attempt FAILING, not on it being
            // shorter. Gating on length would let a long half-finished fragment
            // beat a concise correct answer.
            const spawn = fakeSpawnQueue([
                partialThenTimeout('FINDING: ' + 'x'.repeat(400)),
                agentEndResponse('no exported API')
            ])
            const r = await runWorker({
                prompt: 'x',
                profile: 'adhoc',
                contextWindow: 'unknown',
                override: {
                    'worker-timeout': {timeoutMs: 15, progressCeilingMs: null, fanout: null},
                    carryForward: true
                },
                cwd: process.cwd(),
                spawn
            })
            expect(r.attempts).toBe(2)
            expect(r.text).toBe('no exported API')
            expect(r.salvagedFromDiscardedAttempt).toBe(false)
        })

        test('OFF by default: the shipped path still discards and still returns the last attempt', async () => {
            // The A/B's baseline arm depends on this being byte-for-byte the old
            // behaviour. Without this test "default off" is an unverified claim.
            const prompts: string[] = []
            // A realistic partial section: entry-shaped lines, which is what
            // hasAnswerContent requires before salvage will keep anything.
            const long = [
                'openDb  (path: string) => Database — open the sqlite handle',
                'migrate  (db: Database) => void — apply pending migrations',
                'listingsTable  table name constant used by the query helpers'
            ].join('\n')
            let call = 0
            const spawn = fakeSpawnByPrompt(args => {
                prompts.push(args.join(' '))
                return call++ === 0 ? partialThenTimeout(long) : partialThenTimeout('tiny')
            })
            const r = await runWorker({
                prompt: 'x',
                cwd: process.cwd(),
                spawn,
                profile: 'adhoc',
                contextWindow: 'unknown',
                override: {'worker-timeout': {timeoutMs: 15, progressCeilingMs: null, fanout: null}}
            })
            expect(r.restarts.map(x => x.reason)).toEqual(['worker-timeout', 'worker-timeout'])
            expect(prompts[1]).not.toContain('WORK ALREADY DONE')
            expect(r.text).toBe('tiny')
            expect(r.salvagedFromDiscardedAttempt).toBe(false)
        })

        test('the injection is observable, and does not fire when nothing is carried', async () => {
            // A restart says an attempt was discarded; it does NOT say the next
            // one received anything. Those diverge whenever the partial had no
            // answer content, so they need separate signals.
            const seen: {attempt: number; chars: number}[] = []
            const withContent = fakeSpawnQueue([
                partialThenTimeout('openDb  (path: string) => Database\nmigrate  (db) => void'),
                agentEndResponse('final')
            ])
            await runWorker({
                prompt: 'x',
                profile: 'adhoc',
                contextWindow: 'unknown',
                override: {
                    'worker-timeout': {timeoutMs: 15, progressCeilingMs: null, fanout: null},
                    carryForward: true
                },
                cwd: process.cwd(),
                spawn: withContent,
                onCarryForward: i => void seen.push({attempt: i.attempt, chars: i.chars})
            })
            expect(seen.length).toBe(1)
            expect(seen[0]!.attempt).toBe(2)
            expect(seen[0]!.chars).toBeGreaterThan(0)

            const preambleOnly: typeof seen = []
            const noContent = fakeSpawnQueue([
                partialThenTimeout('Now let me look at the remaining files:'),
                agentEndResponse('final')
            ])
            const r = await runWorker({
                prompt: 'x',
                profile: 'adhoc',
                contextWindow: 'unknown',
                override: {
                    'worker-timeout': {timeoutMs: 15, progressCeilingMs: null, fanout: null},
                    carryForward: true
                },
                cwd: process.cwd(),
                spawn: noContent,
                onCarryForward: i => void preambleOnly.push({attempt: i.attempt, chars: i.chars})
            })
            expect(r.restarts.length).toBe(1) // it DID restart …
            expect(preambleOnly).toEqual([]) // … and carried nothing
        })

        test('salvage refuses a partial that is only preamble (live carry-arm regression)', async () => {
            // The exact text salvage shipped as an APIS section on one task and
            // one task of the live carry arm: all three attempts timed out, the
            // longest partial was one filler sentence, and both fixtures scored 2
            // entries and DEGRADED against 22 and 5 in baseline.
            const preamble =
                'Now let me get more details on the specific APIs and components I need:'
            expect(hasAnswerContent(preamble)).toBe(false)
            expect(
                hasAnswerContent(
                    'zValidator  Hono middleware for Zod validation\nz.object  construct object schema'
                )
            ).toBe(true)

            const spawn = fakeSpawnQueue([
                partialThenTimeout(preamble),
                partialThenTimeout('x'),
                partialThenTimeout('y')
            ])
            const r = await runWorker({
                prompt: 'x',
                profile: 'adhoc',
                contextWindow: 'unknown',
                override: {
                    'worker-timeout': {timeoutMs: 15, progressCeilingMs: null, fanout: null},
                    carryForward: true
                },
                cwd: process.cwd(),
                spawn
            })
            expect(r.attempts).toBe(3)
            // Nothing had answer content, so nothing is salvaged and the final
            // attempt's own text stands — the caller sees a real degrade instead
            // of chatter dressed up as a section.
            expect(r.salvagedFromDiscardedAttempt).toBe(false)
            expect(r.text).toBe('y')
        })

        test('a clean run carries nothing and salvages nothing', async () => {
            const prompts: string[] = []
            const spawn = fakeSpawnByPrompt(args => {
                prompts.push(args.join(' '))
                return agentEndResponse('ok')
            })
            const r = await runWorker({
                prompt: 'x',
                profile: 'adhoc',
                contextWindow: 'unknown',
                override: {
                    carryForward: true
                },
                cwd: process.cwd(),
                spawn
            })
            expect(r.text).toBe('ok')
            expect(r.salvagedFromDiscardedAttempt).toBe(false)
            expect(prompts[0]).not.toContain('WORK ALREADY DONE')
        })

        // As an inline eight-term disjunction, `finalAttemptFailed` is a
        // fifth statement of the taxonomy `worker-failure.ts` owns — and it was
        // missing two of FAILURE_RULES' rows. A crashed final attempt with a
        // non-empty tail counted as NOT failed, so salvage was skipped and a good
        // discarded partial was overwritten by the crash's leftovers.
        test('a CRASHED final attempt still admits salvage (the missing `exit` rung)', async () => {
            const long = [
                'openDb  (path: string) => Database — open the sqlite handle',
                'migrate  (db: Database) => void — apply pending migrations',
                'listingsTable  table name constant used by the query helpers'
            ].join('\n')
            const spawn = fakeSpawnQueue([
                partialThenTimeout(long),
                // Non-zero exit, nothing killed it, and the text is NOT empty —
                // the one combination the old disjunction had no term for.
                agentEndResponse('error: could not open module graph', 1)
            ])
            const r = await runWorker({
                prompt: 'x',
                profile: 'adhoc',
                contextWindow: 'unknown',
                override: {
                    'worker-timeout': {timeoutMs: 15, progressCeilingMs: null, fanout: null},
                    carryForward: true
                },
                cwd: process.cwd(),
                spawn
            })
            expect(r.text).toBe(long)
            expect(r.salvagedFromDiscardedAttempt).toBe(true)
        })

        test('a clean non-zero-exit run with no salvage in hand is unchanged', async () => {
            // The rung must not invent an answer: with nothing discarded worth
            // keeping, the crash's own text still comes back.
            const spawn = fakeSpawnQueue([
                agentEndResponse('error: could not open module graph', 1)
            ])
            const r = await runWorker({
                prompt: 'x',
                profile: 'adhoc',
                contextWindow: 'unknown',
                override: {
                    'worker-timeout': {timeoutMs: 15, progressCeilingMs: null, fanout: null},
                    carryForward: true
                },
                cwd: process.cwd(),
                spawn
            })
            expect(r.text).toBe('error: could not open module graph')
            expect(r.salvagedFromDiscardedAttempt).toBe(false)
        })
    })

    /**
     * "Took too long" and "stopped working" are different faults. A fixed cap
     * cannot tell them apart, so it kills slow-but-working workers — and how slow
     * a worker is depends on the user's machine, which is why a fixed cap makes
     * answer quality hardware-dependent.
     */
    describe('progress-based deadline', () => {
        const toolCall = (n: number): Record<string, unknown> => ({
            type: 'tool_execution_start',
            toolName: 'read',
            args: {path: `src/f${n}.ts`}
        })

        test('a worker that keeps working is not killed for being slow', async () => {
            // Twelve reads paced past the 40ms no-progress window: total elapsed
            // runs far beyond it, but the worker is never idle for a whole window.
            const events = [
                ...Array.from({length: 12}, (_, i) => toolCall(i)),
                {
                    type: 'agent_end',
                    messages: [{role: 'assistant', content: [{type: 'text', text: 'answered'}]}]
                }
            ]
            const spawn = pacedSpawn(events, 30)
            const r = await runWorker({
                prompt: 'x',
                profile: 'adhoc',
                contextWindow: 'unknown',
                override: {
                    'worker-timeout': {timeoutMs: 150, progressCeilingMs: 10_000, fanout: null},
                    stalled: false,
                    loop: {detector: false, progress: {...DEFAULT_LOOP_PROGRESS}}
                },
                cwd: process.cwd(),
                spawn
            })
            expect(r.text).toBe('answered')
            expect(r.timedOut).toBeUndefined()
            expect(r.attempts).toBe(1)
            // Proof the run really did outlive the no-progress window.
            expect(r.totalWallMs).toBeGreaterThan(150)
        })

        test('the same worker IS killed by the same window when it goes quiet', async () => {
            // Identical config, identical first events — only the silence differs.
            // Without this the change would just be "the timeout is longer now".
            const spawn = pacedSpawn([toolCall(0), toolCall(1)], 30, 900)
            const r = await runWorker({
                prompt: 'x',
                profile: 'adhoc',
                contextWindow: 'unknown',
                override: {
                    'worker-timeout': {timeoutMs: 150, progressCeilingMs: 10_000, fanout: null},
                    stalled: false,
                    loop: {detector: false, progress: {...DEFAULT_LOOP_PROGRESS}}
                },
                cwd: process.cwd(),
                spawn
            })
            expect(r.timedOut).toBe(true)
        })

        test('the absolute ceiling still bounds a worker that never stops moving', async () => {
            // Progress must not be a licence to run forever: a worker emitting a
            // call every 5ms would otherwise re-arm the deadline indefinitely.
            const spawn = pacedSpawn(
                Array.from({length: 4_000}, (_, i) => toolCall(i)),
                5
            )
            const r = await runWorker({
                prompt: 'x',
                profile: 'adhoc',
                contextWindow: 'unknown',
                override: {
                    'worker-timeout': {timeoutMs: 150, progressCeilingMs: 400, fanout: null},
                    stalled: false,
                    loop: {detector: false, progress: {...DEFAULT_LOOP_PROGRESS}}
                },
                cwd: process.cwd(),
                spawn
            })
            expect(r.timedOut).toBe(true)
            expect(r.totalWallMs).toBeLessThan(2_000)
        })

        test('without the ceiling the fixed cap is unchanged', async () => {
            // The opt-in must be exactly that: callers that do not set it keep
            // the old behaviour, progress or no progress.
            const spawn = pacedSpawn(
                Array.from({length: 100}, (_, i) => toolCall(i)),
                30
            )
            const r = await runWorker({
                prompt: 'x',
                profile: 'adhoc',
                contextWindow: 'unknown',
                override: {
                    'worker-timeout': {timeoutMs: 150, progressCeilingMs: null, fanout: null},
                    stalled: false,
                    loop: {detector: false, progress: {...DEFAULT_LOOP_PROGRESS}}
                },
                cwd: process.cwd(),
                spawn
            })
            expect(r.timedOut).toBe(true)
        })

        // inv-no-unbounded-worker. The progress deadline SHIPPED ON,
        // so "a worker that is progressing may run to 20 minutes" is now the
        // default path, and the question stops being hypothetical: what bounds a
        // worker whose model endpoint is simply gone?
        //
        // Two independent bounds, and the point of the test is that neither one
        // needs the ceiling. A hung child emits nothing, so it never calls
        // progress() and the deadline never re-arms — it dies at `timeoutMs`
        // exactly as it did before the lever. And the stall probe kills it sooner
        // still. A ceiling 20 minutes out is reached by neither.
        test('a hung endpoint is still killed fast with the ceiling ON', async () => {
            const spawn = (() => {
                const p = makeProc()
                // Emits nothing and never closes on its own — a child wedged on a
                // dead backend. Only a kill from the guard closes it.
                const origKill = p.kill.bind(p)
                p.kill = (sig: string) => {
                    origKill(sig)
                    setTimeout(() => p.emit('close', null), 5)
                    return true
                }
                return p
            }) as unknown as SpawnFn
            const started = Date.now()
            const r = await runWorker({
                prompt: 'x',
                profile: 'adhoc',
                contextWindow: 'unknown',
                override: {
                    'worker-timeout': {timeoutMs: 60, progressCeilingMs: 300_000, fanout: null},
                    stalled: {afterMs: 40, probe: () => Promise.resolve(false)},
                    loop: {detector: false, progress: {...DEFAULT_LOOP_PROGRESS}}
                },
                cwd: process.cwd(),
                spawn
                // The real ratio, scaled: the ceiling is ~5000x the no-progress
                // window here, as 1_200_000 is ~5x the shipped 240_000.
            })
            expect(r.stalled).toBe(true)
            expect(Date.now() - started).toBeLessThan(5_000)
        })

        test('…and without the stall probe the no-progress deadline still bounds it', async () => {
            // The stall probe off, so the ONLY thing left is the progress-based
            // deadline itself. A worker that never progresses gets `timeoutMs`,
            // not the ceiling — which is what makes the ceiling a backstop rather
            // than the bound.
            const spawn = fakeSpawnQueue([
                {events: [], closeDelayMs: 400},
                {events: [], closeDelayMs: 400},
                {events: [], closeDelayMs: 400}
            ])
            const started = Date.now()
            const r = await runWorker({
                prompt: 'x',
                profile: 'adhoc',
                contextWindow: 'unknown',
                override: {
                    'worker-timeout': {timeoutMs: 30, progressCeilingMs: 300_000, fanout: null},
                    stalled: false,
                    loop: {detector: false, progress: {...DEFAULT_LOOP_PROGRESS}}
                },
                cwd: process.cwd(),
                spawn
            })
            expect(r.timedOut).toBe(true)
            expect(Date.now() - started).toBeLessThan(5_000)
        })
    })

    describe('nexttask 5B levers', () => {
        // ── SCALE arm of  (UNWIRED; see task/research-fanout-budget.ts) ──
        test('fanoutTimeout extends the deadline on a project-source docs call', async () => {
            const docsCall = {
                type: 'tool_execution_start',
                toolName: 'pi-worker-docs',
                args: {module: '.', query: 'src/server/db.ts exports'}
            }
            const late = {
                events: [
                    docsCall,
                    {
                        type: 'agent_end',
                        messages: [{role: 'assistant', content: [{type: 'text', text: 'answered'}]}]
                    }
                ],
                closeDelayMs: 90
            }
            // Same child, same 40ms cap, twice: the only difference is the policy.
            const withoutPolicy = await runWorker({
                prompt: 'x',
                profile: 'adhoc',
                contextWindow: 'unknown',
                override: {
                    'worker-timeout': {timeoutMs: 40, progressCeilingMs: null, fanout: null}
                },
                cwd: process.cwd(),
                spawn: fakeSpawnQueue([late, agentEndResponse('second attempt')])
            })
            expect(withoutPolicy.restarts.map(r => r.reason)).toEqual(['worker-timeout'])

            const withPolicy = await runWorker({
                prompt: 'x',
                profile: 'adhoc',
                contextWindow: 'unknown',
                override: {
                    'worker-timeout': {
                        timeoutMs: 40,
                        progressCeilingMs: null,
                        fanout: {perLookupMs: 400, ceilingMs: 10_000}
                    }
                },
                cwd: process.cwd(),
                spawn: fakeSpawnQueue([late, agentEndResponse('second attempt')])
            })
            expect(withPolicy.text).toBe('answered')
            expect(withPolicy.attempts).toBe(1)
            expect(withPolicy.timedOut).toBeUndefined()
        })

        test('fanoutTimeout never pushes past its ceiling, and ignores package lookups', async () => {
            // A ceiling BELOW the child's close time: the extension may not rescue
            // it, or the bound is not a bound. The package-module call is not a
            // project-source lookup and must buy nothing either.
            const spawn = fakeSpawnQueue([
                {
                    events: [
                        {
                            type: 'tool_execution_start',
                            toolName: 'pi-worker-docs',
                            args: {module: 'hono', query: 'hc client'}
                        }
                    ],
                    closeDelayMs: 200
                },
                agentEndResponse('second attempt')
            ])
            const r = await runWorker({
                prompt: 'x',
                profile: 'adhoc',
                contextWindow: 'unknown',
                override: {
                    'worker-timeout': {
                        timeoutMs: 30,
                        progressCeilingMs: null,
                        fanout: {perLookupMs: 400, ceilingMs: 50}
                    }
                },
                cwd: process.cwd(),
                spawn
            })
            expect(r.restarts.map(x => x.reason)).toEqual(['worker-timeout'])
            // The restart names the EFFECTIVE cap, which is what actually killed it.
            expect(r.restarts[0]!.detail).toBe('cap 30ms')
        })

        test('attempts always equals restarts.length + 1', async () => {
            // The invariant every consumer of these fields relies on, checked over
            // mixed causes rather than one branch at a time.
            const spawn = fakeSpawnQueue([
                loopResponse('grep', {pattern: 'glorptube'}, 8),
                agentEndResponse(LEAKED),
                agentEndResponse('done')
            ])
            const r = await runWorker({
                prompt: 'x',
                cwd: process.cwd(),
                spawn,
                profile: 'adhoc',
                contextWindow: 'unknown'
            })
            expect(r.attempts).toBe(r.restarts.length + 1)
            expect(r.restarts.map(x => x.reason)).toEqual(['loop', 'leaked-tool-call'])
        })
    })
})
