/**
 * contracts — a per-run registry of CROSS-SLICE INTERFACE FACTS, recorded once at
 * decompose time and read (never written) by every downstream slice.
 *
 * The failure this serves: a source design pins an interface contract that is not
 * uniform — say a split route table, `POST /api/listings/:id/photos` alongside
 * `GET/DELETE /api/photos/:id`. One slice's refine then FABRICATES the tidy version
 * it expected ("/api/photos → photosRoutes") with no anchor in the doc. Consumer
 * slices follow the spec, the assembly slice follows the fabrication, and the seam
 * between them ships broken while every slice is locally "right". The class is
 * refine synthesizing plausible interface specifics instead of citing them.
 *
 * Mechanism (mirrors env-notes.ts): interface facts that MORE THAN ONE task will
 * touch — endpoint paths, exported signatures, file layouts, env var names, whatever
 * the SOURCE DOC pins — are extracted ONCE (a decompose-time child EMITs `CONTRACT:`
 * lines) and appended HOST-SIDE to `.pi-tasks/contracts.md`. Children never write the
 * file (no artifact corruption). It lives under `.pi-tasks/`, surviving discardEdits
 * and the git-state guard.
 *
 * HARD DESIGN RULE: a registry entry is a VERBATIM QUOTE from the source doc plus a
 * source anchor — NEVER a model-synthesized summary. The anti-synthesis guard is
 * deterministic: a candidate quote is kept only if it is an actual substring of the
 * source document, normalised for whitespace and case. A quote the model
 * paraphrased or invented is not in the doc, so it is dropped.
 *
 * Run on the shape above: fed both real route lines AND the fabricated
 * "/api/photos → photosRoutes", the guard keeps the two that are in the doc and
 * drops the invention. Reflowed whitespace and different casing still match, so
 * quoting across a line wrap does not defeat it.
 *
 * Stack-agnostic: an "interface fact" is any pinned boundary string; the guard is
 * pure substring matching over the source text, with no assumption about its shape.
 */
import {makeLedger} from './ledger.js'

const CONTRACTS_FILE = 'contracts.md'
/** Cap kept entries so the injected block stays bounded on a large design. */
const MAX_CONTRACTS = 40
/** A single contract entry is one line; longer is prose, not a pinned fact. */
const MAX_CONTRACT_LENGTH = 300
/** A quote shorter than this is too generic to anchor a contract (and to match). */
const MIN_QUOTE_LENGTH = 6

export interface ContractEntry {
    /** The verbatim quote from the source doc — the pinned interface fact. */
    quote: string
    /** Where in the source it came from (a header, a section name) — free text. */
    anchor: string
}

/**
 * A stored line plus its dedupe key. The file is a list of formatted lines kept
 * VERBATIM (an existing line is never re-serialised); its key is the normalised
 * first quoted span, falling back to the whole line. A NEW entry carries the key
 * of its quote directly — the same value for every entry the parser can produce.
 */
interface ContractLine {
    line: string
    key: string
}

function lineKey(line: string): string {
    const q = /"([^"]+)"/.exec(line)
    return normalise(q ? q[1] : line)
}

const ledger = makeLedger<ContractLine>({
    file: CONTRACTS_FILE,
    max: MAX_CONTRACTS,
    key: c => c.key,
    serialize: c => c.line,
    parse: raw =>
        raw
            .split('\n')
            .filter(l => l.trim().length > 0)
            .map(line => ({line, key: lineKey(line)}))
})

export function contractsFile(cwd: string): string {
    return ledger.path(cwd)
}

/** The stored registry text ('' when none recorded yet). */
export async function readContracts(cwd: string): Promise<string> {
    return ledger.readRaw(cwd)
}

/**
 * Normalise for substring matching: collapse all whitespace runs to one space and
 * lowercase. Quoting across a line wrap or with reflowed spacing still matches the
 * source, and casing differences do not defeat the anti-synthesis guard.
 *
 * Exported as the ONE grounding normaliser every "verbatim quote from the source
 * doc" guard shares, so the rule cannot drift: decompose-fidelity and requirements
 * both import it from here alongside this module's own use.
 */
export function normalise(s: string): string {
    return s.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Parse `CONTRACT:` lines out of a child's answer text into entries. The line shape
 * the extraction prompt asks for is:
 *   CONTRACT: "<verbatim quote>" [anchor: <where>]
 * The quote (between the first pair of double quotes) is the pinned fact; the
 * optional `[anchor: …]` trailer records provenance. A line without a quoted span
 * is skipped — an unquoted "contract" is a summary, which this registry rejects —
 * and so is a quote shorter than MIN_QUOTE_LENGTH or longer than
 * MAX_CONTRACT_LENGTH. All three skips were run.
 */
export function parseContractLines(text: string): ContractEntry[] {
    const entries: ContractEntry[] = []
    for (const m of text.matchAll(/^[ \t]*CONTRACT:[ \t]*(.+)$/gim)) {
        const body = m[1].trim()
        const q = /"([^"]+)"/.exec(body)
        if (!q) continue
        const quote = q[1].trim()
        if (quote.length < MIN_QUOTE_LENGTH || quote.length > MAX_CONTRACT_LENGTH) continue
        const a = /\[anchor:\s*([^\]]+)\]/i.exec(body)
        entries.push({quote, anchor: a ? a[1].trim() : ''})
    }
    return entries
}

/**
 * THE ANTI-SYNTHESIS GUARD (the F3 defense): keep only entries whose quote actually
 * appears in the source document. A paraphrase or fabrication is not a substring of
 * the doc, so it is dropped — the registry cannot be poisoned with a synthesized
 * contract. Matching is whitespace-insensitive and case-insensitive so a faithful
 * quote across a line wrap still counts. Deduplicated (case-insensitive on the quote).
 */
export function keepGroundedContracts(
    entries: ContractEntry[],
    sourceDoc: string
): ContractEntry[] {
    const haystack = normalise(sourceDoc)
    const seen = new Set<string>()
    const kept: ContractEntry[] = []
    for (const e of entries) {
        const key = normalise(e.quote)
        if (key.length === 0 || seen.has(key)) continue
        if (!haystack.includes(key)) continue // fabricated / paraphrased ⇒ reject
        seen.add(key)
        kept.push(e)
    }
    return kept
}

/** Render one entry as a stored/displayed line. */
function formatEntry(e: ContractEntry): string {
    return e.anchor ? `"${e.quote}" [anchor: ${e.anchor}]` : `"${e.quote}"`
}

/**
 * Append grounded entries to the registry, deduplicated (case-insensitive on the
 * quote) against what is already stored, keeping the newest MAX_CONTRACTS. Failures
 * are swallowed — the registry is a sharpener, never a blocker.
 */
export async function appendContracts(cwd: string, entries: ContractEntry[]): Promise<void> {
    await ledger.append(
        cwd,
        entries.map(e => ({line: formatEntry(e), key: normalise(e.quote)}))
    )
}

/**
 * The read-only prompt block a downstream slice (refine/compose) receives when the
 * registry is non-empty. It is authoritative: these are the pinned cross-slice
 * contracts from the SOURCE doc, and a slice must not restate them differently.
 */
export function buildContractsBlock(contracts: string): string {
    if (contracts.trim().length === 0) return ''
    return [
        'CROSS-SLICE CONTRACTS — interface facts the SOURCE design pins and that more than',
        'one task touches (endpoint paths, exported signatures, file layouts, env var names).',
        'Each is a VERBATIM quote from the design; treat them as AUTHORITATIVE and BINDING:',
        ...contracts
            .trim()
            .split('\n')
            .map(l => `- ${l}`),
        'Your slice MUST match these exactly at its boundary. Do NOT invent, rename, reshape,',
        'or "tidy" a path/signature/layout/name that appears here — a difference between what',
        'your slice emits and a contract above is a SEAM BUG, even if your slice is internally',
        'consistent. If the design is silent on a boundary detail, leave it unspecified rather',
        'than fabricating a specific — do not add contracts of your own.',
        ''
    ].join('\n')
}

/**
 * The block the VERIFY child receives: the same registry, plus the mandate to check
 * the slice's actual boundary against it (F3 is a seam bug — locally right, globally
 * wrong — so per-slice verification must look at the boundary, not just the interior).
 */
export function buildContractsVerifyBlock(contracts: string): string {
    if (contracts.trim().length === 0) return ''
    return [
        'CROSS-SLICE CONTRACTS (verbatim from the source design; authoritative):',
        ...contracts
            .trim()
            .split('\n')
            .map(l => `- ${l}`),
        'These are boundaries MULTIPLE slices share. Check the shipped work at its boundary',
        'against them: does the code this task produced use each path/signature/layout/name',
        'EXACTLY as quoted? A slice that is internally consistent but wires a boundary',
        'differently from a contract above is a SEAM BUG — report FAIL naming the mismatch',
        '(what the code uses vs what the contract pins). Matching every contract it touches',
        'is part of the bar, not an extra.',
        ''
    ].join('\n')
}

/**
 * The full decompose-time extraction prompt: the design and the just-decomposed
 * task titles (so the child can judge which facts a boundary is SHARED on), plus
 * the emit instruction. Runs with --no-tools — pure extraction over text in hand.
 * The host re-grounds every emitted quote against the design (keepGroundedContracts),
 * so a hallucinated contract cannot survive even if the child fabricates one here.
 */
export const CONTRACT_EXTRACT_PROMPT = (feature: string, titles: string[]): string =>
    [
        'You are recording the CROSS-SLICE INTERFACE CONTRACTS for a feature that has just',
        'been split into the task list below. Each task will later be implemented by a',
        'SEPARATE pipeline that sees only its own title — so any interface fact TWO OR MORE',
        'of these tasks must agree on (a shared endpoint path, an exported signature, a file',
        'or module layout, an env var name, a wire/disk format) has to be pinned ONCE here,',
        'exactly as the design states it, or the slices will drift apart at the seam.',
        '',
        'TASK LIST (the slices that will share these boundaries):',
        ...titles.map((t, i) => `${i + 1}. ${t}`),
        '',
        'DESIGN (the ONLY source of truth — quote from it, never from your own knowledge):',
        feature.trim(),
        '',
        CONTRACT_EMIT_INSTRUCTION,
        '',
        'Output the CONTRACT: lines and nothing else. If the design pins no shared boundary,',
        'output nothing.'
    ].join('\n')

/** The emit instruction for the decompose-time extraction child. */
export const CONTRACT_EMIT_INSTRUCTION = [
    'CROSS-SLICE CONTRACTS — extract the interface facts that MORE THAN ONE task above will',
    'touch and that the design PINS: endpoint paths and methods, exported function/type',
    'signatures, file/module layout, env var names, on-disk or wire formats. For each, emit',
    '  CONTRACT: "<verbatim quote copied EXACTLY from the design>" [anchor: <section/header>]',
    'one per line. RULES: (1) the quoted text MUST be copied verbatim from the design — do',
    'NOT paraphrase, summarise, normalise, or complete it; a quote that is not a literal',
    'substring of the design is DISCARDED. (2) Only facts a boundary is shared on — skip',
    'anything a single task fully owns. (3) If the design does not pin a detail, do NOT invent',
    'one. Quotes only; never your own synthesis — a fabricated contract is exactly the bug',
    'this registry exists to prevent.'
].join('\n')
