/**
 * verify-reconcile — deterministic reconciliation of a spec's VERIFY assertions
 * against the PLAN (mx5 run 11, goal D).
 *
 * The failure this closes: TASK_0009's composed spec carried
 *   `if [ -f src/client/pages/admin.tsx ] || grep -rn 'Admin' src/client/pages/ …; then … exit 1`
 * — a NEGATIVE EXISTENCE assertion on a SIBLING task's pinned deliverable
 * (TASK_0008 shipped the admin page; the design pins the admin routes). The
 * scope fence ("do NOT build other steps' work") leaked into the verify script
 * as "other steps' work must be ABSENT". Verify then correctly FAILed at run
 * end, the user accepted it as debt, and the final-gate autofix treated the
 * debt as an instruction and `rm`'d the sibling's deliverable.
 *
 * A sibling's deliverable is a CLAIM about the tree this task runs in — never a
 * valid absence target. The defect must die at SPEC time (a forced critique
 * rewrite, the skip-escape pattern), not surface as a run-end verify-FAIL.
 *
 * Detection is deterministic and shape-aware for how these specs actually write
 * absence checks (measured on the real run-11 artifacts):
 *   - `if <cond>; then … exit 1; fi` where <cond> contains a POSITIVE existence
 *     probe (`[ -f P ]`, `test -e P`, `grep PAT …`): P/PAT must be absent or the
 *     verify fails.
 *   - a standalone / `|| exit`-guarded NEGATED probe (`[ ! -f P ]`,
 *     `test ! -f P`, `! grep PAT …`): same meaning outside an if-header.
 * `grep -v` occurrences are filters, not probes, and are skipped.
 *
 * A detected absence target is a CONFLICT when the plan pins it elsewhere:
 *   - 'disk'     — the path already exists in the worktree at spec time (a
 *                  sibling shipped it; asserting its absence is a guaranteed
 *                  future FAIL);
 *   - 'sibling'  — a SIBLING task's title names it;
 *   - 'contract' — the cross-slice contract registry quotes it.
 * Matching: pattern targets by case-insensitive substring (all-words matching
 * false-fires on `bun:sql` vs a "Bun SQL connection" title); path targets by
 * full-path substring or a word-bounded basename. No similarity thresholds.
 *
 * The finding is a PROBE, not a gate: it forces the critique rewrite and names
 * the reconciliation (delete-tasks legitimately assert absence — the rewrite
 * keeps the check when the GOAL explicitly deletes the artifact).
 */
import {parseVerifyBlock} from './spec-validation.js'

export interface AbsenceAssertion {
    /** The verify line carrying the assertion (trimmed). */
    line: string
    /** The path or grep pattern asserted absent (quotes stripped). */
    target: string
    kind: 'path' | 'pattern'
}

/** A quoted or bare shell word. */
const SHELL_WORD = `"[^"]+"|'[^']+'|[^\\s\\]&|;)]+`

/** Positive existence probes: `-f P` / `-e P` / `-d P` not preceded by `!`. */
const EXIST_RE = new RegExp(
    `(!?)\\s*(?:\\[\\[?\\s*)?(!?)\\s*(?:test\\s+)?(!?)\\s*-[efd]\\s+(${SHELL_WORD})`,
    'g'
)

/** grep probes: optional leading `!`, flags, then the first pattern argument. */
const GREP_RE = new RegExp(`(!\\s+)?\\bgrep\\s+((?:-{1,2}[\\w=,.-]+\\s+)*)(${SHELL_WORD})`, 'g')

function stripQuotes(w: string): string {
    const m = /^"(.*)"$|^'(.*)'$/.exec(w)
    return m ? (m[1] ?? m[2] ?? '') : w
}

/** Extract absence assertions from one shell fragment.
 *  `positiveMeansAbsent` is true inside an `if …; then … exit 1` condition. */
function assertionsInFragment(fragment: string, positiveMeansAbsent: boolean): AbsenceAssertion[] {
    const out: AbsenceAssertion[] = []
    const line = fragment.trim()
    for (const m of line.matchAll(EXIST_RE)) {
        const negated = Boolean(m[1] || m[2] || m[3])
        const wantsAbsent = positiveMeansAbsent ? !negated : negated
        if (!wantsAbsent) continue
        const target = stripQuotes(m[4]).trim()
        if (target.length === 0 || target.startsWith('-') || target.startsWith('$')) continue
        out.push({line, target, kind: 'path'})
    }
    for (const m of line.matchAll(GREP_RE)) {
        const flags = m[2] ?? ''
        if (/(?:^|\s)-\w*v|--invert-match/.test(flags)) continue // a filter, not a probe
        const negated = Boolean(m[1])
        const wantsAbsent = positiveMeansAbsent ? !negated : negated
        if (!wantsAbsent) continue
        const target = stripQuotes(m[3]).trim()
        if (target.length === 0 || target.startsWith('-') || target.startsWith('$')) continue
        out.push({line, target, kind: 'pattern'})
    }
    return out
}

/**
 * All absence assertions in the spec's VERIFY block. Scans the fenced commands:
 * `if` blocks whose body reaches `exit <nonzero>` contribute their condition's
 * POSITIVE probes; other lines contribute their NEGATED probes.
 */
export function findAbsenceAssertions(spec: string): AbsenceAssertion[] {
    const cmds = parseVerifyBlock(spec)
    if (cmds === null) return []
    const lines = cmds.map(c => c.raw)
    const out: AbsenceAssertion[] = []
    for (let i = 0; i < lines.length; i++) {
        const ifm = /^if\s+(.+?)(?:;\s*then\b.*)?$/.exec(lines[i])
        if (ifm) {
            // Collect the block body up to the matching fi (flat scan — generated
            // VERIFY blocks don't nest ifs; a nested one just extends the body).
            let depth = 1
            let body = ''
            let j = i + 1
            for (; j < lines.length && depth > 0; j++) {
                if (/^if\b/.test(lines[j])) depth++
                if (/^fi\b/.test(lines[j])) depth--
                if (depth > 0) body += lines[j] + '\n'
            }
            if (/\bexit\s+[1-9]/.test(body)) {
                out.push(...assertionsInFragment(ifm[1], true))
            }
            i = j - 1
            continue
        }
        out.push(...assertionsInFragment(lines[i], false))
    }
    return out
}

export interface AbsenceConflict {
    assertion: AbsenceAssertion
    against: 'disk' | 'sibling' | 'contract'
    /** What it collided with (the sibling title / contract line / the path). */
    detail: string
}

export interface AbsenceConflictContext {
    /** Does this (repo-relative) path exist in the worktree right now? */
    fileExists: (path: string) => boolean
    /** SIBLING task titles only — never this task's own title. */
    siblingTitles: string[]
    /** The cross-slice contract registry text ('' when absent). */
    contracts: string
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** basename without extension: src/client/pages/admin.tsx → admin */
function basenameSansExt(p: string): string {
    const base = p.split('/').pop() ?? p
    const dot = base.lastIndexOf('.')
    return dot > 0 ? base.slice(0, dot) : base
}

/** Does `haystack` name this target? Patterns match by ci-substring; paths by
 *  full-path substring or word-bounded basename. */
function namesTarget(haystack: string, a: AbsenceAssertion): boolean {
    const h = haystack.toLowerCase()
    if (a.kind === 'pattern') return h.includes(a.target.toLowerCase())
    if (h.includes(a.target.toLowerCase())) return true
    const base = basenameSansExt(a.target)
    if (base.length === 0) return false
    return new RegExp(`\\b${escapeRe(base)}\\b`, 'i').test(haystack)
}

/** Absence assertions that collide with the plan: the deterministic D lever. */
export function findAbsenceConflicts(spec: string, ctx: AbsenceConflictContext): AbsenceConflict[] {
    const out: AbsenceConflict[] = []
    for (const a of findAbsenceAssertions(spec)) {
        if (a.kind === 'path' && ctx.fileExists(a.target)) {
            out.push({assertion: a, against: 'disk', detail: a.target})
        }
        for (const title of ctx.siblingTitles) {
            if (namesTarget(title, a)) {
                out.push({assertion: a, against: 'sibling', detail: title})
                break
            }
        }
        if (ctx.contracts.trim().length > 0) {
            const line = ctx.contracts.split('\n').find(l => namesTarget(l, a))
            if (line !== undefined) {
                out.push({assertion: a, against: 'contract', detail: line.trim()})
            }
        }
    }
    return out
}

/** The forced critique-rewrite defect text (skip-escape pattern: MANDATORY,
 *  self-contained, names the reconciliation). */
export function absenceProbeText(conflicts: AbsenceConflict[]): string {
    const what = {
        disk: 'ALREADY EXISTS in the worktree (a prior task shipped it)',
        sibling: "is a SIBLING task's deliverable",
        contract: 'is pinned by a cross-slice contract'
    } as const
    const items = conflicts.map(
        c =>
            `- VERIFY asserts \`${c.assertion.target}\` must be ABSENT (\`${c.assertion.line.slice(0, 120)}\`), `
            + `but it ${what[c.against]}: ${c.detail.slice(0, 160)}`
    )
    return [
        'PLAN-CONTRADICTION FINDING (deterministic; MUST be resolved, it overrides a CLEAN triage):',
        ...items,
        "A sibling step's deliverable is a FACT about the tree this task runs in, never a",
        "violation. The plan's scope fence forbids THIS task from BUILDING sibling work; it",
        'does not make sibling work absent. A check like this is guaranteed to FAIL at run',
        "end and misleads automated fixers into DELETING the sibling's shipped work.",
        "REWRITE each flagged check to assert THIS task's own deliverables (what it adds or",
        "changes). Keep an absence check ONLY if this task's GOAL explicitly deletes that",
        "exact artifact — then say so in the check's comment."
    ].join('\n')
}

/** Parse SIBLING titles out of the scope-fence text (buildScopeFence's listing),
 *  excluding the "(THIS STEP)" line — a task may legitimately assert about its
 *  own deliverables. '' / undefined (bare /task, no plan) yields none. */
export function siblingTitlesFromPlanContext(planContext: string | undefined): string[] {
    if (!planContext) return []
    const out: string[] = []
    for (const line of planContext.split('\n')) {
        const m = /^\[\d+\](.*)$/.exec(line.trim())
        if (!m) continue
        if (m[1].startsWith(' (THIS STEP)')) continue
        const title = m[1].trim()
        if (title.length > 0) out.push(title)
    }
    return out
}
