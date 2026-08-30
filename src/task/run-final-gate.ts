/**
 * run-final-gate — the RUN-LEVEL final integration gate, the twin of task-gates.ts.
 *
 * task-gates.ts gates ONE task against its own spec. This gates the WHOLE REPO once,
 * when every task in a /task-auto run is checked off and BEFORE the run is declared
 * complete. Every task passing its own per-slice gate does not prove the assembled
 * whole works, so the project's OWN whole-repo commands run once here, unaided.
 *
 * The stage owns four things the per-task gate has no equivalent of:
 *
 *   1. THREE verdicts, not two — PASS / FAIL / UNOBSERVED. A gate that observed
 *      nothing dynamic is never announced as a pass (gate-tally.ts
 *      `unobservedVerdict`).
 *   2. The run-end ACCEPT-debt report — every defect a task was allowed to ship with,
 *      surfaced at the last moment anyone will look, and RE-DERIVED against the final
 *      tree after a converged autofix so the last word is about the tree that shipped.
 *   3. The resolution loop — Leave-failed (recommended) / Autofix (a bounded,
 *      model-driven fix pass + gate re-run) / Accept, with the autofix card withdrawn
 *      after MAX_FINAL_GATE_AUTOFIX so a non-converging fix pass cannot loop forever.
 *   4. The stranded sub-fixes a non-converging fix pass leaves in the working tree —
 *      committed on EVERY terminal outcome, because both of them end the run and the
 *      next `git checkout` would destroy real repairs.
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
import {AutofixLedger} from './autofix-ledger.js'
import {describeDebt, recordDebt, type AcceptDebt, type DebtOrigin} from './accept-debt.js'
import {cancelCheckpoint} from './cancel-points.js'
import {SessionUI} from '../remote/bridge.js'
import {isYoloMode, yoloFinalGateChoice, YOLO_STAMP} from './yolo.js'
import {ignoredWriteTrailLine, ignoredWriteDebtReason} from './write-guard.js'
import {readOwnedRequirements, type OwnedRequirement} from './requirements.js'
import {unclaimedPendingRequirements} from './owned-freeze-reassign.js'
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
     * detect SUB-FIXES a non-converging fix pass left behind (item 4 in the header).
     * Every task is committed by the time this stage runs, so anything dirty here is
     * the fix pass's own work. Absent → the stranded-fix handling is skipped
     * entirely (prior behavior).
     */
    pendingChanges?: (cwd: string) => Promise<string[]>
    /**
     * Re-derive the still-open ACCEPT-debt ledger against the tree AS IT IS NOW
     * (`deriveOpenDebts`, defined in accept-debt.ts and re-exported by
     * final-gate.ts). Needed because the run's "N recorded verify-FAIL defect(s) are
     * STILL unresolved" report is built from the FIRST gate result: without this, an
     * autofix that converged after that report would leave the run's last word about
     * a tree that no longer exists.
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
    /**
     * Write one ACCEPT debt to the ledger. The run-level twin of `GateDeps.recordDebt`,
     * and injectable for the same reason: without it a test that only wants to observe
     * WHICH debts a scenario carries has to write, and then read back, the real ledger
     * on disk. Absent → the real `accept-debt.ts` writer, so production wiring and the
     * prior behaviour are unchanged.
     */
    recordDebt?: (cwd: string, taskId: string, reason: string, origin: DebtOrigin) => Promise<void>
    /**
     * Read the owned-requirement ledger, to report obligations a task DETACHED and no
     * later task claimed. Absent → the real `requirements.ts` reader (prior behaviour);
     * injectable so that check is testable without seeding a real ledger file.
     */
    ownedRequirements?: (cwd: string) => Promise<OwnedRequirement[]>
}

/** Inputs that vary per caller. */
export interface FinalGateStageParams {
    cwd: string
    /** The parent /task-auto id: trail target, notify prefix, commit-message tag. */
    runId: string
    /** The parent plan (the task list), handed to the gate so it can tell a served app
     *  from a CLI — the boot check requires a listener only for the former. Without
     *  that distinction any long-lived process, a file watcher included, satisfies
     *  "still alive". */
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
 * Shares no state with /task-auto's run loop: the stage reads no per-task variable
 * and writes none. Never throws for a gate outcome — only a user cancel inside a
 * gate child propagates (the caller's USER_CANCELLED path handles it).
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
    const carryDebt = (reason: string): Promise<void> =>
        (deps.recordDebt ?? recordDebt)(cwd, id, reason, 'final-gate')
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
    // Trail EVERY aggregated failure entry: the gate runs all sections and ranks the
    // list, so a single sliced reason line would hide everything past the first.
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
    // Record the outcome SYMMETRICALLY — trailing only FAIL would leave a passing
    // gate indistinguishable from a gate that never ran, and the PASS reason names
    // the commands that were run. THREE verdicts, not two (gate-tally.ts
    // `unobservedVerdict`): a gate that observed nothing dynamic is UNOBSERVED, never
    // PASS. It does not block, but it is labelled here, warned about, and recorded as
    // durable debt so the next run's gate re-surfaces it.
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
    // ACCEPT-debt surfacing: tasks the user accepted despite a verify-FAIL that the
    // gate could not prove resolved against the current tree. Surface them at the gate moment — on PASS or FAIL — so a run never
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
    // An owned obligation a task DETACHED — its own spec froze the only file that
    // could satisfy it — and no later task claimed. Detach never deletes the quote, so
    // the run ends holding it. Say so, or the detach becomes a quieter version of the
    // deletion it exists to prevent.
    const unclaimed = unclaimedPendingRequirements(
        await (deps.ownedRequirements ?? readOwnedRequirements)(cwd).catch(() => [])
    )
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
     * Re-derive the debt report against the tree the run actually ends with.
     *
     * The lines above are emitted from the FIRST gate result, so without this the
     * run's last word on its own defects describes a tree the autofix has since
     * changed.
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
        // Per-debt evidence from the VERIFY-COMMAND re-check: which
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
    // Resolution loop: Leave-failed (recommended) / Autofix (bounded, model-driven
    // fix pass + gate re-run) / Accept. The user always decides; after
    // MAX_FINAL_GATE_AUTOFIX attempts that still FAIL the autofix card is withdrawn,
    // so the loop cannot run unbounded.
    //
    // Everything the loop remembers lives in the ledger, not in closure locals: the
    // attempt count and its bound, the accumulated gitignored writes, the stranded
    // sub-fixes, the previous failure signature, the demoted set and the
    // rejected-edits flag. That keeps the non-progress rule where its evidence is.
    // `GateTally`'s twin, one altitude up (autofix-ledger.ts).
    const ledger = new AutofixLedger(MAX_FINAL_GATE_AUTOFIX)
    const refreshStranded = async (): Promise<void> => {
        if (!deps.pendingChanges) return
        try {
            ledger.setStranded(await deps.pendingChanges(cwd))
        } catch {
            // Inconclusive: say nothing rather than claim a clean tree.
            ledger.setStranded([])
        }
    }
    // Commit whatever guard-clean repairs the fix passes left, on ANY terminal
    // non-converged outcome. A run that ends on LEAVE can hold real repairs dirty in
    // the tree, and the next checkout would destroy them silently.
    const commitStranded = async (outcome: 'accepted' | 'left-failed'): Promise<void> => {
        const stranded = ledger.stranded()
        if (stranded.length === 0) return
        if (!ledger.mayCommitTree()) {
            await recGate(
                `final-gate: NOT committing ${stranded.length} working-tree change(s) — a `
                    + `write-guard rejected an attempt and its edits could not be discarded, `
                    + `so the tree holds REJECTED edits: ${stranded.slice(0, 8).join(', ')}`
            )
            return
        }
        // REPORT WHAT ACTUALLY HAPPENED, which means reading `committed`. A
        // CommitResult is {committed, reason?, note?} and carries NO sha, and
        // gitCommitAll answers {committed:false} WITHOUT throwing — so a trail line
        // written from the catch alone would claim a commit over changes still sitting
        // in the working tree.
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
        const canAutofix = deps.finalGateFix !== undefined && ledger.canAutofix()
        // The picker question shows the debts, because the HUMAN weighs them. The
        // autofix seed below deliberately does not: a debt claim is prose about a
        // defect, and a write-enabled child reads prose as an instruction.
        const question =
            `Final integration gate FAILED for ${id}.\n\n${fin.reason}${fin.debtNote ?? ''}\n\n`
            + 'All tasks are checked off — this is the whole-repo check '
            + '(the project’s own test/build/static commands, run unaided).'
            + (ledger.attempts() > 0 ?
                `\n\nAutofix attempts so far: ${ledger.attempts()}/${MAX_FINAL_GATE_AUTOFIX}.`
            :   '')
            // Never let a partial repair be invisible at the moment the human
            // decides — an ACCEPT here would otherwise strand a real fix.
            + strandedFixNote([...ledger.stranded()])
        // YOLO: keep autofixing WHILE the card is still offered — the loop withdraws it
        // after MAX_FINAL_GATE_AUTOFIX, so the cap that bounds a non-converging fix pass
        // still bounds this — then LEAVE the run failed. Never 'accept': an unattended
        // run that could not green the whole-repo gate has not produced a working
        // project, and nobody is there to judge the FAIL it would be accepting.
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
            // instruction to throw away work.
            await commitStranded('accepted')
            active.ui.notify(
                `${id}: final integration gate FAIL accepted by user — completing.`
                    + (ledger.stranded().length > 0 ?
                        ` ${ledger.stranded().length} uncommitted fix-pass change(s) committed separately.`
                    :   ''),
                'warning'
            )
            break
        }
        if (choice.action === 'autofix' && canAutofix) {
            const attempt = ledger.attempt()
            await recGate(
                `final-gate: user chose AUTOFIX (attempt ${attempt}/${MAX_FINAL_GATE_AUTOFIX})`
            )
            active.ui.notify(
                `${id}: final-gate autofix (${attempt}/${MAX_FINAL_GATE_AUTOFIX}) — bounded fix pass, then the gate re-runs…`,
                'info'
            )
            const seed =
                choice.guidance ? `${fin.reason}\n\nUser guidance: ${choice.guidance}` : fin.reason
            const fix = await deps.finalGateFix!(active, cwd, seed, [...ledger.ignoredWrites()])
            // IGNORED-PATH WRITES. The pass wrote file(s) git ignores, so
            // they are not in the commit and a fresh clone does not have them. Trailed
            // on EVERY outcome — a rejected attempt's tracked edits are discarded while
            // its ignored writes survive on disk — and carried forward, so a later
            // attempt's PASS is judged against everything this loop wrote, not just its
            // own attempt. PATH NAMES ONLY: an ignored file's contents (`.env` is the
            // canonical case) never enter a log, a debt or a child prompt.
            if (fix.ignoredWrites && fix.ignoredWrites.length > 0) {
                ledger.wroteIgnored(fix.ignoredWrites)
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
                // The gate's own outcome, WHOLE, with this door's reason on it.
                // Rebuilding it as a two-key literal would drop `openDebts` and
                // `observedFailures` from the value entirely.
                fin = {...(fix.gate ?? fin), ok: true, reason: fix.reason}
                // The gate itself just passed, statics included, so `staticOk` here is
                // proof rather than assumption.
                await reconcileDebts(true)
                break
            }
            await recGate(
                `final-gate: autofix attempt ${attempt} failed — ${fix.reason.slice(0, 200)}`
            )
            // A guard that rejected an attempt WITHOUT discarding leaves rejected edits
            // behind: the terminal paths must not commit the tree after that (the cheat
            // guard stays intact).
            if (fix.guardTripped === true && fix.editsDiscarded !== true) {
                ledger.rejectedEditsRemain()
            }
            // The attempt's edits survive a non-convergence (only a guard trip
            // discards). Find out what they are NOW, so the next picker shows them and
            // a terminal outcome commits them.
            await refreshStranded()
            if (ledger.stranded().length > 0) {
                await recGate(
                    `final-gate: autofix attempt ${attempt} left ${ledger.stranded().length} `
                        + `uncommitted change(s) — ${ledger.stranded().slice(0, 8).join(', ')}`
                )
            }
            active.ui.notify(
                `${id}: final-gate autofix did not converge — ${fix.reason.slice(0, 140)}`,
                'warning'
            )
            // NON-PROGRESS CLASSIFIER. An attempt that changed the tree, re-ran the
            // gate, and got back the SAME ranked-first failure as the previous such
            // attempt is evidence about the CHECK, not about the fix — a check that
            // cannot observe anything in this environment answers identically however
            // the tree moves. Demote that one check to UNOBSERVED-with-debt and let
            // the REMAINING checks decide.
            //
            // The judgement, the observed check and the signature carry-forward are
            // the ledger's — made where the evidence is, not downstream from it.
            const verdict = ledger.judge(
                fix.gate,
                fix.gate !== undefined && ledger.stranded().length > 0
            )
            if (verdict.demoted) {
                await carryDebt(verdict.debtReason!)
                await recGate(
                    `final-gate: check DEMOTED to UNOBSERVED after ${attempt} tree-changing `
                        + `attempts returned an identical failure — carried as debt (origin final-gate) `
                        + `and re-checked by the next run's gate: ${verdict.detail!.slice(0, 240)}`
                )
                active.ui.notify(
                    `${id}: final-gate check is unfalsifiable in this environment — carried as debt; `
                        + 'the remaining checks decide convergence.',
                    'warning'
                )
            }
            // Convergence on the REMAINING checks: a demoted signature no longer counts
            // against the gate. Nothing left ⇒ the run converges carrying the demotion
            // as debt, and the fix passes' repairs are committed rather than stranded.
            if (ledger.hasDemotions() && fix.gate !== undefined) {
                const remaining = ledger.remaining(fix.gate)
                if (remaining !== undefined && remaining.length === 0) {
                    await deps.commit(cwd, `FINAL GATE AUTOFIX (${id})`)
                    const converged =
                        `converged on all remaining checks; ${ledger.demotedCount()} check(s) `
                        + 'carried as UNOBSERVED debt (unfalsifiable in this environment)'
                    await recGate(`final-gate: ${converged}`)
                    active.ui.notify(
                        `${id}: final integration gate converged — ${converged}.`,
                        'warning'
                    )
                    // The gate's own outcome, with this door's reason on it — the
                    // whole value, so `openDebts` survives the assignment.
                    fin = {...fix.gate, ok: true, reason: converged}
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
            // Outcome to outcome, WHOLE. The base is the FRESH gate outcome when the
            // fix pass got as far as re-running it, otherwise the one we already hold;
            // either way it is spread rather than rebuilt, so no field (`openDebts`,
            // `observedFailures`) is dropped by the assignment.
            const base = fix.gate ?? fin
            const carried = base.failures === undefined ? undefined : ledger.remaining(base)
            fin = {
                ...base,
                ok: false,
                reason:
                    ledger.hasDemotions() && carried !== undefined && carried.length > 0 ?
                        carried[0]!
                    :   base.reason,
                ...(carried === undefined ? {} : {failures: carried}),
                // The debt NOTE is the caller's running one: the next picker must
                // still show the open claims, and the fresh gate's own note is
                // reconciled separately against the final tree.
                ...(fin.debtNote === undefined ? {} : {debtNote: fin.debtNote})
            }
            if (fix.gate !== undefined && (fix.gate.failures?.length ?? 0) > 1) {
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
        // guard-clean repairs are committed here too, rather than left dirty for a
        // `git checkout` to destroy. The user still owns the outcome; they own it with
        // the work in HEAD, named in the trail.
        await commitStranded('left-failed')
        return {
            kind: 'failed',
            message:
                `${id} finished all tasks but FAILED the final integration gate — ${fin.reason.slice(0, 200)} — fix and /task-auto-resume (the gate re-runs).`
                + (ledger.stranded().length > 0 ?
                    ` NOTE: ${ledger.stranded().length} fix-pass change(s) were committed separately (${ledger.stranded().slice(0, 4).join(', ')}).`
                :   '')
        }
    }
    return completedResult(id, taskCount, unobservedNote)
}
