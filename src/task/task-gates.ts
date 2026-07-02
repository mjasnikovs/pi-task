/**
 * task-gates — the post-implementation GATE sequence shared by /task-auto's per-task
 * loop and the single /task command.
 *
 * After a task's implementation turn settles, the same two gates run against the
 * just-finished work:
 *
 *   1. VERIFY — RUN the composed spec's VERIFY block in the real workspace and
 *      judge a PASS/FAIL. A FAIL offers the user a boxed AUTOFIX / ACCEPT / dismiss
 *      picker (the user always decides; AUTOFIX re-runs the implementation turn and
 *      loops back to the gate uncapped).
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
        failReason: string
    ) => Promise<{ok: boolean; reason?: string}>
    /**
     * Deterministic whole-repo static check (repo-health), used as the PRE-COMMIT
     * gate on an edit-mode enforce pass: live data shows enforce edits broke the
     * repo's own lint in 11 of 16 tasks, each costing a commit + model re-verify +
     * revert cycle. Checking before committing skips that cycle. Absent → the old
     * commit-then-differential path runs unchanged.
     */
    repoHealth?: (cwd: string) => Promise<{ok: boolean; reason: string}>
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
        // A FAIL no longer dead-stops: offer the boxed AUTOFIX / ACCEPT / dismiss
        // picker. The USER always decides; AUTOFIX loops straight back to the gate
        // as many times as they keep choosing it (no attempt cap).
        let lintFixAttempted = false
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
                const fix = await deps.lintFix(active, p.cwd, p.title, failReason)
                await rec(
                    `lint-fix: ${fix.ok ? 'applied — re-verifying' : `not applied (${fix.reason ?? 'failed'})`}`
                )
                if (fix.ok) {
                    verified = await deps.verify(active, p.cwd, p.title, p.taskId)
                    await rec(verdictLine(verified))
                    continue
                }
            }
            const recOutcome: ResolutionOutcome =
                deps.recommend ?
                    await deps.recommend(active, p.cwd, p.title, p.taskId, failReason)
                :   {recommend: 'autofix', rationale: failReason}
            await rec(`resolution: recommended ${recOutcome.recommend.toUpperCase()}`)
            const choice = await askVerifyResolution(active, p.title, failReason, recOutcome)
            if (choice.action === 'cancel') {
                await rec('resolution: user dismissed the verify-FAIL picker — paused')
                return {kind: 'paused', ctx: active, reason: failReason}
            }
            if (choice.action === 'accept') {
                await rec('resolution: user ACCEPTED the work despite verify FAIL')
                active.ui.notify(
                    `${p.tag}: accepted "${p.title}" despite verify FAIL (${failReason.slice(0, 120)}) — proceeding.`,
                    'warning'
                )
                break
            }
            // AUTOFIX: re-run the implementation turn with the failure (and any typed
            // guidance) prepended as a RE-ATTEMPT banner, then re-verify.
            await rec('resolution: user chose AUTOFIX — re-running the implementation turn')
            active.ui.notify(`${p.tag}: autofixing "${p.title}"…`, 'info')
            const fixInstruction =
                choice.guidance ? `${failReason}\n\nUser guidance: ${choice.guidance}` : failReason
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
        await rec('commit: task snapshot committed')
        active.ui.notify(`${p.tag}: committed "${p.title}".`, 'info')
    } else {
        await rec(`commit: skipped (${commit.reason ?? 'unknown'})`)
        active.ui.notify(
            `${p.tag}: not committed (${commit.reason ?? 'unknown'}) — continuing.`,
            'warning'
        )
    }
    // With the task committed, hold its work to AGENTS.md / CLAUDE.md — but as a step
    // INSIDE the validation gate, gated by the verify signal (see GateDeps.enforce).
    // Skipped when nothing was committed this round, when enforce is off, or in tests
    // with no enforce dep.
    if (deps.enforce && commit.committed) {
        const mode: 'edit' | 'flag' = verifyCleanPass ? 'edit' : 'flag'
        active.ui.notify(
            mode === 'edit' ?
                `${p.tag}: enforcing AGENTS.md/CLAUDE.md on "${p.title}"…`
            :   `${p.tag}: reviewing "${p.title}" against AGENTS.md/CLAUDE.md (no verify signal — report only)…`,
            'info'
        )
        const verdict = await deps.enforce(active, p.cwd, p.title, mode)
        // The child's verdict and its edits are independent facts: the pass has been
        // observed declaring "clean" while having edited files (which then get
        // committed as fixes) — record both so the trail cannot contradict itself.
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
        let enforceEditsBlocked = false
        if (mode === 'edit' && deps.repoHealth && editsMade !== false) {
            const h = await deps.repoHealth(p.cwd)
            if (!h.ok) {
                enforceEditsBlocked = true
                if (deps.discardEdits) {
                    await deps.discardEdits(p.cwd)
                    await rec(`enforce: edits discarded pre-commit (repo health: ${h.reason})`)
                } else {
                    await rec(
                        `enforce: edits FAILED repo health pre-commit (${h.reason}) — no discard available, left uncommitted`
                    )
                }
                active.ui.notify(
                    `${p.tag}: guideline edits on "${p.title}" failed repo health (${h.reason.slice(0, 120)}) — discarded before commit.`,
                    'warning'
                )
            }
        }
        if (mode === 'edit' && !enforceEditsBlocked) {
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
                if (!after.ok) {
                    if (deps.revert) await deps.revert(p.cwd)
                    await rec(
                        `enforce: fixes committed but re-verify FAILED (${(after.reason ?? 'now fails').slice(0, 200)}) — ${deps.revert ? 'REVERTED' : 'left in place (no revert available)'}`
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
