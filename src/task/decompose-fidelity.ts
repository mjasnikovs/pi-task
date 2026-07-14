/**
 * decompose-fidelity — verbatim fidelity of plan derivations (mx5 run 11, goal B).
 *
 * The failure this closes: the design's §12 milestone lines 2 and 4 end in
 * "guards + tests" / "contact + tests"; the decomposed titles carried everything
 * BUT the "+ tests" suffix. A title is ALL a per-task pipeline ever sees, so a
 * silently dropped constraint fragment vanishes from the whole run — the dropped
 * tests were exactly the instrument that would have caught the shipped 404 bug.
 * Decompose paraphrases freely and NOTHING compared a title to the spec line it
 * derives from.
 *
 * Mechanism (contracts.ts pattern, applied to decompose itself): the decompose
 * prompt asks each task line to cite its origin as a trailing
 * `[source: "<verbatim spec line>"]`. The host then:
 *   1. GROUNDS the quote — a citation that is not a (whitespace/case-normalised)
 *      substring of the source doc is fabricated and is stripped, never trusted;
 *   2. deterministically detects DROPPED ADDITIVE FRAGMENTS: the `+`-joined
 *      trailing constraints of the cited line ("… + tests") whose words are
 *      absent from the title;
 *   3. RE-ATTACHES the missing fragments to the title verbatim.
 *
 * Scope is deliberately the additive-suffix class (`+`-joined fragments): those
 * are constraints by construction, so re-attachment can never inject noise that
 * the cited line doesn't demand — worst case is redundancy with what the title
 * already says, never fabrication. Whole-line paraphrase drift is NOT judged here
 * (a title is a paraphrase by design); requirement-level coverage owns that.
 * No similarity thresholds anywhere: grounding is exact normalised substring,
 * presence is exact word membership (with a singular/plural `s` allowance).
 */
import {normalise} from './contracts.js'

/** Trailing `[source: "…"]` clause a decompose line may carry (prompt asks for it last). */
const SOURCE_RE = /\s*\[source:\s*"(.+)"\s*\]\s*$/i

export interface SourcedTitle {
    /** The title with any source clause stripped. */
    base: string
    /** The cited spec line, when present and grounded in the source doc. */
    source?: string
}

/** Split a decompose title into its base and its GROUNDED source citation.
 *  An absent clause yields no source; a fabricated (ungrounded) one is stripped
 *  and dropped — exactly like keepGroundedContracts rejects a paraphrased quote. */
export function extractTitleSource(title: string, sourceDoc: string): SourcedTitle {
    const m = SOURCE_RE.exec(title)
    if (!m) return {base: title.trim()}
    const base = title.slice(0, m.index).trim()
    const quote = m[1].trim()
    if (quote.length === 0 || !normalise(sourceDoc).includes(normalise(quote))) {
        return {base}
    }
    return {base, source: quote}
}

/** Word tokens for presence checks: alphanumeric runs, lowercased. */
function words(s: string): string[] {
    return s.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

/** Is every word of `fragment` present in `titleWords`? A bare trailing `s`
 *  difference (test/tests) does not count as absence — a rule, not a threshold. */
function fragmentPresent(fragment: string, titleWords: Set<string>): boolean {
    return words(fragment).every(w => {
        if (titleWords.has(w)) return true
        if (w.endsWith('s') && titleWords.has(w.slice(0, -1))) return true
        return titleWords.has(w + 's')
    })
}

/**
 * The `+`-joined trailing constraint fragments of `sourceLine` whose words are
 * absent from `title`. "2. **Auth** — sessions, login/logout/me, guards + tests."
 * yields the fragment "tests"; a title that never mentions tests gets it back.
 * Fragments before the first `+` are the task's body — a title paraphrases those
 * freely and they are never judged here. A `+`-part is further split on commas
 * ("+ Tailwind v4 tokens, nav, router" is three constraints), so a title missing
 * one of them gets ONLY that one restored, not the whole phrase (measured live:
 * whole-phrase restoration re-attached text the title already carried).
 */
export function findDroppedPlusFragments(sourceLine: string, title: string): string[] {
    const parts = sourceLine.split('+')
    if (parts.length < 2) return []
    const titleWords = new Set(words(title))
    const missing: string[] = []
    for (const raw of parts.slice(1)) {
        for (const sub of raw.split(',')) {
            // A fragment runs to the next `+`/comma; strip trailing sentence
            // punctuation and markdown emphasis so "tests.**" compares as "tests".
            const fragment = sub.replace(/[*_`]/g, '').replace(/[.,;:!?)\]]+\s*$/, '').trim()
            if (fragment.length === 0) continue
            if (words(fragment).length === 0) continue
            if (!fragmentPresent(fragment, titleWords)) missing.push(fragment)
        }
    }
    return missing
}

export interface TitleRestoration {
    /** Index into the reconciled titles array. */
    index: number
    /** The verbatim fragments re-attached to the title. */
    fragments: string[]
    /** The grounded source line they came from. */
    source: string
}

export interface ReconciledPlan {
    titles: string[]
    restored: TitleRestoration[]
    /** How many titles carried a GROUNDED source citation (adoption signal). */
    sourced: number
}

/**
 * Reconcile decompose output against the source doc: ground each citation, strip
 * the clause (its job ends here), and re-attach any dropped `+`-fragments to the
 * title verbatim so downstream refine/compose — which see ONLY the title — get
 * the constraint back. Titles without a citation pass through unchanged, so a
 * model that never cites degrades to exactly the old behavior.
 */
export function reconcileTitleSources(titles: string[], sourceDoc: string): ReconciledPlan {
    const out: string[] = []
    const restored: TitleRestoration[] = []
    let sourced = 0
    for (let i = 0; i < titles.length; i++) {
        const {base, source} = extractTitleSource(titles[i], sourceDoc)
        if (source === undefined) {
            out.push(base)
            continue
        }
        sourced++
        const missing = findDroppedPlusFragments(source, base)
        if (missing.length === 0) {
            out.push(base)
            continue
        }
        restored.push({index: i, fragments: missing, source})
        out.push(`${base} — MUST also cover (restored from its spec line): ${missing.join(', ')}`)
    }
    return {titles: out, restored, sourced}
}

/** The decompose-prompt rule that makes titles citable (the belt half; the host
 *  grounding + restoration above is the lever). Kept here so prompt and parser
 *  can't drift apart. */
export const DECOMPOSE_SOURCE_RULE =
    '- When a task derives from a specific line of the feature/spec (a milestone, a'
    + ' bullet, a requirement sentence), END that task\'s line with [source: "<that'
    + ' line copied VERBATIM>"]. Copy exactly — a paraphrased or invented quote is'
    + ' discarded host-side. Put the [source: …] clause after any [decisions: …]'
    + ' clause. When the cited line carries additive constraints ("+ tests",'
    + ' "+ docs"), those are PART of the task — keep them in the title itself.'
