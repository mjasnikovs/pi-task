/**
 * prohibition-probe — deterministic detection of VIOLATED SPEC PROHIBITIONS,
 * feeding the verify gate's prompt.
 *
 * The failure class: the spec's CONSTRAINTS say "**Do NOT modify** any
 * server-side code: `src/server/index.ts`, …", the implementation modifies that
 * file anyway, and the verify child either waives the violation ("this is
 * additive, tests pass with it") or never looks. Nothing else in the gate makes it
 * run `git diff`, and rule 4b says it plainly: a forbidden file can be modified
 * without any test noticing.
 *
 * So — like the substitution probe (substitution-probe.ts) — the fix is a
 * pre-check whose finding is injected into the prompt: extract the concrete paths
 * the spec forbids modifying, intersect with the task's changed files (pure git
 * shape, from the same `collectChangedFiles` the substitution probe uses), and
 * hand the child each hit with the exact constraint wording.
 *
 * The finding is advisory, not an auto-FAIL, for one reason: prohibitions in
 * real specs are prose and can be CONDITIONAL ("Do NOT modify `api.ts` beyond
 * what is needed for the new endpoint") — a hard gate on prose extraction would
 * false-FAIL legitimate work. The finding therefore carries the constraint line
 * verbatim and the prompt's no-waiver rule (4b in verify-work.ts) forbids
 * excusing an ABSOLUTE prohibition while directing conditional ones to be judged
 * against their own stated exception. A violation fully reverted before verify
 * leaves no entry in `git diff HEAD`, so it never fires — reverted = not
 * violated.
 */
import type {ChangedFile} from './substitution-probe.js'

/** One "do not modify X" constraint extracted from the spec text. */
export interface Prohibition {
    /** The forbidden path exactly as the spec spells it (file or directory). */
    path: string
    /** The full spec line carrying the prohibition, so the verify child judges
     *  against the EXACT wording — including any exception clause it states. */
    constraint: string
}

/**
 * Does this line express a modification ban? Matches the active forms ("do not
 * modify", "must not touch", "never edit", "don't change") and the passive form
 * ("must not be modified"). Deliberately verb-scoped to modification — a "do not
 * add a dependency" style rule names no path and is the prompt rule's job.
 */
export const PROHIBITION_RE =
    /\b(?:do\s+not|don'?t|must\s+not|never)\s+(?:be\s+)?(?:modify|modified|touch|touched|edit|edited|change|changed|alter|altered|rewrite|rewritten|overwrite|overwritten|delete|deleted|remove|removed)\b/i

/**
 * A backtick token counts as a path only when it is whitespace-free, uses path
 * characters, and either contains a directory separator, has a file extension,
 * or is a dotfile. Bare identifiers (`getOrder`), API routes with spaces
 * (`POST /api/listings`), and code snippets are rejected — the probe would
 * rather miss a `Makefile` than fire on prose.
 */
function looksLikePath(token: string): boolean {
    if (!/^[\w.@~/-]+$/.test(token)) return false
    return token.includes('/') || /\.[A-Za-z0-9]+$/.test(token) || token.startsWith('.')
}

/**
 * Extract the concrete paths the spec explicitly forbids modifying: every
 * backtick-quoted path-like token on a line that expresses a modification ban.
 * Prose-only prohibitions ("do not modify server-side code" with no path named)
 * extract nothing — the prompt-level rule still covers them.
 */
export function extractProhibitions(spec: string): Prohibition[] {
    const out: Prohibition[] = []
    const seen = new Set<string>()
    for (const line of spec.split('\n')) {
        if (!PROHIBITION_RE.test(line)) continue
        for (const m of line.matchAll(/`([^`]+)`/g)) {
            const token = m[1].trim()
            if (!looksLikePath(token) || seen.has(token)) continue
            seen.add(token)
            out.push({path: token, constraint: line.trim()})
        }
    }
    return out
}

/** Normalise a path for comparison: strip leading ./ and trailing /. */
const norm = (p: string): string => p.replace(/^\.\//, '').replace(/\/+$/, '')

/**
 * Intersect the spec's prohibitions with the task's changed files (git shape —
 * the same collector the substitution probe uses). A prohibition matches a
 * changed file exactly, or as a directory prefix (`src/server` covers
 * `src/server/index.ts`). One finding line per violated file, carrying the
 * constraint verbatim; empty array → no block in the prompt.
 */
export function findProhibitionViolations(
    prohibitions: Prohibition[],
    files: ChangedFile[]
): string[] {
    const findings: string[] = []
    for (const f of files) {
        const fp = norm(f.path)
        const hit = prohibitions.find(p => {
            const pp = norm(p.path)
            return fp === pp || fp.startsWith(`${pp}/`)
        })
        if (!hit) continue
        findings.push(
            `${f.path} — modified by this task, but the spec forbids it: "${hit.constraint}"`
        )
    }
    return findings
}
