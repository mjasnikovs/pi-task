/**
 * Running ONE bounded fix child and deciding what its ending MEANS.
 *
 * Two graduated-resolution passes drive a fix child through the same four rungs —
 * cancel propagates, a thrown child is an error, a self-declared BLOCKED ends the
 * attempt, anything else is DONE — and `final-gate-fix.ts:12` says so out loud:
 * it "mirrors the per-task graduated-resolution shape (lint-fix.ts)". This is that
 * ladder, once.
 *
 * NOT the rejected sharing. CONTEXT.md's "the two resolution loops stay two" is
 * about `runGatesForTask` vs `runFinalGateStage` — the LOOPS, at two altitudes.
 * This is one altitude down: the single child invocation inside each, where the
 * two had actually drifted.
 *
 *  - **The lint-fix marker was a DEAD protocol.** `buildLintFixPrompt` instructs
 *    the child to end with `LINT-FIX: DONE` or `LINT-FIX: BLOCKED <why>`, and the
 *    call site was `await deps.runChild(...)` with the return value DISCARDED —
 *    nothing in `src/` or `scripts/` parsed it. The twin parsed its own marker and
 *    used it to skip the expensive gate re-run. So a lint-fix child that reported
 *    BLOCKED still paid the full guard stack plus a whole repo-health run (15–69s
 *    measured), and the user was told `did not converge: <health.reason>` instead
 *    of the child's own stated reason. The suite fed `'LINT-FIX: DONE'` as fake
 *    output, so it stayed green whether the marker was parsed or deleted.
 *  - **The cancel rung re-typed its constant.** `lint-fix.ts` compared against a
 *    literal `'__user_cancelled__'`; it was the only production site in `src/` not
 *    importing `USER_CANCELLED`.
 *
 * What stays per-site: the arbiter (a gate re-run vs a repo-health re-run), the
 * result shape, and the guard sets. Only the child call is shared.
 */

import {USER_CANCELLED} from './child-runner.js'

/** How one fix child ended. A CANCEL is not a member: it throws, so the caller's
 *  own `USER_CANCELLED` path runs unchanged. */
export type FixChildEnd =
    | {kind: 'done'; text: string; note?: string}
    | {kind: 'blocked'; text: string; note: string}
    | {kind: 'error'; msg: string}

export interface FixChildInput {
    runChild: (tools: string, prompt: string, signal?: AbortSignal) => Promise<string>
    tools: string
    prompt: string
    signal?: AbortSignal
    /** The marker word this pass's prompt instructs — `LINT-FIX`, `FINAL-GATE-FIX`. */
    marker: string
}

/**
 * Parse a fix child's final marker. Last match wins: the model reasons before
 * concluding, and bash output can echo the words. No marker → DONE, because the
 * pass's own arbiter re-runs either way; a missing marker only forfeits the
 * early-out on a self-declared BLOCKED.
 */
export function parseFixMarker(marker: string, text: string): {blocked: boolean; note?: string} {
    const re = new RegExp(`${marker}:\\s*(DONE|BLOCKED)\\b[ \\t]*(.*)`, 'gi')
    let last: RegExpExecArray | null = null
    for (let m = re.exec(text); m !== null; m = re.exec(text)) last = m
    if (!last) return {blocked: false}
    if (last[1].toUpperCase() === 'BLOCKED') {
        return {blocked: true, note: last[2].trim() || 'no reason given'}
    }
    return {blocked: false, note: last[2].trim() || undefined}
}

/** Run one fix child through the four-rung ladder. Cancel THROWS; nothing else does. */
export async function runFixChild(input: FixChildInput): Promise<FixChildEnd> {
    let text: string
    try {
        text = await input.runChild(input.tools, input.prompt, input.signal)
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg === USER_CANCELLED) throw err
        return {kind: 'error', msg}
    }
    const parsed = parseFixMarker(input.marker, text)
    if (parsed.blocked) return {kind: 'blocked', text, note: parsed.note ?? 'no reason given'}
    return parsed.note ? {kind: 'done', text, note: parsed.note} : {kind: 'done', text}
}
