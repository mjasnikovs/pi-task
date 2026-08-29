/**
 * What each way a gated task can END means for persistence and for what the user
 * is told — stated once, for both `/task` and `/task-auto`.
 *
 * `runGatesForTask` is already shared verbatim by the two commands, so both
 * consume the same five-kind outcome. What was NOT shared was the answer to the
 * three questions each kind raises: demote the inner task file? fail the parent
 * run file? what do we say, at what level? Those were two `switch`es 600 lines
 * apart with line-for-line correspondence — down to the identical
 * `reason.slice(0, 160)` truncation — differing only in the resume verb, whether
 * a parent run file exists to fail, and whether the message names the step.
 *
 * That is not the shared "task-runner base" CONTEXT.md rules out, and for the
 * same reason `runFinalGateStage` could leave `runAutoLoop`: this is the
 * outcome → (persistence, message) mapping, and it touches none of either loop's
 * state. Adding a sixth outcome kind is now a compile error in one place rather
 * than a silently-unhandled fallthrough in whichever command was not updated.
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
    /** The task or run id shown to the user (`TASK_0007`, `AUTO_0002`, `Task`). */
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
     * claimed success in the run 6 audit.
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
 * Truncate a failure reason for a one-line notification, or produce nothing.
 * Both commands did this identically and inline.
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
