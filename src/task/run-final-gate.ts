/**
 * run-final-gate — the RUN-LEVEL final integration gate, the twin of task-gates.ts.
 *
 * task-gates.ts gates ONE task against its own spec. This gates the WHOLE REPO once,
 * when every task in a /task-auto run is checked off and BEFORE the run is declared
 * complete: every task passed its own per-slice gates, but per-slice green has shipped
 * a dead app twice (mx5 runs 3 & 5 — statics clean, every protected route 500ing). So
 * the project's OWN whole-repo commands run once here, unaided.
 *
 * The stage owns four things the per-task gate has no equivalent of:
 *
 *   1. THREE verdicts, not two — PASS / FAIL / UNOBSERVED. A gate that observed
 *      nothing dynamic is never announced as a pass (final-gate.ts unobservedVerdict).
 *   2. The run-end ACCEPT-debt report — every defect a task was allowed to ship with,
 *      surfaced at the last moment anyone will look, and RE-DERIVED against the final
 *      tree after a converged autofix so the last word is about the tree that shipped.
 *   3. The resolution loop — Leave-failed (recommended) / Autofix (a bounded,
 *      model-driven fix pass + gate re-run) / Accept, with the autofix card withdrawn
 *      after MAX_FINAL_GATE_AUTOFIX so a non-converging fix pass cannot loop forever.
 *   4. The stranded sub-fixes a non-converging fix pass leaves in the working tree —
 *      committed on EVERY terminal outcome, because both of them end the run and the
 *      next `git checkout` would destroy real repairs (mx5 run 14: 13 of them).
 *
 * Every terminal outcome is RETURNED, never announced here — same contract as
 * {@link runGatesForTask}'s GateResult: the caller owns the parent task file's state
 * and its own resume wording. Nothing in this module touches per-task loop state, so
 * a resume simply re-enters it and re-runs the gate.
 */
import type {ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import type {CommitResult} from './auto-commit.js'
import type {FinalGateOutcome} from './final-gate.js'
import type {FinalGateFixFn} from './gate-deps.js'
import {describeDebt, recordDebt, type AcceptDebt} from './accept-debt.js'
import {cancelCheckpoint} from './cancel-points.js'
import {SessionUI} from '../remote/bridge.js'
import {isYoloMode, yoloFinalGateChoice, YOLO_STAMP} from './yolo.js'
import {ignoredWriteTrailLine, ignoredWriteDebtReason} from './write-guard.js'
import {readOwnedRequirements} from './requirements.js'
import {unclaimedPendingRequirements} from './owned-freeze-reassign.js'
import {
    applyDemotions,
    isNonProgress,
    normalizeFailureDetail,
    rankedFirstFailure,
    unobservedDebtReason
} from './final-gate-progress.js'
import {
    classifyFinalGateAnswer,
    MAX_FINAL_GATE_AUTOFIX,
    FINAL_LEAVE_LABEL,
    FINAL_LEAVE_VALUE,
    FINAL_ACCEPT_LABEL,
    FINAL_ACCEPT_VALUE,
    FINAL_AUTOFIX_LABEL,
    FINAL_AUTOFIX_VALUE,
    STRANDED_FIX_COMMIT,
    strandedFixNote
} from './final-gate-fix.js'

/**
 * The seams this stage drives. A strict subset of what /task-auto builds, and
 * deliberately narrow: every optional dep absent degrades to a documented earlier
 * behaviour, so a test supplies only the ones its scenario is about.
 */
export interface FinalGateStageDeps {
    /**
     * Whole-repo FINAL integration gate: the project's own static checks plus its own
     * test/build commands, unaided (see final-gate.ts). Absent (tests / gate off) →
     * the run completes without one, as it did before the gate existed.
     */
    finalGate?: (cwd: string, planText?: string) => Promise<FinalGateOutcome>
    /**
     * Bounded model-driven fix pass for a FAIL (see final-gate-fix.ts), offered as the
     * picker's third option. Runs the fix child, applies the command-shrink guard, and
     * re-runs the gate; the result's `ok` means the gate now passes. Absent (tests / no
     * fix wiring) → the picker keeps only Leave-failed / Accept, exactly the
     * pre-autofix behavior.
     */
    finalGateFix?: FinalGateFixFn
    /**
     * Paths currently uncommitted in the working tree (`git status` shape), used to
     * detect SUB-FIXES a non-converging fix pass left behind (mx5 run 13 PROMPT 4 item
     * 3). Every task is committed by the time this stage runs, so anything dirty here
     * is the fix pass's own work. Absent → the stranded-fix handling is skipped
     * entirely (prior behavior).
     */
    pendingChanges?: (cwd: string) => Promise<string[]>
    /**
     * Re-derive the still-open ACCEPT-debt ledger against the tree AS IT IS NOW
     * (final-gate.ts `deriveOpenDebts`). Needed because the run's "N recorded
     * verify-FAIL defect(s) are STILL unresolved" report used to be built from the
     * FIRST gate result and the converged-autofix path then rebuilt the gate outcome
     * as a bare `{ok, reason}` — so `openDebts` was not merely un-actioned, it was GONE
     * from the value, and no code path could ever clear, re-check or act on it (mx5 run
     * 18: four defects reported STILL OPEN at 14:58, one of them fixed by the autofix
     * that converged at 15:03, and the report never moved).
     *
     * `staticOk` is the caller's PROOF about the current statics, never a guess: it is
     * passed true only where the gate itself just passed them. Absent (tests) → the
     * post-autofix re-check is skipped and the pre-autofix report stands, exactly the
     * prior behavior.
     */
    recheckOpenDebts?: (
        cwd: string,
        staticOk: boolean
    ) => Promise<{openDebts: AcceptDebt[]; debtNote?: string; trail?: string[]}>
    /** Snapshot the working tree into one commit — used for a converged autofix and
     *  for the stranded sub-fixes either terminal outcome would otherwise abandon. */
    commit: (cwd: string, message: string) => Promise<CommitResult>
    /** Append one line to the RUN's durable gate trail (`## gates` on the parent task
     *  file) — the same auditability contract the per-task records carry. Best-effort:
     *  absent in tests → skipped; a failure never breaks the gate. */
    record?: (cwd: string, taskId: string, line: string) => Promise<void>
}

/** Inputs that vary per caller. */
export interface FinalGateStageParams {
    cwd: string
    /** The parent /task-auto id: trail target, notify prefix, commit-message tag. */
    runId: string
    /** The parent plan (the task list), handed to the gate so it can tell a served app
     *  from a CLI — the boot check requires a listener only for the former (mx5 run 10:
     *  a CSS watcher satisfied "still alive"). */
    planText: string
    /** How many tasks the run completed — for the completion announcement only. */
    taskCount: number
}

/**
 * How the run ended. The caller announces each one with its own resume wording and
 * owns the parent task file's state — `cancelled` changes no state (a resume
 * re-enters this stage and runs the gate then), `failed` marks the run failed,
 * `completed` marks it complete.
 */
export type FinalGateStageResult =
    | {kind: 'cancelled'; message: string}
    | {kind: 'failed'; message: string}
    | {kind: 'completed'; message: string; level: 'info' | 'warning'}

/**
 * Show the run-end picker and return the raw answer. Card ORDER is fixed —
 * Leave-failed, then Autofix while the bound still allows it, then Accept — and
 * Leave-failed is the recommendation on every branch: a run that could not green the
 * whole-repo gate has not produced a working project. Same SessionUI.ask the
 * clarify/grill/verify dialogs use, so a remote device answers it too.
 */
async function askFinalGateResolution(
    ctx: ExtensionCommandContext,
    question: string,
    canAutofix: boolean
): Promise<string | undefined> {
    return new SessionUI(ctx).ask({
        localTitle: 'Final integration gate failed — how should pi proceed?',
        displayQuestion: question,
        question,
        recommended: FINAL_LEAVE_LABEL,
        recommended2: canAutofix ? FINAL_AUTOFIX_LABEL : FINAL_ACCEPT_LABEL,
        allowSkip: false,
        options: [
            {label: FINAL_LEAVE_LABEL, value: FINAL_LEAVE_VALUE},
            ...(canAutofix ? [{label: FINAL_AUTOFIX_LABEL, value: FINAL_AUTOFIX_VALUE}] : []),
            {label: FINAL_ACCEPT_LABEL, value: FINAL_ACCEPT_VALUE}
        ]
    })
}

/** The run-completion announcement: a run that completed on statics alone must not
 *  read like one whose product was actually exercised. */
function completedResult(
    id: string,
    taskCount: number,
    unobservedNote: string | null
): FinalGateStageResult {
    return {
        kind: 'completed',
        message:
            `${id} complete — all ${taskCount} tasks done.`
            + (unobservedNote ?
                ' WARNING: the final integration gate was UNOBSERVED — it ran no '
                + 'dynamic check at all, so "complete" here means the statics '
                + 'passed and nothing more. Carried as debt for the next run.'
            :   ''),
        level: unobservedNote ? 'warning' : 'info'
    }
}

/**
 * Run the whole-repo gate and resolve its verdict with the user.
 *
 * Lifted verbatim out of /task-auto's run loop, which it never shared state with:
 * the stage reads no per-task variable and writes none. Never throws for a gate
 * outcome — only a user cancel inside a gate child propagates (the caller's
 * USER_CANCELLED path handles it).
 */
export async function runFinalGateStage(
    active: ExtensionCommandContext,
    deps: FinalGateStageDeps,
    p: FinalGateStageParams
): Promise<FinalGateStageResult> {
    const {cwd, runId: id, planText, taskCount} = p
    // SAFE CHECKPOINT (pre-final-gate): every task is checked off and committed and
    // the whole-repo gate has not started. A resume re-enters this same stage and
    // runs the gate then, so the run is left exactly where it was — not silently
    // declared complete.
    if (cancelCheckpoint('pre-final-gate')) {
        return {
            kind: 'cancelled',
            message: `${id} cancelled before the final integration gate — resume with /task-auto-resume.`
        }
    }
    if (!deps.finalGate) return completedResult(id, taskCount, null)
    /**
     * The ONE place this stage reaches the durable debt ledger. Four distinct findings
     * feed it — an UNOBSERVED gate, an ignored-path write the gate depends on, a
     * converged autofix that observed nothing, and a check DEMOTED as unfalsifiable —
     * and they stay four calls because they are four different facts about the run.
     * What they no longer each restate is WHERE the debt goes: the run's own id, under
     * origin 'final-gate', which is what the next run's gate re-checks.
     */
    const carryDebt = (reason: string): Promise<void> => recordDebt(cwd, id, reason, 'final-gate')
    // Set when the gate finished having observed NOTHING dynamic. Declared out here so
    // the run-completion announcement can say so.
    let unobservedNote: string | null = null
    active.ui.notify(`${id}: running final integration gate…`, 'info')
    // Run-level gate trail on the parent task file — same durable auditability
    // contract as the per-task `## gates` records.
    const recGate = async (line: string): Promise<void> => {
        try {
            await deps.record?.(cwd, id, line)
        } catch {
            // recording must never break the gate
        }
    }
    // Trail EVERY aggregated failure entry (mx5 run 13): the gate runs all sections
    // and ranks the list; a single sliced reason line would re-hide everything past
    // the first entry.
    const trailGateFail = async (f: {reason: string; failures?: string[]}): Promise<void> => {
        const list = f.failures ?? [f.reason]
        if (list.length <= 1) {
            await recGate(`final-gate: FAIL — ${f.reason.slice(0, 300)}`)
            return
        }
        await recGate(
            `final-gate: FAIL — ${list.length} failures (ranked, most load-bearing first)`
        )
        for (const [i, entry] of list.entries()) {
            await recGate(`final-gate FAIL ${i + 1}/${list.length}: ${entry.slice(0, 300)}`)
        }
    }
    let fin: FinalGateOutcome = await deps.finalGate(cwd, planText)
    // Record the outcome symmetrically (mx5 run 10 item 7): only FAIL was ever
    // trailed, so a PASSing gate was indistinguishable from a gate that never ran. The
    // PASS reason names the commands that were run. THREE verdicts, not two
    // (final-gate.ts unobservedVerdict): a gate that observed nothing dynamic is
    // UNOBSERVED, never PASS — IAR1 shipped `PASS — no integration command found`
    // twice while carrying open verify-FAIL debt. It does not block (justified there),
    // but it is labelled here, warned about, and recorded as durable debt so the next
    // run's gate re-surfaces it.
    if (fin.ok && fin.unobserved) {
        unobservedNote = fin.unobserved
        await recGate(`final-gate: UNOBSERVED — ${fin.reason.slice(0, 300)}`)
        await carryDebt(fin.unobserved)
        active.ui.notify(
            `${id}: the final integration gate observed NOTHING dynamic — `
                + 'the run completed on static checks alone. Nothing verified '
                + 'that the assembled product builds, boots or works.',
            'warning'
        )
    } else if (fin.ok) {
        await recGate(`final-gate: PASS — ${fin.reason.slice(0, 300)}`)
    } else {
        await trailGateFail(fin)
    }
    // ACCEPT-debt re-check surfacing (mx5 run 4 B3 / run 8 TASK_0012): tasks the user
    // accepted despite a verify-FAIL that the gate could not prove resolved against the
    // current tree. Surface them at the gate moment — on PASS or FAIL — so a run never
    // completes silently carrying an accepted defect. Informational: the per-task
    // ACCEPT was already a human decision, so this reports, it does not re-fail.
    const debtKey = (d: AcceptDebt): string => `${d.taskId}\t${d.reason}`
    const surfaceOpenDebts = async (debts: AcceptDebt[]): Promise<void> => {
        if (debts.length === 0) return
        for (const d of debts) {
            await recGate(
                `defect STILL OPEN — ${d.taskId || '(unknown task)'}: ${describeDebt(d)}: ${d.reason.slice(0, 240)}${
                    d.conflict ? ` [CONFLICTING CLAIM — ${d.conflict}]` : ''
                }`
            )
        }
        active.ui.notify(
            `${id}: ${debts.length} recorded verify-FAIL defect(s) are STILL unresolved at run end — see the gate trail.`,
            'warning'
        )
    }
    // What was REPORTED, so a post-autofix re-derivation can be compared against it
    // rather than blindly re-printed.
    let reportedDebts: AcceptDebt[] = fin.openDebts ?? []
    await surfaceOpenDebts(reportedDebts)
    // An owned obligation a task DETACHED (its own spec froze the only file that could
    // satisfy it, nexttask 2) and no later task claimed. Detach never deletes the
    // quote, so the run ends holding it — say so, or the resolution would be a quieter
    // version of the deletion it exists to prevent.
    const unclaimed = unclaimedPendingRequirements(await readOwnedRequirements(cwd).catch(() => []))
    for (const o of unclaimed) {
        await recGate(
            `owned requirement UNCLAIMED — "${o.quote.slice(0, 200)}"`
                + ` [frozen in "${o.title.slice(0, 60)}"; no task claimed`
                + ` ${(o.pending ?? []).join(', ')}]`
        )
    }
    if (unclaimed.length > 0) {
        active.ui.notify(
            `${id}: ${unclaimed.length} authoritative design requirement(s) ended the run`
                + ' owned by NO task — the task they were mapped to could not touch the'
                + ' file, and nothing else claimed it. See the gate trail.',
            'warning'
        )
    }
    /**
     * nexttask 6 (mx5 run 18). The lines above are emitted from the FIRST gate result;
     * the converged-autofix paths below used to rebuild `fin` as `{ok, reason}`, so
     * `openDebts` did not survive the fix pass — the run's last word on its own defects
     * was a snapshot of a tree that no longer existed, and no code path could clear,
     * re-check or act on it. Re-derive here, against the tree the run actually ends
     * with, and correct the record.
     *
     * FP-safe by inheritance: `deriveOpenDebts` auto-closes only what a deterministic
     * check can stand behind (a static-class debt when the statics provably pass, a
     * cross-task-deletion whose file is back). Anything model-judged or behavioral
     * STAYS OPEN — `inv-no-false-clear`. `staticOk` is therefore only ever passed true
     * where the gate itself just passed the statics.
     */
    const reconcileDebts = async (staticOk: boolean): Promise<void> => {
        if (!deps.recheckOpenDebts) return
        let fresh: {openDebts: AcceptDebt[]; debtNote?: string; trail?: string[]}
        try {
            fresh = await deps.recheckOpenDebts(cwd, staticOk)
        } catch {
            // A ledger read fault is inconclusive: say nothing rather than imply the
            // defects cleared.
            return
        }
        fin = {
            ...fin,
            openDebts: fresh.openDebts,
            ...(fresh.debtNote ? {debtNote: fresh.debtNote} : {})
        }
        // Per-debt evidence from the VERIFY-COMMAND re-check (nexttask 5): which
        // command was re-run and what it did. A close that cannot be read back from
        // the trail is a close nobody can audit, and an INCONCLUSIVE re-run is worth
        // saying out loud — it is the difference between "still broken" and "nothing
        // could observe it".
        for (const line of fresh.trail ?? []) {
            await recGate(`defect re-check: ${line}`)
        }
        // Identity is (task, origin, reason), but a RESOLUTION claim needs more than a
        // key miss: a ledger entry whose TEXT changed is the same defect re-recorded,
        // never a fix. So a debt counts as closed only when nothing for that (task,
        // origin) survives.
        const slot = (d: AcceptDebt): string => `${d.taskId}\t${d.origin ?? ''}`
        const before = new Set(reportedDebts.map(debtKey))
        const after = new Set(fresh.openDebts.map(debtKey))
        const beforeSlots = new Set(reportedDebts.map(slot))
        const afterSlots = new Set(fresh.openDebts.map(slot))
        const closed = reportedDebts.filter(d => !after.has(debtKey(d)) && !afterSlots.has(slot(d)))
        const added = fresh.openDebts.filter(
            d => !before.has(debtKey(d)) && !beforeSlots.has(slot(d))
        )
        if (closed.length === 0 && added.length === 0) {
            if (reportedDebts.length > 0) {
                await recGate(
                    `defect re-check after autofix: all ${reportedDebts.length} defect(s) `
                        + 'above re-derived against the FINAL tree and still open'
                )
            }
            return
        }
        for (const d of closed) {
            await recGate(
                `defect RESOLVED — ${d.taskId || '(unknown task)'}: ` + `${d.reason.slice(0, 240)}`
            )
        }
        await surfaceOpenDebts(added)
        reportedDebts = fresh.openDebts
        await recGate(
            `defect re-check after autofix: ${closed.length} resolved, `
                + `${fresh.openDebts.length} still open (re-derived against the FINAL tree)`
        )
    }
    // Resolution loop: Leave-failed (recommended) / Autofix (bounded, model-driven fix
    // pass + gate re-run — run 7's gap: the picker had NO automated fix path) /
    // Accept. The user always decides; after MAX_FINAL_GATE_AUTOFIX attempts that
    // still FAIL the autofix card is withdrawn so the loop cannot run unbounded.
    let fixAttempts = 0
    // Gitignored paths the fix passes have written so far in this resolution loop (mx5
    // run 19). Accumulated across attempts: a `.env` written by a failed attempt is
    // still on disk for the next one, and that attempt's own before/after diff cannot
    // see it.
    let ignoredWritten: string[] = []
    // Sub-fixes a non-converging autofix attempt left uncommitted. Refreshed after
    // every attempt; drives the picker note and the terminal commit (mx5 run 13 PROMPT
    // 4 item 3, run 14 item 2b).
    let stranded: string[] = []
    const refreshStranded = async (): Promise<void> => {
        if (!deps.pendingChanges) return
        try {
            stranded = await deps.pendingChanges(cwd)
        } catch {
            // Inconclusive: say nothing rather than claim a clean tree.
            stranded = []
        }
    }
    // NON-PROGRESS / UNFALSIFIABLE-CHECK state (mx5 run 14 item 2a). `prevFailSig` is
    // the previous attempt's normalized ranked-first failure; `demoted` holds the
    // signatures already carried as debt, so a re-run that still reports them does not
    // re-fail the gate.
    let prevFailSig: string | null = null
    const demoted = new Set<string>()
    // Set when a write-guard rejected an attempt whose edits could NOT be discarded:
    // REJECTED edits are then sitting in the tree and must never be committed by the
    // terminal paths below.
    let rejectedEditsInTree = false
    // Commit whatever guard-clean repairs the fix passes left, on ANY terminal
    // non-converged outcome. Run 14 ended on LEAVE with 13 real repairs dirty in the
    // tree after an unattended run — the next checkout would have destroyed them
    // silently.
    const commitStranded = async (outcome: 'accepted' | 'left-failed'): Promise<void> => {
        if (stranded.length === 0) return
        if (rejectedEditsInTree) {
            await recGate(
                `final-gate: NOT committing ${stranded.length} working-tree change(s) — a `
                    + `write-guard rejected an attempt and its edits could not be discarded, `
                    + `so the tree holds REJECTED edits: ${stranded.slice(0, 8).join(', ')}`
            )
            return
        }
        // REPORT WHAT ACTUALLY HAPPENED (mx5 run 20). This bound the CommitResult to
        // `sha` and interpolated it, so the trail read "committed 5 stranded fix-pass
        // change(s) as [object Object]". Worse than cosmetic: `commit` returns
        // {committed, reason?, note?} and NEVER a sha, the `committed` field was never
        // read, and gitCommitAll returns {committed:false} WITHOUT throwing on an
        // unmerged index — so on that path the catch below never fires and the trail
        // claimed a commit over changes that were still sitting in the working tree.
        const notCommitted = async (why: string): Promise<void> => {
            await recGate(
                `final-gate: could NOT commit ${stranded.length} stranded fix-pass `
                    + `change(s) (${why}) — they remain UNCOMMITTED in the working `
                    + `tree: ${stranded.slice(0, 8).join(', ')}`
            )
        }
        try {
            const res = await deps.commit(cwd, STRANDED_FIX_COMMIT(id, outcome))
            if (res.committed) {
                await recGate(
                    `final-gate: committed ${stranded.length} stranded fix-pass change(s)`
                        + `${res.note ? ` (${res.note})` : ''} — ${stranded.slice(0, 8).join(', ')}`
                )
            } else {
                await notCommitted(res.reason ?? 'unknown')
            }
        } catch (err) {
            // Never break the terminal path over this — but say so, so the changes are
            // not silently lost.
            await notCommitted(err instanceof Error ? err.message : String(err))
        }
    }
    while (!fin.ok) {
        const canAutofix = deps.finalGateFix !== undefined && fixAttempts < MAX_FINAL_GATE_AUTOFIX
        // The picker question shows the debts (the HUMAN weighs them); the autofix seed
        // below deliberately does not — mx5 run 11's fix child executed a debt claim as
        // an `rm` instruction.
        const question =
            `Final integration gate FAILED for ${id}.\n\n${fin.reason}${fin.debtNote ?? ''}\n\n`
            + 'All tasks are checked off — this is the whole-repo check '
            + '(the project’s own test/build/static commands, run unaided).'
            + (fixAttempts > 0 ?
                `\n\nAutofix attempts so far: ${fixAttempts}/${MAX_FINAL_GATE_AUTOFIX}.`
            :   '')
            // Never let a partial repair be invisible at the moment the human decides
            // (run 13: a bunfig fix that made `bun run test` pass 116/116 was stranded
            // by an ACCEPT).
            + strandedFixNote(stranded)
        // YOLO: keep autofixing WHILE the card is still offered — the loop withdraws it
        // after MAX_FINAL_GATE_AUTOFIX, so the cap that bounds a non-converging fix pass
        // still bounds this — then LEAVE the run failed. Never 'accept': an unattended
        // run that could not green the whole-repo gate has not produced a working
        // project, and mx5 run 13 shows what an accepted FAIL looks like afterwards (a
        // shipped app that 404s at `/`).
        const yoloFinal = yoloFinalGateChoice(isYoloMode(), canAutofix)
        if (yoloFinal !== null) {
            await recGate(`final-gate: auto-chose ${yoloFinal.action.toUpperCase()} ${YOLO_STAMP}`)
        }
        const answer =
            yoloFinal !== null ?
                yoloFinal.action === 'autofix' ?
                    FINAL_AUTOFIX_VALUE
                :   FINAL_LEAVE_VALUE
            :   await askFinalGateResolution(active, question, canAutofix)
        const choice = classifyFinalGateAnswer(answer)
        if (choice.action === 'accept') {
            await recGate('final-gate: FAIL accepted by user')
            // STRANDED SUB-FIXES: the run completes here, so anything the fix pass
            // repaired but never committed would be lost to the next `git checkout`
            // while HEAD keeps the defect it fixed. Commit it as its own, named
            // commit — the ACCEPT is a decision about the FAILING gate, never an
            // instruction to throw away work (mx5 run 13 item 3).
            await commitStranded('accepted')
            active.ui.notify(
                `${id}: final integration gate FAIL accepted by user — completing.`
                    + (stranded.length > 0 ?
                        ` ${stranded.length} uncommitted fix-pass change(s) committed separately.`
                    :   ''),
                'warning'
            )
            break
        }
        if (choice.action === 'autofix' && canAutofix) {
            fixAttempts += 1
            await recGate(
                `final-gate: user chose AUTOFIX (attempt ${fixAttempts}/${MAX_FINAL_GATE_AUTOFIX})`
            )
            active.ui.notify(
                `${id}: final-gate autofix (${fixAttempts}/${MAX_FINAL_GATE_AUTOFIX}) — bounded fix pass, then the gate re-runs…`,
                'info'
            )
            const seed =
                choice.guidance ? `${fin.reason}\n\nUser guidance: ${choice.guidance}` : fin.reason
            const fix = await deps.finalGateFix!(active, cwd, seed, ignoredWritten)
            // IGNORED-PATH WRITES (mx5 run 19). The pass wrote file(s) git ignores, so
            // they are not in the commit and a fresh clone does not have them. Trailed
            // on EVERY outcome — a rejected attempt's tracked edits are discarded while
            // its ignored writes survive on disk — and carried forward, so a later
            // attempt's PASS is judged against everything this loop wrote, not just its
            // own attempt. PATH NAMES ONLY: an ignored file's contents (`.env` is the
            // canonical case) never enter a log, a debt or a child prompt.
            if (fix.ignoredWrites && fix.ignoredWrites.length > 0) {
                ignoredWritten = [...new Set([...ignoredWritten, ...fix.ignoredWrites])].sort()
                await recGate(ignoredWriteTrailLine(fix.ignoredWrites))
                // Debt only where a verdict can rest on the file: the probe proved the
                // gate needs it, or the question stayed open. A write the gate
                // demonstrably does NOT need is trailed and nothing more — a ledger
                // full of scratch files is a ledger nobody reads.
                if (fix.ignoredDependent !== false) {
                    await carryDebt(ignoredWriteDebtReason(fix.ignoredWrites, fix.ignoredDependent))
                }
            }
            if (fix.ok) {
                await deps.commit(cwd, `FINAL GATE AUTOFIX (${id})`)
                // A converged re-run that observed nothing dynamic is UNOBSERVED on
                // this door too — never announce it as a PASS just because it arrived
                // via autofix.
                if (fix.unobserved) {
                    unobservedNote = fix.unobserved
                    await carryDebt(fix.unobserved)
                }
                await recGate(
                    `final-gate: autofix ${fix.unobserved ? 'ended UNOBSERVED' : 'converged'} — ${fix.reason.slice(0, 200)}`
                )
                active.ui.notify(
                    `${id}: final integration gate ${fix.unobserved ? 'is UNOBSERVED' : 'PASSES'} after autofix — ${fix.reason.slice(0, 140)}`,
                    fix.unobserved ? 'warning' : 'info'
                )
                fin = {ok: true, reason: fix.reason}
                // The gate itself just passed, statics included, so `staticOk` here is
                // proof rather than assumption.
                await reconcileDebts(true)
                break
            }
            await recGate(
                `final-gate: autofix attempt ${fixAttempts} failed — ${fix.reason.slice(0, 200)}`
            )
            // A guard that rejected an attempt WITHOUT discarding leaves rejected edits
            // behind: the terminal paths must not commit the tree after that (the cheat
            // guard stays intact).
            if (fix.guardTripped === true && fix.editsDiscarded !== true) {
                rejectedEditsInTree = true
            }
            // The attempt's edits survive a non-convergence (only a guard trip
            // discards). Find out what they are NOW, so the next picker shows them and
            // a terminal outcome commits them.
            await refreshStranded()
            if (stranded.length > 0) {
                await recGate(
                    `final-gate: autofix attempt ${fixAttempts} left ${stranded.length} `
                        + `uncommitted change(s) — ${stranded.slice(0, 8).join(', ')}`
                )
            }
            active.ui.notify(
                `${id}: final-gate autofix did not converge — ${fix.reason.slice(0, 140)}`,
                'warning'
            )
            // NON-PROGRESS CLASSIFIER (mx5 run 14 item 2a). An attempt that changed the
            // tree, re-ran the gate, and got back the SAME ranked-first failure as the
            // previous such attempt is evidence about the CHECK, not the fix: run 14
            // burned all three attempts on a boot probe that could not observe a
            // listener in that sandbox at all. Demote that one check to
            // UNOBSERVED-with-debt and let the REMAINING checks decide.
            const detail = rankedFirstFailure({
                reason: fix.gateReason,
                failures: fix.gateFailures
            })
            const edited = fix.gateReason !== undefined && stranded.length > 0
            // …and whether a PROBE OBSERVED this failure (nexttask 19A). Exact text
            // identity against the gate's own observed subset — not a second string
            // pattern, which is the mistake `isNonProgress` already made once.
            const observed = fix.gateObservedFailures?.includes(detail ?? '') === true
            if (
                detail !== null
                && isNonProgress({
                    previousSignature: prevFailSig,
                    currentDetail: detail,
                    edited,
                    observed
                })
            ) {
                demoted.add(normalizeFailureDetail(detail))
                prevFailSig = null
                await carryDebt(unobservedDebtReason(detail))
                await recGate(
                    `final-gate: check DEMOTED to UNOBSERVED after ${fixAttempts} tree-changing `
                        + `attempts returned an identical failure — carried as debt (origin final-gate) `
                        + `and re-checked by the next run's gate: ${detail.slice(0, 240)}`
                )
                active.ui.notify(
                    `${id}: final-gate check is unfalsifiable in this environment — carried as debt; `
                        + 'the remaining checks decide convergence.',
                    'warning'
                )
            } else {
                prevFailSig = detail !== null ? normalizeFailureDetail(detail) : null
            }
            // Convergence on the REMAINING checks: a demoted signature no longer counts
            // against the gate. Nothing left ⇒ the run converges carrying the demotion
            // as debt, and the fix passes' repairs are committed rather than stranded.
            if (demoted.size > 0 && fix.gateReason !== undefined) {
                const remaining = applyDemotions(fix.gateFailures ?? [fix.gateReason], demoted)
                if (remaining.length === 0) {
                    await deps.commit(cwd, `FINAL GATE AUTOFIX (${id})`)
                    const converged =
                        `converged on all remaining checks; ${demoted.size} check(s) `
                        + 'carried as UNOBSERVED debt (unfalsifiable in this environment)'
                    await recGate(`final-gate: ${converged}`)
                    active.ui.notify(
                        `${id}: final integration gate converged — ${converged}.`,
                        'warning'
                    )
                    fin = {ok: true, reason: converged}
                    // Converged on the REMAINING checks only: one or more were DEMOTED
                    // as unfalsifiable here, and the statics may be among them. No
                    // proof ⇒ pass false, so nothing static-class can auto-close on
                    // this door (inv-no-false-clear).
                    await reconcileDebts(false)
                    break
                }
            }
            // Work from the FRESH gate failure when the fix pass got as far as
            // re-running the gate; otherwise keep the last. The full ranked list rides
            // along (and is re-trailed when fresh) so the next picker and the next fix
            // seed still carry every entry, not just the first. The debt note is
            // carried so the next picker still shows the open claims (the seed never
            // includes it). Demoted checks are stripped from what rides forward, so the
            // next picker and the next fix seed target only what is still falsifiable —
            // never re-aiming the child at the check the classifier just proved it
            // cannot move.
            const freshFailures = fix.gateReason !== undefined ? fix.gateFailures : fin.failures
            const carried =
                freshFailures !== undefined ? applyDemotions(freshFailures, demoted) : undefined
            fin = {
                ok: false,
                reason:
                    demoted.size > 0 && carried !== undefined && carried.length > 0 ?
                        carried[0]!
                    :   (fix.gateReason ?? fin.reason),
                failures: carried,
                debtNote: fin.debtNote
            }
            if (fix.gateReason !== undefined && (fix.gateFailures?.length ?? 0) > 1) {
                await trailGateFail(fin)
            }
            continue
        }
        // Leave failed — the dismissal default, unchanged from the two-option picker
        // (an unavailable autofix demotes here too).
        await recGate(
            yoloFinal !== null ?
                `final-gate: left failed — autofix budget spent, nobody to ask ${YOLO_STAMP}`
            :   'final-gate: left failed (user)'
        )
        // Leaving the run failed is TERMINAL for an unattended run, so the fix passes'
        // guard-clean repairs are committed here too — run 14 left 13 of them dirty for
        // a `git checkout` to destroy (mx5 run 13 item 3, run 14 item 2b). The user
        // still owns the outcome; they own it with the work in HEAD, named in the trail.
        await commitStranded('left-failed')
        return {
            kind: 'failed',
            message:
                `${id} finished all tasks but FAILED the final integration gate — ${fin.reason.slice(0, 200)} — fix and /task-auto-resume (the gate re-runs).`
                + (stranded.length > 0 ?
                    ` NOTE: ${stranded.length} fix-pass change(s) were committed separately (${stranded.slice(0, 4).join(', ')}).`
                :   '')
        }
    }
    return completedResult(id, taskCount, unobservedNote)
}
