/**
 * task-gates — the post-implementation GATE sequence shared by /task-auto's per-task
 * loop and the single /task command.
 *
 * After a task's implementation turn settles, the same two gates run against the
 * just-finished work:
 *
 *   1. VERIFY — RUN the composed spec's VERIFY block in the real workspace and
 *      judge a PASS/FAIL. A FAIL goes to gate-resolution.ts's decision table,
 *      which returns one of three actions: re-run the implementation turn
 *      UNATTENDED and loop back, accept the artifact and write the defect to the
 *      debt ledger, or show the user the boxed picker. This module owns none of
 *      that policy — it only carries the actions out.
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
import {
    VERIFY_FAIL_PREFIX,
    verifyFailClass,
    type VerifyFail,
    type VerifyFailClass,
    type VerifyOutcome
} from './verify-work.js'
import type {EnforceOutcome} from './enforce-guidelines.js'
import {
    resolutionOptions,
    classifyResolutionAnswer,
    type ResolutionOutcome,
    type ResolutionChoice
} from './verify-resolution.js'
import {resolveDisposition, type SpecContradiction} from './gate-resolution.js'
import {
    classifyHealthDelta,
    regressedCommands,
    type HealthBaseline,
    type HealthSignal
} from './health-baseline.js'
import type {LintFixResult} from './lint-fix.js'
import {SessionUI, notifyBoth, notifyRun} from '../remote/bridge.js'
import {isYoloMode, YOLO_STAMP} from './yolo.js'
import {
    extractFailingCommand,
    findRepairCandidate,
    summariseDefect,
    type RepairCandidate
} from './root-cause-repair.js'
import {attributeEnforceFailure} from './enforce-attribution.js'
import {describeHealthFailures, isHealthRed} from './repo-health-check.js'
import {healthRedSubject, parseHealthRepairTitle, type HealthRed} from './health-repair.js'
// The debt ledger is reached through the injected `recordDebt` dep (so it stays
// absent-in-tests); only the origin TYPE and the cross-task-deletion reason SHAPE
// come from accept-debt.ts directly — the latter because its writer and its
// re-check-side parser (extractDeletedDebtPath) have to move together.
import {crossTaskDeletionReason, type DebtOrigin} from './accept-debt.js'
import type {FixContext} from './fix-context.js'
import {clampOutput} from './clamp-output.js'
import {cancelCheckpoint} from './cancel-points.js'
import {updateTaskFrontMatter} from './task-io.js'

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
            planKey?: string
            fixContext?: FixContext
            healthBaseline?: (ctx: ExtensionCommandContext) => Promise<HealthBaseline | null>
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
     * The DIFFERENTIAL re-verify the enforce pass runs against the enforced tree,
     * to decide whether its own commit survives. Absent → `verify`, which is what
     * it has always been, so production wiring is untouched.
     *
     * Its own field because it answers a different question from the gate above.
     * Sharing one field would leave a caller — or a test — no way to answer the two
     * differently except by counting invocations.
     */
    reVerify?: (
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
     * After a verify FAIL, research whether the work is genuinely wrong (AUTOFIX),
     * good as-is (ACCEPT), or blocked by a contradiction in its own spec. One input
     * to the decision table, which alone decides what happens next. Absent → the
     * table sees the conservative AUTOFIX default.
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
     * full implementation re-run AUTOFIX reaches for. Smallest tool first: a static
     * finding does not need the whole turn re-run to fix it. Runs at most once per
     * gate sequence; a `frozen-path` result mints the SpecContradiction that ends
     * the loop, anything else falls through to the decision table unchanged. Absent
     * → the loop goes straight to the judge and the table.
     */
    lintFix?: (
        ctx: ExtensionCommandContext,
        cwd: string,
        taskTitle: string,
        taskId: string,
        failReason: string
    ) => Promise<LintFixResult>
    /**
     * Deterministic whole-repo static check (repo-health), used as the PRE-COMMIT
     * gate on an edit-mode enforce pass: an enforce edit that breaks the project's
     * own lint would otherwise cost a commit, a model re-verify and a revert before
     * anything noticed. Checking first skips that cycle. Absent → the
     * commit-then-differential path runs on its own.
     *
     * Takes the live ctx and a label so the implementation can render a status line
     * while it runs: it is as slow as the project's own lint, and a gate step that
     * long with no widget is indistinguishable from a hang.
     */
    repoHealth?: (
        ctx: ExtensionCommandContext,
        cwd: string,
        label: string
    ) => Promise<{ok: boolean; reason: string; output?: string} & HealthSignal>
    /**
     * Record what the same static checks say about the tree RIGHT NOW, as the
     * baseline a later verify differential attributes against (health-baseline.ts).
     * Called where the tree is committed and the task has not started — the
     * `/task-auto` pre-task checkpoint, and `/task`'s own start. Null when the
     * capture could not run; absent in tests → no baseline is written and the
     * verify gate establishes one lazily.
     */
    captureHealthBaseline?: (
        ctx: ExtensionCommandContext,
        cwd: string,
        label: string
    ) => Promise<HealthBaseline | null>
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
     * is recorded so the sequence is auditable from artifacts alone. A verdict that
     * lives only in a terminal notify cannot answer "why did enforce not run here?"
     * after the fact. Best-effort: absent in tests → skipped; failures are swallowed
     * by the implementation, never by this sequence.
     */
    record?: (cwd: string, taskId: string, line: string) => Promise<void>
    /**
     * Record ONE durable defect to the run-level ledger (`.pi-tasks/accept-debt.md`,
     * see accept-debt.ts), stamped with the DebtOrigin that says how it was reached.
     * The final integration gate re-checks every recorded debt at run end and surfaces
     * the ones still open, so a defect the gate found is never lost by whatever the
     * loop then did with the WORK — accepted by a human ('accepted'), dismissed at
     * the picker ('dismissed'), accepted unattended by yolo mode ('yolo-accepted'),
     * reverted with the enforce commit ('enforce-revert'), kept because the enforce
     * diff could not have caused it ('enforce-kept'), unreachable under the task's
     * own spec ('spec-contradiction'), a sibling's deliverable deleted and accepted
     * ('cross-task-deletion'), or another task's pre-existing bug this one merely
     * tripped over ('root-cause').
     *
     * The ORIGIN is load-bearing, not a label: the final gate reports by class, and
     * an unattended auto-pick may never be recorded as the 'accepted' class, which
     * asserts a human weighed the failing artifact. Best-effort; absent in tests →
     * no ledger written.
     */
    recordDebt?: (cwd: string, taskId: string, reason: string, origin: DebtOrigin) => Promise<void>
    /**
     * Queue a scoped repair task for a root-caused defect. The gate DETECTS the
     * cause; only the /task-auto loop may mutate the plan, so the two are decoupled
     * through the durable `.pi-tasks/repair-queue.md` ledger this writes (see
     * root-cause-repair.ts). Absent (tests) → detection still records the debt,
     * nothing is scheduled. buildGateDeps always supplies it, so a bare `/task`
     * queues repairs exactly like /task-auto — only the plan mutation is the loop's.
     */
    recordRepairCandidate?: (cwd: string, candidate: RepairCandidate) => Promise<void>
    /**
     * Close the open static debts naming a health command, stamped with the task
     * whose verified work made that check pass — a health repair entry
     * (health-repair.ts) going green. Returns the debts closed. Absent (tests) →
     * nothing closes.
     */
    closeHealthDebts?: (
        cwd: string,
        command: string,
        resolvedBy: string
    ) => Promise<{taskId: string; reason: string}[]>
    /**
     * Paths the CURRENT task's own work touches — the AUTHORSHIP discriminator for
     * the root-cause channel: a FAIL blamed on a file this task edited may well be
     * this task's own fault, and only a file it never touched can be somebody
     * else's pre-existing bug. `worktree` = uncommitted changes (the pre-commit
     * verify site); `committed` = the files the task snapshot + the ENFORCE commit
     * changed (the post-commit enforce site); `enforce-commit` = the ENFORCE COMMIT
     * ALONE, which is the only correct authorship question at the enforce
     * differential — that differential decides whether to discard the ENFORCE
     * COMMIT, so what the TASK touched is irrelevant to it.
     * `null` means UNKNOWN (git unavailable) and stands the whole channel down —
     * inconclusive is never evidence, so an unreadable tree can only cost a repair
     * task, never spawn a wrong one or wrongly keep a regression.
     */
    touchedFiles?: (
        cwd: string,
        scope: 'worktree' | 'committed' | 'enforce-commit'
    ) => Promise<string[] | null>
    /**
     * Every path git tracks in the repo — used ONLY to resolve a bare file name a
     * FAIL text names (`MyListings.spec.tsx:186`) to its repo path, so the defect
     * can be attributed and a repair queued for it. Absent/null costs resolution,
     * never changes a keep/revert verdict.
     */
    repoFiles?: (cwd: string) => Promise<string[] | null>
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
     * framing is insufficient for this class (see frozen-path-guard.ts), so the deny
     * is mechanical: the write is undone, not merely warned about. Absent → the
     * guard warns only.
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
    /**
     * The USER cancelled an AUTOFIX re-run. Distinct from `interrupted`: the task
     * file already says `cancelled` and must not be demoted to `failed` over it.
     */
    | {kind: 'cancelled'; ctx: ExtensionCommandContext}
    /** An AUTOFIX re-run's implementation itself failed. */
    | {kind: 'failed'; ctx: ExtensionCommandContext; reason?: string}

// The trail-side output ceiling lives in clamp-output.ts, so the render probe's
// evidence clamps identically — one ceiling, one implementation.

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
    rec: ResolutionOutcome,
    /** The repair ACCEPT would queue (a regressed health check), if any. */
    acceptQueues?: string
): Promise<ResolutionChoice> {
    const options = resolutionOptions(rec.recommend, acceptQueues)
    const question =
        `Verification FAILED for "${title}".\n\n${failReason}\n\n`
        + `Recommended: ${rec.recommend.toUpperCase()} — ${rec.rationale}`
        + (acceptQueues ? `\n\nACCEPT queues ${acceptQueues} before the next task.` : '')
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

/** The repair a red health check earns, as the picker and the trail name it. */
/** Was `command` among the checks this verdict inherited red? */
function inheritsRed(verified: VerifyOutcome, command: string): boolean {
    return verified.inheritedHealth?.includes(`\`${command}\``) ?? false
}

/**
 * The reason the bounded lint fix is handed, or null when the FAIL has no static
 * half. A suite regressed beside a lint still leaves the lint for it to fix; told
 * about the suite too, it would chase a red its static check cannot observe.
 */
function staticFixReason(verified: VerifyOutcome, failClass: VerifyFailClass): string | null {
    if (failClass === 'repo-health') return verified.reason ?? ''
    if (failClass !== 'test-suite') return null
    const statics = (verified.health?.commands ?? []).filter(
        c => c.kind !== 'test' && isHealthRed(c)
    )
    if (statics.length === 0) return null
    return `${VERIFY_FAIL_PREFIX['repo-health']} ${describeHealthFailures(statics)}`
}

function describeHealthRepair(red: HealthRed): string {
    return red.files.length > 0 ?
            `a repair for ${red.files.join(', ')} (\`${red.command}\`)`
        :   `a repair for \`${red.command}\``
}

/**
 * Run the verify + enforce gates against a task's just-finished implementation.
 *
 * Both commands gate identically because both call this. Returns a GateResult;
 * `done` means the caller should proceed (the
 * work is verified-or-accepted, checked off, committed, and enforced), every other
 * kind is a terminal stop the caller announces. Never throws for a gate outcome —
 * only a user cancel inside a gate child propagates (handled by the caller's
 * USER_CANCELLED path).
 */
/** The durable per-task gate trail: every outcome is appended to the task file so
 *  the sequence is auditable from artifacts alone. Best-effort — recording must
 *  never break the gate sequence. */
type Recorder = (line: string) => Promise<void>

/**
 * The root-cause channel: was this FAIL caused by a pre-existing defect in a file
 * some OTHER task created and this task never touched?
 */
type RootCauseRouter = (
    failReason: string,
    rationale: string,
    scope: 'worktree' | 'committed' | 'enforce-commit'
) => Promise<RepairCandidate | null>

/**
 * What the VERIFY half settled. Either the sequence is over (`stop` carries the
 * terminal GateResult — dismissed picker, cancelled session, interrupted or failed
 * autofix) or the task proceeds to commit + enforce.
 *
 * `cleanPass` is the ONE fact that crosses to the enforce half: a GENUINE clean
 * pass (a real signal ran and the work met it) is the only thing that gives
 * enforce a signal to revert against, so only then may it edit in place. A no-op
 * pass, a disabled gate or an accept-override leaves it false → flag-only.
 */
type VerifyGateStep =
    {stop: GateResult} | {proceed: {ctx: ExtensionCommandContext; cleanPass: boolean}}

/**
 * The VERIFY resolution loop: run the task's verification against the finished
 * work, and carry out what gate-resolution.ts's decision table says to do with a
 * FAIL (bounded lint fix first, then the table's autofix / accept / ask) until it
 * verifies, is accepted, or terminates.
 *
 * Split from `runGatesForTask` at the single boolean that crosses to the ENFORCE
 * half (`cleanPass`). This loop has four terminal exits and carries the whole
 * negotiation; enforce always falls through. Joined, a test of the enforce
 * differential would have to traverse this entire loop first.
 */
export async function resolveVerifyGate(
    ctxIn: ExtensionCommandContext,
    deps: GateDeps,
    p: GateParams,
    rec: Recorder,
    routeRootCause: RootCauseRouter
): Promise<VerifyGateStep> {
    let active = ctxIn
    const verdictLine = (v: VerifyOutcome): string =>
        v.ok ?
            v.reason ?
                `verify: PASS (${v.reason})`
            :   'verify: PASS'
        :   `verify: FAIL — ${v.reason}`
    /**
     * The loop's ONLY debt-bearing exit. Every way out of a FAIL that leaves the
     * task FINISHED — accepted by a human, accepted unattended, blocked by a spec
     * contradiction, or dismissed at the picker — goes through here, so a defect
     * cannot leave this gate with no ledger entry (five did in AUTO_0002). The
     * exits that leave the task UNFINISHED and resumable (a cancel, a re-run that
     * could not start) are deliberately not debts: that work is coming back.
     */
    const settleDebt = async (origin: DebtOrigin, reason: string): Promise<void> => {
        try {
            await deps.recordDebt?.(p.cwd, p.taskId, reason, origin)
        } catch {
            // recording must never break the gate sequence
        }
    }
    const healthRedOf = async (
        health: NonNullable<VerifyFail['health']>
    ): Promise<HealthRed | null> => {
        try {
            return healthRedSubject(health, p.cwd, (await deps.repoFiles?.(p.cwd)) ?? null)
        } catch {
            return null
        }
    }
    // GATE: actually RUN the task's verification against the just-finished work
    // BEFORE it is checked off or committed. Whether this produced a GENUINE clean
    // pass (a real signal ran and the work met it) also decides how the enforce pass
    // below may behave: only a genuine pass gives a signal to revert against, so only
    // then may enforce edit in place. A no-op pass (no spec), a disabled gate, or an
    // accept-override leaves this false → enforce runs flag-only.
    let verifyCleanPass = false
    if (deps.verify) {
        notifyBoth(active, `${p.tag}: verifying "${p.title}"…`, 'info')
        let verified = await deps.verify(active, p.cwd, p.title, p.taskId)
        await rec(verdictLine(verified))
        let lintFixAttempted = false
        let autoFixCount = 0
        // A contradiction outlives the round that proved it: it is a fact about the
        // SPEC, not about one verdict. Re-deriving it per round is how a loop spends
        // its whole budget on a freeze that was already named in round one (0053).
        let contradiction: SpecContradiction | null = null
        while (!verified.ok) {
            // SAFE CHECKPOINT (before a resolution round): a round is a bounded
            // lint fix, a research child and possibly a whole implementation
            // re-run, so a cancel observed only INSIDE one buys all of that
            // first. At the TOP of the loop because every later position is past
            // something that already recorded itself — the unattended branch
            // increments the counter, writes its `## gates` line and toasts
            // "auto-fixing…" before it reaches any code below.
            //
            // The task file still reads `completed` here, written at spec handoff
            // before any of this ran, and `completed` is not in RESUMABLE_STATES.
            // Returning `cancelled` without this write would leave the announced
            // "resume with /task-resume" pointing at a file /task-resume skips —
            // the work is unverified AND uncommitted at this point, so that is the
            // one place in the gate where a missed demotion loses it.
            if (cancelCheckpoint('gate:pre-resolution')) {
                await updateTaskFrontMatter(p.cwd, p.taskId, {state: 'cancelled'}).catch(() => {})
                return {stop: {kind: 'cancelled', ctx: active}}
            }
            const failReason = verified.reason
            // GRADUATED resolution: a repo-health FAIL (pure static findings) gets ONE
            // bounded fix attempt before the picker — smallest tool first. Applied →
            // re-verify and re-enter the loop on the fresh verdict; not applied (guard
            // trip, no convergence) → fall through to the decision table unchanged.
            const failClass = verifyFailClass(verified) ?? 'model-verdict'
            const lintFixReason = staticFixReason(verified, failClass)
            if (!lintFixAttempted && deps.lintFix && lintFixReason !== null) {
                lintFixAttempted = true
                notifyRun(
                    active,
                    `${p.tag}: static findings on "${p.title}" — attempting bounded lint fix…`,
                    'info'
                )
                const fix = await deps.lintFix(active, p.cwd, p.title, p.taskId, lintFixReason)
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
                if (fix.contradiction) contradiction = fix.contradiction
            }
            // Two FAILs make the recommendation research MOOT before it runs. An
            // UNOBSERVED one (rule 5c) is a check that could not RUN for want of
            // tooling, and a contradiction has already been PROVEN deterministically
            // — asking a model to re-derive either costs a child and decides nothing.
            const unobserved = verified.unobserved === true
            const judge = contradiction === null && !unobserved ? deps.recommend : undefined
            const recOutcome: ResolutionOutcome =
                judge ?
                    await judge(active, p.cwd, p.title, p.taskId, failReason)
                :   {recommend: 'autofix', rationale: failReason}
            if (judge) await rec(`resolution: recommended ${recOutcome.recommend.toUpperCase()}`)
            contradiction ??= recOutcome.contradiction ?? null
            const unattended = isYoloMode()
            // A regressed health check is THIS task's red. Accepting it ships the
            // red, and the next checkpoint splices a repair before anything builds
            // on it (health-repair.ts) — named here so a human choosing ACCEPT
            // sees what the choice queues, and the trail says the same.
            const regression = verified.health ? await healthRedOf(verified.health) : null
            const acceptQueues = regression ? describeHealthRepair(regression) : undefined
            const disposition = resolveDisposition({
                failClass,
                recommend: recOutcome.recommend,
                unobserved,
                contradiction,
                attempts: autoFixCount,
                unattended
            })
            let choice: ResolutionChoice
            if (disposition.action === 'autofix') {
                autoFixCount += 1
                await rec(`resolution: auto-AUTOFIX (${disposition.reason})`)
                notifyRun(
                    active,
                    `${p.tag}: verify FAIL on "${p.title}" — auto-fixing (${disposition.reason})…`,
                    'info'
                )
                choice = {action: 'autofix'}
            } else if (disposition.action === 'accept') {
                // NAME the rule that decided. This line is the durable record of why
                // a defect shipped, and the rules that reach it have spent wildly
                // different amounts of the budget — some none at all.
                await rec(
                    `resolution: auto-ACCEPTED despite verify FAIL — ${disposition.reason}${
                        unattended ? `, nobody to ask ${YOLO_STAMP}` : ''
                    }`
                )
                choice = {action: 'accept'}
            } else {
                // Why the picker is up, when that is not already the line above:
                // the judge-accept row's reason only restates the recommendation.
                if (disposition.rule !== 'judge-accept') {
                    await rec(`resolution: asking the human — ${disposition.reason}`)
                }
                choice = await askVerifyResolution(
                    active,
                    p.title,
                    failReason,
                    recOutcome,
                    acceptQueues
                )
            }
            if (choice.action === 'cancel') {
                await rec('resolution: user dismissed the verify-FAIL picker — paused')
                await settleDebt('dismissed', failReason)
                return {stop: {kind: 'paused', ctx: active, reason: failReason}}
            }
            if (choice.action === 'accept') {
                // Provenance splits here, mandatorily. The table's own accept carries
                // the origin that names the rule which decided; only a PICKER answer
                // earns the plain 'accepted' class, which asserts a human weighed
                // this failing artifact.
                const origin: DebtOrigin =
                    disposition.action === 'accept' ? disposition.debtOrigin : 'accepted'
                if (origin === 'accepted') {
                    await rec('resolution: user ACCEPTED the work despite verify FAIL')
                }
                // Durable debt: the defect ships and nothing else in this task
                // revisits it. The final integration gate re-checks it at run end and
                // surfaces it if still open. The reason LEADS with the fail text so
                // its minted class prefix still routes the run-end re-check.
                await settleDebt(
                    origin,
                    disposition.rule === 'spec-contradiction' ?
                        `${failReason} — ${disposition.reason}`
                    :   failReason
                )
                if (acceptQueues) {
                    await rec(
                        `accept: repo health regressed by this task — ${acceptQueues} is spliced before the next task`
                    )
                }
                // ROOT CAUSE: an accepted FAIL that some OTHER task's file caused is
                // not fixed by accepting it — every later task keeps tripping over
                // the same bug. Queue the scoped repair so the plan closes it.
                await routeRootCause(failReason, recOutcome.rationale, 'worktree')
                // Cross-task deletions the verify probe detected ship in the next
                // commit with this ACCEPT — record each as its own durable debt so
                // the final gate re-checks them. Best-effort.
                for (const del of verified.crossTaskDeletions ?? []) {
                    try {
                        await deps.recordDebt?.(
                            p.cwd,
                            p.taskId,
                            crossTaskDeletionReason(del),
                            'cross-task-deletion'
                        )
                        await rec(
                            `accept-debt: cross-task deletion recorded — ${del.path} (${del.owner}'s deliverable)`
                        )
                    } catch {
                        // recording must never break the gate sequence
                    }
                }
                notifyRun(
                    active,
                    `${p.tag}: accepted "${p.title}" despite verify FAIL (${failReason.slice(0, 120)}) — proceeding.${
                        unattended ? ` ${YOLO_STAMP}` : ''
                    }`,
                    'warning'
                )
                break
            }
            // AUTOFIX: re-run the implementation turn with the failure (and any typed
            // guidance) prepended as a RE-ATTEMPT banner, then re-verify. The
            // recommendation child already LOCATED the defect while deciding, so
            // hand its diagnosis to the re-run rather than making it re-derive the
            // cause from the bare FAIL line. Skipped when there is no researched
            // rationale beyond the failure text itself.
            // Only the picker branch may claim a person chose this: the unattended
            // branch already recorded itself one line above, and a trail that says
            // "user chose" when nobody was asked is the same lie the accept line
            // used to tell.
            if (disposition.action === 'ask') {
                await rec('resolution: user chose AUTOFIX — re-running the implementation turn')
            }
            notifyBoth(active, `${p.tag}: autofixing "${p.title}"…`, 'info')
            const diagnosis =
                (
                    recOutcome.recommend === 'autofix'
                    && recOutcome.rationale.length > 0
                    && recOutcome.rationale !== failReason
                ) ?
                    recOutcome.rationale
                :   ''
            const fixRes = await deps.runTask(active, p.cwd, p.title, {
                resumeId: p.taskId,
                planContext: p.planContext,
                fixContext: {
                    outcome: verified,
                    disposition,
                    probes: verified.probes ?? {},
                    attempt: autoFixCount,
                    contradiction,
                    ...(diagnosis === '' ? {} : {diagnosis}),
                    ...(choice.guidance === undefined ? {} : {guidance: choice.guidance})
                }
            })
            active = fixRes.ctx ?? active
            // The re-run's ending, mapped to this loop's own terminal kinds. A
            // CANCEL lands on `interrupted` — the user stopped it, so the task is
            // left resumable rather than reported as a fault.
            if (fixRes.end.kind === 'no-session') {
                return {stop: {kind: 'session-cancelled', ctx: active}}
            }
            // A CANCEL and an ESC-interrupt are NOT the same ending. Folding them
            // together sent a cancelled re-run down the `interrupted` row, which
            // demotes the task file — writing `failed` over the `cancelled` the
            // cancel itself wrote.
            if (fixRes.end.kind === 'cancelled') {
                return {stop: {kind: 'cancelled', ctx: active}}
            }
            if (fixRes.end.kind === 'interrupted') {
                return {stop: {kind: 'interrupted', ctx: active}}
            }
            if (fixRes.end.kind === 'failed') {
                return {
                    stop: {
                        kind: 'failed',
                        ctx: active,
                        ...(fixRes.end.reason === undefined ? {} : {reason: fixRes.end.reason})
                    }
                }
            }
            // Resume reuses the same inner task id, so p.taskId is stable.
            verified = await deps.verify(active, p.cwd, p.title, p.taskId)
            await rec(verdictLine(verified))
        }
        // Static checks the repo was ALREADY failing when this task started (see
        // health-baseline.ts). They did not fail this gate — that is the point — but
        // dropping them here is how a sibling's defect vanishes until the run-end
        // gate rediscovers it with nobody's name on it. Recorded once, after the
        // loop, whatever the verdict was: a task can verify perfectly in a red repo.
        if (verified.inheritedHealth) {
            await rec(`accept-debt: inherited repo health — ${verified.inheritedHealth}`)
            await settleDebt('inherited-health', verified.inheritedHealth)
        }
        // A health repair that verified CLEAN — the check it exists for ran green —
        // closes the debts that check opened, under its own id. Another check
        // inherited red beside it says nothing about this one.
        const repair = parseHealthRepairTitle(p.title)
        if (repair && verified.ok && !verified.reason && !inheritsRed(verified, repair.command)) {
            try {
                const closed = await deps.closeHealthDebts?.(p.cwd, repair.command, p.taskId)
                if (closed && closed.length > 0) {
                    await rec(
                        `accept-debt: closed ${closed.length} debt(s) on \`${repair.command}\` — `
                            + `${closed.map(d => d.taskId).join(', ')} — repaired by ${p.taskId}`
                    )
                }
            } catch {
                // closing debts must never break the gate sequence
            }
        }
        // Loop exited because the work verified OR the user accepted the artifact. A
        // genuine clean pass is ok===true with NO reason; a no-op pass or an
        // accept-override (verified.ok still false at break) is NOT a guardable signal.
        verifyCleanPass = verified.ok && !verified.reason
    }
    return {proceed: {ctx: active, cleanPass: verifyCleanPass}}
}

/**
 * The ENFORCE differential: hold the committed work to AGENTS.md / CLAUDE.md,
 * then decide whether the pass\'s own commit survives.
 *
 * `reVerify` is deliberately NOT `deps.verify`. They answer two different
 * questions — the gate above, and this differential — so they are two fields.
 *
 * Reads `active` and never reassigns it: nothing here can replace the live
 * session, unlike the autofix in the verify half.
 */
export async function runEnforcePass(
    active: ExtensionCommandContext,
    deps: GateDeps,
    p: GateParams,
    rec: Recorder,
    routeRootCause: RootCauseRouter,
    args: {cleanPass: boolean; commit: CommitResult}
): Promise<void> {
    const {cleanPass: verifyCleanPass, commit} = args
    // With the task committed, hold its work to AGENTS.md / CLAUDE.md — but as a step
    // INSIDE the validation gate, gated by the verify signal (see GateDeps.enforce).
    // Skipped when nothing was committed this round, when enforce is off, or in tests
    // with no enforce dep.
    if (deps.enforce && commit.committed) {
        const mode: 'edit' | 'flag' = verifyCleanPass ? 'edit' : 'flag'
        // BASELINE repo health, captured BEFORE the edit pass touches the tree, so the
        // pre-commit gate below is DIFFERENTIAL: it can tell an enforce-CAUSED
        // regression (was clean, now fails) from a repo that was ALREADY unhealthy.
        // Without the baseline, a lint that was already crashing before the pass ran
        // makes every enforce pass look like the cause, and its good work is
        // discarded for a fault it did not commit. Only meaningful in edit mode (flag
        // makes no edits); the task's work is already committed so this reflects the
        // committed state the pass is about to build on.
        const healthBefore =
            mode === 'edit' && deps.repoHealth ?
                await deps.repoHealth(active, p.cwd, p.title)
            :   undefined
        const verdict = await deps.enforce(active, p.cwd, p.title, mode)
        // FROZEN-PATH WRITE-DENY (mechanical, not prompt — a "MUST NOT edit"
        // instruction is not reliable): the enforce EDIT pass runs read,edit and can
        // mutate a path the spec froze.
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
                    notifyRun(
                        active,
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
            notifyRun(
                active,
                `${p.tag}: guideline ${mode === 'edit' ? 'enforcement' : 'review'} on "${p.title}" — ${verdict.reason ?? 'not clean'} — continuing.`,
                'warning'
            )
        }
        // PRE-COMMIT health gate on enforce edits: an edit pass that breaks the
        // repo's own lint would otherwise burn a commit, a model re-verify and a
        // revert before anything noticed. A deterministic static check BEFORE
        // committing skips that cycle and discards the bad edits outright. Only runs
        // when the tree is actually
        // dirty (or dirtiness is unknowable); the differential guard below still
        // catches behavioral regressions the static check cannot see.
        //
        // The gate is DIFFERENTIAL, not absolute: discard the edits only
        // when they REGRESSED the health signal — clean before, failing after. A repo
        // that was already failing before enforce ran is not enforce's fault, so its
        // edits are KEPT (and the pre-existing failure is recorded, to be caught by
        // the final integration gate, not blamed on this pass). The failing command's
        // OUTPUT is captured into the trail, not just its exit code, so the discard
        // is explainable after the run.
        let enforceEditsBlocked = false
        if (mode === 'edit' && deps.repoHealth && editsMade !== false) {
            const after = await deps.repoHealth(active, p.cwd, p.title)
            // The SAME differential the verify gate runs (health-baseline.ts), per
            // command rather than per overall verdict — two runs can both be red
            // while a different check failed in each. A missing baseline is no
            // longer read as a clean one: that default silently turned this
            // differential back into the absolute check it exists to replace.
            const delta = classifyHealthDelta(healthBefore ?? null, after)
            if (delta === 'regressed') {
                enforceEditsBlocked = true
                // What REGRESSED, not the check's own verdict: a vanished suite fails
                // nothing, so `after.reason` reads "tests passed" under this discard.
                const regressed = regressedCommands(healthBefore ?? null, after)
                const why = regressed.length > 0 ? describeHealthFailures(regressed) : after.reason
                const outputTail = after.output ? ` — output:\n${clampOutput(after.output)}` : ''
                if (deps.discardEdits) {
                    await deps.discardEdits(p.cwd)
                    await rec(
                        `enforce: edits discarded pre-commit — REGRESSED repo health (${why})${outputTail}`
                    )
                } else {
                    await rec(
                        `enforce: edits REGRESSED repo health pre-commit (${why}) — no discard available, left uncommitted${outputTail}`
                    )
                }
                notifyRun(
                    active,
                    `${p.tag}: guideline edits on "${p.title}" regressed repo health (${why.slice(0, 120)}) — discarded before commit.`,
                    'warning'
                )
            } else if (delta === 'pre-existing') {
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
            // KNOWN-clean tree (the dirty dep ran and found no code edits): skip the
            // enforce commit AND the differential re-verify outright. Without this
            // gate the commit is never empty — the .pi-tasks gate-trail lines written
            // above make it real — so every task would burn a model re-verify on an
            // UNCHANGED tree, and any FAIL it turned up would be "reverted" into the
            // void: the revert drops a bookkeeping-only commit while the defect
            // report is discarded and the task stays PASS. No edits ⇒ nothing to
            // guard ⇒ no commit, no re-verify, no revert. The trail lines ride along
            // in the next ordinary commit.
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
                const differential = deps.reVerify ?? deps.verify
                const after =
                    differential ?
                        await differential(active, p.cwd, p.title, p.taskId)
                    :   ({ok: true} as VerifyOutcome)
                const afterReason = after.reason ?? 'enforce re-verify failed'
                // PRE-EXISTING-CAUSE KEEP PATH. A re-verify can FAIL on a file the
                // enforce pass never touched — another task's bug this one merely
                // ran into. Reverting there destroys good work over a fault it did
                // not cause AND leaves the actual cause unscheduled. So when the FAIL
                // is attributed to another task's untouched file, KEEP the edits and
                // route the real defect to a repair task. Everything unknown (git
                // unavailable, no provenance, this task touched the file, an
                // environment-blamed FAIL) falls through to the revert below.
                //
                // The scope is `enforce-commit`, NOT the task's own commit. This
                // differential decides whether to discard the ENFORCE COMMIT, so the
                // causal question is "could the enforce diff have caused this?".
                // Asking what the TASK touched answers a question nobody at this seam
                // is asking.
                const rootCause =
                    after.ok ? null : await routeRootCause(afterReason, '', 'enforce-commit')
                // ATTRIBUTION PRE-FILTER. The root-cause channel above needs a blame
                // CUE, a path-separator token and known provenance. A FAIL text can
                // carry none of the three — a bare `MyListings.spec.tsx:186` names a
                // file with no directory and no blame wording — and then falls
                // straight through to the revert. This filter asks only the
                // mechanical question: does the
                // failing check name any file the ENFORCE COMMIT touched? Disjoint =>
                // the revert cannot repair the failure, so keep the edits and route
                // the defect. Unknown diff, or a FAIL naming no file at all, still
                // reverts — never keep on ignorance.
                const attribution =
                    !after.ok && !rootCause ?
                        attributeEnforceFailure({
                            failReason: afterReason,
                            enforceTouched:
                                (await deps.touchedFiles?.(p.cwd, 'enforce-commit')) ?? null,
                            repoFiles: (await deps.repoFiles?.(p.cwd)) ?? null
                        })
                    :   null
                if (!after.ok && rootCause) {
                    await rec(
                        `enforce: re-verify FAILED (${afterReason.slice(0, 200)}) but the failure is attributed to a PRE-EXISTING defect in \`${rootCause.file}\` `
                            + `(${rootCause.owner}'s file, untouched by the ENFORCE COMMIT whose fate this differential decides) — edits KEPT, not reverted; repair task queued`
                    )
                    notifyRun(
                        active,
                        `${p.tag}: guideline fixes on "${p.title}" re-verified red on a pre-existing defect in ${rootCause.file} (${rootCause.owner}'s file) — keeping the fixes, queued a repair task.`,
                        'warning'
                    )
                } else if (!after.ok && attribution?.verdict === 'keep') {
                    // KEEP, mechanically justified: every file the failing check named
                    // is outside the enforce diff (and outside its companions — a
                    // touched file's own spec/story counts as inside). Discarding
                    // the enforce commit could not repair this, so doing so only
                    // costs the correct change the pass made.
                    await rec(
                        `enforce: re-verify FAILED (${afterReason.slice(0, 200)}) but the failing check names only \`${attribution.named.join(', ')}\`, `
                            + `which the ENFORCE COMMIT does not touch (its diff: ${attribution.enforceDiff.join(', ') || '—'}) — `
                            + 'reverting it could not repair this, so the edits are KEPT and the defect is recorded as durable debt'
                    )
                    // Keeping the edits must NOT lose the finding. Same durability
                    // as the revert path; only the disposition of the edits differs.
                    await deps.recordDebt?.(p.cwd, p.taskId, afterReason, 'enforce-kept')
                    // …and, when the named file is somebody else's committed work,
                    // queue the scoped repair so something actually FIXES it.
                    if (attribution.file && deps.introducedBy && deps.recordRepairCandidate) {
                        try {
                            const owner = await deps.introducedBy(p.cwd, attribution.file)
                            const verifyCommand = extractFailingCommand(afterReason)
                            if (owner && owner !== p.taskId) {
                                await deps.recordRepairCandidate(p.cwd, {
                                    file: attribution.file,
                                    owner,
                                    defect: summariseDefect(afterReason, attribution.file),
                                    blamedTask: p.taskId,
                                    ...(verifyCommand ? {verifyCommand} : {})
                                })
                                await rec(
                                    `root-cause: \`${attribution.file}\` is ${owner}'s file — scoped repair task queued`
                                )
                            }
                        } catch {
                            // queueing a repair must never break the gate sequence
                        }
                    }
                    notifyRun(
                        active,
                        `${p.tag}: guideline fixes on "${p.title}" re-verified red on ${attribution.file ?? 'a file'} — outside the enforce diff, so keeping the fixes and recording the defect.`,
                        'warning'
                    )
                } else if (!after.ok) {
                    if (deps.revert) await deps.revert(p.cwd)
                    await rec(
                        `enforce: fixes committed but re-verify FAILED (${(after.reason ?? 'now fails').slice(0, 200)}) — ${deps.revert ? 'REVERTED' : 'left in place (no revert available)'}`
                            // Why the attribution filter did NOT save the edits, so a
                            // revert is explainable from the trail alone.
                            + (attribution ?
                                ` [attribution: ${attribution.why}${
                                    attribution.overlap ?
                                        ` — the check names \`${attribution.overlap.named}\`, the enforce diff touches \`${attribution.overlap.enforce}\``
                                    :   ''
                                }]`
                            :   '')
                    )
                    // Persist the FAIL as a durable defect. The revert restores the
                    // tree the ORIGINAL verify already blessed, so this re-verify
                    // caught something that verify's earlier PASS missed — erasing it
                    // along with the enforce edits would bury a real fault. The final
                    // gate re-checks and surfaces it (static-class auto-closes if a
                    // later task fixed the statics; otherwise it stays open).
                    await deps.recordDebt?.(
                        p.cwd,
                        p.taskId,
                        after.reason ?? 'enforce re-verify failed',
                        'enforce-revert'
                    )
                    notifyRun(
                        active,
                        `${p.tag}: guideline fixes regressed verification on "${p.title}" (${(after.reason ?? 'now fails').slice(0, 120)}) — ${deps.revert ? 'reverted them, kept the verified work' : 'left in place (no revert available)'}.`,
                        'warning'
                    )
                } else {
                    await rec('enforce: fixes committed — re-verify PASS, kept')
                    notifyRun(
                        active,
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
        // so a missing enforce run is explainable from the trail.
        await rec('enforce: skipped (nothing committed this round)')
    }
}

export async function runGatesForTask(
    ctxIn: ExtensionCommandContext,
    deps: GateDeps,
    p: GateParams
): Promise<GateResult> {
    const rec: Recorder = async (line: string): Promise<void> => {
        try {
            await deps.record?.(p.cwd, p.taskId, line)
        } catch {
            // recording must never break the gate sequence
        }
    }
    /**
     * ROOT-CAUSE CHANNEL. Ask whether a FAIL was caused by a
     * pre-existing defect in a file some OTHER task created and this task never
     * touched. On a hit: record the durable debt (so the final gate surfaces it)
     * and queue a scoped repair task, so something finally FIXES it rather than
     * recording the same cause once per task that trips over it. Returns the
     * candidate so the caller can also decide
     * NOT to punish the current task for it. Never throws: any fault degrades to
     * null, i.e. exactly the pre-existing behavior.
     */
    const routeRootCause = async (
        failReason: string,
        rationale: string,
        scope: 'worktree' | 'committed' | 'enforce-commit'
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
            await deps.recordDebt?.(
                p.cwd,
                p.taskId,
                `${failReason} — ROOT CAUSE: \`${candidate.file}\` (introduced by ${candidate.owner}, not touched by this task)`,
                'root-cause'
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
    const step = await resolveVerifyGate(ctxIn, deps, p, rec, routeRootCause)
    if ('stop' in step) return step.stop
    const {ctx: active, cleanPass} = step.proceed
    // Mark the work verified (parent task-list check-off for /task-auto; no-op for
    // /task) BEFORE committing, so the commit captures the check-off too.
    await p.onVerified?.()
    // Commit the task's work as one snapshot FIRST — before guideline enforcement —
    // so a passing task is durably recorded no matter what enforcement later finds.
    const commit = await deps.commit(p.cwd, `task: ${p.title} (${p.taskId})`)
    if (commit.committed) {
        await rec(`commit: task snapshot committed${commit.note ? ` (${commit.note})` : ''}`)
        // SAY WHAT WAS LEFT OUT. The stage skips untracked regenerable test-runner
        // output, so a blind `git add -A` cannot make a screenshot a tracked
        // deliverable that a later fix attempt is then rejected for deleting. A
        // SILENT exclusion is the same failure class as a silent ignored-path write,
        // so it gets its own trail line.
        if (commit.excluded && commit.excluded.length > 0) {
            await rec(
                `commit: left ${commit.excluded.length} untracked test-runner artifact(s) out of the `
                    + `snapshot — regenerable output, not deliverables: `
                    + `${commit.excluded.slice(0, 8).join(', ')}`
                    + `${commit.excluded.length > 8 ? `, +${commit.excluded.length - 8} more` : ''}`
            )
        }
        notifyBoth(active, `${p.tag}: committed "${p.title}".`, 'info')
    } else {
        await rec(`commit: skipped (${commit.reason ?? 'unknown'})`)
        // A benign skip ("nothing to commit", auto-commit off) is a warning. A real
        // git failure is louder: it silently disables enforce AND every commit-based
        // guard, so a whole run can end with nothing committed and only per-task
        // warnings to show for it. "blocked" is the unmerged-index refusal
        // (gitCommitAll) — the same severity: nothing can commit until it's resolved.
        const gitFailure = /^git (commit|add) (failed|blocked)/.test(commit.reason ?? '')
        const line =
            gitFailure ?
                `${p.tag}: COMMIT FAILED (${commit.reason}) — enforce and revert guards are disabled for this task.`
            :   `${p.tag}: not committed (${commit.reason ?? 'unknown'}) — continuing.`
        // A git failure means the whole task ran unguarded. A remote user cannot
        // infer that from the widget, and a toast is gone before they look.
        if (gitFailure) notifyRun(active, line, 'error')
        else notifyBoth(active, line, 'warning')
    }
    // SAFE CHECKPOINT (post task commit): the work verified, the parent entry is
    // checked off and the snapshot is in HEAD. Only the enforce pass is skipped,
    // and enforce is re-runnable.
    //
    // Returns `done`, not `cancelled`: this task IS done, and `cancelled` would
    // announce "resume with /task-resume" over a task whose work is already
    // committed — a resume there re-runs the whole spec pipeline to redo it. The
    // flag stays raised, so /task-auto stops one step later at loop-top with the
    // right wording and a ticked checkbox, and a bare /task simply ends. The trail
    // line is what keeps the skip from being silent.
    if (cancelCheckpoint('gate:post-commit')) {
        await rec('enforce: skipped — cancel requested after the task snapshot committed')
        return {kind: 'done', ctx: active}
    }
    await runEnforcePass(active, deps, p, rec, routeRootCause, {cleanPass, commit})
    return {kind: 'done', ctx: active}
}
