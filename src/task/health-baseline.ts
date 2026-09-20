/**
 * health-baseline — what the repo's own static checks said BEFORE the task ran,
 * and the differential that decides whose fault a red check is.
 *
 * THE FAILURE THIS CLOSES. The verify gate ran `runRepoHealthCheck` and failed on
 * its absolute exit code. So a task that inherited a repo whose lint was already
 * red failed its gate for somebody else's defect (AUTO_0002: 0034 absorbed 0033's
 * lint debt), and — worse — that FAIL short-circuited before the probes, so the
 * deterministic findings about the task's OWN work were never computed at all.
 *
 * THE COMPARISON IS PER COMMAND, not per overall verdict. `ok` is one boolean over
 * a list of checks that short-circuits on the first failure, so "red before, red
 * after" is true of a repo whose lint was already broken AND of a task that broke
 * typecheck on top of it. Only the (cmd, exitCode) pairs can tell those apart.
 *
 * WHERE THE BASELINE COMES FROM. `/task-auto` captures it at the pre-task
 * checkpoint commit, where the tree is clean and therefore describes exactly the
 * state the task starts from; `/task` captures at its own start. Health commands
 * may WRITE (`--fix` is a common `lint` script), so the capture discards edits
 * afterwards — a baseline that silently fixed the repo would make the task's gate
 * judge a tree nobody authored. A task file that has no baseline (it predates this,
 * or the capture failed) gets one lazily at verify time from a detached worktree at
 * HEAD: no stash, and the real index is never touched.
 */
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type {GitRunner} from '../shared/git-runner.js'
import type {HealthCommandResult, HealthOutcome} from './repo-health-check.js'
import {commitTreeHash} from './tree-hash.js'

/**
 * The permissive read of a health result: everything the differential needs and
 * nothing else. The gate deps hand around structurally-typed health signals (and
 * tests fake them), so the differential asks for the two fields it reads rather
 * than for the full `HealthOutcome`.
 */
export interface HealthSignal {
    ok: boolean
    /** Absent → the result predates per-command recording; the differential then
     *  has only the overall verdict to compare. */
    commands?: readonly HealthCommandResult[]
}

export interface HealthBaseline {
    /** When the baseline was taken (ISO). */
    at: string
    /** The tree it describes, so a reader can tell whether it still applies. */
    treeHash: string | null
    outcome: HealthOutcome
}

/**
 * Whose fault the current health result is.
 *   clean        — nothing is failing now.
 *   regressed    — a check fails that the baseline did not have failing. THIS task.
 *   pre-existing — every failing check failed the same way before the task ran.
 */
export type HealthDelta = 'clean' | 'regressed' | 'pre-existing'

function failures(signal: HealthSignal): HealthCommandResult[] {
    return (signal.commands ?? []).filter(c => c.outcome === 'fail')
}

/**
 * Classify the current health result against the baseline.
 *
 * A NULL baseline is `regressed`, deliberately. An unestablished baseline is not
 * evidence that the breakage predates the task — it is the absence of evidence —
 * and the two errors are not symmetrical: calling it pre-existing SHIPS a real
 * regression as inherited debt, while calling it a regression routes the failure
 * through the resolution table, where a judge, a bounded lint fix or a human can
 * still say otherwise. The same reasoning retires the `healthBefore?.ok ?? true`
 * default the enforce site used to carry.
 */
export function classifyHealthDelta(
    baseline: HealthSignal | null,
    after: HealthSignal
): HealthDelta {
    if (vanishedSuites(baseline, after).length > 0) return 'regressed'
    if (after.ok) return 'clean'
    if (!baseline) return 'regressed'
    const before = failures(baseline)
    const now = failures(after)
    // A failing result that names no failing command carries no per-command detail
    // (a legacy record, or an injected signal); the overall verdict is all there is.
    const detailed = now.length > 0 && (baseline.ok || before.length > 0)
    if (!detailed) return baseline.ok ? 'regressed' : 'pre-existing'
    return regressedCommands(baseline, after).length > 0 ? 'regressed' : 'pre-existing'
}

const failureKey = (c: HealthCommandResult): string => JSON.stringify([c.cmd, c.exitCode])

/**
 * Test commands the baseline RAN that now find no tests to run.
 *
 * A runner that found nothing observed nothing, which is a gap — in isolation. A
 * task that deleted the test directory, renamed it, or broke the config's glob
 * leaves the same gap, and the check reports the repo healthy because a gap never
 * fails. Against a baseline that ran the suite, the suite is gone: this task's
 * regression, and the largest one it can hide behind a green.
 *
 * Ran, not passed. A baseline that ran the suite RED ran it, and deleting a red
 * suite is the same move with a larger payoff: the whole check turns green.
 */
export function vanishedSuites(
    baseline: HealthSignal | null,
    after: HealthSignal
): HealthCommandResult[] {
    if (!baseline) return []
    const ran = new Set((baseline.commands ?? []).filter(c => c.outcome !== 'skip').map(c => c.cmd))
    return (after.commands ?? []).filter(
        c => c.outcome === 'skip' && c.gap === 'empty-suite' && ran.has(c.cmd)
    )
}

/** The failing commands the baseline did not have failing the same way — what a
 *  `regressed` verdict is about. Every failing command when there is no baseline. */
export function regressedCommands(
    baseline: HealthSignal | null,
    after: HealthSignal
): HealthCommandResult[] {
    const wasFailing = new Set(baseline ? failures(baseline).map(failureKey) : [])
    return [
        ...failures(after).filter(c => !wasFailing.has(failureKey(c))),
        ...vanishedSuites(baseline, after)
    ]
}

/**
 * The failing commands, as prompt/trail lines naming the exit code. A test
 * runner exits 1 for one failing test or for fifty, so for a suite the line
 * claims only the exit code: which tests fail was not compared.
 */
export function inheritedHealthFindings(after: HealthSignal): string[] {
    return failures(after).map(c =>
        c.kind === 'test' ?
            `\`${c.cmd}\` exits ${c.exitCode}, as it did before this task — the same exit code, not proof the same tests fail`
        :   `\`${c.cmd}\` exits ${c.exitCode} (and did before this task)`
    )
}

// ─── The task-file section ───────────────────────────────────────────────────

export const HEALTH_BASELINE_SECTION = 'health baseline'

/**
 * Render for `## health baseline`. JSON in a fence rather than a hand-rolled
 * grammar: this round-trips through a committed file that a later run parses, and
 * a second grammar is a second thing to drift.
 *
 * The captured output is dropped, the outcome's and each command's — up to 40
 * lines of a linter's report, in a file committed with every task, for a field the
 * differential never reads. The live run's own trail already carries it.
 */
export function formatHealthBaseline(b: HealthBaseline): string {
    const {output: _output, commands, ...rest} = b.outcome
    const outcome = {...rest, commands: commands.map(({output: _o, ...c}) => c)}
    return ['```json', JSON.stringify({...b, outcome}, null, 2), '```'].join('\n')
}

/** Parse a `## health baseline` section back. Null on anything unreadable — an
 *  unparseable baseline is no baseline, never a fabricated clean one. */
export function parseHealthBaseline(section: string | null): HealthBaseline | null {
    if (!section) return null
    const json = section.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '')
    try {
        const parsed = JSON.parse(json) as Partial<HealthBaseline>
        const outcome = parsed.outcome
        if (!outcome || typeof outcome.ok !== 'boolean') return null
        return {
            at: typeof parsed.at === 'string' ? parsed.at : '',
            treeHash: typeof parsed.treeHash === 'string' ? parsed.treeHash : null,
            outcome: {
                ok: outcome.ok,
                reason: outcome.reason ?? '',
                ecosystem: outcome.ecosystem ?? null,
                commands: outcome.commands ?? [],
                output: ''
            }
        }
    } catch {
        return null
    }
}

// ─── Capture ─────────────────────────────────────────────────────────────────

export interface CaptureDeps {
    runHealth: () => Promise<HealthOutcome>
    treeHash: () => Promise<string | null>
    /** Undo whatever a `--fix`-style health command wrote. */
    discardEdits: () => Promise<void>
    now?: () => Date
}

/**
 * Capture the baseline for the tree as it stands. The hash is taken FIRST: a
 * health command that writes would otherwise be described by the hash of its own
 * output rather than of the tree the task starts from.
 */
export async function captureHealthBaseline(deps: CaptureDeps): Promise<HealthBaseline> {
    const treeHash = await deps.treeHash()
    try {
        const outcome = await deps.runHealth()
        return {at: (deps.now?.() ?? new Date()).toISOString(), treeHash, outcome}
    } finally {
        await deps.discardEdits()
    }
}

// ─── The lazy baseline ───────────────────────────────────────────────────────

export interface LazyCaptureDeps {
    git: GitRunner
    /** Run the health check in the given directory — the throwaway worktree. */
    runHealthIn: (dir: string) => Promise<HealthOutcome>
    tmpDir?: () => string
    now?: () => Date
}

function lazyWorktreePath(): string {
    return path.join(
        os.tmpdir(),
        `pi-task-health-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
}

/**
 * Establish a baseline for a task file that has none, from a DETACHED WORKTREE at
 * HEAD. HEAD is the last commit before the task's uncommitted work, so it is the
 * state the task started from — and checking it out elsewhere means the real index,
 * the real working tree and the stash are all untouched, which no `stash` or
 * `checkout` of the live tree could promise.
 *
 * Null when git cannot produce the worktree; the caller then has no baseline, and
 * `classifyHealthDelta` says what that means.
 */
export async function lazyHealthBaseline(deps: LazyCaptureDeps): Promise<HealthBaseline | null> {
    const dir = (deps.tmpDir ?? lazyWorktreePath)()
    const added = await deps.git(['worktree', 'add', '--detach', dir, 'HEAD'])
    if (added.exitCode !== 0) return null
    try {
        const outcome = await deps.runHealthIn(dir)
        return {
            at: (deps.now?.() ?? new Date()).toISOString(),
            treeHash: await commitTreeHash(deps.git, 'HEAD'),
            outcome
        }
    } finally {
        // `--force` because the health run may have written into it (a `--fix`
        // script, a build cache), which plain `worktree remove` refuses. If git
        // still declines, drop the directory and prune the admin record by hand —
        // a stale worktree entry makes every later `worktree add` in this repo
        // noisier, and nothing else will clean it up.
        const removed = await deps.git(['worktree', 'remove', '--force', dir])
        if (removed.exitCode !== 0) {
            await fsp.rm(dir, {recursive: true, force: true}).catch(() => {})
            await deps.git(['worktree', 'prune'])
        }
    }
}
