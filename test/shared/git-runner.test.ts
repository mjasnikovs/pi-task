/**
 * git-runner tests — driven entirely through the GitRunner interface with a fake
 * `spawnFn`, so they pin the CONTRACT (never throws, exit code carries failure,
 * env merges over process.env, abort is honoured) rather than git's behaviour.
 * The real-git plumbing this runner serves is exercised by git-state-guard.test.ts
 * against throwaway repos; duplicating that here would test git, not the seam.
 */
import {describe, expect, test} from 'bun:test'
import {EventEmitter} from 'node:events'
import type {ProcLike, SpawnFn} from '../../src/shared/child-process.js'
import {makeGit} from '../../src/shared/git-runner.js'
import {fakeSpawnQueue, makeProc} from '../test-utils/fake-spawn.js'

interface SpawnCall {
    command: string
    args: ReadonlyArray<string>
    cwd: string
    env?: NodeJS.ProcessEnv
}

/** A fake spawn that RECORDS how it was invoked, then replies with `stdout`/`exitCode`. */
function recordingSpawn(
    calls: SpawnCall[],
    reply: {stdout?: string; exitCode?: number} = {}
): SpawnFn {
    return ((
        command: string,
        args: ReadonlyArray<string>,
        options: {cwd: string; env?: NodeJS.ProcessEnv}
    ) => {
        calls.push({command, args, cwd: options.cwd, ...(options.env ? {env: options.env} : {})})
        const p = makeProc()
        queueMicrotask(() => {
            if (reply.stdout) (p.stdout as EventEmitter).emit('data', Buffer.from(reply.stdout))
            p.emit('close', reply.exitCode ?? 0)
        })
        return p as unknown as ProcLike
    }) as unknown as SpawnFn
}

describe('makeGit', () => {
    test('invokes `git` with the given args in the given cwd', async () => {
        const calls: SpawnCall[] = []
        const git = makeGit('/work/repo', undefined, recordingSpawn(calls, {stdout: 'main\n'}))
        const r = await git(['rev-parse', '--abbrev-ref', 'HEAD'])

        expect(r).toEqual({stdout: 'main\n', exitCode: 0})
        expect(calls).toHaveLength(1)
        expect(calls[0].command).toBe('git')
        expect([...calls[0].args]).toEqual(['rev-parse', '--abbrev-ref', 'HEAD'])
        expect(calls[0].cwd).toBe('/work/repo')
    })

    test('a failing subcommand REPORTS its exit code rather than throwing', async () => {
        const git = makeGit('/work/repo', undefined, fakeSpawnQueue([{stdout: '', exitCode: 128}]))
        // The whole point of the contract: no try/catch at the call site.
        const r = await git(['rev-parse', '-q', '--verify', 'refs/stash'])
        expect(r.exitCode).toBe(128)
        expect(r.stdout).toBe('')
    })

    test('stderr is not part of the result — only stdout and the exit code', async () => {
        const git = makeGit(
            '/work/repo',
            undefined,
            fakeSpawnQueue([{stdout: 'out', exitCode: 1, stderr: 'fatal: not a git repository'}])
        )
        const r = await git(['status'])
        expect(Object.keys(r).sort()).toEqual(['exitCode', 'stdout'])
        expect(r).toEqual({stdout: 'out', exitCode: 1})
    })

    test('no env argument ⇒ the child inherits this process env (no override passed)', async () => {
        const calls: SpawnCall[] = []
        const git = makeGit('/work/repo', undefined, recordingSpawn(calls))
        await git(['status'])
        expect(calls[0].env).toBeUndefined()
    })

    test('env entries MERGE over process.env rather than replacing it', async () => {
        // A sentinel we own, rather than PATH. The key an inherited variable ends up
        // under after a spread is a property of the platform's environment object,
        // not of this merge — asserting on PATH would test that instead.
        const sentinel = 'PI_TASK_GIT_RUNNER_MERGE_PROBE'
        process.env[sentinel] = 'inherited'
        try {
            const calls: SpawnCall[] = []
            const git = makeGit('/work/repo', undefined, recordingSpawn(calls))
            await git(['write-tree'], {GIT_INDEX_FILE: '/tmp/throwaway-index'})

            const env = calls[0].env
            expect(env).toBeDefined()
            expect(env!.GIT_INDEX_FILE).toBe('/tmp/throwaway-index')
            // The inherited entry survives the merge — substituting the env
            // wholesale would strip PATH and git would not resolve at all.
            expect(env![sentinel]).toBe('inherited')
        } finally {
            delete process.env[sentinel]
        }
    })

    test('each call is independent — one runner serves many invocations', async () => {
        const calls: SpawnCall[] = []
        const git = makeGit('/work/repo', undefined, recordingSpawn(calls, {stdout: 'x'}))
        await git(['a'])
        await git(['b'], {GIT_INDEX_FILE: '/tmp/i'})
        await git(['c'])

        expect(calls.map(c => c.args[0])).toEqual(['a', 'b', 'c'])
        // The env override on the middle call does not leak onto its neighbours.
        expect(calls[0].env).toBeUndefined()
        expect(calls[1].env).toBeDefined()
        expect(calls[2].env).toBeUndefined()
    })

    test('an ALREADY-aborted signal kills the child instead of hanging', async () => {
        const ac = new AbortController()
        ac.abort()
        let killed = false
        const spawnFn = (() => {
            const p = makeProc()
            p.kill = () => {
                killed = true
                p.killed = true
                p.emit('close', 143)
                return true
            }
            return p as unknown as ProcLike
        }) as unknown as SpawnFn

        const git = makeGit('/work/repo', ac.signal, spawnFn)
        const r = await git(['log'])
        expect(killed).toBe(true)
        expect(r.exitCode).toBe(143)
    })

    test('aborting mid-flight settles the promise (a hung git cannot wedge a caller)', async () => {
        const ac = new AbortController()
        const spawnFn = (() => {
            const p = makeProc()
            // Deliberately never closes on its own — the abort must end it.
            p.kill = () => {
                if (p.killed) return true
                p.killed = true
                p.emit('close', 143)
                return true
            }
            return p as unknown as ProcLike
        }) as unknown as SpawnFn

        const git = makeGit('/work/repo', ac.signal, spawnFn)
        const pending = git(['fetch'])
        ac.abort()
        expect(await pending).toEqual({stdout: '', exitCode: 143})
    })
})
