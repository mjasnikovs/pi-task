/**
 * gate-deps — builds the concrete {@link GateDeps} (verify / enforce / recommend /
 * commit / revert) that the post-implementation gate sequence drives. Both
 * /task-auto and the single /task command construct the gate children through it,
 * so they are identical.
 *
 * `runTask` (the AUTOFIX re-run) is INJECTED rather than imported, which is what
 * keeps the graph acyclic: this module names the orchestrators only in comments,
 * while orchestrator.ts, auto-orchestrator.ts and plan-orchestrator.ts all import
 * from here.
 *
 * The gate children run on the `gate` worker profile: no wall-clock timeout, and
 * the path-revisit loop rule disabled because re-running the same check IS the
 * job, leaving only the exact-match rule. Each gets a status widget and a per-gate
 * debug log under `.pi-tasks/`.
 *
 * NONE of them is read-only by capability. `VERIFY_TOOLS` and `RESOLUTION_TOOLS`
 * are both `read,bash` and `ENFORCE_TOOLS` is `read,edit`, so verify and recommend
 * are read-only by CONTRACT only — which is exactly why GATE_CHILD_KINDS marks
 * those two `guarded` and the git-state guard restores what they move.
 */
import {existsSync, readFileSync} from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import type {ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import type {GateDeps} from './task-gates.js'
import {tasksDir, readTaskFile, appendGateRecord} from './task-io.js'
import {gitCommitAll, gitDropLastCommit, git} from './auto-commit.js'
import {runGuidelineEnforcement} from './enforce-guidelines.js'
import {runWorkVerification, extractSpecForVerification, type VerifyProbes} from './verify-work.js'
import {readEnvNotes, appendEnvNotes} from './env-notes.js'
import {readContracts} from './contracts.js'
import {recordDebt} from './accept-debt.js'
import {recordRepairCandidate} from './root-cause-repair.js'
import {runRepoHealthCheck} from './repo-health-check.js'
import {
    runFinalIntegrationGate,
    discoverGateCommandLabels,
    discoverGateCommandBodies
} from './final-gate.js'
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
    findActionableIgnoredWrites,
    type TreeChangeSummary,
    type IgnoredSnapshot
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
import {getConfig} from '../config/config.js'
import {groupChildArgs} from '../config/group-args.js'
import {contextWindowForGroup} from './context-usage.js'
import {makeDebugAppender} from './debug-log.js'
import {startAutoLoader} from './widget.js'
import {ChildStatus} from './child-status.js'
import {makeGateChild, type GateChildKind} from './gate-child.js'

/** A function that re-runs a task's implementation turn (AUTOFIX). Injected by the
 *  command so this module stays free of the orchestrators (avoids an import cycle). */
export type RunTaskFn = GateDeps['runTask']

/** Max chars of a tool result kept in the gate debug log. */
const TOOL_RESULT_LOG_LIMIT = 300

/**
 * One-line, tail-kept, whitespace-flattened summary of a tool's output for the gate
 * debug log. The TAIL is kept — a bind failure, a final status or an assertion
 * lands at the END of the output — with a leading ellipsis when truncated.
 * Measured: all-whitespace and empty input both give "(no output)", internal
 * newlines collapse to single spaces, and a 410-char input comes back 301 chars
 * long, starting `…` and ending on the input's last characters.
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
    failReason: string,
    /** Ignored paths earlier attempts in this resolution loop already wrote (see
     *  FinalFixDeps.ignoredKnown) — a failed attempt's ignored writes survive its
     *  discard and can green a later attempt. */
    ignoredKnown?: string[]
) => Promise<FinalFixResult>

/** Keep the gate machinery's own artifacts out of every git pathspec below. */
const EXCLUDE_TASKS_DIR = ':(exclude).pi-tasks'

/**
 * Pin the diff header prefixes on any command whose output we PARSE for paths.
 *
 * `parseAddedLines` reads the file out of the `+++ b/…` header, but the prefix is
 * user-configurable: `diff.mnemonicPrefix=true` emits `i/` and `w/` instead of
 * `a/` and `b/`, and `diff.noprefix=true` emits none. Not hypothetical: this
 * machine has `diff.mnemonicPrefix=true` set globally, and measured on git 2.55.0,
 * an unpinned `git diff HEAD` here emits `--- c/src/app.ts` / `+++ w/src/app.ts`
 * (a bare `git diff` emits `i/` and `w/`). Every added line would then be
 * attributed to `w/src/app.ts`, a path that exists nowhere, and the probe-gaming
 * and sandbox-path probes would silently read a diff of files not in the repo.
 * With these two arguments the header comes back as `a/` and `b/` under
 * mnemonicPrefix and under noprefix alike.
 */
const DIFF_PREFIX_ARGS = ['--src-prefix=a/', '--dst-prefix=b/']

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
 * probe, which needs the actual line text the numstat-shape collector omits.
 * Pre-commit the work is the tree-vs-HEAD diff plus untracked files (read whole, as
 * all-added); on the post-enforce re-verify the tree is clean, so fall back to the
 * last commit's diff. Failures degrade to an empty list — the probe is a sharpener,
 * never a blocker. The `.pi-tasks/` bookkeeping is excluded from every git command.
 */
export async function collectAddedLines(cwd: string, signal?: AbortSignal): Promise<AddedLine[]> {
    const tracked = await git(
        cwd,
        ['diff', ...DIFF_PREFIX_ARGS, 'HEAD', '--', '.', EXCLUDE_TASKS_DIR],
        signal
    )
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
        const last = await git(
            cwd,
            ['diff', ...DIFF_PREFIX_ARGS, 'HEAD~1..HEAD', '--', '.', EXCLUDE_TASKS_DIR],
            signal
        )
        return last.exitCode === 0 ? parseAddedLines(last.stdout) : []
    }
    return lines
}

/**
 * Deterministic sandbox-path-leak pass (see foreign-path.ts): find absolute paths
 * the task committed that resolve nowhere on this machine while the real file sits
 * in the repo, REPAIR the ones whose relative form provably resolves, and return
 * verify findings for whatever is left.
 *
 * The repair runs here, before the verify child, for the same reason lint-fix
 * does: the defect is mechanical and the correct target is already known, so
 * spending an AUTOFIX round (or a human) on a path substitution is waste. What it
 * cannot repair still reaches the child under rule 4e. Failures degrade to no
 * findings — a sharpener, never a blocker.
 */
export async function collectForeignPathFindings(
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
 * Deterministic neutered-check-script pass (see script-escape.ts): check-class
 * scripts that cannot report failure, in a manifest THIS task changed.
 *
 * Scoped to manifests the task touched, so the finding lands on the task that
 * authored the script rather than being re-served to every later task. A script
 * neutered by an earlier task is the whole-repo final gate's business, which
 * re-checks the shipped manifest at run end regardless of who wrote it.
 *
 * Failures degrade to no findings — a sharpener, never a blocker.
 */
export async function collectScriptEscapeFindings(
    cwd: string,
    signal?: AbortSignal
): Promise<string[]> {
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
 * Deterministic test-runner glob-collision pass (see runner-globs.ts): the manifest
 * declares both `bun test` and `playwright test` without a provably disjoint file
 * set, so `bun test` imports the playwright specs and dies during collection.
 *
 * Whole-repo rather than diff-scoped, unlike the neutered-script probe: a collision
 * is a property of the PAIR of declarations, and the task that completes the pair is
 * rarely the one that will be blamed by a diff. It is cheap (two small file reads)
 * and silent unless both runners are actually declared. Failures degrade to no
 * findings — a sharpener, never a blocker.
 */
export async function collectRunnerGlobFindings(cwd: string): Promise<string[]> {
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
 * Build output directories declared by the project's OWN build commands, so the
 * ignored-write exemption follows the real tooling instead of a name list.
 *
 * The pattern is `--outdir` or `--out-dir`, LOWERCASE, followed by `=` or a space.
 * Measured on a manifest declaring all four spellings: `--outdir=./dist/` yields
 * `dist` and `--out-dir build` yields `build`, while `--outDir out` (tsc's
 * spelling) yields nothing and a bare `--outdir -` is dropped by the leading-dash
 * guard. Best-effort: an unreadable or non-JSON manifest contributes nothing and
 * the name-list fallback in classifyIgnoredPath applies.
 */
export function parseBuildOutdirs(cwd: string): string[] {
    let raw: string
    try {
        raw = readFileSync(path.join(cwd, 'package.json'), 'utf8')
    } catch {
        return []
    }
    let scripts: Record<string, string>
    try {
        scripts = (JSON.parse(raw) as {scripts?: Record<string, string>}).scripts ?? {}
    } catch {
        return []
    }
    const out = new Set<string>()
    for (const body of Object.values(scripts)) {
        if (typeof body !== 'string') continue
        for (const m of body.matchAll(/--out-?dir[= ]([^\s'"]+)/g)) {
            const p = (m[1] ?? '').replace(/^\.\//, '').replace(/\/+$/, '')
            if (p.length > 0 && !p.startsWith('-')) out.add(p)
        }
    }
    return [...out]
}

/**
 * IGNORED-PATH CHANNEL (see write-guard.ts). A fingerprint of every
 * ACTIONABLE ignored path (`git status --porcelain --ignored=matching`, minus
 * build output / node_modules / .pi-tasks / .git), taken before and after a
 * write-capable gate child so its writes to files git never reports are
 * attributable to it.
 *
 * `--ignored=matching` collapses a wholly-ignored directory into ONE entry, which
 * is what keeps this cheap: run against a repo ignoring `logs/`, `node_modules/`
 * and `.env`, with files in all three, it reports exactly three lines —
 * `!! .env`, `!! logs/`, `!! node_modules/` — never one per file. Every failure
 * mode degrades to `{}` (no git, a git that rejects the flag, an unreadable path),
 * so the gate behaves as if the channel were absent.
 */
export async function collectIgnoredSnapshot(
    cwd: string,
    signal?: AbortSignal
): Promise<IgnoredSnapshot> {
    const r = await git(
        cwd,
        ['status', '--porcelain', '--ignored=matching', '--', '.', EXCLUDE_TASKS_DIR],
        signal
    )
    if (r.exitCode !== 0) return {}
    const outdirs = parseBuildOutdirs(cwd)
    const paths = r.stdout
        .split('\n')
        .filter(l => l.startsWith('!! '))
        .map(l => l.slice(3).trim())
        .map(p => (p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p))
        .filter(p => p.length > 0)
    const snap: IgnoredSnapshot = {}
    for (const rel of findActionableIgnoredWrites(paths, outdirs)) {
        try {
            const st = await fsp.stat(path.join(cwd, rel))
            // A directory's own mtime moves when entries are added or removed; that
            // is the whole fingerprint available for one without walking it, and a
            // walk is exactly the cost this channel refuses to pay.
            snap[rel] = st.isDirectory() ? `dir:${st.mtimeMs}` : `${st.mtimeMs}:${st.size}`
        } catch {
            // Vanished between status and stat — nothing to fingerprint.
        }
    }
    return snap
}

/**
 * The dependency test, decided mechanically rather than by judgement: move the
 * ignored paths aside, re-run the gate once, put them back. A gate that no longer
 * passes without them was passing on state the repository does not contain.
 *
 * Returns null when the question could not be answered (nothing movable, a move or
 * a restore fault, too many paths) — an unanswered probe never downgrades a
 * verdict. Restoration runs in a finally and is best-effort per path: leaving a
 * developer's `.env` renamed on disk would be a far worse failure than a missed
 * downgrade.
 */
export async function gatePassesWithoutIgnored(
    cwd: string,
    paths: string[],
    runGate: (cwd: string) => Promise<{ok: boolean}>,
    log?: (msg: string) => void
): Promise<boolean | null> {
    if (paths.length === 0 || paths.length > MAX_IGNORED_PROBE_PATHS) return null
    const moved: Array<{from: string; to: string}> = []
    try {
        for (const rel of paths) {
            // `--ignored=matching` reports a wholly-ignored DIRECTORY with a trailing
            // slash — measured, it prints `logs/`, not `logs`. Left on,
            // `path.join('/repo', 'logs/')` is `/repo/logs/`, so the probe target
            // becomes `/repo/logs/.pi-gate-probe` — a path INSIDE the directory, and
            // the rename is a move-into-itself that answers null for every directory
            // entry. Stripped, the target is the sibling `/repo/logs.pi-gate-probe`.
            const from = path.join(cwd, rel.replace(/\/+$/, ''))
            const to = `${from}.pi-gate-probe`
            try {
                await fsp.rename(from, to)
                moved.push({from, to})
            } catch {
                // Could not move one → the probe cannot answer the question at all.
                return null
            }
        }
        if (moved.length === 0) return null
        const again = await runGate(cwd)
        return again.ok
    } catch {
        return null
    } finally {
        for (const m of moved) {
            try {
                await fsp.rename(m.to, m.from)
            } catch {
                log?.(
                    `final-gate: WARNING — could not restore ${path.relative(cwd, m.from)} after `
                        + `the ignored-dependency probe; it is on disk as ${path.basename(m.to)}`
                )
            }
        }
    }
}

/** Bound on the ignored-dependency probe: past this the set is not a fix child's
 *  handful of files and moving them is not a safe thing to do to a worktree. */
const MAX_IGNORED_PROBE_PATHS = 20

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
 * Deterministic test-assembly probe input: read the task's own changed TEST files
 * plus the repo's tracked source files, and return the finding lines naming any
 * test that rebuilds a production assembly it never imports.
 * Pure import-graph shape; failures degrade to no findings (the probe is a sharpener,
 * never a blocker). `changed` is the already-collected task diff, reused so the probe
 * costs one extra tracked-file listing, not a second diff.
 */
export async function collectTestAssemblyFindings(
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
 * The composed spec a gate judges against: the `## spec` section of the task file
 * (see extractSpecForVerification). A task that never reached compose has no spec
 * section, and an unreadable task file is the same case — both are null, and every
 * caller already treats null as "nothing to hold the work to" (verify no-ops,
 * frozen paths are empty, recommend falls back to the title). Never throws. This
 * would otherwise be the same four-line try/catch at four gate sites.
 */
export async function readSpecForVerification(cwd: string, taskId: string): Promise<string | null> {
    try {
        const {body} = await readTaskFile(cwd, taskId)
        return extractSpecForVerification(body)
    } catch {
        return null
    }
}

/**
 * Bind the deterministic verify probes — THE one place the collectors above meet
 * the probe table in verify-work.ts. One entry per `BoundProbeKey`; the table row
 * with that key reads it, and the table's loop owns the ritual (skip when absent,
 * degrade to the row's empty value when the thunk throws), so nothing here needs a
 * try/catch and a fault in one probe cannot reach another. Each thunk is LAZY:
 * building the record runs no git.
 *
 * `spec` is the composed spec (see readSpecForVerification): the prohibition probe
 * reads it and skips the git call when the spec forbids nothing. `log` is the
 * verify debug appender for the one probe that repairs as well as reports.
 */
export function buildVerifyProbes(params: {
    cwd: string
    signal?: AbortSignal
    taskId: string
    spec: string | null
    log?: (msg: string) => void
}): VerifyProbes {
    const {cwd, signal, taskId, spec, log} = params
    return {
        // Deterministic self-verification probe: test files the task itself
        // authored/changed become prompt-level findings mandating the child
        // to drive the real artifact before trusting their green result.
        substitution: () => collectChangedFiles(cwd, signal).then(findSubstitutionSuspects),
        // Deterministic prohibition probe: paths the spec forbids modifying
        // that the task's diff modified anyway become prompt-level findings
        // under the no-waiver rule — the child otherwise rarely runs `git
        // diff` and cannot even see the violation.
        prohibition: () => {
            const banned = spec ? extractProhibitions(spec) : []
            if (banned.length === 0) return Promise.resolve([])
            return collectChangedFiles(cwd, signal).then(files =>
                findProhibitionViolations(banned, files)
            )
        },
        // Deterministic cross-task deletion probe: tracked files this task's
        // diff DELETES whose introducing commit belongs to a DIFFERENT task —
        // a sibling's committed deliverable destroyed, typically to green a
        // check. Injected under rule 4d and carried on a FAIL so an ACCEPT
        // records durable debts.
        crossTaskDeletion: () =>
            collectTaskTreeChanges(cwd, signal).then(changes =>
                findCrossTaskDeletions(changes, taskId, rel => taskThatIntroduced(cwd, rel))
            ),
        // Deterministic probe-gaming probe: added lines whose stated purpose
        // is to make a check pass rather than meet the requirement ("return
        // 401 so the verification test passes") become rule-4c findings, so
        // the child verifies the real requirement and not the check.
        probeGaming: () => collectAddedLines(cwd, signal).then(findProbeGaming),
        // Deterministic sandbox-path-leak probe: absolute paths committed
        // from the authoring child's own environment (`/workspace/src/shared`)
        // that resolve nowhere here. Repaired deterministically where the
        // relative form provably resolves; the remainder is injected under
        // rule 4e, whose point is that such a path breaks the BUILD — so the
        // checks that would have caught it report nothing rather than failing.
        foreignPath: () => collectForeignPathFindings(cwd, signal, log),
        // Deterministic neutered-check-script probe: a check script this task
        // authored that cannot fail (`… || true`, an inverted-grep launder).
        // Injected under rule 4f, because the child cannot find this by
        // running the script — it passes, which IS the defect.
        scriptEscape: () => collectScriptEscapeFindings(cwd, signal),
        // Deterministic runner glob-collision probe: both `bun test` and
        // `playwright test` declared with no proof their file sets are
        // disjoint. Injected under rule 4g — the collision kills the suite
        // during COLLECTION, which does not look like a test failure.
        runnerGlob: () => collectRunnerGlobFindings(cwd),
        // Deterministic test-assembly probe: authored test files that rebuild
        // production wiring — importing the leaf modules the shipped entry
        // composes and assembling their own copy — become rule-3f findings,
        // so the child drives the REAL assembly and not the copy.
        testAssembly: () =>
            collectChangedFiles(cwd, signal).then(changed =>
                collectTestAssemblyFindings(cwd, changed, signal)
            )
    }
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
    // A/B seam, same shape as CANCEL_AB_ARM in cancel-points.ts: drop the loader
    // across the deterministic stage so the dead air can be measured in the SAME
    // binary. Unset in every real run.
    const deadAirBaseline = process.env.DEADAIR_AB_ARM === 'baseline'
    // ONE live status for every gate child, so the widget mirrors the running
    // child's latest output line and context usage exactly like the single-task
    // phase widget — and so the verify gate's own loader (below) reads what its
    // loader-less child feeds.
    const status = new ChildStatus({parentContextWindow})
    // What the git-state guard had to restore after the MOST RECENT verify/recommend
    // child run (see git-state-guard.ts). runWorkVerification reads this through its
    // mutationCheck dep to discard a verdict computed on a mutated tree.
    let lastGuardReconcile: ReconcileResult | null = null

    // Restore tracked files to HEAD and drop files a pass created. The `.pi-tasks`
    // trail and log writes made during the pass survive both: the checkout excludes
    // that directory by pathspec and the clean excludes it with `-e`. Shared by the
    // enforce pre-commit gate (discardEdits) and the final-gate autofix guards.
    const discardTreeEdits = async (cwd2: string): Promise<void> => {
        await git(cwd2, ['checkout', '--', '.', EXCLUDE_TASKS_DIR], signal)
        await git(cwd2, ['clean', '-fd', '-e', '.pi-tasks'], signal)
    }

    // Adapter onto the shared gate-child runner (gate-child.ts). What survives
    // here is WIRING — which context, which log file, which config knobs, and
    // the shared live status; the ritual and the per-kind policy are the
    // table's. The enforce child below goes through the same call.
    const gateChild = (
        gateCtx: ExtensionCommandContext,
        cwd2: string,
        taskTitle: string,
        kind: GateChildKind,
        logFile: string,
        opts: {loader?: boolean} = {}
    ): ((tools: string, prompt: string, sig?: AbortSignal) => Promise<string>) =>
        makeGateChild({
            ctx: gateCtx,
            cwd: cwd2,
            taskTitle,
            kind,
            logPath: path.join(tasksDir(cwd2), logFile),
            ...(opts.loader === undefined ? {} : {loader: opts.loader}),
            commandTimeoutMs: getConfig().requestTimeoutMs,
            streamInactivityMs: getConfig().streamInactivityMs,
            // Read per gateChild() call, like its two neighbours, so a
            // /task-config change lands on the next gate without a restart.
            groupArgs: groupChildArgs('gate'),
            // `gateCtx` rather than the run's own window: a run spans several
            // groups, and a window smaller than the child's real one makes the
            // churn rule fire early and kill a healthy child.
            contextWindow: contextWindowForGroup(gateCtx, 'gate'),
            status,
            runWorker,
            makeDebugAppender,
            captureGitState,
            reconcileGitState,
            describeTreeChanges: async (c, sig) =>
                formatTreeChanges(await collectTreeChanges(c, sig)),
            truncateToolResult,
            onReconcile: rec => {
                lastGuardReconcile = rec
            }
        })

    return {
        runTask,
        // Durable per-task gate trail: every verdict/decision lands in the task
        // file's `## gates` section so gate behavior is auditable from artifacts.
        record: (cwd2, taskId, line) => appendGateRecord(cwd2, taskId, line),
        // Durable defect ledger under `.pi-tasks/` (survives discardEdits): every
        // recorded class — accepted, yolo-accepted, enforce-revert, enforce-kept,
        // frozen-blocked, cross-task-deletion, root-cause — lands here with its
        // origin, and the final integration gate re-checks each one at run end.
        recordDebt,
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
                // `enforce-commit` is HEAD ALONE (`log -n 1`) — at the enforce
                // differential HEAD is the ENFORCE commit, and that commit's own diff
                // is the only file set that can answer "could reverting this repair
                // the failure?". Every other scope reads the last two commits.
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
        frozenPaths: async (cwd2, taskId) =>
            frozenPathsFromSpec(await readSpecForVerification(cwd2, taskId)),
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
                // Run the worker child with no loop detector and no wall clock. This
                // pass reworks files in place until every violation is fixed and
                // legitimately reads and edits the same file many times, which the
                // research-worker guards would mislabel as a runaway.
                // classifyEnforceChildFailure still blocks on a real failure — a
                // non-zero exit, a leaked tool call — or a user cancel.
                //
                // The enforce child goes through the same makeGateChild call as
                // every other kind; what differs is its GATE_CHILD_KINDS row — no
                // git-state guard, because editing is this pass's job, no
                // tool-result logging, and its own end marker. Its debug log is
                // separate because the enforce child is otherwise unobservable.
                runChild: gateChild(enforceCtx, cwd2, taskTitle, 'enforce', 'enforce-debug.log')
            })
        },
        verify: async (verifyCtx, cwd2, taskTitle, taskId) => {
            if (!getConfig().verifyWork) {
                return {ok: true, reason: 'disabled'}
            }
            // The spec to verify against is the composed spec committed in the task
            // file. A task that never reached compose has no spec section —
            // runWorkVerification treats a null spec as a no-op pass.
            const spec = await readSpecForVerification(cwd2, taskId)
            // DEAD AIR (the reason this loader exists). The gate's DETERMINISTIC
            // stage — repo health plus the nine PROBE_ADAPTERS rows — runs before
            // the verify child, and the child's own loader only starts once the
            // child does. The implementation widget is cleared at `agent_end`, so
            // without this the screen has no spinner, no clock and no line for the
            // whole stage. A `verifying…` notify would not help: pi-tui schedules
            // every render through `process.nextTick` (pi-tui/dist/tui.js), so a
            // synchronous health check starves the render entirely. One loader spans
            // the WHOLE gate — the deterministic stage and the child.
            const gateStartedAt = Date.now()
            let stageLine: string | undefined
            // `track` clears the PREVIOUS child's trailer before the loader goes
            // up: the deterministic stage has no child of its own, so a stale `↳`
            // line from the last task's enforce pass would otherwise sit under the
            // new status block as if it were live. The frame's `lastLine` wins
            // over the status's own, which is how the stage label shows until
            // the child has a line.
            const gateFrame =
                deadAirBaseline ? null : (
                    () => ({
                        title: taskTitle,
                        kind: 'verify' as const,
                        step: 'verify',
                        stepNum: 1,
                        stepTotal: 1,
                        startedAt: gateStartedAt,
                        lastLine: status.snapshot().lastLine ?? stageLine
                    })
                )
            return status.track(verifyCtx, gateFrame, () =>
                runWorkVerification({
                    cwd: cwd2,
                    signal,
                    spec,
                    // The child renders no loader of its own: the gate-wide one above is
                    // already live and reads the same status the child feeds, so a
                    // second widget on the same key would only fight it.
                    runChild: gateChild(verifyCtx, cwd2, taskTitle, 'verify', 'verify-debug.log', {
                        loader: deadAirBaseline
                    }),
                    // Names the deterministic step in the live status line.
                    onStage: label => {
                        stageLine = label
                    },
                    // Deterministic whole-repo static-analysis gate — runs the project's
                    // own lint/typecheck and fails on a real non-zero exit, independent of
                    // the model-authored VERIFY block, which may not lint at all. ASYNC,
                    // so the lint does not starve pi-tui's nextTick-scheduled renders.
                    //
                    // ONE call, both arms. A baseline arm that dropped the signal or the
                    // progress hook here would be uncancellable and mute for reasons
                    // unrelated to the thing under test. The arm's only difference is
                    // the LOADER, above.
                    repoHealth: () =>
                        runRepoHealthCheck(cwd2, {
                            signal,
                            onCommand: c => {
                                stageLine = `repo health · ${c}`
                            }
                        }),
                    // The deterministic probes, bound in one place (buildVerifyProbes
                    // above); the PROBE_ADAPTERS table in verify-work.ts runs them.
                    probes: buildVerifyProbes({
                        cwd: cwd2,
                        signal,
                        taskId,
                        spec,
                        log: makeDebugAppender(path.join(tasksDir(cwd2), 'verify-debug.log'))
                    }),
                    // Git-state guard result of the most recent child run: a verdict
                    // computed on a tree the child itself mutated is discarded — but ONLY
                    // when the mutation touched graded state (verdictTainted). A child
                    // that merely left test-runner output behind (test-results/,
                    // playwright-report/ …) judged an equivalent tree; its verdict stands
                    // and the artifacts are still cleaned. See git-state-guard.ts for
                    // which mutations count as tainting.
                    mutationCheck: () =>
                        lastGuardReconcile?.verdictTainted ?
                            {mutated: true, detail: lastGuardReconcile.actions.join('; ')}
                        :   {mutated: false, detail: ''},
                    // Per-run environment-facts cache under `.pi-tasks/` (survives
                    // discardEdits): earlier children's discoveries save this child
                    // the re-archaeology; its own ENV-NOTE lines are stored for the
                    // next one, stamped with this task's id as their origin so a
                    // later child sees a cited fact is second-hand and must
                    // re-validate before excusing a failure. Facts only — verdict
                    // rules unaffected.
                    envNotes: {
                        read: () => readEnvNotes(cwd2),
                        append: notes => appendEnvNotes(cwd2, notes, taskId)
                    },
                    // Per-run cross-slice contract registry under `.pi-tasks/`: the
                    // verbatim interface facts the design pins that multiple slices
                    // share, so the verify child checks this slice's boundary against
                    // them. Empty on single-`/task` runs or a design with no shared
                    // boundary → no block.
                    contracts: () => readContracts(cwd2)
                })
            )
        },
        lintFix: async (fixCtx, cwd2, taskTitle, taskId, failReason) => {
            // Same frozen extraction the enforce guard and the verify rule-4b probe
            // consume. A linter's own error text can instruct an edit inside a
            // spec-frozen file, so the lint-fix child must both KNOW the do-not-touch
            // list and be mechanically denied it — knowing alone is not enough when
            // the tool output is telling it otherwise. Spec unreadable → no frozen
            // paths, and the guard degrades to a no-op.
            const frozenPaths = frozenPathsFromSpec(await readSpecForVerification(cwd2, taskId))
            return runBoundedLintFix({
                cwd: cwd2,
                signal,
                failReason,
                runChild: gateChild(fixCtx, cwd2, taskTitle, 'lint-fix', 'verify-debug.log'),
                repoHealth: () => runRepoHealthCheck(cwd2, {signal}),
                git: async args => {
                    const r = await git(cwd2, args, signal)
                    return {exitCode: r.exitCode, stdout: r.stdout}
                },
                frozenPaths,
                // Cross-task deletion guard: the revert-guard only watches files the
                // task had already dirtied, so it is blind to a CLEAN tracked sibling
                // deliverable — deleting one greens the lint and the pass returns ok.
                // Provenance is the discriminator: the guard restores the sibling's
                // deleted file and reports not-applied, naming the owner.
                currentTaskId: taskId,
                introducedBy: rel => Promise.resolve(taskThatIntroduced(cwd2, rel))
            })
        },
        // Deterministic static check + tree helpers for the enforce pre-commit gate.
        // task-gates.ts calls it up to twice per task in `edit` mode — a baseline
        // before the edit pass, and a differential check after it when edits were
        // made. Each run is as long as the project's own lint, so it gets the same
        // treatment as the verify-side run: async, under a live loader naming the
        // command.
        repoHealth: (healthCtx, cwd2, label) => {
            const startedAt = Date.now()
            let running: string | undefined
            const stop = startAutoLoader(healthCtx, () => ({
                title: label,
                kind: 'enforce',
                step: 'repo health',
                stepNum: 1,
                stepTotal: 1,
                startedAt,
                lastLine: running ? `repo health · ${running}` : 'repo health'
            }))
            return runRepoHealthCheck(cwd2, {
                signal,
                onCommand: c => {
                    running = c
                }
            }).finally(stop)
        },
        dirty: async cwd2 => {
            const r = await git(
                cwd2,
                ['status', '--porcelain', '--', '.', EXCLUDE_TASKS_DIR],
                signal
            )
            return r.exitCode === 0 && r.stdout.trim().length > 0
        },
        discardEdits: discardTreeEdits,
        finalGateFix: (fixCtx, cwd2, failReason, ignoredKnown) =>
            runFinalGateAutofix({
                cwd: cwd2,
                signal,
                failReason,
                runChild: gateChild(
                    fixCtx,
                    cwd2,
                    'final integration gate',
                    'final-fix',
                    'final-gate-debug.log'
                ),
                // The gate re-run is the only arbiter of convergence, and the
                // shrink guard's discovery is the gate's own (see final-gate.ts).
                // The run's cancel reaches the re-run too. Without it the whole
                // `FinalGateOptions.signal` path is inert in the shipped code.
                gate: c => runFinalIntegrationGate(c, {signal}),
                discoverLabels: discoverGateCommandLabels,
                discoverBodies: discoverGateCommandBodies,
                discard: discardTreeEdits,
                // WRITE-GUARD STACK. This child has free bash, so it needs one.
                // Diff capture happens at the makeGateChild seam, keyed on the
                // child's TOOLS; the deletion guard and the probe scan
                // reject-and-discard inside runFinalGateAutofix. The frozen-path
                // deny (FinalFixDeps.frozenPaths/revertFrozen) is deliberately NOT
                // wired here: per-task fences are task-SCOPED — "this task must not
                // touch a sibling's territory" — so their union across a run can
                // fence off a file a legitimate whole-repo fix has to touch. Wire it
                // only when a run-GLOBAL freeze source exists, never a per-task
                // union.
                treeChanges: () => collectTreeChanges(cwd2, signal),
                probeScan: () => collectAddedLines(cwd2, signal).then(findProbeGaming),
                // IGNORED-PATH CHANNEL: every write guard above reads
                // `git status --porcelain`, which does not report ignored paths, so
                // a pass that greens a command by writing credentials into a
                // gitignored `.env` is structurally invisible to all of them — and
                // the gate would certify a PASS no fresh clone can reproduce. This
                // does not reject the write; a local `.env` is often the only way to
                // make a check run at all. It records it, and downgrades a PASS
                // proven to depend on it.
                ignoredSnapshot: () => collectIgnoredSnapshot(cwd2, signal),
                ...(ignoredKnown && ignoredKnown.length > 0 ? {ignoredKnown} : {}),
                gateWithoutIgnored: paths =>
                    gatePassesWithoutIgnored(
                        cwd2,
                        paths,
                        c => runFinalIntegrationGate(c, {signal}),
                        makeDebugAppender(path.join(tasksDir(cwd2), 'final-gate-debug.log'))
                    ),
                log: makeDebugAppender(path.join(tasksDir(cwd2), 'final-gate-debug.log'))
            }),
        recommend: async (recCtx, cwd2, taskTitle, taskId, failReason) => {
            // Read the same composed spec the verify gate judged against, so the
            // recommendation reasons over the real contract (degrade to the bare title).
            const spec = (await readSpecForVerification(cwd2, taskId)) ?? taskTitle
            return researchResolution({
                cwd: cwd2,
                signal,
                spec,
                failReason,
                runChild: gateChild(recCtx, cwd2, taskTitle, 'recommend', 'verify-debug.log')
            })
        }
    }
}
