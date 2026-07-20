import {describe, expect, test} from 'bun:test'
import {
    DEFAULT_STREAM_INACTIVITY_MS,
    pollIntervalMs,
    StreamWatchdog,
    streamStallCause,
    streamStallHint,
    streamStallReminder,
    type TimerHandle
} from './stream-watchdog.js'
import {isConnectionError} from '../task/child-runner.js'
import {WATCHDOG_CANCEL_MARKER} from './command-watchdog.js'

/** Fake clock + scheduler: the test drives time explicitly, so a 10-minute
 *  window is exercised without waiting 10 minutes. */
function harness(timeoutMs: number) {
    let now = 1_000
    const fires: number[] = []
    let tick: (() => void) | undefined
    const wd = new StreamWatchdog({
        getTimeoutMs: () => timeoutMs,
        now: () => now,
        schedule: (fn): TimerHandle => {
            tick = fn
            return 'timer'
        },
        cancel: () => {
            tick = undefined
        },
        onFire: idleMs => fires.push(idleMs)
    })
    return {
        wd,
        fires,
        advance: (ms: number) => {
            now += ms
            tick?.()
        },
        armed: () => tick !== undefined
    }
}

describe('StreamWatchdog', () => {
    test('fires when the stream is silent for the whole window', () => {
        const h = harness(600_000)
        h.wd.start()
        h.advance(599_000)
        expect(h.fires).toEqual([])
        h.advance(2_000)
        expect(h.fires).toEqual([601_000])
    })

    // The core distinction the run-14 audit demanded: a local model dribbling one
    // token every 30s is HEALTHY. Only total silence is a hang.
    test('a slow but steady stream never fires', () => {
        const h = harness(600_000)
        h.wd.start()
        for (let i = 0; i < 100; i++) {
            h.advance(30_000)
            h.wd.note()
        }
        expect(h.fires).toEqual([])
    })

    // A long build emits nothing on the model stream; that silence belongs to the
    // command watchdog, so this one must stand down or the two double-fire.
    test('stays quiet while a tool executes, and rearms after it ends', () => {
        const h = harness(600_000)
        h.wd.start()
        h.wd.suspend()
        h.advance(3_600_000)
        expect(h.fires).toEqual([])
        h.wd.resume()
        h.advance(300_000)
        expect(h.fires).toEqual([])
        h.advance(301_000)
        expect(h.fires.length).toBe(1)
    })

    test('fires at most once per arming, and stops when told', () => {
        const h = harness(1_000)
        h.wd.start()
        h.advance(2_000)
        h.advance(2_000)
        expect(h.fires.length).toBe(1)
        expect(h.armed()).toBe(false)
    })

    test('a zero/negative ceiling means off — it never arms', () => {
        const h = harness(0)
        h.wd.start()
        h.advance(10_000_000)
        expect(h.fires).toEqual([])
        expect(h.armed()).toBe(false)
    })

    test('a second start while armed counts as activity, not a restart', () => {
        const h = harness(600_000)
        h.wd.start()
        h.advance(500_000)
        h.wd.start()
        h.advance(500_000)
        expect(h.fires).toEqual([])
    })

    // pi runs a tool BATCH in parallel: every start is emitted up front and each
    // call ends on its own. The clock must stay paused until the LAST one settles.
    test('a keyed batch stays suspended until the last tool ends', () => {
        const h = harness(600_000)
        h.wd.start()
        h.wd.suspend('slow')
        h.wd.suspend('fast')
        h.wd.resume('fast')
        h.advance(3_600_000)
        expect(h.fires).toEqual([])
        h.wd.resume('slow')
        h.advance(601_000)
        expect(h.fires.length).toBe(1)
    })

    // An end whose start was never seen (the watchdog armed mid-batch) must not
    // clear a sibling that IS being tracked.
    test('an unmatched end does not un-pause a tracked tool', () => {
        const h = harness(600_000)
        h.wd.start()
        h.wd.suspend('real')
        h.wd.resume('never-started')
        h.advance(3_600_000)
        expect(h.fires).toEqual([])
    })

    test('unkeyed suspend/resume still nests', () => {
        const h = harness(600_000)
        h.wd.start()
        h.wd.suspend()
        h.wd.suspend()
        h.wd.resume()
        h.advance(3_600_000)
        expect(h.fires).toEqual([])
        h.wd.resume()
        h.advance(601_000)
        expect(h.fires.length).toBe(1)
    })

    test('stop() after a suspend leaves nothing armed', () => {
        const h = harness(1_000)
        h.wd.start()
        h.wd.suspend()
        h.wd.stop()
        h.advance(10_000)
        expect(h.fires).toEqual([])
    })
})

describe('pollIntervalMs', () => {
    test('is a fraction of the window, clamped to a sane band', () => {
        expect(pollIntervalMs(600_000)).toBe(30_000)
        expect(pollIntervalMs(60_000)).toBe(15_000)
        expect(pollIntervalMs(100)).toBe(50)
    })
})

describe('messages', () => {
    // The whole child-side design rests on this: a stream stall must look like a
    // connection failure to the retry path that already exists, or it silently
    // falls through to fail-fast instead of retrying.
    test('streamStallCause is recognised by the connection-error retry', () => {
        expect(isConnectionError(streamStallCause(600_000))).toBe(true)
    })

    // Same abort channel as the command watchdog: steerUntilDone recognises a
    // watchdog recovery by this marker, and a missing marker wedges an
    // unattended run on the abort/steer race (b543d15).
    test('the main-session reminder carries the shared watchdog marker', () => {
        const msg = streamStallReminder(600_000, WATCHDOG_CANCEL_MARKER)
        expect(msg).toContain(WATCHDOG_CANCEL_MARKER)
        expect(msg).toContain('10 minutes')
    })

    // Idempotent resume: the dead turn's tool calls are already in the transcript.
    test('the reminder tells the model to continue, not to redo completed work', () => {
        const msg = streamStallReminder(600_000, WATCHDOG_CANCEL_MARKER)
        expect(msg).toMatch(/must NOT be repeated/)
        expect(msg).toMatch(/Continue from that recorded state/)
    })

    // A hung stream is not the model's fault; blaming it teaches truncation.
    test('the child hint states the infrastructure cause and warns edits persist', () => {
        const hint = streamStallHint(600_000)
        expect(hint).toMatch(/not a mistake/)
        expect(hint).toMatch(/still in the working tree/)
    })

    test('the default window is generous enough for local prompt processing', () => {
        expect(DEFAULT_STREAM_INACTIVITY_MS).toBe(600_000)
    })
})
