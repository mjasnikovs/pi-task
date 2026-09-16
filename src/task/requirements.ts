/**
 * requirements — requirement-level coverage accounting for /task-auto planning.
 *
 * The failure this closes: a single holistic coverage question ("do these tasks
 * cover the whole feature?") is answerable YES by any task list that mirrors the
 * spec's own milestone headings. Such a list is structurally parity-complete, so
 * the sections that are NOT milestones — a Testing section demanding a test
 * script, a test database, a test directory — can produce zero tasks and zero
 * per-task injection while the judge still says COMPLETE.
 *
 * Mechanism (spec-shape-agnostic, contracts.ts pattern):
 *   1. EXTRACT requirement units as VERBATIM quotes from whatever structure the
 *      spec has (headings, bullets, prose) — each host-GROUNDED by the
 *      normalised-substring guard against a CANDIDATE block (`RequirementPolicy`),
 *      so neither a fabricated requirement nor a DDL column can enter.
 *   2. MAP each grounded requirement against the task list (a per-requirement
 *      verdict: TASK n / CROSS-CUTTING / NONE). Completeness is then computed
 *      HOST-SIDE from the map — a blanket "COMPLETE" is structurally impossible
 *      because the model must commit to a falsifiable claim per requirement.
 *   3. CARRY what tasks don't own: cross-cutting requirements (methodology,
 *      quality bars) are appended to `.pi-tasks/requirements.md` and injected
 *      VERBATIM into every task's refine/compose (the REFINE_PRESERVE_DIRECTIVE
 *      pattern: content travels, not a pointer); requirements still unmapped
 *      after the retry rounds are recorded user-visibly, never silently dropped.
 *
 * A mandated verification methodology rides the same channel: when the spec says
 * "a test lands in the same change as each new route", that quote is exactly what
 * gets injected, and compose's VERIFY rules fold it into every applicable task's
 * runnable verification.
 */
import {normalise} from './contracts.js'
import {makeLedger} from './ledger.js'
import {
    blocksOf,
    demark,
    groundIn,
    parseSpecDoc,
    preambleOf,
    sectionPlains,
    type Block,
    type BlockKind,
    type SpecDoc
} from './spec-doc.js'

const REQUIREMENTS_FILE = 'requirements.md'
/** Cap kept entries so the injected block stays bounded on a large design. */
const MAX_REQUIREMENTS = 40
/** One line each; longer is prose, not a requirement statement. */
const MAX_REQUIREMENT_LENGTH = 300
/** Too short to state an obligation (and to ground unambiguously). */
const MIN_QUOTE_LENGTH = 6
/** The checklist rides into the extraction prompt, so it stays readable. */
const MAX_OBLIGATION_PASSAGES = 20

export interface RequirementEntry {
    /** The verbatim quote from the source doc — the obligation. */
    quote: string
    /** Where it came from (heading/section, or 'prose'). Model-authored. */
    anchor: string
    /** 1-based source line of the block it grounded in — the HOST's anchor. */
    line?: number
    /** Grounded above the first heading, where a doc says what the thing IS. */
    preamble?: boolean
}

/**
 * Which blocks may carry a requirement.
 *
 * The model still proposes whatever it likes; this decides what GROUNDING will
 * accept. A fenced block is code or a file tree, and a table row is a grid of
 * columns whose cells only read as a sentence by accident — both produced
 * "requirements" like a DDL column definition or a router-table guard cell,
 * which no task can own and which then held the coverage verdict INCOMPLETE.
 */
export interface RequirementPolicy {
    candidateKinds: ReadonlySet<BlockKind>
    excludePreamble: boolean
}

export const REQUIREMENT_POLICY: RequirementPolicy = {
    candidateKinds: new Set<BlockKind>(['para', 'list-item', 'quote']),
    excludePreamble: true
}

function candidates(doc: SpecDoc, policy: RequirementPolicy): (b: Block) => boolean {
    const excluded = policy.excludePreamble ? new Set(preambleOf(doc)) : new Set<Block>()
    return b => policy.candidateKinds.has(b.kind) && !excluded.has(b)
}

/**
 * A stored carried-requirements line plus its dedupe key (mirrors contracts.ts:
 * lines are kept VERBATIM, keyed on the normalised first quoted span — whole line
 * when there is none; a NEW entry carries the key of its quote directly).
 */
interface CarriedLine {
    line: string
    key: string
}

function carriedLineKey(line: string): string {
    const q = /"([^"]+)"/.exec(line)
    return normalise(q ? q[1] : line)
}

const carried = makeLedger<CarriedLine>({
    file: REQUIREMENTS_FILE,
    max: MAX_REQUIREMENTS,
    key: c => c.key,
    serialize: c => c.line,
    parse: raw =>
        raw
            .split('\n')
            .filter(l => l.trim().length > 0)
            .map(line => ({line, key: carriedLineKey(line)}))
})

export function requirementsFile(cwd: string): string {
    return carried.path(cwd)
}

/** Parse `REQUIREMENT: "<quote>" [anchor: …]` lines (mirrors parseContractLines). */
export function parseRequirementLines(text: string): RequirementEntry[] {
    const entries: RequirementEntry[] = []
    for (const m of text.matchAll(/^[ \t]*REQUIREMENT:[ \t]*(.+)$/gim)) {
        const body = m[1].trim()
        const q = /"([^"]+)"/.exec(body)
        if (!q) continue
        const quote = q[1].trim()
        if (quote.length < MIN_QUOTE_LENGTH || quote.length > MAX_REQUIREMENT_LENGTH) continue
        const a = /\[anchor:\s*([^\]]+)\]/i.exec(body)
        entries.push({quote, anchor: a ? a[1].trim() : ''})
    }
    return entries
}

/** THE ANTI-SYNTHESIS GUARD: keep only entries whose quote grounds in a CANDIDATE
 *  block of the source doc (same rule as keepGroundedContracts, narrowed by the
 *  policy). A quote whose only match lies in an excluded block is dropped — the
 *  model is free to propose it, the document decides. Does NOT cap — capping is
 *  capRequirements' job, which protects obligation-marked passages from doc-order
 *  truncation. */
export function keepGroundedRequirements(
    entries: RequirementEntry[],
    sourceDoc: string | SpecDoc,
    policy: RequirementPolicy = REQUIREMENT_POLICY
): RequirementEntry[] {
    const doc = typeof sourceDoc === 'string' ? parseSpecDoc(sourceDoc) : sourceDoc
    const accept = candidates(doc, policy)
    const preamble = new Set(preambleOf(doc))
    const seen = new Set<string>()
    const kept: RequirementEntry[] = []
    for (const e of entries) {
        const key = normalise(demark(e.quote))
        if (key.length === 0 || seen.has(key)) continue
        const block = groundIn(doc, e.quote, accept)
        if (block === null) continue
        seen.add(key)
        kept.push({...e, line: block.line, preamble: preamble.has(block)})
    }
    return kept
}

/**
 * Bound the list WITHOUT doc-order truncation. An extractor that works top-down
 * yields more entries than the cap from the doc's early sections alone, so a
 * plain first-N cap drops the TAIL sections wholesale — and a spec keeps its
 * testing and deployment obligations at the end. "Given order" as the tie-break
 * re-creates the same bias one level up.
 *
 * Rule (deterministic priority, not a knob): entries quoting an obligation-
 * marked passage survive first; the remaining budget is filled ROUND-ROBIN
 * across the source doc's sections (each section's entries in doc order), so
 * every section keeps its head obligations and no section is wholesale dropped.
 * Bucketing is by the quote's POSITION in the source doc — grounded substring,
 * never the model-authored anchor text. Without `sourceDoc` (or for quotes that
 * cannot be located) the fill degrades to the old given-order behavior.
 */
export function capRequirements(
    entries: RequirementEntry[],
    passages: string[],
    sourceDoc?: string,
    /** `false` skips the low-value deprioritisation, so a caller can compare the
     *  two fills without transcribing sectionFairFill. Production never passes it
     *  — auto-orchestrator.ts calls this with three arguments. */
    deprioritiseLowValue = true
): RequirementEntry[] {
    if (entries.length <= MAX_REQUIREMENTS) return entries
    const norms = passages.map(p => normalise(demark(p)))
    const covers = (e: RequirementEntry): boolean => {
        const q = normalise(demark(e.quote))
        return norms.some(p => p.includes(q))
    }
    const marked = entries.filter(covers)
    const rest = entries.filter(e => !covers(e))
    const budget = MAX_REQUIREMENTS - Math.min(marked.length, MAX_REQUIREMENTS)
    // The low-value filter applies to the UNMARKED remainder only. Quoting an
    // obligation-marked passage is the pipeline's existing, validated evidence
    // that a quote states an obligation, and it outranks any lexical heuristic:
    // "MUST log every request" is 22 characters and every length-based rule reads
    // it as a fragment. Filtering ahead of the marked/rest split deleted it.
    //
    // The ordering only matters for specs whose obligations are SHORT; it is not
    // what makes tail coverage hold. That is sectionFairFill below.
    const pool = deprioritiseLowValue ? budgetedByObligation(rest, budget, sourceDoc) : rest
    return [...marked.slice(0, MAX_REQUIREMENTS), ...sectionFairFill(pool, budget, sourceDoc)]
}

/** Longest a dependency-pin row can be before it is presumed to carry an
 *  obligation after the pin. A bare pin is short; a pin-prefixed line that DOES
 *  obligate ("TypeScript `6.0.3` — one strict `tsconfig.json`: `strict`,
 *  `noUncheckedIndexedAccess`, …") is several times longer. */
const MAX_PIN_LENGTH = 80

/** Cut mid-expression: an unbalanced fence or bracket, or a trailing separator.
 *  NOT `;` — a complete clause legitimately ends with one, and dropping on `;`
 *  would discard a runnable line like `lint` = `prettier … && eslint … && tsc
 *  --noEmit`. */
function isTruncatedQuote(q: string): boolean {
    if ((q.match(/`/g) ?? []).length % 2 === 1) return true
    for (const [open, close] of [
        ['(', ')'],
        ['[', ']'],
        ['{', '}']
    ]) {
        const o = (q.match(new RegExp(`\\${open}`, 'g')) ?? []).length
        const c = (q.match(new RegExp(`\\${close}`, 'g')) ?? []).length
        if (o > c) return true
    }
    return /[,:([{]\s*$/.test(q.trim())
}

/** A bare version row — data, not an obligation. Length-gated, see MAX_PIN_LENGTH. */
function isDependencyPin(q: string): boolean {
    const t = q.trim().replace(/^\*\*|\*\*$/g, '')
    if (t.length > MAX_PIN_LENGTH) return false
    return /^\**[`*]?[\w@/-]+[`*]?\**\s*[`']?\d+\.\d+/.test(t)
}

/** A DDL/schema row: `col type …`. */
function isSchemaRow(q: string): boolean {
    return /^\s*[\w_]+\s+(?:uuid|text|int|integer|bigint|boolean|timestamptz|bytea|jsonb|numeric|smallint)\b/i.test(
        q
    )
}

/** Too short to state an obligation. MIN_QUOTE_LENGTH (6) admits "Contact
 *  seller"; a clause needs a subject and a predicate. */
function isQuoteFragment(q: string): boolean {
    const t = q.trim()
    return t.length < 25 || t.split(/\s+/).length < 4
}

/**
 * Quotes that pass the grounding guard (verbatim substring of the doc) but state
 * no obligation. There is no obligation test anywhere else in the pipeline —
 * `keepGroundedRequirements` only checks the quote really appears in the source,
 * so any sentence at all survives it and precision rests entirely on the model.
 */
export function isLowValueQuote(quote: string): boolean {
    return (
        isTruncatedQuote(quote)
        || isDependencyPin(quote)
        || isSchemaRow(quote)
        || isQuoteFragment(quote)
    )
}

/**
 * Deprioritise obligation-free quotes, but only as far as the BUDGET requires.
 *
 * The extractor's single-pass yield swings wildly for byte-identical input, and
 * the padding crowds real obligations out of the fixed number that ship — a
 * high-yield run lands FEWER critical obligations than a low-yield one.
 * Deprioritising the obligation-free quotes reverses that.
 *
 * BUDGETED, not absolute. Below the cap no slot is contested, so dropping there
 * destroys information and buys nothing — a filter that runs unconditionally can
 * leave slots empty while discarding the only carrier of a real obligation the
 * lexical rules misread. So the low-value entries come back in source-doc order
 * until the list reaches the cap.
 *
 * Doc order for the restore is the neutral choice: which entries return only
 * matters when more were dropped than there are free slots, and ordering by
 * anything else would fit the rule to one spec.
 */
function budgetedByObligation(
    entries: RequirementEntry[],
    budget: number,
    sourceDoc?: string
): RequirementEntry[] {
    const keep = entries.filter(e => !isLowValueQuote(e.quote))
    if (keep.length >= budget) return keep
    const at = (e: RequirementEntry): number => {
        if (!sourceDoc) return Number.MAX_SAFE_INTEGER
        const i = sourceDoc.indexOf(e.quote.trim())
        return i < 0 ? Number.MAX_SAFE_INTEGER : i
    }
    const restored = entries
        .filter(e => isLowValueQuote(e.quote))
        .map((e, given) => ({e, at: at(e), given}))
        .sort((x, y) => x.at - y.at || x.given - y.given)
        .slice(0, budget - keep.length)
        .map(x => x.e)
    return [...keep, ...restored]
}

/** Round-robin fill across doc sections: bucket each entry by the FIRST section
 *  whose normalised text contains its quote (the same containment rule that
 *  grounded it), take each bucket's entries in in-section order, one per bucket
 *  per round. Entries that cannot be located (or no doc) go to a trailing
 *  bucket in given order — the pre-behavior, never worse. */
function sectionFairFill(
    entries: RequirementEntry[],
    budget: number,
    sourceDoc?: string
): RequirementEntry[] {
    if (budget <= 0) return []
    if (!sourceDoc) return entries.slice(0, budget)
    const sections = sectionPlains(parseSpecDoc(sourceDoc))
    const buckets = new Map<number, Array<{e: RequirementEntry; at: number}>>()
    entries.forEach((e, given) => {
        const q = normalise(demark(e.quote))
        let b = sections.findIndex(s => s.includes(q))
        let at: number
        if (b < 0) {
            b = sections.length // unlocatable → trailing bucket, given order
            at = given
        } else {
            at = sections[b].indexOf(q)
        }
        const list = buckets.get(b) ?? []
        list.push({e, at})
        buckets.set(b, list)
    })
    const ordered = [...buckets.keys()].sort((a, b) => a - b)
    for (const k of ordered) buckets.get(k)!.sort((a, b) => a.at - b.at)
    const out: RequirementEntry[] = []
    for (let round = 0; out.length < budget; round++) {
        let took = false
        for (const k of ordered) {
            const list = buckets.get(k)!
            if (round >= list.length) continue
            out.push(list[round].e)
            took = true
            if (out.length >= budget) break
        }
        if (!took) break
    }
    return out
}

/**
 * DETERMINISTIC RECALL FLOOR (same medicine as the launch-contract checklist):
 * paragraphs carrying an obligation marker (word-bounded "required"/"must").
 * Extraction recall over a long doc is the model's, and it varies run to run, so
 * an entire section can come back with no quotes at all. The host enumerates the
 * marked passages; the prompt lists their head lines as a checklist, and
 * uncoveredPassages() below turns "a marked passage produced no quote" into hard
 * evidence for one forced re-extraction.
 */
export function enumerateObligationPassages(
    doc: string | SpecDoc,
    policy: RequirementPolicy = REQUIREMENT_POLICY
): string[] {
    const parsed = typeof doc === 'string' ? parseSpecDoc(doc) : doc
    const accept = candidates(parsed, policy)
    const out: string[] = []
    // The SAME policy grounding uses. A marked passage no quote can be grounded
    // in would report itself uncovered forever and force a re-extraction every
    // round that can never discharge it.
    for (const b of blocksOf(parsed)) {
        if (!accept(b)) continue
        const p = b.text.trim()
        if (p.length < MIN_QUOTE_LENGTH) continue
        if (!/\b(required|must)\b/i.test(p)) continue
        out.push(p)
        if (out.length >= MAX_OBLIGATION_PASSAGES) break
    }
    return out
}

/** The head line of a passage, for compact checklist rendering. */
function passageHead(p: string): string {
    const first = p.split('\n')[0].trim()
    return first.length > 140 ? first.slice(0, 140) + '…' : first
}

/** Marked passages none of the kept quotes came from — the hard evidence that
 *  extraction recall failed there (a kept quote "covers" a passage when the
 *  passage contains it, normalised). */
export function uncoveredPassages(passages: string[], kept: RequirementEntry[]): string[] {
    const keptNorm = kept.map(e => normalise(demark(e.quote)))
    return passages.filter(p => {
        const pn = normalise(demark(p))
        return !keptNorm.some(q => pn.includes(q))
    })
}

/** Reprompt hint for the forced re-extraction over uncovered passages. */
export function extractionRetryHint(uncovered: string[]): string {
    return (
        '[SYSTEM NOTE: Your previous answer produced NO requirement from these passages, '
        + 'although each carries an explicit obligation marker. Re-extract the FULL '
        + 'requirement list, making sure every obligation in each passage below is quoted '
        + 'verbatim:\n'
        + uncovered.map(p => `  - ${passageHead(p)}`).join('\n')
        + ']'
    )
}

/** The plan-time extraction prompt. Runs with --no-tools; every quote is
 *  re-grounded host-side, so guessing wastes effort. Spec-shape-agnostic.
 *  `passages` is enumerateObligationPassages' checklist ([] ⇒ prompt unchanged). */
export const REQUIREMENT_EXTRACT_PROMPT = (feature: string, passages: string[] = []): string =>
    [
        'You are recording the REQUIREMENTS of the feature/design below as VERBATIM quotes.',
        'A requirement is anything the text OBLIGATES the finished work to have, do, or obey:',
        'functional behavior, constraints, quality bars, security/accessibility rules, and any',
        'MANDATED METHODOLOGY (testing cadence, verification practice, required scripts, files,',
        'directory structures, databases). Extract from WHATEVER structure the text has —',
        'numbered sections, bullet lists, or flowing prose with no headings at all.',
        "Pay particular attention to obligations that are NOT part of the text's main",
        'feature/milestone structure (a "required" testing or security section, an obligation',
        'buried mid-prose) — those are the ones downstream planning loses.',
        '',
        'FEATURE/DESIGN (the ONLY source — quote from it, never from your own knowledge):',
        feature.trim(),
        '',
        ...(passages.length > 0 ?
            [
                'OBLIGATION-MARKED PASSAGES — found mechanically (they contain "required"/"must").',
                'This checklist exists ONLY so you do not MISS one: every obligation in each of',
                'these passages must appear among your REQUIREMENT lines. It is a floor, not a',
                'ceiling — obligations outside these passages must be extracted too.',
                ...passages.map(p => `  - ${p.split('\n')[0].trim().slice(0, 140)}`),
                ''
            ]
        :   []),
        'For each requirement, emit exactly:',
        '  REQUIREMENT: "<verbatim quote copied EXACTLY from the text>" [anchor: <section/heading, or prose>]',
        'one per line. RULES: (1) the quote MUST be a literal substring of the text — do NOT',
        'paraphrase, merge, normalise, or complete it; ungrounded quotes are DISCARDED',
        'host-side. (2) Prefer the single sentence or line that states the obligation most',
        'directly. (3) One obligation per line. (4) Do NOT quote examples, rationale, or',
        'reference links. (5) Never invent a requirement the text does not state. (6) Quote',
        'the PROSE that states the obligation — a quote taken from a code/DDL block, from a',
        "table row, or from the text's opening description is DISCARDED host-side; where an",
        'obligation only appears there, quote the sentence that introduces it instead.',
        '',
        'Output the REQUIREMENT: lines and nothing else. If the text states no requirements,',
        'output nothing.'
    ].join('\n')

// ─── Mapping (the host-side coverage accounting) ─────────────────────────────

export type ReqMapping = {kind: 'task'; task: number} | {kind: 'cross'} | {kind: 'none'}

/**
 * A requirement no single task can ever OWN: a PROHIBITION (it states what must
 * NOT exist or happen — there is no task that "delivers" an absence), a GLOBAL
 * POLICY (a product-wide rule every slice obeys, not one slice's deliverable), or
 * a DESCRIPTION (what the product IS, which no slice delivers either). The
 * per-task coverage map maps all three to NONE forever, so left in the `unmapped`
 * set they hold the decompose loop's verdict at INCOMPLETE and make it regenerate
 * the whole plan every round — which can replace a good plan with a worse one.
 * These belong in the CROSS-CUTTING carry, injected verbatim into every task,
 * never fed back as a missing area.
 *
 * Deterministic and precision-biased: it only reclassifies clear prohibitions and
 * clearly product-global policies. It does NOT need to catch every un-ownable line
 * — the monotonic replacement rule (coverage-loop.ts) is the hard backstop, so a
 * miss here can at most cost one wasted regeneration, never a dropped area. Spec-
 * shape/domain agnostic: pure phrasing, no feature nouns.
 */
// Bare `no`, `not` and `none` are NOT here. They read as prohibitions in a
// grammar that has none: "the page renders even when the user is not logged in"
// is an ownable behaviour statement, and the bare-negative rule swept it — and
// everything like it — into a carry no task ever delivers. What remains is modal
// negation and explicit exclusion verbs, which cannot fire that way.
const PROHIBITION_RE =
    /\b(?:must not|must never|shall not|shall never|should not|may not|cannot|can'?t|won'?t|will not|do(?:es)? not|don'?t|doesn'?t|never|without|avoids?|prohibit(?:ed|s|ing)?|forbid(?:den|s)?|disallow(?:ed|s|ing)?|excludes?|excluded|neither|nor)\b/i
/** "must have NO runtime dependencies" — the absence shape bare `no` used to
 *  carry. Anchored to an existence verb AND gated by a modal below, because
 *  without the modal it is ordinary description: "the empty state shows when
 *  there are no listings yet" obligates nothing. */
const NEGATED_EXISTENCE_RE =
    /\b(?:is|are|be|been|being|has|have|had|contains?|ships?|leaves?|with)\s+no\b/i
// Kept narrow on purpose — bare "all"/"every"/"any" appear in plenty of ownable
// feature statements ("lists all photos"), so the global branch keys only on
// scope words that name the WHOLE product and is additionally gated by a modal.
const GLOBAL_SCOPE_RE =
    /\b(?:everywhere|throughout|always|global(?:ly)?|across (?:the|all|every)|site-?wide|app(?:lication)?-?wide|universal(?:ly)?|consistent(?:ly)?|entire (?:app|application|site|codebase|product|system|ui|project))\b/i
const MODAL_RE = /\b(?:must|shall|should|require[sd]?|required|needs? to|has to|have to)\b/i

export type RequirementClass = 'prohibition' | 'global-policy' | 'descriptive' | 'ownable'

/**
 * `descriptive` is the class the coverage loop must not chase: a line that says
 * what the product IS rather than what the work must do. It cost two whole
 * rejected decompose rounds live — "Invite-only used-parts marketplace for a
 * local Mazda MX-5 club." was extracted as a requirement, mapped NONE by every
 * round because no task delivers a sentence, and held the verdict INCOMPLETE.
 *
 * Both marks are required, not either: preamble POSITION (above every heading,
 * where a spec states its subject) and the absence of any modal. A preamble
 * sentence that does carry a modal is a real obligation stated up front, and a
 * modal-free sentence anywhere else is the ordinary shape of a feature statement
 * — treating either alone as descriptive would empty the coverage gate.
 */
export function classifyRequirement(quote: string, fromPreamble = false): RequirementClass {
    const q = quote.trim()
    if (PROHIBITION_RE.test(q)) return 'prohibition'
    if (NEGATED_EXISTENCE_RE.test(q) && MODAL_RE.test(q)) return 'prohibition'
    if (GLOBAL_SCOPE_RE.test(q) && MODAL_RE.test(q)) return 'global-policy'
    if (fromPreamble && !MODAL_RE.test(q)) return 'descriptive'
    return 'ownable'
}

/** A requirement no single task can ever OWN, judged on the quote alone — the
 *  shape `groundedCoverage` and the granularity floor get. */
export function isCrossCuttingRequirement(quote: string): boolean {
    const c = classifyRequirement(quote)
    return c === 'prohibition' || c === 'global-policy'
}

/** Requirement INDICES a task owns (a `TASK n` verdict), the monotonic-replacement
 *  signal (coverage-loop.ts). Index-aligned with the requirements list. */
export function ownedRequirementIndices(mappings: ReqMapping[]): Set<number> {
    const out = new Set<number>()
    mappings.forEach((m, i) => {
        if (m.kind === 'task') out.add(i)
    })
    return out
}

/** Per-requirement coverage verdicts against a task list. Runs with --no-tools. */
export const COVERAGE_MAP_PROMPT = (requirements: RequirementEntry[], titles: string[]): string =>
    [
        'Below are the REQUIRED CONTENTS of a feature (verbatim quotes mechanically grounded',
        'in its design) and the planned TASK LIST. For EACH requirement, judge which task will',
        'deliver it. Judge coverage, not wording — a task covers a requirement when its stated',
        'scope would naturally include it.',
        '',
        'REQUIREMENTS:',
        ...requirements.map((r, i) => `${i + 1}. "${r.quote}"${r.anchor ? ` [${r.anchor}]` : ''}`),
        '',
        'TASK LIST:',
        ...titles.map((t, i) => `${i + 1}. ${t}`),
        '',
        'For EVERY requirement, in order, output exactly one line:',
        '  MAP: <requirement#> -> TASK <task#>     (one task clearly owns it)',
        '  MAP: <requirement#> -> CROSS-CUTTING    (a rule/methodology MANY tasks must each fold into their own work)',
        '  MAP: <requirement#> -> NONE             (no task plausibly covers it)',
        'Every requirement number must appear exactly once. Output the MAP: lines and nothing else.'
    ].join('\n')

/**
 * Parse the mapping output. Index-aligned with `requirements` (0-based); a
 * requirement the model skipped, or mapped to an out-of-range task, is `none` —
 * distrust by default: an unaccounted requirement is exactly what this gate
 * exists to surface, so parsing leniency must never manufacture coverage.
 */
export function parseCoverageMap(text: string, reqCount: number, taskCount: number): ReqMapping[] {
    const out: ReqMapping[] = Array.from({length: reqCount}, () => ({kind: 'none'}) as ReqMapping)
    for (const m of text.matchAll(
        /^[ \t]*MAP:[ \t]*(\d+)[ \t]*(?:->|→)[ \t]*(TASK[ \t]*(\d+)|CROSS[- ]?CUTTING|NONE)/gim
    )) {
        const reqIdx = parseInt(m[1], 10) - 1
        if (reqIdx < 0 || reqIdx >= reqCount) continue
        const verdict = m[2].toUpperCase()
        if (verdict.startsWith('TASK')) {
            const t = parseInt(m[3], 10)
            out[reqIdx] = t >= 1 && t <= taskCount ? {kind: 'task', task: t} : {kind: 'none'}
        } else if (verdict.startsWith('CROSS')) {
            out[reqIdx] = {kind: 'cross'}
        } else {
            out[reqIdx] = {kind: 'none'}
        }
    }
    return out
}

export interface CoverageAccounting {
    mapped: Array<{req: RequirementEntry; task: number}>
    crossCutting: RequirementEntry[]
    /** Requirements NO task covers — drives the decompose reprompt / surfacing. */
    unmapped: RequirementEntry[]
}

/** Deterministic accounting over the parsed map — the host, not the model,
 *  decides completeness. */
export function accountCoverage(
    requirements: RequirementEntry[],
    mappings: ReqMapping[]
): CoverageAccounting {
    const acc: CoverageAccounting = {mapped: [], crossCutting: [], unmapped: []}
    for (let i = 0; i < requirements.length; i++) {
        const m = mappings[i] ?? {kind: 'none'}
        if (m.kind === 'task') acc.mapped.push({req: requirements[i], task: m.task})
        else if (m.kind === 'cross') acc.crossCutting.push(requirements[i])
        // NONE — but a prohibition, a global policy and a product description can
        // never be OWNED by a task (an absence, a product-wide rule, a statement of
        // what the thing IS); the model maps them NONE every round, which forces
        // endless whole-plan regeneration. Carry them cross-cutting instead, so
        // they stop driving the coverage loop — carried, never dropped.
        else if (
            classifyRequirement(requirements[i].quote, requirements[i].preamble ?? false)
            !== 'ownable'
        )
            acc.crossCutting.push(requirements[i])
        else acc.unmapped.push(requirements[i])
    }
    return acc
}

// ─── The carried-requirements artifact + injection block ────────────────────

/** The stored carried-requirements text ('' when none recorded). */
export async function readRequirements(cwd: string): Promise<string> {
    return carried.readRaw(cwd)
}

function formatEntry(e: RequirementEntry, marker?: string): string {
    const anchor = e.anchor ? ` [anchor: ${e.anchor}]` : ''
    return `"${e.quote}"${anchor}${marker ? ` [${marker}]` : ''}`
}

/**
 * Append carried requirements, deduped against what is stored. Three channels,
 * each better carried into every task than silently lost — host-side only,
 * children never write it, best-effort:
 *   • `crossCutting` — obligations no single task owns (policy/global rules).
 *   • `unresolved`   — grounded requirements still unmapped after the retry rounds.
 *   • `judgeFlagged` — free-text areas the holistic coverage judge flagged as
 *     uncovered that requirement-extraction never captured as a tracked entry, so
 *     the grounded channels above are structurally blind to them: without this
 *     channel such an area is warned about once and then dropped. These are plain
 *     strings, not quotes of the source; marked distinctly so a task can tell an
 *     inferred area from a verbatim obligation.
 *   • `danglingArtifacts` — runtime files the spec references but nothing
 *     produces (an `index.html` the server serves that no task, tree entry or
 *     build output ever creates), still unclaimed by any title at coverage
 *     exhaustion. Deterministically extracted (artifact-closure.ts), so like
 *     judge areas they are host-authored strings, not source quotes.
 */
export async function appendCarriedRequirements(
    cwd: string,
    crossCutting: RequirementEntry[],
    unresolved: RequirementEntry[] = [],
    judgeFlagged: string[] = [],
    danglingArtifacts: string[] = []
): Promise<void> {
    const fresh: CarriedLine[] = []
    for (const [entries, marker] of [
        [crossCutting, undefined],
        [unresolved, 'no task owns this — surfaced at plan time'],
        [
            judgeFlagged.map(q => ({quote: q, anchor: ''})),
            'judge-flagged uncovered area, no task owns this — surfaced at plan time'
        ],
        [
            danglingArtifacts.map(q => ({quote: q, anchor: ''})),
            'dangling runtime artifact, nothing produces it — surfaced at plan time'
        ]
    ] as const) {
        for (const e of entries) fresh.push({line: formatEntry(e, marker), key: normalise(e.quote)})
    }
    await carried.append(cwd, fresh)
}

/**
 * The read-only block refine/compose receive when carried requirements exist.
 * Verbatim content travels with every task — the REFINE_PRESERVE_DIRECTIVE
 * pattern in phases.ts, content rather than a pointer — and the VERIFY mandate is
 * spelled out, so a mandated verification methodology reaches every applicable
 * task's runnable checks.
 */
export function buildRequirementsBlock(requirements: string): string {
    if (requirements.trim().length === 0) return ''
    return [
        'CROSS-CUTTING REQUIREMENTS — obligations the SOURCE design states that apply across',
        'tasks (verbatim quotes; AUTHORITATIVE). No single task owns them, so EVERY task must',
        'fold them into its own slice wherever they touch it:',
        ...requirements
            .trim()
            .split('\n')
            .map(l => `- ${l}`),
        'For each entry that touches artifacts THIS task creates or changes (its routes,',
        'components, pages, commands, files): deliver it IN THIS TASK as part of the same',
        'change — e.g. a mandated test/check for a new artifact lands with that artifact —',
        'and make ACCEPTANCE/VERIFY exercise it with runnable commands. These are never',
        '"a later task\'s job" unless the plan names a task that owns them. Entries that do',
        "not touch this task's slice are ignored, not restated.",
        ''
    ].join('\n')
}

// ─── Owned (task-mapped) requirements ────────────────────────────────
//
// The CROSS-CUTTING requirements are persisted and injected into every task. The
// TASK-MAPPED ones only ride the decompose ledger, which shapes the title list —
// so without this channel nothing ever shows a task its OWN mapped obligations,
// and a refine that merely READ the clause can still narrow it away in the
// composed spec. An obligation the coverage map assigned to a task travels INTO
// that task here, as verbatim authoritative text, on the same channel the
// cross-cutting requirements use.

const OWNED_REQUIREMENTS_FILE = 'requirements-owned.md'

export interface OwnedRequirement {
    /** The verbatim design quote (the obligation). */
    quote: string
    anchor: string
    /** The plan title of the task the coverage map assigned it to — matched
     *  against the executing task's title at phase time (ids don't exist yet at
     *  plan time, and spliced repair tasks shift them). */
    title: string
    /**
     * DETACHED: the files this obligation
     * names that its assigned task FROZE, making it unsatisfiable there. While
     * set, the entry is owned by nobody — `ownedForTitle` skips it — and `title`
     * records only where it came from. The next task whose refined prompt shows
     * a write intent on one of these paths claims it (clearing this field), and
     * an entry nobody claims is surfaced at the end of the run rather than
     * silently dropped. Absent on every ordinary entry.
     */
    pending?: string[]
}

/**
 * Uncapped and never appended to — the mapping is recomputed whole per plan
 * round and rewritten by the DETACH/CLAIM passes, so the key is the quote only
 * for the ledger's contract; nothing dedupes through it.
 */
const ownedLedger = makeLedger<OwnedRequirement>({
    file: OWNED_REQUIREMENTS_FILE,
    key: o => normalise(o.quote),
    serialize: o =>
        `OWNED: "${o.quote}"${o.anchor ? ` [anchor: ${o.anchor}]` : ''}`
        + (o.pending && o.pending.length > 0 ? ` [pending: ${o.pending.join(', ')}]` : '')
        + ` [title: ${o.title.replace(/\n/g, ' ')}]`,
    parse: parseOwnedRequirements
})

export function ownedRequirementsFile(cwd: string): string {
    return ownedLedger.path(cwd)
}

/** Persist the task-mapped requirements (host-side, plan time). Overwrites —
 *  the mapping is recomputed whole per plan round. Best-effort like the carried
 *  artifact. */
export async function writeOwnedRequirements(
    cwd: string,
    entries: OwnedRequirement[]
): Promise<void> {
    await ownedLedger.write(cwd, entries)
}

export async function readOwnedRequirements(cwd: string): Promise<OwnedRequirement[]> {
    return ownedLedger.read(cwd)
}

export function parseOwnedRequirements(text: string): OwnedRequirement[] {
    const out: OwnedRequirement[] = []
    for (const m of text.matchAll(
        /^OWNED:\s*"([^"\n]+)"(?:\s*\[anchor:\s*([^\]]*)\])?(?:\s*\[pending:\s*([^\]]*)\])?\s*\[title:\s*([^\n]+)\]\s*$/gim
    )) {
        const pending = (m[3] ?? '')
            .split(',')
            .map(p => p.trim())
            .filter(p => p.length > 0)
        out.push({
            quote: m[1].trim(),
            anchor: (m[2] ?? '').trim(),
            title: m[4].replace(/\]\s*$/, '').trim(),
            ...(pending.length > 0 ? {pending} : {})
        })
    }
    return out
}

/** The owned entries whose plan title matches THIS task's title (normalised
 *  equality — titles travel verbatim from the plan list into task creation;
 *  spliced repair tasks simply match nothing). A DETACHED entry (`pending`) is
 *  owned by nobody until a task claims it, so it is never returned here — its
 *  `title` is provenance, not ownership. */
export function ownedForTitle(owned: OwnedRequirement[], title: string): OwnedRequirement[] {
    const t = normalise(title)
    if (t.length === 0) return []
    return owned.filter(o => normalise(o.title) === t && !(o.pending && o.pending.length > 0))
}

/** The injection block for a task's OWN mapped obligations. Mirrors
 *  buildRequirementsBlock (the directive pattern that measurably works) but is
 *  singular in address: these are not "wherever they touch", they ARE this
 *  task's obligations and must survive into the spec. */
export function buildOwnedRequirementsBlock(owned: OwnedRequirement[]): string {
    if (owned.length === 0) return ''
    return [
        "THIS TASK'S OWN REQUIREMENTS — obligations the SOURCE design states for exactly this",
        "task's slice (verbatim quotes; AUTHORITATIVE — the design outranks any narrower",
        'restatement, including the refined prompt above):',
        ...owned.map(o => `- "${o.quote}"${o.anchor ? ` [anchor: ${o.anchor}]` : ''}`),
        'Every entry must be SATISFIED BY THIS TASK and must appear in the spec: state it (or',
        'its concrete consequence) under CONSTRAINTS or ACCEPTANCE, and make VERIFY exercise',
        'it where runnable. Never weaken an entry to a narrower behavior — if the quote says',
        'more than the refined prompt, the quote wins.',
        ''
    ].join('\n')
}

/**
 * The host-side belt for the owned channel: deterministically append each owned
 * obligation the composed spec does not already carry as a CONSTRAINTS bullet.
 * The injected block alone is an instruction compose can ignore; an append
 * cannot be. "Already carries" = the normalised quote appears anywhere in the
 * spec, so a spec that DID fold the clause in is not double-stated. No
 * CONSTRAINTS section → returned unchanged; this runs only on specs the shape
 * gate already accepted.
 *
 * Scoped to the OWNING task only. A prohibition the coverage map leaves unowned is
 * already carried cross-cutting to every task by `accountCoverage` above, so the
 * owned channel is not the place to reach a requirement's other readers.
 */
export function appendOwnedConstraints(spec: string, owned: OwnedRequirement[]): string {
    if (owned.length === 0) return spec
    const m = /^CONSTRAINTS[ \t]*$/m.exec(spec)
    if (!m) return spec
    const already = normalise(spec)
    const missing = owned.filter(o => !already.includes(normalise(o.quote)))
    if (missing.length === 0) return spec
    const insertAt = m.index + m[0].length
    const bullets = missing
        .map(
            o =>
                `  - "${o.quote}"${o.anchor ? ` [${o.anchor}]` : ''} — owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)`
        )
        .join('\n')
    return `${spec.slice(0, insertAt)}\n${bullets}${spec.slice(insertAt)}`
}

/** The decompose-prompt ledger block: the grounded requirement list rides into
 *  decompose so a title list that mirrors the spec's own headings cannot
 *  discharge it. */
export function buildRequirementsLedger(requirements: RequirementEntry[]): string {
    if (requirements.length === 0) return ''
    return [
        'REQUIRED CONTENT LEDGER (verbatim from the spec, mechanically grounded — the task',
        'list must collectively carry EVERY entry, whatever structure you follow; mirroring',
        "the spec's own milestone/section list does NOT by itself discharge these):",
        ...requirements.map((r, i) => `${i + 1}. "${r.quote}"${r.anchor ? ` [${r.anchor}]` : ''}`),
        ''
    ].join('\n')
}
