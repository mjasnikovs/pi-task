import {describe, expect, test} from 'bun:test'
import {runWorker} from './pi-worker-core.js'
import type {SpawnFn} from '../shared/child-process.js'
import {
    agentEndResponse,
    fakeSpawnByPrompt,
    fakeSpawnQueue,
    loopResponse,
    makeProc
} from '../test-utils/fake-spawn.js'

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
        const r = await runWorker({prompt: 'hello', cwd: process.cwd(), spawn})
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
        const r = await runWorker({prompt: 'x', cwd: process.cwd(), spawn})
        expect(r.text).toBe('spaced')
    })

    test('returns non-negative waitMs and workMs that sum to total elapsed', async () => {
        const spawn = fakeSpawnByPrompt(() => agentEndResponse('ok'))
        const r = await runWorker({prompt: 'x', cwd: process.cwd(), spawn})
        expect(r.waitMs).toBeGreaterThanOrEqual(0)
        expect(r.workMs).toBeGreaterThanOrEqual(0)
    })

    test('workMs is zero when the child never produces stdout', async () => {
        // A child that exits without emitting stdout — onFirstByte never fires,
        // so all elapsed time is bucketed as wait, not work. This is the shape
        // we want when surfacing queue-vs-generation splits later.
        const spawn = fakeSpawnByPrompt(() => ({stdout: '', stderr: 'silent', exitCode: 1}))
        const r = await runWorker({prompt: 'x', cwd: process.cwd(), spawn})
        expect(r.workMs).toBe(0)
        expect(r.waitMs).toBeGreaterThanOrEqual(0)
    })

    test('re-prompts on a leaked tool call and returns the clean retry', async () => {
        const spawn = fakeSpawnQueue([agentEndResponse(LEAKED), agentEndResponse('clean output')])
        const r = await runWorker({prompt: 'x', cwd: process.cwd(), spawn})
        expect(r.text).toBe('clean output')
        expect(r.leakedToolCall).toBeUndefined()
    })

    test('flags the result when every attempt leaks a tool call', async () => {
        const spawn = fakeSpawnQueue([
            agentEndResponse(LEAKED),
            agentEndResponse(LEAKED),
            agentEndResponse(LEAKED)
        ])
        const r = await runWorker({prompt: 'x', cwd: process.cwd(), spawn})
        expect(r.leakedToolCall).toBeTruthy()
    })

    test('restarts a loop-killed worker with a hint and returns the clean retry', async () => {
        // First spawn thrashes the same grep 6× → trips LoopDetector(20,5) → the
        // unified runner SIGTERMs it. The worker must re-spawn (with a loop hint)
        // rather than surface the kill as a failure, like every other phase does.
        const spawn = fakeSpawnQueue([
            loopResponse('grep', {pattern: 'glorptube'}, 6),
            agentEndResponse('clean output')
        ])
        const r = await runWorker({prompt: 'x', cwd: process.cwd(), spawn})
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
        const r = await runWorker({prompt: 'x', cwd: process.cwd(), spawn})
        expect(r.loopHit).toBeTruthy()
        expect(r.loopHit?.call.name).toBe('grep')
        expect(r.loopHit?.count).toBeGreaterThanOrEqual(5)
    })

    test('loop: false disables the detector — a thrashing worker runs to completion', async () => {
        // 8 identical greps would trip LoopDetector(20,5) and get SIGTERMed; with
        // the guard off the worker is left alone and returns its own result. This
        // is what the /task-auto enforcement fix pass relies on.
        const spawn = fakeSpawnByPrompt(() =>
            loopResponse('grep', {pattern: 'glorptube'}, 8, {trailingText: 'all fixed'})
        )
        const r = await runWorker({prompt: 'x', cwd: process.cwd(), spawn, loop: false})
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
        const r = await runWorker({prompt: 'x', cwd: process.cwd(), spawn, timeoutMs: 0})
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
        const r = await runWorker({prompt: 'x', cwd: process.cwd(), spawn, timeoutMs: 15})
        expect(r.text).toBe('clean output')
        expect(r.timedOut).toBeUndefined()
    })

    test('surfaces timedOut when the worker times out through every restart', async () => {
        const spawn = fakeSpawnQueue([
            {events: [], closeDelayMs: 60},
            {events: [], closeDelayMs: 60},
            {events: [], closeDelayMs: 60}
        ])
        const r = await runWorker({prompt: 'x', cwd: process.cwd(), spawn, timeoutMs: 15})
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
            cwd: process.cwd(),
            spawn,
            timeoutMs: 0,
            stall: {afterMs: 50, probe: () => Promise.resolve(false)}
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
            cwd: process.cwd(),
            spawn,
            tools: 'read,grep'
        })
        expect(receivedArgs[receivedArgs.indexOf('--tools') + 1]).toBe('read,grep')
    })
})
