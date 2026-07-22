/**
 * STAGE 2 SCORING — pure functions, no model time, no I/O.
 *
 * This file is deliberately SEPARATE from scripts/apis-trajectory.ts. The brief for this stage
 * says the primary metric must be scored with the committed `classifyQuery` UNCHANGED — a
 * predicate re-tuned after seeing the data it is applied to measures the tuning, not the data.
 * Keeping the new code out of that file makes "unchanged" a one-line `git diff` check rather
 * than a claim, so `classifyQuery` and the cue sets are IMPORTED here and never redefined.
 *
 * THE PRIMARY METRIC (decides the verdict): per rep, did worker:apis issue at least one
 * BEHAVIOUR-class PACKAGE docs query? Two halves, and both matter:
 *   BEHAVIOUR  classifyQuery says so — the committed cue set, fixed against a 2-rep smoke run
 *              before Stage 1 was scored.
 *   PACKAGE    `module !== '.'`. Project-source lookups are 66 of 127 queries and no external
 *              documentation lever can act on them at all; leaving them in the denominator
 *              would dilute the one population the lever can move.
 * Stage-1 baseline for exactly this metric: 2/15 reps = 13.3%, and 3/61 package queries = 4.9%.
 *
 * KNOWN WEAKNESS OF THE PREDICATE, restated here because the brief requires it to accompany
 * any result: of Stage 1's 29 "neither" queries, two are arguably behavioural ("how route
 * chaining works with hc", "how response looks after $fetch"). So the true behaviour rate over
 * that run is 3-5 of 127, not exactly 3. The conclusion does not turn on which end you take,
 * and the same predicate scores both arms, so the bias is common-mode.
 *
 * THE SECONDARY METRIC (reported, NEVER used to pass): did the rep call search or fetch at
 * all. It is a SECOND causal claim — more behaviour questions need not produce escalation,
 * because a behaviour question can still be answered out of the package text — so it gets its
 * own number and no arm is sized on it.
 *
 * THE OUTPUT-SIDE COUNTERS are what make the lever's effect visible in the artifact rather
 * than only in the trajectory: how many emitted entries actually carry a SEMANTICS field, and
 * how many of those are the honest `UNVERIFIED:` abstention. The abstention count is not a
 * defect counter — step 3 of the lever's fallback is mandatory — but it must be REPORTED,
 * because a treatment arm that fills every field with `UNVERIFIED:` has changed the format
 * and nothing else.
 */
import {classifyQuery, parseApisEntries, type ApisEntry} from './apis-trajectory.js'

/** The subset of a docs-sink record this module scores. Structural, so any sink row fits. */
export interface DocsQueryRecord {
    /** `.` for project source, else the package specifier. */
    module: string
    query: string
}

/** Is this a BEHAVIOUR-class question about an external package — the primary metric's unit? */
export function isBehaviourPackageQuery(rec: DocsQueryRecord): boolean {
    return rec.module !== '.' && classifyQuery(rec.query) === 'behaviour'
}

/** Package queries only, split by the committed classifier. The metric's denominator. */
export function packageQueryKinds(recs: DocsQueryRecord[]): {
    total: number
    behaviour: number
    signatureOnly: number
    neither: number
} {
    const pkg = recs.filter(r => r.module !== '.')
    return {
        total: pkg.length,
        behaviour: pkg.filter(r => classifyQuery(r.query) === 'behaviour').length,
        signatureOnly: pkg.filter(r => classifyQuery(r.query) === 'signature-only').length,
        neither: pkg.filter(r => classifyQuery(r.query) === 'neither').length
    }
}

/**
 * The marker the contract asks for. Tolerant on the separator (a weak model emits `-`, `--`,
 * `—` or nothing before it) and on case, because the metric is "did the worker produce a
 * semantics field", not "did it reproduce the punctuation". Anchored on the word SEMANTICS
 * followed by a colon so ordinary prose containing "semantics" does not score.
 */
const SEMANTICS_FIELD = /\bSEMANTICS\s*:/i

/** The mandatory step-3 abstention, in the form the contract specifies. */
const UNVERIFIED_FIELD = /\bSEMANTICS\s*:\s*UNVERIFIED\s*:/i

export interface SemanticsCounts {
    entries: number
    /** Entries carrying a SEMANTICS field at all. */
    withSemantics: number
    /** Of those, the honest `SEMANTICS: UNVERIFIED: <question>` abstention. */
    unverified: number
    /** Entries with a filled (non-UNVERIFIED) semantics clause. */
    answered: number
}

/**
 * Count semantics fields over an emitted APIS section.
 *
 * Scored over the WHOLE line, not the parsed `rest`: `parseApisEntries` splits the head off at
 * the first double-space/dash/colon separator, and the contract's own format puts the
 * semantics field after a dash — so scoring `rest` alone would work by accident today and
 * silently stop working the moment a model emits `name: sig — SEMANTICS: …`.
 */
export function countSemantics(section: string): SemanticsCounts {
    const lines = sectionLines(section)
    const withSemantics = lines.filter(l => SEMANTICS_FIELD.test(l))
    const unverified = withSemantics.filter(l => UNVERIFIED_FIELD.test(l))
    return {
        entries: parseApisEntries(section).length,
        withSemantics: withSemantics.length,
        unverified: unverified.length,
        answered: withSemantics.length - unverified.length
    }
}

/**
 * The raw non-empty lines of a section, in order. `parseApisEntries` is the entry COUNT
 * authority (invariant 1 is stated against its Stage-1 numbers); this is the text those
 * entries came from, kept intact for the regex counters above.
 */
export function sectionLines(section: string): string[] {
    return section
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0)
}

/** Entries as parsed, for callers that want both counters off one parse. */
export function entriesOf(section: string): ApisEntry[] {
    return parseApisEntries(section)
}

/**
 * Identifier-shaped tokens inside the SEMANTICS clauses of a section — the text the lever ADDS.
 *
 * WHY THIS IS A SEPARATE COUNTER FROM THE STAGE-1 GROUNDING TEST. `parseApisEntries` takes an
 * entry's NAME as the head of the line, and the Stage-1 ungrounded rate (2/588 = 0.3%) is
 * computed over those name symbols. The semantics clause lives in the REMAINDER of the line, so
 * it is not covered by that counter at all — which would leave the lever's own output field
 * outside the fabrication guard, and fabrication in exactly that field is what killed run 15.
 *
 * Same conservative bias as Stage 1: identifier-shaped tokens of length >= 3, no stop-list, so
 * ordinary English words in the clause ground against the prompt and can only push the
 * ungrounded rate DOWN. A finding that survives that bias is real.
 */
export function semanticsSymbols(section: string): string[] {
    const out: string[] = []
    for (const line of sectionLines(section)) {
        const m = /\bSEMANTICS\s*:/i.exec(line)
        if (!m) continue
        out.push(...(line.slice(m.index + m[0].length).match(/[$]?[A-Za-z_][A-Za-z0-9_$]{2,}/g) ?? []))
    }
    return [...new Set(out)]
}
