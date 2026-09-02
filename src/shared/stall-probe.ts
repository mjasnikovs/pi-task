/**
 * Dead-backend stall probe — the third child guard machine, beside the stream and
 * command watchdogs.
 *
 * The failure it serves: the model server dies mid-child and the child hangs
 * MUTE. pi's own connection handling runs from a catch, so a request that never
 * answers never reaches it. Silence alone is not evidence — prompt processing
 * legitimately emits nothing for minutes — so only "no output for `afterMs` AND
 * the endpoint does not answer a probe" counts as a dead backend.
 *
 * Liveness is OUTPUT PROGRESS: any chunk resets the window. A reachable probe
 * also resets it, so the next probe is a full window away rather than every
 * tick, and a probe that itself throws proves nothing and is treated as
 * reachable. The machine takes its clock and scheduler as deps for the same
 * reason the two watchdogs do: so it can be driven by a fake in a unit test
 * instead of only through a real spawn.
 */

import type {TimerHandle} from './command-watchdog.js'

export interface StallProbeDeps {
    /** Silence that triggers a probe, in ms. */
    afterMs: number
    /** true → the model endpoint answered; false → it did not. */
    probe: () => Promise<boolean>
    now: () => number
    schedule: (fn: () => void, ms: number) => TimerHandle
    cancel: (handle: TimerHandle) => void
    /** Fires ONCE, when the window elapsed and the probe found nobody home. */
    onDead: () => void
}

/**
 * Half the window, clamped. Never tighter than 50ms, never looser than 15s: a
 * probe is one network call, so it must not be re-issued every tick, and a
 * window of minutes must still be noticed within seconds of elapsing.
 */
export function stallPollIntervalMs(afterMs: number): number {
    return Math.max(50, Math.min(afterMs / 2, 15_000))
}

export class StallProbe {
    private timer: TimerHandle | undefined
    private lastActivity = 0
    private probing = false
    private dead = false

    constructor(private readonly deps: StallProbeDeps) {}

    start(): void {
        if (this.timer !== undefined) return
        this.lastActivity = this.deps.now()
        this.timer = this.deps.schedule(
            () => void this.check(),
            stallPollIntervalMs(this.deps.afterMs)
        )
    }

    /** Any output from the child: the window starts over. */
    note(): void {
        this.lastActivity = this.deps.now()
    }

    stop(): void {
        if (this.timer !== undefined) this.deps.cancel(this.timer)
        this.timer = undefined
    }

    /** @internal Exposed for the poll callback and tests. */
    async check(): Promise<void> {
        if (this.probing || this.dead) return
        if (this.deps.now() - this.lastActivity < this.deps.afterMs) return
        this.probing = true
        let reachable: boolean
        try {
            reachable = await this.deps.probe()
        } catch {
            reachable = true
        }
        this.probing = false
        if (reachable) {
            this.lastActivity = this.deps.now()
            return
        }
        this.dead = true
        this.stop()
        this.deps.onDead()
    }
}

/** Real-clock poll deps. REF'd for the reason stream-watchdog.ts records. */
export const realStallTimerDeps: Pick<StallProbeDeps, 'now' | 'schedule' | 'cancel'> = {
    now: () => Date.now(),
    schedule: (fn, ms) => setInterval(fn, ms),
    cancel: handle => clearInterval(handle as ReturnType<typeof setInterval>)
}
