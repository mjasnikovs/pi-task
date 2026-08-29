/**
 * lint-fix — the bounded, graduated resolution for a repo-health verify FAIL.
 *
 * WHY A SEPARATE PASS. AUTOFIX's only hammer is a FULL implementation re-run. For a
 * repo-health FAIL of a few trivial lint findings the re-run REGENERATES the work
 * rather than editing it, and fresh output fails lint differently — the loop cannot
 * converge because the tool is bigger than the defect. A bounded fix child
 * (read,edit,bash) edits only the findings.
 *
 * REVERT-GUARD. A fix child can reach lint-clean by DISCARDING the task's
 * uncommitted work: `git checkout -- <the work file>` makes every finding vanish.
 * The prompt forbids it, but the guard is outcome-based, because command filtering
 * cannot catch every path to the same effect:
 *
 *   - Before the child runs: snapshot the full working state (`git add -A` +
 *     `git write-tree`, then unstage) and record which files differ from HEAD.
 *   - After: any pre-existing work file now byte-identical to HEAD means the child
 *     discarded work instead of fixing it → restore the snapshot, report not-applied.
 *   - Converge check: the injected repoHealth must pass; otherwise not-applied.
 *
 * A file whose ENTIRE pre-fix diff was the lint finding (fixing it legitimately
 * restores HEAD) trips the guard conservatively — the fix is discarded and the
 * ordinary AUTOFIX picker takes over. Safe direction: the guard may only cost time,
 * never work.
 *
 * Not-applied is never terminal: the caller falls through to the existing
 * recommend → AUTOFIX/ACCEPT/dismiss picker, so this pass can only make the loop
 * faster, never change what it can decide.
 *
 * FROZEN-PATH GUARD. The checker's own error text can INSTRUCT an edit to a
 * spec-frozen file. Typed ESLint, asked to lint a file outside the tsconfig
 * `include`, prints:
 *
 *     Parsing error: <file> was not found by the project service. Consider either
 *     including it in the tsconfig.json or including it in allowDefaultProject.
 *
 * A child that complies edits `tsconfig.json`. If the task's spec froze that file,
 * verify's prohibition probe raises rule 4b — "SPEC PROHIBITIONS ARE PART OF THE
 * BAR — YOU HAVE NO WAIVER AUTHORITY" — and FAILs the TASK for the gate child's
 * edit. Two gates, contradictory rules, same file; the loop never converges.
 *
 * So the deny is mechanical rather than framing: the spec's frozen paths are
 * threaded in via `frozenPaths`, injected into the prompt as a do-not-touch list
 * (belt), and any frozen path the child still changed is deterministically reverted
 * post-child and the fix reported not-applied (suspenders). Only paths that were
 * CLEAN before the child ran are reverted — a frozen path already dirty with
 * (possibly task) work is left alone, in the guard's safe direction: cost time,
 * never work.
 *
 * CROSS-TASK DELETION GUARD. The revert-guard above is outcome-based but blind to a
 * CLEAN tracked file. Delete one and `git status --porcelain` reports ` D <path>`
 * while it appears in NEITHER of the guard's two lists: it was not pre-dirty (it
 * matched HEAD) and not pre-untracked (it is tracked). If the lint then converges,
 * the pass returns ok having destroyed a sibling task's committed deliverable. The
 * discriminator is PROVENANCE, not deletion per se: a tracked file the CHILD deleted
 * whose introducing task (per `introducedBy`, git history) differs from the CURRENT
 * task is restored from HEAD and the fix reported not-applied naming the owner.
 * Same-task deletions, unknown provenance, relocations (a deletion whose basename
 * reappears among the added paths) and any git error all step aside — the guard may
 * only cost time, never work. Armed only when both `currentTaskId` and
 * `introducedBy` are wired.
 */
import {parseChangedFrozenFiles, pathNamedIn, revertFrozenPaths} from './frozen-path-guard.js'
import {runFixChild} from './fix-child.js'
import {parseTreeChanges, type TreeChangeSummary} from './write-guard.js'
import {findCrossTaskDeletions} from './task-provenance.js'

export interface LintFixResult {
    /** true → findings fixed, repo health passes, work preserved. */
    ok: boolean
    /** why the fix was not applied (guard trip, no convergence, child error). */
    reason?: string
}

export interface LintFixDeps {
    cwd: string
    signal?: AbortSignal
    /** The verify FAIL reason (names the failing command, e.g. "repo health: `bun run lint` exited 1"). */
    failReason: string
    /** Run the fix child; same closure shape the other gate children use. */
    runChild: (tools: string, prompt: string, signal?: AbortSignal) => Promise<string>
    /** The deterministic whole-repo static check to converge against. `output`
     *  (the failing command's captured text, when the impl provides it) lets the
     *  non-convergence path trace the findings to a spec-frozen path. */
    repoHealth: () => Promise<{ok: boolean; reason: string; output?: string}>
    /** Run git in cwd; injected so the guard logic is unit-testable. */
    git: (args: string[]) => Promise<{exitCode: number; stdout: string}>
    /**
     * Paths the task's spec forbids modifying (frozenPathsFromSpec over the same
     * composed spec verify judges). Injected into the child's prompt AND enforced
     * deterministically post-child: a frozen path the child changed is reverted
     * and the fix reported not-applied. Absent/empty → no-op, prior behavior.
     */
    frozenPaths?: string[]
    /**
     * The CURRENT task's id, for the cross-task deletion guard's provenance
     * discriminator. Absent → the guard is disarmed (prior behavior).
     */
    currentTaskId?: string
    /**
     * file → introducing task id (git provenance, see task-provenance.ts); null on
     * any unknown — inconclusive is never evidence. Absent → the cross-task
     * deletion guard is disarmed (prior behavior).
     */
    introducedBy?: (rel: string) => Promise<string | null>
    /**
     * Debug-log sink. Every guard below logs its own trip through it: a guard whose
     * firing leaves no record cannot be distinguished from one that never armed.
     */
    log?: (msg: string) => void
}

/** The fix child edits and runs the checker; bash exists to RUN the check, not git. */
export const LINT_FIX_TOOLS = 'read,edit,bash'

/**
 * Build the fix child's prompt. Two constraints carry the design: smallest edits
 * only — the re-run's rewrite habit is the defect this pass replaces — and an
 * explicit ban on discarding work, which is the cheapest route to a green check and
 * exactly what the revert-guard exists to catch.
 */
export function buildLintFixPrompt(failReason: string, frozenPaths: string[] = []): string {
    const frozenBlock =
        frozenPaths.length === 0 ?
            []
        :   [
                '3b. HARD CONSTRAINT — SPEC-FROZEN PATHS. The task spec forbids modifying:',
                ...frozenPaths.map(p => `   - ${p}`),
                '   You must NOT edit, create, or delete anything at or under these paths,',
                "   EVEN IF the checker's own error message suggests exactly that fix",
                '   (e.g. "consider including it in the tsconfig.json"). Any change you make',
                '   to a frozen path is detected and reverted, and the whole fix is rejected.',
                '   If the check cannot pass without touching a frozen path, STOP and report',
                '   LINT-FIX: BLOCKED with the reason.',
                ''
            ]
    return [
        'You are a bounded static-analysis fix pass. A verification gate just failed',
        `with: ${failReason}`,
        '',
        'The working tree contains UNCOMMITTED task work. Your ONLY job is to make the',
        "project's own static check pass again while preserving that work untouched.",
        '',
        '1. Run the failing check first to see the exact findings (the command is named',
        "   above; it is one of the project's own package.json scripts / make targets).",
        '',
        '2. Fix EXACTLY those findings with the smallest possible edits.',
        '   - Do NOT rewrite, restructure, or "improve" anything else.',
        '   - Do NOT touch files that have no findings.',
        '   - An unused variable/import introduced by the current work: delete just',
        '     those lines (or prefix an intentionally-unused parameter with _).',
        '',
        '3. HARD CONSTRAINT — never discard work: you must NOT run git checkout,',
        '   git restore, git stash, git reset, git clean, or any git command that',
        '   mutates state; you must NOT delete or revert whole files or functions.',
        '   Reverting the work would make the findings vanish — that is destroying the',
        '   task, not fixing it, and it is detected and rejected.',
        '',
        ...frozenBlock,
        '4. Re-run the check after editing and confirm it exits 0.',
        '',
        'End with exactly one line:',
        '  LINT-FIX: DONE',
        '  LINT-FIX: BLOCKED <why>'
    ].join('\n')
}

/**
 * Pure guard core: which pre-existing work files did the fix pass revert to HEAD?
 * `preDirty` = files differing from HEAD before the fix; `stillDirty` = after.
 */
export function revertGuardViolations(preDirty: string[], stillDirty: Set<string>): string[] {
    return preDirty.filter(f => !stillDirty.has(f))
}

const EXCLUDE_TASKS_DIR = ':(exclude).pi-tasks'

/**
 * Files differing from HEAD, or null when git itself failed. The distinction is
 * load-bearing: without it a run rolls back GOOD converged fixes because a git
 * failure after the child read as "[] files still dirty" → every pre-existing work
 * file looked reverted → false "discarded work". A git error is INCONCLUSIVE, not
 * evidence of destruction.
 */
async function dirtyFiles(deps: LintFixDeps): Promise<string[] | null> {
    const r = await deps.git(['diff', '--name-only', 'HEAD', '--', '.', EXCLUDE_TASKS_DIR])
    if (r.exitCode !== 0) return null
    return r.stdout
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0)
}

/**
 * The whole tree's current changes (`git status --porcelain` shape), or null when
 * git itself failed — inconclusive, not evidence (same discipline as dirtyFiles).
 * Feeds the cross-task deletion guard's pre/post comparison.
 */
async function treeChanges(deps: LintFixDeps): Promise<TreeChangeSummary | null> {
    const r = await deps.git(['status', '--porcelain', '--', '.', EXCLUDE_TASKS_DIR])
    if (r.exitCode !== 0) return null
    return parseTreeChanges(r.stdout)
}

/**
 * Which spec-frozen paths currently show a change in `git status`? Null when git
 * itself failed — inconclusive, not evidence (same discipline as dirtyFiles).
 */
async function frozenDirtySet(deps: LintFixDeps, frozen: string[]): Promise<Set<string> | null> {
    if (frozen.length === 0) return new Set()
    const r = await deps.git(['status', '--porcelain', '--', ...frozen])
    if (r.exitCode !== 0) return null
    return new Set(parseChangedFrozenFiles(r.stdout))
}

/**
 * Run the bounded fix: snapshot → child → revert-guard → frozen-path guard →
 * converge check. Never throws for an outcome; only a child-level user cancel
 * propagates from runChild.
 */
export async function runBoundedLintFix(deps: LintFixDeps): Promise<LintFixResult> {
    // Snapshot the full working state as a tree object (includes untracked files),
    // then unstage so the child sees the tree exactly as it was. A git failure at
    // snapshot time leaves the guard without a baseline — it then runs vacuously
    // (nothing to compare) rather than inventing violations.
    const preDirty = (await dirtyFiles(deps)) ?? []
    const preUntrackedRes = await deps.git([
        'ls-files',
        '--others',
        '--exclude-standard',
        '--',
        '.',
        EXCLUDE_TASKS_DIR
    ])
    const preUntracked =
        preUntrackedRes.exitCode !== 0 ?
            []
        :   preUntrackedRes.stdout
                .split('\n')
                .map(l => l.trim())
                .filter(l => l.length > 0)
    let snapshot: string | null = null
    const add = await deps.git(['add', '-A'])
    if (add.exitCode === 0) {
        const wt = await deps.git(['write-tree'])
        if (wt.exitCode === 0) snapshot = wt.stdout.trim()
        await deps.git(['reset'])
    }

    // FROZEN-PATH baseline: frozen paths already dirty BEFORE the child ran carry
    // (possibly the task's own) work — the guard must never revert those, only
    // changes the CHILD introduces on top of a clean frozen path. A git failure
    // here disables the guard for this run (inconclusive ≠ license to revert).
    const frozen = deps.frozenPaths ?? []
    const preFrozenDirty = await frozenDirtySet(deps, frozen)

    // CROSS-TASK DELETION baseline: deletions already in the tree pre-child are
    // the task's own (uncommitted) work, not the child's — only deletions the
    // CHILD introduces on top are candidates. A git failure here disarms the
    // guard for this run (inconclusive ≠ evidence).
    const deletionGuardArmed = Boolean(deps.currentTaskId && deps.introducedBy)
    const preChanges = deletionGuardArmed ? await treeChanges(deps) : null

    // The four-rung ladder lives in task/fix-child.ts: a cancel propagates as a
    // THROW (so the caller's USER_CANCELLED path is unchanged), a child that threw
    // for any other reason is `error`, a self-declared BLOCKED is `blocked`, and
    // anything else is `done`.
    const end = await runFixChild({
        runChild: deps.runChild,
        tools: LINT_FIX_TOOLS,
        prompt: buildLintFixPrompt(deps.failReason, frozen),
        signal: deps.signal,
        marker: 'LINT-FIX'
    })
    if (end.kind === 'error') {
        deps.log?.(`lint-fix child failed — ${end.msg}`)
        return {ok: false, reason: `fix child failed: ${end.msg}`}
    }
    // A BLOCKED child is NOT an early return from here: the guards below exist to
    // catch a child that discarded work, and a child can discard work and then
    // block. The marker is consulted after them, in place of the re-run — which is
    // where the twin consults its own.

    // REVERT-GUARD: every pre-existing work file must still differ from HEAD, and
    // every pre-existing untracked file must still exist. Trip → restore snapshot.
    // Every comparison requires git to have actually SUCCEEDED. A git error after
    // the child reads as "nothing is dirty", which would flag every pre-existing
    // work file as discarded — inconclusive, not evidence. The guard then steps
    // aside and the converge check below still decides.
    const stillDirtyList = await dirtyFiles(deps)
    let guardNote: string | undefined
    const violations: string[] = []
    if (stillDirtyList === null) {
        guardNote = 'revert-guard inconclusive (git failed after fix) — converge check decides'
    } else {
        const stillDirty = new Set(stillDirtyList)
        violations.push(...revertGuardViolations(preDirty, stillDirty))
        for (const f of preUntracked) {
            const probe = await deps.git(['ls-files', '--others', '--exclude-standard', '--', f])
            if (probe.exitCode !== 0) {
                // git error → unknown, not "gone"; note it once and move on.
                guardNote ??= 'revert-guard partly inconclusive (git probe failed)'
                continue
            }
            const gone =
                probe.stdout.trim().length === 0
                // ...unless the child legitimately made it tracked-dirty (it edited it).
                && !stillDirty.has(f)
            if (gone) violations.push(f)
        }
    }
    if (violations.length > 0) {
        if (snapshot) {
            // Restore the pre-fix state: tree paths back, then unstage. .pi-tasks is
            // excluded so gate logs appended during the fix survive.
            await deps.git(['checkout', snapshot, '--', '.', EXCLUDE_TASKS_DIR])
            await deps.git(['reset'])
        }
        deps.log?.(`lint-fix REVERT-GUARD — discarded ${violations.length} work file(s)`)
        return {
            ok: false,
            reason:
                `revert-guard: fix pass discarded work (${violations.slice(0, 3).join(', ')}`
                + `${violations.length > 3 ? ', …' : ''}) — fix ${snapshot ? 'rolled back' : 'REJECTED but no snapshot to restore'}`
        }
    }

    // CROSS-TASK DELETION GUARD: a tracked file the CHILD deleted whose
    // introducing task differs from the current task is a sibling's committed
    // deliverable destroyed to go green. The revert-guard above only watches
    // pre-dirty and pre-untracked files, and a clean tracked sibling file is
    // neither. Restore JUST those paths from HEAD (they were clean pre-child,
    // so nothing of the task's work can be lost) and report not-applied naming the
    // owner. Inconclusive on any side — git error, unknown provenance, same-task
    // deletion, relocation — steps aside.
    if (deletionGuardArmed && preChanges !== null) {
        const postChanges = await treeChanges(deps)
        if (postChanges !== null) {
            const preDeleted = new Set(preChanges.deleted)
            const crossDeletions = await findCrossTaskDeletions(
                {
                    modified: postChanges.modified,
                    added: postChanges.added,
                    deleted: postChanges.deleted.filter(p => !preDeleted.has(p))
                },
                deps.currentTaskId!,
                deps.introducedBy!
            )
            if (crossDeletions.length > 0) {
                await deps.git(['checkout', '-f', 'HEAD', '--', ...crossDeletions.map(d => d.path)])
                const named = crossDeletions.map(d => `${d.path} — ${d.owner}'s deliverable`)
                deps.log?.(`lint-fix CROSS-TASK-DELETION GUARD — ${named[0]}`)
                return {
                    ok: false,
                    reason:
                        `cross-task-deletion: fix child DELETED sibling task deliverable(s) `
                        + `(${named.slice(0, 3).join('; ')}${crossDeletions.length > 3 ? '; …' : ''}) `
                        + `— restored from HEAD; deleting another task's committed work is not a fix`
                }
            }
        }
    }

    // FROZEN-PATH GUARD: a frozen path that was clean pre-child and is changed now
    // is the child's edit — the exact write verify's rule-4b prohibition probe
    // fails the TASK for. Revert JUST those paths (they were clean, so HEAD ==
    // pre-state: no work can be lost) and report not-applied so the caller falls
    // through to the ordinary recommend → AUTOFIX/ACCEPT picker. Inconclusive git
    // (either side) → guard steps aside; the verify probe still catches what
    // survives.
    if (preFrozenDirty !== null) {
        const postFrozenDirty = await frozenDirtySet(deps, frozen)
        if (postFrozenDirty !== null) {
            const frozenViolations = [...postFrozenDirty].filter(f => !preFrozenDirty.has(f))
            if (frozenViolations.length > 0) {
                const reverted = await revertFrozenPaths(frozenViolations, deps.git)
                deps.log?.(
                    `lint-fix FROZEN-PATH GUARD — ${frozenViolations.slice(0, 3).join(', ')}`
                )
                return {
                    ok: false,
                    reason:
                        `frozen-path: fix child modified spec-frozen path(s) `
                        + `(${frozenViolations.slice(0, 3).join(', ')}`
                        + `${frozenViolations.length > 3 ? ', …' : ''}) — `
                        + `${reverted.length > 0 ? 'reverted' : 'REJECTED (revert found nothing to undo)'}; `
                        + `the static findings need a fix that respects the spec's constraints`
                }
            }
        }
    }

    if (end.kind === 'blocked') deps.log?.(`lint-fix BLOCKED — ${end.note}`)

    // The CHECK is the arbiter, including after a BLOCKED marker.
    //
    // The marker is scraped last-match-wins out of arbitrary child output, and
    // LINT_FIX_TOOLS carries bash — so the child's own command output is in that
    // text. A child can also genuinely converge and THEN block: `eslint --fix`
    // silently clears the last finding, and the model still reports
    // `LINT-FIX: BLOCKED the generated file is frozen`. Returning not-applied on
    // the marker alone would send the gate to `deps.recommend(...)` with a
    // failReason that no longer describes the tree, skipping the re-verify and
    // burning a full implementation re-run on findings that are already gone —
    // while the child's edits sit in the working tree.
    //
    // So BLOCKED does not decide; it only supplies a better REASON when the check
    // agrees nothing converged. Skipping the re-run on the marker alone is not
    // worth that risk.
    const health = await deps.repoHealth()
    if (!health.ok) {
        if (end.kind === 'blocked') {
            return {ok: false, reason: `fix child blocked: ${end.note}`}
        }
        // FROZEN-PATH TRACE on non-convergence: when the child was honest — it did
        // NOT touch the frozen path, so the guard above never tripped — but the
        // check is still red and its own output NAMES a frozen path (the typed
        // ESLint message quoted in this file's header), the findings can only be
        // fixed by an edit this task's spec forbids. Report it under the same
        // `frozen-path:` prefix as the guard trip, so the gate loop can route
        // straight to the human picker instead of burning unattended AUTOFIX
        // rounds an impl re-run under the same freeze cannot converge out of.
        const implicated = frozen.filter(p =>
            pathNamedIn(`${health.reason}\n${health.output ?? ''}`, p)
        )
        if (implicated.length > 0) {
            deps.log?.(`lint-fix FROZEN-PATH TRACE — ${implicated.slice(0, 3).join(', ')}`)
            return {
                ok: false,
                reason:
                    `frozen-path: static findings implicate spec-frozen path(s) `
                    + `(${implicated.slice(0, 3).join(', ')}`
                    + `${implicated.length > 3 ? ', …' : ''}) — did not converge `
                    + `(${health.reason}); a fix under this task's constraints cannot converge`
            }
        }
        return {ok: false, reason: `did not converge: ${health.reason}`}
    }
    return {ok: true, reason: guardNote}
}
