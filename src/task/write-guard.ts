/**
 * write-guard — deterministic tree-change accounting for WRITE-CAPABLE gate
 * children.
 *
 * The failure class: the final-gate autofix child (read,edit,bash) was added after
 * the guard generation and inherited NONE of the guards the other
 * write-capable passes carry — no diff capture, no frozen-path deny, no probe
 * scans, free `rm`. It will delete a file like `src/client/pages/admin.tsx` (a task
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
 * glob — a legitimate fix shape). Pure text/path analysis; no git
 * execution, no stack assumptions.
 */
import {isDeletionExemptArtifact} from './regenerable-artifacts.js'

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

/**
 * Parse `git diff --name-status` output (tab-separated: `M\tpath`, `A\tpath`,
 * `D\tpath`, `R100\told\tnew`, `C75\told\tnew`) into the same change summary. Used
 * where the working tree is already clean and the last COMMIT's diff is the record
 * of the task's changes (the post-enforce re-verify fallback). A rename entry
 * contributes its source to `deleted` and its target to `added`, matching
 * parseTreeChanges so the relocation allowance below reads both shapes identically;
 * a copy's source still exists, so only its target counts (as added).
 */
export function parseNameStatusChanges(nameStatus: string): TreeChangeSummary {
    const modified = new Set<string>()
    const deleted = new Set<string>()
    const added = new Set<string>()
    for (const raw of nameStatus.split('\n')) {
        const parts = raw.split('\t').map(s => s.trim())
        const code = parts[0] ?? ''
        if (code.length === 0 || !parts[1]) continue
        if (code.startsWith('R')) {
            deleted.add(parts[1])
            if (parts[2]) added.add(parts[2])
            continue
        }
        if (code.startsWith('C')) {
            added.add(parts[2] ?? parts[1])
            continue
        }
        if (code.startsWith('D')) {
            deleted.add(parts[1])
            continue
        }
        if (code.startsWith('A')) {
            added.add(parts[1])
            continue
        }
        modified.add(parts[1])
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
 * attempt — a `rm src/client/pages/admin.tsx` had no corresponding add and
 * destroyed a sibling task's verified deliverable.
 *
 * REGENERABLE TEST-RUNNER OUTPUT IS EXEMPT. The guard is pure git: no
 * ecosystem, no exemption list, so three Playwright FAILURE screenshots that
 * a task's own `git add -A` had swept into a commit read as deliverables. Two
 * consecutive attempts were discarded whole over them — each taking a real
 * `src/client/api.test.tsx` repair with it, which attempt 3 then re-did and kept.
 * 6m14s of an 8m16s gate. And the pipeline committed those same three deletions at
 * the end anyway, in the stranded-fix commit, so the guard did not
 * even preserve what it rejected two attempts to protect.
 *
 * The exempt list is a strict SUBSET of the verdict-level artifact list and lives
 * in `regenerable-artifacts.ts`. `dist/`, `build/`, `.next/`, `.turbo/` and
 * `.svelte-kit/` are NOT in it: a committed build output can be the shipped
 * artifact, so deleting one is destructive in a way deleting a failure screenshot
 * is not.
 */
export function findForbiddenDeletions(changes: TreeChangeSummary): string[] {
    if (changes.deleted.length === 0) return []
    const addedNames = new Set(changes.added.map(basename))
    return changes.deleted.filter(p => !addedNames.has(basename(p)) && !isDeletionExemptArtifact(p))
}

// ─────────────────────────────────────────────────────────────────────────────
// IGNORED-PATH CHANNEL
//
// The final-gate autofix greened `bun run seed` by writing DATABASE_URL and
// ADMIN_* into `/workspace/.env`, which `.gitignore:14` ignores. Everything
// above consumes `git status --porcelain`, which does not report ignored paths,
// so the edit was invisible to the diff capture, the deletion guard, the probe
// scan and the stranded-fix commit. The gate then certified a PASS that a fresh
// clone cannot reproduce: `.env` is not in the commit and `.env.example` never
// grew the ADMIN_* keys the seed requires.
//
// The rule is NOT to reject the write. A local `.env` is often the only way to
// make a check run at all, and rejecting it would leave the gate unable to test
// anything. What is illegitimate is the VERDICT: a PASS that depends on a file
// the repository does not contain is not an observation of the shipped product.
// So the write is recorded, carried as debt, and any gate PASS proven to depend
// on it is downgraded to UNOBSERVED (the verdict class settled in final-gate.ts
// unobservedVerdict: zero reproducible observation is UNOBSERVED, not PASS).
//
// EXEMPT BY MECHANISM, not by hope: build output and dependency trees are
// ignored too and a rule that fires on every `dist/` write is unusable. The real
// shape, measured over recorded child logs: gate children announce a few dozen
// writes, a minority to ignored paths, and nearly all of those are `.env` (the
// rest `node_modules`, from an install). Gate children do not hand-write build output; the
// COMMANDS they run do, and that never enters this channel because it is
// attributed by a before/after snapshot of the child's own window.
// ─────────────────────────────────────────────────────────────────────────────

/** Why an ignored path is (or is not) something the gate may rule on. */
export type IgnoredClass = 'build-output' | 'dep-dir' | 'task-dir' | 'vcs-meta' | 'actionable'

/**
 * Directory names that are build output or a dependency tree by convention. The
 * parsed outdirs (see classifyIgnoredPath's `outdirs`) come from the project's
 * own tooling and are the primary mechanism; this list is the fallback for
 * projects whose build is not declared in a package.json (CMake, cargo, gradle).
 */
const BUILD_DIR_NAMES = new Set([
    'node_modules',
    'dist',
    'build',
    'target',
    'out',
    'coverage',
    '.next',
    '.nuxt',
    '.svelte-kit',
    '.turbo',
    '.cache',
    '.parcel-cache',
    '.vite',
    '.gradle',
    '__pycache__',
    '.pytest_cache',
    '.venv',
    'venv'
])

/**
 * Classify one repo-relative ignored path. `outdirs` are build output directories
 * parsed from the project's own build commands. Only `actionable` may produce a
 * finding — everything else is reproducible from the repository by running the
 * project's own tooling, which is exactly what makes it not a gate concern.
 */
export function classifyIgnoredPath(rel: string, outdirs: string[]): IgnoredClass {
    const segs = rel
        .replace(/^\.\//, '')
        .split('/')
        .filter(s => s.length > 0)
    if (segs.length === 0) return 'actionable'
    if (segs.includes('.pi-tasks')) return 'task-dir'
    if (segs.includes('.git')) return 'vcs-meta'
    if (segs.includes('node_modules')) return 'dep-dir'
    for (const o of outdirs) {
        const oSegs = o
            .replace(/^\.\//, '')
            .split('/')
            .filter(s => s.length > 0)
        if (oSegs.length > 0 && oSegs.every((s, i) => segs[i] === s)) return 'build-output'
    }
    if (segs.some(s => BUILD_DIR_NAMES.has(s))) return 'build-output'
    return 'actionable'
}

/** The ignored paths a gate may rule on: everything not exempt by mechanism. */
export function findActionableIgnoredWrites(paths: string[], outdirs: string[]): string[] {
    return paths.filter(p => classifyIgnoredPath(p, outdirs) === 'actionable')
}

/**
 * A fingerprint per ignored path (`mtimeMs:size`, or a marker for a directory),
 * taken before and after a write-capable child so a write is ATTRIBUTED to that
 * child rather than to the tree's pre-existing state. Ignored files are untracked,
 * so git cannot tell "changed" from "was always there" — only the snapshot can.
 */
export type IgnoredSnapshot = Record<string, string>

/**
 * Paths whose fingerprint appeared or changed across the child's window. Pure, so
 * the attribution rule is unit-testable without a repo.
 */
export function diffIgnoredSnapshots(before: IgnoredSnapshot, after: IgnoredSnapshot): string[] {
    const out: string[] = []
    for (const [p, fp] of Object.entries(after)) {
        if (before[p] !== fp) out.push(p)
    }
    return out.sort()
}

/**
 * The gate-trail line. PATH NAMES ONLY: the contents of an ignored file are never
 * read into a log, a debt reason or a child prompt (`.env` is the canonical case —
 * this channel exists because of a file full of credentials).
 */
export function ignoredWriteTrailLine(paths: string[]): string {
    return (
        `final-gate: fix pass modified IGNORED path(s) — ${paths.join(', ')}; `
        + 'these are NOT committed and NOT reproducible from the repository'
    )
}

/**
 * The durable debt reason for the same event. Path names only, same rule.
 *
 * The wording tracks what was actually PROVEN. `dependent === true` is the probe's
 * answer that the gate does not pass without these files; `undefined` is an
 * unanswered probe (the attempt never converged, or the probe could not run), which
 * is still worth carrying because the file is on disk and can green a LATER attempt.
 * A debt that overstates its evidence is the same defect this whole channel exists
 * to fix, one level up.
 */
export function ignoredWriteDebtReason(paths: string[], dependent?: boolean): string {
    const head =
        dependent === true ?
            `final-gate PASS depended on gitignored file(s) the run wrote and cannot ship: ${paths.join(', ')}. `
            + 'A fresh clone does NOT have them, so the checks that passed here cannot be reproduced. '
        :   `the final-gate fix pass wrote gitignored file(s) that are NOT in the commit: ${paths.join(', ')}. `
            + 'Whether the gate needs them was not established, so a fresh clone may not reproduce this run. '
    return (
        head
        + 'The durable fix is a TRACKED counterpart (e.g. .env.example) or a check that '
        + 'does not need the file — never committing the ignored file itself.'
    )
}

/** The UNOBSERVED note that replaces such a PASS. Path names only, same rule. */
export function ignoredWriteUnobservedNote(paths: string[]): string {
    return (
        `UNOBSERVED — NOT a pass: the gate's checks passed only with gitignored file(s) `
        + `this run wrote (${paths.join(', ')}), which are not in the commit; re-running `
        + 'them without those files FAILS, so no reproducible evidence was produced.'
    )
}

/**
 * One-line summary for the gate debug log — the diff capture every write-capable
 * child gets so "what did this pass change" is answerable from artifacts (the
 * a `rm` left no trace outside the bash stream).
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
