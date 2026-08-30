/**
 * Shared spawn fakes for tests.
 *
 * Three factories:
 *   - fakeSpawnSimple(stdout, exitCode?, stderr?) — for one-shot worker tests
 *   - fakeSpawnQueue(responses) — yields each response in order across calls
 *   - fakeSpawnByPrompt(match) — picks a response by inspecting the prompt arg
 *
 * The shape matches SpawnFn from src/shared/child-process.ts: a function
 * returning a ProcLike — an EventEmitter carrying stdin, stdout, stderr, killed
 * and kill().
 */

import {EventEmitter} from 'node:events'
import type {ProcLike, SpawnFn} from '../../src/shared/child-process.js'

export interface SpawnResponseText {
    stdout: string
    exitCode?: number
    stderr?: string
    /**
     * Delay (ms) between emitting output and the `close` event. Lets a test
     * simulate a child that keeps running — so a per-worker wall-clock timeout
     * fires before the child exits on its own. Default: close immediately.
     */
    closeDelayMs?: number
}

export interface SpawnResponseJsonEvents {
    /**
     * One JSON event per entry. Each is JSON.stringified and emitted as a
     * stdout chunk followed by `\n`. After the last event a `close` is emitted.
     */
    events: ReadonlyArray<Record<string, unknown>>
    exitCode?: number
    stderr?: string
    /** See SpawnResponseText.closeDelayMs. */
    closeDelayMs?: number
}

export type SpawnResponse = SpawnResponseText | SpawnResponseJsonEvents

function isJsonEvents(r: SpawnResponse): r is SpawnResponseJsonEvents {
    return Array.isArray((r as SpawnResponseJsonEvents).events)
}

function emitResponse(
    emitter: EventEmitter & {
        stdout: EventEmitter
        stderr: EventEmitter
    },
    r: SpawnResponse
): void {
    const exitCode = r.exitCode ?? 0
    const stderr = r.stderr ?? ''
    queueMicrotask(() => {
        if (isJsonEvents(r)) {
            for (const evt of r.events) {
                emitter.stdout.emit('data', Buffer.from(JSON.stringify(evt) + '\n'))
            }
        } else {
            if (r.stdout) emitter.stdout.emit('data', Buffer.from(r.stdout))
        }
        if (stderr) emitter.stderr.emit('data', Buffer.from(stderr))
        // A delayed close lets the child appear to keep running past a caller's
        // timeout; the close still arrives so the run promise resolves.
        if (r.closeDelayMs && r.closeDelayMs > 0) {
            setTimeout(() => emitter.emit('close', exitCode), r.closeDelayMs)
        } else {
            emitter.emit('close', exitCode)
        }
    })
}

export function makeProc(): EventEmitter & ProcLike & {stdinData: string} {
    const emitter = new EventEmitter() as EventEmitter & ProcLike & {stdinData: string}
    emitter.stdout = new EventEmitter()
    emitter.stderr = new EventEmitter()
    // Capture whatever runChild writes to stdin — that is where it delivers the
    // prompt. Tests that need the prompt read `stdinData` after the run.
    emitter.stdinData = ''
    emitter.stdin = {
        write: (chunk: string) => {
            emitter.stdinData += chunk
            return true
        },
        end: () => {}
    }
    emitter.killed = false
    emitter.kill = () => {
        emitter.killed = true
        return true
    }
    return emitter
}

export function fakeSpawnSimple(stdout: string, exitCode = 0, stderr = ''): SpawnFn {
    return (() => {
        const p = makeProc()
        emitResponse(p as EventEmitter & {stdout: EventEmitter; stderr: EventEmitter}, {
            stdout,
            exitCode,
            stderr
        })
        return p
    }) as unknown as SpawnFn
}

export function fakeSpawnQueue(responses: ReadonlyArray<SpawnResponse>): SpawnFn {
    let i = 0
    return (() => {
        const p = makeProc()
        const r = responses[i] ?? responses[responses.length - 1]
        i++
        emitResponse(p as EventEmitter & {stdout: EventEmitter; stderr: EventEmitter}, r)
        return p
    }) as unknown as SpawnFn
}

export function fakeSpawnByPrompt(match: (args: ReadonlyArray<string>) => SpawnResponse): SpawnFn {
    return ((_cmd: string, args: ReadonlyArray<string>) => {
        const p = makeProc()
        // The prompt arrives on stdin, which runChild writes synchronously right
        // after this returns — so defer response selection to a microtask and append
        // the captured prompt as the final args element. A matcher reading
        // args[args.length - 1] then sees it either way; an arg-only spawn (git)
        // gets nothing appended.
        queueMicrotask(() => {
            const argsForMatch = p.stdinData.length > 0 ? [...args, p.stdinData] : args
            emitResponse(
                p as EventEmitter & {stdout: EventEmitter; stderr: EventEmitter},
                match(argsForMatch)
            )
        })
        return p
    }) as unknown as SpawnFn
}

/**
 * A child that emits its events SPACED OUT over time, rather than all at once.
 *
 * The other factories deliver everything in one microtask, which makes every
 * worker instantaneous and hides any distinction between "slow" and "stuck".
 * Pacing is what lets a test tell a worker that is steadily working from one
 * that has gone quiet — the whole point of a progress-based deadline.
 *
 * @param gapMs             delay between consecutive events
 * @param trailingSilenceMs quiet time after the last event, before `close`
 */
export function pacedSpawn(
    events: ReadonlyArray<Record<string, unknown>>,
    gapMs: number,
    trailingSilenceMs = 0
): SpawnFn {
    return (() => {
        const p = makeProc()
        let i = 0
        const step = (): void => {
            // A killed child still has to close, or the run promise never
            // settles and the test hangs instead of failing.
            if (p.killed) {
                p.emit('close', 0)
                return
            }
            if (i >= events.length) {
                setTimeout(() => p.emit('close', 0), trailingSilenceMs)
                return
            }
            ;(p.stdout as EventEmitter).emit('data', Buffer.from(JSON.stringify(events[i]) + '\n'))
            i++
            setTimeout(step, gapMs)
        }
        setTimeout(step, gapMs)
        return p
    }) as unknown as SpawnFn
}

/**
 * Convenience: a response whose event stream repeats the SAME tool_execution_start
 * `count` times — enough identical calls to trip a LoopDetector(window, threshold).
 * No agent_end, so the only assistant text is whatever `trailingText` supplies
 * (default none), mimicking a worker killed mid-thrash. Optionally hold the close
 * open with `closeDelayMs` to also model a worker that never exits on its own.
 */
export function loopResponse(
    toolName: string,
    args: Record<string, unknown>,
    count: number,
    opts: {exitCode?: number; closeDelayMs?: number; trailingText?: string} = {}
): SpawnResponseJsonEvents {
    const events: Array<Record<string, unknown>> = []
    for (let i = 0; i < count; i++) {
        events.push({type: 'tool_execution_start', toolName, args})
    }
    if (opts.trailingText !== undefined) {
        events.push({
            type: 'agent_end',
            messages: [{role: 'assistant', content: [{type: 'text', text: opts.trailingText}]}]
        })
    }
    return {
        events,
        exitCode: opts.exitCode ?? 0,
        ...(opts.closeDelayMs ? {closeDelayMs: opts.closeDelayMs} : {})
    }
}

/**
 * A child that NEVER ends on its own — it emits its events and then goes quiet,
 * exactly like a pi child blocked in an unbounded `bash` call. It ends only when
 * killed: `kill()` emits `close` with 143 (SIGTERM), as a real child does when
 * runChild aborts its signal.
 *
 * Needed because the other factories always emit `close`, which is the one thing
 * a hung command does not do — and that pending-forever run IS the production
 * symptom the command watchdog exists to end. Each spawn takes the next response
 * in `responses` (last one repeats), and `onSpawn` receives the prompt so a test
 * can assert on the hint carried into a restart.
 */
export function fakeSpawnKillable(
    responses: ReadonlyArray<SpawnResponseJsonEvents>,
    onSpawn?: (prompt: string) => void
): SpawnFn {
    let i = 0
    return (() => {
        const p = makeProc()
        const r = responses[Math.min(i, responses.length - 1)]!
        i++
        p.kill = () => {
            if (p.killed) return true
            p.killed = true
            p.emit('close', 143)
            return true
        }
        const streams = p as EventEmitter & {stdout: EventEmitter; stderr: EventEmitter}
        queueMicrotask(() => {
            onSpawn?.(p.stdinData)
            for (const evt of r.events) {
                streams.stdout.emit('data', Buffer.from(JSON.stringify(evt) + '\n'))
            }
            if (r.stderr) streams.stderr.emit('data', Buffer.from(r.stderr))
            // Deliberately no `close` — the child is now hung.
        })
        return p
    }) as unknown as SpawnFn
}

/** Convenience: build a json-events response that delivers final assistant text via agent_end. */
export function agentEndResponse(text: string, exitCode = 0): SpawnResponseJsonEvents {
    return {
        events: [
            {
                type: 'agent_end',
                messages: [
                    {
                        role: 'assistant',
                        content: [{type: 'text', text}]
                    }
                ]
            }
        ],
        exitCode
    }
}

/**
 * Convenience: a model-failure agent_end — stopReason "error", the cause in
 * errorMessage, and empty text content. That is the shape pi-agent-core's
 * `handleRunFailure` builds: an assistant message with content
 * [{type: 'text', text: ''}] and stopReason "error", pushed through message_start,
 * message_end, turn_end and agent_end. exitCode defaults to 0, so the failure
 * rides in the events rather than in the exit status.
 */
export function agentErrorResponse(errorMessage: string, exitCode = 0): SpawnResponseJsonEvents {
    return {
        events: [
            {
                type: 'agent_end',
                messages: [
                    {
                        role: 'assistant',
                        content: [{type: 'text', text: ''}],
                        stopReason: 'error',
                        errorMessage
                    }
                ]
            }
        ],
        exitCode
    }
}
