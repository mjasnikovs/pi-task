/**
 * verify-reconcile — deterministic reconciliation of a spec's VERIFY assertions
 * against the plan. Wired as the `plan-contradiction` critique probe.
 *
 * A sibling step's deliverable is a fact about the tree this task runs in, never
 * a valid absence target. A VERIFY line asserting it is missing is a guaranteed
 * run-end FAIL, and an automated fixer handed that FAIL can "resolve" it by
 * deleting the sibling's work. The defect has to die at spec time instead.
 *
 * Two shapes read as "this must be absent":
 *   - an `if` whose condition holds a POSITIVE existence probe (`[ -f P ]`,
 *     `test -e P`, `grep PAT …`) and whose body reaches `exit <nonzero>`;
 *   - a NEGATED probe anywhere else (`[ ! -f P ]`, `test ! -f P`,
 *     `! grep PAT …`), `|| exit`-guarded or standing alone.
 * `grep -v` / `--invert-match` is a filter, not a probe, and is skipped; so is
 * a target starting with `-` or `$`.
 *
 * A detected target is a CONFLICT when the plan pins it elsewhere:
 *   - 'disk'     — the path exists in the worktree at spec time;
 *   - 'sibling'  — a SIBLING task's title names it;
 *   - 'contract' — the cross-slice contract registry quotes it.
 * The three are checked independently, so one assertion can raise all three.
 *
 * Matching: pattern targets by case-insensitive substring; path targets by
 * full-path substring or a word-bounded basename. No similarity thresholds and
 * no all-words matching — all-words matches `bun:sql` against a "Bun SQL
 * connection" title, where substring does not.
 *
 * The finding is a PROBE, not a gate: it only forces the critique rewrite, and
 * `absenceProbeText` tells that rewrite to KEEP an absence check when the GOAL
 * explicitly deletes the artifact.
 */
import {parseVerifyBlock} from './spec-validation.js'

export interface AbsenceAssertion {
    /** The trimmed fragment the assertion was read out of: the whole VERIFY
     *  line, or only the condition when it came from an `if` header. */
    line: string
    /** The path or grep pattern asserted absent (quotes stripped). */
    target: string
    kind: 'path' | 'pattern'
}

/** A quoted or bare shell word. */
const SHELL_WORD = `"[^"]+"|'[^']+'|[^\\s\\]&|;)]+`

/**
 * A `-f`/`-e`/`-d` existence probe, with or without a leading `test`. The three
 * `(!?)` groups cover every place a negation can sit — before the `[`, inside
 * it, and before the flag — so the caller can tell `[ ! -f P ]` from `[ -f P ]`.
 */
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
 * All absence assertions in the spec's VERIFY block. An `if` line contributes
 * its condition's POSITIVE probes only when a LATER line reaches
 * `exit <nonzero>`: the body scan starts at the next command, so a one-line
 * `if …; then exit 1; fi` yields nothing. Every other line contributes its
 * NEGATED probes. Empty when the spec has no fenced VERIFY block.
 */
export function findAbsenceAssertions(spec: string): AbsenceAssertion[] {
    const cmds = parseVerifyBlock(spec)
    if (cmds === null) return []
    const lines = cmds.map(c => c.raw)
    const out: AbsenceAssertion[] = []
    for (let i = 0; i < lines.length; i++) {
        const ifm = /^if\s+(.+?)(?:;\s*then\b.*)?$/.exec(lines[i])
        if (ifm) {
            // Collect the block body up to the matching `fi`, counting nested
            // `if`s. A nested if is never scanned as a condition of its own —
            // its lines just extend the outer body, so an `exit 1` inside it
            // arms the OUTER condition.
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

/** Every absence assertion that collides with the plan. disk, sibling and
 *  contract are tested independently, so one assertion can yield three. */
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

/** The defect block handed to the critique rewrite. Self-contained: it names
 *  each conflict, why it is one, and the reconciliation to apply. */
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

/** Parse SIBLING titles out of `buildScopeFence`'s listing, whose rows read
 *  `[N] head` and `[N] (THIS STEP) head`. The "(THIS STEP)" row is dropped — a
 *  task may legitimately assert about its own deliverables. '' and undefined
 *  (a bare /task with no plan) yield none. */
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
