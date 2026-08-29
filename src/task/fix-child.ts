/**
 * Running ONE bounded fix child and deciding what its ending MEANS.
 *
 * Two graduated-resolution passes — `lint-fix.ts` and `final-gate-fix.ts` — drive
 * a fix child through the same four rungs: a cancel propagates as a throw, a
 * child that threw for any other reason is an `error`, a self-declared BLOCKED is
 * `blocked`, and anything else is `done`. `final-gate-fix.ts`'s own header says
 * it "mirrors the per-task graduated-resolution shape (lint-fix.ts)". This is
 * that ladder, written once.
 *
 * Both prompts instruct the marker their pass parses: `LINT-FIX: DONE` /
 * `LINT-FIX: BLOCKED <why>` and `FINAL-GATE-FIX: DONE` / `FINAL-GATE-FIX:
 * BLOCKED <why>`.
 *
 * What stays per-site: the arbiter, the result shape, and the guard sets. Only
 * the child call is shared. The arbiters differ in kind — `final-gate-fix` calls
 * `deps.gate`, `lint-fix` calls `deps.repoHealth` — and so does what BLOCKED
 * buys: `final-gate-fix` skips its gate re-run on a blocked child, while
 * `lint-fix` runs repo-health regardless and uses the marker only to word the
 * failure.
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
 * concluding, and both passes give the child `bash`, so its own command output is
 * in the text being scraped.
 *
 * No marker → DONE. Neither pass treats the marker as the verdict — the arbiter
 * decides — so a missing marker costs at most the blocked early-out in
 * `final-gate-fix`, and nothing at all in `lint-fix`.
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
