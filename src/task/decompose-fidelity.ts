/**
 * decompose-fidelity — verbatim fidelity of plan derivations.
 *
 * The failure this closes: a design's milestone line ends in an additive
 * constraint — "… guards + tests" — and the decomposed title carries everything
 * BUT the "+ tests" suffix. A title is ALL a per-task pipeline ever sees, so a
 * silently dropped fragment vanishes from the whole run, and the dropped thing is
 * disproportionately the instrument that would have caught the bug. Decompose
 * paraphrases freely, and without this nothing compares a title to the spec line
 * it derives from.
 *
 * Mechanism (contracts.ts pattern, applied to decompose itself): the decompose
 * prompt asks each task line to cite its origin as a trailing
 * `[source: "<verbatim spec line>"]`. The host then:
 *   1. GROUNDS the quote in a BLOCK of the parsed spec doc — a citation that is
 *      not a (whitespace/case-normalised) substring is fabricated and is
 *      stripped, never trusted — and remembers which block it landed in;
 *   2. deterministically detects DROPPED ADDITIVE FRAGMENTS: the `+`-joined
 *      trailing constraints of the cited block ("… + tests") whose words are
 *      absent from the title;
 *   3. RE-ATTACHES the missing fragments to the title verbatim.
 *
 * Scope is deliberately the additive-suffix class (`+`-joined fragments): those
 * are constraints by construction, so re-attachment can never inject noise the
 * cited line does not demand — worst case is redundancy with what the title
 * already says, never fabrication. In practice not even that: a title that
 * already carries the fragment restores nothing, and the singular/plural
 * allowance means "a test" counts as covering "tests". Whole-line paraphrase drift is NOT judged here
 * (a title is a paraphrase by design); requirement-level coverage owns that.
 * No similarity thresholds anywhere: grounding is exact normalised substring,
 * presence is exact word membership (with a singular/plural `s` allowance).
 */
import {normalise} from './contracts.js'
import {
    demark,
    groundIn,
    parseSpecDoc,
    specPlain,
    type Block,
    type BlockKind,
    type SpecDoc
} from './spec-doc.js'

/** One trailing `[source: "…"]` clause, anchored so it is the WHOLE remainder. */
const SOURCE_RE = /^\[source:\s*"([\s\S]*)"\s*\]$/i

/**
 * Undo the backslash-escaping a model applies to a quote it is putting INSIDE a
 * double-quoted clause. `[source: "… \`import { sql } from \\"bun\\"\` gotcha …"]`
 * is a faithful copy of a line the document stores with plain quotes; the
 * backslashes are an artefact of the delimiter, not content, so without this an
 * otherwise-faithful quote fails to match for that reason alone.
 *
 * Only `\"` is undone — no other escape sequence is interpreted, so this cannot
 * rewrite a quote into something the document happens to contain. Confirmed both
 * ways: the escaped-quote citation grounds, and a citation carrying a literal
 * `\n` does not.
 */
function unescapeQuotes(s: string): string {
    return s.replace(/\\"/g, '"')
}

export interface GroundedSource {
    /** The citation as the model wrote it. */
    quote: string
    /** The document block it grounded in — null when it matches only ACROSS block
     *  boundaries (a model quoting two consecutive bullets as one line). */
    block: Block | null
}

export interface SourcedTitle {
    /** The title with every source clause stripped. */
    base: string
    /** The cited spec lines, in order, keeping only those GROUNDED in the doc. */
    sources: GroundedSource[]
}

/**
 * Split a decompose title into its base and its GROUNDED source citations.
 *
 * PLURAL, because the model emits plural: the prompt asks for one trailing
 * citation and a real share of titles carry more than one.
 *
 * A single anchored pattern cannot read them. Run on `[source: "A"] [source: "B"]`,
 * `\[source:\s*"(.+)"\]$` captures the superstring `A"] [source: "B` — from the
 * FIRST clause to the LAST quote — which is of course not in the document, so two
 * real citations become one fabricated one and both are discarded. Making the
 * quantifier LAZY changes nothing: `(.+?)` against the same input captures the
 * identical superstring, because leftmost-first matching plus the `$` anchor
 * expands it across the later clauses just the same. Peeling from the end with
 * lastIndexOf is what actually works — confirmed, both citations come back.
 *
 * An absent clause yields no sources; a fabricated (ungrounded) one is dropped
 * — exactly like keepGroundedContracts rejects a paraphrased quote.
 */
export function extractTitleSource(title: string, sourceDoc: string | SpecDoc): SourcedTitle {
    const doc = typeof sourceDoc === 'string' ? parseSpecDoc(sourceDoc) : sourceDoc
    const flat = normalise(specPlain(doc))
    let base = title.trim()
    const sources: GroundedSource[] = []
    for (;;) {
        const at = base.toLowerCase().lastIndexOf('[source:')
        if (at === -1) break
        const m = SOURCE_RE.exec(base.slice(at).trim())
        if (!m) break
        const quote = m[1].trim()
        base = base.slice(0, at).trim()
        if (quote.length === 0) continue
        const unescaped = unescapeQuotes(quote)
        const block = groundIn(doc, unescaped)
        if (block !== null) sources.unshift({quote, block})
        // A citation that spans two blocks is still a faithful copy of the doc, so
        // it stays grounded; it just has no single block to restore fragments from.
        else if (flat.includes(normalise(demark(unescaped)))) sources.unshift({quote, block: null})
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
 * An additive suffix is a PROSE construct. Inside a table row a `+` joins one
 * cell's own words while the row's other cells are unrelated columns; inside a
 * code fence it is code. Live, those two shapes restored `password) | public |`
 * (a router table's path, guard and its pipes) and `check` (the tail of a DDL
 * `check (…)` constraint) into task titles as spec obligations.
 */
const RESTORABLE_KINDS: ReadonlySet<BlockKind> = new Set<BlockKind>(['para', 'list-item'])

const BRACKET_PAIRS: ReadonlyArray<readonly [string, string]> = [
    ['(', ')'],
    ['[', ']'],
    ['{', '}']
]

function occurrences(s: string, ch: string): number {
    let n = 0
    for (const c of s) if (c === ch) n++
    return n
}

/** A fragment cut mid-expression: the cut is the defect, not the content. */
function isBalanced(s: string): boolean {
    return BRACKET_PAIRS.every(([open, close]) => occurrences(s, open) === occurrences(s, close))
}

/**
 * Split on the separators that sit at bracket depth ZERO. A `+` or a comma inside
 * a parenthetical belongs to the parenthetical — splitting there is what cut
 * `(unused + not expired)` into a fragment with a dangling `)`.
 *
 * A stray closer floors the depth at zero rather than driving it negative, so a
 * line whose brackets are already unbalanced still splits on its later separators.
 */
function splitAtDepth(s: string, separators: string): string[] {
    const out: string[] = []
    let depth = 0
    let start = 0
    for (let i = 0; i < s.length; i++) {
        const c = s[i]
        if (BRACKET_PAIRS.some(([open]) => open === c)) depth++
        else if (BRACKET_PAIRS.some(([, close]) => close === c)) depth = Math.max(0, depth - 1)
        else if (depth === 0 && separators.includes(c)) {
            out.push(s.slice(start, i))
            start = i + 1
        }
    }
    out.push(s.slice(start))
    return out
}

/**
 * The `+`-joined trailing constraint fragments of a spec block whose words are
 * absent from `title`. "2. **Auth** — sessions, login/logout/me, guards + tests."
 * yields the fragment "tests"; a title that never mentions tests gets it back.
 * Fragments before the first `+` are the task's body — a title paraphrases those
 * freely and they are never judged here. A `+`-part is further split on commas
 * ("+ Tailwind v4 tokens, nav, router" is three constraints), so a title missing
 * one of them gets ONLY that one restored, not the whole phrase (measured live:
 * whole-phrase restoration re-attached text the title already carried).
 *
 * A bare string is read as prose — the shape a caller that has no document has.
 */
export function findDroppedPlusFragments(source: Block | string, title: string): string[] {
    const block: Block =
        typeof source === 'string' ?
            {kind: 'para', text: source, plain: demark(source), line: 0}
        :   source
    if (!RESTORABLE_KINDS.has(block.kind)) return []
    const parts = splitAtDepth(block.plain, '+')
    if (parts.length < 2) return []
    const titleWords = new Set(words(title))
    const missing: string[] = []
    for (const raw of parts.slice(1)) {
        for (const sub of splitAtDepth(raw, ',')) {
            // Trailing sentence punctuation is the line's, not the fragment's;
            // brackets are left alone because they are what the balance test reads.
            const fragment = sub.replace(/[.,;:!?]+\s*$/, '').trim()
            if (words(fragment).length === 0) continue
            if (!isBalanced(fragment)) continue
            if (!fragmentPresent(fragment, titleWords)) missing.push(fragment)
        }
    }
    return missing
}

/** Restored fragments as a DELIMITED list. A bare `join(', ')` is ambiguous the
 *  moment a fragment contains a comma of its own — and they routinely do. */
export function renderFragments(fragments: string[]): string {
    return fragments.map(f => `"${f}"`).join('; ')
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
    const doc = parseSpecDoc(sourceDoc)
    const out: string[] = []
    const restored: TitleRestoration[] = []
    let sourced = 0
    for (let i = 0; i < titles.length; i++) {
        const {base, sources} = extractTitleSource(titles[i], doc)
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
            if (src.block === null) continue
            for (const f of findDroppedPlusFragments(src.block, base)) {
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
        restored.push({index: i, fragments: missing, sources: sources.map(s => s.quote)})
        out.push(
            `${base} — MUST also cover (restored from its spec line): ${renderFragments(missing)}`
        )
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
