import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import {
    LoopDetector,
    loopKey,
    LOOP_THRESHOLD,
    LOOP_WINDOW,
    MAX_LOOP_RESTARTS
} from './loop-detector.js'

/**
 * Runaway guard for the IMPLEMENTATION TURN — the one model surface with none.
 *
 * MEASURED: one turn ran 5h16m and 6,760 tool calls, alternating two
 * byte-identical bash commands 3,300 times each with its output frozen and zero
 * edits. The command watchdog is per call (each took ~2.5s), the stream was never
 * silent, and MAX_COMPACTION_RESUMES counts only compactions that PARK at idle,
 * while all 18 of these were inside the turn. The two detectors are built only in
 * the CHILD spawn paths, and this turn runs in the user's own session.
 *
 * IT BLOCKS RATHER THAN KILLS because there is no re-spawn here — the argument
 * single-read-extension.ts already makes: "detect-and-kill only re-spawns a model
 * that deterministically re-thrashes". pi's ctx.abort() would also empty the
 * queued-message list into the user's editor. That also raises the bar on false
 * positives: a `gate` child killed by mistake costs one attempt of three, this
 * costs the user their turn.
 *
 * WHY PROGRESS IS READ OFF THE CALL, NOT THE RESULT. The gate profile pairs its
 * LoopDetector with a StallDetector, which judges results. That cannot work here:
 * pi's edit tool returns the constant `Successfully replaced N block(s) in <path>.`
 * and puts the diff in `details`, not `content`, so every real edit to one file is
 * byte-identical result text and scores as dead ground. An edit's ARGUMENTS carry
 * the progress its result throws away, so an edit is what resets the window.
 *
 * Known blind spots, all deliberate: a bash-driven mutation (`sed -i`, `>`,
 * `git apply`) does not reset; one varying `write` per iteration buys unlimited
 * immunity; a repeat cycle of LOOP_WINDOW/LOOP_THRESHOLD or longer never fills the
 * window; polling a booting server with an identical curl trips at five; and
 * schema-invalid calls never reach this hook at all, since pi validates first.
 */

/** Tool names that mutate the tree. pi ships exactly seven core tools, and
 *  pi-task's own four (pi-worker, -search, -fetch, -docs) are all read-only. */
const MUTATING_TOOLS = new Set(['edit', 'write'])

interface ArmedState {
    /** Every non-mutating call. Reset by a mutating one — see the module header. */
    loop: LoopDetector
    /** Mutating calls ONLY, and never reset inside a turn, so a byte-identical
     *  edit cannot hide behind the reset it would otherwise trigger. */
    edits: LoopDetector
    /** Blocks served per call identity. Per-key, so two unrelated loops cannot
     *  sum into a termination neither of them earned. */
    strikes: Map<string, number>
    terminating: boolean
    oneShot: boolean
}

/**
 * Path-revisit is OFF for both detectors (that is the Infinity). MEASURED: at the
 * default threshold, six DISTINCT edits to one file trip the path rule, because
 * an edit names a `file_path` and no `limit`, so the first one sets the
 * high-water mark and every later one scores as already-covered ground. Six edits
 * to one file is the most ordinary thing an implementation turn does. mx5
 * TASK_0002 is the same lesson from the other side: the rule killed an enforce
 * child that was editing one file as its job.
 */
function freshDetector(): LoopDetector {
    return new LoopDetector(LOOP_WINDOW, LOOP_THRESHOLD, Number.POSITIVE_INFINITY)
}

/** The armed turn's state, or null outside one. One slot: one task runs at a time. */
let armed: ArmedState | null = null

/** Built, never spread from the previous state: a leaked `terminating` would
 *  block every call for the rest of an awaited run. */
function freshArmedState(oneShot: boolean): ArmedState {
    return {
        loop: freshDetector(),
        edits: freshDetector(),
        strikes: new Map(),
        terminating: false,
        oneShot
    }
}

/** `oneShot` mirrors the impl widget's split: fire-and-forget lets the settle
 *  event disarm; an awaited run spans resume/steer turns and disarms in its finally. */
export function armImplementationGuard(opts: {oneShot: boolean}): void {
    armed = freshArmedState(opts.oneShot)
}

export function disarmImplementationGuard(): void {
    armed = null
}

/** @internal Test seam: is a turn currently guarded? */
export function implementationGuardArmed(): boolean {
    return armed !== null
}

/**
 * Present tense, unlike `formatLoopHint`, which addresses a re-spawned child
 * about an attempt that does not exist here.
 *
 * It claims nothing about the call's RESULT, which this hook fires too early to
 * see, and it does not offer "change the call" — that is an escape, not advice:
 * one altered byte is a new key and a clean slate on both counters.
 */
export function blockedCallReason(toolName: string, count: number): string {
    return (
        `Blocked: this is the ${count}th identical ${toolName} call in this turn. `
        + `Use what you already have, or do something different, then continue the task.`
    )
}

/** The reason on the final block, which also ends the turn. */
export function terminalCallReason(): string {
    return (
        `Blocked: this turn repeated one call past every warning, so it is being stopped `
        + `here. Nothing further will run.`
    )
}

/**
 * Inert until armed. Registering ANY `tool_call` handler switches on pi's
 * `beforeToolCall` for every call in the session, so the armed check comes first.
 */
export function registerImplementationGuards(pi: ExtensionAPI): void {
    pi.on('tool_call', event => {
        const state = armed
        if (!state) return
        try {
            // Every call, whatever it is: pi terminates only when EVERY finalized
            // result in the batch carries the flag (agent-loop.js
            // shouldTerminateToolBatch). The batch that trips it has already
            // finalized its earlier calls without it and so survives; the next one
            // ends. One batch, and it is the only bound this path has.
            if (state.terminating) {
                return {block: true, terminate: true, reason: terminalCallReason()}
            }
            const call = {name: event.toolName, args: event.input}
            const mutating = MUTATING_TOOLS.has(event.toolName)
            const hit = mutating ? state.edits.record(call) : state.loop.record(call)
            if (!hit) {
                if (mutating) state.loop = freshDetector()
                return
            }
            const key = loopKey(call)
            const strikes = (state.strikes.get(key) ?? 0) + 1
            state.strikes.set(key, strikes)
            // Blocking alone does not stop a determined model: nothing prevents the
            // next identical call.
            if (strikes > MAX_LOOP_RESTARTS) {
                state.terminating = true
                return {block: true, terminate: true, reason: terminalCallReason()}
            }
            return {block: true, reason: blockedCallReason(event.toolName, hit.count)}
        } catch {
            // pi does not guard this hook, and a throw here would block a
            // legitimate call. A broken guard must cost nothing.
            return
        }
    })

    // NOT `agent_end`, which fires again for every auto-retry, every threshold
    // compaction and every queued message — pi drives those with `agent.continue()`,
    // each a fresh agent loop. The measured runaway compacted 18 times INSIDE its
    // turn, so a one-shot disarm on agent_end would have retired the guard after the
    // first ~375 of its 6,760 calls. `agent_settled` is the boundary that means what
    // this needs: no retry, compaction or queued continuation left to run.
    pi.on('agent_settled', () => {
        if (!armed) return
        if (armed.oneShot) disarmImplementationGuard()
        // An awaited run spans resume and steer turns. Counters are per TURN, so a
        // fresh one starts clean rather than inheriting the last one's strikes.
        else armed = freshArmedState(false)
    })
    pi.on('session_shutdown', disarmImplementationGuard)
}
