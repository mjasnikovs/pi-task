/**
 * suppression-probe — deterministic detection of a task that reached green by
 * WIDENING SUPPRESSIONS rather than by fixing what the checker found.
 *
 * TASK_0034 shipped sixteen of them in one file — one blanket `eslint-disable`
 * header and fifteen `@ts-expect-error` lines — and every gate reported success.
 * Nothing named it, because nothing was looking: the checks were green, which is
 * exactly what a suppression buys. The verify child cannot discover this by
 * running the project's commands for the same reason.
 *
 * So it is a diff question, not a check question. The probe counts each pattern's
 * matching lines the task ADDED and subtracts the ones it REMOVED, per file: a
 * refactor that deletes three `@ts-ignore`s and adds one is net -2 and silent,
 * while a file that gained one is a finding. Net, not absolute, because a task
 * that legitimately moves code would otherwise be accused of writing what it only
 * relocated.
 *
 * The registry is DATA, and deliberately cross-ecosystem — a suppression exists
 * for every checker, and a TypeScript-only list would have made this a TypeScript
 * feature. Projects add their own through the `suppressionPatterns` config.
 */
import type {EcosystemId} from '../workers/docs-ecosystems.js'

/** One suppression spelling. `ecosystems` narrows a row to the projects where it
 *  means what it says; absent ⇒ it applies everywhere. */
export interface SuppressionPattern {
    id: string
    re: RegExp
    ecosystems?: EcosystemId[]
}

/**
 * The shipped rows. Each `re` is a LINE test, so a pattern that appears inside a
 * string literal or a comment still counts — the point is the suppression's
 * presence in the shipped file, and deciding what is "really" a suppression would
 * need a parser per language to answer worse.
 */
export const SUPPRESSION_PATTERNS: readonly SuppressionPattern[] = [
    {id: '@ts-expect-error', re: /@ts-expect-error/, ecosystems: ['npm']},
    {id: '@ts-ignore', re: /@ts-ignore/, ecosystems: ['npm']},
    {id: 'eslint-disable', re: /eslint-disable/, ecosystems: ['npm']},
    {id: 'as unknown as', re: /\bas\s+unknown\s+as\b/, ecosystems: ['npm']},
    {id: '#[allow(', re: /#\[allow\(/, ecosystems: ['cargo']},
    {id: '# noqa', re: /#\s*noqa\b/i},
    {id: '# type: ignore', re: /#\s*type:\s*ignore\b/},
    {id: '//nolint', re: /\/\/\s*nolint\b/, ecosystems: ['go']},
    {id: '@SuppressWarnings', re: /@SuppressWarnings\b/},
    {id: '#pragma warning disable', re: /#pragma\s+warning\s+disable\b/}
]

/** One diff line the probe reads: which side of the diff it is on, and where. */
export interface DiffLine {
    path: string
    text: string
    added: boolean
}

/** A file that gained suppressions, with the net count per pattern. */
export interface SuppressionHit {
    path: string
    patternId: string
    /** Added matching lines minus removed ones. Always positive — a net-zero or
     *  net-negative pattern is not a widening and is not reported. */
    net: number
}

/**
 * Compile the extra patterns a project configures. An unparseable source is
 * dropped rather than thrown: a hand-edited config may not break the gate, and a
 * pattern nobody can compile finds nothing either way.
 */
export function compileSuppressionPatterns(sources: readonly string[]): SuppressionPattern[] {
    const out: SuppressionPattern[] = []
    for (const source of sources) {
        try {
            out.push({id: source, re: new RegExp(source)})
        } catch {
            // an invalid regex is a config defect, not a gate failure
        }
    }
    return out
}

/** The rows in force for a project: the shipped ones its ecosystems claim, plus
 *  every configured one (a user pattern is never ecosystem-gated — they wrote it
 *  for this repo). */
export function suppressionPatternsFor(
    ecosystems: readonly EcosystemId[],
    extra: readonly SuppressionPattern[] = []
): SuppressionPattern[] {
    const shipped = SUPPRESSION_PATTERNS.filter(
        p =>
            !p.ecosystems
            || ecosystems.length === 0
            || p.ecosystems.some(e => ecosystems.includes(e))
    )
    return [...shipped, ...extra]
}

/**
 * Net-new suppressions per file and pattern, in a stable order (file, then
 * registry order) so two runs over the same diff produce the same findings.
 */
export function findSuppressionWidening(
    lines: readonly DiffLine[],
    patterns: readonly SuppressionPattern[] = SUPPRESSION_PATTERNS
): SuppressionHit[] {
    // Keyed by path then pattern rather than by a joined string: any separator
    // would have to be a character no path can contain, and `\0` — the honest
    // choice — is a byte prettier rewrites and plain grep cannot see.
    const byPath = new Map<string, Map<string, SuppressionHit>>()
    const hits: SuppressionHit[] = []
    for (const line of lines) {
        for (const pattern of patterns) {
            if (!pattern.re.test(line.text)) continue
            let byPattern = byPath.get(line.path)
            if (!byPattern) {
                byPattern = new Map()
                byPath.set(line.path, byPattern)
            }
            let hit = byPattern.get(pattern.id)
            if (!hit) {
                hit = {path: line.path, patternId: pattern.id, net: 0}
                byPattern.set(pattern.id, hit)
                hits.push(hit)
            }
            hit.net += line.added ? 1 : -1
        }
    }
    return hits.filter(h => h.net > 0).sort((a, b) => a.path.localeCompare(b.path))
}

/** The verify prompt's finding lines for the suppression-widening row. */
export function suppressionVerifyFindings(hits: readonly SuppressionHit[]): string[] {
    return hits.map(
        h =>
            `${h.path} — ${h.net} net-new \`${h.patternId}\` line${h.net === 1 ? '' : 's'} added by this task`
    )
}
