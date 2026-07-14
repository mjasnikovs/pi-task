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
 *
 * WRITE-GUARD STACK (mx5 run 11): this child was added after the run-8 guard
 * generation and inherited none of them — it ran `rm` on a sibling task's
 * verified deliverable to satisfy a recorded debt claim and hand-copied a pinned
 * contract to green the lint, with free bash and no trace. Every attempt now
 * runs, deterministically and in order: frozen-path revert (when a freeze set is
 * wired — see below) → deletion guard (a tracked file deleted without relocation
 * rejects the attempt) → shrink guard (above) → probe-gaming scan over the added
 * lines (a fix that SAYS it games a check rejects the attempt). Diff capture for
 * every write-capable gate child lives at the gate-deps seam, keyed on the
 * child's TOOLS, so the next write-capable kind cannot run invisibly either.
 *
 * The frozen-path deny is implemented but NOT wired by gate-deps: per-task
 * frozen fences are task-SCOPED (they fence a task off a sibling's territory),
 * and the measured union over the run-11 specs would have reverted the one
 * legitimate whole-repo fix that run needed (migrate.ts — frozen by its own
 * producing task). It activates only when a run-GLOBAL freeze source exists.
 */
import {USER_CANCELLED} from './child-runner.js'
import {findForbiddenDeletions, type TreeChangeSummary} from './write-guard.js'

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
        '   - Do NOT delete tracked files at all. Every tracked file is a completed',
        '     task’s committed deliverable; a deletion is detected and the whole fix',
        '     is rejected. A legitimate relocation keeps the file (same file name)',
        '     elsewhere in the tree.',
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
    /** Discard the fix child's working-tree edits (guard trips only). Absent
     *  → the violation is still rejected, edits are left for inspection. */
    discard?: (cwd: string) => Promise<void>
    // ── Write-guard stack (mx5 run 11: this child ran UNGUARDED — free `rm`,
    //    no diff capture, no frozen-path deny, no probe scan). All optional so
    //    tests and older wirings degrade to the previous behavior; gate-deps
    //    wires every one of them.
    /** The fix child's tree changes (`git status --porcelain` shape) — diff capture
     *  for the log and the deletion guard's input. The tree was clean before the
     *  child ran (every task committed), so status IS the child's work. */
    treeChanges?: () => Promise<TreeChangeSummary>
    /** The union of every task spec's frozen (Do-NOT-modify) paths — the whole-run
     *  write-deny set, since this child works across all slices at once. */
    frozenPaths?: () => Promise<string[]>
    /** Restore the given frozen paths to HEAD; returns the files actually reverted
     *  (same mechanical deny the enforce pass carries — see frozen-path-guard.ts). */
    revertFrozen?: (paths: string[]) => Promise<string[]>
    /** Deterministic probe scan over the child's ADDED lines (probe-gaming, F6):
     *  a fix written to game a check rather than meet it rejects the attempt —
     *  run 11's autofix replaced the typed client with a hand-written contract
     *  copy to green the lint. Findings are verbatim offending lines. */
    probeScan?: () => Promise<string[]>
    /** Write a timestamped line to the gate debug log (guard events). */
    log?: (msg: string) => void
}

/**
 * Run one bounded final-gate fix attempt: snapshot discovery → child → write-guard
 * stack (diff capture → frozen-path revert → deletion guard → shrink guard → probe
 * scan) → gate re-run. Never throws for an outcome; only a user cancel inside
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

    const rejected = (what: string): FinalFixResult => ({
        ok: false,
        reason: `${what} — edits ${deps.discard ? 'discarded' : 'REJECTED but left in the tree (no discard available)'}`
    })

    // (Diff capture — what the pass changed, durably — happens at the gate-deps
    // seam for every write-capable child; here only the guards act on it.)

    // FROZEN-PATH WRITE-DENY: undo the child's edits to any path a task spec
    // froze, before anything downstream can act on them — same mechanical deny
    // the enforce pass carries (prompt framing is A/B-proven insufficient).
    // Non-fatal: the rest of the fix survives, only the frozen edits are undone.
    if (deps.frozenPaths && deps.revertFrozen) {
        const frozen = await deps.frozenPaths()
        if (frozen.length > 0) {
            const reverted = await deps.revertFrozen(frozen)
            if (reverted.length > 0) {
                deps.log?.(
                    `final-fix FROZEN-PATH GUARD — reverted spec-frozen file(s) the fix pass modified: ${reverted.join(', ')}`
                )
            }
        }
    }

    // DELETION GUARD (post-revert state): a tracked file the pass deleted without
    // relocating it is a committed deliverable destroyed — reject the attempt.
    if (deps.treeChanges) {
        const gone = findForbiddenDeletions(await deps.treeChanges())
        if (gone.length > 0) {
            if (deps.discard) await deps.discard(deps.cwd)
            const r = rejected(
                `fix pass DELETED tracked file(s) (${gone.join(', ')}) — a completed task's `
                    + `committed deliverable is not the fix child's to remove`
            )
            deps.log?.(`final-fix DELETION GUARD — ${r.reason}`)
            return r
        }
    }

    // SHRINK GUARD: every gate command discoverable before the fix must still be
    // discoverable after it. A vanished command means the child "fixed" the gate
    // by removing the check — reject and (when possible) discard the edits.
    const after = new Set(deps.discoverLabels(deps.cwd))
    const vanished = before.filter(label => !after.has(label))
    if (vanished.length > 0) {
        if (deps.discard) await deps.discard(deps.cwd)
        return rejected(`fix pass removed the gate's own command(s) (${vanished.join(', ')})`)
    }

    // PROBE SCAN (F6): added lines whose stated purpose is to make a check pass
    // rather than meet the requirement reject the attempt — there is no verify
    // child downstream of this pass to judge the finding, and the probe is
    // FP-measured at 1 true hit in 50,735 added lines on the real corpus.
    if (deps.probeScan) {
        const findings = await deps.probeScan()
        if (findings.length > 0) {
            if (deps.discard) await deps.discard(deps.cwd)
            const r = rejected(
                `fix pass added CHECK-GAMING code (${findings.slice(0, 2).join('; ').slice(0, 300)})`
            )
            deps.log?.(`final-fix PROBE-GAMING GUARD — ${r.reason}`)
            return r
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
