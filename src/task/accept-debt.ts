/**
 * accept-debt — a per-run ledger of tasks the user ACCEPTED despite a verify-FAIL.
 *
 * The failure this closes (mx5 run 4 B3, carried open; run 8 fixture TASK_0012):
 * when a task's VERIFY gate FAILs and the resolution picker's ACCEPT branch is
 * chosen, the human blesses the artifact AS-IS — a real, recorded defect ships and
 * NOTHING revisits it. Run 8's TASK_0012 shipped a frozen-path violation that was
 * accepted and never re-checked; a later task could have fixed it, or it could
 * still be broken at run end, and no gate ever said which.
 *
 * Mechanism (mirrors env-notes.ts / contracts.ts): each ACCEPT-despite-FAIL is
 * appended HOST-SIDE to `.pi-tasks/accept-debt.md` as a durable `<taskId>\t<reason>`
 * record (the gate sequence never lets a child write the file — no artifact
 * corruption). The ledger lives under `.pi-tasks/`, so it survives discardEdits and
 * the git-state guard, both of which exclude that directory by design.
 *
 * RE-CHECK at run end (final-gate.ts): the final integration gate reads the ledger,
 * re-checks each debt against the CURRENT tree, and SURFACES the ones still open in
 * its report — a run may not complete silently carrying accepted verify-FAILs. The
 * re-check is FP-SAFE by construction: the only debt a deterministic check can
 * prove RESOLVED stack-agnostically is one whose FAIL was itself a deterministic
 * static/health failure (`repo health: …`) — resolved iff the gate's own static
 * check now passes (a later task fixed the statics). Every other class (behavioral,
 * frozen-path, model-judged) cannot be proven resolved without re-running the
 * model, so it is SURFACED, never auto-closed — biasing hard toward informing the
 * user rather than re-hiding a live defect. "Nothing still open = clean."
 */
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import {tasksDir} from './task-io.js'

const ACCEPT_DEBT_FILE = 'accept-debt.md'
/** Cap kept records so a run that accepts many FAILs cannot grow the report unboundedly. */
const MAX_DEBTS = 60
/** A recorded reason is one line; anything longer is truncated (it is a summary, not prose). */
const MAX_REASON_LENGTH = 300
/**
 * Field separator between a task id and its FAIL reason in the stored file. A tab
 * never occurs in the normalised one-line records written here, so it round-trips
 * cleanly and any stray tab in a reason is flattened to a space before storage.
 */
const FIELD_SEP = '\t'

/**
 * Provenance of a recorded defect:
 *   - 'accepted'       — the user chose ACCEPT despite a verify-FAIL (the original class).
 *   - 'enforce-revert' — an enforce-pass re-verify FAILED and the enforce edits were
 *     reverted; the FAIL indicted the ORIGINAL work (mx5 run 10 TASK_0004: "Missing
 *     server entry point … the Hono server cannot be started"), so the terminal defect
 *     was FOUND and then erased by the very mechanism that found it. Persisted here so
 *     the final gate re-checks and surfaces it instead of letting it die with the revert.
 *   - 'frozen-blocked' — a repo-health verify-FAIL whose only fix is an edit to a path
 *     THIS task's spec froze (mx5 run 12: `bun run lint` permanently red because the
 *     created files need a tsconfig registration every spec forbids). Cross-task
 *     contradiction: no unattended re-run can converge, so the gate loop records the
 *     defect and routes to the human picker instead of burning AUTOFIX rounds.
 *   - 'cross-task-deletion' — the task's work DELETED a sibling task's committed
 *     deliverable (mx5 run 12 PROMPT 2: a fix child deleted TASK_0020's playwright ct
 *     files to green a lint) and the user ACCEPTed the verify-FAIL anyway, so the
 *     deletion ships in the next commit. Recorded so the final gate re-checks it:
 *     resolved iff the named file is back in the tree (a later task restored it),
 *     otherwise surfaced.
 */
export type DebtOrigin = 'accepted' | 'enforce-revert' | 'frozen-blocked' | 'cross-task-deletion'

/** One recorded defect: the task, why its VERIFY failed, and how it was recorded. */
export interface AcceptDebt {
    taskId: string
    reason: string
    /** Absent in legacy 2-field records → treated as 'accepted'. */
    origin?: DebtOrigin
    /**
     * Set (never serialized) when the recorded reason CONFLICTS with the run itself:
     * it asserts a file's existence is the failure, but that file is another task's
     * committed deliverable (see annotateDebtConflicts). A conflicting debt is a
     * PLAN defect to surface, never an instruction to act on — mx5 run 11's autofix
     * child `rm`'d TASK_0008's verified admin page to satisfy exactly such a claim.
     */
    conflict?: string
}

export function acceptDebtFile(cwd: string): string {
    return path.join(tasksDir(cwd), ACCEPT_DEBT_FILE)
}

/** The raw stored ledger ('' when none recorded yet). Parse with parseAcceptDebts. */
export async function readAcceptDebtsRaw(cwd: string): Promise<string> {
    try {
        return (await fsp.readFile(acceptDebtFile(cwd), 'utf8')).trim()
    } catch {
        return ''
    }
}

/**
 * Parse the stored ledger into records. Fields are tab-separated: `id`, `reason`, and
 * an optional `origin` (legacy 2-field records have no origin → 'accepted'). Because a
 * stored reason is tab-normalised (see normaliseReason), splitting on the separator is
 * unambiguous. A line without any separator (a reason but no id, e.g. hand-edited)
 * parses with an empty taskId rather than being dropped — a recorded debt is never
 * silently lost.
 */
export function parseAcceptDebts(raw: string): AcceptDebt[] {
    const out: AcceptDebt[] = []
    for (const line of raw.split('\n')) {
        const t = line.trim()
        if (t.length === 0) continue
        const parts = t.split(FIELD_SEP)
        if (parts.length === 1) {
            out.push({taskId: '', reason: parts[0]!.trim()})
            continue
        }
        const origin = parts[2]?.trim()
        out.push({
            taskId: parts[0]!.trim(),
            reason: parts[1]!.trim(),
            ...((
                origin === 'enforce-revert'
                || origin === 'frozen-blocked'
                || origin === 'cross-task-deletion'
            ) ?
                {origin: origin as DebtOrigin}
            :   {})
        })
    }
    return out
}

/** Read + parse in one step. */
export async function readAcceptDebts(cwd: string): Promise<AcceptDebt[]> {
    return parseAcceptDebts(await readAcceptDebtsRaw(cwd))
}

function normaliseReason(reason: string): string {
    return reason
        .replace(/[\t\n]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_REASON_LENGTH)
}

function serialize(d: AcceptDebt): string {
    // Legacy 2-field shape for 'accepted' (backward compatible); a 3rd origin field
    // only for the non-accepted classes, so old readers/files round-trip unchanged.
    return d.origin && d.origin !== 'accepted' ?
            `${d.taskId}${FIELD_SEP}${d.reason}${FIELD_SEP}${d.origin}`
        :   `${d.taskId}${FIELD_SEP}${d.reason}`
}

/** Dedup key: same origin + task + reason is one debt (no double-record). */
function debtKey(d: AcceptDebt): string {
    return `${d.origin ?? 'accepted'} ${d.taskId.toLowerCase()} ${d.reason.toLowerCase()}`
}

/**
 * Append one accepted-despite-FAIL record, deduplicated against what is already
 * stored (case-insensitive on task id + reason), keeping the newest MAX_DEBTS.
 * Failures are swallowed — the ledger is an auditing aid, never a blocker of the
 * gate sequence that calls it.
 */
async function appendDebt(cwd: string, entry: AcceptDebt): Promise<void> {
    if (entry.reason.length === 0) return
    try {
        const existing = parseAcceptDebts(await readAcceptDebtsRaw(cwd))
        const seen = new Set(existing.map(debtKey))
        if (seen.has(debtKey(entry))) return
        const kept = [...existing, entry].slice(-MAX_DEBTS)
        await fsp.mkdir(tasksDir(cwd), {recursive: true})
        await fsp.writeFile(acceptDebtFile(cwd), kept.map(serialize).join('\n') + '\n', 'utf8')
    } catch {
        // best-effort ledger
    }
}

/** Record a user-ACCEPTED-despite-verify-FAIL debt. */
export async function recordAcceptDebt(cwd: string, taskId: string, reason: string): Promise<void> {
    await appendDebt(cwd, {taskId: taskId.trim(), reason: normaliseReason(reason)})
}

/**
 * Record an ENFORCE-REVERT debt (mx5 run 10 item 3): an enforce re-verify FAILED and
 * the enforce edits were reverted, but the FAIL indicted the ORIGINAL work — so the
 * defect is still in the shipped tree. Durable so the final gate re-checks/surfaces it
 * rather than letting it die with the revert.
 */
export async function recordEnforceRevertDebt(
    cwd: string,
    taskId: string,
    reason: string
): Promise<void> {
    await appendDebt(cwd, {
        taskId: taskId.trim(),
        reason: normaliseReason(reason),
        origin: 'enforce-revert'
    })
}

/**
 * Record a FROZEN-BLOCKED debt (mx5 run 12 / PROMPT 1 layer B): a repo-health FAIL
 * whose static findings can only be fixed by editing a path this task's spec froze —
 * a cross-task contradiction no unattended re-run may resolve. Recorded when the gate
 * loop routes to the picker (regardless of what the human then picks), so the final
 * gate re-checks it at run end. Static-class by reason prefix (`repo health: …`), so
 * it auto-closes iff the final gate's own static check passes.
 */
export async function recordFrozenBlockedDebt(
    cwd: string,
    taskId: string,
    reason: string
): Promise<void> {
    await appendDebt(cwd, {
        taskId: taskId.trim(),
        reason: normaliseReason(reason),
        origin: 'frozen-blocked'
    })
}

/**
 * Record a CROSS-TASK DELETION debt (mx5 run 12 PROMPT 2): the task's work deleted a
 * file a DIFFERENT task's commit introduced, verify FAILed, and the user ACCEPTed —
 * so the deletion survives into the next commit. The reason is a fixed machine-
 * parseable shape (`deleted \`<path>\` …`) so the final gate's re-check can extract
 * the path and prove the debt resolved iff the file is back in the tree.
 */
export async function recordCrossTaskDeletionDebt(
    cwd: string,
    taskId: string,
    deletion: {path: string; owner: string}
): Promise<void> {
    await appendDebt(cwd, {
        taskId: taskId.trim(),
        reason: normaliseReason(
            `deleted \`${deletion.path}\` — ${deletion.owner}'s committed deliverable, removed by this task's work`
        ),
        origin: 'cross-task-deletion'
    })
}

/**
 * The deleted path a cross-task-deletion debt names (the fixed shape
 * recordCrossTaskDeletionDebt writes). Null on any other reason text — an
 * unextractable path means the re-check cannot prove anything, so the debt
 * stays open (surface, never re-hide).
 */
export function extractDeletedDebtPath(reason: string): string | null {
    const m = /^deleted `([^`]+)`/.exec(reason.trim())
    return m ? m[1] : null
}

/** Overwrite the ledger with exactly these records (used to prune resolved debts). */
export async function writeAcceptDebts(cwd: string, debts: AcceptDebt[]): Promise<void> {
    try {
        await fsp.mkdir(tasksDir(cwd), {recursive: true})
        if (debts.length === 0) {
            await fsp.writeFile(acceptDebtFile(cwd), '', 'utf8')
            return
        }
        await fsp.writeFile(acceptDebtFile(cwd), debts.map(serialize).join('\n') + '\n', 'utf8')
    } catch {
        // best-effort ledger
    }
}

/**
 * STATIC-CLASS debt: one whose accepted FAIL was the deterministic whole-repo static
 * health check (`repo health: …`, the prefix runWorkVerification's repoHealth branch
 * emits). This is the ONE class a deterministic re-check can prove resolved
 * stack-agnostically — the final gate runs the same static check, so a later task
 * that fixed the statics resolves the debt. Every other reason is model-judged or
 * behavioral and cannot be proven resolved without re-running the model.
 */
export function isStaticClassDebt(reason: string): boolean {
    return /^\s*repo health:/i.test(reason)
}

/**
 * Re-check the ledger against the current run state. A static-class debt is RESOLVED
 * iff the final gate's own static check now passes (`staticOk`); a cross-task-deletion
 * debt is RESOLVED iff the file it names is back in the tree (`fileExists` — a later
 * task or a human restored it, so the deletion no longer holds); every other debt
 * stays OPEN (unprovable ⇒ surface, never re-hide). FP-safe: the only auto-closes are
 * ones a deterministic check can stand behind.
 */
export function recheckAcceptDebts(
    debts: AcceptDebt[],
    opts: {staticOk: boolean; fileExists?: (rel: string) => boolean}
): {open: AcceptDebt[]; resolved: AcceptDebt[]} {
    const open: AcceptDebt[] = []
    const resolved: AcceptDebt[] = []
    for (const d of debts) {
        if (d.origin === 'cross-task-deletion') {
            const p = extractDeletedDebtPath(d.reason)
            let restored: boolean
            try {
                restored = p !== null && opts.fileExists?.(p) === true
            } catch {
                restored = false // an existence-check fault is inconclusive, not proof
            }
            if (restored) resolved.push(d)
            else open.push(d)
            continue
        }
        if (opts.staticOk && isStaticClassDebt(d.reason)) resolved.push(d)
        else open.push(d)
    }
    return {open, resolved}
}

// ─── Conflicting-claim classification (mx5 run 11) ──────────────────────────
//
// A recorded debt is a CLAIM about the tree, not an instruction to change it. The
// one class a deterministic check can prove SELF-CONTRADICTORY is an
// existence-as-failure claim ("<path> exists" fails the verify) whose named path is
// a DIFFERENT task's committed deliverable: the plan shipped the file on purpose
// and a sibling's verify indicts it — a plan defect (sibling scope-fence leaked
// into a verify assertion), not a fixable fault. Run 11's TASK_0009 debt read
// "src/client/pages/admin.tsx exists (introduced by prior TASK_0008…)" and the
// final-gate autofix child, seeded with it, ran `rm` on the verified page.

/** A path-like token: at least one directory separator, ending in a file name. */
const PATH_TOKEN_RE = /(?:[\w.@-]+\/)+[\w.@-]+\.\w+/g

/**
 * Extract the paths whose EXISTENCE the reason asserts as the failure — a path
 * token immediately followed by "exists" / "still exists", or by "must/should not
 * exist". Only this narrow shape qualifies: a reason that merely MENTIONS a path
 * (a prohibition violation, a broken import) is an ordinary defect claim, not an
 * existence assertion, and must never be flagged (run 11's T1/T7 debts name paths
 * this way and are genuine).
 */
export function extractExistenceClaims(reason: string): string[] {
    const out: string[] = []
    for (const m of reason.matchAll(PATH_TOKEN_RE)) {
        const after = reason.slice(m.index! + m[0].length)
        if (
            /^\s+(?:still\s+)?exists\b/.test(after)
            || /^\s+(?:must|should)\s+not\s+exist\b/.test(after)
        ) {
            out.push(m[0])
        }
    }
    return [...new Set(out)]
}

/**
 * Annotate each debt whose existence-as-failure claim names a file INTRODUCED by a
 * different task's commit (per `introducedBy`, typically git history) with a
 * human-readable conflict statement. Everything degrades to no annotation: no
 * existence claim, an unknown introducer, or the debt's own task introducing the
 * file (then the claim is at least self-consistent) all pass through unchanged.
 */
export function annotateDebtConflicts(
    debts: AcceptDebt[],
    introducedBy: (path: string) => string | null
): AcceptDebt[] {
    return debts.map(d => {
        for (const p of extractExistenceClaims(d.reason)) {
            const producer = introducedBy(p)
            if (producer && producer !== d.taskId) {
                return {
                    ...d,
                    conflict:
                        `\`${p}\` is ${producer}'s committed deliverable — this assertion `
                        + `contradicts a sibling task's shipped work (a plan defect, not a fix `
                        + `instruction); do NOT delete or rewrite that deliverable to satisfy it`
                }
            }
        }
        return d
    })
}

/**
 * A one-line-per-debt suffix appended to the final gate's report reason so the still
 * -open accepted defects surface in the gate outcome the user sees (and in the fail
 * picker). Empty when nothing is open. The header states the records' status
 * explicitly: they are claims for the HUMAN, re-stated by the gate, never
 * instructions — and a conflicting claim carries its contradiction inline.
 */
export function buildAcceptDebtNote(open: AcceptDebt[]): string {
    if (open.length === 0) return ''
    const items = open.map(
        d =>
            `${d.taskId || '(unknown task)'} — ${describeDebt(d)}: ${d.reason}`
            + (d.conflict ? `\n    ⚠ CONFLICTING CLAIM — ${d.conflict}` : '')
    )
    return (
        `\n\nUNRESOLVED VERIFY-FAIL DEBT still open (${open.length}) — `
        + 'these defects were recorded during the run and are NOT re-verified by this gate. '
        + 'They are records for a human decision, not instructions to edit code:\n'
        + items.map(i => `  - ${i}`).join('\n')
    )
}

/** One-line provenance label for a debt, for the surfaced report. */
export function describeDebt(d: AcceptDebt): string {
    if (d.origin === 'enforce-revert') {
        return 'enforce re-verify FAILED then the edits were reverted (defect indicts the ORIGINAL work, still shipped)'
    }
    if (d.origin === 'frozen-blocked') {
        return 'repo health blocked by a spec-frozen path (cross-task contradiction — no task may perform the fixing edit)'
    }
    if (d.origin === 'cross-task-deletion') {
        return "a sibling task's committed deliverable was DELETED by this task's work and the deletion was accepted (still missing from the tree)"
    }
    return 'accepted despite verify-FAIL'
}
