/**
 * accept-debt — a per-run ledger of tasks the user ACCEPTED despite a verify-FAIL.
 *
 * The failure this closes:
 * when a task's VERIFY gate FAILs and the resolution picker's ACCEPT branch is
 * chosen, the human blesses the artifact AS-IS — a real, recorded defect ships and
 * NOTHING revisits it. A later task could have fixed it, or it could still be
 * broken at run end, and no gate ever said which.
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
import {existsSync} from 'node:fs'
import * as path from 'node:path'
import * as fsp from 'node:fs/promises'
import {runVerifyCommandLine, spawnCommand, type CommandRunner} from './command-run.js'
import {failClassOfReason, isStaticClass} from './verify-work.js'
import {taskThatIntroduced} from './task-provenance.js'
import {makeLedger} from './ledger.js'
import {parseVerifyBlockStrict} from './spec-validation.js'
import {taskFilePath} from './task-io.js'
import {isUnfailableCommand} from './unfailable-command.js'

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
 *     reverted, but the FAIL indicted the ORIGINAL work, so the terminal defect
 *     was FOUND and then erased by the very mechanism that found it. Persisted here so
 *     the final gate re-checks and surfaces it instead of letting it die with the revert.
 *   - 'enforce-kept'   — the same enforce re-verify FAIL, but the failing check named
 *     only files the ENFORCE COMMIT does not touch, so reverting that commit could not
 *     possibly repair it — reverting a change in one file over a failure in a file
 *     it cannot reach only loses the change. The edits are KEPT and
 *     the defect is recorded here — keeping the work must never mean losing the finding.
 *   - 'frozen-blocked' — a repo-health verify-FAIL whose only fix is an edit to a path
 *     THIS task's spec froze — a lint left permanently red because the files it
 *     created need a registration every spec forbids editing. Cross-task
 *     contradiction: no unattended re-run can converge, so the gate loop records the
 *     defect and routes to the human picker instead of burning AUTOFIX rounds.
 *   - 'yolo-accepted'   — YOLO MODE (unattended auto-pick, see yolo.ts) took the
 *     verify-FAIL picker's terminal option with nobody watching. It is NOT the
 *     'accepted' class and must never collapse into it: 'accepted' asserts a HUMAN
 *     weighed this failing artifact and blessed it, which is exactly the assurance
 *     an auto-pick cannot give. Same re-check treatment, honest provenance.
 *   - 'cross-task-deletion' — the task's work DELETED a sibling task's committed
 *     deliverable — a fix child deleting a sibling's test files to green a lint —
 *     and the user ACCEPTed the verify-FAIL anyway, so the
 *     deletion ships in the next commit. Recorded so the final gate re-checks it:
 *     resolved iff the named file is back in the tree (a later task restored it),
 *     otherwise surfaced.
 *   - 'final-gate' — the final integration gate DEMOTED one of its own checks to
 *     UNOBSERVED: two fix attempts that both changed the tree and
 *     re-ran the gate produced a byte-identical ranked-first failure, so the check
 *     is unfalsifiable in this environment — the boot probe needing a tool the
 *     sandbox does not have, say — and no further attempt can move it. The
 *     run is allowed to converge on the REMAINING checks, carrying this one here
 *     so the next run's gate re-checks and re-surfaces it rather than losing it.
 *     Also recorded for the ZERO-OBSERVATION verdict (final-gate.ts
 *     unobservedVerdict): the whole gate observed nothing dynamic — usually because
 *     the project's ecosystem exposes no discoverable command at all — so the run
 *     completed on statics alone. Same treatment for the same reason: unprovable
 *     here, so carry it forward rather than let a silent PASS bury it.
 *   - 'root-cause' — the task's verify FAILed because of a PRE-EXISTING defect in a
 *     file a DIFFERENT task created, which this task's own work never touched. One
 *     such defect can FAIL several later tasks in a row. The current task is not
 *     at fault, so its work — and, at the
 *     enforce site, the enforce pass's edits — are KEPT rather than reverted; the
 *     defect is recorded here and a scoped repair task is queued into the plan
 *     (root-cause-repair.ts). Before this class existed the ledger recorded the same
 *     root cause twice and nothing ever scheduled a fix, so it survived ~24h.
 */
export type DebtOrigin =
    | 'accepted'
    | 'enforce-revert'
    | 'enforce-kept'
    | 'frozen-blocked'
    | 'cross-task-deletion'
    | 'yolo-accepted'
    | 'final-gate'
    | 'root-cause'

/**
 * Origin → the one-line provenance label the surfaced report prints for it
 * (describeDebt). This table IS the origin registry: `Record<DebtOrigin, string>`
 * makes a new union member a compile error until it has a label, and both the
 * describe side and the parse side read it, so adding an origin is one union member
 * plus one line here — not the six edit sites the per-origin recorder functions used
 * to cost. The label text is user-facing (it lands in the final gate's report and in
 * the FAIL picker), so these strings are byte-frozen.
 */
const DEBT_LABELS: Record<DebtOrigin, string> = {
    accepted: 'accepted despite verify-FAIL',
    'enforce-revert':
        'enforce re-verify FAILED then the edits were reverted (defect indicts the ORIGINAL work, still shipped)',
    'enforce-kept':
        'enforce re-verify FAILED on a check the enforce diff cannot reach — the guideline edits were KEPT (reverting them could not fix it) and the defect indicts the ORIGINAL work, still shipped',
    'frozen-blocked':
        'repo health blocked by a spec-frozen path (cross-task contradiction — no task may perform the fixing edit)',
    'cross-task-deletion':
        "a sibling task's committed deliverable was DELETED by this task's work and the deletion was accepted (still missing from the tree)",
    'yolo-accepted':
        'auto-ACCEPTED by YOLO mode despite verify-FAIL (unattended — no human weighed this)',
    'final-gate':
        'final-gate check DEMOTED to UNOBSERVED (identical failure across two tree-changing fix attempts — unfalsifiable in that environment, never proven passing)',
    'root-cause':
        "verify FAILed on a PRE-EXISTING defect in another task's file that this task never touched (this task's work was kept; a scoped repair task was queued for the root cause)"
}

/**
 * A stored origin field is honoured only when it is a REGISTERED origin — anything
 * else (a hand-edited line, a field from a newer build) falls back to the 'accepted'
 * class rather than being trusted or dropped.
 */
function isKnownOrigin(origin: string | undefined): origin is DebtOrigin {
    return origin !== undefined && Object.hasOwn(DEBT_LABELS, origin)
}

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
     * PLAN defect to surface, never an instruction to act on. An autofix child
     * seeded with such a claim will delete the file to satisfy it.
     */
    conflict?: string
    /**
     * The ONE command this debt's own reason NAMES, quoted verbatim in backticks and
     * present byte-identically in the owning task's VERIFY block. Set at record
     * time by classifyVerifyCommand; absent whenever the
     * reason names no such command — which is most of them (measured: 2 of 19
     * PROJECT-pool debts, `scripts/debt-verify-class-baserate.ts`).
     *
     * It exists so the run-end re-check can settle the debt the way the debt was
     * created: by RUNNING the command and reading its exit status. Never
     * synthesised, never paraphrased, never reconstructed from prose — the stored
     * string is the VERIFY-block line itself (`inv-command-provenance`).
     */
    verifyCommand?: string
}

export function acceptDebtFile(cwd: string): string {
    return ledger.path(cwd)
}

/** The raw stored ledger ('' when none recorded yet). Parse with parseAcceptDebts. */
export async function readAcceptDebtsRaw(cwd: string): Promise<string> {
    return ledger.readRaw(cwd)
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
        // 4th field: the verbatim VERIFY command the reason names.
        // Absent in every legacy record, and absent in most new ones.
        const verifyCommand = parts[3]?.trim()
        out.push({
            taskId: parts[0]!.trim(),
            reason: parts[1]!.trim(),
            // 'accepted' is deliberately NOT carried: it is the legacy 2-field shape's
            // implicit class, so an absent origin and a spelled-out 'accepted' must
            // parse to the same record.
            ...(isKnownOrigin(origin) && origin !== 'accepted' ? {origin} : {}),
            ...(verifyCommand !== undefined && verifyCommand.length > 0 ? {verifyCommand} : {})
        })
    }
    return out
}

/** Read + parse in one step. */
export async function readAcceptDebts(cwd: string): Promise<AcceptDebt[]> {
    return ledger.read(cwd)
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
    // The 4th verify-command field forces the origin field to be written (positional
    // format) — 'accepted' spelled out there parses back to the same absent origin.
    if (d.verifyCommand !== undefined && d.verifyCommand.length > 0) {
        return [d.taskId, d.reason, d.origin ?? 'accepted', d.verifyCommand].join(FIELD_SEP)
    }
    return d.origin && d.origin !== 'accepted' ?
            `${d.taskId}${FIELD_SEP}${d.reason}${FIELD_SEP}${d.origin}`
        :   `${d.taskId}${FIELD_SEP}${d.reason}`
}

/** Dedup key: same origin + task + reason is one debt (no double-record). */
function debtKey(d: AcceptDebt): string {
    return `${d.origin ?? 'accepted'} ${d.taskId.toLowerCase()} ${d.reason.toLowerCase()}`
}

/**
 * The debt ledger. `onNoop: 'skip'` — a duplicate is a return, not a rewrite: the
 * file is touched only when a NEW debt enters it.
 */
const ledger = makeLedger<AcceptDebt>({
    file: ACCEPT_DEBT_FILE,
    max: MAX_DEBTS,
    key: debtKey,
    serialize,
    parse: parseAcceptDebts,
    onNoop: 'skip'
})

/**
 * Append one accepted-despite-FAIL record, deduplicated against what is already
 * stored (case-insensitive on task id + reason), keeping the newest MAX_DEBTS.
 * Failures are swallowed — the ledger is an auditing aid, never a blocker of the
 * gate sequence that calls it.
 */
async function appendDebt(cwd: string, entry: AcceptDebt): Promise<void> {
    if (entry.reason.length === 0) return
    try {
        // Classify AT RECORD TIME, against the spec as it stands when the defect is
        // recorded. Doing it later would read a spec a subsequent task
        // may have rewritten — the provenance claim has to be made where it is true.
        const verifyCommand =
            entry.verifyCommand ?? (await classifyVerifyCommand(cwd, entry.taskId, entry.reason))
        if (verifyCommand !== null && verifyCommand !== undefined) entry = {...entry, verifyCommand}
        await ledger.append(cwd, [entry])
    } catch {
        // best-effort ledger
    }
}

/**
 * Record one durable defect against the run ledger, stamped with the DebtOrigin that
 * says how it was reached (see DebtOrigin's doc for what each class asserts).
 *
 * This was eight exported wrappers that differed only in that one string literal, so
 * a new class cost six edit sites. The origin is not cosmetic: the final gate
 * re-checks and reports BY class, and an unattended auto-pick may never be recorded
 * as the 'accepted' class — that one asserts a human weighed the failing artifact.
 *
 * Best-effort by construction (appendDebt swallows its own faults): the ledger is an
 * auditing aid and must never break the gate sequence that calls it.
 *
 * `origin` is REQUIRED and deliberately has no default. It used to default to
 * 'accepted' (the legacy 2-field on-disk shape), and that default silently absorbed
 * a dropped argument: the eight-recorder collapse migrated one call in
 * scripts/ignored-writes-ab.ts without its origin, so a run-level 'final-gate'
 * demotion was stamped as a human 'accepted'. The wrappers each carried their class
 * in the NAME, so no migration of them could lose it; a defaulted parameter can.
 * Making it explicit turns that whole class of slip into a compile error.
 */
export async function recordDebt(
    cwd: string,
    taskId: string,
    reason: string,
    origin: DebtOrigin
): Promise<void> {
    await appendDebt(cwd, {taskId: taskId.trim(), reason: normaliseReason(reason), origin})
}

/**
 * The reason text a CROSS-TASK DELETION debt stores: the task's
 * work deleted a file a DIFFERENT task's commit introduced, verify FAILed, and the
 * user ACCEPTed — so the deletion survives into the next commit. The shape is fixed
 * and machine-parseable so the final gate's re-check can extract the path and prove
 * the debt resolved iff the file is back in the tree; it lives here, next to
 * extractDeletedDebtPath, because the writer and the reader of that shape have to
 * move together.
 */
export function crossTaskDeletionReason(deletion: {path: string; owner: string}): string {
    return `deleted \`${deletion.path}\` — ${deletion.owner}'s committed deliverable, removed by this task's work`
}

/**
 * The deleted path a cross-task-deletion debt names (the fixed shape
 * crossTaskDeletionReason builds). Null on any other reason text — an
 * unextractable path means the re-check cannot prove anything, so the debt
 * stays open (surface, never re-hide).
 */
export function extractDeletedDebtPath(reason: string): string | null {
    const m = /^deleted `([^`]+)`/.exec(reason.trim())
    return m ? m[1] : null
}

/** Overwrite the ledger with exactly these records (used to prune resolved debts). */
export async function writeAcceptDebts(cwd: string, debts: AcceptDebt[]): Promise<void> {
    await ledger.write(cwd, debts)
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
    return isStaticClass(failClassOfReason(reason))
}

/**
 * The VERIFY-COMMAND class: the ONE command a recorded reason itself
 * NAMES, quoted verbatim in backticks, and present byte-identically in the owning
 * task's VERIFY block.
 *
 * Without it, a debt whose reason reads `work did not verify: The VERIFY block
 * command \`…\` fails unaided` can be FIXED by a later autofix and still be
 * reported STILL OPEN at run end, because no reachable code path could close it:
 * see recheckAcceptDebts, whose other two classes never match such a reason.
 *
 * Deliberately NOT fuzzy: a backticked span is accepted only when it equals a parsed
 * VERIFY line exactly (after trimming). No paraphrase, no reconstruction, no prefix
 * match — the returned string is the VERIFY-block entry itself, so anything stored
 * or re-run carries the task spec's own provenance (`inv-command-provenance`). A
 * reason that quotes a path, a symbol or a truncated command matches nothing and the
 * debt stays unclassified, i.e. exactly as un-closable as it is today.
 */
/**
 * A stored command must survive the ledger's own storage format and stay something
 * a shell can be handed verbatim. A tab would break the positional record, a newline
 * would split it into two, and an over-long line is a heredoc/prose artefact rather
 * than a command. Any of those ⇒ not stored ⇒ the debt is simply unclassified, i.e.
 * exactly as un-closable as it is today.
 *
 * …and one more condition: a command whose EXIT STATUS IS DESTROYED
 * BY ITS OWN CONSTRUCTION is not storable either. The whole auto-close rests on a
 * ZERO exit meaning "the check passed" (see recheckAcceptDebts below), and a
 * VERIFY line shaped like `test -f … && echo "PASS" || echo "FAIL"` exits zero
 * whatever the tree contains. Projects with no test runner attract these: a
 * string of such lines standing in for a build check.
 * Refusing to store one leaves the debt OPEN and surfaced, which is strictly the
 * smaller claim. See unfailable-command.ts for what is and is not decidable, and
 * why bare `|| true` stays out of scope.
 */
function isStorableCommand(cmd: string): boolean {
    return (
        cmd.length > 0
        && cmd.length <= MAX_REASON_LENGTH
        && !/[\t\n\r]/.test(cmd)
        && !isUnfailableCommand(cmd)
    )
}

/**
 * Read the owning task's spec and return the VERIFY command its FAIL reason names,
 * or null. Best-effort by design: a missing task file, an unparseable or UNCLOSED
 * VERIFY fence, or a reason that quotes nothing all yield null, and null simply
 * means the debt keeps today's behaviour (surfaced, never auto-closed).
 *
 * The STRICT parse matters here. A spec that opens ```sh and never closes it
 * makes the lenient parser hand back the phase-timings table and every appended
 * gate-trail line as "VERIFY commands" — including sentences that quote
 * `bun run lint`. Matching a reason against that would mint a stored, re-runnable
 * command with fabricated provenance, which is the one thing this class may not do.
 */
export async function classifyVerifyCommand(
    cwd: string,
    taskId: string,
    reason: string
): Promise<string | null> {
    if (taskId.trim().length === 0) return null
    try {
        const spec = await fsp.readFile(taskFilePath(cwd, taskId.trim()), 'utf8')
        const cmds = parseVerifyBlockStrict(spec)
        if (cmds === null || cmds.length === 0) return null
        const hit = verifyCommandFromReason(
            reason,
            cmds.map(c => c.raw)
        )
        return hit !== null && isStorableCommand(hit) ? hit : null
    } catch {
        return null
    }
}

export function verifyCommandFromReason(
    reason: string,
    verifyCommands: readonly string[]
): string | null {
    const byText = new Map<string, string>()
    for (const c of verifyCommands) {
        const t = c.trim()
        if (t.length > 0 && !byText.has(t)) byText.set(t, t)
    }
    if (byText.size === 0) return null
    for (const m of reason.matchAll(/`([^`]+)`/g)) {
        const hit = byText.get(m[1]!.trim())
        if (hit !== undefined) return hit
    }
    return null
}

/**
 * How a re-run of a debt's stored VERIFY command ended, as the re-check sees it.
 * `pass` is the ONLY conclusive outcome: everything else — a real failure, a missing
 * tool, unreachable infrastructure, a timeout, a tree the run mutated — leaves the
 * debt exactly as open as it was.
 */
export interface VerifyRerunResult {
    outcome: 'pass' | 'fail' | 'gap'
    detail?: string
}

/**
 * Re-runs allowed per re-check. `inv-bounded`: a run that accepted many command-shaped
 * FAILs must not turn its own report into an unbounded second test suite. Three covers
 * every recorded run in the corpus (max classified per run: 1) with room to spare, and
 * anything past it stays open with the budget stated in the trail — never closed.
 */
const MAX_VERIFY_RERUNS = 3

/**
 * Re-check the ledger against the current run state. A static-class debt is RESOLVED
 * iff the final gate's own static check now passes (`staticOk`); a cross-task-deletion
 * debt is RESOLVED iff the file it names is back in the tree (`fileExists` — a later
 * task or a human restored it, so the deletion no longer holds); every other debt
 * stays OPEN (unprovable ⇒ surface, never re-hide) — unless it carries a stored
 * `verifyCommand` and `rerunVerify` re-runs that command to a ZERO exit, which is the
 * third class: the debt named a command, the command was run, and it
 * passed. FP-safe: the only auto-closes are ones a deterministic check can stand
 * behind, and here the check is the task spec's own command.
 */
export async function recheckAcceptDebts(
    debts: AcceptDebt[],
    opts: {
        staticOk: boolean
        fileExists?: (rel: string) => boolean
        /**
         * Re-run a debt's stored VERIFY command. Absent ⇒ the class is
         * inert and every debt behaves exactly as it did before it existed. Only
         * `pass` may close a debt; `fail` and `gap` both leave it open, and the
         * caller is expected to have made `pass` mean "ran, exited 0, and changed
         * nothing tracked" (`inv-no-write`).
         */
        rerunVerify?: (command: string, debt: AcceptDebt) => Promise<VerifyRerunResult>
    }
): Promise<{open: AcceptDebt[]; resolved: AcceptDebt[]; trail: string[]}> {
    const open: AcceptDebt[] = []
    const resolved: AcceptDebt[] = []
    const trail: string[] = []
    let rerunsLeft = MAX_VERIFY_RERUNS
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
        if (opts.staticOk && isStaticClassDebt(d.reason)) {
            resolved.push(d)
            continue
        }
        // VERIFY-COMMAND class, LAST so the two older classes decide exactly what they
        // decided before (`inv-existing-classes-kept`) and nothing is re-run that was
        // already settled without running anything.
        const cmd = d.verifyCommand
        if (opts.rerunVerify === undefined || cmd === undefined || !isStorableCommand(cmd)) {
            open.push(d)
            continue
        }
        if (rerunsLeft <= 0) {
            trail.push(
                `${d.taskId}: NOT re-checked — the per-run re-run budget `
                    + `(${MAX_VERIFY_RERUNS}) is spent; the debt stays open`
            )
            open.push(d)
            continue
        }
        rerunsLeft -= 1
        let r: VerifyRerunResult
        try {
            r = await opts.rerunVerify(cmd, d)
        } catch {
            // A harness fault observes nothing, so it proves nothing.
            r = {outcome: 'gap', detail: 're-run harness fault'}
        }
        if (r.outcome === 'pass') {
            resolved.push(d)
            trail.push(`${d.taskId}: RESOLVED — re-ran \`${cmd}\` and it exited 0`)
            continue
        }
        trail.push(
            `${d.taskId}: still open — re-ran \`${cmd}\`: `
                + (r.outcome === 'fail' ?
                    `it FAILED${r.detail ? ` (${r.detail})` : ''}`
                :   `INCONCLUSIVE${r.detail ? ` (${r.detail})` : ''}, nothing was observed`)
        )
        open.push(d)
    }
    return {open, resolved, trail}
}

// ─── Conflicting-claim classification ──────────────────────────
//
// A recorded debt is a CLAIM about the tree, not an instruction to change it. The
// one class a deterministic check can prove SELF-CONTRADICTORY is an
// existence-as-failure claim ("<path> exists" fails the verify) whose named path is
// a DIFFERENT task's committed deliverable: the plan shipped the file on purpose
// and a sibling's verify indicts it — a plan defect (sibling scope-fence leaked
// into a verify assertion), not a fixable fault. A debt reading "<path> exists"
// hands a final-gate autofix child a reason to `rm` a verified page.

/** A path-like token: at least one directory separator, ending in a file name. */
const PATH_TOKEN_RE = /(?:[\w.@-]+\/)+[\w.@-]+\.\w+/g

/**
 * Extract the paths whose EXISTENCE the reason asserts as the failure — a path
 * token immediately followed by "exists" / "still exists", or by "must/should not
 * exist". Only this narrow shape qualifies: a reason that merely MENTIONS a path
 * (a prohibition violation, a broken import) is an ordinary defect claim, not an
 * existence assertion, and must never be flagged (such debts name paths
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

/**
 * One-line provenance label for a debt, for the surfaced report. Straight off
 * DEBT_LABELS, so a new origin cannot ship without one; an absent or unregistered
 * origin falls back to the 'accepted' class exactly as the branch chain did.
 */
export function describeDebt(d: AcceptDebt): string {
    return isKnownOrigin(d.origin) ? DEBT_LABELS[d.origin] : DEBT_LABELS.accepted
}

/**
 * ACCEPT-debt re-check: read the ledger of tasks
 * the user accepted despite a verify-FAIL and re-check each against the CURRENT
 * tree. A static-class debt whose statics now pass is provably RESOLVED (a later
 * task fixed it) and pruned from the ledger; every other debt cannot be proven
 * resolved deterministically, so it stays OPEN and is surfaced — a run may not
 * complete silently carrying an accepted defect. FP-safe by construction (see
 * accept-debt.ts). Best-effort: a ledger read/write failure must never break the
 * caller.
 *
 * FACTORED OUT of runFinalIntegrationGate: the derivation has to be
 * runnable at a SECOND moment — after a converged final-gate autofix, where the
 * orchestrator used to rebuild its gate outcome as a bare `{ok, reason}` and drop
 * `openDebts` entirely. The report a run ends on has to be derived from the tree
 * the run ends with, not from the tree as it was before the fix pass.
 *
 * `staticOk` is the caller's claim about the CURRENT statics, and it is the only
 * thing that can auto-close a static-class debt — so a caller that does not know
 * must pass `false` (unprovable ⇒ stays open), never a guess.
 */
export async function deriveOpenDebts(
    cwd: string,
    staticOk: boolean,
    /** The spawner for the VERIFY-COMMAND re-runs. Defaults to the real one. */
    run: CommandRunner = spawnCommand,
    signal?: AbortSignal
): Promise<{openDebts: AcceptDebt[]; debtNote?: string; trail?: string[]}> {
    const {
        open: openRaw,
        resolved,
        trail
    } = await recheckAcceptDebts(await readAcceptDebts(cwd), {
        staticOk,
        // Cross-task-deletion debts auto-close iff the deleted file is back in the
        // tree — a deterministic existence check, corroborating the per-file
        // provenance the record already carries.
        fileExists: rel => existsSync(path.join(cwd, rel)),
        // VERIFY-COMMAND class: a debt that NAMES a command is settled
        // by running that command, under the gate's own env-gap contract and behind
        // the no-write guard below.
        rerunVerify: cmd => rerunDebtVerifyCommand(cwd, cmd, run, signal)
    })
    if (resolved.length > 0) await writeAcceptDebts(cwd, openRaw)
    // Conflicting-claim annotation: an existence-as-failure debt whose
    // named file is another task's committed deliverable is a plan defect — surface
    // the contradiction with the debt so nobody (human or child) treats the claim as
    // a deletion instruction. Pure git-history lookup; degrades to no annotation.
    const openDebts = annotateDebtConflicts(openRaw, p => taskThatIntroduced(cwd, p))
    const debtNote = buildAcceptDebtNote(openDebts)
    return {openDebts, ...(debtNote ? {debtNote} : {}), ...(trail.length > 0 ? {trail} : {})}
}

/** Per-command ceiling for a debt re-run (`inv-bounded`). */
const DEBT_RERUN_TIMEOUT_MS = 300_000

/**
 * Extra infrastructure-gap shapes recognised ONLY when re-running a debt's command,
 * never in the gate's own verdicts. A driver that reports its connection simply
 * closed (`ERR_POSTGRES_CONNECTION_CLOSED` — what bun's SQL client says when the
 * database is not running at all) is an
 * absent dependency, and calling that "the defect is still present" would be a
 * finding the environment invented. Kept out of INFRA_GAP_OUTPUT_RE on purpose: in a
 * gate verdict the same wording can be a real fault the suite must own, and only the
 * debt re-check needs the conservative reading — where it costs nothing, because gap
 * and fail both leave the debt open.
 */
const DEBT_INFRA_GAP_RE = /ERR_POSTGRES_CONNECTION_CLOSED|ERR_MYSQL_CONNECTION|ECONNRESET/i

/**
 * Re-run ONE debt's stored VERIFY command for the re-check, with the no-write guard
 * (`inv-no-write`) wrapped around it.
 *
 * A VERIFY command is the project's own command and may legitimately write (a build
 * emits `dist/`, a suite writes a snapshot). What it may NOT do is turn the tree into
 * a passing tree and have that count as the debt being fixed — the run would then be
 * certifying its own side effect. So tracked state is captured before and after, and
 * a pass that came with a tracked change is downgraded to INCONCLUSIVE with the
 * change named. Untracked output is left alone: it is what a build legitimately
 * produces, and `git status --porcelain` in a repo with the usual ignores does not
 * see it.
 *
 * A repository the guard cannot read (no git, git absent) is not a licence to skip
 * the guard: the re-run is INCONCLUSIVE there, because "nothing changed" would be an
 * assumption rather than an observation.
 */
export async function rerunDebtVerifyCommand(
    cwd: string,
    command: string,
    /** The spawner, for BOTH the command and the tracked-state reads. Injected so
     *  the guard's four outcomes are testable without a repo or a real command. */
    run: CommandRunner = spawnCommand,
    signal?: AbortSignal
): Promise<VerifyRerunResult> {
    const tracked = async (): Promise<string | null> => {
        const r = await run({
            cwd,
            bin: 'git',
            args: ['status', '--porcelain', '--untracked-files=no'],
            timeoutMs: 60_000,
            ...(signal === undefined ? {} : {signal})
        })
        return r.failedToStart || r.status !== 0 ? null : r.stdout
    }
    const before = await tracked()
    const r = await runVerifyCommandLine(
        cwd,
        command,
        DEBT_RERUN_TIMEOUT_MS,
        DEBT_INFRA_GAP_RE,
        run,
        signal
    )
    if (r.outcome === 'fail') return {outcome: 'fail', detail: `exit ${r.status} — ${r.tail}`}
    if (r.outcome === 'gap') return {outcome: 'gap', detail: r.detail}
    const after = await tracked()
    if (before === null || after === null) {
        return {outcome: 'gap', detail: 'tracked-state guard could not read git status'}
    }
    if (before !== after) {
        return {
            outcome: 'gap',
            detail: 'the re-run itself CHANGED tracked files — a command that edits the tree into a pass proves nothing'
        }
    }
    return {outcome: 'pass'}
}
