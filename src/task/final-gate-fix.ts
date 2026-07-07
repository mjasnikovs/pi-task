/**
 * final-gate-fix — the bounded, model-driven fix pass offered when the FINAL
 * integration gate fails.
 *
 * The failure this closes (mx5 run 7, validated): the final gate's first live
 * firing was a TRUE POSITIVE — the project's own `test` command genuinely failed
 * whole-repo while every per-slice check was green — but the resolution picker
 * offered only "Leave failed" / "Accept". There was NO automated path to fix a
 * defect the run itself shipped; the user had to leave the run failed, fix by
 * hand, and resume.
 *
 * This mirrors the per-task graduated-resolution shape (lint-fix.ts): a bounded
 * write-enabled child (read, edit, bash) is seeded with the gate's exact failure
 * (command + exit code + output tail), fixes the defect in place, and the gate
 * itself is re-run as the only arbiter — the child's self-report is never
 * trusted. The user always chooses this path from the picker ("Leave failed"
 * stays the recommended default), and attempts are capped so a non-converging
 * loop hands control back to a person.
 *
 * CHEAT GUARD (deterministic): the cheapest way for a fix child to "converge" is
 * to remove the failing command itself — delete the `test` script, drop the
 * Makefile target — so the gate discovers nothing and vacuously passes. Both
 * live lint-fix validation runs cheated exactly this way (via git checkout)
 * until a guard existed. So the discovered gate commands are snapshotted before
 * the child runs; any previously-discovered command that is no longer
 * discoverable afterwards rejects the attempt and discards its edits. A fix may
 * change what a command DOES, never make it disappear.
 */
import {USER_CANCELLED} from './child-runner.js'

/** Same bounded-fix contract as lint-fix: edit in place, bash exists to RUN the
 *  failing command (and the project's own tooling), not to mutate git state. */
export const FINAL_FIX_TOOLS = 'read,edit,bash'

/**
 * How many fix passes the user may launch from the picker before the option is
 * withdrawn (mirrors the per-task MAX_AUTO_AUTOFIX budget). Each attempt is a
 * full model child plus a full gate re-run — after this many that still FAIL,
 * only Leave-failed / Accept remain so a person breaks the loop.
 */
export const MAX_FINAL_GATE_AUTOFIX = 3

/** Picker labels/values. Classification accepts the value token, the label, or
 *  free text (→ autofix guidance), same contract as the per-task resolution. */
export const FINAL_LEAVE_VALUE = 'fail'
export const FINAL_ACCEPT_VALUE = 'accept'
export const FINAL_AUTOFIX_VALUE = 'autofix'
export const FINAL_LEAVE_LABEL = 'Leave failed — I will fix and /task-auto-resume'
export const FINAL_ACCEPT_LABEL = 'Accept — complete the run anyway'
export const FINAL_AUTOFIX_LABEL = 'Autofix — run a bounded fix pass and re-run the gate'

export interface FinalGateChoice {
    /** What the user decided. 'leave' = leave the run failed (also the dismissal
     *  default — identical to the pre-autofix behavior). */
    action: 'leave' | 'accept' | 'autofix'
    /** Free-text guidance typed instead of picking a card; folded into the fix
     *  child's failure seed. Only set with 'autofix'. */
    guidance?: string
}

/**
 * Map a final-gate picker answer to an action. Dismissal (undefined/empty) and
 * an explicit leave stay "leave" — exactly what the two-option picker did.
 * Free text becomes autofix guidance, mirroring classifyResolutionAnswer; the
 * caller demotes autofix back to "leave" when the option was not offered.
 */
export function classifyFinalGateAnswer(answer: string | undefined): FinalGateChoice {
    if (answer === undefined) return {action: 'leave'}
    const t = answer.trim()
    if (t.length === 0) return {action: 'leave'}
    if (t === FINAL_LEAVE_VALUE || /^leave\b/i.test(t)) return {action: 'leave'}
    if (t === FINAL_ACCEPT_VALUE || /^accept\b/i.test(t)) return {action: 'accept'}
    if (t === FINAL_AUTOFIX_VALUE || /^autofix\b/i.test(t)) return {action: 'autofix'}
    return {action: 'autofix', guidance: t}
}

/**
 * The gate's fail reason always carries the failing command in backticks
 * (`` `bun run test` exited 1 — … `` / ``static checks: `make lint` exited 2``).
 * Extract it for reporting; the shrink guard itself compares the FULL
 * discovered-command sets, so a reason this cannot parse still guards.
 */
export function extractFailingCommand(reason: string): string | null {
    const m = /`([^`]+)`\s+exited\b/.exec(reason)
    return m ? m[1] : null
}

/**
 * Build the fix child's prompt. Generic by construction: the only project facts
 * in it are the gate's own failure text — the command comes from the project's
 * discovered manifest, never from a hardcoded ecosystem.
 */
export function buildFinalFixPrompt(failReason: string): string {
    return [
        'You are a bounded fix pass for a FAILED whole-repo integration gate.',
        'Every task in this run is complete and committed; then the project’s own',
        'integration command was run against the assembled repository and failed:',
        '',
        failReason.trim(),
        '',
        'Your ONLY job is to make that command pass by fixing the DEFECT it reveals.',
        '',
        '1. Re-run the exact failing command first and read its full output.',
        '2. Diagnose the root cause, then fix it with the smallest correct change.',
        '   The project’s own manifests, configs and conventions define what',
        '   correct means — follow them, do not invent new structure.',
        '',
        '3. HARD CONSTRAINTS:',
        '   - Do NOT delete, skip, disable, or weaken tests or checks to make the',
        '     command pass. Relocating or scoping a file the runner was never meant',
        '     to pick up (per the project’s own config) is a legitimate fix;',
        '     deleting it or marking it skipped is not.',
        '   - Do NOT remove or rename the project’s own commands (its test/build/',
        '     lint scripts or targets). Making the gate unable to find the command',
        '     is detected and the whole fix is rejected.',
        '   - Do NOT run git commands that mutate state (checkout, restore, reset,',
        '     revert, stash, clean). The work in this repository is finished and',
        '     committed — reverting it is destroying the run, not fixing it.',
        '',
        '4. Re-run the failing command after your fix and confirm it exits 0. The',
        '   gate is re-run mechanically after you finish — your claim is not the',
        '   verdict, the real exit code is.',
        '',
        'End with exactly one line:',
        '  FINAL-GATE-FIX: DONE',
        '  FINAL-GATE-FIX: BLOCKED <why you could not fix it>'
    ].join('\n')
}

/**
 * Parse the child's final marker. Last match wins (the model reasons before
 * concluding and bash output can echo the words). No marker → treated as DONE:
 * the gate re-run is the arbiter either way, so a missing marker only skips the
 * early-out on a self-declared BLOCKED.
 */
export function parseFinalFixMarker(text: string): {blocked: boolean; note?: string} {
    const re = /FINAL-GATE-FIX:\s*(DONE|BLOCKED)\b[ \t]*(.*)/gi
    let last: RegExpExecArray | null = null
    for (let m = re.exec(text); m !== null; m = re.exec(text)) last = m
    if (!last) return {blocked: false}
    if (last[1].toUpperCase() === 'BLOCKED') {
        return {blocked: true, note: last[2].trim() || 'no reason given'}
    }
    return {blocked: false, note: last[2].trim() || undefined}
}

export interface FinalFixResult {
    /** true → the fix child ran AND the re-run gate passed. */
    ok: boolean
    /** Human-readable outcome (converged gate reason, or why the attempt failed). */
    reason: string
    /** On a did-not-converge outcome: the FRESH gate failure, so the caller's next
     *  picker (and next fix attempt) works from the current state, not the stale one. */
    gateReason?: string
}

export interface FinalFixDeps {
    cwd: string
    signal?: AbortSignal
    /** The gate's FAIL reason (command + exit code + output tail), plus any
     *  user-typed guidance the caller folded in. */
    failReason: string
    /** Run the fix child; same closure shape the other gate children use. */
    runChild: (tools: string, prompt: string, signal?: AbortSignal) => Promise<string>
    /** Re-run the final integration gate — the only arbiter of convergence. */
    gate: (cwd: string) => Promise<{ok: boolean; reason: string}>
    /** Labels of every currently-discoverable gate command (static + integration),
     *  for the shrink guard. Pure discovery — nothing is executed. */
    discoverLabels: (cwd: string) => string[]
    /** Discard the fix child's working-tree edits (shrink-guard trip only). Absent
     *  → the violation is still rejected, edits are left for inspection. */
    discard?: (cwd: string) => Promise<void>
}

/**
 * Run one bounded final-gate fix attempt: snapshot discovery → child → shrink
 * guard → gate re-run. Never throws for an outcome; only a user cancel inside
 * runChild propagates (the caller's USER_CANCELLED path handles it).
 */
export async function runFinalGateAutofix(deps: FinalFixDeps): Promise<FinalFixResult> {
    const before = deps.discoverLabels(deps.cwd)

    let text: string
    try {
        text = await deps.runChild(
            FINAL_FIX_TOOLS,
            buildFinalFixPrompt(deps.failReason),
            deps.signal
        )
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg === USER_CANCELLED) throw err
        return {ok: false, reason: `fix child failed: ${msg}`}
    }

    // SHRINK GUARD: every gate command discoverable before the fix must still be
    // discoverable after it. A vanished command means the child "fixed" the gate
    // by removing the check — reject and (when possible) discard the edits.
    const after = new Set(deps.discoverLabels(deps.cwd))
    const vanished = before.filter(label => !after.has(label))
    if (vanished.length > 0) {
        if (deps.discard) await deps.discard(deps.cwd)
        return {
            ok: false,
            reason:
                `fix pass removed the gate's own command(s) (${vanished.join(', ')}) — `
                + `edits ${deps.discard ? 'discarded' : 'REJECTED but left in the tree (no discard available)'}`
        }
    }

    const marker = parseFinalFixMarker(text)
    if (marker.blocked) {
        // Self-declared blocked: skip the (expensive) gate re-run; nothing converged.
        return {ok: false, reason: `fix child blocked: ${marker.note}`}
    }

    const fin = await deps.gate(deps.cwd)
    if (!fin.ok) {
        return {
            ok: false,
            reason: `did not converge: ${fin.reason}`,
            gateReason: fin.reason
        }
    }
    return {ok: true, reason: fin.reason}
}
