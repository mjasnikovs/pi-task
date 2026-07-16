/**
 * lint-fix — the bounded, graduated resolution for a repo-health verify FAIL.
 *
 * The failure this closes (mx5 run 3, TASK_0017): AUTOFIX's only hammer is a FULL
 * implementation re-run. For a repo-health FAIL of 10 trivial lint findings the live
 * run burned two 36–56-minute impl turns, each REGENERATING a fresh 900-line rewrite
 * that failed lint differently — the loop cannot converge because the tool is bigger
 * than the defect. Validated live on the real TASK_0017 tree: a bounded fix child
 * (read,edit,bash) reached lint-clean in 64s and 106s, 2/2.
 *
 * The same validation caught the design's failure mode: BOTH runs cheated, running
 * `git checkout -- src/test/request.ts` — REVERTING the task's uncommitted work to
 * make the findings vanish. So this pass ships with a deterministic REVERT-GUARD,
 * outcome-based (command filtering can't catch every path to the same effect):
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
 * FROZEN-PATH GUARD (mx5 run 12, TASK_0021/0022): the checker's own error text
 * can INSTRUCT an edit to a spec-frozen file (typed ESLint: "playwright/index.ts
 * was not found by the project … Consider either including it in the
 * tsconfig.json") and this child complies — while the task's spec froze
 * `tsconfig.json` and verify's rule-4b prohibition probe then fails the TASK for
 * the gate child's edit. Two gates, contradictory rules, same file; the loop
 * never converges (live: TASK_0021 burned all three unattended AUTOFIX rounds).
 * Prompt framing alone is A/B-proven ~0–1/5 on the weak model (see
 * frozen-path-guard.ts), so the deny is mechanical: the spec's frozen paths are
 * threaded in via `frozenPaths`, injected into the prompt as a do-not-touch list
 * (belt), and any frozen path the child still changed is deterministically
 * reverted post-child and the fix reported not-applied (suspenders). Only paths
 * that were CLEAN before the child ran are reverted — a frozen path already
 * dirty with (possibly task) work is left alone, in the guard's safe direction:
 * cost time, never work.
 */
import {parseChangedFrozenFiles, revertFrozenPaths} from './frozen-path-guard.js'

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
    /** The deterministic whole-repo static check to converge against. */
    repoHealth: () => Promise<{ok: boolean; reason: string}>
    /** Run git in cwd; injected so the guard logic is unit-testable. */
    git: (args: string[]) => Promise<{exitCode: number; stdout: string}>
    /**
     * Paths the task's spec forbids modifying (frozenPathsFromSpec over the same
     * composed spec verify judges). Injected into the child's prompt AND enforced
     * deterministically post-child: a frozen path the child changed is reverted
     * and the fix reported not-applied. Absent/empty → no-op, prior behavior.
     */
    frozenPaths?: string[]
}

/** The fix child edits and runs the checker; bash exists to RUN the check, not git. */
export const LINT_FIX_TOOLS = 'read,edit,bash'

/**
 * Build the fix child's prompt. The constraints encode both live findings: smallest
 * edits only (the impl re-run's rewrite habit is the defect this pass replaces), and
 * an explicit ban on discarding work (both validation runs reached green via
 * `git checkout` of the work file until the guard existed).
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
 * load-bearing: mx5 run 4 rolled back two GOOD converged fixes because a git
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

    try {
        await deps.runChild(
            LINT_FIX_TOOLS,
            buildLintFixPrompt(deps.failReason, frozen),
            deps.signal
        )
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // A cancel must propagate so the caller's USER_CANCELLED path runs.
        if (msg === '__user_cancelled__') throw err
        return {ok: false, reason: `fix child failed: ${msg}`}
    }

    // REVERT-GUARD: every pre-existing work file must still differ from HEAD, and
    // every pre-existing untracked file must still exist. Trip → restore snapshot.
    // Every comparison requires git to have actually SUCCEEDED: a git error after
    // the child is inconclusive (proven live: it flagged the whole untracked file
    // list as "discarded" while the child had verifiably edited only lint findings)
    // — then the guard steps aside and the converge check below still decides.
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
        return {
            ok: false,
            reason:
                `revert-guard: fix pass discarded work (${violations.slice(0, 3).join(', ')}`
                + `${violations.length > 3 ? ', …' : ''}) — fix ${snapshot ? 'rolled back' : 'REJECTED but no snapshot to restore'}`
        }
    }

    // FROZEN-PATH GUARD: a frozen path that was clean pre-child and is changed
    // now is the child's edit — the exact write verify's rule-4b prohibition
    // probe is guaranteed to fail the TASK for (mx5 run 12: ESLint's own error
    // text instructed the tsconfig.json edit and the child complied, 5/5 in the
    // live A/B). Revert JUST those paths (they were clean, so HEAD == pre-state:
    // no work can be lost) and report not-applied so the caller falls through to
    // the ordinary recommend → AUTOFIX/ACCEPT picker. Inconclusive git (either
    // side) → guard steps aside; the verify probe still catches what survives.
    if (preFrozenDirty !== null) {
        const postFrozenDirty = await frozenDirtySet(deps, frozen)
        if (postFrozenDirty !== null) {
            const frozenViolations = [...postFrozenDirty].filter(f => !preFrozenDirty.has(f))
            if (frozenViolations.length > 0) {
                const reverted = await revertFrozenPaths(frozenViolations, deps.git)
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

    const health = await deps.repoHealth()
    if (!health.ok) {
        return {ok: false, reason: `did not converge: ${health.reason}`}
    }
    return {ok: true, reason: guardNote}
}
