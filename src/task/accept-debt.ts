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
import {parseVerifyBlockStrict} from './spec-validation.js'
import {taskFilePath, tasksDir} from './task-io.js'

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
 *   - 'enforce-kept'   — the same enforce re-verify FAIL, but the failing check named
 *     only files the ENFORCE COMMIT does not touch, so reverting that commit could not
 *     possibly repair it (mx5 run 18 TASK_0024: a one-line paren removal in `Admin.tsx`
 *     was reverted over a `MyListings.spec.tsx` CT failure it cannot reach, and the
 *     final gate re-made the identical change 5 minutes later). The edits are KEPT and
 *     the defect is recorded here — keeping the work must never mean losing the finding.
 *   - 'frozen-blocked' — a repo-health verify-FAIL whose only fix is an edit to a path
 *     THIS task's spec froze (mx5 run 12: `bun run lint` permanently red because the
 *     created files need a tsconfig registration every spec forbids). Cross-task
 *     contradiction: no unattended re-run can converge, so the gate loop records the
 *     defect and routes to the human picker instead of burning AUTOFIX rounds.
 *   - 'yolo-accepted'   — YOLO MODE (unattended auto-pick, see yolo.ts) took the
 *     verify-FAIL picker's terminal option with nobody watching. It is NOT the
 *     'accepted' class and must never collapse into it: 'accepted' asserts a HUMAN
 *     weighed this failing artifact and blessed it, which is exactly the assurance
 *     an auto-pick cannot give. Same re-check treatment, honest provenance.
 *   - 'cross-task-deletion' — the task's work DELETED a sibling task's committed
 *     deliverable (mx5 run 12 PROMPT 2: a fix child deleted TASK_0020's playwright ct
 *     files to green a lint) and the user ACCEPTed the verify-FAIL anyway, so the
 *     deletion ships in the next commit. Recorded so the final gate re-checks it:
 *     resolved iff the named file is back in the tree (a later task restored it),
 *     otherwise surfaced.
 *   - 'final-gate' — the final integration gate DEMOTED one of its own checks to
 *     UNOBSERVED (mx5 run 14): two fix attempts that both changed the tree and
 *     re-ran the gate produced a byte-identical ranked-first failure, so the check
 *     is unfalsifiable in this environment (run 14: the boot probe needed `ss` or
 *     `lsof` and the sandbox had neither) and no further attempt can move it. The
 *     run is allowed to converge on the REMAINING checks, carrying this one here
 *     so the next run's gate re-checks and re-surfaces it rather than losing it.
 *     Also recorded for the ZERO-OBSERVATION verdict (final-gate.ts
 *     unobservedVerdict): the whole gate observed nothing dynamic — usually because
 *     the project's ecosystem exposes no discoverable command at all — so the run
 *     completed on statics alone. Same treatment for the same reason: unprovable
 *     here, so carry it forward rather than let a silent PASS bury it.
 *   - 'root-cause' — the task's verify FAILed because of a PRE-EXISTING defect in a
 *     file a DIFFERENT task created, which this task's own work never touched (mx5
 *     run 14: TASK_0007's `test/teardown.ts` TRUNCATE bug FAILed TASK_0013 and
 *     TASK_0019). The current task is not at fault, so its work — and, at the
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
     * PLAN defect to surface, never an instruction to act on — mx5 run 11's autofix
     * child `rm`'d TASK_0008's verified admin page to satisfy exactly such a claim.
     */
    conflict?: string
    /**
     * The ONE command this debt's own reason NAMES, quoted verbatim in backticks and
     * present byte-identically in the owning task's VERIFY block (nexttask 5, mx5 run
     * 19 TASK_0009). Set at record time by classifyVerifyCommand; absent whenever the
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
        // 4th field: the verbatim VERIFY command the reason names (nexttask 5).
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
 * Append one accepted-despite-FAIL record, deduplicated against what is already
 * stored (case-insensitive on task id + reason), keeping the newest MAX_DEBTS.
 * Failures are swallowed — the ledger is an auditing aid, never a blocker of the
 * gate sequence that calls it.
 */
async function appendDebt(cwd: string, entry: AcceptDebt): Promise<void> {
    if (entry.reason.length === 0) return
    try {
        // Classify AT RECORD TIME, against the spec as it stands when the defect is
        // recorded (nexttask 5). Doing it later would read a spec a subsequent task
        // may have rewritten — the provenance claim has to be made where it is true.
        const verifyCommand =
            entry.verifyCommand ?? (await classifyVerifyCommand(cwd, entry.taskId, entry.reason))
        if (verifyCommand !== null && verifyCommand !== undefined) entry = {...entry, verifyCommand}
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
 * auditing aid and must never break the gate sequence that calls it. `origin`
 * defaults to 'accepted', which is the legacy 2-field on-disk shape.
 */
export async function recordDebt(
    cwd: string,
    taskId: string,
    reason: string,
    origin: DebtOrigin = 'accepted'
): Promise<void> {
    await appendDebt(cwd, {taskId: taskId.trim(), reason: normaliseReason(reason), origin})
}

/**
 * The reason text a CROSS-TASK DELETION debt stores (mx5 run 12 PROMPT 2): the task's
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
 * The VERIFY-COMMAND class (nexttask 5): the ONE command a recorded reason itself
 * NAMES, quoted verbatim in backticks, and present byte-identically in the owning
 * task's VERIFY block.
 *
 * mx5 run 19 recorded `work did not verify: The VERIFY block command \`AGENT=1 bun
 * test test/listings.test.ts\` fails unaided …`; eleven minutes later the final-gate
 * autofix fixed exactly that, the gate's own re-run printed `121 pass 0 fail`, and
 * the run still ended reporting the debt STILL OPEN — because no reachable code path
 * could ever have closed it (see recheckAcceptDebts: two classes, neither reachable
 * for a `work did not verify:` reason).
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
 */
function isStorableCommand(cmd: string): boolean {
    return cmd.length > 0 && cmd.length <= MAX_REASON_LENGTH && !/[\t\n\r]/.test(cmd)
}

/**
 * Read the owning task's spec and return the VERIFY command its FAIL reason names,
 * or null. Best-effort by design: a missing task file, an unparseable or UNCLOSED
 * VERIFY fence, or a reason that quotes nothing all yield null, and null simply
 * means the debt keeps today's behaviour (surfaced, never auto-closed).
 *
 * The STRICT parse matters here. mx5 run 19's `TASK_0001.md` opens ```sh and never
 * closes it, so the lenient parser hands back the phase-timings table and every
 * appended gate-trail line as "VERIFY commands" — including sentences that quote
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
 * third class (nexttask 5): the debt named a command, the command was run, and it
 * passed. FP-safe: the only auto-closes are ones a deterministic check can stand
 * behind, and here the check is the task spec's own command.
 */
export function recheckAcceptDebts(
    debts: AcceptDebt[],
    opts: {
        staticOk: boolean
        fileExists?: (rel: string) => boolean
        /**
         * Re-run a debt's stored VERIFY command (nexttask 5). Absent ⇒ the class is
         * inert and every debt behaves exactly as it did before it existed. Only
         * `pass` may close a debt; `fail` and `gap` both leave it open, and the
         * caller is expected to have made `pass` mean "ran, exited 0, and changed
         * nothing tracked" (`inv-no-write`).
         */
        rerunVerify?: (command: string, debt: AcceptDebt) => VerifyRerunResult
    }
): {open: AcceptDebt[]; resolved: AcceptDebt[]; trail: string[]} {
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
            r = opts.rerunVerify(cmd, d)
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

/**
 * One-line provenance label for a debt, for the surfaced report. Straight off
 * DEBT_LABELS, so a new origin cannot ship without one; an absent or unregistered
 * origin falls back to the 'accepted' class exactly as the branch chain did.
 */
export function describeDebt(d: AcceptDebt): string {
    return isKnownOrigin(d.origin) ? DEBT_LABELS[d.origin] : DEBT_LABELS.accepted
}
