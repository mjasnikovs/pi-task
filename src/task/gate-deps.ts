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
import {existsSync} from 'node:fs'
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
import {
    recordAcceptDebt,
    recordEnforceKeptDebt,
    recordEnforceRevertDebt,
    recordFrozenBlockedDebt,
    recordCrossTaskDeletionDebt,
    recordYoloAcceptDebt,
    recordRootCauseDebt
} from './accept-debt.js'
import {recordRepairCandidate} from './root-cause-repair.js'
import {runRepoHealthCheck} from './repo-health-check.js'
import {runFinalIntegrationGate, discoverGateCommandLabels} from './final-gate.js'
import {runFinalGateAutofix, type FinalFixResult} from './final-gate-fix.js'
import {researchResolution} from './verify-resolution.js'
import {extractProhibitions, findProhibitionViolations} from './prohibition-probe.js'
import {frozenPathsFromSpec, revertFrozenPaths} from './frozen-path-guard.js'
import {findProbeGaming, parseAddedLines, type AddedLine} from './probe-gaming.js'
import {findSubstitutionSuspects, isTestFile, type ChangedFile} from './substitution-probe.js'
import {
    parseTreeChanges,
    parseNameStatusChanges,
    formatTreeChanges,
    type TreeChangeSummary
} from './write-guard.js'
import {taskThatIntroduced, findCrossTaskDeletions} from './task-provenance.js'
import {
    findTestRebuiltAssemblies,
    testAssemblyVerifyFindings,
    type RepoFile
} from './test-assembly.js'
import {runBoundedLintFix} from './lint-fix.js'
import {findForeignPaths, foreignPathVerifyFindings, repairForeignPaths} from './foreign-path.js'
import {
    findScriptEscapesInManifest,
    scriptEscapeVerifyFindings,
    type ScriptEscapeFinding
} from './script-escape.js'
import {assessRunnerGlobs, runnerGlobVerifyFindings} from './runner-globs.js'
import {captureGitState, reconcileGitState, type ReconcileResult} from './git-state-guard.js'
import {runWorker} from '../workers/pi-worker-core.js'
import {formatLoopHint} from './child-runner.js'
import {getConfig} from '../config/config.js'
import {makeDebugAppender} from './debug-log.js'
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

/**
 * Deterministic sandbox-path-leak pass (see foreign-path.ts, mx5 run 13 PROMPT 4
 * item 1): find absolute paths the task committed that resolve nowhere on this
 * machine while the real file sits in the repo, REPAIR the ones whose relative
 * form provably resolves, and return verify findings for whatever is left.
 *
 * The repair runs here, before the verify child, for the same reason lint-fix
 * does: the defect is mechanical and the correct target is already known, so
 * spending an AUTOFIX round (or a human) on a path substitution is waste. What it
 * cannot repair still reaches the child under rule 4e. Failures degrade to no
 * findings — a sharpener, never a blocker.
 */
async function collectForeignPathFindings(
    cwd: string,
    signal?: AbortSignal,
    logDebug?: (m: string) => void
): Promise<string[]> {
    const lines = await collectAddedLines(cwd, signal)
    if (lines.length === 0) return []
    const findings = findForeignPaths(
        lines,
        abs => existsSync(abs),
        rel => existsSync(path.join(cwd, rel))
    )
    if (findings.length === 0) return []
    const {repaired, remaining} = await repairForeignPaths(findings, {
        readFile: rel => fsp.readFile(path.join(cwd, rel), 'utf8'),
        writeFile: (rel, text) => fsp.writeFile(path.join(cwd, rel), text, 'utf8'),
        existsInRepo: rel => existsSync(path.join(cwd, rel))
    })
    for (const r of repaired) logDebug?.(`sandbox path leak repaired — ${r}`)
    for (const f of remaining) {
        logDebug?.(`sandbox path leak NOT repaired — ${f.file}: ${f.absolute}`)
    }
    return foreignPathVerifyFindings(remaining)
}

/** Manifests whose `scripts` the check-script scanner understands. */
const MANIFEST_RE = /(^|\/)package\.json$/

/**
 * Deterministic neutered-check-script pass (see script-escape.ts, mx5 run 13 PROMPT
 * 4 item 4): check-class scripts that cannot report failure, in a manifest THIS
 * task changed.
 *
 * Scoped to manifests the task touched, so the finding lands on the task that
 * authored the script rather than being re-served to every later task. A script
 * neutered by an earlier task is the whole-repo final gate's business, which
 * re-checks the shipped manifest at run end regardless of who wrote it.
 *
 * Failures degrade to no findings — a sharpener, never a blocker.
 */
async function collectScriptEscapeFindings(cwd: string, signal?: AbortSignal): Promise<string[]> {
    const changed = await collectChangedFiles(cwd, signal)
    const manifests = changed.map(f => f.path).filter(p => MANIFEST_RE.test(p))
    const findings: ScriptEscapeFinding[] = []
    for (const rel of manifests) {
        try {
            findings.push(
                ...findScriptEscapesInManifest(await fsp.readFile(path.join(cwd, rel), 'utf8'))
            )
        } catch {
            // unreadable/absent manifest — nothing to report
        }
    }
    return scriptEscapeVerifyFindings(findings)
}

/** Playwright config filenames, in the order playwright itself resolves them. */
const PLAYWRIGHT_CONFIGS = [
    'playwright.config.ts',
    'playwright.config.js',
    'playwright.config.mts',
    'playwright-ct.config.ts',
    'playwright-ct.config.js'
]

/** Read a repo file as text, or null when absent/unreadable. */
async function readOrNull(cwd: string, rel: string): Promise<string | null> {
    try {
        return await fsp.readFile(path.join(cwd, rel), 'utf8')
    } catch {
        return null
    }
}

/**
 * Deterministic test-runner glob-collision pass (see runner-globs.ts, mx5 runs 7 AND
 * 13, PROMPT 4 item 2): the manifest declares both `bun test` and `playwright test`
 * without a provably disjoint file set, so `bun test` imports the playwright specs
 * and dies during collection.
 *
 * Whole-repo rather than diff-scoped, unlike the neutered-script probe: a collision
 * is a property of the PAIR of declarations, and the task that completes the pair is
 * rarely the one that will be blamed by a diff. It is cheap (two small file reads)
 * and silent unless both runners are actually declared. Failures degrade to no
 * findings — a sharpener, never a blocker.
 */
async function collectRunnerGlobFindings(cwd: string): Promise<string[]> {
    const manifestText = await readOrNull(cwd, 'package.json')
    if (manifestText === null) return []
    let scripts: Record<string, string>
    try {
        const parsed: unknown = JSON.parse(manifestText)
        const raw = (parsed as {scripts?: unknown} | null)?.scripts
        if (typeof raw !== 'object' || raw === null) return []
        scripts = raw as Record<string, string>
    } catch {
        return []
    }
    let playwrightConfig: string | null = null
    for (const name of PLAYWRIGHT_CONFIGS) {
        playwrightConfig = await readOrNull(cwd, name)
        if (playwrightConfig !== null) break
    }
    return runnerGlobVerifyFindings(
        assessRunnerGlobs({
            scripts,
            bunfig: await readOrNull(cwd, 'bunfig.toml'),
            playwrightConfig
        })
    )
}

/**
 * The working tree's current changes as a summary (write-guard shape): what a
 * write-capable gate child changed, given the tree was clean when it started.
 * Failures degrade to an empty summary — the guard then has nothing to reject.
 */
export async function collectTreeChanges(
    cwd: string,
    signal?: AbortSignal
): Promise<TreeChangeSummary> {
    const r = await git(cwd, ['status', '--porcelain', '--', '.', EXCLUDE_TASKS_DIR], signal)
    return r.exitCode === 0 ? parseTreeChanges(r.stdout) : {modified: [], deleted: [], added: []}
}

/**
 * The task's changes for the cross-task deletion probe: the working tree's status
 * when the work is uncommitted (pre-commit verify), else the LAST COMMIT's
 * name-status diff (the post-enforce re-verify runs on a clean tree, where that
 * commit IS the task's work). Failures degrade to an empty summary — the probe is
 * a sharpener, never a blocker. Same fallback discipline as collectChangedFiles.
 */
export async function collectTaskTreeChanges(
    cwd: string,
    signal?: AbortSignal
): Promise<TreeChangeSummary> {
    const now = await collectTreeChanges(cwd, signal)
    if (now.modified.length + now.deleted.length + now.added.length > 0) return now
    const last = await git(
        cwd,
        ['diff', '--name-status', 'HEAD~1..HEAD', '--', '.', EXCLUDE_TASKS_DIR],
        signal
    )
    return last.exitCode === 0 ? parseNameStatusChanges(last.stdout) : now
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
            // `kind` defaults to 'event': every marker below (start/end, the
            // git-state guard's restore, the loop warning, a write-capable child's
            // tree changes) is a guard record that survives at the default level.
            // Only the child's own stdout and its tool results pass 'stream'.
            const log = makeDebugAppender(path.join(tasksDir(cwd2), logFile))
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
                        // The gate child runs to completion (timeoutMs 0), but a
                        // single command inside it must still be bounded: pi's bash
                        // tool has no default timeout, so a `bun run dev` / hung
                        // check the model forgot to bound wedges the gate forever.
                        // The stall guard cannot see it — a reachable model endpoint
                        // reads as proof of life while the command blocks. Same
                        // ceiling the main session uses, so one /task-config knob
                        // covers implementation and gates alike.
                        commandTimeoutMs: getConfig().requestTimeoutMs,
                        // Same reasoning one level up: a gate child with no
                        // wall-clock cap also needs the HUNG-STREAM bound, which
                        // the probe-based stall guard structurally cannot supply
                        // (a healthy endpoint reads as proof of life).
                        streamInactivityMs: getConfig().streamInactivityMs,
                        loop: {pathThreshold: Number.POSITIVE_INFINITY},
                        // A discarded attempt is otherwise invisible here too: the
                        // returned exitCode/text describe the FINAL attempt, so a
                        // gate child that burned two attempts and its wall clock
                        // reads exactly like one that ran clean.
                        onRestart: rs =>
                            log(
                                `=== ${kind} RESTART (attempt ${rs.attempt} discarded)`
                                    + ` reason=${rs.reason} wall=${rs.wallMs}ms`
                                    + (rs.detail ? ` — ${rs.detail}` : '')
                                    + ' ==='
                            ),
                        onLine: line => {
                            // `lastLine` feeds the LIVE status widget and is not
                            // logging — it stays outside the gate, or a quiet
                            // trail would also blank the progress display.
                            lastLine = line
                            log(line, 'stream')
                        },
                        // Log tool OUTPUTS, not just the command (mx5 run 10 item 6):
                        // without the result "verify claimed curl PASS on a server that
                        // cannot serve" is undecidable from the log. Truncated, tail-kept
                        // (a bind failure / status usually lands at the end), error-flagged.
                        onToolResult: ({name, isError, text}) =>
                            log(
                                `↳ ${name} [${isError ? 'ERR' : 'ok'}]: ${truncateToolResult(text)}`,
                                'stream'
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
                // CAPABILITY-LEVEL diff capture (mx5 run 11): any WRITE-capable
                // child — decided by its tools, not by which phase spawned it —
                // gets its tree changes logged, so a future write-capable kind
                // cannot run invisibly the way the final-fix child's `rm` did.
                if (/\b(?:edit|bash|write)\b/.test(tools)) {
                    log(
                        `=== ${kind} tree changes: ${formatTreeChanges(await collectTreeChanges(cwd2, sig))} ===`
                    )
                }
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
        recordYoloAcceptDebt: (cwd2, taskId, reason) => recordYoloAcceptDebt(cwd2, taskId, reason),
        recordEnforceRevertDebt: (cwd2, taskId, reason) =>
            recordEnforceRevertDebt(cwd2, taskId, reason),
        // Same ledger, the KEPT disposition (mx5 run 18 / nexttask 4): the enforce
        // re-verify FAILed on a check the enforce diff cannot reach, so the edits
        // stayed and only the defect was recorded.
        recordEnforceKeptDebt: (cwd2, taskId, reason) =>
            recordEnforceKeptDebt(cwd2, taskId, reason),
        // Durable cross-task-contradiction ledger (PROMPT 1 layer B): a repo-health
        // FAIL whose only fix is an edit to a path this task's spec froze — recorded
        // when the gate loop routes it to the picker, re-checked by the final gate.
        recordFrozenBlockedDebt: (cwd2, taskId, reason) =>
            recordFrozenBlockedDebt(cwd2, taskId, reason),
        // Durable cross-task-deletion ledger (PROMPT 2): a sibling's committed
        // deliverable this task's diff deletes, ACCEPTed into a commit anyway —
        // the final gate re-checks it (resolved iff the file is back in the tree).
        recordCrossTaskDeletionDebt: (cwd2, taskId, deletion) =>
            recordCrossTaskDeletionDebt(cwd2, taskId, deletion),
        // ROOT-CAUSE channel (mx5 run 14 item 5): a FAIL another task's untouched
        // file caused is recorded as its own debt class and queued as a scoped
        // repair task, instead of being blamed on — and reverted out of — the task
        // that merely tripped over it.
        recordRootCauseDebt: (cwd2, taskId, reason) => recordRootCauseDebt(cwd2, taskId, reason),
        recordRepairCandidate: (cwd2, candidate) => recordRepairCandidate(cwd2, candidate),
        // file → introducing task, the provenance half of the discriminator.
        introducedBy: (cwd2, rel) => Promise.resolve(taskThatIntroduced(cwd2, rel)),
        // Tracked paths, used only to resolve a bare file name a FAIL text names
        // (`MyListings.spec.tsx:186`) to its repo path. A git fault returns null,
        // which costs resolution and nothing else.
        repoFiles: async cwd2 => {
            try {
                const r = await git(cwd2, ['ls-files'], signal)
                if (r.exitCode !== 0) return null
                return r.stdout
                    .split('\n')
                    .map(l => l.trim())
                    .filter(l => l.length > 0)
            } catch {
                return null
            }
        },
        // The authorship half: which files THIS task's work touched. `worktree` is
        // the pre-commit verify site (uncommitted changes); `committed` is the
        // post-commit enforce site, where the task snapshot and the ENFORCE commit
        // are the last two commits. Any git fault returns null, which stands the
        // channel down entirely rather than guessing.
        touchedFiles: async (cwd2, scope) => {
            try {
                if (scope === 'worktree') {
                    const r = await git(cwd2, ['status', '--porcelain'], signal)
                    if (r.exitCode !== 0) return null
                    const c = parseTreeChanges(r.stdout)
                    return [...c.modified, ...c.added, ...c.deleted]
                }
                // `enforce-commit` is HEAD ALONE — at the enforce differential HEAD is
                // the ENFORCE commit, and that commit's own diff is the only file set
                // that can answer "could reverting this repair the failure?" (mx5 run
                // 18 / nexttask 4).
                const r = await git(
                    cwd2,
                    [
                        'log',
                        '-n',
                        scope === 'enforce-commit' ? '1' : '2',
                        '--name-only',
                        '--format=',
                        'HEAD'
                    ],
                    signal
                )
                if (r.exitCode !== 0) return null
                return r.stdout
                    .split('\n')
                    .map(l => l.trim())
                    .filter(l => l.length > 0)
            } catch {
                return null
            }
        },
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
                    const logEnforce = makeDebugAppender(
                        path.join(tasksDir(cwd2), 'enforce-debug.log')
                    )
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
                            // …but still bound any SINGLE command (see makeGateChild).
                            // enforce is read,edit today, so nothing here can hang on
                            // bash — wired anyway so a future tool grant can't quietly
                            // re-open the hole.
                            commandTimeoutMs: getConfig().requestTimeoutMs,
                            // Unbounded wall clock here too — the hung-stream
                            // bound is the only thing that ends a dead stream.
                            streamInactivityMs: getConfig().streamInactivityMs,
                            // Exact-match loop guard only: pathThreshold Infinity
                            // disables the path-revisit heuristic, so revisiting one
                            // file (which IS this pass's job) never trips — only a
                            // literally-identical call repeated past threshold does.
                            loop: {pathThreshold: Number.POSITIVE_INFINITY},
                            // Same reasoning as the gate child: without this a
                            // discarded attempt leaves no trace anywhere.
                            onRestart: rs =>
                                logEnforce(
                                    `=== enforce RESTART (attempt ${rs.attempt} discarded)`
                                        + ` reason=${rs.reason} wall=${rs.wallMs}ms`
                                        + (rs.detail ? ` — ${rs.detail}` : '')
                                        + ' ==='
                                ),
                            onLine: line => {
                                // `lastLine` drives the live widget, not the trail.
                                lastLine = line
                                logEnforce(line, 'stream')
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
                // Deterministic cross-task deletion probe (mx5 run 12 PROMPT 2):
                // tracked files this task's diff DELETES whose introducing commit
                // belongs to a DIFFERENT task — a sibling's committed deliverable
                // destroyed (typically to green a check). Injected under rule 4d and
                // carried on a FAIL so an ACCEPT records durable debts.
                crossTaskDeletionProbe: () =>
                    collectTaskTreeChanges(cwd2, signal).then(changes =>
                        findCrossTaskDeletions(changes, taskId, rel =>
                            taskThatIntroduced(cwd2, rel)
                        )
                    ),
                // Deterministic sandbox-path-leak probe (mx5 run 13 PROMPT 4 item
                // 1): absolute paths committed from the authoring child's own
                // environment (`/workspace/src/shared`) that resolve nowhere here.
                // Repaired deterministically where the relative form provably
                // resolves; the remainder is injected under rule 4e, whose point is
                // that such a path breaks the BUILD — so the checks that would have
                // caught it report nothing rather than failing.
                foreignPathProbe: () =>
                    collectForeignPathFindings(
                        cwd2,
                        signal,
                        makeDebugAppender(path.join(tasksDir(cwd2), 'verify-debug.log'))
                    ),
                // Deterministic neutered-check-script probe (mx5 run 13 PROMPT 4
                // item 4): a check script this task authored that cannot fail
                // (`… || true`, an inverted-grep launder). Injected under rule 4f,
                // because the child provably cannot find this by running the
                // script — it passes, which IS the defect.
                scriptEscapeProbe: () => collectScriptEscapeFindings(cwd2, signal),
                // Deterministic runner glob-collision probe (mx5 runs 7 AND 13,
                // PROMPT 4 item 2): both `bun test` and `playwright test` declared
                // with no proof their file sets are disjoint. Injected under rule
                // 4g — the collision kills the suite during COLLECTION, which does
                // not look like a test failure.
                runnerGlobProbe: () => collectRunnerGlobFindings(cwd2),
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
        lintFix: async (fixCtx, cwd2, taskTitle, taskId, failReason) => {
            // Same frozen extraction the enforce guard and the verify rule-4b
            // probe consume (mx5 run 12: the lint-fix child edited spec-frozen
            // tsconfig.json because ESLint's own error text instructed it, then
            // verify failed the TASK for that edit — the child must know the
            // spec's do-not-touch list AND be mechanically denied it).
            let frozenPaths: string[] = []
            try {
                const {body} = await readTaskFile(cwd2, taskId)
                frozenPaths = frozenPathsFromSpec(extractSpecForVerification(body))
            } catch {
                // spec unreadable → no frozen paths; the guard degrades to a no-op
            }
            return runBoundedLintFix({
                cwd: cwd2,
                signal,
                failReason,
                runChild: makeGateChild(fixCtx, cwd2, taskTitle, 'lint-fix', 'verify-debug.log'),
                repoHealth: () => Promise.resolve(runRepoHealthCheck(cwd2)),
                git: async args => {
                    const r = await git(cwd2, args, signal)
                    return {exitCode: r.exitCode, stdout: r.stdout}
                },
                frozenPaths,
                // Cross-task deletion guard (mx5 run 12 PROMPT 2): the revert-guard
                // is blind to a clean tracked sibling deliverable, so deleting one
                // greens the lint and the pass returns ok. Provenance is the
                // discriminator — the guard restores a sibling's deleted file and
                // reports not-applied naming the owner.
                currentTaskId: taskId,
                introducedBy: rel => Promise.resolve(taskThatIntroduced(cwd2, rel))
            })
        },
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
                discard: discardTreeEdits,
                // WRITE-GUARD STACK (mx5 run 11: this child ran with free bash and
                // none of the run-8 guards — it rm'd a sibling task's verified
                // deliverable and hand-copied a contract to green the lint). Diff
                // capture happens at the makeGateChild seam; deletion guard +
                // probe scan reject-and-discard here. The frozen-path deny
                // (FinalFixDeps.frozenPaths/revertFrozen) is deliberately NOT
                // wired: per-task fences are task-SCOPED ("this task must not
                // touch a sibling's territory"), and the measured union over the
                // run-11 specs would have reverted the one legitimate fix that
                // run needed (migrate.ts, frozen by its own producing task). Wire
                // it only when a run-GLOBAL freeze source exists (a design-level
                // preserve registry), never a per-task union.
                treeChanges: () => collectTreeChanges(cwd2, signal),
                probeScan: () => collectAddedLines(cwd2, signal).then(findProbeGaming),
                log: makeDebugAppender(path.join(tasksDir(cwd2), 'final-gate-debug.log'))
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
