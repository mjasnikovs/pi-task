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
import {
    findForbiddenDeletions,
    diffIgnoredSnapshots,
    ignoredWriteTrailLine,
    ignoredWriteUnobservedNote,
    type TreeChangeSummary,
    type IgnoredSnapshot
} from './write-guard.js'
import {findNarrowedCommands, narrowingRejectionText} from './command-shrink.js'

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
 * discovered manifest, never from a hardcoded ecosystem. The seed may carry
 * SEVERAL failures (the gate aggregates every section since mx5 run 13, ranked
 * most load-bearing first); convergence means the WHOLE list is empty, so the
 * child is told to fix all of them.
 */
export function buildFinalFixPrompt(failReason: string): string {
    return [
        'You are a bounded fix pass for a FAILED whole-repo integration gate.',
        'Every task in this run is complete and committed; then the project’s own',
        'integration commands were run against the assembled repository and failed:',
        '',
        failReason.trim(),
        '',
        'Your ONLY job is to fix the DEFECT(s) those failures reveal. When several',
        'failures are listed they are ranked most load-bearing first — fix ALL of',
        'them; the gate only converges when every one passes.',
        '',
        '1. Re-run each exact failing command first and read its full output.',
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
        '4. Re-run the failing command(s) after your fix and confirm they exit 0.',
        '   The gate is re-run mechanically after you finish — your claim is not',
        '   the verdict, the real exit codes are.',
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

/**
 * STRANDED SUB-FIXES (mx5 run 13, PROMPT 4 item 3).
 *
 * A fix attempt that does not converge keeps its edits: they are NOT discarded
 * (only a guard trip discards), and `deps.commit` runs only on `fix.ok`. So a
 * partial fix that genuinely repaired something sits in the working tree, uncommitted,
 * and if the user then ACCEPTs the FAIL the run completes around it — leaving HEAD
 * broken while the repair is invisible unless someone runs `git status`.
 *
 * That is exactly what run 13 shipped: the fix child's bunfig.toml change made
 * `bun run test` pass 116/116, attempt 1 did not converge overall, the user accepted
 * the FAIL, and the tree still shows the file modified while HEAD's `bun run test` is
 * broken. The repair and the breakage were BOTH real; only the repair was discarded
 * by default.
 *
 * The rule: a partial fix is either committed (its own commit, named in the trail) or
 * explicitly surfaced — never silently stranded.
 *
 * mx5 run 14 proved the committing half only ever ran on the ACCEPT path. The run
 * ended on LEAVE (YOLO, budget spent) and 13 real repairs — the dev script, the
 * teardown bug, test serialization, the migrate script: the changes that make that
 * app work today — were left dirty in the tree, one `git checkout` from gone, after
 * an UNATTENDED run nobody was watching. So EVERY terminal non-converged outcome
 * commits them now, not just ACCEPT. Only guard-CLEAN edits qualify: an attempt a
 * write-guard rejected without discarding leaves REJECTED edits in the tree, and
 * those are never committed (the guard is not weakened to make committing easier).
 */

/** Commit subject for partial fixes committed alongside a terminal gate FAIL. */
export const STRANDED_FIX_COMMIT = (
    runId: string,
    outcome: 'accepted' | 'left-failed' = 'accepted'
): string =>
    `FINAL GATE PARTIAL FIX (${runId}) — ${
        outcome === 'accepted' ?
            'accepted with gate still failing'
        :   'run left failed, repairs preserved'
    }`

/**
 * The picker/trail line describing what a non-converging fix pass left behind.
 * Empty string when the tree is clean — the caller then says nothing at all.
 */
export function strandedFixNote(paths: string[]): string {
    if (paths.length === 0) return ''
    const shown = paths.slice(0, 8).join(', ')
    return (
        `\n\nUNCOMMITTED: the fix pass left ${paths.length} change(s) in the working tree `
        + `(${shown}${paths.length > 8 ? ', …' : ''}). These are NOT in HEAD. Either terminal `
        + `choice commits them as their own, named commit so they cannot be lost to a later `
        + `checkout — the run's outcome is recorded in the gate trail either way.`
    )
}

export interface FinalFixResult {
    /** true → the fix child ran AND the re-run gate passed. */
    ok: boolean
    /** Human-readable outcome (converged gate reason, or why the attempt failed). */
    reason: string
    /** On a did-not-converge outcome: the FRESH gate failure, so the caller's next
     *  picker (and next fix attempt) works from the current state, not the stale one. */
    gateReason?: string
    /** The fresh gate's individual ranked failures (see FinalGateOutcome.failures),
     *  so the caller can trail each entry — never just the first. */
    gateFailures?: string[]
    /** …and which of them a PROBE returned after OBSERVING (see
     *  FinalGateOutcome.observedFailures). Carried so the caller's non-progress
     *  classifier can ask the probe's own verdict instead of guessing from the
     *  failure text — a check that was observed to FAIL is never demote-eligible
     *  (nexttask 19A). */
    gateObservedFailures?: string[]
    /** On a converged outcome: the re-run gate's UNOBSERVED note, if it observed
     *  nothing dynamic (see FinalGateOutcome.unobserved). Carried so the caller
     *  labels a converge-on-statics-alone the same way it labels a first-pass one —
     *  "converged" must never quietly mean "we stopped being able to check". */
    unobserved?: string
    /** Gitignored path(s) this fix pass wrote, exempt classes already removed (see
     *  write-guard.ts). Present whether or not the gate converged — the caller
     *  trails them either way; path names only, never contents. */
    ignoredWrites?: string[]
    /** …and the mechanical dependency probe found the converged gate does NOT pass
     *  without them, so `unobserved` above carries the downgrade. Absent when the
     *  probe could not answer (no probe wired, restore risk, too many paths). */
    ignoredDependent?: boolean
    /** A write-guard rejected this attempt (deletion / shrink / probe-gaming). */
    guardTripped?: boolean
    /** …and its edits were discarded. When a guard tripped and this is false, the
     *  working tree still holds REJECTED edits, so the caller must NOT commit what
     *  it finds there (mx5 run 14 item 2b: commit surviving fix-pass edits — but
     *  only guard-CLEAN ones; the cheat guard is never weakened to ease committing). */
    editsDiscarded?: boolean
}

export interface FinalFixDeps {
    cwd: string
    signal?: AbortSignal
    /** The gate's FAIL reason (command + exit code + output tail), plus any
     *  user-typed guidance the caller folded in. */
    failReason: string
    /** Run the fix child; same closure shape the other gate children use. */
    runChild: (tools: string, prompt: string, signal?: AbortSignal) => Promise<string>
    /** Re-run the final integration gate — the only arbiter of convergence.
     *  Converges only when the gate's FULL aggregated failure list is empty
     *  (ok=true); `failures` rides through so the caller sees every entry. */
    gate: (cwd: string) => Promise<{
        ok: boolean
        reason: string
        failures?: string[]
        /** Which of them a probe returned after OBSERVING (nexttask 19A) — carried
         *  through so the caller's demote decision can ask the probe's own verdict
         *  instead of re-deriving observability from the failure string. */
        observedFailures?: string[]
        unobserved?: string
    }>
    /** Labels of every currently-discoverable gate command (static + integration),
     *  for the shrink guard. Pure discovery — nothing is executed. */
    discoverLabels: (cwd: string) => string[]
    /** The same commands' RESOLVED BODIES (`label → scripts[name]` / Makefile
     *  recipe), for the scope-shrink half of the guard. Absent → only the label
     *  comparison runs, i.e. the pre-run-19 behaviour. */
    discoverBodies?: (cwd: string) => Record<string, string>
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
    // ── Ignored-path channel (mx5 run 19: the fix pass greened `bun run seed` by
    //    writing credentials into a gitignored `.env`, invisible to every guard
    //    above because porcelain does not report ignored paths).
    /** Fingerprint of the ACTIONABLE ignored paths (build output and node_modules
     *  already exempt). Called before and after the child; the difference is what
     *  this pass wrote. Absent → the channel is off and behaviour is unchanged. */
    ignoredSnapshot?: () => Promise<IgnoredSnapshot>
    /** Ignored paths EARLIER attempts in this resolution loop already wrote. An
     *  attempt that fails still leaves its ignored writes on disk (discard reverts
     *  tracked files only), so without this a `.env` written by attempt 1 would be
     *  invisible to attempt 2's before/after diff — and attempt 2's converged PASS
     *  would rest on it unrecorded. The caller accumulates. */
    ignoredKnown?: string[]
    /** The mechanical dependency test: does the gate still pass with these paths
     *  moved aside? `null` ⇒ unanswerable, which never downgrades a verdict. */
    gateWithoutIgnored?: (paths: string[]) => Promise<boolean | null>
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
    const bodiesBefore = deps.discoverBodies?.(deps.cwd) ?? {}
    // Ignored paths as they stood BEFORE the child. Attribution needs both ends:
    // ignored files are untracked, so git alone cannot tell a file this pass wrote
    // from one that was already sitting in the worktree.
    const ignoredBefore = deps.ignoredSnapshot ? await deps.ignoredSnapshot() : null

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

    // What the child wrote to gitignored paths. Recorded on the trail IMMEDIATELY —
    // before any guard can reject the attempt — because `discard` reverts tracked
    // edits only: an ignored file the pass wrote survives a rejection, and the trail
    // is the only place that fact can ever be read back.
    const ignoredWrites =
        ignoredBefore === null || !deps.ignoredSnapshot ?
            []
        :   [
                ...new Set([
                    ...diffIgnoredSnapshots(ignoredBefore, await deps.ignoredSnapshot()),
                    ...(deps.ignoredKnown ?? [])
                ])
            ].sort()
    if (ignoredWrites.length > 0) deps.log?.(ignoredWriteTrailLine(ignoredWrites))
    const withIgnored = <T extends FinalFixResult>(r: T): T =>
        ignoredWrites.length > 0 ? {...r, ignoredWrites} : r

    const rejected = (what: string): FinalFixResult =>
        withIgnored({
            ok: false,
            reason: `${what} — edits ${deps.discard ? 'discarded' : 'REJECTED but left in the tree (no discard available)'}`,
            guardTripped: true,
            editsDiscarded: deps.discard !== undefined
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
    const changes = deps.treeChanges ? await deps.treeChanges() : null
    if (changes) {
        const gone = findForbiddenDeletions(changes)
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

    // SCOPE-SHRINK GUARD (mx5 run 19): the label surviving is not enough. The
    // autofix kept `bun run test` and rewrote its BODY from `AGENT=1 bun test`
    // to `AGENT=1 bun test ./test`, so the set difference above was empty while
    // the suite stopped covering the repository — and the gate re-ran, went
    // green, and reported "converged". Compare the resolved bodies and reject a
    // fix that shrinks what the gate measures (command-shrink.ts: four
    // mechanical shapes, measured at 3 hits in 274 manifest-touching corpus
    // commits, all three read by hand as real narrowings).
    if (deps.discoverBodies) {
        const addedByFix = new Set((changes?.added ?? []).map(p => p.replace(/^\.\//, '')))
        const narrowed = findNarrowedCommands(bodiesBefore, deps.discoverBodies(deps.cwd), {
            createdByFix: p => {
                const n = p.replace(/^\.\//, '')
                return addedByFix.has(n) || [...addedByFix].some(a => a.endsWith(`/${n}`))
            }
        })
        if (narrowed.length > 0) {
            if (deps.discard) await deps.discard(deps.cwd)
            const r = rejected(narrowingRejectionText(narrowed))
            deps.log?.(`final-fix SCOPE-SHRINK GUARD — ${r.reason}`)
            return r
        }
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
        return withIgnored({ok: false, reason: `fix child blocked: ${marker.note}`})
    }

    const fin = await deps.gate(deps.cwd)
    if (!fin.ok) {
        return withIgnored({
            ok: false,
            reason: `did not converge: ${fin.reason}`,
            gateReason: fin.reason,
            gateFailures: fin.failures,
            ...(fin.observedFailures ? {gateObservedFailures: fin.observedFailures} : {})
        })
    }

    // IGNORED-DEPENDENCY DOWNGRADE (mx5 run 19). The gate says PASS; the question
    // this answers is whether that PASS belongs to the REPOSITORY or only to this
    // worktree. Decided mechanically, never by judgement: move the ignored files
    // the pass wrote aside, re-run the gate once, put them back. Still passing ⇒
    // they were incidental and the PASS stands. Failing ⇒ the checks were passing
    // on state no fresh clone has, which is the definition of UNOBSERVED (see
    // final-gate.ts unobservedVerdict) — not a FAIL: the fix is real, it just did
    // not ship. The probe runs only here, so a run with no ignored writes (the
    // overwhelming majority — 1 of 68 recorded child logs) pays nothing.
    let ignoredDependent: boolean | undefined
    if (ignoredWrites.length > 0 && deps.gateWithoutIgnored) {
        const passesWithout = await deps.gateWithoutIgnored(ignoredWrites)
        if (passesWithout !== null) ignoredDependent = !passesWithout
    }
    const notes = [
        ...(fin.unobserved ? [fin.unobserved] : []),
        ...(ignoredDependent === true ? [ignoredWriteUnobservedNote(ignoredWrites)] : [])
    ]
    if (ignoredDependent === true) {
        deps.log?.(
            `final-gate: converged PASS DOWNGRADED to UNOBSERVED — the gate does not pass with `
                + `${ignoredWrites.join(', ')} moved aside, and those path(s) are gitignored`
        )
    }
    return withIgnored({
        ok: true,
        reason: fin.reason,
        ...(notes.length > 0 ? {unobserved: notes.join(' ')} : {}),
        ...(ignoredDependent !== undefined ? {ignoredDependent} : {})
    })
}
