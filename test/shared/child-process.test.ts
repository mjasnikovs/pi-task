import {afterEach, describe, expect, jest, test} from 'bun:test'
import {getEventListeners} from 'node:events'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
    KILL_GRACE_MS,
    runChild,
    summarizeToolArgs,
    ownGroupSpawnOptions,
    reapProcessGroup
} from '../../src/shared/child-process.js'
import {spawn as realSpawn} from 'node:child_process'
import {fakeSpawnSimple, agentEndResponse, makeProc} from '../test-utils/fake-spawn.js'
import {fakeTaskkill, recordKills} from '../test-utils/fake-reap.js'
import {testPosix} from '../test-utils/platform.js'
import {dead} from '../test-utils/process-state.js'
import {tmpDir} from '../test-utils/tmp-dir.js'
import type {
    ChildResult,
    LoopHit,
    RunChildOptions,
    SpawnFn
} from '../../src/shared/child-process.js'

const noopInvocation = {command: 'pi', args: ['--print']}

/**
 * Kills for real processes a test started, run after it even when it failed or timed
 * out. A test that saw its processes die clears them: a dead pid may be reused.
 */
const strays: Array<() => void> = []
afterEach(() => {
    for (const kill of strays.splice(0)) {
        try {
            kill()
        } catch {
            // already gone
        }
    }
})

/** Kill the pid a real child wrote to `file`, if it got that far. */
const killPidIn = (file: string) => (): void => {
    if (fs.existsSync(file)) process.kill(Number(fs.readFileSync(file, 'utf8')), 'SIGKILL')
}

/** Spawn fake that emits each given raw string as its own stdout 'data' chunk,
 *  then closes. Lets tests control exactly where chunk boundaries fall. */
function fakeSpawnChunks(chunks: string[], exitCode = 0): SpawnFn {
    return (() => {
        const p = makeProc()
        queueMicrotask(() => {
            for (const c of chunks) p.stdout!.emit('data', Buffer.from(c))
            p.emit('close', exitCode)
        })
        return p
    }) as unknown as SpawnFn
}

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

describe('runChild stdin delivery', () => {
    /** A child whose stdin pipe breaks on write, the way a killed child's does. */
    function fakeSpawnBrokenStdin(exitCode: number, killedByUs = false): SpawnFn {
        return (() => {
            const p = makeProc()
            let onError: ((e: unknown) => void) | undefined
            p.stdin = {
                write: () => {
                    queueMicrotask(() => onError?.(new Error('write EPIPE')))
                    return false
                },
                end: () => {},
                on: (_e: 'error', l: (e: unknown) => void) => (onError = l)
            }
            queueMicrotask(() => {
                queueMicrotask(() => {
                    if (killedByUs) p.kill('SIGTERM')
                    p.emit('close', exitCode)
                })
            })
            return p
        }) as unknown as SpawnFn
    }

    test('a broken stdin does not take the host down and fails the run', async () => {
        const result = await runChild(
            fakeSpawnBrokenStdin(0),
            {...noopInvocation, stdin: 'the prompt'},
            '/tmp',
            undefined,
            {mode: 'text'}
        )
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain('prompt delivery failed')
    })

    test("a broken stdin keeps the child's own non-zero exit", async () => {
        const result = await runChild(
            fakeSpawnBrokenStdin(42),
            {...noopInvocation, stdin: 'the prompt'},
            '/tmp',
            undefined,
            {mode: 'text'}
        )
        expect(result.exitCode).toBe(42)
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

    // The string `context_usage` appears in no installed @earendil-works package,
    // so a test fed on such an event would assert nothing. `message_end` is the
    // real and only readout, and the WINDOW comes from the caller because the
    // stream carries none.
    test('emits onContextUsage from message_end, windowed by the caller', async () => {
        const events = [
            {
                type: 'message_end',
                message: {
                    role: 'assistant',
                    usage: {input: 900, cacheRead: 100, cacheWrite: 0, output: 0}
                }
            }
        ]
        const stdout = events.map(e => JSON.stringify(e) + '\n').join('')
        const spawn = fakeSpawnSimple(stdout)
        const snapshots: Array<{tokens: number; contextWindow: number; percent: number}> = []
        await runChild(spawn, noopInvocation, '/tmp', undefined, {
            mode: 'json-events',
            contextWindow: 200_000,
            onContextUsage: s => snapshots.push(s)
        })
        expect(snapshots).toHaveLength(1)
        expect(snapshots[0].tokens).toBe(1000)
        expect(snapshots[0].contextWindow).toBe(200_000)
        expect(snapshots[0].percent).toBe(0.5)
    })

    test('parses an event whose JSON is split across two data chunks', async () => {
        const line = JSON.stringify(agentEndResponse('split answer').events[0]) + '\n'
        const mid = Math.floor(line.length / 2)
        const spawn = fakeSpawnChunks([line.slice(0, mid), line.slice(mid)])
        const result = await runChild(spawn, noopInvocation, '/tmp', undefined, {
            mode: 'json-events'
        })
        expect(result.text).toBe('split answer')
    })

    test('flushes a final event that is not newline-terminated', async () => {
        // No trailing '\n' — the event only completes at close.
        const line = JSON.stringify(agentEndResponse('no newline').events[0])
        const spawn = fakeSpawnChunks([line])
        const result = await runChild(spawn, noopInvocation, '/tmp', undefined, {
            mode: 'json-events'
        })
        expect(result.text).toBe('no newline')
    })

    test('does not buffer the raw stream into stdout (prevents string-length overflow)', async () => {
        // A large multi-chunk json-events stream must not accumulate in stdout.
        const deltas = Array.from({length: 50}, (_, i) => ({
            type: 'message_update',
            assistantMessageEvent: {type: 'text_delta', delta: `x${i} `}
        }))
        const chunks = [
            JSON.stringify({type: 'message_update', assistantMessageEvent: {type: 'text_start'}})
                + '\n',
            ...deltas.map(e => JSON.stringify(e) + '\n')
        ]
        const spawn = fakeSpawnChunks(chunks)
        const result = await runChild(spawn, noopInvocation, '/tmp', undefined, {
            mode: 'json-events'
        })
        // Text is still assembled from the deltas…
        expect(result.text).toContain('x0')
        expect(result.text).toContain('x49')
        // …but the raw event bytes were dropped, not buffered.
        expect(result.stdout).toBe('')
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

    test('a loop hit in the tail flushed after the leader exited is still the verdict', async () => {
        // The last event of a run has no newline behind it, so it reaches the sink
        // only in the flush that runs after 'exit'. A looped child that then exits 0
        // must not pass for a clean answer.
        const spawn = (() => {
            const p = makeProc()
            queueMicrotask(() => {
                const evt = {type: 'tool_execution_start', toolName: 'bash', args: {command: 'ls'}}
                p.stdout!.emit('data', Buffer.from(JSON.stringify(evt)))
                p.emit('exit', 0)
                p.emit('close', 0)
            })
            return p
        }) as unknown as SpawnFn
        const hit: LoopHit = {call: {name: 'bash', args: {command: 'ls'}}, count: 5, windowSize: 5}
        const result = await runChild(spawn, noopInvocation, '/tmp', undefined, {
            mode: 'json-events',
            onToolCall: () => hit
        })
        expect(result.kill).toEqual({by: 'loop', hit})
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

describe('runChild stall guard (dead model backend)', () => {
    /** A proc that emits `chunks` at `everyMs` intervals and never closes on its
     *  own — only a kill() closes it (like a pi child wedged on a dead backend). */
    function wedgedSpawn(chunks: number, everyMs: number): SpawnFn {
        return (() => {
            const p = makeProc()
            let sent = 0
            const feed = setInterval(() => {
                if (sent < chunks) {
                    p.stdout!.emit('data', Buffer.from('{"type":"noise"}\n'))
                    sent++
                }
            }, everyMs)
            const origKill = p.kill.bind(p)
            p.kill = (sig: string) => {
                origKill(sig)
                clearInterval(feed)
                setTimeout(() => p.emit('close', null), 5)
                return true
            }
            return p
        }) as unknown as SpawnFn
    }

    test('no output + unreachable endpoint → killed with stalled:true', async () => {
        let probes = 0
        const result = await runChild(wedgedSpawn(1, 5), noopInvocation, '/tmp', undefined, {
            mode: 'json-events',
            stall: {
                afterMs: 80,
                probe: () => {
                    probes++
                    return Promise.resolve(false)
                }
            }
        })
        expect(result.kill).toEqual({by: 'stalled'})
        expect(result.aborted).toBe(true)
        expect(probes).toBe(1)
    })

    test('no output + REACHABLE endpoint → keeps waiting (prompt processing)', async () => {
        let probes = 0
        const spawn = (() => {
            const p = makeProc()
            // Silent for 3+ stall windows, then finishes honestly.
            setTimeout(() => p.emit('close', 0), 300)
            return p
        }) as unknown as SpawnFn
        const result = await runChild(spawn, noopInvocation, '/tmp', undefined, {
            mode: 'json-events',
            stall: {
                afterMs: 60,
                probe: () => {
                    probes++
                    return Promise.resolve(true)
                }
            }
        })
        expect(result.kill).toBeUndefined()
        expect(result.aborted).toBe(false)
        expect(probes).toBeGreaterThanOrEqual(1)
    })

    test('output progress resets the window — probe never fires for a chatty child', async () => {
        let probes = 0
        const spawn = (() => {
            const p = makeProc()
            let sent = 0
            const feed = setInterval(() => {
                p.stdout!.emit('data', Buffer.from('{"type":"noise"}\n'))
                if (++sent === 6) {
                    clearInterval(feed)
                    p.emit('close', 0)
                }
            }, 40)
            return p
        }) as unknown as SpawnFn
        const result = await runChild(spawn, noopInvocation, '/tmp', undefined, {
            mode: 'json-events',
            stall: {
                afterMs: 150,
                probe: () => {
                    probes++
                    return Promise.resolve(false)
                }
            }
        })
        expect(result.kill).toBeUndefined()
        expect(probes).toBe(0)
    })

    test('a crashing probe proves nothing → keeps waiting', async () => {
        const spawn = (() => {
            const p = makeProc()
            setTimeout(() => p.emit('close', 0), 200)
            return p
        }) as unknown as SpawnFn
        const result = await runChild(spawn, noopInvocation, '/tmp', undefined, {
            mode: 'json-events',
            stall: {afterMs: 60, probe: () => Promise.reject(new Error('probe broke'))}
        })
        expect(result.kill).toBeUndefined()
        expect(result.aborted).toBe(false)
    })
})

describe('summarizeToolArgs — search/fetch workers', () => {
    test('pi-worker-search shows the quoted query, 60-char clipped', () => {
        expect(summarizeToolArgs('pi-worker-search', {query: 'bun sql tagged template'})).toBe(
            '"bun sql tagged template"'
        )
        const long = 'x'.repeat(80)
        const out = summarizeToolArgs('pi-worker-search', {query: long})
        expect(out).toBe(`"${'x'.repeat(59)}…"`)
    })

    test('pi-worker-fetch shows the url, 60-char clipped', () => {
        expect(summarizeToolArgs('pi-worker-fetch', {url: 'https://bun.sh/docs', query: 'q'})).toBe(
            'https://bun.sh/docs'
        )
        const long = `https://example.com/${'a'.repeat(80)}`
        expect(summarizeToolArgs('pi-worker-fetch', {url: long})).toBe(long.slice(0, 59) + '…')
    })

    test('missing expected arg falls through to the generic fields', () => {
        expect(summarizeToolArgs('pi-worker-search', {q: 'wrong-name'})).toBe('')
        expect(summarizeToolArgs('pi-worker-fetch', {})).toBe('')
    })
})

// Model children run arbitrary bash and can background a server that outlives the
// child, holding a port and wrecking the final gate's own `bun run start` with a
// self-inflicted EADDRINUSE. They must be spawned in their OWN process group and
// that group reaped on exit; plumbing children (text mode) must not be.
describe('runChild process-group reaping', () => {
    type GroupOpts = {detached?: boolean; windowsHide?: boolean}
    /** A spawn that records the options it was handed and returns a controllable proc. */
    function recordingSpawn(pid: number | undefined): {spawn: SpawnFn; opts: GroupOpts} {
        const opts: GroupOpts = {}
        const spawn = ((_cmd: string, _args: string[], o: GroupOpts) => {
            opts.detached = o.detached
            opts.windowsHide = o.windowsHide
            const p = makeProc()
            p.pid = pid
            queueMicrotask(() => {
                p.emit('exit', 0, null)
                p.emit('close', 0)
            })
            return p
        }) as unknown as SpawnFn
        return {spawn, opts}
    }

    // Driven per platform, not read from the host: on a POSIX host a hardcoded
    // `detached: true` would satisfy the live-platform shape and the win32 arm
    // would never run.
    test('json-events child on win32 is spawned windowsHide, never detached', async () => {
        const {spawn, opts} = recordingSpawn(4242)
        await runChild(spawn, noopInvocation, '/tmp', undefined, {
            mode: 'json-events',
            platform: 'win32'
        })
        expect(opts).toEqual({windowsHide: true, detached: undefined})
    })

    test.each(['darwin', 'linux'] as const)(
        'json-events child on %s is spawned detached (its own process group)',
        async platform => {
            const {spawn, opts} = recordingSpawn(4242)
            await runChild(spawn, noopInvocation, '/tmp', undefined, {
                mode: 'json-events',
                platform
            })
            expect(opts).toEqual({detached: true, windowsHide: undefined})
        }
    )

    test('text child (git/plumbing) gets neither detached nor windowsHide', async () => {
        const {spawn, opts} = recordingSpawn(4242)
        await runChild(spawn, noopInvocation, '/tmp', undefined, {mode: 'text'})
        expect(opts.detached).toBeUndefined()
        expect(opts.windowsHide).toBeUndefined()
    })

    // Driven by `platform`, so the windows runner asserts the POSIX reap too.
    test('linux: a child that exits has its group SIGTERMed, then SIGKILLed', async () => {
        const {spawn} = recordingSpawn(4242)
        jest.useFakeTimers()
        try {
            const killed = await recordKills(async () => {
                await runChild(spawn, noopInvocation, '/tmp', undefined, {
                    mode: 'json-events',
                    platform: 'linux'
                })
                jest.advanceTimersByTime(KILL_GRACE_MS)
            })
            expect(killed).toEqual([
                {pid: -4242, sig: 'SIGTERM'},
                {pid: -4242, sig: 'SIGKILL'}
            ])
        } finally {
            jest.useRealTimers()
        }
    })

    test('text child does not signal any process group on close', async () => {
        const {spawn} = recordingSpawn(4242)
        const killed = await recordKills(() =>
            runChild(spawn, noopInvocation, '/tmp', undefined, {mode: 'text'})
        )
        expect(killed).toEqual([])
    })

    /** A model child that closes once killed, as a real one does. */
    function killableSpawn(onKill: () => void): SpawnFn {
        return (() => {
            const p = makeProc()
            p.pid = 4242
            p.kill = () => {
                onKill()
                p.killed = true
                queueMicrotask(() => {
                    p.emit('exit', null, 'SIGTERM')
                    p.emit('close', null)
                })
                return true
            }
            return p
        }) as unknown as SpawnFn
    }

    /** Abort a model child on `platform`, then run out every reap timer it armed. */
    async function abortOn(platform: NodeJS.Platform, onKill: () => void = () => {}) {
        const controller = new AbortController()
        jest.useFakeTimers()
        try {
            const run = runChild(killableSpawn(onKill), noopInvocation, '/tmp', controller.signal, {
                mode: 'json-events',
                platform
            })
            controller.abort()
            await run
            jest.advanceTimersByTime(KILL_GRACE_MS)
        } finally {
            jest.useRealTimers()
        }
    }

    /** A child deaf to SIGTERM, as a hung one can be, that dies only to SIGKILL. */
    function termDeafSpawn(signals: string[]): SpawnFn {
        return (() => {
            const p = makeProc()
            p.pid = 4242
            p.kill = (sig: string) => {
                signals.push(sig)
                p.killed = true
                if (sig === 'SIGKILL') {
                    queueMicrotask(() => {
                        p.emit('exit', null, 'SIGKILL')
                        p.emit('close', null)
                    })
                }
                return true
            }
            return p
        }) as unknown as SpawnFn
    }

    /**
     * Abort a SIGTERM-deaf child and let its grace period run out. The run comes back
     * unawaited with the clock real again, so one that never settles fails on the
     * test timeout instead of stranding fake timers and kill spies for later tests.
     */
    function abortDeaf(opts: RunChildOptions, signals: string[] = []): Promise<ChildResult> {
        const controller = new AbortController()
        jest.useFakeTimers()
        try {
            const run = runChild(
                termDeafSpawn(signals),
                noopInvocation,
                '/tmp',
                controller.signal,
                opts
            )
            controller.abort()
            jest.advanceTimersByTime(KILL_GRACE_MS)
            return run
        } finally {
            jest.useRealTimers()
        }
    }

    // `killed` turns true once SIGTERM is delivered, not once the child is gone.
    test('a child deaf to SIGTERM is SIGKILLed when the grace period ends', async () => {
        const signals: string[] = []
        const r = await abortDeaf({mode: 'text'}, signals)
        expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
        expect(r.kill).toEqual({by: 'aborted'})
    })

    test("linux: a deaf model child's group is SIGKILLed when the grace period ends", async () => {
        let run: Promise<ChildResult> | undefined
        const killed = await recordKills(() => {
            run = abortDeaf({mode: 'json-events', platform: 'linux'})
        })
        expect(killed.slice(0, 2)).toEqual([
            {pid: -4242, sig: 'SIGTERM'},
            {pid: -4242, sig: 'SIGKILL'}
        ])
        await run
    })

    // Once the child has exited Windows may hand its pid to an unrelated process,
    // and `taskkill /T /F` would kill that one and everything under it.
    test('win32: a child that exits on its own is never taskkilled', async () => {
        const tk = fakeTaskkill()
        jest.useFakeTimers()
        try {
            const {spawn} = recordingSpawn(4242)
            const killed = await recordKills(async () => {
                await runChild(spawn, noopInvocation, '/tmp', undefined, {
                    mode: 'json-events',
                    platform: 'win32'
                })
                jest.advanceTimersByTime(KILL_GRACE_MS)
            })
            expect(killed).toEqual([])
            expect(tk.calls()).toEqual([])
        } finally {
            jest.useRealTimers()
            tk.restore()
        }
    })

    // taskkill walks the tree down from a live root.
    test('win32: a killed child is taskkilled once, before its own kill', async () => {
        const tk = fakeTaskkill()
        try {
            const killed = await recordKills(() => abortOn('win32', () => tk.note('kill')))
            expect(killed).toEqual([])
            expect(tk.calls()).toEqual(['taskkill /pid 4242 /T /F', 'kill'])
        } finally {
            tk.restore()
        }
    })

    // A grandchild holding the inherited pipes keeps 'close' away long after the
    // leader exited. The run ends with the leader, and a kill landing after it is moot.
    test('win32: the run ends when the leader exits, though its pipes stay open', async () => {
        const tk = fakeTaskkill()
        const controller = new AbortController()
        const p = makeProc()
        p.pid = 4242
        try {
            let run: Promise<ChildResult> | undefined
            const killed = await recordKills(() => {
                jest.useFakeTimers()
                try {
                    run = runChild(
                        (() => p) as unknown as SpawnFn,
                        noopInvocation,
                        '/tmp',
                        controller.signal,
                        {mode: 'json-events', platform: 'win32'}
                    )
                    p.emit('exit', 0, null)
                    controller.abort()
                    jest.advanceTimersByTime(KILL_GRACE_MS)
                } finally {
                    jest.useRealTimers()
                }
            })
            const r = await run!
            expect(r.exitCode).toBe(0)
            expect(r.kill).toBeUndefined()
            expect(killed).toEqual([])
            expect(tk.calls()).toEqual([])
        } finally {
            tk.restore()
        }
    })

    // A spawn seam need not report 'exit'; 'close' still means the leader is gone.
    test('win32: a leader seen only through close is not taskkilled after it', async () => {
        const tk = fakeTaskkill()
        const controller = new AbortController()
        const spawn = (() => {
            const p = makeProc()
            p.pid = 4242
            p.kill = () => {
                p.killed = true
                queueMicrotask(() => p.emit('close', null))
                return true
            }
            return p
        }) as unknown as SpawnFn
        jest.useFakeTimers()
        try {
            const run = runChild(spawn, noopInvocation, '/tmp', controller.signal, {
                mode: 'json-events',
                platform: 'win32'
            })
            controller.abort()
            await run
            jest.advanceTimersByTime(KILL_GRACE_MS)
            expect(tk.calls()).toEqual(['taskkill /pid 4242 /T /F'])
        } finally {
            jest.useRealTimers()
            tk.restore()
        }
    })

    // Real processes on the host's platform. Detached, so neither a POSIX group reap
    // nor the job a Windows runtime puts its children in ends the grandchild early.
    test('a real child ends its run on exit, though a grandchild holds its pipes', async () => {
        const pidFile = path.join(tmpDir('grandchild-pid-'), 'pid')
        strays.push(killPidIn(pidFile))
        const script = [
            "const {spawn} = require('node:child_process')",
            "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], {detached: true, stdio: 'inherit'})",
            "require('node:fs').writeFileSync(process.env.GRANDCHILD_PID_FILE, String(g.pid))",
            'process.exit(0)'
        ].join('\n')
        const r = await runChild(
            realSpawn as unknown as SpawnFn,
            {
                command: process.execPath,
                args: ['-e', script],
                env: {...process.env, GRANDCHILD_PID_FILE: pidFile}
            },
            process.cwd(),
            undefined,
            {mode: 'json-events'}
        )
        expect(r.exitCode).toBe(0)
    })
})

describe('reapProcessGroup', () => {
    test('win32: one forced tree kill through System32 taskkill', async () => {
        const tk = fakeTaskkill()
        try {
            const killed = await recordKills(() =>
                reapProcessGroup(4242, 'SIGTERM', {platform: 'win32', leaderExited: false})
            )
            expect(killed).toEqual([])
            expect(tk.calls()).toEqual(['taskkill /pid 4242 /T /F'])
        } finally {
            tk.restore()
        }
    })

    test('win32: nothing once the leader has exited', async () => {
        const tk = fakeTaskkill()
        try {
            const killed = await recordKills(() =>
                reapProcessGroup(4242, 'SIGTERM', {platform: 'win32', leaderExited: true})
            )
            expect(killed).toEqual([])
            expect(tk.calls()).toEqual([])
        } finally {
            tk.restore()
        }
    })

    // A POSIX group outlives its leader, and the server it backgrounded is the point.
    test('linux: the group is signalled even after the leader exited', async () => {
        const killed = await recordKills(() =>
            reapProcessGroup(4242, 'SIGKILL', {platform: 'linux', leaderExited: true})
        )
        expect(killed).toEqual([{pid: -4242, sig: 'SIGKILL'}])
    })

    // Windows always sets SystemRoot, but an empty one must not turn the path relative
    // and run whatever System32\taskkill.exe the working directory holds. On a windows
    // host the real taskkill answers instead, so it is aimed at a process of our own.
    test('win32: an empty SystemRoot never runs a taskkill from the working directory', async () => {
        const target = realSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], {
            stdio: 'ignore'
        })
        strays.push(() => target.kill('SIGKILL'))
        const tk = fakeTaskkill({relative: true})
        try {
            await recordKills(() =>
                reapProcessGroup(target.pid!, 'SIGTERM', {platform: 'win32', leaderExited: false})
            )
            expect(tk.calls()).toEqual([])
        } finally {
            tk.restore()
        }
    })

    // Real processes on the host's own platform: on the windows runner this runs the
    // real taskkill. The grandchild shares the leader's stdout, so 'close' arrives only
    // once both are dead.
    test('a live leader is reaped together with the grandchild it started', async () => {
        const leaderScript = [
            "const {spawn} = require('node:child_process')",
            "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], {stdio: 'inherit'})",
            'console.log(g.pid)',
            'setInterval(() => {}, 1 << 30)'
        ].join('\n')
        const leader = realSpawn(process.execPath, ['-e', leaderScript], {
            ...ownGroupSpawnOptions(process.platform),
            stdio: ['ignore', 'pipe', 'ignore']
        })
        let grandchild: number | undefined
        strays.push(
            () => leader.kill('SIGKILL'),
            () => grandchild && process.kill(grandchild, 'SIGKILL')
        )
        const closed = new Promise(resolve => leader.once('close', resolve))
        await new Promise((resolve, reject) => {
            leader.stdout.once('data', (d: Buffer) => resolve((grandchild = Number(String(d)))))
            leader.once('error', reject)
        })
        reapProcessGroup(leader.pid!, 'SIGKILL', {leaderExited: false})
        await closed
        strays.length = 0
    })
})

// pi's bash tool starts every command in a group of its own, so this is the shape a
// model's `bun run dev &` really takes. Real processes on the host's platform.
describe('what a model child leaves running', () => {
    const piBashTool = new URL(
        './core/tools/bash.js',
        import.meta.resolve('@earendil-works/pi-coding-agent')
    ).href
    const slashes = (p: string): string => p.replace(/\\/g, '/')
    const keepAlive = 'setInterval(() => {}, 1 << 30)'

    test("a server backgrounded through pi's bash tool ends with the child", async () => {
        const dir = tmpDir('leftover-')
        const serverPidFile = path.join(dir, 'server.pid')
        const userMarker = path.join(dir, 'user-bash-env-ran')
        const userBashEnv = path.join(dir, 'user-bash-env.sh')
        fs.writeFileSync(userBashEnv, `echo ran > '${slashes(userMarker)}'\n`)
        const modelChild = path.join(dir, 'model-child.mjs')
        fs.writeFileSync(
            modelChild,
            [
                `import {createLocalBashOperations} from ${JSON.stringify(piBashTool)}`,
                'await createLocalBashOperations().exec(process.env.SERVER_COMMAND, process.cwd(), {onData: () => {}})',
                'process.exit(0)'
            ].join('\n')
        )
        // `/proc/$!/winpid` is Git Bash's map from its own pid to the Windows one.
        const serverCommand =
            `'${slashes(process.execPath)}' -e '${keepAlive}' & `
            + `echo $(cat /proc/$!/winpid 2>/dev/null || echo $!) > '${slashes(serverPidFile)}'`
        const bystander = realSpawn(process.execPath, ['-e', keepAlive], {stdio: 'ignore'})
        strays.push(() => bystander.kill('SIGKILL'), killPidIn(serverPidFile))

        const r = await runChild(
            realSpawn as unknown as SpawnFn,
            {
                command: process.execPath,
                args: [modelChild],
                env: {...process.env, BASH_ENV: userBashEnv, SERVER_COMMAND: serverCommand}
            },
            dir,
            undefined,
            {mode: 'json-events'}
        )
        expect(r.exitCode).toBe(0)
        // Gone when the run settles, not merely signalled: the next phase binds its port.
        expect(dead(Number(fs.readFileSync(serverPidFile, 'utf8')))).toBe(true)
        expect(fs.existsSync(userMarker)).toBe(true)
        expect(dead(bystander.pid!)).toBe(false)
        strays.length = 0
        bystander.kill('SIGKILL')
    })
})

describe('the pipes are released when the run settles', () => {
    testPosix('a grandchild that inherited stderr cannot grow the result after it', async () => {
        const dir = tmpDir('pipe-holder-')
        const pidFile = path.join(dir, 'writer.pid')
        strays.push(killPidIn(pidFile))
        let proc: ReturnType<typeof realSpawn> | undefined
        const spawn = ((...args: Parameters<typeof realSpawn>) => {
            proc = realSpawn(...args)
            return proc
        }) as unknown as SpawnFn
        const r = await runChild(
            spawn,
            {
                command: 'sh',
                args: ['-c', `(while :; do echo x >&2; sleep 0.01; done) & echo $! > '${pidFile}'`]
            },
            dir,
            undefined,
            {mode: 'text'}
        )
        expect(r.exitCode).toBe(0)
        // Settled on 'exit' with the writer still holding the pipe; the read end
        // must be closed, or every line it writes lands in a string nobody reads.
        expect(proc!.stdout!.destroyed).toBe(true)
        expect(proc!.stderr!.destroyed).toBe(true)
    })
})

// ─── Abort-listener lifecycle ────────────────────────────────────────────────

/**
 * A TaskRunner shares ONE AbortController across every child of a run, so any
 * listener a finished child leaves behind lives until the whole run ends — and
 * `killProc`'s closure retains that child, its invocation (prompt included) and
 * `opts` with it. The registration IS `{once: true}`, and that does not help: it
 * removes the listener only when an abort actually fires, which is exactly the
 * path a healthy run never takes. The explicit `removeEventListener` is what
 * detaches it; these tests pin that on every terminal path.
 */
describe('runChild abort-listener lifecycle', () => {
    const listeners = (s: AbortSignal): number => getEventListeners(s, 'abort').length

    /** Spawn fake whose child ends via the given event instead of a normal close. */
    function fakeSpawnEnding(event: 'close' | 'error'): SpawnFn {
        return (() => {
            const p = makeProc()
            queueMicrotask(() => p.emit(event, event === 'close' ? 0 : new Error('spawn failed')))
            return p
        }) as unknown as SpawnFn
    }

    test('leaves no listener after 20 children close normally on a shared signal', async () => {
        const controller = new AbortController()
        for (let i = 0; i < 20; i++) {
            await runChild(fakeSpawnEnding('close'), noopInvocation, '/tmp', controller.signal, {
                mode: 'text'
            })
        }
        expect(controller.signal.aborted).toBe(false)
        expect(listeners(controller.signal)).toBe(0)
    })

    test('leaves no listener after 20 children fail via error on a shared signal', async () => {
        const controller = new AbortController()
        for (let i = 0; i < 20; i++) {
            const r = await runChild(
                fakeSpawnEnding('error'),
                noopInvocation,
                '/tmp',
                controller.signal,
                {mode: 'text'}
            )
            expect(r.exitCode).toBe(1)
        }
        expect(listeners(controller.signal)).toBe(0)
    })

    test('detaches on the json-events path too (own process group, sink attached)', async () => {
        const controller = new AbortController()
        for (let i = 0; i < 10; i++) {
            await runChild(
                fakeSpawnSimple(JSON.stringify(agentEndResponse('hi').events[0]) + '\n'),
                noopInvocation,
                '/tmp',
                controller.signal,
                {mode: 'json-events'}
            )
        }
        expect(listeners(controller.signal)).toBe(0)
    })

    test('aborting an active child cleans up once and resolves once', async () => {
        const controller = new AbortController()
        let closes = 0
        const spawn = (() => {
            const p = makeProc()
            p.kill = () => {
                if (p.killed) return true
                p.killed = true
                // A real child answers SIGTERM with a close; count them so a
                // double-settle would show up as more than one resolution.
                queueMicrotask(() => {
                    closes++
                    p.emit('close', 143)
                })
                return true
            }
            return p
        }) as unknown as SpawnFn

        const run = runChild(spawn, noopInvocation, '/tmp', controller.signal, {mode: 'text'})
        controller.abort()
        const result = await run
        expect(result.aborted).toBe(true)
        expect(closes).toBe(1)
        expect(listeners(controller.signal)).toBe(0)
    })

    test('racing error and close resolves once and leaves no listener', async () => {
        const controller = new AbortController()
        const spawn = (() => {
            const p = makeProc()
            queueMicrotask(() => {
                p.emit('error', new Error('boom'))
                p.emit('close', 0)
                p.emit('close', 0)
            })
            return p
        }) as unknown as SpawnFn

        // The first terminal event wins; the later ones must not re-resolve.
        const result = await runChild(spawn, noopInvocation, '/tmp', controller.signal, {
            mode: 'text'
        })
        expect(result.exitCode).toBe(1)
        expect(listeners(controller.signal)).toBe(0)
    })

    test('an already-aborted signal gains no listener', async () => {
        const controller = new AbortController()
        controller.abort()
        await runChild(fakeSpawnEnding('close'), noopInvocation, '/tmp', controller.signal, {
            mode: 'text'
        })
        expect(listeners(controller.signal)).toBe(0)
    })

    test('completed children are not retained by the shared signal', async () => {
        const controller = new AbortController()
        const refs: Array<WeakRef<object>> = []
        const spawn = (() => {
            const p = makeProc()
            refs.push(new WeakRef(p))
            queueMicrotask(() => p.emit('close', 0))
            return p
        }) as unknown as SpawnFn

        for (let i = 0; i < 8; i++) {
            await runChild(spawn, {command: 'pi', args: []}, '/tmp', controller.signal, {
                mode: 'text'
            })
        }
        // Let the close-path group-reap timer expire, then force collection.
        await new Promise(r => setTimeout(r, 1_200))
        Bun.gc(true)
        // The most recent child may still be reachable from the stack; every
        // earlier one must be collectable now that its listener is detached.
        const alive = refs.filter(r => r.deref() !== undefined).length
        expect(alive).toBeLessThanOrEqual(1)
    })
})

// Issue #20: on Windows a `detached` child gets its own console window, and
// every console process the model then runs pops another. The reap there is
// `taskkill /T`, which needs no flag. POSIX keeps `detached` — it is what makes
// `kill(-pid)` sweep a backgrounded server. Pinned per platform so a mac or
// linux edit cannot bring the window spam back, and a windows edit cannot lose
// the group reap.
describe('ownGroupSpawnOptions', () => {
    test('win32: hidden console, never detached', () => {
        expect(ownGroupSpawnOptions('win32')).toEqual({windowsHide: true})
    })

    test.each(['darwin', 'linux'] as const)('%s: own process group', platform => {
        expect(ownGroupSpawnOptions(platform)).toEqual({detached: true})
    })

    testPosix('a real POSIX child under these options leads its own group', async () => {
        const p = realSpawn('sh', ['-c', 'ps -o pgid= -p $$'], {
            ...ownGroupSpawnOptions(process.platform),
            stdio: ['ignore', 'pipe', 'ignore']
        })
        const pgid = await new Promise<string>((resolve, reject) => {
            let out = ''
            p.stdout.on('data', (d: Buffer) => (out += d.toString()))
            p.on('error', reject)
            p.on('close', () => resolve(out.trim()))
        })
        // A missing or busybox `ps` prints nothing; say so rather than let
        // Number('') === 0 read as "inherited the runner's group".
        expect(pgid).toMatch(/^\d+$/)
        // A group leader's pgid is its own pid. Inheriting ours would mean a
        // `kill(-pid)` reap hits nothing but ESRCH.
        expect(Number(pgid)).toBe(p.pid!)
    })
})
