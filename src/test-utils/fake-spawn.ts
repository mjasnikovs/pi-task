/**
 * Shared spawn fakes for tests.
 *
 * Three factories:
 *   - fakeSpawnSimple(stdout, exitCode?, stderr?) — for one-shot worker tests
 *   - fakeSpawnQueue(responses) — yields each response in order across calls
 *   - fakeSpawnByPrompt(match) — picks a response by inspecting the prompt arg
 *
 * The shape matches SpawnFn from src/shared/child-process.ts: a function
 * returning a ProcLike (EventEmitter with stdout/stderr/kill/killed).
 */

import {EventEmitter} from 'node:events'
import type {ProcLike, SpawnFn} from '../shared/child-process.js'

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
    // Capture whatever runChild writes to stdin (the prompt, since it no longer
    // rides on argv). Tests that need the prompt read `stdinData` after the run.
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
        // The prompt now arrives on stdin, which runChild writes synchronously
        // right after this returns — so defer response selection to a microtask
        // and append the captured prompt as the final args element. Matchers that
        // read args[args.length - 1] keep working whether the prompt came via
        // argv (old) or stdin (new); arg-only spawns (git) get nothing appended.
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
 * Convenience: a model-failure agent_end — stopReason "error" with the real
 * cause in errorMessage and empty text content, exactly as pi emits when the
 * provider/local model dies after its own retries (see agent.js handleRunFailure).
 * Note exitCode defaults to 0: pi exits cleanly even on a model error.
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
