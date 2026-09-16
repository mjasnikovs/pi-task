/**
 * spec-doc — ONE structured read of the source design document.
 *
 * The failure this closes: six host-side planning parsers each split the same
 * markdown their own way, over one flat string. `demark` ran for grounding and
 * was thrown away, so `findDroppedPlusFragments` re-cleaned the raw quote by a
 * different rule; requirement candidacy could not tell a sentence from a SQL
 * column or a router table's guard column. Live, that shipped task titles
 * carrying `check` (a `check (…)` constraint inside a DDL fence) and
 * `password) | public |` (two cells of a routing table) as restored spec
 * constraints, and promoted the document's one-line product description to a
 * requirement no task could ever own.
 *
 * A document is PREAMBLE (whatever sits above the first heading — where a spec
 * says what the thing IS) plus heading-delimited SECTIONS of BLOCKS. A block is
 * the smallest unit a quote can be grounded in and the smallest unit a policy can
 * exclude, and it carries its own `plain`: the text as a model READS it, which is
 * the single normalisation every grounding guard in the pipeline shares.
 *
 * Markdown-shaped but not markdown-dependent: a doc with no headings, no lists
 * and no tables parses to one paragraph block per paragraph, which is exactly the
 * flat-string behavior every consumer had before.
 */
import {normalise} from './contracts.js'

export type BlockKind = 'para' | 'list-item' | 'table-row' | 'fence' | 'quote'

export interface Block {
    kind: BlockKind
    /** The source lines, verbatim. */
    text: string
    /** `text` with markdown MARKUP removed — see `demark`. */
    plain: string
    /** 1-based line of the block's first line; the anchor a grounded quote records. */
    line: number
}

export interface Section {
    /** The heading text without its `#` run. */
    heading: string
    depth: number
    blocks: Block[]
}

export interface SpecDoc {
    /** Blocks above the first heading. Empty unless the doc has headings at all. */
    preamble: Block[]
    sections: Section[]
}

/**
 * Markdown MARKUP dropped before grounding — emphasis runs, list and heading
 * markers, blockquote markers, table pipes and CODE BACKTICKS. Not content: no
 * word, number or punctuation inside a sentence is touched, so this cannot make
 * an invented quote match.
 *
 * WHY. A model copies a spec line as it READS, and what it reads is rendered:
 * `2. **Auth** — sessions, login/logout/me, guards + tests.` comes back as
 * `Auth — sessions, login/logout/me, guards + tests.` That is a verbatim copy of
 * the line's TEXT, and the exact-substring test called it fabricated and threw
 * it away — including, as here, the "+ tests" line that is the restoration
 * module's own worked example.
 *
 * BACKTICKS ARE THE SAME CLASS and were the larger half. A code span renders as
 * bare text, so `3. **Invites** — create/validate/redeem, \`/join/:token\` page.`
 * comes back as `Invites — create/validate/redeem, /join/:token page.` Screening
 * every spec line in its RENDERED form is what makes those quotes match at all.
 *
 * The two directions this has to hold in, both run:
 *   FLOOR   a real spec line with ONE content word altered must NOT be grounded —
 *           changing `sessions` to `tokens`, or `redeem` to `revoke`, drops it.
 *   CEILING a real spec line quoted without its markup MUST be grounded — both the
 *           `2. **Auth** —` numbering-and-bold case and the backticked
 *           `` `/join/:token` `` case still match.
 */
export function demark(s: string): string {
    return s
        .replace(/\*\*|__/g, '')
        .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')
        .replace(/^\s*>\s?/gm, '')
        .replace(/^#+\s*/gm, '')
        .replace(/`/g, '')
        .replace(/\|/g, ' ')
}

const HEADING_RE = /^(#{1,6})\s+(\S.*?)\s*$/
const FENCE_RE = /^\s*(```+|~~~+)/
const TABLE_ROW_RE = /^\s*\|/
const BLOCKQUOTE_RE = /^\s*>/
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+\S/
/** A thematic break carries no text, so it is not a block of anything. */
const THEMATIC_BREAK_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/

/** The kinds a line OPENS on sight. `null` ⇒ prose, which continues whatever
 *  block is already open (markdown's lazy continuation) or opens a paragraph. */
function openingKind(line: string): BlockKind | null {
    if (TABLE_ROW_RE.test(line)) return 'table-row'
    if (BLOCKQUOTE_RE.test(line)) return 'quote'
    if (LIST_ITEM_RE.test(line)) return 'list-item'
    return null
}

export function parseSpecDoc(text: string): SpecDoc {
    const lines = text.replace(/\r\n?/g, '\n').split('\n')
    const doc: SpecDoc = {preamble: [], sections: []}
    let open: {kind: BlockKind; lines: string[]; line: number} | null = null
    const target = (): Block[] =>
        doc.sections.length > 0 ? doc.sections[doc.sections.length - 1].blocks : doc.preamble
    const emit = (kind: BlockKind, body: string[], line: number): void => {
        const t = body.join('\n')
        if (t.trim().length > 0) target().push({kind, text: t, plain: demark(t), line})
    }
    const close = (): void => {
        if (open) emit(open.kind, open.lines, open.line)
        open = null
    }
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i]
        const fence = FENCE_RE.exec(raw)
        if (fence) {
            close()
            const start = i + 1
            const body = [raw]
            // A fence runs to its closing marker or to EOF — an unclosed fence is
            // still one block, never a re-read of its contents as prose.
            while (i + 1 < lines.length) {
                body.push(lines[++i])
                if (lines[i].trimStart().startsWith(fence[1])) break
            }
            emit('fence', body, start)
            continue
        }
        const heading = HEADING_RE.exec(raw)
        if (heading) {
            close()
            doc.sections.push({heading: heading[2], depth: heading[1].length, blocks: []})
            continue
        }
        if (raw.trim().length === 0 || THEMATIC_BREAK_RE.test(raw)) {
            close()
            continue
        }
        const kind = openingKind(raw)
        if (kind === 'table-row') {
            close()
            emit('table-row', [raw], i + 1)
            continue
        }
        if (kind === 'quote' && open?.kind === 'quote') {
            open.lines.push(raw)
            continue
        }
        if (kind !== null) {
            close()
            open = {kind, lines: [raw], line: i + 1}
            continue
        }
        if (open === null) open = {kind: 'para', lines: [raw], line: i + 1}
        else open.lines.push(raw)
    }
    close()
    return doc
}

/** Every block, in document order. */
export function blocksOf(doc: SpecDoc): Block[] {
    return [...doc.preamble, ...doc.sections.flatMap(s => s.blocks)]
}

/**
 * The blocks above the first CONTENT section — where a spec says what the thing
 * IS rather than what the work must do.
 *
 * Two shapes, both real. A doc can open with prose and then head its sections; or
 * it can open with its TITLE as the only top-level heading and put the same prose
 * under it, which is what `# MX-5 Private — Project Design` does. A lone depth-1
 * heading above deeper ones is a title, not a section, so its body is preamble
 * too.
 *
 * A document with NO sections at all has no preamble: "preamble" means "above the
 * body", so without a body there is nothing to be above — otherwise a heading-less
 * prose spec would have its whole content excluded by any preamble policy.
 */
export function preambleOf(doc: SpecDoc): Block[] {
    const [first, ...rest] = doc.sections
    if (first === undefined) return []
    const titled = first.depth === 1 && rest.length > 0 && rest.every(s => s.depth > 1)
    return titled ? [...doc.preamble, ...first.blocks] : doc.preamble
}

/** A heading in `plain` form. Demarked as the LINE it was, `#` run included:
 *  without it demark reads the `11.` of "11. Security notes" as a list marker. */
function headingPlain(s: Section): string {
    return demark(`${'#'.repeat(s.depth)} ${s.heading}`)
}

/** Heading-delimited section texts in `plain` form, pre-normalised for
 *  containment tests. The preamble is its own leading section. */
export function sectionPlains(doc: SpecDoc): string[] {
    const out = [doc.preamble.map(b => b.plain).join('\n')]
    for (const s of doc.sections)
        out.push([headingPlain(s), ...s.blocks.map(b => b.plain)].join('\n'))
    return out.map(normalise).filter(s => s.length > 0)
}

/** The whole doc in `plain` form — the flat fallback for a quote that spans
 *  block boundaries (a model quoting two consecutive bullets as one line). */
export function specPlain(doc: SpecDoc): string {
    return [
        ...doc.preamble.map(b => b.plain),
        ...doc.sections.flatMap(s => [headingPlain(s), ...s.blocks.map(b => b.plain)])
    ].join('\n')
}

/**
 * The first block whose `plain` contains `quote`, both demarked and normalised —
 * the anchor a grounded quote records. `accept` narrows candidacy: a quote whose
 * only match lies outside it is NOT grounded, which is how a requirement policy
 * rejects a DDL column or a table cell the model quoted as an obligation.
 */
export function groundIn(
    doc: SpecDoc,
    quote: string,
    accept?: (b: Block) => boolean
): Block | null {
    const q = normalise(demark(quote))
    if (q.length === 0) return null
    for (const b of blocksOf(doc)) {
        if (accept && !accept(b)) continue
        if (normalise(b.plain).includes(q)) return b
    }
    return null
}
