/**
 * root-cause-repair — turn a verify-FAIL that was CAUSED by another task's file
 * into a scoped repair task in the running plan.
 *
 * The failure class this closes: one task ships a broken shared file — a test
 * teardown, say — and that file then FAILS later, unrelated tasks. Each of those
 * FAILs is recorded as a debt naming the same root cause, and nothing schedules a
 * fix: every later task keeps hitting it, and each one's enforce pass can be
 * reverted over a defect it did not create.
 *
 * The channel here is deliberately narrow, because a false positive costs a whole
 * task slot and mutates a running plan. Three independent conditions must ALL hold:
 *
 *   1. TEXT — the FAIL reason (or the resolution research's rationale) carries an
 *      explicit blame cue ("pre-existing", "created by TASK_nnnn", "bug in", "this
 *      task did not modify") and a path token near it. Merely MENTIONING a path is
 *      not blame: a FAIL that quotes the spec's own "Preserve all existing files
 *      on disk" alongside a path must not spawn a repair task for that path.
 *   2. PROVENANCE — the blamed file was introduced by a DIFFERENT task's commit
 *      (task-provenance.ts). Unknown provenance is never evidence.
 *   3. AUTHORSHIP — the current task's own work does not touch the blamed file. If
 *      this task edited it, the defect may well be its own and the ordinary
 *      autofix/revert path is right.
 *
 * Environment-attributed failures are vetoed outright ("no PostgreSQL database
 * server is available in this environment"). No file edit repairs a missing
 * daemon, so a repair task there would be a guaranteed non-converging FAIL.
 *
 * Everything downstream is deduplicated by FILE: N debts naming one root file
 * yield exactly ONE repair task per run. The repair task itself is just an
 * ordinary plan entry — if it fails, it lands in the ledger like any other task
 * and is never re-spawned, which is what keeps this from looping.
 */
import {makeLedger} from './ledger.js'

/** A path-like token: at least one directory separator, ending in a file name. */
const PATH_TOKEN_RE = /(?:[\w.@-]+\/)+[\w.@-]+\.\w+/g

/**
 * Phrases that ATTRIBUTE a failure to something that predates the current task.
 * Each is a blame cue: the path token nearest a cue is the accused file. Kept
 * deliberately specific — a bare "existing" matches the spec boilerplate
 * "Preserve all existing files on disk" that a task FAIL quotes.
 */
const BLAME_CUE_RE =
    /pre-?\s?existing|existing (?:bug|defect|failure|issue|fault)|(?:created|introduced|added|written) (?:by|in) TASK_\d+|(?:bug|defect|fault|error) in\b|already (?:broken|failing|red)|(?:this task )?did not (?:modify|touch|create|change)|not (?:modified|touched|created|introduced) by this task|unrelated to this task/gi

/**
 * Failures the environment causes, not a file. No edit to any file repairs a
 * missing database server, so these must never open the repair channel. The
 * canonical shape is "no PostgreSQL database server is available in this
 * environment (no binary, no Docker, no listener on port 5432)".
 */
const ENVIRONMENT_BLAME_RE =
    /no (?:postgres|postgresql|mysql|database|redis|docker|network|internet|display)\b|not (?:installed|available|running|present) (?:in|on|for) (?:this |the )?(?:env|environment|sandbox|container|machine|image|system)|(?:environment|env|sandbox|container) (?:gap|limitation|lacks|has no|does not (?:have|provide))|no (?:binary|listener|daemon|server) (?:on|for|available)|missing (?:binary|executable|system (?:tool|package)|runtime)|is not installed|command not found/i

/** How far from a blame cue a path token may sit and still be the accused file. */
const BLAME_WINDOW = 160
/** A recorded defect summary is one clamped line, not prose. */
const MAX_DEFECT_LENGTH = 160
/** Ledger ceiling — a pathological run cannot grow the queue unboundedly. */
const MAX_QUEUED = 40
const REPAIR_QUEUE_FILE = 'repair-queue.md'
const FIELD_SEP = '\t'

/** One file accused of causing another task's verify FAIL. */
export interface RepairCandidate {
    /** Repo-relative path of the accused file. */
    file: string
    /** The task whose commit introduced `file` (provenance). */
    owner: string
    /** One-line summary of the defect, lifted from the FAIL text. */
    defect: string
    /** The task whose verify FAILed because of it. */
    blamedTask: string
    /** The failing command from the debt — becomes the repair task's VERIFY. */
    verifyCommand?: string
}

/** True when the FAIL text blames the ENVIRONMENT rather than a file. */
export function isEnvironmentAttributed(text: string): boolean {
    return ENVIRONMENT_BLAME_RE.test(text)
}

interface Accusation {
    file: string
    /** Character distance between the blame cue and the path token. */
    distance: number
    /** The clause the accusation was made in — the defect summary source. */
    clause: string
}

/**
 * The single file a FAIL text accuses, or null. Scans every blame cue, pairs it
 * with the NEAREST path token within {@link BLAME_WINDOW} characters (a cue and its
 * subject sit adjacent in practice: "pre-existing teardown bug in
 * `test/teardown.ts`"), and keeps the closest pair overall. One FAIL has one root
 * cause, so this deliberately returns at most one accusation rather than every
 * path the reason happens to name.
 */
export function findAccusedFile(text: string): Accusation | null {
    if (text.trim().length === 0) return null
    const paths = [...text.matchAll(PATH_TOKEN_RE)].map(m => ({
        value: m[0],
        start: m.index!,
        end: m.index! + m[0].length
    }))
    if (paths.length === 0) return null
    let best: Accusation | null = null
    // matchAll on a /g regex is safe here (fresh iterator, no shared lastIndex).
    for (const cue of text.matchAll(BLAME_CUE_RE)) {
        const cueStart = cue.index!
        const cueEnd = cueStart + cue[0].length
        for (const p of paths) {
            const distance =
                p.start >= cueEnd ? p.start - cueEnd
                : p.end <= cueStart ? cueStart - p.end
                : 0
            if (distance > BLAME_WINDOW) continue
            if (best === null || distance < best.distance) {
                best = {file: p.value, distance, clause: clauseAround(text, cueStart)}
            }
        }
    }
    return best
}

/**
 * The sentence/clause a character offset sits in. Splitting on sentence and dash
 * boundaries keeps the defect summary to the accusation itself instead of the
 * whole multi-clause FAIL reason.
 */
function clauseAround(text: string, offset: number): string {
    const before = text.slice(0, offset)
    const startMatch = /[.;]\s|\s—\s/g
    let start = 0
    for (const m of before.matchAll(startMatch)) start = m.index! + m[0].length
    const after = text.slice(offset)
    const endMatch = /[.;]\s|\s—\s/.exec(after)
    const end = endMatch ? offset + endMatch.index : text.length
    return text.slice(start, end).trim()
}

/**
 * Collapse whitespace and clamp — a stored defect summary is one short line that
 * has to read well inside a plan title. The gate's own verdict boilerplate ("work
 * did not verify: ") and a leading repeat of the accused file are stripped: the
 * title already names both the step kind and the file, so repeating them there
 * spends the clamp budget on nothing.
 */
export function summariseDefect(clause: string, file?: string): string {
    let out = clause.replace(/\s+/g, ' ').trim()
    out = out.replace(/^work (?:did not verify|unobserved|is unverified)\s*:\s*/i, '')
    if (file) {
        const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        out = out.replace(
            new RegExp(`^\`?${escaped}\`?\\s+(?:has|had|contains)\\s+an?\\s+`, 'i'),
            ''
        )
    }
    out = out.replace(/^[,\-—:\s]+/, '').trim()
    // Drop trailing consequence clauses — "X is broken, which means the VERIFY
    // command fails" restates the FAIL; the repair task only needs the X.
    out = out.replace(/,\s*(?:which|so|meaning|causing the VERIFY)\b.*$/i, '')
    if (out.length <= MAX_DEFECT_LENGTH) return out
    const cut = out.slice(0, MAX_DEFECT_LENGTH)
    const lastSpace = cut.lastIndexOf(' ')
    return `${(lastSpace > MAX_DEFECT_LENGTH / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

/**
 * A runnable command quoted in the FAIL text — the repair task's VERIFY, per the
 * requirement that it re-run the exact command the debt failed on. Only the first
 * backticked token that STARTS like a shell command (optionally env-prefixed)
 * qualifies, so prose in backticks is never mistaken for a command.
 */
export function extractFailingCommand(text: string): string | undefined {
    const RUNNER =
        /^(?:[A-Z][A-Z0-9_]*=\S+\s+)*(?:bun|npm|pnpm|yarn|npx|node|deno|make|cargo|go|python3?|pytest|dotnet|mvn|gradle)\b\s+\S/
    for (const m of text.matchAll(/`([^`\n]+)`/g)) {
        const cmd = m[1].trim()
        if (RUNNER.test(cmd)) return cmd
    }
    return undefined
}

export interface RootCauseInput {
    /** The verify gate's FAIL reason. */
    failReason: string
    /** The resolution research's rationale, when one ran ('' otherwise). */
    rationale?: string
    /** The task whose verify FAILed. */
    currentTaskId: string
    /**
     * Paths the CURRENT task's own work touches. `null` means unknown (git
     * unavailable) — the channel stands down rather than guessing, so an
     * unreadable tree can only cost a repair task, never spawn a wrong one.
     */
    touched: string[] | null
    /** file → introducing task (task-provenance.ts). May throw; a throw reads
     *  as unknown provenance. */
    introducedBy: (rel: string) => string | null | Promise<string | null>
}

/**
 * The repair candidate a verify FAIL justifies, or null. All three conditions from
 * the module header must hold; anything unknown or environment-shaped returns null.
 */
export async function findRepairCandidate(input: RootCauseInput): Promise<RepairCandidate | null> {
    const current = input.currentTaskId.trim()
    if (current.length === 0) return null
    if (input.touched === null) return null
    const text = [input.failReason, input.rationale ?? '']
        .filter(t => t.trim().length > 0)
        .join(' ')
    if (text.trim().length === 0) return null
    if (isEnvironmentAttributed(text)) return null
    const accused = findAccusedFile(text)
    if (!accused) return null
    // AUTHORSHIP: a file this task's own work touches is not somebody else's bug.
    // Suffix-compare so an absolute or `./`-prefixed status path still matches.
    const touchedSet = input.touched.map(t => normalisePath(t))
    const file = normalisePath(accused.file)
    if (touchedSet.some(t => t === file || t.endsWith(`/${file}`) || file.endsWith(`/${t}`))) {
        return null
    }
    let owner: string | null
    try {
        owner = await input.introducedBy(accused.file)
    } catch {
        owner = null
    }
    if (!owner || owner === current) return null
    return {
        file: accused.file,
        owner,
        defect: summariseDefect(accused.clause, accused.file),
        blamedTask: current,
        ...(extractFailingCommand(text) ? {verifyCommand: extractFailingCommand(text)} : {})
    }
}

function normalisePath(p: string): string {
    return p.replace(/^\.\//, '').replace(/^\/+/, '').trim()
}

// ─── Durable queue ───────────────────────────────────────────────────────────
//
// The gate sequence (task-gates.ts) DETECTS candidates; the /task-auto loop is
// what may mutate the plan. They are decoupled through a small ledger under
// `.pi-tasks/` — the same durability contract as accept-debt.ts: it survives
// discardEdits and the git-state guard, and a resume picks up what a crash left.

export function repairQueueFile(cwd: string): string {
    return ledger.path(cwd)
}

function serialize(c: RepairCandidate): string {
    return [c.file, c.owner, c.blamedTask, c.verifyCommand ?? '', c.defect]
        .map(f => f.replace(/[\t\n]+/g, ' ').trim())
        .join(FIELD_SEP)
}

/** Parse the stored queue. Malformed lines are skipped, never thrown on. */
export function parseRepairQueue(raw: string): RepairCandidate[] {
    const out: RepairCandidate[] = []
    for (const line of raw.split('\n')) {
        const t = line.trim()
        if (t.length === 0) continue
        const parts = t.split(FIELD_SEP)
        if (parts.length < 5) continue
        const [file, owner, blamedTask, verifyCommand, defect] = parts
        if (!file.trim() || !owner.trim()) continue
        out.push({
            file: file.trim(),
            owner: owner.trim(),
            blamedTask: blamedTask.trim(),
            defect: defect.trim(),
            ...(verifyCommand.trim() ? {verifyCommand: verifyCommand.trim()} : {})
        })
    }
    return out
}

/**
 * The queue. Keyed on file + blamed task ("cap 1 repair task per file per run" is
 * enforced at drain; here a re-detection of the same accusation is a return, not a
 * second record — hence `onNoop: 'skip'`).
 */
const ledger = makeLedger<RepairCandidate>({
    file: REPAIR_QUEUE_FILE,
    max: MAX_QUEUED,
    key: x => `${x.file.toLowerCase()} ${x.blamedTask.toLowerCase()}`,
    serialize,
    parse: parseRepairQueue,
    onNoop: 'skip'
})

/** Append one candidate. Best-effort — the queue never blocks a gate. */
export async function recordRepairCandidate(cwd: string, c: RepairCandidate): Promise<void> {
    await ledger.append(cwd, [c])
}

/**
 * Read the queue and CLEAR it. Draining is what makes the "cap 1 repair task per
 * file per run" bound hold without a second ledger: whatever is drained either
 * becomes a plan entry (which is then itself the dedup key — see
 * {@link planHasRepairFor}) or was already covered by one.
 */
export async function drainRepairQueue(cwd: string): Promise<RepairCandidate[]> {
    const parsed = await ledger.read(cwd)
    if (parsed.length === 0) return []
    // Best-effort clear; a failed clear at worst re-offers candidates that
    // planHasRepairFor then rejects.
    await ledger.write(cwd, [])
    return parsed
}

/** One merged repair per file, carrying every task the defect FAILed. */
export interface MergedRepair {
    file: string
    owner: string
    defect: string
    blamed: string[]
    verifyCommand?: string
}

/**
 * Collapse candidates by file — MANDATORY dedup: two debts naming the same file
 * must yield exactly ONE repair task naming both blamed tasks. Keyed on the
 * NORMALISED path, so `./x.ts` and `x.ts` are one entry. First record wins for
 * defect and command (they describe the same fault); blamed tasks accumulate in
 * first-seen order.
 */
export function mergeRepairCandidates(candidates: RepairCandidate[]): MergedRepair[] {
    const byFile = new Map<string, MergedRepair>()
    for (const c of candidates) {
        const key = normalisePath(c.file).toLowerCase()
        const prev = byFile.get(key)
        if (!prev) {
            byFile.set(key, {
                file: c.file,
                owner: c.owner,
                defect: c.defect,
                blamed: c.blamedTask ? [c.blamedTask] : [],
                ...(c.verifyCommand ? {verifyCommand: c.verifyCommand} : {})
            })
            continue
        }
        if (c.blamedTask && !prev.blamed.includes(c.blamedTask)) prev.blamed.push(c.blamedTask)
        if (!prev.verifyCommand && c.verifyCommand) prev.verifyCommand = c.verifyCommand
    }
    return [...byFile.values()]
}

// ─── Plan entry ──────────────────────────────────────────────────────────────

/** Machine-recognisable prefix, so a repair entry can be found in a plan again. */
export const REPAIR_TITLE_PREFIX = 'repair '

/**
 * The plan title for a repair task, in the fixed shape
 * `repair <file>: <defect> (root cause of TASK_A, TASK_B debts)`. The file sits
 * immediately after the prefix so {@link parseRepairTitleFile} can recover it —
 * that recovery is both the dedup key and how the loop knows to attach the
 * repair scope fence.
 */
export function buildRepairTitle(r: MergedRepair): string {
    const blame = r.blamed.length > 0 ? ` (root cause of ${r.blamed.join(', ')} debts)` : ''
    return `${REPAIR_TITLE_PREFIX}${r.file}: ${r.defect}${blame}`
}

/** The file a repair title names, or null when the title is not a repair entry. */
export function parseRepairTitleFile(title: string): string | null {
    const m = /^repair\s+((?:[\w.@-]+\/)*[\w.@-]+\.\w+)\s*:/.exec(title.trim())
    return m ? m[1] : null
}

/**
 * Is a repair for `file` ALREADY in the plan? This is the cap-1-per-file-per-run
 * bound: it counts checked-off entries too, so a repair task that ran and FAILed
 * is never re-spawned — it lands in the accept-debt ledger like any other task.
 */
export function planHasRepairFor(titles: string[], file: string): boolean {
    const want = normalisePath(file).toLowerCase()
    return titles.some(t => {
        const f = parseRepairTitleFile(t)
        return f !== null && normalisePath(f).toLowerCase() === want
    })
}

/**
 * The extra scope fence a repair entry carries into refine. A repair title names
 * one file and one narrow defect, which refine will otherwise re-expand into
 * "overhaul the test infrastructure". The fence pins the single editable file and
 * pins the VERIFY to the exact command the debt failed on.
 */
export function buildRepairScopeFence(file: string, verifyCommand?: string): string {
    return [
        `REPAIR TASK — this step exists ONLY to fix one specific pre-existing defect in`,
        `\`${file}\`. It was created because that file made OTHER tasks' verification fail;`,
        `it is not a feature step and must not grow into one.`,
        '',
        'HARD CONSTRAINTS for this step (they override any broader reading of the title):',
        `  - \`${file}\` is the ONLY file you may modify. Do not refactor, restructure, or`,
        '    "improve" anything else, and do not create new files.',
        '  - Fix the named defect and nothing more. Do NOT redesign the test harness, the',
        '    build, the schema, or any shared infrastructure — a wider change here would',
        "    silently overwrite sibling tasks' shipped work.",
        '  - Do not delete or weaken any existing test to make the command pass.',
        verifyCommand ?
            `  - The VERIFY block MUST be exactly: \`${verifyCommand}\` — the command this`
            + '    defect was failing. It passing is the whole acceptance criterion.'
        :   '  - The VERIFY block MUST re-run the command the defect was failing, unaided.'
    ].join('\n')
}
