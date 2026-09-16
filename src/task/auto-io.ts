/**
 * AUTO-file I/O & parsing for /task-auto.
 *
 * Thin layer over task-io/task-parsers: a TASK_AUTO_NNNN.md is a normal task
 * file — the same front matter, parsed by the same `parseFrontMatter` — whose
 * body holds `## feature prompt`, `## clarifications`, `## tasks` and optionally
 * `## coverage`. The checkbox list under `## tasks` is the resume cursor, and the
 * loop finds its next step with `entries.find(e => !e.done)` rather than a
 * remembered position.
 *
 * A checkbox line reads `- [ ] P01 TASK_0006 a2  title` — see {@link ENTRY_RE}.
 */
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import {tasksDir, ensureTasksDir, readTaskFile, setTaskSection} from './task-io.js'
import {extractSection, parseFrontMatter} from './task-parsers.js'
import {readTextFile} from '../shared/fs-text.js'
import {RESUMABLE_STATES} from './task-types.js'
import type {TaskState} from './task-types.js'
import type {AutoResumeCandidate} from './resume-gap.js'
import {RUN_END_POLICY, type RunEndKind} from './run-end.js'

const AUTO_FILE_RE = /^(TASK_AUTO_\d{4,})\.md$/

export interface TaskEntry {
    /** Position in the list — shifts when a repair step is spliced in. */
    index: number
    /**
     * The entry's stable identity, allocated at plan time and never reused.
     * `index` moves and `title` is prose a later pass may rewrite; this is what
     * the owned-requirements ledger joins on. Absent on an AUTO file written
     * before the key existed, where the title join is still the only one there is.
     */
    key?: string
    title: string
    done: boolean
    producedId?: string
    /** How many implementation attempts this entry has had. */
    attempts?: number
    /**
     * How the last attempt ENDED, recorded only when it ended abnormally. A
     * resume otherwise cannot tell an entry the user cancelled from one that
     * faulted, because both leave the same unchecked, stamped line.
     */
    lastEnd?: RunEndKind
}

export async function allocateAutoId(cwd: string): Promise<string> {
    await ensureTasksDir(cwd)
    const entries = await fsp.readdir(tasksDir(cwd))
    let max = 0
    for (const e of entries) {
        const m = AUTO_FILE_RE.exec(e)
        if (m) {
            const n = parseInt(m[1].slice('TASK_AUTO_'.length), 10)
            if (n > max) max = n
        }
    }
    return `TASK_AUTO_${String(max + 1).padStart(4, '0')}`
}

/**
 * Parse a decompose-phase model output into a clean list of titles.
 *
 * No cap: every title the model emits is kept — 100 lines in, 100 titles out.
 * A ceiling here would be invisible and self-defeating, because it would clip the
 * tail of a large plan AND re-clip every coverage retry, so a design that
 * genuinely needs more tasks than the ceiling could never grow past it — it would
 * burn its coverage rounds and ship a knowingly-gapped plan. The real bound is
 * the design's own grounded-requirement scope, enforced downstream by the
 * coverage loop; this parser must not pre-empt it.
 *
 * Accepts checkbox, bare-dash and numbered forms (`1.` and `2)`), indented or
 * not, and skips prose lines and empty bullets.
 */
export function parseDecomposeList(raw: string): string[] {
    const out: string[] = []
    for (const line of raw.split('\n')) {
        const m = /^\s*(?:-\s*\[\s*[xX ]?\s*\]\s*|-\s+|\d+[.)]\s+)(.+?)\s*$/.exec(line)
        if (m && m[1].trim().length > 0) out.push(m[1].trim())
    }
    return out
}

/** The MISSING bound the coverage prompt states; a longer list is truncated
 *  rather than rejected. */
const MAX_MISSING_AREAS = 8

/** Parsed DECOMPOSE_COVERAGE_PROMPT verdict. */
export type CoverageVerdict =
    | {kind: 'complete'; missing: string[]}
    | {kind: 'incomplete'; missing: string[]}
    /** The judge DID rule INCOMPLETE but named nothing to reprompt with. */
    | {kind: 'unparseable'}

/** What an `unparseable` verdict contributes to the plan's missing-area list, so
 *  the judge's own INCOMPLETE cannot be shipped as COMPLETE. */
export const UNNAMED_COVERAGE_GAP =
    'the coverage judge ruled INCOMPLETE without naming the uncovered area'

/**
 * Parse the coverage-triage child's verdict. Returns null when no COVERAGE tag is
 * present at all (the model wrote prose), and the caller reads a null verdict as
 * an empty missing-list, so a malformed judgment can never block planning.
 *
 * `COVERAGE: INCOMPLETE` with no MISSING lines is NOT null, and that distinction
 * is the whole point: prose is no verdict, while this is a verdict of INCOMPLETE
 * that happens to name nothing. Collapsing the two shipped a plan the judge had
 * just ruled incomplete, logged as COMPLETE.
 */
export function parseCoverageVerdict(raw: string): CoverageVerdict | null {
    const tag = /^\s*COVERAGE:\s*(COMPLETE|INCOMPLETE)\s*$/im.exec(raw)
    if (!tag) return null
    if (tag[1].toUpperCase() === 'COMPLETE') return {kind: 'complete', missing: []}
    const missing: string[] = []
    for (const line of raw.split('\n')) {
        const m = /^\s*MISSING:\s*(.+?)\s*$/i.exec(line)
        if (m && m[1].length > 0) missing.push(m[1])
        if (missing.length >= MAX_MISSING_AREAS) break
    }
    return missing.length === 0 ? {kind: 'unparseable'} : {kind: 'incomplete', missing}
}

const CHECKBOX_RE = /^- \[([ xX])\]\s+(.+?)\s*$/

/**
 * The checkbox line grammar: `- [ ] P01 TASK_0006 a2  title`, where the attempts
 * field may carry how the last attempt ended — `a2:failed`.
 *
 * Every field is optional and each is followed by ONE space; the title is set off
 * by an EXTRA space. That two-space delimiter is what keeps the grammar
 * unambiguous against prose: a title of its own may begin `TASK_0006 is broken`
 * or `(auto) …` and is read whole, because a single space never separates a field
 * from a title. Both legacy forms — `TASK_0006  title` and a bare `title` — are
 * the same grammar with fields missing, so no migration pass is needed on read.
 *
 * The end suffix spells out the endings RUN_END_POLICY registers rather than
 * accepting any word, so `a2:whatever ` stays prose and a renamed ending is a
 * parse miss, never a silently mis-read field.
 */
const ENTRY_RE = new RegExp(
    '^(?:(?:(P\\d{2,}) )?(?:(TASK_\\d{4,}) )?'
        + `(?:a(\\d+)(?::(${Object.keys(RUN_END_POLICY).join('|')}))? )? )?(.+)$`
)

function parseEntryLine(line: string, index: number): TaskEntry | null {
    const m = CHECKBOX_RE.exec(line.trim())
    if (!m) return null
    const f = ENTRY_RE.exec(m[2].trim())
    if (!f) return null
    const [, key, producedId, attempts, lastEnd, title] = f
    // Attempts are only ever written alongside an id (they are minted when the
    // inner task starts), so a bare `a7  …` is a title, not a field.
    const keyed = key !== undefined || producedId !== undefined
    return {
        index,
        done: m[1].toLowerCase() === 'x',
        // A line carries a stamped TASK_NNNN id both when done (the completed
        // inner task) and when merely started — an unchecked, stamped line is an
        // in-progress entry whose inner task can be resumed.
        ...(key !== undefined && {key}),
        ...(producedId !== undefined && {producedId}),
        ...(keyed && attempts !== undefined && {attempts: parseInt(attempts, 10)}),
        ...(keyed && lastEnd !== undefined && {lastEnd: lastEnd as RunEndKind}),
        title: keyed || attempts === undefined ? title.trim() : m[2].trim()
    }
}

/**
 * Render one entry back into the line grammar.
 *
 * An entry with NEITHER a key nor an id has no field to anchor an attempts count
 * against, and `a2  title` alone re-parses as a title (see {@link ENTRY_RE}) — so
 * the count is dropped rather than written into a line that would read it back as
 * prose. Only pre-key legacy plans are in that state, and they predate the counter.
 */
function renderEntryLine(e: Omit<TaskEntry, 'index'>): string {
    const anchored = e.key !== undefined || e.producedId !== undefined
    const attempts =
        e.attempts === undefined || !anchored ?
            undefined
        :   `a${e.attempts}${e.lastEnd === undefined ? '' : `:${e.lastEnd}`}`
    const fields = [e.key, e.producedId, attempts]
        .filter((f): f is string => f !== undefined && f.length > 0)
        .join(' ')
    return `- [${e.done ? 'x' : ' '}] ${fields.length > 0 ? `${fields}  ` : ''}${e.title}`
}

/** The plan key for the `index`th entry of a freshly planned list. */
export function planKeyAt(index: number): string {
    return `P${String(index + 1).padStart(2, '0')}`
}

/**
 * The lowest key number no entry in `entries` holds. Keys are allocated 1:1 with
 * plan entries, so an unkeyed legacy list has implicitly spent its first N
 * numbers — counting it in keeps a spliced repair step from minting a key an
 * eventual migration would hand to an existing entry.
 */
export function nextPlanKey(entries: readonly TaskEntry[]): string {
    const highest = entries.reduce(
        (max, e) => Math.max(max, e.key ? parseInt(e.key.slice(1), 10) : 0),
        entries.length
    )
    return planKeyAt(highest)
}

/** Parse the "## tasks" checkbox list. */
export function parseTaskList(body: string): TaskEntry[] {
    const section = extractSection(body, 'tasks')
    if (section === null) return []
    const entries: TaskEntry[] = []
    for (const line of section.split('\n')) {
        const entry = parseEntryLine(line, entries.length)
        if (entry) entries.push(entry)
    }
    return entries
}

/** Build the initial AUTO-file body. `coverage` is the requirement-level
 *  accounting summary — a durable, user-visible record of what was carried
 *  cross-cutting and what stayed unowned. An empty string omits the section
 *  entirely rather than emitting a blank heading. */
export function buildAutoBody(
    feature: string,
    clarifications: string,
    titles: string[],
    coverage = ''
): string {
    const tasks = titles
        .map((t, i) => renderEntryLine({key: planKeyAt(i), title: t, done: false}))
        .join('\n')
    return (
        `\n## feature prompt\n\n${feature.trim() || '(none)'}\n\n`
        + `## clarifications\n\n${clarifications.trim() || '(none)'}\n\n`
        + `## tasks\n\n${tasks}\n`
        + (coverage.trim().length > 0 ? `\n## coverage\n\n${coverage.trim()}\n` : '')
    )
}

/**
 * Rewrite the Nth checkbox line of the "## tasks" section in place. `render`
 * receives the line as parsed, so a rewrite that only changes one field carries
 * the others — a check-off must not drop the key the ownership join reads.
 */
async function rewriteTaskLine(
    cwd: string,
    id: string,
    index: number,
    render: (entry: TaskEntry) => string,
    label: string
): Promise<void> {
    const {body} = await readTaskFile(cwd, id)
    const section = extractSection(body, 'tasks') ?? ''
    const lines = section.split('\n')
    let seen = -1
    for (let i = 0; i < lines.length; i++) {
        const entry = parseEntryLine(lines[i], seen + 1)
        if (!entry) continue
        seen++
        if (seen === index) {
            lines[i] = render(entry)
            break
        }
    }
    if (seen < index) {
        throw new Error(
            `${label}: index ${index} out of range in ${id} (only ${seen + 1} checkboxes found)`
        )
    }
    await setTaskSection(cwd, id, 'tasks', lines.join('\n'))
}

/** Check off the Nth checkbox line, stamping the produced TASK_NNNN id. */
export async function checkOffTask(
    cwd: string,
    id: string,
    index: number,
    producedId: string,
    title: string
): Promise<void> {
    await rewriteTaskLine(
        cwd,
        id,
        index,
        e => renderEntryLine({...e, done: true, title, producedId: producedId || undefined}),
        'checkOffTask'
    )
}

/**
 * Stamp the inner TASK_NNNN id onto the Nth (still-unchecked) entry the moment
 * the inner task is allocated. This links the AUTO entry to its in-progress
 * inner task so /task-auto-resume can continue it from its saved phase instead
 * of starting a brand-new task — matching how /task-resume behaves.
 *
 * The first stamp is also where the attempt counter is minted: an entry under way
 * has had one attempt.
 */
export async function stampTaskInProgress(
    cwd: string,
    id: string,
    index: number,
    producedId: string,
    title: string
): Promise<void> {
    await rewriteTaskLine(
        cwd,
        id,
        index,
        e => renderEntryLine({...e, done: false, title, producedId}),
        'stampTaskInProgress'
    )
}

/**
 * Count one more attempt on the `index`th entry and return the new total.
 *
 * Called for a fresh start AND for a resume, because both spend a run on the
 * entry: a task that crashes in refine is re-entered from scratch every time, and
 * a counter that only saw fresh starts would read 1 forever while the loop re-ran
 * it without end. The previous ending is cleared here — it describes the attempt
 * that is now over.
 */
export async function beginTaskAttempt(cwd: string, id: string, index: number): Promise<number> {
    let attempts = 1
    await rewriteTaskLine(
        cwd,
        id,
        index,
        e => {
            attempts = (e.attempts ?? 0) + 1
            const {lastEnd: _ended, ...rest} = e
            return renderEntryLine({...rest, attempts})
        },
        'beginTaskAttempt'
    )
    return attempts
}

/** Record how the `index`th entry's attempt ended. */
export async function recordTaskEnd(
    cwd: string,
    id: string,
    index: number,
    lastEnd: RunEndKind
): Promise<void> {
    await rewriteTaskLine(
        cwd,
        id,
        index,
        e => renderEntryLine({...e, attempts: e.attempts ?? 1, lastEnd}),
        'recordTaskEnd'
    )
}

/** The bare title of a checkbox line (fields stripped), or null if not one. */
function entryTitle(line: string): string | null {
    return parseEntryLine(line, 0)?.title ?? null
}

/**
 * Insert a NEW unchecked entry directly after the `afterIndex`th checkbox — the
 * mid-run plan mutation the root-cause repair channel needs: a repair task must
 * land BEFORE the next dependent task, not at the end of the plan, or the defect
 * keeps failing everything in between.
 *
 * MONOTONIC by construction: this only ever SPLICES a line in. No existing entry
 * is rewritten, reordered or dropped, and an already-present title is a no-op —
 * so a plan can grow mid-run but never shrink, and a retried insert cannot
 * duplicate. Returns whether a line was added.
 *
 * Run against a real plan: inserting a new title after entry 0 returns true and
 * lands it directly after that entry; the same title again returns false; a title
 * that is already present AND CHECKED also returns false; an empty title returns
 * false. Everything else keeps its order.
 *
 * Later entries shift down by one, which is safe because the /task-auto loop
 * re-reads and re-parses the plan at the top of every iteration and locates its
 * next step with `entries.find(e => !e.done)` — first unchecked — rather than a
 * cached index.
 */
export async function insertTaskAfter(
    cwd: string,
    id: string,
    afterIndex: number,
    title: string
): Promise<boolean> {
    const clean = title.trim()
    if (clean.length === 0) return false
    const {body} = await readTaskFile(cwd, id)
    const section = extractSection(body, 'tasks') ?? ''
    const lines = section.split('\n')
    // Duplicate check scans the WHOLE list first: an existing entry with this exact
    // title (checked or not) means the plan already carries this step, wherever it
    // sits relative to afterIndex — never add a second one.
    if (lines.some(l => entryTitle(l) === clean)) return false
    const entries: TaskEntry[] = []
    let insertAt = -1
    for (let i = 0; i < lines.length; i++) {
        const entry = parseEntryLine(lines[i], entries.length)
        if (!entry) continue
        entries.push(entry)
        // A negative afterIndex means "before the first entry".
        if (entries.length === 1 && afterIndex < 0) insertAt = i
        if (entries.length - 1 <= afterIndex) insertAt = i + 1
    }
    // An out-of-range afterIndex is not an error: the loop above leaves `insertAt`
    // just past the LAST checkbox, so the entry is appended rather than lost — a
    // plan that grew underneath the caller must still receive it. Confirmed with
    // afterIndex 99 on a five-entry plan.
    //
    // The guard below is the different case: a `## tasks` section with NO checkbox
    // lines at all, where there is no position to splice into.
    if (insertAt === -1) return false
    lines.splice(
        insertAt,
        0,
        renderEntryLine({key: nextPlanKey(entries), title: clean, done: false})
    )
    await setTaskSection(cwd, id, 'tasks', lines.join('\n'))
    return true
}

/**
 * Insert a NEW unchecked entry directly BEFORE the `index`th checkbox — the
 * position a health repair needs: the task about to run must wait until the red
 * it would build on is fixed. Same monotonic, duplicate-refusing splice as
 * {@link insertTaskAfter}.
 */
export function insertTaskBefore(
    cwd: string,
    id: string,
    index: number,
    title: string
): Promise<boolean> {
    return insertTaskAfter(cwd, id, index - 1, title)
}

/**
 * Find the most-recently-updated resumable TASK_AUTO_* file, with the state and
 * last-write time the resume banner reports (see resume-gap.ts). Null when there
 * is nothing resumable.
 *
 * `states` narrows which states count as resumable BEFORE the newest-wins sort,
 * and that ordering is the whole point. The UNATTENDED path passes
 * UNATTENDED_STATES so the search answers the question it actually asks — "is
 * there an IN-FLIGHT run to pick up?"
 *
 * Filtering after the sort instead would let one failed run shadow an in-flight
 * one behind it. Demonstrated on two files, the newer `failed` and the older
 * `in_progress`: the default states pick the newer failed one, while
 * UNATTENDED_STATES picks the older in-progress one. Had the newest been chosen
 * first and only then refused on state, the restart would find nothing and the
 * in-flight run would sit in exactly the dead air this exists to end.
 */
export async function findResumableAutoDetailed(
    cwd: string,
    states: readonly TaskState[] = RESUMABLE_STATES
): Promise<AutoResumeCandidate | null> {
    await ensureTasksDir(cwd)
    const entries = await fsp.readdir(tasksDir(cwd))
    const candidates: AutoResumeCandidate[] = []
    for (const f of entries) {
        const m = AUTO_FILE_RE.exec(f)
        if (!m) continue
        try {
            const raw = await readTextFile(path.join(tasksDir(cwd), f))
            const fm = parseFrontMatter(raw)
            if (!fm) continue
            if (!states.includes(fm.state)) continue
            const st = await fsp.stat(path.join(tasksDir(cwd), f))
            candidates.push({id: m[1], state: fm.state, lastWriteMs: st.mtimeMs})
        } catch {
            /* skip unreadable */
        }
    }
    candidates.sort((a, b) => b.lastWriteMs - a.lastWriteMs)
    return candidates.length > 0 ? candidates[0] : null
}

/** Id-only form of {@link findResumableAutoDetailed}. */
export async function findResumableAuto(cwd: string): Promise<string | null> {
    return (await findResumableAutoDetailed(cwd))?.id ?? null
}
