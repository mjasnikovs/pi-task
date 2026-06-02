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
}

export interface SpawnResponseJsonEvents {
    /**
     * One JSON event per entry. Each is JSON.stringified and emitted as a
     * stdout chunk followed by `\n`. After the last event a `close` is emitted.
     */
    events: ReadonlyArray<Record<string, unknown>>
    exitCode?: number
    stderr?: string
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
        emitter.emit('close', exitCode)
    })
}

export function makeProc(): EventEmitter & ProcLike {
    const emitter = new EventEmitter() as EventEmitter & ProcLike
    emitter.stdout = new EventEmitter()
    emitter.stderr = new EventEmitter()
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
        emitResponse(p as EventEmitter & {stdout: EventEmitter; stderr: EventEmitter}, match(args))
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
