/**
 * decompose-fidelity — verbatim fidelity of plan derivations.
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

/** One trailing `[source: "…"]` clause, anchored so it is the WHOLE remainder. */
const SOURCE_RE = /^\[source:\s*"([\s\S]*)"\s*\]$/i

/**
 * Markdown MARKUP dropped before grounding — emphasis runs, list and heading
 * markers, table pipes and CODE BACKTICKS. Not content: no word, number or
 * punctuation inside a sentence is touched, so this cannot make an invented
 * quote match.
 *
 * WHY. A model copies a spec line as it READS, and what it reads is rendered:
 * `2. **Auth** — sessions, login/logout/me, guards + tests.` comes back as
 * `Auth — sessions, login/logout/me, guards + tests.` That is a verbatim copy of
 * the line's TEXT, and the exact-substring test called it fabricated and threw
 * it away — including, as here, the "+ tests" line that is this module's own
 * worked example.
 *
 * BACKTICKS ARE THE SAME CLASS and were the larger half. A code span renders as
 * bare text, so `3. **Invites** — create/validate/redeem, \`/join/:token\` page.`
 * comes back as `Invites — create/validate/redeem, /join/:token page.` Screening
 * every spec line in its RENDERED form is what makes those quotes match at all.
 *
 * The two directions this has to hold in:
 *   FLOOR   a real spec line with ONE content word altered must NOT be grounded.
 *   CEILING a real spec line quoted without its markup MUST be grounded.
 */
function demark(s: string): string {
    return s
        .replace(/\*\*|__/g, '')
        .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')
        .replace(/^#+\s*/gm, '')
        .replace(/`/g, '')
        .replace(/\|/g, ' ')
}

/**
 * Undo the backslash-escaping a model applies to a quote it is putting INSIDE a
 * double-quoted clause. `[source: "… \`import { sql } from \\"bun\\"\` gotcha …"]`
 * is a faithful copy of a line the document stores with plain quotes; the
 * backslashes are an artefact of the delimiter, not content, and a real share of
 * otherwise-faithful quotes fail to match for this reason alone.
 * Only `\"` is undone — no other escape sequence is interpreted, so this
 * cannot rewrite a quote into something the document happens to contain.
 */
function unescapeQuotes(s: string): string {
    return s.replace(/\\"/g, '"')
}

export interface SourcedTitle {
    /** The title with every source clause stripped. */
    base: string
    /** The cited spec lines, in order, keeping only those GROUNDED in the doc. */
    sources: string[]
}

/**
 * Split a decompose title into its base and its GROUNDED source citations.
 *
 * PLURAL, because the model emits plural. The prompt asks for one trailing
 * citation and a quarter of real titles carry more — 62 of 244 across the 20
 * recorded runs. The old pattern was `\[source:\s*"(.+)"\]$`: greedy `.+`
 * against an end anchor, so on `[source: "A"] [source: "B"]` it matched from the
 * FIRST clause to the LAST quote and produced the superstring `A"] [source: "B`,
 * which of course is not in the document. Two real citations became one
 * fabricated one, and both were discarded. Peeling from the end with
 * lastIndexOf is the fix; a lazy quantifier is NOT, because leftmost-first
 * matching plus the `$` anchor expands it across the later clauses just the same.
 *
 * An absent clause yields no sources; a fabricated (ungrounded) one is dropped
 * — exactly like keepGroundedContracts rejects a paraphrased quote.
 */
export function extractTitleSource(title: string, sourceDoc: string): SourcedTitle {
    const ref = normalise(demark(sourceDoc))
    let base = title.trim()
    const sources: string[] = []
    for (;;) {
        const at = base.toLowerCase().lastIndexOf('[source:')
        if (at === -1) break
        const m = SOURCE_RE.exec(base.slice(at).trim())
        if (!m) break
        const quote = m[1].trim()
        base = base.slice(0, at).trim()
        if (quote.length > 0 && ref.includes(normalise(demark(unescapeQuotes(quote)))))
            sources.unshift(quote)
    }
    return {base, sources}
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
            const fragment = sub
                .replace(/[*_`]/g, '')
                .replace(/[.,;:!?)\]]+\s*$/, '')
                .trim()
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
    /** The grounded source lines they came from, in citation order. */
    sources: string[]
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
        const {base, sources} = extractTitleSource(titles[i], sourceDoc)
        if (sources.length === 0) {
            out.push(base)
            continue
        }
        sourced++
        // EVERY grounded citation is checked, not just the first. A title that
        // cites three spec lines can drop a constraint from any of them, and the
        // fragments are deduped because two cited lines routinely share one
        // ("+ tests" appears on four §12 milestones).
        const seen = new Set<string>()
        const missing: string[] = []
        for (const src of sources) {
            for (const f of findDroppedPlusFragments(src, base)) {
                const k = f.toLowerCase()
                if (seen.has(k)) continue
                seen.add(k)
                missing.push(f)
            }
        }
        if (missing.length === 0) {
            out.push(base)
            continue
        }
        restored.push({index: i, fragments: missing, sources})
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
