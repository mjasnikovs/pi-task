/**
 * task-gates — the post-implementation GATE sequence shared by /task-auto's per-task
 * loop and the single /task command.
 *
 * After a task's implementation turn settles, the same two gates run against the
 * just-finished work:
 *
 *   1. VERIFY — RUN the composed spec's VERIFY block in the real workspace and
 *      judge a PASS/FAIL. On a FAIL a fresh read-only child recommends AUTOFIX or
 *      ACCEPT: an AUTOFIX recommendation re-runs the implementation turn UNATTENDED
 *      (no prompt) and loops back to the gate, bounded by MAX_AUTO_AUTOFIX; the user
 *      is shown the boxed picker only when the recommendation is ACCEPT (blessing the
 *      artifact as-is) or when that unattended-autofix cap is reached.
 *   2. ENFORCE — hold the committed work to the project's AGENTS.md / CLAUDE.md
 *      rules. Runs in `edit` mode (fix in place) only when the verify gate produced
 *      a genuine clean pass to guard the edits against; otherwise `flag` mode
 *      (read-only, report don't fix). An edit pass that regresses the verify signal
 *      is reverted.
 *
 * Both gates are no-ops when their config flag is off (the injected deps return a
 * disabled pass), so wiring this into a command is inert until the user enables
 * `verify work` / `enforce guidelines` in /task-config.
 *
 * The sequence is parameterised so each caller supplies the parent-specific glue
 * (notify prefix, the autofix scope fence, and the "mark verified" step — a parent
 * task-list check-off for /task-auto, a no-op for /task). Terminal outcomes are
 * returned as a discriminated GateResult; the caller turns them into its own
 * announce + state changes (the resume command differs: /task-auto-resume vs
 * /task-resume).
 */
import type {ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import type {RunSingleTaskResult} from './orchestrator.js'
import type {CommitResult} from './auto-commit.js'
import type {VerifyOutcome} from './verify-work.js'
import type {EnforceOutcome} from './enforce-guidelines.js'
import {
    resolutionOptions,
    classifyResolutionAnswer,
    type ResolutionOutcome,
    type ResolutionChoice
} from './verify-resolution.js'
import {SessionUI} from '../remote/bridge.js'
import {isYoloMode, yoloVerifyResolution, YOLO_STAMP} from './yolo.js'
import {findRepairCandidate, type RepairCandidate} from './root-cause-repair.js'

/**
 * The deps the gate sequence drives. A superset of these is built once per command
 * by buildGateDeps; AutoDeps extends this with the planning-only `runChild`. Every
 * gate dep is injected so the sequence is testable without spawning pi, and so the
 * optional gates (verify/enforce/recommend/revert) can be absent in tests or when
 * their config flag is off — the sequence then treats them as a pass / no-op.
 */
export interface GateDeps {
    /**
     * Re-run a task's implementation turn (AUTOFIX after a verify FAIL). Resumes
     * the same inner task id, optionally fenced by a plan scope and led by a
     * RE-ATTEMPT banner naming the verification failure.
     */
    runTask: (
        ctx: ExtensionCommandContext,
        cwd: string,
        title: string,
        opts?: {
            resumeId?: string
            onStart?: (taskId: string) => void | Promise<void>
            planContext?: string
            fixInstruction?: string
        }
    ) => Promise<RunSingleTaskResult>
    /** Snapshot the working tree into one commit after a task passes. */
    commit: (cwd: string, message: string) => Promise<CommitResult>
    /**
     * Verify the just-finished task's work by RUNNING its composed spec's VERIFY
     * block in the real workspace, then reporting a PASS/FAIL verdict. Absent in
     * tests or when `verify work` is off → the sequence treats it as a pass.
     */
    verify?: (
        ctx: ExtensionCommandContext,
        cwd: string,
        taskTitle: string,
        taskId: string
    ) => Promise<VerifyOutcome>
    /**
     * Hold the committed work to AGENTS.md / CLAUDE.md. `edit` (fix in place) only
     * with a clean verify signal to guard against; otherwise `flag` (report only).
     * Absent in tests or when `enforce guidelines` is off → skipped.
     */
    enforce?: (
        ctx: ExtensionCommandContext,
        cwd: string,
        taskTitle: string,
        mode: 'edit' | 'flag'
    ) => Promise<EnforceOutcome>
    /**
     * After a verify FAIL, research whether to recommend AUTOFIX or ACCEPT — only
     * sets which card the picker tints RECOMMENDED; the user always decides. Absent
     * → the picker defaults the recommendation to AUTOFIX.
     */
    recommend?: (
        ctx: ExtensionCommandContext,
        cwd: string,
        taskTitle: string,
        taskId: string,
        failReason: string
    ) => Promise<ResolutionOutcome>
    /**
     * Discard the working-tree edits an `edit` enforcement pass made, restoring the
     * verified task commit (the differential guard's revert). Absent → the guard
     * skips the revert and warns.
     */
    revert?: (cwd: string) => Promise<void>
    /**
     * BOUNDED fix for a repo-health verify FAIL: a small read,edit,bash child fixes
     * exactly the static findings (revert-guarded — see lint-fix.ts), instead of the
     * full implementation re-run AUTOFIX reaches for. Validated live: 64s/106s to
     * lint-clean where the impl re-run burned 36–56 min and did not converge. Runs
     * at most once per gate sequence; not-applied falls through to the picker.
     * Absent → the loop goes straight to recommend/picker as before.
     */
    lintFix?: (
        ctx: ExtensionCommandContext,
        cwd: string,
        taskTitle: string,
        taskId: string,
        failReason: string
    ) => Promise<{ok: boolean; reason?: string}>
    /**
     * Deterministic whole-repo static check (repo-health), used as the PRE-COMMIT
     * gate on an edit-mode enforce pass: live data shows enforce edits broke the
     * repo's own lint in 11 of 16 tasks, each costing a commit + model re-verify +
     * revert cycle. Checking before committing skips that cycle. Absent → the old
     * commit-then-differential path runs unchanged.
     */
    repoHealth?: (cwd: string) => Promise<{ok: boolean; reason: string; output?: string}>
    /** Does the working tree hold changes (excluding .pi-tasks)? Lets the pre-commit
     *  health check run only when the enforce pass actually edited something. */
    dirty?: (cwd: string) => Promise<boolean>
    /** Restore the working tree to HEAD (excluding .pi-tasks) — discards enforce
     *  edits that failed the pre-commit health check, before they are committed. */
    discardEdits?: (cwd: string) => Promise<void>
    /**
     * Append one line to the task's durable gate trail (`## gates` in the task
     * file). Every gate outcome — each verify verdict, the user's FAIL resolution,
     * the commit result, enforce mode + verdict, the differential guard's decision —
     * is recorded so the sequence is auditable from artifacts alone (the mx5 audit
     * could not tell WHY 10 of 18 tasks show no enforce run: verdicts lived only in
     * terminal notifies). Best-effort: absent in tests → skipped; failures are
     * swallowed by the implementation, never by this sequence.
     */
    record?: (cwd: string, taskId: string, line: string) => Promise<void>
    /**
     * Record a durable ACCEPT-despite-verify-FAIL debt (task id + FAIL reason) to the
     * run-level ledger (`.pi-tasks/accept-debt.md`, see accept-debt.ts). Called only on
     * the picker's ACCEPT branch — the human blessed a failing artifact as-is, so the
     * defect is real and recorded; the final integration gate re-checks it at run end
     * and surfaces it if still open. Best-effort; absent in tests → no ledger written.
     */
    recordAcceptDebt?: (cwd: string, taskId: string, reason: string) => Promise<void>
    /**
     * Record a durable YOLO-ACCEPTED debt: the same ACCEPT branch, but reached by an
     * unattended auto-pick (yolo mode) rather than a human. Separate dep — and
     * separate ledger origin — because collapsing the two would let an auto-pick
     * read as "a human blessed this" in the final gate's run-end report. Best-effort;
     * absent in tests → no ledger written.
     */
    recordYoloAcceptDebt?: (cwd: string, taskId: string, reason: string) => Promise<void>
    /**
     * Record a durable ENFORCE-REVERT debt (mx5 run 10 item 3): the enforce re-verify
     * FAILED and the enforce edits were reverted, but the FAIL indicts the ORIGINAL
     * work (run 10 TASK_0004: "Missing server entry point … the Hono server cannot be
     * started"). Without this the diagnosis dies with the revert; recorded, the final
     * gate re-checks and surfaces it like an accept-debt. Best-effort; absent in tests.
     */
    recordEnforceRevertDebt?: (cwd: string, taskId: string, reason: string) => Promise<void>
    /**
     * Record a durable FROZEN-BLOCKED debt (mx5 run 12 / PROMPT 1 layer B): a
     * repo-health FAIL whose only fix is an edit to a path THIS task's spec froze —
     * a cross-task contradiction. Recorded when the loop routes such a FAIL to the
     * picker (whatever the human then picks, the defect is real and no task may fix
     * it), so the final gate re-checks it at run end. Best-effort; absent in tests.
     */
    recordFrozenBlockedDebt?: (cwd: string, taskId: string, reason: string) => Promise<void>
    /**
     * Record a durable CROSS-TASK DELETION debt (mx5 run 12 PROMPT 2): the task's
     * work deleted a file a DIFFERENT task's commit introduced, verify FAILed with
     * the deterministic finding attached, and the user ACCEPTed anyway — the
     * deletion ships in the next commit, so the final gate must re-check it
     * (resolved iff the file is back in the tree). Best-effort; absent in tests.
     */
    recordCrossTaskDeletionDebt?: (
        cwd: string,
        taskId: string,
        deletion: {path: string; owner: string}
    ) => Promise<void>
    /**
     * Record a durable ROOT-CAUSE debt (mx5 run 14 item 5): this task's verify
     * FAILed on a pre-existing defect in a file ANOTHER task created and this task
     * never touched. Its work is kept (it is not at fault) but the defect is real,
     * so the final gate must re-check and surface it. Best-effort; absent in tests.
     */
    recordRootCauseDebt?: (cwd: string, taskId: string, reason: string) => Promise<void>
    /**
     * Queue a scoped repair task for a root-caused defect. The gate DETECTS the
     * cause; only the /task-auto loop may mutate the plan, so the two are decoupled
     * through the durable `.pi-tasks/repair-queue.md` ledger this writes (see
     * root-cause-repair.ts). Absent (bare `/task`, tests) → detection still records
     * the debt, nothing is scheduled.
     */
    recordRepairCandidate?: (cwd: string, candidate: RepairCandidate) => Promise<void>
    /**
     * Paths the CURRENT task's own work touches — the AUTHORSHIP discriminator for
     * the root-cause channel: a FAIL blamed on a file this task edited may well be
     * this task's own fault, and only a file it never touched can be somebody
     * else's pre-existing bug. `worktree` = uncommitted changes (the pre-commit
     * verify site); `committed` = the files the task snapshot + the ENFORCE commit
     * changed (the post-commit enforce site). `null` means UNKNOWN (git
     * unavailable) and stands the whole channel down — inconclusive is never
     * evidence, so an unreadable tree can only cost a repair task, never spawn a
     * wrong one or wrongly keep a regression.
     */
    touchedFiles?: (cwd: string, scope: 'worktree' | 'committed') => Promise<string[] | null>
    /** The task whose commit INTRODUCED a file (task-provenance.ts). Null for a
     *  file predating the run or any git error → unknown provenance. */
    introducedBy?: (cwd: string, rel: string) => Promise<string | null>
    /**
     * The concrete paths this task's spec forbids modifying (its `Do NOT modify`
     * CONSTRAINTS — see frozen-path-guard.ts / prohibition-probe.ts). Used to
     * write-deny the enforce EDIT pass: a violating edit is reverted before it can
     * be committed. Empty when the spec froze nothing → the guard is a no-op.
     * Absent in tests / on a bare `/task` → the guard is skipped.
     */
    frozenPaths?: (cwd: string, taskId: string) => Promise<string[]>
    /**
     * Restore the given frozen paths to their committed (HEAD) state, discarding a
     * gate child's edits to them, and return the files actually reverted. Prompt
     * framing is A/B-proven insufficient for this class, so the deny is mechanical:
     * the write is undone, not merely warned about. Absent → the guard warns only.
     */
    revertFrozenPaths?: (cwd: string, paths: string[]) => Promise<string[]>
}

/** Inputs the sequence needs that vary per caller. */
export interface GateParams {
    cwd: string
    /** The inner task id whose spec is verified and whose work is committed. */
    taskId: string
    /** The task title — used in commit messages and user-facing notifies. */
    title: string
    /** Prefix for in-progress notifies (the parent /task-auto id, or the /task id). */
    tag: string
    /** Scope fence forwarded to an AUTOFIX re-run's refine (siblings for /task-auto;
     *  undefined for a bare /task). */
    planContext?: string
    /** Runs after the verify gate passes/accepts and BEFORE the work is committed —
     *  the parent task-list check-off for /task-auto, omitted for /task. */
    onVerified?: () => void | Promise<void>
}

/**
 * Why the gate sequence stopped. `done` means the work verified (or was accepted),
 * was checked off + committed, and enforcement ran — the caller proceeds. The other
 * kinds are terminal: the caller announces them (with its own resume command) and
 * stops. `ctx` is always the live (possibly session-replaced) context the caller
 * must adopt.
 */
export type GateResult =
    | {kind: 'done'; ctx: ExtensionCommandContext}
    /** User dismissed the verify-FAIL picker — pause, leave the work unblessed. */
    | {kind: 'paused'; ctx: ExtensionCommandContext; reason: string}
    /** An AUTOFIX re-run could not start a fresh session. */
    | {kind: 'session-cancelled'; ctx: ExtensionCommandContext}
    /** An AUTOFIX re-run was interrupted (ESC) and the user declined to steer. */
    | {kind: 'interrupted'; ctx: ExtensionCommandContext}
    /** An AUTOFIX re-run's implementation itself failed. */
    | {kind: 'failed'; ctx: ExtensionCommandContext; reason?: string}

/**
 * How many times a verify FAIL may be auto-fixed UNATTENDED (the research
 * recommended AUTOFIX, so pi re-runs the impl turn without prompting) before the
 * loop falls back to the human picker. Each AUTOFIX is a full implementation
 * re-run, so a non-converging loop must not run forever with nobody able to break
 * it — after this many consecutive auto attempts that still FAIL, the picker is
 * shown so a person can decide. A recommendation to ACCEPT always shows the picker
 * regardless of this count (blessing an artifact as-is is a human's call).
 */
export const MAX_AUTO_AUTOFIX = 3

/**
 * Bound a captured health-check output before it is embedded in a gate-trail line.
 * appendGateRecord flattens newlines to spaces, so the trail stays one line per
 * entry; this just caps the volume (a wedged tool can emit megabytes). The health
 * check already trims to its own first-N lines — this is the trail-side ceiling.
 */
const TRAIL_OUTPUT_MAX_CHARS = 1200
function clampOutput(output: string): string {
    return output.length > TRAIL_OUTPUT_MAX_CHARS ?
            `${output.slice(0, TRAIL_OUTPUT_MAX_CHARS)}…`
        :   output
}

/**
 * Show the boxed two-choice picker after a verify FAIL and return what the user
 * decided. The model-recommended card is placed first so the renderer tints it
 * green; the user ALWAYS makes the final call (there is no auto-pick). Mirrors the
 * clarify/grill dialog: the same SessionUI.ask races the local boxed picker against
 * a remote answer, with the two actions also surfaced as remote buttons.
 */
export async function askVerifyResolution(
    ctx: ExtensionCommandContext,
    title: string,
    failReason: string,
    rec: ResolutionOutcome
): Promise<ResolutionChoice> {
    const options = resolutionOptions(rec.recommend)
    const question =
        `Verification FAILED for "${title}".\n\n${failReason}\n\n`
        + `Recommended: ${rec.recommend.toUpperCase()} — ${rec.rationale}`
    const answer = await new SessionUI(ctx).ask({
        localTitle: 'Verification failed — how should pi proceed?',
        displayQuestion: question,
        question,
        recommended: options[0].label,
        recommended2: options[1].label,
        allowSkip: false,
        options
    })
    return classifyResolutionAnswer(answer)
}

/**
 * Run the verify + enforce gates against a task's just-finished implementation.
 *
 * Lifted verbatim from /task-auto's per-task loop so the two commands gate
 * identically. Returns a GateResult; `done` means the caller should proceed (the
 * work is verified-or-accepted, checked off, committed, and enforced), every other
 * kind is a terminal stop the caller announces. Never throws for a gate outcome —
 * only a user cancel inside a gate child propagates (handled by the caller's
 * USER_CANCELLED path).
 */
export async function runGatesForTask(
    ctxIn: ExtensionCommandContext,
    deps: GateDeps,
    p: GateParams
): Promise<GateResult> {
    let active = ctxIn
    // Durable per-task gate trail — every outcome below is also appended to the
    // task file so the sequence is auditable from artifacts alone. Best-effort.
    const rec = async (line: string): Promise<void> => {
        try {
            await deps.record?.(p.cwd, p.taskId, line)
        } catch {
            // recording must never break the gate sequence
        }
    }
    /**
     * ROOT-CAUSE CHANNEL (mx5 run 14 item 5). Ask whether a FAIL was caused by a
     * pre-existing defect in a file some OTHER task created and this task never
     * touched. On a hit: record the durable debt (so the final gate surfaces it)
     * and queue a scoped repair task (so something finally FIXES it — run 14
     * recorded the same `test/teardown.ts` cause twice and scheduled nothing, and
     * the bug survived ~24h). Returns the candidate so the caller can also decide
     * NOT to punish the current task for it. Never throws: any fault degrades to
     * null, i.e. exactly the pre-existing behavior.
     */
    const routeRootCause = async (
        failReason: string,
        rationale: string,
        scope: 'worktree' | 'committed'
    ): Promise<RepairCandidate | null> => {
        if (!deps.touchedFiles || !deps.introducedBy) return null
        try {
            const candidate = await findRepairCandidate({
                failReason,
                rationale,
                currentTaskId: p.taskId,
                touched: await deps.touchedFiles(p.cwd, scope),
                introducedBy: rel => deps.introducedBy!(p.cwd, rel)
            })
            if (!candidate) return null
            await deps.recordRootCauseDebt?.(
                p.cwd,
                p.taskId,
                `${failReason} — ROOT CAUSE: \`${candidate.file}\` (introduced by ${candidate.owner}, not touched by this task)`
            )
            await deps.recordRepairCandidate?.(p.cwd, candidate)
            await rec(
                `root-cause: FAIL attributed to \`${candidate.file}\` — a pre-existing defect in ${candidate.owner}'s file that this task never touched; `
                    + 'recorded as durable debt and a scoped repair task queued'
            )
            return candidate
        } catch {
            return null
        }
    }
    const verdictLine = (v: VerifyOutcome): string =>
        v.ok ?
            v.reason ?
                `verify: PASS (${v.reason})`
            :   'verify: PASS'
        :   `verify: FAIL — ${v.reason ?? 'did not verify'}`
    // GATE: actually RUN the task's verification against the just-finished work
    // BEFORE it is checked off or committed. Whether this produced a GENUINE clean
    // pass (a real signal ran and the work met it) also decides how the enforce pass
    // below may behave: only a genuine pass gives a signal to revert against, so only
    // then may enforce edit in place. A no-op pass (no spec), a disabled gate, or an
    // accept-override leaves this false → enforce runs flag-only.
    let verifyCleanPass = false
    if (deps.verify) {
        active.ui.notify(`${p.tag}: verifying "${p.title}"…`, 'info')
        let verified = await deps.verify(active, p.cwd, p.title, p.taskId)
        await rec(verdictLine(verified))
        // A FAIL no longer dead-stops. When the research recommends AUTOFIX, pi
        // re-runs the impl turn UNATTENDED (no picker) — the human is consulted only
        // when the recommendation is ACCEPT (blessing the artifact as-is). The
        // unattended fix is BOUNDED by MAX_AUTO_AUTOFIX: once that many consecutive
        // auto attempts still FAIL, the picker returns so a person can break the loop.
        let lintFixAttempted = false
        let autoFixCount = 0
        // Set when the bounded lint-fix reports the `frozen-path:` rejection: the
        // repo-health FAIL can only be fixed by editing a path THIS task's spec
        // froze (mx5 run 12's unsatisfiable registration pair). An impl re-run is
        // under the same freeze — rule 4b fails the task if it complies with the
        // linter — so unattended AUTOFIX rounds CANNOT converge and are skipped;
        // the picker is forced with the cross-task contradiction named, and the
        // defect is recorded as a durable debt for the final gate.
        let frozenContradiction: string | null = null
        let frozenDebtRecorded = false
        while (!verified.ok) {
            const failReason = verified.reason ?? 'did not verify'
            // GRADUATED resolution: a repo-health FAIL (pure static findings) gets ONE
            // bounded fix attempt before the picker — smallest tool first. Applied →
            // re-verify and re-enter the loop on the fresh verdict; not applied (guard
            // trip, no convergence) → fall through to the ordinary picker unchanged.
            if (!lintFixAttempted && deps.lintFix && failReason.startsWith('repo health:')) {
                lintFixAttempted = true
                active.ui.notify(
                    `${p.tag}: static findings on "${p.title}" — attempting bounded lint fix…`,
                    'info'
                )
                const fix = await deps.lintFix(active, p.cwd, p.title, p.taskId, failReason)
                await rec(
                    `lint-fix: ${
                        fix.ok ?
                            `applied${fix.reason ? ` (${fix.reason})` : ''} — re-verifying`
                        :   `not applied (${fix.reason ?? 'failed'})`
                    }`
                )
                if (fix.ok) {
                    verified = await deps.verify(active, p.cwd, p.title, p.taskId)
                    await rec(verdictLine(verified))
                    continue
                }
                if ((fix.reason ?? '').startsWith('frozen-path:')) {
                    frozenContradiction = fix.reason ?? null
                }
            }
            // UNOBSERVED (rule 5c): a spec-required behavioral check could not run because
            // its observation tooling is absent. An unattended AUTOFIX re-run cannot install
            // a missing tool, so it would only burn MAX_AUTO_AUTOFIX turns and re-FAIL — the
            // decision (provision the tool, or accept the unproven behavior) is the human's.
            // Skip the (moot) recommendation research and force the picker.
            const isUnobserved = verified.unobserved === true
            // FROZEN-BLOCKED (cross-task contradiction): skip the recommendation
            // research too — it would only re-derive what the deterministic lint-fix
            // rejection already proved. The picker shows the contradiction; ACCEPT
            // records the (already-recorded) defect as the human's call. Applies
            // only while the FAIL is still the repo-health one the contradiction
            // explains — a later, different FAIL gets the ordinary resolution path.
            const isFrozenBlocked =
                frozenContradiction !== null && failReason.startsWith('repo health:')
            const recOutcome: ResolutionOutcome =
                isUnobserved ? {recommend: 'autofix', rationale: failReason}
                : isFrozenBlocked ?
                    {
                        recommend: 'accept',
                        rationale:
                            `${frozenContradiction} — the failing static check can only be fixed by `
                            + `editing a path this task's spec freezes (a cross-task contradiction: `
                            + `the spec forbids the very edit the repo needs; the "owning" earlier `
                            + `step already completed). An implementation re-run under the same `
                            + `freeze cannot converge. ACCEPT records it as durable debt the final `
                            + `gate re-checks; fixing it needs a plan-level change, not a re-run.`
                    }
                : deps.recommend ?
                    await deps.recommend(active, p.cwd, p.title, p.taskId, failReason)
                :   {recommend: 'autofix', rationale: failReason}
            await rec(
                isUnobserved ?
                    'resolution: verify UNOBSERVED — spec-required check could not run (tooling absent); '
                        + 'forcing the human picker, an unattended re-run cannot provision it'
                : isFrozenBlocked ?
                    'resolution: repo-health FAIL is blocked by spec-frozen path(s) — cross-task '
                    + 'contradiction; unattended AUTOFIX skipped (an impl re-run under the same '
                    + 'freeze cannot converge), forcing the human picker'
                :   `resolution: recommended ${recOutcome.recommend.toUpperCase()}`
            )
            if (isFrozenBlocked && !frozenDebtRecorded) {
                frozenDebtRecorded = true
                // Durable regardless of what the human picks next: the contradiction
                // is real, cross-task, and outside this task's power to fix — the
                // final gate must surface it at run end (static-class: it auto-closes
                // iff the run-end static check passes).
                try {
                    await deps.recordFrozenBlockedDebt?.(
                        p.cwd,
                        p.taskId,
                        `${failReason} — ${frozenContradiction}`
                    )
                } catch {
                    // recording must never break the gate sequence
                }
            }
            // AUTO-RESOLVE the AUTOFIX path: when the research says the work is
            // genuinely wrong, re-run the fix WITHOUT prompting the user. The picker is
            // reserved for the ACCEPT recommendation (the human decides whether to bless
            // an artifact the gate FAILed) and for the bounded fallback: after
            // MAX_AUTO_AUTOFIX consecutive unattended attempts that still FAIL, hand
            // control back so a person can break a non-converging loop.
            const autoFixNow =
                !isUnobserved
                && !isFrozenBlocked
                && recOutcome.recommend === 'autofix'
                && autoFixCount < MAX_AUTO_AUTOFIX
            // YOLO: the picker is unreachable with nobody watching, and by the time
            // we are here the unattended AUTOFIX budget is ALREADY spent (autoFixNow
            // is false) — so the only option left that terminates is ACCEPT, recorded
            // as its own 'yolo-accepted' debt. Deliberately NOT a re-entry into
            // autofix: MAX_AUTO_AUTOFIX exists to break a non-converging loop, and an
            // auto-pick here would restart the budget from the site that proves it ran out.
            const yoloChoice = autoFixNow ? null : yoloVerifyResolution(isYoloMode())
            let choice: ResolutionChoice
            if (yoloChoice !== null) {
                choice = yoloChoice
                await rec(
                    `resolution: auto-ACCEPTED despite verify FAIL — autofix budget spent, nobody to ask ${YOLO_STAMP}`
                )
            } else if (autoFixNow) {
                autoFixCount += 1
                await rec(
                    `resolution: auto-AUTOFIX (recommended, unattended ${autoFixCount}/${MAX_AUTO_AUTOFIX})`
                )
                active.ui.notify(
                    `${p.tag}: verify FAIL on "${p.title}" — auto-fixing (recommended, ${autoFixCount}/${MAX_AUTO_AUTOFIX})…`,
                    'info'
                )
                choice = {action: 'autofix'}
            } else {
                choice = await askVerifyResolution(active, p.title, failReason, recOutcome)
            }
            if (choice.action === 'cancel') {
                await rec('resolution: user dismissed the verify-FAIL picker — paused')
                return {kind: 'paused', ctx: active, reason: failReason}
            }
            if (choice.action === 'accept') {
                const byYolo = yoloChoice !== null
                if (!byYolo) await rec('resolution: user ACCEPTED the work despite verify FAIL')
                // Durable debt: the human blessed a FAILing artifact as-is, so the
                // defect ships and nothing else revisits it (mx5 run 4 B3 / run 8
                // TASK_0012). Record it to the run ledger; the final integration gate
                // re-checks it at run end and surfaces it if still open. Best-effort.
                // The frozen-blocked routing above already recorded this defect (with
                // the contradiction named) — don't double-enter it in the ledger.
                if (!frozenDebtRecorded) {
                    try {
                        // Provenance splits here, mandatorily: an auto-pick writes the
                        // 'yolo-accepted' origin, never the plain 'accepted' one that
                        // asserts a human weighed the failing artifact.
                        if (byYolo) {
                            await deps.recordYoloAcceptDebt?.(p.cwd, p.taskId, failReason)
                        } else {
                            await deps.recordAcceptDebt?.(p.cwd, p.taskId, failReason)
                        }
                    } catch {
                        // recording must never break the gate sequence
                    }
                }
                // ROOT CAUSE: an accepted FAIL that some OTHER task's file caused is
                // not fixed by accepting it — run 14 accepted this shape repeatedly
                // and the causing bug outlived the whole run. Queue the scoped repair
                // so the plan actually closes it.
                await routeRootCause(failReason, recOutcome.rationale, 'worktree')
                // Cross-task deletions the verify probe detected ship in the next
                // commit with this ACCEPT — record each as its own durable debt so
                // the final gate re-checks them (mx5 run 12 PROMPT 2). Best-effort.
                for (const del of verified.crossTaskDeletions ?? []) {
                    try {
                        await deps.recordCrossTaskDeletionDebt?.(p.cwd, p.taskId, del)
                        await rec(
                            `accept-debt: cross-task deletion recorded — ${del.path} (${del.owner}'s deliverable)`
                        )
                    } catch {
                        // recording must never break the gate sequence
                    }
                }
                active.ui.notify(
                    `${p.tag}: accepted "${p.title}" despite verify FAIL (${failReason.slice(0, 120)}) — proceeding.${
                        byYolo ? ` ${YOLO_STAMP}` : ''
                    }`,
                    'warning'
                )
                break
            }
            // AUTOFIX: re-run the implementation turn with the failure (and any typed
            // guidance) prepended as a RE-ATTEMPT banner, then re-verify. The
            // recommendation child already LOCATED the defect while deciding (mx5
            // run 6: it pinned the exact SQL alias bug and the afterAll DB-drop) —
            // hand that diagnosis to the re-run so it fixes the located cause
            // instead of re-deriving it from the bare FAIL line. Skipped when there
            // is no researched rationale beyond the failure text itself.
            await rec('resolution: user chose AUTOFIX — re-running the implementation turn')
            active.ui.notify(`${p.tag}: autofixing "${p.title}"…`, 'info')
            const diagnosis =
                (
                    recOutcome.recommend === 'autofix'
                    && recOutcome.rationale.length > 0
                    && recOutcome.rationale !== failReason
                ) ?
                    `\n\nDIAGNOSIS (a read-only investigation of this failure found):\n${recOutcome.rationale}`
                :   ''
            const fixInstruction = `${failReason}${diagnosis}${
                choice.guidance ? `\n\nUser guidance: ${choice.guidance}` : ''
            }`
            const fixRes = await deps.runTask(active, p.cwd, p.title, {
                resumeId: p.taskId,
                planContext: p.planContext,
                fixInstruction
            })
            active = fixRes.ctx ?? active
            if (fixRes.sessionCancelled) return {kind: 'session-cancelled', ctx: active}
            if (fixRes.interrupted) return {kind: 'interrupted', ctx: active}
            if (!fixRes.ok) return {kind: 'failed', ctx: active, reason: fixRes.reason}
            // Resume reuses the same inner task id, so p.taskId is stable.
            verified = await deps.verify(active, p.cwd, p.title, p.taskId)
            await rec(verdictLine(verified))
        }
        // Loop exited because the work verified OR the user accepted the artifact. A
        // genuine clean pass is ok===true with NO reason; a no-op pass or an
        // accept-override (verified.ok still false at break) is NOT a guardable signal.
        verifyCleanPass = verified.ok && !verified.reason
    }
    // Mark the work verified (parent task-list check-off for /task-auto; no-op for
    // /task) BEFORE committing, so the commit captures the check-off too.
    await p.onVerified?.()
    // Commit the task's work as one snapshot FIRST — before guideline enforcement —
    // so a passing task is durably recorded no matter what enforcement later finds.
    const commit = await deps.commit(p.cwd, `task: ${p.title} (${p.taskId})`)
    if (commit.committed) {
        await rec(`commit: task snapshot committed${commit.note ? ` (${commit.note})` : ''}`)
        active.ui.notify(`${p.tag}: committed "${p.title}".`, 'info')
    } else {
        await rec(`commit: skipped (${commit.reason ?? 'unknown'})`)
        // A benign skip ("nothing to commit", auto-commit off) is a warning. A real
        // git failure is louder: it silently disables enforce AND every commit-based
        // guard — mx5 run 4 lost all 10 commits (no container git identity) with only
        // per-task warnings to show for it. "blocked" is the unmerged-index refusal
        // (gitCommitAll) — the same severity: nothing can commit until it's resolved.
        const gitFailure = /^git (commit|add) (failed|blocked)/.test(commit.reason ?? '')
        active.ui.notify(
            gitFailure ?
                `${p.tag}: COMMIT FAILED (${commit.reason}) — enforce and revert guards are disabled for this task.`
            :   `${p.tag}: not committed (${commit.reason ?? 'unknown'}) — continuing.`,
            gitFailure ? 'error' : 'warning'
        )
    }
    // With the task committed, hold its work to AGENTS.md / CLAUDE.md — but as a step
    // INSIDE the validation gate, gated by the verify signal (see GateDeps.enforce).
    // Skipped when nothing was committed this round, when enforce is off, or in tests
    // with no enforce dep.
    if (deps.enforce && commit.committed) {
        const mode: 'edit' | 'flag' = verifyCleanPass ? 'edit' : 'flag'
        // BASELINE repo health, captured BEFORE the edit pass touches the tree, so the
        // pre-commit gate below is DIFFERENTIAL: it can tell an enforce-CAUSED
        // regression (was clean, now fails) from a repo that was ALREADY unhealthy
        // (run-8 F8: five enforce passes were discarded on a lint that was already
        // crashing — exit 2 — before enforce edited anything; the discard threw away
        // good work for a fault it did not cause). Only meaningful in edit mode (flag
        // makes no edits); the task's work is already committed so this reflects the
        // committed state the pass is about to build on.
        const healthBefore =
            mode === 'edit' && deps.repoHealth ? await deps.repoHealth(p.cwd) : undefined
        const verdict = await deps.enforce(active, p.cwd, p.title, mode)
        // FROZEN-PATH WRITE-DENY (mechanical, not prompt — the "MUST NOT edit"
        // instruction is A/B-proven ~0–1/5 reliable on the weak model): the enforce
        // EDIT pass runs read,edit and has been seen mutating a path the spec froze.
        // Before its edits are inspected/committed below, restore any frozen path it
        // touched to the committed task state, so the violating write cannot land in
        // the ENFORCE GUIDELINES commit regardless of what the model intended. The
        // task's OWN frozen-path edits (if any) are already in HEAD and are the verify
        // prohibition-probe's job — this only undoes the gate child's edits on top.
        // No-op when the spec froze nothing or the deps are absent (bare /task, tests).
        if (mode === 'edit' && deps.frozenPaths && deps.revertFrozenPaths) {
            const frozen = await deps.frozenPaths(p.cwd, p.taskId)
            if (frozen.length > 0) {
                const reverted = await deps.revertFrozenPaths(p.cwd, frozen)
                if (reverted.length > 0) {
                    await rec(
                        `enforce: frozen-path write DENIED — reverted ${reverted.length} spec-frozen file(s) the edit pass modified: ${reverted.join(', ')}`
                    )
                    active.ui.notify(
                        `${p.tag}: guideline edits on "${p.title}" touched spec-frozen path(s) (${reverted.join(', ').slice(0, 120)}) — reverted before commit.`,
                        'warning'
                    )
                }
            }
        }
        // The child's verdict and its edits are independent facts: the pass has been
        // observed declaring "clean" while having edited files (which then get
        // committed as fixes) — record both so the trail cannot contradict itself.
        // `editsMade` is read AFTER the frozen-path revert so a pass whose only edit
        // was to a frozen path correctly shows a clean tree (nothing left to commit).
        const editsMade = mode === 'edit' && deps.dirty ? await deps.dirty(p.cwd) : undefined
        await rec(
            `enforce(${mode}): ${verdict.ok ? `clean${verdict.reason ? ` (${verdict.reason})` : ''}` : (verdict.reason ?? 'not clean')}${editsMade ? ' — edits in tree' : ''}`
        )
        if (!verdict.ok) {
            active.ui.notify(
                `${p.tag}: guideline ${mode === 'edit' ? 'enforcement' : 'review'} on "${p.title}" — ${verdict.reason ?? 'not clean'} — continuing.`,
                'warning'
            )
        }
        // PRE-COMMIT health gate on enforce edits: live data shows the edit pass broke
        // the repo's own lint in 11/16 tasks, each burning a commit + model re-verify +
        // revert cycle. A deterministic static check BEFORE committing skips the cycle
        // and discards the bad edits outright. Only runs when the tree is actually
        // dirty (or dirtiness is unknowable); the differential guard below still
        // catches behavioral regressions the static check cannot see.
        //
        // The gate is DIFFERENTIAL, not absolute (run-8 F8): discard the edits only
        // when they REGRESSED the health signal — clean before, failing after. A repo
        // that was already failing before enforce ran is not enforce's fault, so its
        // edits are KEPT (and the pre-existing failure is recorded, to be caught by the
        // final integration gate, not blamed on this pass). The failing command's
        // output is captured into the trail so the discard is explainable — F8 was
        // unreproducible precisely because only the exit code was recorded.
        let enforceEditsBlocked = false
        if (mode === 'edit' && deps.repoHealth && editsMade !== false) {
            const after = await deps.repoHealth(p.cwd)
            // A regression needs a clean (or unknown) baseline turning to a fail. If
            // healthBefore is undefined (repoHealth was absent at baseline time) treat
            // the baseline as clean — the conservative absolute behavior.
            const wasHealthyBefore = healthBefore?.ok ?? true
            const regressed = !after.ok && wasHealthyBefore
            if (regressed) {
                enforceEditsBlocked = true
                const outputTail = after.output ? ` — output:\n${clampOutput(after.output)}` : ''
                if (deps.discardEdits) {
                    await deps.discardEdits(p.cwd)
                    await rec(
                        `enforce: edits discarded pre-commit — REGRESSED repo health (${after.reason})${outputTail}`
                    )
                } else {
                    await rec(
                        `enforce: edits REGRESSED repo health pre-commit (${after.reason}) — no discard available, left uncommitted${outputTail}`
                    )
                }
                active.ui.notify(
                    `${p.tag}: guideline edits on "${p.title}" regressed repo health (${after.reason.slice(0, 120)}) — discarded before commit.`,
                    'warning'
                )
            } else if (!after.ok) {
                // Failing both before and after → not enforce's fault. Keep the edits;
                // record that the repo entered the gate already unhealthy so the trail
                // explains why a still-failing repo did NOT trigger a discard here.
                const outputTail = after.output ? ` — output:\n${clampOutput(after.output)}` : ''
                await rec(
                    `enforce: repo health still failing after edits but was ALREADY failing before the pass (${after.reason}) — pre-existing, edits kept${outputTail}`
                )
            }
        }
        if (mode === 'edit' && !enforceEditsBlocked && editsMade === false) {
            // KNOWN-clean tree (dirty dep ran and found no code edits): skip the
            // enforce commit AND the differential re-verify outright. Without this
            // gate the commit is never empty — the .pi-tasks gate-trail lines written
            // above make it real — so mx5 run 5 burned a full model re-verify on an
            // UNCHANGED tree for all ~29 tasks, and the 10 FAILs those re-verifies
            // produced (all real, pre-existing defects) were "reverted" into the
            // void: the revert dropped a bookkeeping-only commit and the defect
            // reports were discarded while the tasks stayed PASS. No edits ⇒ nothing
            // to guard ⇒ no commit, no re-verify, no revert. The trail lines ride
            // along in the next ordinary commit.
            await rec('enforce(edit): no code edits — enforce commit and re-verify skipped')
        } else if (mode === 'edit' && !enforceEditsBlocked) {
            // Commit whatever the pass fixed as its own snapshot. A no-op when it made
            // no edits (nothing to commit) — then there is nothing to re-verify/revert.
            const enforceCommit = await deps.commit(
                p.cwd,
                `ENFORCE GUIDELINES: ${p.title} (${p.taskId})`
            )
            if (enforceCommit.committed) {
                // Differential guard: re-run the verify signal against the enforced
                // tree. A regression ⇒ drop the enforce commit, keep the verified work.
                const after =
                    deps.verify ?
                        await deps.verify(active, p.cwd, p.title, p.taskId)
                    :   ({ok: true} as VerifyOutcome)
                const afterReason = after.reason ?? 'enforce re-verify failed'
                // PRE-EXISTING-CAUSE KEEP PATH (mx5 run 14 item 5b). Both of run
                // 14's enforce-reverts were this shape: the re-verify FAILed on
                // TASK_0007's `test/teardown.ts` TRUNCATE bug — a file neither the
                // task's work nor the enforce pass touched — and the differential
                // reverted enforce's edits anyway, destroying good work over a fault
                // it did not cause AND leaving the actual cause unscheduled. When the
                // FAIL is attributed to another task's untouched file, KEEP the edits
                // and route the real defect to a repair task instead. Everything
                // unknown (git unavailable, no provenance, this task touched the file,
                // an environment-blamed FAIL) falls through to the revert below —
                // the conservative pre-existing behavior.
                const rootCause =
                    after.ok ? null : await routeRootCause(afterReason, '', 'committed')
                if (!after.ok && rootCause) {
                    await rec(
                        `enforce: re-verify FAILED (${afterReason.slice(0, 200)}) but the failure is attributed to a PRE-EXISTING defect in \`${rootCause.file}\` `
                            + `(${rootCause.owner}'s file, untouched by this task and by the enforce pass) — edits KEPT, not reverted; repair task queued`
                    )
                    active.ui.notify(
                        `${p.tag}: guideline fixes on "${p.title}" re-verified red on a pre-existing defect in ${rootCause.file} (${rootCause.owner}'s file) — keeping the fixes, queued a repair task.`,
                        'warning'
                    )
                } else if (!after.ok) {
                    if (deps.revert) await deps.revert(p.cwd)
                    await rec(
                        `enforce: fixes committed but re-verify FAILED (${(after.reason ?? 'now fails').slice(0, 200)}) — ${deps.revert ? 'REVERTED' : 'left in place (no revert available)'}`
                    )
                    // Persist the FAIL as a durable defect (mx5 run 10 item 3). The
                    // revert restores the tree the ORIGINAL verify already blessed, so
                    // this re-verify caught a defect that verify's earlier PASS missed —
                    // erasing it with the enforce edits buried the terminal fault 8.5h
                    // before run end. The final gate re-checks/surfaces it (static-class
                    // auto-closes if a later task fixed the statics; else stays open).
                    await deps.recordEnforceRevertDebt?.(
                        p.cwd,
                        p.taskId,
                        after.reason ?? 'enforce re-verify failed'
                    )
                    active.ui.notify(
                        `${p.tag}: guideline fixes regressed verification on "${p.title}" (${(after.reason ?? 'now fails').slice(0, 120)}) — ${deps.revert ? 'reverted them, kept the verified work' : 'left in place (no revert available)'}.`,
                        'warning'
                    )
                } else {
                    await rec('enforce: fixes committed — re-verify PASS, kept')
                    active.ui.notify(
                        `${p.tag}: committed guideline fixes for "${p.title}".`,
                        'info'
                    )
                }
            } else {
                await rec('enforce(edit): no fixes to commit')
            }
        }
        // 'flag' mode makes no edits — nothing to commit or revert.
    } else if (deps.enforce) {
        // deps.enforce wired but nothing was committed this round — record the skip
        // so a missing enforce run is explainable from the trail (mx5 audit gap).
        await rec('enforce: skipped (nothing committed this round)')
    }
    return {kind: 'done', ctx: active}
}
