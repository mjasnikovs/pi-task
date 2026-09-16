/**
 * env-notes — a per-run cache of ENVIRONMENT FACTS shared across gate children.
 *
 * The failure this serves: every gate child re-discovers the
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
 * PROVENANCE + RE-VALIDATION. A shared cache has a failure mode a per-child one
 * does not: a WRONG fact propagates. The shape to fear is a verify child grepping
 * component names in a MINIFIED bundle — identifiers there are mangled, so zero
 * hits is guaranteed regardless of the truth — concluding "the build tree-shakes
 * all route components, pre-existing issue", and every later task inheriting that
 * verbatim as a standing excuse to wave off a genuinely broken deliverable.
 * Nobody re-checks a fact that is already written down.
 *
 * Two guards close it. (a) Each note is stamped host-side with the ORIGIN task
 * that recorded it, so it reads as second-hand hearsay rather than the reader's
 * own observation. (b) The injected block demands the reader RE-VALIDATE a note
 * in the CURRENT tree before citing it to excuse a failure, marks EXCUSE-CLASS
 * notes for exactly that scrutiny, and states outright that a zero-hit grep of a
 * generated artifact is not evidence of absence. Provenance is mechanical;
 * re-validation is prompt-level.
 */
import {makeLedger} from './ledger.js'

const ENV_NOTES_FILE = 'env-notes.md'
/** Cap kept notes so a chatty run cannot grow the prompt block unboundedly. */
const MAX_NOTES = 40
/** A single fact is one line; anything longer is prose, not a fact. */
const MAX_NOTE_LENGTH = 240
/**
 * Field separator between a note's fields in the stored file. A tab never occurs
 * in a one-line fact (facts are prose), so it round-trips cleanly and any stray
 * tab in an emitted fact is normalised to a space before storage.
 */
const FIELD_SEP = '\t'

/**
 * One recorded fact, the origin task that established it, the run it belongs to,
 * and the SUBJECT it is about.
 *
 * The subject is the ledger key, and that is the whole point: twenty children
 * re-measuring one database's reachability wrote twenty slots of one fact, and the
 * oldest, least true of them was as loud as the newest. Under a subject key the
 * latest measurement REPLACES its predecessor, which is also the only retraction
 * mechanism a fact cache has.
 */
export interface EnvNote {
    fact: string
    origin: string
    /** The run that recorded it; '' for a file written before runs were stamped. */
    runId: string
    subject: string
    /** The task that retracted this claim. A resolved note stays as an audit line
     *  and is never carried into another child's prompt. */
    resolvedBy?: string
}

/** Stored line: `fact TAB origin TAB runId TAB subject TAB resolvedBy`, where every
 *  field after the fact may be absent — a one- or two-field line is what earlier
 *  versions wrote, and it still reads. */
export function parseEnvNotes(raw: string): EnvNote[] {
    const out: EnvNote[] = []
    for (const line of raw.split('\n')) {
        const t = line.trim()
        if (t.length === 0) continue
        const [fact, origin, runId, subject, resolvedBy] = t.split(FIELD_SEP).map(f => f.trim())
        out.push({
            fact,
            origin: origin ?? '',
            runId: runId ?? '',
            // A legacy line carries no subject, so it gets the one the host would
            // derive for it today — which is what makes the old file dedupe too.
            subject: subject || deriveSubject(fact),
            ...(resolvedBy ? {resolvedBy} : {})
        })
    }
    return out
}

function serializeNote(n: EnvNote): string {
    return [n.fact, n.origin, n.runId, n.subject, n.resolvedBy ?? ''].join(FIELD_SEP).trimEnd()
}

/** Keyed on the SUBJECT (case-insensitive), latest statement wins. */
const ledger = makeLedger<EnvNote>({
    file: ENV_NOTES_FILE,
    max: MAX_NOTES,
    key: n => n.subject.toLowerCase(),
    serialize: serializeNote,
    parse: parseEnvNotes,
    conflict: 'replace'
})

export function envNotesFile(cwd: string): string {
    return ledger.path(cwd)
}

/** The raw stored file ('' when none were recorded yet). Parse with parseEnvNotes. */
export async function readEnvNotes(cwd: string): Promise<string> {
    return ledger.readRaw(cwd)
}

/** Leading words a subject may be built from: the generic ones say nothing about
 *  which fact this is. */
const SUBJECT_STOPWORDS = new Set([
    'the',
    'this',
    'that',
    'these',
    'those',
    'and',
    'but',
    'for',
    'from',
    'with',
    'current',
    'still',
    'now',
    'not',
    'are',
    'was',
    'were'
])

function subjectWords(s: string): string[] {
    return s
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(t => t.length > 2 && !SUBJECT_STOPWORDS.has(t))
}

/**
 * The subject of a fact the child did not name one for.
 *
 * A fact identifies what it is ABOUT by naming it first, and three rungs cover
 * what an environment fact names: the SERVICE it reached (a URL authority), the
 * COMMAND it ran (the first code span, by its basename so a tool named by path is
 * the same tool), or — for the rest — its leading words.
 *
 * Measured against the 40-note cache a real 21-task run left behind, where 34
 * slots restate two facts: it resolves them to nine subjects, so the twelfth
 * re-measurement of one database replaces the eleventh instead of joining it.
 */
export function deriveSubject(fact: string): string {
    const url = /\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s/@`]*@)?([^\s/`,;)]+)/i.exec(fact)
    if (url) return url[1].toLowerCase()
    const code = /`([^`]+)`/.exec(fact)
    if (code) {
        // A leading `VAR=value` is the environment of the command, not the command.
        const word = code[1]
            .trim()
            .split(/\s+/)
            .find(w => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w))
        if (word !== undefined && word.length > 0) {
            const bare = /^\.{0,2}\//.test(word) ? (word.split('/').pop() ?? word) : word
            if (bare.length > 0) return bare.toLowerCase()
        }
    }
    return subjectWords(fact).slice(0, 2).join(' ')
}

/** One thing a child shared: a fact, or the retraction of one. */
export interface EmittedNote {
    subject: string
    fact: string
    /** The child observed this subject's recorded claim to be no longer true. */
    resolved?: true
}

/**
 * Pull the facts out of a child's answer text. Three forms are accepted:
 * `ENV-NOTE[<subject>]: <fact>` (what the instruction asks for), the bare
 * `ENV-NOTE: <fact>` whose subject the host derives, and
 * `ENV-NOTE-RESOLVED[<subject>]: <what was observed>`, which retracts a recorded
 * claim. Facts are trimmed, deduped case-insensitively, and dropped when empty or
 * over MAX_NOTE_LENGTH. A `VERDICT:` line and even a near-miss `ENV-NOTES:` line
 * match nothing, so a verdict cannot leak into the fact cache.
 */
export function extractEnvNotes(text: string): EmittedNote[] {
    const notes: EmittedNote[] = []
    const seen = new Set<string>()
    const line = /^[ \t]*ENV-NOTE(-RESOLVED)?(?:\[([^\]\n]*)\])?:[ \t]*(.+)$/gm
    for (const m of text.matchAll(line)) {
        const fact = m[3].trim()
        if (fact.length === 0 || fact.length > MAX_NOTE_LENGTH) continue
        const key = fact.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        const named = (m[2] ?? '').trim()
        notes.push({
            subject: named.length > 0 ? named : deriveSubject(fact),
            fact,
            ...(m[1] ? {resolved: true as const} : {})
        })
    }
    return notes
}

/**
 * EXCUSE-CLASS wording: a note that waves a problem off as someone else's or as a
 * prior condition. These are the notes that propagate across slices as standing
 * excuses, and the ones most likely to be masking a real defect rather than
 * describing the environment.
 *
 * Pure text, stack-agnostic. The flag never drops or fails a note — it only marks
 * it as needing live re-validation before it may EXCUSE a failure, so a false
 * positive is harmless: a benign fact re-validates and is used, and the marker
 * only bites a citation-to-wave-off.
 *
 * Run against the shapes it has to separate: "unrelated to this task",
 * "tree-shaken by the build", "pre-existing mismatch in the schema", "not
 * applicable here" and "affects all routes" all flag, while the benign status
 * fact "5 pre-existing warnings" does NOT — a "pre-existing" match needs a
 * co-located problem word — and neither do ordinary facts like "postgres
 * reachable on 5432".
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
 * Store what a child shared, keyed by SUBJECT: a fresh statement about a subject
 * REPLACES the one the cache held, so the newest measurement is the one later
 * children read and a stale fact cannot outlive its correction. Each note is
 * stamped with the `origin` task and the `runId` that recorded it — the run is
 * what the prompt block scopes on, the task is the provenance a reader is told to
 * re-validate against.
 *
 * A retraction stores the observation that closed the subject and marks it
 * RESOLVED, so it stays as an audit line without being carried into another
 * child's prompt.
 *
 * Tabs in an emitted fact are normalised to spaces before storage, which is what
 * keeps the separator unambiguous. The cap holds too — sixty further facts leave
 * MAX_NOTES stored. Failures are swallowed: the cache is a sharpener, never a
 * blocker.
 */
export async function appendEnvNotes(
    cwd: string,
    notes: readonly EmittedNote[],
    origin = '',
    runId = ''
): Promise<void> {
    const fresh: EnvNote[] = []
    for (const note of notes) {
        const fact = note.fact.trim().replace(/\t/g, ' ')
        const subject = note.subject.trim().replace(/\t/g, ' ')
        if (fact.length === 0 || subject.length === 0) continue
        fresh.push({
            fact,
            origin: origin.trim(),
            runId: runId.trim(),
            subject,
            // The field is the resolved FLAG as well as its provenance, so an
            // unattributed retraction still needs a value to survive the round-trip.
            ...(note.resolved ? {resolvedBy: origin.trim() || 'unrecorded'} : {})
        })
    }
    await ledger.append(cwd, fresh)
}

function noteLine(n: EnvNote): string {
    const origin = n.origin ? ` — recorded by ${n.origin}` : ' — origin unrecorded'
    const flag =
        isExcuseNote(n.fact) ?
            '  [EXCUSE-CLASS — re-validate in the CURRENT tree before citing this to wave off any failure]'
        :   ''
    return `- ${n.fact}${origin}${flag}`
}

/**
 * The prompt block a gate child receives when notes exist. Two things are
 * load-bearing: the no-waiver caveat (facts save re-discovery time but grant no
 * license to prepare/repair) and the trust discipline (a note is second-hand
 * until re-validated; an EXCUSE-CLASS note may not wave off a failure without a
 * live re-check; a grep of a generated artifact is not evidence of absence).
 *
 * THIS RUN leads. A fact measured by a sibling task minutes ago describes the tree
 * the child is standing in; one from a run last week describes a tree that has
 * moved since, and reading the two as one list is how a stale fact gets cited as
 * current. Resolved subjects are dropped from both lists: a retracted claim is
 * exactly the thing that must not be carried forward. `runId` '' (a cache written
 * before runs were stamped) reads as an earlier run.
 */
export function buildEnvNotesBlock(raw: string, runId = ''): string {
    const notes = parseEnvNotes(raw).filter(n => n.resolvedBy === undefined)
    if (notes.length === 0) return ''
    const inRun = (n: EnvNote): boolean => runId.length > 0 && n.runId === runId
    const mine = notes.filter(inRun)
    const earlier = notes.filter(n => !inRun(n))
    const earlierBlock =
        earlier.length === 0 ? []
        : mine.length === 0 ? earlier.map(noteLine)
        : ['', 'From EARLIER runs (an older tree — trust these less):', ...earlier.map(noteLine)]
    return [
        'KNOWN ENVIRONMENT FACTS — recorded by earlier verification passes in this run',
        '(second-hand, may be stale or WRONG):',
        ...mine.map(noteLine),
        ...earlierBlock,
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
    '  ENV-NOTE[<subject>]: <one-line fact>',
    'anywhere in your answer, one per fact. <subject> names WHAT the fact is about in a word or',
    'two — the service, the tool, the command (`postgres:5432`, `bun test`, `docker compose`).',
    'It is the cache key: a fact you emit under a subject REPLACES the one recorded for it, so',
    'a re-measurement corrects the record instead of stacking another copy beside it. If a fact',
    'listed above turns out NOT to be true any more, retract it with',
    '  ENV-NOTE-RESOLVED[<subject>]: <what you observed instead>',
    'A fact is something you OBSERVED to be true of the',
    'machine or environment — never a task verdict, never spec content, never a judgment about',
    'the code. In particular do NOT record an absence you inferred from grepping a built or',
    'minified artifact (identifiers there are mangled — a zero-hit grep proves nothing), and',
    'do NOT record "X is pre-existing / unrelated / not my task": that is a verdict, not an',
    'environment fact. These are cached for later verification passes in this run so they do',
    'not re-discover the same things.'
].join('\n')
