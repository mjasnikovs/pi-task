/**
 * write-guard — deterministic tree-change accounting for WRITE-CAPABLE gate
 * children (mx5 run 11).
 *
 * The failure class: the final-gate autofix child (read,edit,bash) was added after
 * the run-8 guard generation and inherited NONE of the guards the other
 * write-capable passes carry — no diff capture, no frozen-path deny, no probe
 * scans, free `rm`. Run 11 it deleted `src/client/pages/admin.tsx` (TASK_0008's
 * verified deliverable) to satisfy a recorded debt claim, and the deletion was
 * invisible: nothing even logged what the pass changed.
 *
 * This module is the pure half of the guard stack: parse `git status --porcelain`
 * into a change summary (the diff-capture log line every write-capable child now
 * gets at the gate-deps seam), and classify tracked-file DELETIONS. A fix pass
 * exists to repair the assembled repository, not to shrink it: every tracked file
 * is a committed task's deliverable, so deleting one is rejected outright — with
 * one allowance, a RELOCATION (the same file name reappears as an added file
 * elsewhere, e.g. moving a test the runner was never meant to pick up out of its
 * glob — the legitimate fix shape from run 7). Pure text/path analysis; no git
 * execution, no stack assumptions.
 */

/** What a write-capable pass changed, from `git status --porcelain`. */
export interface TreeChangeSummary {
    /** Tracked files modified in place (includes rename targets). */
    modified: string[]
    /** Tracked files deleted from the worktree/index (includes rename sources). */
    deleted: string[]
    /** New files: untracked (`??`) or staged adds (includes rename targets). */
    added: string[]
}

/** Porcelain v1 line: `XY <path>` or `XY <orig> -> <new>` (rename/copy). */
function splitEntry(raw: string): {x: string; y: string; from: string; to: string} | null {
    if (raw.length < 4) return null
    const x = raw[0]
    const y = raw[1]
    const file = raw.slice(3).trim()
    if (file.length === 0) return null
    let from = file
    let to = file
    const arrow = file.indexOf(' -> ')
    if (arrow !== -1) {
        from = file.slice(0, arrow).trim()
        to = file.slice(arrow + 4).trim()
    }
    const unquote = (s: string): string =>
        s.startsWith('"') && s.endsWith('"') && s.length >= 2 ? s.slice(1, -1) : s
    return {x, y, from: unquote(from), to: unquote(to)}
}

/**
 * Parse `git status --porcelain` output into the change summary. A rename entry
 * contributes its source to `deleted` and its target to `added` (unstaged child
 * edits show the same reality as separate ` D old` + `?? new` lines, so both
 * shapes classify identically). Deterministic and pure so it is unit-tested
 * without a repo.
 */
export function parseTreeChanges(porcelain: string): TreeChangeSummary {
    const modified = new Set<string>()
    const deleted = new Set<string>()
    const added = new Set<string>()
    for (const raw of porcelain.split('\n')) {
        const e = splitEntry(raw)
        if (!e) continue
        const status = `${e.x}${e.y}`
        if (status === '??') {
            added.add(e.to)
            continue
        }
        if (e.x === 'R' || e.y === 'R' || e.x === 'C') {
            deleted.add(e.from)
            added.add(e.to)
            continue
        }
        if (e.x === 'D' || e.y === 'D') {
            deleted.add(e.from)
            continue
        }
        if (e.x === 'A') {
            added.add(e.to)
            continue
        }
        modified.add(e.to)
    }
    return {modified: [...modified], deleted: [...deleted], added: [...added]}
}

const basename = (p: string): string => {
    const i = p.lastIndexOf('/')
    return i === -1 ? p : p.slice(i + 1)
}

/**
 * The deletions a fix pass may NOT make: every deleted tracked file whose name does
 * not reappear among the added files (a relocation keeps the file, under the same
 * name, somewhere in the tree). Anything returned here rejects the whole fix
 * attempt — run 11's `rm src/client/pages/admin.tsx` had no corresponding add and
 * destroyed a sibling task's verified deliverable.
 */
export function findForbiddenDeletions(changes: TreeChangeSummary): string[] {
    if (changes.deleted.length === 0) return []
    const addedNames = new Set(changes.added.map(basename))
    return changes.deleted.filter(p => !addedNames.has(basename(p)))
}

/**
 * One-line summary for the gate debug log — the diff capture every write-capable
 * child gets so "what did this pass change" is answerable from artifacts (the
 * run-11 `rm` left no trace outside the bash stream).
 */
export function formatTreeChanges(changes: TreeChangeSummary): string {
    if (
        changes.modified.length === 0
        && changes.deleted.length === 0
        && changes.added.length === 0
    ) {
        return '(no tree changes)'
    }
    const part = (label: string, list: string[]): string[] =>
        list.length > 0 ? [`${label} [${list.join(', ')}]`] : []
    return [
        ...part('MODIFIED', changes.modified),
        ...part('NEW', changes.added),
        ...part('DELETED', changes.deleted)
    ].join(' ')
}
