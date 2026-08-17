/**
 * Progress-based runaway guard for phase children — the replacement for a
 * wall-clock cap.
 *
 * WHY NOT SECONDS. PHASE_CHILD_TIMEOUT_MS was sized against "measured HEALTHY
 * planning children" on one local backend: decompose 89s, so 600s looked like a
 * 6x margin. That sizing is not a property of the pathology, it is a property of
 * that day's model, that day's samplers and that day's design doc. Measured on
 * the same 27B backend with reasoning ON (2026-08-17, n=10 replays of one
 * captured auto-decompose request, everything else byte-identical): every single
 * healthy run took 610-927s and produced 26-42 correct titles. The cap would
 * have killed 10 out of 10 GOOD runs. A slower model, a bigger design doc or a
 * longer reasoning budget moves that number again — so any constant in seconds
 * is wrong for someone.
 *
 * WHAT REPLACES IT. Two bounds, both dimensionless — invariant to model speed,
 * project size and reasoning budget:
 *
 *   1. NO NEW GROUND. Count CONSECUTIVE tool calls whose RESULT taught the child
 *      nothing: an error, or bytes it has already been given. A child paging
 *      forward through a 25 KB design file gets different bytes every call and
 *      never trips, however slow it is. A child re-opening the same four files
 *      trips after NO_PROGRESS_LIMIT of them, however fast it is.
 *
 *      Judged on the RESULT, not the arguments, because the arguments lie. The
 *      thrash measured on 2026-08-17 was 197 of 200 calls REFUSED by the
 *      single-read guard, each at a different rising offset — so by arguments it
 *      looked like textbook forward paging, and both an offset rule and the loop
 *      detector's path rule waved all 200 through. By result it is 197 identical
 *      refusals in a row, which is what it actually was.
 *
 *   2. CONTEXT CHURN. Sum the bytes of tool RESULTS the child has pulled in. Once
 *      that exceeds CONTEXT_CHURN_FACTOR times its own context window and it
 *      still has not answered, it has necessarily forgotten what it read first
 *      and is re-reading to fill a window pi keeps compacting. That is the
 *      mx5-n 2026-08-14 shape: 16m23s at 117,370 of a 120,064-token window,
 *      ~56k tokens of tool output per minute, forward-paging the whole time so
 *      rule 1 alone would not have caught it. The bound scales with the model's
 *      OWN window, so a 1M-context model gets a 1M-context allowance.
 *
 * Neither rule can fire on a child that is thinking rather than calling tools:
 * that case is bounded by the model's max tokens (server-enforced) and by the
 * stream watchdog if the stream goes silent. Between the three there is no
 * runaway left that needs a clock.
 *
 * Pure logic, no I/O, no timers. LoopDetector (loop-detector.ts) is the
 * short-window sibling that trips FAST on an exact repeat; this is the
 * whole-run backstop that trips on sustained non-progress.
 */

import {stableStringify} from './loop-detector.js'
import type {LoopHit, ToolCall} from '../shared/child-process.js'

/**
 * Consecutive no-new-ground tool results before the child is killed.
 *
 * Eight, because the honest reasons to get back something you have already seen
 * are few and bounded: re-checking a file after an edit, a grep that lands in a
 * file already read, a retry after a malformed call, a missing path. A child
 * doing real work interleaves those with progress and resets the counter. In the
 * replayed thrash the counter never resets at all — the observed runs made
 * 188-201 consecutive dead calls. The gap between "a handful" and "two hundred"
 * is wide enough that the exact value is not load-bearing.
 */
export const NO_PROGRESS_LIMIT = 8

/**
 * Multiples of the child's OWN context window of tool output it may pull before
 * being called stuck. Two, so a child is allowed to fill its window once and
 * still have a whole window of budget left for legitimate re-reading after pi
 * compacts. Past that it is provably re-reading what it can no longer hold.
 */
export const CONTEXT_CHURN_FACTOR = 2

/** Chars per token. Rough on purpose — the bound is a factor of 2, not a budget. */
const CHARS_PER_TOKEN = 4

/** Which rule tripped, so the caller can hint at the right mistake. */
export type StallKind = 'no-new-ground' | 'context-churn'

export class StallDetector {
    /** Every distinct result the child has been handed, for the WHOLE run. */
    private readonly seenResults = new Set<string>()
    /** Exact (name, args) keys already issued — the fallback signal for a
     *  transport that reports calls but not results. */
    private readonly seenCalls = new Set<string>()
    private deadStreak = 0
    private resultChars = 0
    private contextWindow = 0

    constructor(
        private readonly limit: number = NO_PROGRESS_LIMIT,
        private readonly churnFactor: number = CONTEXT_CHURN_FACTOR
    ) {}

    /**
     * Record a tool call. Returns a LoopHit (tagged with `stall`) when either
     * rule has tripped, so it rides the kill/restart path the loop detector
     * already has, else null.
     *
     * The verdict is read here but EARNED in noteResult: this is the hook the
     * child runner can kill from, and a result only arrives after its call has
     * been let through.
     */
    record(call: ToolCall): LoopHit | null {
        if (this.churnTripped()) {
            return {
                call,
                count: Math.round(this.resultChars / CHARS_PER_TOKEN),
                windowSize: this.contextWindow,
                stall: 'context-churn'
            }
        }
        const key = `${call.name}\x00${stableStringify(call.args)}`
        // A verbatim repeat is dead ground whatever its result turns out to be,
        // and this is the only signal available if results are not reported.
        if (this.seenCalls.has(key)) this.deadStreak++
        this.seenCalls.add(key)
        if (this.deadStreak >= this.limit) {
            return {call, count: this.deadStreak, windowSize: 0, stall: 'no-new-ground'}
        }
        return null
    }

    /**
     * A tool call finished. Its result is what actually entered the context, so
     * it — not the arguments — decides whether the child learned anything. An
     * error, or bytes already handed over earlier in this run, is dead ground.
     */
    noteResult(text: string, isError = false): void {
        this.resultChars += text.length
        if (isError || this.seenResults.has(text)) {
            this.deadStreak++
            return
        }
        this.seenResults.add(text)
        this.deadStreak = 0
    }

    /** Latest context-window size reported by the child. 0 until one arrives. */
    noteContext(contextWindow: number): void {
        if (contextWindow > 0) this.contextWindow = contextWindow
    }

    private churnTripped(): boolean {
        if (this.contextWindow <= 0) return false
        return this.resultChars / CHARS_PER_TOKEN > this.contextWindow * this.churnFactor
    }
}

/**
 * Restart hint for a child killed by the stall detector. Names the specific
 * mistake — re-reading covered ground vs pulling in more than it can hold —
 * because "you ran out of time" (the old wall-clock hint) told a model that was
 * working correctly but slowly to truncate its work for no reason.
 */
export function formatStallHint(kind: StallKind): string {
    if (kind === 'context-churn') {
        return (
            '[SYSTEM NOTE: Your previous attempt pulled in more file content than '
            + 'its context window can hold, so the earliest material was dropped and '
            + 'you began re-reading it. Do not re-open files. Read only what you have '
            + 'not read yet, and write your answer from what you have.]'
        )
    }
    return (
        '[SYSTEM NOTE: Your previous attempt made a run of tool calls that returned '
        + 'nothing you had not already seen — you were re-opening files you had '
        + 'already read. Read each region of a file AT MOST ONCE, and when a file is '
        + 'too large to read whole, page FORWARD through it rather than re-opening '
        + 'the start. Write your answer from what you have gathered.]'
    )
}
