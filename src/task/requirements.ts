/**
 * requirements — requirement-level coverage accounting for /task-auto planning
 * (mx5 run 11, goal A).
 *
 * The failure this closes: the design's §10 Testing section REQUIRES test-first
 * cadence, Playwright CT with screenshot baselines, a `test:ct` script, a
 * separate test DB, and a `test/` dir — and got ZERO tasks and ZERO per-task
 * injection. The coverage gate asked one holistic question ("do these tasks
 * cover the whole feature?"), and a task list that mirrors the spec's own
 * milestone list is structurally parity-complete, so the judge said COMPLETE in
 * round 1. Milestone-parity coverage is structurally blind to sections that
 * aren't milestones.
 *
 * Mechanism (spec-shape-agnostic, contracts.ts pattern):
 *   1. EXTRACT requirement units as VERBATIM quotes from whatever structure the
 *      spec has (headings, tables, bullets, prose) — each host-GROUNDED by the
 *      normalised-substring guard, so a fabricated requirement can never enter.
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
 * Goal C rides the same channel: when the spec mandates a verification
 * methodology ("a test lands in the same change as each new route"), that quote
 * is exactly what gets injected, and compose's VERIFY rules fold it into every
 * applicable task's runnable verification.
 */
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import {tasksDir} from './task-io.js'
import {normalise} from './contracts.js'

const REQUIREMENTS_FILE = 'requirements.md'
/** Cap kept entries so the injected block stays bounded on a large design. */
const MAX_REQUIREMENTS = 40
/** One line each; longer is prose, not a requirement statement. */
const MAX_REQUIREMENT_LENGTH = 300
/** Too short to state an obligation (and to ground unambiguously). */
const MIN_QUOTE_LENGTH = 6

export interface RequirementEntry {
    /** The verbatim quote from the source doc — the obligation. */
    quote: string
    /** Where it came from (heading/section, or 'prose'). */
    anchor: string
}

export function requirementsFile(cwd: string): string {
    return path.join(tasksDir(cwd), REQUIREMENTS_FILE)
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

/** THE ANTI-SYNTHESIS GUARD: keep only entries whose quote is a normalised
 *  substring of the source doc (same rule as keepGroundedContracts). Does NOT
 *  cap — capping is capRequirements' job, which protects obligation-marked
 *  passages from doc-order truncation. */
export function keepGroundedRequirements(
    entries: RequirementEntry[],
    sourceDoc: string
): RequirementEntry[] {
    const haystack = normalise(sourceDoc)
    const seen = new Set<string>()
    const kept: RequirementEntry[] = []
    for (const e of entries) {
        const key = normalise(e.quote)
        if (key.length === 0 || seen.has(key)) continue
        if (!haystack.includes(key)) continue
        seen.add(key)
        kept.push(e)
    }
    return kept
}

/**
 * Bound the list WITHOUT doc-order truncation: measured live, an eager model
 * extracts 40+ items top-down (every §1 decision row), so a plain first-N cap
 * systematically drops the TAIL sections — exactly where mx5 keeps its testing
 * obligations. Rule (deterministic priority, not a knob): entries quoting an
 * obligation-marked passage survive first; the remainder fills in given order.
 */
export function capRequirements(
    entries: RequirementEntry[],
    passages: string[]
): RequirementEntry[] {
    if (entries.length <= MAX_REQUIREMENTS) return entries
    const norms = passages.map(normalise)
    const covers = (e: RequirementEntry): boolean => {
        const q = normalise(e.quote)
        return norms.some(p => p.includes(q))
    }
    const marked = entries.filter(covers)
    const rest = entries.filter(e => !covers(e))
    return [...marked, ...rest].slice(0, MAX_REQUIREMENTS)
}

/**
 * DETERMINISTIC RECALL FLOOR (same medicine as the launch-contract checklist):
 * paragraphs carrying an obligation marker (word-bounded "required"/"must").
 * Extraction recall over a 20KB doc is the weak model's, and it is variance-
 * prone — measured live, 1 of 5 runs kept 16 quotes with ZERO §10 items. The
 * host enumerates the marked passages; the prompt lists their head lines as a
 * checklist, and uncoveredPassages() below turns "a marked passage produced no
 * quote" into hard evidence for one forced re-extraction.
 */
export function enumerateObligationPassages(doc: string): string[] {
    const out: string[] = []
    for (const para of doc.split(/\n[ \t]*\n/)) {
        const p = para.trim()
        if (p.length < MIN_QUOTE_LENGTH) continue
        if (!/\b(required|must)\b/i.test(p)) continue
        out.push(p)
        if (out.length >= 20) break
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
    const keptNorm = kept.map(e => normalise(e.quote))
    return passages.filter(p => {
        const pn = normalise(p)
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
        'numbered sections, tables, bullet lists, or flowing prose with no headings at all.',
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
        'reference links. (5) Never invent a requirement the text does not state.',
        '',
        'Output the REQUIREMENT: lines and nothing else. If the text states no requirements,',
        'output nothing.'
    ].join('\n')

// ─── Mapping (the host-side coverage accounting) ─────────────────────────────

export type ReqMapping = {kind: 'task'; task: number} | {kind: 'cross'} | {kind: 'none'}

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
        else acc.unmapped.push(requirements[i])
    }
    return acc
}

// ─── The carried-requirements artifact + injection block ────────────────────

/** The stored carried-requirements text ('' when none recorded). */
export async function readRequirements(cwd: string): Promise<string> {
    try {
        return (await fsp.readFile(requirementsFile(cwd), 'utf8')).trim()
    } catch {
        return ''
    }
}

function formatEntry(e: RequirementEntry, marker?: string): string {
    const anchor = e.anchor ? ` [anchor: ${e.anchor}]` : ''
    return `"${e.quote}"${anchor}${marker ? ` [${marker}]` : ''}`
}

/**
 * Append carried requirements (cross-cutting, plus any left unmapped after the
 * retry rounds — better carried into every task than silently lost), deduped
 * against what is stored. Host-side only; children never write it. Best-effort.
 */
export async function appendCarriedRequirements(
    cwd: string,
    crossCutting: RequirementEntry[],
    unresolved: RequirementEntry[] = []
): Promise<void> {
    if (crossCutting.length === 0 && unresolved.length === 0) return
    try {
        const existing = (await readRequirements(cwd)).split('\n').filter(l => l.trim().length > 0)
        const seen = new Set(
            existing.map(l => {
                const q = /"([^"]+)"/.exec(l)
                return normalise(q ? q[1] : l)
            })
        )
        const merged = [...existing]
        for (const [entries, marker] of [
            [crossCutting, undefined],
            [unresolved, 'no task owns this — surfaced at plan time']
        ] as const) {
            for (const e of entries) {
                const key = normalise(e.quote)
                if (seen.has(key)) continue
                seen.add(key)
                merged.push(formatEntry(e, marker))
            }
        }
        await fsp.mkdir(tasksDir(cwd), {recursive: true})
        await fsp.writeFile(
            requirementsFile(cwd),
            merged.slice(-MAX_REQUIREMENTS).join('\n') + '\n',
            'utf8'
        )
    } catch {
        // best-effort artifact
    }
}

/**
 * The read-only block refine/compose receive when carried requirements exist.
 * Verbatim content travels with every task (the directive pattern that works),
 * and the VERIFY mandate is explicit — goal C rides here.
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

/** The decompose-prompt ledger block (goal E's belt): the grounded requirement
 *  list rides into decompose so structure-mirroring can't discharge it. */
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
