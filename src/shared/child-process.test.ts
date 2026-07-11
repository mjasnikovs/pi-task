import {describe, expect, test} from 'bun:test'
import {runChild, summarizeToolArgs} from './child-process.js'
import {fakeSpawnSimple, agentEndResponse, makeProc} from '../test-utils/fake-spawn.js'
import type {LoopHit, SpawnFn} from './child-process.js'

const noopInvocation = {command: 'pi', args: ['--print']}

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

    test('emits onContextUsage on context_usage event', async () => {
        const events = [{type: 'context_usage', tokens: 1000, contextWindow: 200000, percent: 0.5}]
        const stdout = events.map(e => JSON.stringify(e) + '\n').join('')
        const spawn = fakeSpawnSimple(stdout)
        const snapshots: Array<{tokens: number; contextWindow: number; percent: number}> = []
        await runChild(spawn, noopInvocation, '/tmp', undefined, {
            mode: 'json-events',
            onContextUsage: s => snapshots.push(s)
        })
        expect(snapshots).toHaveLength(1)
        expect(snapshots[0].tokens).toBe(1000)
        expect(snapshots[0].contextWindow).toBe(200000)
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
        expect(result.stalled).toBe(true)
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
        expect(result.stalled).toBeUndefined()
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
        expect(result.stalled).toBeUndefined()
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
        expect(result.stalled).toBeUndefined()
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

// mx5 run 9 item 3: model children run arbitrary bash and can `bun run dev &` a
// server that outlives the child, holding a port and wrecking the final gate's own
// `bun run start` with a self-inflicted EADDRINUSE. They must be spawned in their
// own process group and that group reaped on exit; plumbing (text mode) must not be.
describe('runChild process-group reaping', () => {
    /** A spawn that records the options it was handed and returns a controllable proc. */
    function recordingSpawn(pid: number | undefined): {spawn: SpawnFn; opts: {detached?: boolean}} {
        const opts: {detached?: boolean} = {}
        const spawn = ((_cmd: string, _args: string[], o: {detached?: boolean}) => {
            opts.detached = o.detached
            const p = makeProc()
            p.pid = pid
            queueMicrotask(() => p.emit('close', 0))
            return p
        }) as unknown as SpawnFn
        return {spawn, opts}
    }

    test('json-events child is spawned detached (its own process group)', async () => {
        const {spawn, opts} = recordingSpawn(4242)
        await runChild(spawn, noopInvocation, '/tmp', undefined, {mode: 'json-events'})
        expect(opts.detached).toBe(true)
    })

    test('text child (git/plumbing) is NOT detached', async () => {
        const {spawn, opts} = recordingSpawn(4242)
        await runChild(spawn, noopInvocation, '/tmp', undefined, {mode: 'text'})
        expect(opts.detached).toBeUndefined()
    })

    test('reaps the whole process group on close (negative-pid signal)', async () => {
        const {spawn} = recordingSpawn(4242)
        const killed: Array<{pid: number; sig: string | number}> = []
        const realKill = process.kill
        // Intercept so the test never signals a real group; record the calls.
        process.kill = ((p: number, s: string | number) => {
            killed.push({pid: p, sig: s})
            return true
        }) as typeof process.kill
        try {
            await runChild(spawn, noopInvocation, '/tmp', undefined, {mode: 'json-events'})
        } finally {
            process.kill = realKill
        }
        // The group (negative pid) got a SIGTERM once the child closed.
        expect(killed.some(k => k.pid === -4242 && k.sig === 'SIGTERM')).toBe(true)
    })

    test('text child does not signal any process group on close', async () => {
        const {spawn} = recordingSpawn(4242)
        const killed: number[] = []
        const realKill = process.kill
        process.kill = ((p: number) => {
            killed.push(p)
            return true
        }) as typeof process.kill
        try {
            await runChild(spawn, noopInvocation, '/tmp', undefined, {mode: 'text'})
        } finally {
            process.kill = realKill
        }
        expect(killed).toEqual([])
    })
})
