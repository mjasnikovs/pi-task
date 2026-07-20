import {describe, expect, test} from 'bun:test'
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import {registerStreamWatchdog} from './stream-watchdog.js'
import {consumeWatchdogAbort, WATCHDOG_CANCEL_MARKER} from './command-watchdog.js'
import {getConfig} from '../config/config.js'

/**
 * Minimal ExtensionAPI stand-in: records handler registrations so a test can
 * replay the event sequence a hung turn produces, and captures the follow-up
 * message the watchdog posts.
 */
function fakePi() {
    const handlers = new Map<string, (e: unknown, ctx: unknown) => void>()
    const messages: string[] = []
    let aborts = 0
    const ctx = {abort: () => aborts++}
    const pi = {
        on: (name: string, fn: (e: unknown, ctx: unknown) => void) => handlers.set(name, fn),
        sendUserMessage: (text: string) => messages.push(text)
    } as unknown as ExtensionAPI
    return {
        pi,
        emit: (name: string) => handlers.get(name)?.({}, ctx),
        has: (name: string) => handlers.has(name),
        messages,
        aborts: () => aborts
    }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** Run `fn` with a millisecond-scale window instead of the 10-minute production one. */
async function withWindow(ms: number, fn: () => Promise<void>): Promise<void> {
    const cfg = getConfig()
    const prev = cfg.streamInactivityMs
    cfg.streamInactivityMs = ms
    try {
        await fn()
    } finally {
        cfg.streamInactivityMs = prev
        consumeWatchdogAbort() // never leak the one-shot flag into another test
    }
}

describe('registerStreamWatchdog', () => {
    // The exact run-14 shape: a turn streams normally, then the stream dies with
    // no error, no exit, and no further events of any kind.
    test('aborts the turn and posts a resume reminder when the stream dies mid-turn', async () => {
        await withWindow(80, async () => {
            const f = fakePi()
            registerStreamWatchdog(f.pi)
            f.emit('turn_start')
            f.emit('message_start')
            f.emit('message_update')
            // …then silence.
            await sleep(400)
            expect(f.aborts()).toBe(1)
            expect(f.messages.length).toBe(1)
            // Same abort channel as the command watchdog — steerUntilDone reads
            // BOTH the flag and this marker to tell a watchdog abort from an ESC.
            expect(consumeWatchdogAbort()).toBe(true)
            expect(f.messages[0]).toContain(WATCHDOG_CANCEL_MARKER)
            f.emit('agent_end')
        })
    })

    test('a streaming turn is never touched', async () => {
        await withWindow(80, async () => {
            const f = fakePi()
            registerStreamWatchdog(f.pi)
            f.emit('turn_start')
            for (let i = 0; i < 12; i++) {
                await sleep(40)
                f.emit('message_update')
            }
            expect(f.aborts()).toBe(0)
            expect(f.messages).toEqual([])
            f.emit('agent_end')
        })
    })

    // The command watchdog owns tool time; double-firing here would abort every
    // build that outruns the stream window.
    test('a long tool execution does not trip the stream watchdog', async () => {
        await withWindow(80, async () => {
            const f = fakePi()
            registerStreamWatchdog(f.pi)
            f.emit('turn_start')
            f.emit('tool_execution_start')
            await sleep(400)
            expect(f.aborts()).toBe(0)
            f.emit('tool_execution_end')
            f.emit('agent_end')
        })
    })

    test('nothing fires once the agent loop has ended', async () => {
        await withWindow(80, async () => {
            const f = fakePi()
            registerStreamWatchdog(f.pi)
            f.emit('turn_start')
            f.emit('agent_end')
            await sleep(300)
            expect(f.aborts()).toBe(0)
            expect(f.messages).toEqual([])
        })
    })

    test('off (0) never arms', async () => {
        await withWindow(0, async () => {
            const f = fakePi()
            registerStreamWatchdog(f.pi)
            f.emit('turn_start')
            f.emit('message_update')
            await sleep(300)
            expect(f.aborts()).toBe(0)
            expect(f.messages).toEqual([])
        })
    })

    test('subscribes to every stream-bearing event, so no live turn looks idle', () => {
        const f = fakePi()
        registerStreamWatchdog(f.pi)
        for (const name of [
            'before_provider_request',
            'after_provider_response',
            'turn_start',
            'message_start',
            'message_update',
            'message_end',
            'tool_execution_start',
            'tool_execution_end',
            'agent_end',
            'session_shutdown'
        ]) {
            expect(f.has(name)).toBe(true)
        }
    })
})
