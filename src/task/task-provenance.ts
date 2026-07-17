/**
 * task-provenance — file → introducing-task lookup, and the cross-task deletion
 * detection built on it (mx5 run-12 PROMPT 2).
 *
 * The failure class: write-enabled gate/fix children can DELETE a sibling task's
 * committed deliverable to turn a red check green. Live (mx5 2026-07-16,
 * verify-debug.log 17:53:44): `bun run lint` was permanently red because
 * committed playwright ct files were not registered in a spec-frozen tsconfig —
 * so a lint-fix child deleted TASK_0020's verified deliverables and the pass
 * returned ok. Every existing guard missed the class:
 *
 *   - the lint-fix revert-guard checks only pre-DIRTY files reverted and
 *     pre-UNTRACKED files gone — a CLEAN tracked sibling file is in neither set;
 *   - the frozen-path guard covers only paths THIS task's spec froze;
 *   - the run-11 deletion guard covers only the final-fix child;
 *   - the impl turn legitimately deletes files (its own refactors), so a blanket
 *     ban is wrong — the discriminator must be PROVENANCE: who introduced the file.
 *
 * The provenance primitive (extracted from final-gate.ts, where it fed the
 * conflicting-claim annotation) resolves a file to the task whose commit ADDED it
 * (`git log --diff-filter=A` → oldest task-subject commit). Every unknown — a file
 * predating the run, a non-task commit, any git error — degrades to null:
 * inconclusive is never evidence, so the guards built on this may only cost time,
 * never work.
 */
import {spawnSync} from 'node:child_process'
import {findForbiddenDeletions, type TreeChangeSummary} from './write-guard.js'

/** Run a git subcommand; only stdout + exit code are read (injectable for tests). */
export type ProvenanceGit = (args: string[]) => Promise<{stdout: string; exitCode: number}>

/**
 * The task id carried by the OLDEST commit subject in `git log --diff-filter=A
 * --format=%s` output (newest-first, so the LAST line is the original
 * introduction — a delete-and-re-add later in history must not reattribute the
 * file). Both the task snapshot and the ENFORCE commit shapes match the
 * `(TASK_nnnn)` suffix. Null when the output is empty or the adding commit is
 * not a task commit.
 */
export function parseIntroducingTask(logSubjects: string): string | null {
    const subjects = logSubjects.trim().split('\n').filter(Boolean)
    const first = subjects[subjects.length - 1] ?? ''
    const m = /\((TASK_\d+)\)\s*$/.exec(first)
    return m ? m[1] : null
}

/**
 * The task whose commit INTRODUCED `rel`. Null when the file predates the run,
 * was never committed, git is unavailable, or the adding commit is not a task
 * commit — every unknown degrades to "no provenance claim".
 */
export function taskThatIntroduced(cwd: string, rel: string): string | null {
    const r = spawnSync('git', ['log', '--diff-filter=A', '--format=%s', '--', rel], {
        cwd,
        encoding: 'utf8'
    })
    if (r.error || r.status !== 0 || !r.stdout) return null
    return parseIntroducingTask(r.stdout)
}

/** Same lookup through an injected async git (the lint-fix deps shape). */
export async function taskThatIntroducedVia(
    git: ProvenanceGit,
    rel: string
): Promise<string | null> {
    const r = await git(['log', '--diff-filter=A', '--format=%s', '--', rel])
    if (r.exitCode !== 0 || !r.stdout) return null
    return parseIntroducingTask(r.stdout)
}

/** One detected cross-task deletion: the file and the task whose commit introduced it. */
export interface CrossTaskDeletion {
    path: string
    owner: string
}

/**
 * Deterministic cross-task deletion detection: a tracked file DELETED in the
 * given change summary whose introducing task differs from the CURRENT task is a
 * finding. Everything else steps aside by construction — same-task deletions and
 * unknown provenance are never findings (a task refactoring its own work must not
 * be blocked), an unknown CURRENT task id disables the check ("differs" cannot be
 * established), and a relocation (the same file name reappears among the added
 * files — write-guard's allowance) is not a deletion. `introducedBy` may be sync
 * or async and may throw; a throw reads as unknown provenance.
 */
export async function findCrossTaskDeletions(
    changes: TreeChangeSummary,
    currentTaskId: string,
    introducedBy: (rel: string) => string | null | Promise<string | null>
): Promise<CrossTaskDeletion[]> {
    const current = currentTaskId.trim()
    if (current.length === 0) return []
    const out: CrossTaskDeletion[] = []
    for (const p of findForbiddenDeletions(changes)) {
        let owner: string | null
        try {
            owner = await introducedBy(p)
        } catch {
            owner = null
        }
        if (owner && owner !== current) out.push({path: p, owner})
    }
    return out
}

/**
 * Finding lines for the verify prompt (the substitution-probe injection pattern:
 * the rule alone is A/B-proven ignored, the rule plus a concrete finding naming
 * the file is what lands).
 */
export function crossTaskDeletionVerifyFindings(found: CrossTaskDeletion[]): string[] {
    return found.map(
        f => `\`${f.path}\` — introduced and committed by ${f.owner}, DELETED by this task's work`
    )
}
