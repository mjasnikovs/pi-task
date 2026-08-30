/**
 * What each way a gated task can END means for persistence and for what the user
 * is told — stated once, for both `/task` and `/task-auto`.
 *
 * `runGatesForTask` is shared by the two commands, so both consume the same
 * outcome union. Each kind raises the same three questions: demote the inner task
 * file? fail the parent run file? what do we say, at what level? This table
 * answers them once. It touches none of either loop's state — it is the
 * outcome → (persistence, message) mapping and nothing else — and a new outcome
 * kind is a compile error here rather than a silent fallthrough in whichever
 * command was not updated.
 *
 * The three things that genuinely differ per command are parameters: the resume
 * verb, whether the message names a step (`/task` runs one task and passes an
 * empty `at`), and whether a parent run file exists to fail.
 *
 * The PRE-gate outcomes (`res.sessionCancelled` / `res.interrupted` / `!res.ok`,
 * before the gate runs) are deliberately NOT here. Their wording genuinely
 * differs between the two commands — `/task` says "could not start a fresh
 * session for /task" where `/task-auto` says "could not start a session. Run
 * /task-auto-resume to retry" — and `/task-auto` has a cancel-requested branch
 * `/task` has no equivalent for. Folding them in would mean a table of message
 * overrides, which is not a simplification.
 */

/** The gate outcomes a command has to act on. Mirrors runGatesForTask's union. */
export type TerminalOutcomeKind =
    'done' | 'paused' | 'session-cancelled' | 'cancelled' | 'interrupted' | 'failed'

/** What the message needs to name. */
export interface TerminalMessageContext {
    /** The task or run id shown to the user. */
    tag: string
    /**
     * The step this happened at, ALREADY formatted with its leading space —
     * ` at "Add auth routes"`. Empty for `/task`, which runs one task and has no
     * step to name.
     */
    at: string
    /** The failure cause, already truncated and formatted with its leading dash. */
    why: string
    /** `/task-resume` or `/task-auto-resume`. */
    resumeCmd: string
}

export interface TerminalOutcome {
    /**
     * Demote the INNER task file to resumable. It reads `completed` from
     * spec-handoff, and leaving it that way is how a failed run's task file
     * claimed success after the run had failed.
     */
    markResumable: boolean
    /**
     * Mark the PARENT run file failed. Only `/task-auto` has one; `/task` ignores
     * this, which is why it is a property of the OUTCOME rather than of the
     * command — the outcome is equally fatal either way.
     */
    failParent: boolean
    level: 'info' | 'warning' | 'error'
    message: (c: TerminalMessageContext) => string
}

/**
 * Truncate a failure reason for a one-line notification, or produce nothing when
 * there is no reason.
 */
export function formatWhy(reason?: string): string {
    return reason ? ` — ${reason.slice(0, 160)}` : ''
}

/** The step suffix, or empty when the command has no step to name. */
export function formatAt(title?: string): string {
    return title === undefined ? '' : ` at "${title}"`
}

export const TERMINAL_OUTCOMES: Record<TerminalOutcomeKind, TerminalOutcome> = {
    done: {
        markResumable: false,
        failParent: false,
        level: 'info',
        message: c => `${c.tag} complete — verified.`
    },
    paused: {
        // The user was shown the verify-failure picker and dismissed it. Nothing
        // is wrong with the tree; they simply have not decided yet.
        markResumable: true,
        failParent: true,
        level: 'warning',
        message: c =>
            `${c.tag} paused${c.at} — verification failed and you dismissed the choice; `
            + `resume with ${c.resumeCmd}.`
    },
    'session-cancelled': {
        // No session for the autofix child. Nothing ran, so nothing to demote.
        markResumable: false,
        failParent: false,
        level: 'warning',
        message: c =>
            `${c.tag} paused — could not start a session for autofix. `
            + `Run ${c.resumeCmd} to retry.`
    },
    cancelled: {
        // The USER stopped the re-run. The task file already says `cancelled`, and
        // `markResumable` writes `failed` — that both lies in the ledger and turns
        // a deliberate stop into a red error. RUN_END_POLICY states this for the
        // first implementation run; this row states the same thing for a re-run.
        markResumable: false,
        failParent: false,
        level: 'warning',
        // `cancelled` is already in RESUMABLE_STATES, so the file needs no demotion
        // AND the resume works — naming it costs nothing and is true.
        message: c => `${c.tag} cancelled${c.at} — resume with ${c.resumeCmd}.`
    },
    interrupted: {
        markResumable: true,
        // NOT a failure: the user stopped it. The parent run stays in_progress so
        // a resume picks up where it left off.
        failParent: false,
        level: 'warning',
        message: c => `${c.tag} paused${c.at} — resume with ${c.resumeCmd}.`
    },
    failed: {
        markResumable: true,
        failParent: true,
        level: 'error',
        message: c => `${c.tag} stopped${c.at}${c.why} — fix and run ${c.resumeCmd}.`
    }
}
