/**
 * frozen-path-guard — deterministic write-deny on spec-frozen paths for the
 * write-capable gate children (the enforce EDIT pass especially).
 *
 * The failure class (deferred once as the last unshipped
 * piece of the frozen-contract work): a spec's CONSTRAINTS pin a path as
 * off-limits ("**Do NOT modify** `src/server/index.ts`"), and a later
 * write-enabled GATE pass — the enforce child runs `read,edit` — edits that path
 * anyway. Its edits are judged only locally (a guideline-compliance verdict), then
 * committed as an "ENFORCE GUIDELINES" snapshot on top of the verified task. The
 * frozen contract is silently mutated by the very pass meant to police the work.
 *
 * Prompt framing is A/B-PROVEN insufficient for this class (the "FROZEN CONTRACT,
 * MUST NOT edit" instruction does not hold on its own — the weak
 * local model ignores an explicit capitalized MUST-NOT most of the time). A
 * chmod-style physical deny holds, but makes the model THRASH on the bare
 * EACCES (1000+ futile re-attempts observed) — unacceptable on the enforce child,
 * which runs UNGUARDED (no wall-clock timeout). pi itself has no path-level edit
 * interception (only tool-NAME allow/deny), so the achievable, thrash-free,
 * stack-agnostic realization of a tool-layer deny is this: let the pass edit
 * freely, then deterministically UNDO any frozen-path change it made before those
 * edits can be committed. The violating write never lands in a commit, regardless
 * of what the model intended — no model in the loop, same discipline as
 * git-state-guard.
 *
 * Everything degrades to a no-op when the spec froze nothing (a single-`/task`
 * run, or a spec with no `Do NOT modify` line naming a path → no frozen paths →
 * nothing snapshotted, nothing reverted) and on any git error. Pure git shape,
 * zero stack assumptions — a frozen path exists for a CLI, a library, a script
 * collection exactly as for a web app.
 */
import {extractProhibitions} from './prohibition-probe.js'

/** Run a git subcommand in the guard's cwd; only stdout + exit code are read. */
export type FrozenGit = (args: string[]) => Promise<{stdout: string; exitCode: number}>

/**
 * The concrete paths the spec forbids modifying, normalized and de-duplicated —
 * the SAME extraction the verify prohibition-probe and the accept-debt ledger
 * consume, so "frozen" means one thing across the gates. Empty when the spec is
 * null or names no path-like token on a modification-ban line: the guard is then a
 * no-op by construction.
 */
export function frozenPathsFromSpec(spec: string | null | undefined): string[] {
    if (!spec) return []
    const seen = new Set<string>()
    for (const p of extractProhibitions(spec)) {
        const n = p.path.replace(/^\.\//, '').replace(/\/+$/, '')
        if (n.length > 0) seen.add(n)
    }
    return [...seen]
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Does this prose/tool-output text NAME the given path? Word-bounded on both
 * sides so `tsconfig.json` matches `` `tsconfig.json` ``, `(tsconfig.json:18)`
 * and a bare mention, but never `foo.tsconfig.json`, `config/tsconfig.json`
 * (a different file) or `tsconfig.json5`/`tsconfig.json.bak`. Shared by the
 * compose-time unsatisfiable-pair detector (frozen-conflict.ts) and lint-fix's
 * non-convergence trace, so "the text names a frozen path" means one thing.
 */
export function pathNamedIn(text: string, path: string): boolean {
    const p = path.replace(/^\.\//, '').replace(/\/+$/, '')
    if (p.length === 0) return false
    return new RegExp(`(?:^|[^\\w./-])${escapeRe(p)}(?!\\.?[\\w-])`, 'im').test(text)
}

/**
 * Parse `git status --porcelain` output (already scoped to the frozen pathspec)
 * into the list of changed files, for the gate-trail record and to decide whether
 * anything must be reverted at all. A rename line (`R  old -> new`) yields the NEW
 * path — the side that carries the child's write. Deterministic and pure so the
 * parsing is unit-tested without a real repo.
 */
export function parseChangedFrozenFiles(porcelain: string): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    for (const raw of porcelain.split('\n')) {
        // Porcelain v1: two status chars, a space, then the path. Blank/short lines
        // (trailing newline) carry no entry.
        if (raw.length < 4) continue
        let file = raw.slice(3).trim()
        if (file.length === 0) continue
        // Rename/copy: "orig -> new" — the new path is the one the write produced.
        const arrow = file.indexOf(' -> ')
        if (arrow !== -1) file = file.slice(arrow + 4).trim()
        // Porcelain quotes paths with unusual chars; strip the surrounding quotes.
        if (file.startsWith('"') && file.endsWith('"') && file.length >= 2) {
            file = file.slice(1, -1)
        }
        if (file.length === 0 || seen.has(file)) continue
        seen.add(file)
        out.push(file)
    }
    return out
}

/**
 * Restore the spec-frozen paths to their committed (HEAD) state, undoing any
 * change a just-run write-capable gate child made to them, and return the list of
 * files that had to be reverted (empty ⇒ the pass respected every frozen path).
 *
 * Runs AFTER the task's own work is committed (HEAD), so "restore to HEAD" keeps
 * the verified task's version of the frozen file and discards ONLY the gate
 * child's edit on top of it — the task's own frozen-path edits, if any, are a
 * separate concern the verify prohibition-probe surfaces. `git checkout HEAD`
 * covers modified/deleted tracked files under each pathspec; `git clean` removes
 * any untracked file the pass created under a frozen directory. Both are scoped to
 * the frozen pathspec, so nothing else in the tree is touched.
 *
 * Best-effort: an empty frozen list, a non-git tree, or any git error yields an
 * empty result — the guard must never break the gate on a project it cannot reason
 * about.
 */
export async function revertFrozenPaths(paths: string[], git: FrozenGit): Promise<string[]> {
    if (paths.length === 0) return []
    const status = await git(['status', '--porcelain', '--', ...paths])
    if (status.exitCode !== 0) return []
    const changed = parseChangedFrozenFiles(status.stdout)
    if (changed.length === 0) return []
    // Restore tracked modifications/deletions from HEAD, then remove any untracked
    // additions — both confined to the frozen pathspec so the pass's legitimate
    // edits to OTHER files survive untouched.
    await git(['checkout', '-f', 'HEAD', '--', ...paths])
    await git(['clean', '-fdq', '--', ...paths])
    return changed
}
