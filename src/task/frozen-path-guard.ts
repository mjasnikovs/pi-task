/**
 * frozen-path-guard — deterministic write-deny on spec-frozen paths for the
 * write-capable gate children, the enforce EDIT pass especially.
 *
 * The failure class: a spec's CONSTRAINTS pin a path as off-limits ("**Do NOT
 * modify** `src/server/index.ts`"), and a later write-enabled GATE pass edits it
 * anyway. The enforce child runs with `ENFORCE_TOOLS = 'read,edit'`, its edits
 * are judged only for guideline compliance, and they are then committed as an
 * `ENFORCE GUIDELINES` snapshot on top of the verified task — so the frozen
 * contract gets mutated by the very pass meant to police the work.
 *
 * A tool-layer deny is not available. pi 0.84.4 offers `--tools` and
 * `--exclude-tools`, both allow/deny by tool NAME; no flag scopes an edit to a
 * path. A chmod-style physical deny would leave the child thrashing on a bare
 * EACCES, and the enforce child has NO WALL CLOCK to stop it — the `gate` row of
 * WORKER_PROFILES sets `worker-timeout` to `{timeoutMs: 0}`, leaving only a
 * per-command watchdog and a stream watchdog.
 *
 * So the achievable deny is after the fact: let the pass edit freely, then
 * deterministically UNDO any frozen-path change before those edits can be
 * committed. No model is in the loop, the same discipline as git-state-guard.
 *
 * Everything degrades to a no-op when the spec froze nothing — a single-`/task`
 * run, or a spec with no `Do NOT modify` line naming a path — and on any git
 * error. Pure git shape, zero stack assumptions: a frozen path exists for a CLI,
 * a library or a script collection exactly as for a web app.
 */
import {extractProhibitions} from './prohibition-probe.js'

/** Run a git subcommand in the guard's cwd; only stdout + exit code are read. */
export type FrozenGit = (args: string[]) => Promise<{stdout: string; exitCode: number}>

/**
 * The concrete paths the spec forbids modifying, normalized and de-duplicated —
 * `extractProhibitions`, the same extraction the verify prohibition probe
 * (gate-deps.ts) and the compose-time conflict detector (frozen-conflict.ts)
 * consume, so "frozen" means one thing across the gates.
 *
 * Normalisation strips a leading `./` and a trailing `/`: measured, a spec
 * banning `` `./src/a.ts` `` and `` `src/b/` `` yields `src/a.ts` and `src/b`.
 * A null spec, or one with no modification-ban line naming a path, yields an
 * empty list and the guard is a no-op by construction.
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
 * Does this prose or tool-output text NAME the given path? Word-bounded on both
 * sides. Measured against `tsconfig.json`: `` `tsconfig.json` ``,
 * `(tsconfig.json:18)` and a bare mention all match; `foo.tsconfig.json`,
 * `config/tsconfig.json` (a different file), `tsconfig.json5` and
 * `tsconfig.json.bak` all do not. Shared by the compose-time unsatisfiable-pair
 * detector (frozen-conflict.ts) and lint-fix's non-convergence trace, so "the
 * text names a frozen path" means one thing.
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
 *
 * Every shape below was taken from real `git status --porcelain` output, not
 * assumed: ` M path`, ` D path`, `?? path`, `R  old -> new`, and a path
 * containing a space, which git emits wrapped in double quotes.
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
 * separate concern the verify prohibition probe surfaces. `git checkout -f HEAD`
 * covers modified and deleted tracked files under each pathspec; `git clean -fdq`
 * removes untracked files the pass created under a frozen directory. Both are
 * scoped to the frozen pathspec.
 *
 * Run against a real repo with one frozen directory and one free one: a modified
 * file came back to its HEAD content, a deleted file came back, and two untracked
 * creations (one with a space in its name) were removed, while an edit to a file
 * OUTSIDE the pathspec survived untouched.
 *
 * ONE CASE IS NOT FULLY UNDONE: a rename already STAGED in the index. `git mv`
 * inside the frozen directory leaves `frozen/new.txt` present and staged after
 * both commands, because checkout cannot restore a path HEAD does not contain and
 * clean skips tracked files — while this function still reports it as reverted.
 * An ordinary edit-tool rename is a delete plus an untracked create, and that IS
 * fully undone; staging requires git, which the enforce child does not have.
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
