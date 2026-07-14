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
import {readEnvNotes, appendEnvNotes} from './env-notes.js'
import {readContracts} from './contracts.js'
import {recordAcceptDebt, recordEnforceRevertDebt} from './accept-debt.js'
import {runRepoHealthCheck} from './repo-health-check.js'
import {runFinalIntegrationGate, discoverGateCommandLabels} from './final-gate.js'
import {runFinalGateAutofix, type FinalFixResult} from './final-gate-fix.js'
import {researchResolution} from './verify-resolution.js'
import {extractProhibitions, findProhibitionViolations} from './prohibition-probe.js'
import {frozenPathsFromSpec, revertFrozenPaths} from './frozen-path-guard.js'
import {findProbeGaming, parseAddedLines, type AddedLine} from './probe-gaming.js'
import {findSubstitutionSuspects, isTestFile, type ChangedFile} from './substitution-probe.js'
import {
    findTestRebuiltAssemblies,
    testAssemblyVerifyFindings,
    type RepoFile
} from './test-assembly.js'
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

/** Max chars of a tool result kept in the gate debug log (mx5 run 10 item 6). */
const TOOL_RESULT_LOG_LIMIT = 300

/**
 * One-line, tail-kept, whitespace-flattened summary of a tool's output for the gate
 * debug log. The TAIL is kept (a bind failure / final status / assertion lands at the
 * end of the output) with a leading ellipsis when truncated; empty output → "(no output)".
 */
export function truncateToolResult(text: string, limit = TOOL_RESULT_LOG_LIMIT): string {
    const flat = text.replace(/\s+/g, ' ').trim()
    if (flat.length === 0) return '(no output)'
    return flat.length > limit ? `…${flat.slice(-limit)}` : flat
}

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
 * Collect the task's added lines WITH CONTENT (path + text) for the probe-gaming
 * probe (F6), which needs the actual line text the numstat-shape collector omits.
 * Pre-commit the work is the tree-vs-HEAD diff plus untracked files (read whole, as
 * all-added); on the post-enforce re-verify the tree is clean, so fall back to the
 * last commit's diff. Failures degrade to an empty list — the probe is a sharpener,
 * never a blocker. The `.pi-tasks/` bookkeeping is excluded from every git command.
 */
export async function collectAddedLines(cwd: string, signal?: AbortSignal): Promise<AddedLine[]> {
    const tracked = await git(cwd, ['diff', 'HEAD', '--', '.', EXCLUDE_TASKS_DIR], signal)
    const lines: AddedLine[] = tracked.exitCode === 0 ? parseAddedLines(tracked.stdout) : []
    const untracked = await git(
        cwd,
        ['ls-files', '--others', '--exclude-standard', '--', '.', EXCLUDE_TASKS_DIR],
        signal
    )
    for (const name of splitLines(untracked.exitCode === 0 ? untracked.stdout : '')) {
        try {
            const content = await fsp.readFile(path.join(cwd, name), 'utf8')
            for (const text of content.split('\n')) lines.push({path: name, text})
        } catch {
            // unreadable/binary — nothing to report
        }
    }
    if (lines.length === 0) {
        const last = await git(cwd, ['diff', 'HEAD~1..HEAD', '--', '.', EXCLUDE_TASKS_DIR], signal)
        return last.exitCode === 0 ? parseAddedLines(last.stdout) : []
    }
    return lines
}

/** Source extensions whose relative imports the test-assembly probe reasons over. */
const SOURCE_EXT_RE = /\.(?:[cm]?[jt]sx?)$/
/** Bounds so the probe stays cheap on large repos (it reads file text). */
const MAX_PROBE_FILES = 4000
const MAX_PROBE_FILE_BYTES = 512 * 1024

/** Best-effort read of a repo file's text; unreadable/oversized → null (skipped). */
async function readRepoFile(cwd: string, rel: string): Promise<RepoFile | null> {
    try {
        const buf = await fsp.readFile(path.join(cwd, rel))
        if (buf.length > MAX_PROBE_FILE_BYTES) return null
        return {path: rel, text: buf.toString('utf8')}
    } catch {
        return null
    }
}

/**
 * Deterministic test-assembly probe input (see test-assembly.ts, run-8 F4): read the
 * task's own changed TEST files plus the repo's tracked source files, and return the
 * finding lines naming any test that rebuilds a production assembly it never imports.
 * Pure import-graph shape; failures degrade to no findings (the probe is a sharpener,
 * never a blocker). `changed` is the already-collected task diff, reused so the probe
 * costs one extra tracked-file listing, not a second diff.
 */
async function collectTestAssemblyFindings(
    cwd: string,
    changed: ChangedFile[],
    signal?: AbortSignal
): Promise<string[]> {
    const changedTests = changed.filter(f => isTestFile(f.path))
    if (changedTests.length === 0) return []
    const listed = await git(cwd, ['ls-files', '--', '.', EXCLUDE_TASKS_DIR], signal)
    if (listed.exitCode !== 0) return []
    const sources = splitLines(listed.stdout)
        .filter(p => SOURCE_EXT_RE.test(p))
        .slice(0, MAX_PROBE_FILES)
    const production: RepoFile[] = []
    for (const rel of sources) {
        if (isTestFile(rel)) continue
        const f = await readRepoFile(cwd, rel)
        if (f) production.push(f)
    }
    const testFiles: RepoFile[] = []
    for (const {path: rel} of changedTests) {
        const f = await readRepoFile(cwd, rel)
        if (f) testFiles.push(f)
    }
    return testAssemblyVerifyFindings(findTestRebuiltAssemblies(testFiles, production))
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
                        // Log tool OUTPUTS, not just the command (mx5 run 10 item 6):
                        // without the result "verify claimed curl PASS on a server that
                        // cannot serve" is undecidable from the log. Truncated, tail-kept
                        // (a bind failure / status usually lands at the end), error-flagged.
                        onToolResult: ({name, isError, text}) =>
                            log(
                                `↳ ${name} [${isError ? 'ERR' : 'ok'}]: ${truncateToolResult(text)}`
                            ),
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
                            // Distinguish the two outcomes in the trail: a tainting
                            // mutation (graded work altered → verdict will be
                            // discarded) vs benign cleanup (test-runner output the
                            // child left behind → verdict stands).
                            const label =
                                rec.verdictTainted ?
                                    'child mutated graded state (verdict discarded)'
                                :   'cleaned child test-runner artifacts (verdict kept)'
                            log(
                                `=== ${kind} GIT-STATE GUARD — ${label}; restored: ${rec.actions.join('; ')} ===`
                            )
                            if (rec.verdictTainted) {
                                gateCtx.ui.notify(
                                    `${taskTitle}: ${kind} child mutated repo state — restored (${rec.actions.join('; ').slice(0, 140)}).`,
                                    'warning'
                                )
                            }
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
        // Durable ACCEPT-despite-verify-FAIL ledger under .pi-tasks/ (survives
        // discardEdits): the final integration gate re-checks each debt at run end.
        recordAcceptDebt: (cwd2, taskId, reason) => recordAcceptDebt(cwd2, taskId, reason),
        recordEnforceRevertDebt: (cwd2, taskId, reason) =>
            recordEnforceRevertDebt(cwd2, taskId, reason),
        // Frozen-path write-deny (see frozen-path-guard.ts): the concrete paths this
        // task's spec forbids modifying, so the gate sequence can UNDO any edit the
        // enforce EDIT pass makes to them before those edits are committed. Reads the
        // same composed spec + extractProhibitions the verify probe consumes; empty on
        // a spec that froze nothing → the guard is a no-op.
        frozenPaths: async (cwd2, taskId) => {
            try {
                const {body} = await readTaskFile(cwd2, taskId)
                return frozenPathsFromSpec(extractSpecForVerification(body))
            } catch {
                return []
            }
        },
        // Restore those frozen paths to HEAD, discarding a gate child's edits to them;
        // returns the files actually reverted (for the trail). Best-effort git shape.
        revertFrozenPaths: (cwd2, paths) =>
            revertFrozenPaths(paths, async args => {
                const r = await git(cwd2, args, signal)
                return {stdout: r.stdout, exitCode: r.exitCode}
            }),
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
                // Deterministic test-assembly probe (F4): authored test files that
                // rebuild production wiring — importing the leaf modules the shipped
                // entry composes and assembling their own copy — become rule-3f
                // findings so the child drives the REAL assembly, not the copy.
                testAssemblyProbe: () =>
                    collectChangedFiles(cwd2, signal).then(changed =>
                        collectTestAssemblyFindings(cwd2, changed, signal)
                    ),
                // Deterministic probe-gaming probe (F6): added lines whose stated
                // purpose is to make a check pass rather than meet the requirement
                // ("return 401 so the verification test passes") become rule-4c
                // findings so the child verifies the real requirement, not the check.
                probeGamingProbe: () => collectAddedLines(cwd2, signal).then(findProbeGaming),
                // Deterministic prohibition probe: paths the spec forbids modifying
                // that the task's diff modified anyway become prompt-level findings
                // under the no-waiver rule — the child otherwise rarely runs `git
                // diff` and cannot even see the violation.
                prohibitionProbe: () => {
                    const banned = spec ? extractProhibitions(spec) : []
                    if (banned.length === 0) return Promise.resolve([])
                    return collectChangedFiles(cwd2, signal).then(files =>
                        findProhibitionViolations(banned, files)
                    )
                },
                // Git-state guard result of the most recent child run: a verdict
                // computed on a tree the child itself mutated is discarded — but ONLY
                // when the mutation touched graded state (verdictTainted). A child
                // that merely left test-runner output behind (test-results/,
                // playwright-report/ …) judged an equivalent tree; its verdict stands
                // and the artifacts were still cleaned (mx5 run 9 lost 7 verdicts this
                // way — see git-state-guard.ts).
                mutationCheck: () =>
                    lastGuardReconcile?.verdictTainted ?
                        {mutated: true, detail: lastGuardReconcile.actions.join('; ')}
                    :   {mutated: false, detail: ''},
                // Per-run environment-facts cache under .pi-tasks/ (survives
                // discardEdits): earlier children's discoveries save this child
                // the re-archaeology; its own ENV-NOTE lines are stored for the
                // next one, stamped with this task's id as their origin so a
                // later child sees a cited fact is second-hand and must
                // re-validate before excusing a failure (F7). Facts only —
                // verdict rules unaffected.
                envNotes: {
                    read: () => readEnvNotes(cwd2),
                    append: notes => appendEnvNotes(cwd2, notes, taskId)
                },
                // Per-run cross-slice contract registry under .pi-tasks/ (F3): the
                // verbatim interface facts the design pins that multiple slices
                // share, so the verify child checks this slice's boundary against
                // them. Empty on single-`/task` runs or a design with no shared
                // boundary → no block.
                contracts: () => readContracts(cwd2)
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
