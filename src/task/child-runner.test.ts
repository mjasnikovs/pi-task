import {describe, expect, test} from 'bun:test'
import {
    runPhaseChild,
    prependHint,
    runPhaseWithLoopGuard,
    runWithEmphasisRetry,
    LoopExhaustedError,
    childArgs
} from './child-runner.js'
import {fakeSpawnSimple, agentEndResponse, fakeSpawnQueue} from '../test-utils/fake-spawn.js'
import type {ProcLike, SpawnFn} from '../shared/child-process.js'
import {withTmpTaskDir} from '../test-utils/tmp-task-dir.js'
import {writeTaskFile} from './task-io.js'
import {EventEmitter} from 'node:events'

function depsWith(spawn: SpawnFn) {
    return {
        cwd: '/tmp',
        taskId: 'TASK_TEST',
        signal: new AbortController().signal,
        spawn
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
        const args = childArgs('read', 'hello')
        const i = args.indexOf('--mode')
        expect(i).toBeGreaterThanOrEqual(0)
        expect(args[i + 1]).toBe('json')
    })

    test('includes --print, --tools <tools>, and the prompt as the last arg', () => {
        const args = childArgs('read,bash', 'do the thing')
        expect(args).toContain('--print')
        const t = args.indexOf('--tools')
        expect(t).toBeGreaterThanOrEqual(0)
        expect(args[t + 1]).toBe('read,bash')
        expect(args[args.length - 1]).toBe('do the thing')
    })

    test('an empty tools string emits --no-tools instead of --tools', () => {
        const args = childArgs('', 'judge this text')
        expect(args).toContain('--no-tools')
        expect(args).not.toContain('--tools')
        // Still json mode, still prompt last.
        const i = args.indexOf('--mode')
        expect(args[i + 1]).toBe('json')
        expect(args[args.length - 1]).toBe('judge this text')
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
})

describe('prependHint', () => {
    test('returns prompt unchanged when hint is null', () => {
        expect(prependHint(null, 'do thing')).toBe('do thing')
    })

    test('prepends hint with a blank line separator', () => {
        expect(prependHint('NOTE', 'do thing')).toBe('NOTE\n\ndo thing')
    })
})

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
