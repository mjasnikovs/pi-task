/**
 * env-notes — a per-run cache of ENVIRONMENT FACTS shared across gate children.
 *
 * The failure this serves (mx5 run 7, F8): every gate child re-discovers the
 * same environment facts from scratch — where the DB credentials live, which
 * services are reachable, which tools are installed — burning minutes of
 * archaeology per child through the serial model bottleneck.
 *
 * Mechanism: children EMIT facts as `ENV-NOTE: <fact>` lines in their answer
 * text; the HOST parses and appends them to `.pi-tasks/env-notes.md` (children
 * never write the file — no artifact corruption, host-side dedupe). The file
 * lives under `.pi-tasks/`, so it survives discardEdits and the git-state
 * guard, both of which exclude that directory by design.
 *
 * SCOPE — facts only, never verdicts, never spec content: an endpoint, a
 * credential LOCATION, a tool's presence/version, a service's reachability.
 * And the cache must not become a pre-prepared runway that masks missing
 * project setup: the verify-as-shipped rule ("any prep you needed IS the
 * defect") still governs every verdict — the block injected into prompts says
 * so explicitly. The cache only kills re-discovery time.
 *
 * PROVENANCE + RE-VALIDATION (run 8, F7): a verify child once grepped component
 * names in a MINIFIED bundle (identifiers mangled ⇒ 0 hits by construction),
 * wrote "build tree-shakes ALL route components — pre-existing issue" to the
 * cache, and ten later tasks inherited it verbatim as a standing "pre-existing,
 * unrelated" excuse to wave off a genuinely broken deliverable — nobody
 * re-checked. Two guards close that class: (a) each note is stamped host-side
 * with the ORIGIN task that recorded it (a note is second-hand hearsay, not the
 * reader's own observation); (b) the injected block demands the reader
 * RE-VALIDATE a note in the CURRENT tree before citing it to excuse a failure,
 * flags EXCUSE-CLASS notes ("pre-existing", "unrelated", "tree-shaken") for
 * exactly that scrutiny, and forbids treating a grep of a generated artifact as
 * evidence of absence. Provenance is mechanical; re-validation is prompt-level.
 */
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import {tasksDir} from './task-io.js'

const ENV_NOTES_FILE = 'env-notes.md'
/** Cap kept notes so a chatty run cannot grow the prompt block unboundedly. */
const MAX_NOTES = 40
/** A single fact is one line; anything longer is prose, not a fact. */
const MAX_NOTE_LENGTH = 240
/**
 * Field separator between a fact and its origin in the stored file. A tab never
 * occurs in a one-line fact (facts are prose), so it round-trips cleanly and any
 * stray tab in an emitted fact is normalised to a space before storage.
 */
const ORIGIN_SEP = '\t'

export function envNotesFile(cwd: string): string {
    return path.join(tasksDir(cwd), ENV_NOTES_FILE)
}

/** The raw stored file ('' when none were recorded yet). Parse with parseEnvNotes. */
export async function readEnvNotes(cwd: string): Promise<string> {
    try {
        return (await fsp.readFile(envNotesFile(cwd), 'utf8')).trim()
    } catch {
        return ''
    }
}

/** One recorded fact plus the origin task that established it (may be ''). */
export interface EnvNote {
    fact: string
    origin: string
}

/**
 * Parse the stored file into fact+origin records. Legacy lines written before
 * provenance (no separator) parse with an empty origin, so old caches still read.
 */
export function parseEnvNotes(raw: string): EnvNote[] {
    const out: EnvNote[] = []
    for (const line of raw.split('\n')) {
        const t = line.trim()
        if (t.length === 0) continue
        const i = t.indexOf(ORIGIN_SEP)
        if (i === -1) out.push({fact: t, origin: ''})
        else out.push({fact: t.slice(0, i).trim(), origin: t.slice(i + 1).trim()})
    }
    return out
}

function serializeNote(n: EnvNote): string {
    return n.origin ? `${n.fact}${ORIGIN_SEP}${n.origin}` : n.fact
}

/**
 * Pull `ENV-NOTE: <fact>` lines out of a child's answer text. Deduplicated,
 * length-capped; verdict markers can never match (different prefix).
 */
export function extractEnvNotes(text: string): string[] {
    const notes: string[] = []
    const seen = new Set<string>()
    for (const m of text.matchAll(/^[ \t]*ENV-NOTE:[ \t]*(.+)$/gm)) {
        const note = m[1].trim()
        if (note.length === 0 || note.length > MAX_NOTE_LENGTH) continue
        const key = note.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        notes.push(note)
    }
    return notes
}

/**
 * EXCUSE-CLASS wording: a note that waves a problem off as someone else's or a
 * prior condition ("pre-existing … mismatch", "unrelated to this task",
 * "tree-shaken", "not applicable"). These are the notes that propagate across
 * slices as standing excuses (mx5 run-8 F7) — every one of the run-8 cache's
 * dozen such notes was either the false tree-shake fact or the schema mismatch
 * the final gate later proved was a REAL defect. Pure text, stack-agnostic; the
 * flag never drops or fails a note, it only marks it as needing live
 * re-validation before it may EXCUSE a failure. FP is harmless by construction:
 * a benign fact re-validates and is used, the marker only bites a citation-to-
 * wave-off. Benign status facts ("5 pre-existing warnings") do not match — a
 * "pre-existing" match requires a co-located problem word.
 */
const EXCUSE_PATTERNS: RegExp[] = [
    /\bunrelated\b/i,
    /\bnot (?:my|our|this) (?:task|concern|deliverable|slice|problem)\b/i,
    /\boutside (?:the|this) deliverable\b/i,
    /\bnot applicable\b/i,
    /\bnot specific to\b/i,
    /\btree[-\s]?shak/i,
    /\bpre-?existing\b[^.\n]*\b(?:fail|issue|mismatch|bug|error|broken|problem|affect)/i,
    /\baffect(?:ing|s)? all\b/i
]

/** True when a fact reads like a standing excuse (see EXCUSE_PATTERNS). */
export function isExcuseNote(fact: string): boolean {
    return EXCUSE_PATTERNS.some(re => re.test(fact))
}

/**
 * Append newly discovered facts to the cache, deduplicated against what is
 * already there (case-insensitive fact match), keeping the newest MAX_NOTES.
 * Each new fact is stamped with the `origin` task that recorded it; a fact
 * already present keeps its ORIGINAL origin (provenance traces to who first
 * established it). Failures are swallowed — the cache is a sharpener, never a
 * blocker.
 */
export async function appendEnvNotes(cwd: string, notes: string[], origin = ''): Promise<void> {
    if (notes.length === 0) return
    try {
        const existing = parseEnvNotes(await readEnvNotes(cwd))
        const seen = new Set(existing.map(n => n.fact.toLowerCase()))
        const merged = [...existing]
        for (const note of notes) {
            const fact = note.trim().replace(/\t/g, ' ')
            const key = fact.toLowerCase()
            if (key.length === 0 || seen.has(key)) continue
            seen.add(key)
            merged.push({fact, origin: origin.trim()})
        }
        const kept = merged.slice(-MAX_NOTES)
        await fsp.mkdir(tasksDir(cwd), {recursive: true})
        await fsp.writeFile(envNotesFile(cwd), kept.map(serializeNote).join('\n') + '\n', 'utf8')
    } catch {
        // best-effort cache
    }
}

/**
 * The prompt block a gate child receives when notes exist. Two things are
 * load-bearing: the no-waiver caveat (facts save re-discovery time but grant no
 * license to prepare/repair) and the trust discipline (a note is second-hand
 * until re-validated; an EXCUSE-CLASS note may not wave off a failure without a
 * live re-check; a grep of a generated artifact is not evidence of absence).
 */
export function buildEnvNotesBlock(raw: string): string {
    const notes = parseEnvNotes(raw)
    if (notes.length === 0) return ''
    const lines = notes.map(n => {
        const origin = n.origin ? ` — recorded by ${n.origin}` : ' — origin unrecorded'
        const flag =
            isExcuseNote(n.fact) ?
                '  [EXCUSE-CLASS — re-validate in the CURRENT tree before citing this to wave off any failure]'
            :   ''
        return `- ${n.fact}${origin}${flag}`
    })
    return [
        'KNOWN ENVIRONMENT FACTS — recorded by earlier verification passes in this run',
        '(second-hand, may be stale or WRONG):',
        ...lines,
        '',
        'These facts only save you re-discovery time (where credentials/config live, which',
        'tools are installed, which services are reachable). They are NOT a license to',
        'prepare or repair the run: the verify-as-shipped rules below still govern the',
        'verdict — if the project needs something its own committed files do not provide,',
        'that remains the defect no matter what is listed here.',
        '',
        'TRUST DISCIPLINE — a false "pre-existing, unrelated" note once masked a real shipped',
        'defect across many tasks in this exact pipeline; do not repeat it:',
        '- A note above is second-hand hearsay from another task, not your own observation.',
        '  You may CITE one to EXCUSE, wave off, or down-grade a failure ONLY IF you',
        '  RE-VALIDATE its claim in the CURRENT tree right now and state the command or',
        '  observation you used to reconfirm it.',
        '- If a note fails re-validation (its claim is not true in the current tree), do NOT',
        "  inherit it: treat the underlying problem as UNexcused and report it. Don't silently",
        '  carry a stale fact forward.',
        '- EVIDENCE HYGIENE: string-searching a MINIFIED, bundled, or otherwise generated or',
        '  compiled artifact is NOT evidence that something is absent — identifiers there are',
        '  renamed or stripped by construction, so a zero-hit grep proves nothing. Derive',
        '  presence/absence only from SOURCE files or by EXECUTING the artifact and observing.',
        '- A claim that a defect is "pre-existing", "unrelated", or "not this task" is an',
        '  EXCUSE, not a fact (the ones above are marked): re-establish it live, and if it',
        '  actually holds as a real defect, escalate it (report FAIL) rather than passing it',
        '  on as a standing waiver.',
        ''
    ].join('\n')
}

/** The emit instruction appended to bash-capable gate-child prompts. */
export const ENV_NOTE_EMIT_INSTRUCTION = [
    'ENVIRONMENT FACTS — share what you discover: when you establish a durable fact about',
    'THIS MACHINE or the project environment (a service reachable/absent at an address, where',
    'credentials/config live, a tool or runtime present/missing and its version), emit a line',
    '  ENV-NOTE: <one-line fact>',
    'anywhere in your answer, one per fact. A fact is something you OBSERVED to be true of the',
    'machine or environment — never a task verdict, never spec content, never a judgment about',
    'the code. In particular do NOT record an absence you inferred from grepping a built or',
    'minified artifact (identifiers there are mangled — a zero-hit grep proves nothing), and',
    'do NOT record "X is pre-existing / unrelated / not my task": that is a verdict, not an',
    'environment fact. These are cached for later verification passes in this run so they do',
    'not re-discover the same things.'
].join('\n')
