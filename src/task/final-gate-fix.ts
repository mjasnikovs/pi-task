/**
 * final-gate-fix — the bounded, model-driven fix pass the FINAL integration
 * gate's resolution picker offers as its second card.
 *
 * This mirrors the per-task graduated-resolution shape (lint-fix.ts) and shares
 * its child ladder through `runFixChild`: a write-enabled child limited to
 * `read,edit,bash` is seeded with the gate's own failure text, edits in place,
 * and then the gate is RE-RUN. The child's self-report can only end an attempt
 * early as BLOCKED; it can never produce a PASS. `run-final-gate.ts` keeps
 * "Leave failed" as the recommended card and stops offering Autofix after
 * MAX_FINAL_GATE_AUTOFIX attempts, so a non-converging loop hands control back
 * to a person.
 *
 * CHEAT GUARD (deterministic): the cheapest way for a fix child to "converge" is
 * to remove the failing command itself — delete the `test` script, drop the
 * Makefile target — so the gate discovers nothing and vacuously passes. The
 * discovered gate commands are therefore snapshotted before the child runs; a
 * previously-discovered command that is no longer discoverable afterwards
 * rejects the attempt and discards its edits, and so does one whose resolved
 * BODY narrowed. A fix may change what a command DOES, never make it disappear
 * or shrink what it covers.
 *
 * WRITE-GUARD STACK, in the order `runFinalGateAutofix` runs it: frozen-path
 * revert (only when a freeze set is wired) → deletion guard (a tracked file
 * deleted without relocation rejects the attempt) → shrink guard → scope-shrink
 * guard → probe-gaming scan over the added lines. Diff capture is NOT here: it
 * lives at the gate-child seam, where a `/\b(?:edit|bash|write)\b/` test on the
 * child's TOOLS decides it, so any future write-capable kind is logged too.
 *
 * The frozen-path deny is implemented here but NOT wired by gate-deps — the
 * `finalGateFix` wiring there passes every other dep and omits these two.
 * Per-task frozen fences are task-SCOPED, so their union across a run's specs
 * can fence off a file a legitimate whole-repo fix has to touch. It activates
 * only when a run-GLOBAL freeze source exists.
 */
import {parseFixMarker, runFixChild} from './fix-child.js'
import type {FinalGateOutcome} from './final-gate.js'
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
 * withdrawn. Same value as the per-task MAX_AUTO_AUTOFIX budget. Each attempt is
 * a full model child plus a full gate re-run — after this many that still FAIL,
 * `run-final-gate.ts` drops the Autofix card and only Leave-failed / Accept
 * remain, so a person breaks the loop.
 */
export const MAX_FINAL_GATE_AUTOFIX = 3

/** Picker labels/values. Each label starts with its own value word, so
 *  `classifyFinalGateAnswer` accepts the value token and the label alike;
 *  anything else is free text and becomes autofix guidance. */
export const FINAL_LEAVE_VALUE = 'fail'
export const FINAL_ACCEPT_VALUE = 'accept'
export const FINAL_AUTOFIX_VALUE = 'autofix'
export const FINAL_LEAVE_LABEL = 'Leave failed — I will fix and /task-auto-resume'
export const FINAL_ACCEPT_LABEL = 'Accept — complete the run anyway'
export const FINAL_AUTOFIX_LABEL = 'Autofix — run a bounded fix pass and re-run the gate'

export interface FinalGateChoice {
    /** What the user decided. 'leave' = leave the run failed, and also what a
     *  dismissed picker means. */
    action: 'leave' | 'accept' | 'autofix'
    /** Free-text guidance typed instead of picking a card; folded into the fix
     *  child's failure seed. Only set with 'autofix'. */
    guidance?: string
}

/**
 * Map a final-gate picker answer to an action. Dismissal (undefined/empty) and
 * an explicit leave both stay "leave". Free text becomes autofix guidance; the
 * caller's `choice.action === 'autofix' && canAutofix` test demotes autofix back
 * to leave when the card was not offered.
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
 * The gate's fail reason carries the failing command in backticks — final-gate
 * mints `` `<label>` exited <status> — <tail> ``, with a `lockfile check: ` or
 * `launch script: ` prefix on two of the sections. Extract it for reporting
 * only; the shrink guard compares the FULL discovered-command sets, so a reason
 * this cannot parse still guards.
 */
export function exitedCommandFromReason(reason: string): string | null {
    const m = /`([^`]+)`\s+exited\b/.exec(reason)
    return m ? m[1] : null
}

/**
 * Build the fix child's prompt. Generic by construction: the only project facts
 * in it are the gate's own failure text, whose command labels come from the
 * project's discovered manifest. The seed may carry SEVERAL failures — the gate
 * runs every section and aggregates, emitting "N failures (ranked, most
 * load-bearing first)" — and it reports `ok` only when that list is empty, so
 * the child is told to fix all of them.
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

/** This pass's marker word, parsed by the shared `parseFixMarker` (last match
 *  wins; no marker → DONE). */
export function parseFinalFixMarker(text: string): {blocked: boolean; note?: string} {
    return parseFixMarker('FINAL-GATE-FIX', text)
}

/**
 * STRANDED SUB-FIXES.
 *
 * An attempt that does not converge KEEPS its edits — only a guard trip
 * discards — and the caller commits only on `fix.ok`. So a partial fix that
 * genuinely repaired something sits uncommitted in the working tree while HEAD
 * still carries the defect, invisible unless someone runs `git status`.
 *
 * The rule: a partial fix is either committed as its own named commit or
 * explicitly surfaced — never silently stranded. `run-final-gate.ts` calls
 * `commitStranded` on BOTH terminal outcomes, accept and leave-failed, so an
 * unattended run that ends on LEAVE does not leave real repairs one `git
 * checkout` from gone.
 *
 * Only guard-CLEAN edits qualify. `AutofixLedger.mayCommitTree()` goes false
 * once a guard has rejected an attempt whose edits could not be discarded, and
 * never flips back: the guard is not weakened to make committing easier.
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
    /**
     * The re-run gate's OUTCOME, whole — present whenever the gate actually ran,
     * absent only when the fix child self-declared BLOCKED and the re-run was
     * skipped. The whole `FinalGateOutcome` crosses, not a hand-picked copy of
     * some of its fields: a copy silently drops whatever it forgot, and the
     * pairing between `failures` and `observedFailures` only holds inside it.
     */
    gate?: FinalGateOutcome
    /** On a converged outcome: the UNOBSERVED note the CALLER should show. It is
     *  the gate's own note plus any downgrade this fix pass added (see the
     *  ignored-dependency probe below), so it is not simply `gate.unobserved`. */
    unobserved?: string
    /** Gitignored path(s) this fix pass wrote, with the exempt classes already
     *  removed (task dir, `.git`, node_modules, build output — write-guard.ts).
     *  Present whether or not the gate converged; path names only, never
     *  contents. */
    ignoredWrites?: string[]
    /** …and the mechanical dependency probe found the converged gate does NOT pass
     *  without them, so `unobserved` above carries the downgrade. Absent when the
     *  probe could not answer: no probe wired, a path that would not move, or more
     *  paths than its bound allows. */
    ignoredDependent?: boolean
    /** A write-guard rejected this attempt (deletion / shrink / probe-gaming). */
    guardTripped?: boolean
    /** …and its edits were discarded. False here with `guardTripped` true means
     *  the tree still holds REJECTED edits, and the caller must not commit what it
     *  finds: that is what `AutofixLedger.mayCommitTree()` latches off. */
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
     *  (ok=true); `failures` rides through so the caller sees every entry.
     *  Typed as the gate's own outcome, not a structural copy of some fields. */
    gate: (cwd: string) => Promise<FinalGateOutcome>
    /** Labels of every currently-discoverable gate command — health, lockfile,
     *  integration and boot — for the shrink guard. Pure discovery: nothing
     *  runs. */
    discoverLabels: (cwd: string) => string[]
    /** The same commands' RESOLVED BODIES (`label → scripts[name]` / Makefile
     *  recipe), for the scope-shrink half of the guard. Absent → only the label
     *  comparison runs. */
    discoverBodies?: (cwd: string) => Record<string, string>
    /** Discard the fix child's working-tree edits (guard trips only). Absent
     *  → the violation is still rejected, edits are left for inspection. */
    discard?: (cwd: string) => Promise<void>
    // ── Write-guard stack. All optional, so a wiring that omits one degrades to
    //    not running that guard rather than throwing. gate-deps wires all of
    //    them EXCEPT frozenPaths/revertFrozen — see the header.
    /** Tree changes in `git status --porcelain` shape — the deletion guard's input
     *  and the "created by this fix" set the scope-shrink guard consults. Every
     *  task is committed before this stage, so what status reports is fix-pass
     *  work; on a second attempt that includes the first attempt's kept edits,
     *  since a non-converged attempt is not discarded. */
    treeChanges?: () => Promise<TreeChangeSummary>
    /** The union of every task spec's frozen (Do-NOT-modify) paths — the whole-run
     *  write-deny set, since this child works across all slices at once. */
    frozenPaths?: () => Promise<string[]>
    /** Restore the given frozen paths to HEAD; returns the files actually reverted.
     *  `frozen-path-guard.ts`'s `revertFrozenPaths`, the same one the per-task
     *  passes use. */
    revertFrozen?: (paths: string[]) => Promise<string[]>
    /** Deterministic probe scan over the child's ADDED lines: a fix whose own
     *  added text says it is gaming a check rather than meeting it rejects the
     *  attempt. There is no verify child downstream of this pass to judge such a
     *  finding. Findings are the verbatim offending lines. */
    probeScan?: () => Promise<string[]>
    // ── Ignored-path channel. Every guard above consumes `git status
    //    --porcelain`, which does not report ignored paths, so a pass that greens
    //    a command by writing into a gitignored `.env` is invisible to all of
    //    them.
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
 * Run one bounded final-gate fix attempt: snapshot discovery and ignored paths →
 * child → frozen-path revert → deletion guard → shrink guard → scope-shrink
 * guard → probe scan → gate re-run. Never throws for an outcome; only a user
 * cancel inside runChild propagates, and the caller's USER_CANCELLED path
 * handles that.
 */
export async function runFinalGateAutofix(deps: FinalFixDeps): Promise<FinalFixResult> {
    const before = deps.discoverLabels(deps.cwd)
    const bodiesBefore = deps.discoverBodies?.(deps.cwd) ?? {}
    // Ignored paths as they stood BEFORE the child. Attribution needs both ends:
    // ignored files are untracked, so git alone cannot tell a file this pass wrote
    // from one that was already sitting in the worktree.
    const ignoredBefore = deps.ignoredSnapshot ? await deps.ignoredSnapshot() : null

    // The child ladder is task/fix-child.ts, shared with the per-task pass.
    const end = await runFixChild({
        runChild: deps.runChild,
        tools: FINAL_FIX_TOOLS,
        prompt: buildFinalFixPrompt(deps.failReason),
        signal: deps.signal,
        marker: 'FINAL-GATE-FIX'
    })
    if (end.kind === 'error') return {ok: false, reason: `fix child failed: ${end.msg}`}

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

    // (Diff capture — what the pass changed, durably — happens in gate-child.ts,
    // which logs the tree changes of any child whose TOOLS include edit/bash/
    // write; here only the guards act on them.)

    // FROZEN-PATH WRITE-DENY: undo the child's edits to any path a task's spec
    // froze, before anything downstream can act on them — the same mechanical
    // revert the per-task passes carry, not prompt framing. Non-fatal: the rest
    // of the fix survives, only the frozen edits are undone.
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

    // DELETION GUARD (post-revert state): a tracked file the pass deleted is a
    // completed task's committed deliverable destroyed — reject the attempt. A
    // deletion paired with an added file of the SAME BASENAME is a relocation and
    // passes, as do the regenerable artifacts write-guard.ts exempts.
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

    // SCOPE-SHRINK GUARD: the label surviving is not enough. A child can keep
    // `bun run test` and rewrite its BODY to run a subdirectory instead of the
    // repository — the set difference above stays empty while the suite stops
    // covering what the gate is meant to measure, and the re-run then goes green
    // and reports "converged". So compare the resolved bodies too
    // (command-shrink.ts holds the mechanical narrowing shapes).
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

    // PROBE SCAN: added lines whose own stated purpose is to make a check pass
    // rather than meet the requirement reject the attempt. Nothing downstream of
    // this pass would judge such a finding — the gate re-run only sees exit
    // codes.
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

    if (end.kind === 'blocked') {
        // Self-declared blocked: skip the (expensive) gate re-run; nothing converged.
        return withIgnored({ok: false, reason: `fix child blocked: ${end.note}`})
    }

    const fin = await deps.gate(deps.cwd)
    if (!fin.ok) {
        return withIgnored({ok: false, reason: `did not converge: ${fin.reason}`, gate: fin})
    }

    // IGNORED-DEPENDENCY DOWNGRADE. The gate says PASS; this decides whether the
    // PASS belongs to the REPOSITORY or only to this worktree. Mechanical, never
    // judgement: move the ignored files the pass wrote aside, re-run the gate
    // once, put them back. Still passing ⇒ incidental, the PASS stands. Failing ⇒
    // the checks were passing on state no fresh clone has, which is UNOBSERVED
    // (final-gate.ts unobservedVerdict), not a FAIL — the fix is real, it just
    // did not ship. Guarded on a non-empty `ignoredWrites`, so a pass that wrote
    // no ignored paths runs no extra gate.
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
        gate: fin,
        ...(notes.length > 0 ? {unobserved: notes.join(' ')} : {}),
        ...(ignoredDependent !== undefined ? {ignoredDependent} : {})
    })
}
