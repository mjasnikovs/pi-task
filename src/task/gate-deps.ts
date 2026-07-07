/**
 * gate-deps — builds the concrete {@link GateDeps} (verify / enforce / recommend /
 * commit / revert) that the post-implementation gate sequence drives.
 *
 * Lifted out of /task-auto's `defaultDeps` so both /task-auto and the single /task
 * command construct the gate children identically. `runTask` (the AUTOFIX re-run) is
 * INJECTED rather than imported, so this module never imports the orchestrators —
 * keeping the dependency graph acyclic (the orchestrators import this).
 *
 * The gate children — verify, the post-FAIL recommend, and enforce — are read-only
 * (or read,edit for enforce) passes of the same local model that must run to
 * completion: unguarded (no wall-clock timeout, exact-match loop guard only,
 * path-revisit disabled because re-running the same check IS the job), each with a
 * status widget and a per-gate debug log under .pi-tasks/.
 */
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import type {ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import type {GateDeps} from './task-gates.js'
import {tasksDir, readTaskFile, appendGateRecord} from './task-io.js'
import {gitCommitAll, gitDropLastCommit, git} from './auto-commit.js'
import {runGuidelineEnforcement, classifyEnforceChildFailure} from './enforce-guidelines.js'
import {runWorkVerification, extractSpecForVerification} from './verify-work.js'
import {runRepoHealthCheck} from './repo-health-check.js'
import {runFinalIntegrationGate, discoverGateCommandLabels} from './final-gate.js'
import {runFinalGateAutofix, type FinalFixResult} from './final-gate-fix.js'
import {researchResolution} from './verify-resolution.js'
import {findSubstitutionSuspects, type ChangedFile} from './substitution-probe.js'
import {runBoundedLintFix} from './lint-fix.js'
import {captureGitState, reconcileGitState, type ReconcileResult} from './git-state-guard.js'
import {runWorker} from '../workers/pi-worker-core.js'
import {formatLoopHint} from './child-runner.js'
import {getConfig} from '../config/config.js'
import {startAutoLoader, type ContextSnapshot} from './widget.js'
import {resolveContextUsage} from './context-usage.js'

/** A function that re-runs a task's implementation turn (AUTOFIX). Injected by the
 *  command so this module stays free of the orchestrators (avoids an import cycle). */
export type RunTaskFn = GateDeps['runTask']

/** One bounded final-gate fix attempt (see final-gate-fix.ts): fix child →
 *  shrink guard → gate re-run. Consumed by /task-auto's run-end gate branch. */
export type FinalGateFixFn = (
    ctx: ExtensionCommandContext,
    cwd: string,
    failReason: string
) => Promise<FinalFixResult>

/** Keep the gate machinery's own artifacts out of every git pathspec below. */
const EXCLUDE_TASKS_DIR = ':(exclude).pi-tasks'

const splitLines = (s: string): string[] =>
    s
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0)

/** Parse `git diff --numstat` output into {path, addedLines} (binary files → 0). */
const parseNumstat = (stdout: string): ChangedFile[] =>
    splitLines(stdout).flatMap(line => {
        const [added, , ...rest] = line.split('\t')
        const p = rest.join('\t')
        if (!p) return []
        const n = Number.parseInt(added, 10)
        return [{path: p, addedLines: Number.isNaN(n) ? 0 : n}]
    })

/**
 * Collect the task's changed files as pure GIT SHAPE — path + added-line count,
 * no content, no language parsing — for the self-verification probe. Before the
 * task commit the work is the tree-vs-HEAD diff (+ untracked files, counted from
 * disk); on the post-enforce re-verify the tree is clean, so fall back to the last
 * commit. Failures degrade to an empty list — the probe is a sharpener, never a
 * blocker.
 */
export async function collectChangedFiles(
    cwd: string,
    signal?: AbortSignal
): Promise<ChangedFile[]> {
    const tracked = await git(
        cwd,
        ['diff', '--numstat', 'HEAD', '--', '.', EXCLUDE_TASKS_DIR],
        signal
    )
    const files = tracked.exitCode === 0 ? parseNumstat(tracked.stdout) : []
    const untracked = await git(
        cwd,
        ['ls-files', '--others', '--exclude-standard', '--', '.', EXCLUDE_TASKS_DIR],
        signal
    )
    for (const name of splitLines(untracked.exitCode === 0 ? untracked.stdout : '')) {
        try {
            const content = await fsp.readFile(path.join(cwd, name), 'utf8')
            files.push({path: name, addedLines: content.split('\n').length})
        } catch {
            // unreadable/binary — nothing to report
        }
    }
    if (files.length === 0) {
        const last = await git(
            cwd,
            ['diff', '--numstat', 'HEAD~1..HEAD', '--', '.', EXCLUDE_TASKS_DIR],
            signal
        )
        return last.exitCode === 0 ? parseNumstat(last.stdout) : []
    }
    return files
}

/**
 * Build the gate deps for one command run. `runTask` is the orchestrator's
 * implementation re-runner, injected by the caller. The returned object also drives
 * a shared status widget: `getLastLine`/`getContextUsage` expose the children's
 * latest stream line and context usage so the caller can mirror them in its own
 * loader if it wants (the gate closures already render their own loaders).
 */
export function buildGateDeps(params: {
    signal: AbortSignal
    parentContextWindow: number
    runTask: RunTaskFn
}): GateDeps & {finalGateFix: FinalGateFixFn} {
    const {signal, parentContextWindow, runTask} = params
    // Captured by each gate child's loader so the widget mirrors the child's latest
    // output line and context usage, exactly like the single-task phase widget.
    let lastLine: string | undefined
    let contextUsage: ContextSnapshot | undefined
    // What the git-state guard had to restore after the MOST RECENT verify/recommend
    // child run (see git-state-guard.ts). runWorkVerification reads this through its
    // mutationCheck dep to discard a verdict computed on a mutated tree.
    let lastGuardReconcile: ReconcileResult | null = null

    // Restore tracked files to HEAD and drop files a pass created; the .pi-tasks
    // trail/log writes made during the pass survive both. Shared by the enforce
    // pre-commit gate (discardEdits) and the final-gate autofix shrink guard.
    const discardTreeEdits = async (cwd2: string): Promise<void> => {
        await git(cwd2, ['checkout', '--', '.', EXCLUDE_TASKS_DIR], signal)
        await git(cwd2, ['clean', '-fd', '-e', '.pi-tasks'], signal)
    }

    // Shared runner for the per-task GATE children (verify + post-FAIL recommend).
    // Both are read-only passes of the same local model that must run to completion:
    // unguarded (no wall-clock timeout, exact-match loop guard only, path-revisit
    // disabled because re-running the same check is the job), with a status widget
    // and a per-gate debug log. Returns the closure runWorkVerification /
    // researchResolution expect as `runChild`.
    const makeGateChild =
        (
            gateCtx: ExtensionCommandContext,
            cwd2: string,
            taskTitle: string,
            kind: 'verify' | 'recommend' | 'lint-fix' | 'final-fix',
            logFile: string
        ) =>
        async (tools: string, prompt: string, sig?: AbortSignal): Promise<string> => {
            lastLine = undefined
            contextUsage = undefined
            lastGuardReconcile = null
            const startedAt = Date.now()
            const logPath = path.join(tasksDir(cwd2), logFile)
            const log = (msg: string): void => {
                void fsp.appendFile(logPath, `${new Date().toISOString()} ${msg}\n`).catch(() => {})
            }
            log(`=== ${kind} start: ${taskTitle} ===`)
            // GIT-STATE GUARD: these children are read-only BY CONTRACT, but the
            // contract is prompt-level and the live model breaks it (mx5 run 6: the
            // verify child `git stash`ed the task's uncommitted work and never popped
            // — the impl was destroyed and the orphan stash detonated 2 days later).
            // Snapshot before, deterministically restore after; lint-fix is excluded
            // because editing is its job (it carries its own revert guard).
            const guardSnapshot =
                kind === 'verify' || kind === 'recommend' ? await captureGitState(cwd2, sig) : null
            const stopLoader = startAutoLoader(gateCtx, () => ({
                title: taskTitle,
                kind,
                step: kind,
                stepNum: 1,
                stepTotal: 1,
                startedAt,
                lastLine,
                contextUsage
            }))
            try {
                let r
                try {
                    r = await runWorker({
                        prompt,
                        cwd: cwd2,
                        signal: sig,
                        tools,
                        timeoutMs: 0,
                        loop: {pathThreshold: Number.POSITIVE_INFINITY},
                        onLine: line => {
                            lastLine = line
                            log(line)
                        },
                        onContextUsage: snapshot => {
                            contextUsage = resolveContextUsage(
                                snapshot,
                                contextUsage,
                                parentContextWindow
                            )
                        }
                    })
                } finally {
                    // Restore whatever the child moved BEFORE any verdict/failure is
                    // acted on — a crashed child must not skip the restore either.
                    if (guardSnapshot) {
                        const rec = await reconcileGitState(cwd2, guardSnapshot, sig)
                        lastGuardReconcile = rec
                        if (rec.mutated) {
                            log(
                                `=== ${kind} GIT-STATE GUARD — child mutated repo state; restored: ${rec.actions.join('; ')} ===`
                            )
                            gateCtx.ui.notify(
                                `${taskTitle}: ${kind} child mutated repo state — restored (${rec.actions.join('; ').slice(0, 140)}).`,
                                'warning'
                            )
                        }
                    }
                }
                if (r.loopHit) {
                    log(`=== ${kind} LOOP WARNING — ${formatLoopHint(r.loopHit)} ===`)
                    gateCtx.ui.notify(
                        `${taskTitle}: ${kind} worker looped past the nudges — continuing (not blocked).`,
                        'warning'
                    )
                }
                const failure = classifyEnforceChildFailure(r)
                log(failure ? `=== ${kind} end: FAIL — ${failure} ===` : `=== ${kind} end: ok ===`)
                if (failure) throw new Error(failure)
                return r.text
            } finally {
                stopLoader()
            }
        }

    return {
        runTask,
        // Durable per-task gate trail: every verdict/decision lands in the task
        // file's `## gates` section so gate behavior is auditable from artifacts.
        record: (cwd2, taskId, line) => appendGateRecord(cwd2, taskId, line),
        commit: (cwd2, message) =>
            getConfig().autoCommit ?
                gitCommitAll(cwd2, message, signal)
            :   Promise.resolve({committed: false, reason: 'auto-commit disabled'}),
        revert: cwd2 => gitDropLastCommit(cwd2, signal),
        enforce: (enforceCtx, cwd2, taskTitle, mode) => {
            if (!getConfig().enforceGuidelines) {
                return Promise.resolve({ok: true, reason: 'disabled'})
            }
            return runGuidelineEnforcement({
                cwd: cwd2,
                signal,
                mode,
                // Run the worker child UNGUARDED: no loop detector, no wall-clock
                // timeout. This pass reworks files in place until every violation is
                // fixed and legitimately reads/edits the same file many times — the
                // research-worker guards mislabel that as a runaway and kill good work
                // (proven on mx5 TASK_0002). classifyEnforceChildFailure still blocks
                // on a real failure (non-zero exit, leaked tool call) or a user cancel.
                runChild: async (tools, prompt, sig) => {
                    lastLine = undefined
                    contextUsage = undefined
                    const startedAt = Date.now()
                    // Per-pass debug log; the enforce child is otherwise unobservable.
                    const enforceLogPath = path.join(tasksDir(cwd2), 'enforce-debug.log')
                    const logEnforce = (msg: string): void => {
                        void fsp
                            .appendFile(enforceLogPath, `${new Date().toISOString()} ${msg}\n`)
                            .catch(() => {})
                    }
                    logEnforce(`=== enforce start: ${taskTitle} ===`)
                    const stopLoader = startAutoLoader(enforceCtx, () => ({
                        title: taskTitle,
                        kind: 'enforce',
                        step: 'guidelines',
                        stepNum: 1,
                        stepTotal: 1,
                        startedAt,
                        lastLine,
                        contextUsage
                    }))
                    try {
                        const r = await runWorker({
                            prompt,
                            cwd: cwd2,
                            signal: sig,
                            tools,
                            timeoutMs: 0, // no wall-clock timeout — run to completion
                            // Exact-match loop guard only: pathThreshold Infinity
                            // disables the path-revisit heuristic, so revisiting one
                            // file (which IS this pass's job) never trips — only a
                            // literally-identical call repeated past threshold does.
                            loop: {pathThreshold: Number.POSITIVE_INFINITY},
                            onLine: line => {
                                lastLine = line
                                logEnforce(line)
                            },
                            onContextUsage: snapshot => {
                                contextUsage = resolveContextUsage(
                                    snapshot,
                                    contextUsage,
                                    parentContextWindow
                                )
                            }
                        })
                        // A loop that survived the restart-with-hint nudges is a
                        // warning, not a failure: log it and tell the user, but let the
                        // verdict gate be the only thing that can block.
                        if (r.loopHit) {
                            logEnforce(
                                `=== enforce LOOP WARNING — ${formatLoopHint(r.loopHit)} ===`
                            )
                            enforceCtx.ui.notify(
                                `${taskTitle}: enforce worker looped past the nudges — continuing (not blocked).`,
                                'warning'
                            )
                        }
                        const failure = classifyEnforceChildFailure(r)
                        logEnforce(
                            failure ?
                                `=== enforce end: FAIL — ${failure} ===`
                            :   '=== enforce end: verdict captured ==='
                        )
                        if (failure) throw new Error(failure)
                        return r.text
                    } finally {
                        stopLoader()
                    }
                }
            })
        },
        verify: async (verifyCtx, cwd2, taskTitle, taskId) => {
            if (!getConfig().verifyWork) {
                return {ok: true, reason: 'disabled'}
            }
            // The spec to verify against is the composed spec committed in the task
            // file. A task that never reached compose has no spec section —
            // runWorkVerification treats a null spec as a no-op pass.
            let spec: string | null
            try {
                const {body} = await readTaskFile(cwd2, taskId)
                spec = extractSpecForVerification(body)
            } catch {
                spec = null
            }
            return runWorkVerification({
                cwd: cwd2,
                signal,
                spec,
                runChild: makeGateChild(verifyCtx, cwd2, taskTitle, 'verify', 'verify-debug.log'),
                // Deterministic whole-repo static-analysis gate — runs the project's
                // own lint/typecheck and fails on a real non-zero exit, independent of
                // the model-authored VERIFY block (which may not lint at all).
                repoHealth: () => Promise.resolve(runRepoHealthCheck(cwd2)),
                // Deterministic self-verification probe: test files the task itself
                // authored/changed become prompt-level findings mandating the child
                // to drive the real artifact before trusting their green result.
                probe: () => collectChangedFiles(cwd2, signal).then(findSubstitutionSuspects),
                // Git-state guard result of the most recent child run: a verdict
                // computed on a tree the child itself mutated is discarded (the
                // guard already restored the state — see git-state-guard.ts).
                mutationCheck: () =>
                    lastGuardReconcile?.mutated ?
                        {mutated: true, detail: lastGuardReconcile.actions.join('; ')}
                    :   {mutated: false, detail: ''}
            })
        },
        lintFix: (fixCtx, cwd2, taskTitle, failReason) =>
            runBoundedLintFix({
                cwd: cwd2,
                signal,
                failReason,
                runChild: makeGateChild(fixCtx, cwd2, taskTitle, 'lint-fix', 'verify-debug.log'),
                repoHealth: () => Promise.resolve(runRepoHealthCheck(cwd2)),
                git: async args => {
                    const r = await git(cwd2, args, signal)
                    return {exitCode: r.exitCode, stdout: r.stdout}
                }
            }),
        // Deterministic static check + tree helpers for the enforce pre-commit gate.
        repoHealth: cwd2 => Promise.resolve(runRepoHealthCheck(cwd2)),
        dirty: async cwd2 => {
            const r = await git(
                cwd2,
                ['status', '--porcelain', '--', '.', EXCLUDE_TASKS_DIR],
                signal
            )
            return r.exitCode === 0 && r.stdout.trim().length > 0
        },
        discardEdits: discardTreeEdits,
        finalGateFix: (fixCtx, cwd2, failReason) =>
            runFinalGateAutofix({
                cwd: cwd2,
                signal,
                failReason,
                runChild: makeGateChild(
                    fixCtx,
                    cwd2,
                    'final integration gate',
                    'final-fix',
                    'final-gate-debug.log'
                ),
                // The gate re-run is the only arbiter of convergence, and the
                // shrink guard's discovery is the gate's own (see final-gate.ts).
                gate: c => runFinalIntegrationGate(c),
                discoverLabels: discoverGateCommandLabels,
                discard: discardTreeEdits
            }),
        recommend: async (recCtx, cwd2, taskTitle, taskId, failReason) => {
            // Read the same composed spec the verify gate judged against, so the
            // recommendation reasons over the real contract (degrade to the bare title).
            let spec: string
            try {
                const {body} = await readTaskFile(cwd2, taskId)
                spec = extractSpecForVerification(body) ?? taskTitle
            } catch {
                spec = taskTitle
            }
            return researchResolution({
                cwd: cwd2,
                signal,
                spec,
                failReason,
                runChild: makeGateChild(recCtx, cwd2, taskTitle, 'recommend', 'verify-debug.log')
            })
        }
    }
}
