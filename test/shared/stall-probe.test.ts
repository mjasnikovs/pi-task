/**
 * The dead-backend probe as a machine, driven by a fake clock — the unit the
 * inline `setInterval` in runChild never had. runChild's own tests still cover
 * the wiring (test/shared/child-process.test.ts, "stall guard").
 */
import {describe, expect, test} from 'bun:test'
import {StallProbe, stallPollIntervalMs} from '../../src/shared/stall-probe.js'

function harness(opts: {afterMs: number; probe: () => Promise<boolean>}) {
    let now = 1_000
    let tick: (() => void) | undefined
    let cancelled = 0
    let dead = 0
    const machine = new StallProbe({
        ...opts,
        now: () => now,
        schedule: fn => {
            tick = fn
            return 'h'
        },
        cancel: () => {
            cancelled++
        },
        onDead: () => {
            dead++
        }
    })
    // Let the async probe settle after a tick.
    const poll = async (): Promise<void> => {
        tick?.()
        await new Promise(r => setTimeout(r, 0))
    }
    return {
        machine,
        poll,
        advance: (ms: number) => {
            now += ms
        },
        dead: () => dead,
        cancelled: () => cancelled
    }
}

describe('StallProbe', () => {
    test('silence past the window with an unreachable endpoint fires onDead once and stops', async () => {
        let probes = 0
        const h = harness({
            afterMs: 100,
            probe: () => {
                probes++
                return Promise.resolve(false)
            }
        })
        h.machine.start()
        h.advance(99)
        await h.poll()
        expect(probes).toBe(0)
        h.advance(1)
        await h.poll()
        expect(probes).toBe(1)
        expect(h.dead()).toBe(1)
        expect(h.cancelled()).toBe(1)
        // Dead is terminal: another poll neither probes nor fires again.
        h.advance(1_000)
        await h.poll()
        expect(probes).toBe(1)
        expect(h.dead()).toBe(1)
    })

    test('a reachable endpoint resets the window, so the next probe is a full window away', async () => {
        let probes = 0
        const h = harness({
            afterMs: 100,
            probe: () => {
                probes++
                return Promise.resolve(true)
            }
        })
        h.machine.start()
        h.advance(100)
        await h.poll()
        expect(probes).toBe(1)
        h.advance(50)
        await h.poll()
        expect(probes).toBe(1)
        h.advance(50)
        await h.poll()
        expect(probes).toBe(2)
        expect(h.dead()).toBe(0)
    })

    test('output resets the window and a chatty child is never probed', async () => {
        let probes = 0
        const h = harness({
            afterMs: 100,
            probe: () => {
                probes++
                return Promise.resolve(false)
            }
        })
        h.machine.start()
        for (let i = 0; i < 5; i++) {
            h.advance(60)
            h.machine.note()
            await h.poll()
        }
        expect(probes).toBe(0)
    })

    test('a probe that throws proves nothing — treated as reachable', async () => {
        const h = harness({afterMs: 100, probe: () => Promise.reject(new Error('probe broke'))})
        h.machine.start()
        h.advance(100)
        await h.poll()
        expect(h.dead()).toBe(0)
        // And the window was reset by the failed probe, as by a reachable one.
        h.advance(50)
        await h.poll()
        expect(h.dead()).toBe(0)
    })

    test('a probe in flight is not re-issued by the next tick', async () => {
        let probes = 0
        let settle: ((v: boolean) => void) | undefined
        const h = harness({
            afterMs: 100,
            probe: () => {
                probes++
                return new Promise(r => {
                    settle = r
                })
            }
        })
        h.machine.start()
        h.advance(100)
        h.machine.check().catch(() => {})
        h.machine.check().catch(() => {})
        expect(probes).toBe(1)
        settle!(true)
        await new Promise(r => setTimeout(r, 0))
        expect(h.dead()).toBe(0)
    })

    test('stop cancels the poll; start is idempotent', () => {
        const h = harness({afterMs: 100, probe: () => Promise.resolve(true)})
        h.machine.start()
        h.machine.start()
        h.machine.stop()
        h.machine.stop()
        expect(h.cancelled()).toBe(1)
    })
})

describe('stallPollIntervalMs', () => {
    test('half the window, never under 50ms, never over 15s', () => {
        expect(stallPollIntervalMs(20)).toBe(50)
        expect(stallPollIntervalMs(1_000)).toBe(500)
        expect(stallPollIntervalMs(180_000)).toBe(15_000)
    })
})
