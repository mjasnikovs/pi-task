import {describe, expect, test} from 'bun:test'
import {CommandWatchdog, reminderMessage, type WatchdogDeps} from './command-watchdog.js'
import {realTimerDeps} from '../shared/command-watchdog.js'

/**
 * A synchronous fake scheduler: records armed timers and lets the test fire one
 * by id, so the state machine is exercised without real time passing.
 */
function makeHarness(timeoutMs: number, shouldWatch?: (toolName: string) => boolean) {
    let nextId = 0
    const timers = new Map<number, () => void>()
    const fired: {toolCallId: string; toolName: string; timeoutMs: number}[] = []
    let currentTimeout = timeoutMs

    const deps: WatchdogDeps = {
        getTimeoutMs: () => currentTimeout,
        shouldWatch,
        schedule: fn => {
            const id = nextId++
            timers.set(id, fn)
            return id
        },
        cancel: handle => {
            timers.delete(handle as number)
        },
        onFire: (toolCallId, toolName, ms) => fired.push({toolCallId, toolName, timeoutMs: ms})
    }

    return {
        watchdog: new CommandWatchdog(deps),
        fired,
        /** Fire the timer with the given handle id, as the real clock would. */
        elapse: (handle: number) => timers.get(handle)?.(),
        armedCount: () => timers.size,
        setTimeout: (ms: number) => {
            currentTimeout = ms
        }
    }
}

describe('CommandWatchdog', () => {
    test('a command that overruns is fired with its tool name and the ceiling', () => {
        const h = makeHarness(900_000)
        h.watchdog.onStart('call-1', 'bash')
        expect(h.armedCount()).toBe(1)
        h.elapse(0)
        expect(h.fired).toEqual([{toolCallId: 'call-1', toolName: 'bash', timeoutMs: 900_000}])
    })

    test('a command that ends before the ceiling never fires', () => {
        const h = makeHarness(900_000)
        h.watchdog.onStart('call-1', 'bash')
        h.watchdog.onEnd('call-1')
        expect(h.armedCount()).toBe(0)
        // Firing a disarmed timer is a no-op (the fn was cancelled).
        h.elapse(0)
        expect(h.fired).toHaveLength(0)
    })

    test('off (0 / non-positive) never arms', () => {
        const h = makeHarness(0)
        h.watchdog.onStart('call-1', 'bash')
        expect(h.armedCount()).toBe(0)
        expect(h.fired).toHaveLength(0)
    })

    test('an explicitly exempt tool never arms while other tools remain guarded', () => {
        const h = makeHarness(900_000, toolName => toolName !== 'fable_loop')
        h.watchdog.onStart('call-1', 'fable_loop')
        expect(h.armedCount()).toBe(0)

        h.watchdog.onStart('call-2', 'bash')
        expect(h.armedCount()).toBe(1)
        h.elapse(0)
        expect(h.fired).toEqual([{toolCallId: 'call-2', toolName: 'bash', timeoutMs: 900_000}])
    })

    test('an exempt tool still running when a guarded sibling overruns is never itself fired', () => {
        // pi runs sibling tool calls CONCURRENTLY (extensions docs: "sibling
        // tool calls ... executed concurrently"), so the overlap is real, not
        // hypothetical. The machine's guarantee is narrow and worth pinning: the
        // exempt call is never the one reported. It is NOT spared the abort —
        // ctx.abort() ends the whole agent operation (see shared/
        // command-watchdog.ts) and there is no per-call cancellation channel.
        const h = makeHarness(900_000, toolName => toolName !== 'fable_loop')
        h.watchdog.onStart('call-1', 'fable_loop')
        h.watchdog.onStart('call-2', 'bash')
        h.elapse(0)
        expect(h.fired.map(f => f.toolName)).toEqual(['bash'])
    })

    test('re-guarding a tool mid-session takes effect on its next start', () => {
        let exempt = true
        const h = makeHarness(900_000, name => !(exempt && name === 'fable_loop'))
        h.watchdog.onStart('call-1', 'fable_loop')
        expect(h.armedCount()).toBe(0)
        exempt = false // the operator flips the /task-config row back on
        h.watchdog.onStart('call-2', 'fable_loop')
        expect(h.armedCount()).toBe(1)
    })

    test('the ceiling is read per start, so a config change takes effect next command', () => {
        const h = makeHarness(0)
        h.watchdog.onStart('call-1', 'bash') // off → no arm
        expect(h.armedCount()).toBe(0)
        h.setTimeout(300_000)
        h.watchdog.onStart('call-2', 'bash') // now armed
        expect(h.armedCount()).toBe(1)
    })

    test('a duplicate start for the same id does not leak the earlier timer', () => {
        const h = makeHarness(900_000)
        h.watchdog.onStart('call-1', 'bash')
        h.watchdog.onStart('call-1', 'bash')
        // Only the latest timer remains armed.
        expect(h.armedCount()).toBe(1)
    })

    test('an already-ended call that races the timer does not fire', () => {
        const h = makeHarness(900_000)
        h.watchdog.onStart('call-1', 'bash')
        // Simulate the end handler running, then a stale timer callback: elapse
        // after onEnd cancelled it — nothing should fire.
        h.watchdog.onEnd('call-1')
        h.elapse(0)
        expect(h.fired).toHaveLength(0)
    })

    test('clearAll cancels every armed timer', () => {
        const h = makeHarness(900_000)
        h.watchdog.onStart('call-1', 'bash')
        h.watchdog.onStart('call-2', 'grep')
        expect(h.armedCount()).toBe(2)
        h.watchdog.clearAll()
        expect(h.armedCount()).toBe(0)
        h.elapse(0)
        h.elapse(1)
        expect(h.fired).toHaveLength(0)
    })

    test('a second command is guarded after the first fires', () => {
        const h = makeHarness(600_000)
        h.watchdog.onStart('call-1', 'bash')
        h.elapse(0)
        expect(h.fired).toHaveLength(1)
        h.watchdog.onStart('call-2', 'bash')
        h.elapse(1)
        expect(h.fired).toHaveLength(2)
        expect(h.fired[1]!.toolCallId).toBe('call-2')
    })
})

describe('reminderMessage', () => {
    test('names the tool, the minutes, and the timeout fix', () => {
        const msg = reminderMessage('bash', 900_000)
        expect(msg).toContain('`bash`')
        expect(msg).toContain('15 minutes')
        expect(msg).toContain('timeout')
        expect(msg).toContain('cancelled')
    })

    test('tells the model the killed command produced no result (anti-fabrication)', () => {
        // A live run showed the model claim the killed server was "now running";
        // the reminder must explicitly deny any success/started-process claim.
        const msg = reminderMessage('bash', 300_000)
        expect(msg).toContain('produced NO result')
        expect(msg.toLowerCase()).toContain('do not claim')
    })

    test('singular minute has no trailing s', () => {
        expect(reminderMessage('bash', 60_000)).toContain('1 minute and')
    })

    test('sub-minute ceilings round up to at least 1 minute (never "0 minutes")', () => {
        expect(reminderMessage('bash', 30_000)).toContain('1 minute')
    })
})

describe('realTimerDeps', () => {
    // Same measured windows failure as the stream watchdog's poll: under Bun an
    // unref'd timer never fires once nothing ref'd is pending, and a child sitting
    // in a hung command IS that state — so an unref'd ceiling silently disabled the
    // guard on windows. Asserted on the handle, so it fails on any platform.
    test('schedules a REF’d timer — an unref’d one is dead on windows', () => {
        const h = realTimerDeps.schedule(() => {}, 60_000) as {hasRef?: () => boolean}
        try {
            expect(h.hasRef?.()).toBe(true)
        } finally {
            realTimerDeps.cancel(h as never)
        }
    })
})
