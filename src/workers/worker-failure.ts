/**
 * How a worker child DIED — the one classification of a finished `runWorker`
 * result, and the single place its precedence is written down.
 *
 * Why this module exists. `RunWorkerResult` reports each kill cause as its own
 * optional field (`loopHit`, `timedOut`, `stalled`, `commandTimedOut`,
 * `streamStalled`, `leakedToolCall`, `aborted`, `exitCode`), and every kill path
 * ALSO sets `aborted` and a non-zero exit — killProc flips those on every route
 * out. So a consumer cannot read the fields in any order it likes: the specific
 * causes must be matched before the generic `aborted`/`exitCode` ones, or a dead
 * backend is reported to the user as "you cancelled".
 *
 * As prose in three doc comments and as the source order of three hand-written
 * ladders (`classifyEnforceChildFailure`, `classifyResearchWorker`, and the
 * gate's own reading), that rule has three chances to drift — and it does:
 * `streamStalled` gets added to the result and to `finalAttemptFailed`, but the
 * enforce ladder
 * never grew an arm for it, so an enforcement child killed for a hung model
 * stream fell all the way through to `if (aborted) return USER_CANCELLED` — the
 * exact mislabel the comment above that line warns against.
 *
 * The fix is to make the order data. `FAILURE_RULES` is ordered, the first
 * matching row wins, and consumers `switch` on the resulting `kind` instead of
 * re-deriving the ladder. A new kill cause is one row here plus a compile error
 * in every consumer that has not handled it — which is what makes the drift that
 * caused the bug impossible rather than merely fixed.
 */

import type {LoopHit} from '../task/loop-detector.js'
import type {WorkerKillId} from './worker-kill.js'

/**
 * The subset of a finished child result this classification reads.
 *
 * Structural on purpose: `runWorker` returns a superset, and
 * `EnforceChildResult` is a hand-written narrowing of the same shape. Typing the
 * input as what is actually READ lets both pass without either importing the
 * other's interface.
 */
export interface WorkerFailureInput {
    exitCode: number
    aborted: boolean
    timedOut?: boolean
    stalled?: boolean
    loopHit?: unknown
    leakedToolCall?: unknown
    commandTimedOut?: {toolName: string; timeoutMs: number}
    streamStalled?: {idleMs: number}
}

/**
 * Why the child died, or `undefined` when it finished under its own power.
 *
 * Note what is NOT here: an empty answer, and a reported `modelError` on a run
 * that still produced text. Neither is a kill — whether they count as a failure
 * is the consumer's policy (research accepts a genuinely empty section; the gate
 * does not), so folding them in would move a decision out of the module that
 * owns it.
 */
export type WorkerFailure =
    | {kind: 'stalled'}
    | {kind: 'command-timeout'; toolName: string; timeoutMs: number}
    | {kind: 'stream-stall'; idleMs: number}
    | {kind: 'worker-timeout'}
    | {kind: 'loop'; hit: LoopHit}
    | {kind: 'leaked-tool-call'; text: string}
    | {kind: 'aborted'}
    | {kind: 'exit'; code: number}

/** The `kind` of every row, for exhaustiveness checks in consumers. */
export type WorkerFailureKind = WorkerFailure['kind']

/**
 * Every kind is a cause on the roster. A `kind` with no `WORKER_KILLS` row is a
 * compile error here, not a discovery six months later.
 */
type _KindsAreKills = WorkerFailureKind extends WorkerKillId ? true : never
const _kindsAreKills: _KindsAreKills = true
void _kindsAreKills

/**
 * The ordered ladder. FIRST MATCH WINS — row order IS the precedence, and it is
 * the only statement of it in the codebase.
 *
 * The order, and why:
 *
 *  1. `stalled` — no output AND the model endpoint did not answer a probe. The
 *     most specific diagnosis there is, and the one most easily lost: the kill
 *     aborts, so anything checked after `aborted` never sees it.
 *  2. `command-timeout` — a watchdog kill naming the tool call that hung. Also
 *     aborts. Before the wall-clock timeout because it is the narrower cause
 *     (the two cannot be confused: a watchdog kill leaves the worker's own
 *     timeout flag false).
 *  3. `stream-stall` — a watchdog kill for a model stream that went silent while
 *     no tool was running. Sits next to `command-timeout` because it is the same
 *     class of event: a watchdog, not the model, ended the attempt.
 *  4. `worker-timeout` — the wall-clock backstop.
 *  5. `loop` — killed for repeating one tool call past threshold. After the
 *     timeouts, matching the enforce ladder this replaces; in practice the two
 *     cannot both fire, since a loop kill stops the attempt before its own timer
 *     can expire.
 *  6. `leaked-tool-call` — the model wrote a call as prose instead of invoking
 *     it. Only ever set on an otherwise clean run.
 *  7. `aborted` — no specific cause survived, so this really is a cancel.
 *  8. `exit` — a plain non-zero exit with no kill behind it: a crash.
 */
export const FAILURE_RULES: ReadonlyArray<{
    /** The roster id this row matches. `worker-kill.test.ts` checks the sequence
     *  against `FAILURE_ORDER`, so a reordering or an omission is a test failure
     *  rather than a silently different precedence. */
    id: WorkerKillId
    match: (r: WorkerFailureInput) => WorkerFailure | null
}> = [
    {id: 'stalled', match: r => (r.stalled === true ? {kind: 'stalled'} : null)},
    {
        id: 'command-timeout',
        match: r =>
            r.commandTimedOut ?
                {
                    kind: 'command-timeout',
                    toolName: r.commandTimedOut.toolName,
                    timeoutMs: r.commandTimedOut.timeoutMs
                }
            :   null
    },
    {
        id: 'stream-stall',
        match: r =>
            r.streamStalled ? {kind: 'stream-stall', idleMs: r.streamStalled.idleMs} : null
    },
    {id: 'worker-timeout', match: r => (r.timedOut === true ? {kind: 'worker-timeout'} : null)},
    {id: 'loop', match: r => (r.loopHit ? {kind: 'loop', hit: r.loopHit as LoopHit} : null)},
    {
        id: 'leaked-tool-call',
        match: r =>
            r.leakedToolCall ? {kind: 'leaked-tool-call', text: String(r.leakedToolCall)} : null
    },
    {id: 'aborted', match: r => (r.aborted ? {kind: 'aborted'} : null)},
    {id: 'exit', match: r => (r.exitCode !== 0 ? {kind: 'exit', code: r.exitCode} : null)}
]

/**
 * Classify a finished child. Returns `undefined` when nothing killed it —
 * which is not the same as "it answered": the text may still be empty, and that
 * judgement belongs to the caller.
 */
/**
 * What a worker failure SAYS to the caller that asked for the work.
 *
 * WHY IT EXISTS. The ladder above already names the cause exactly, with its
 * detail — which tool hung, how long the stream was idle, which exit code. None
 * of that reached a human. `formatChildFailure` was handed a `ChildOutcome`
 * (`{aborted, exitCode, stderr}`) and answered `if (aborted) return
 * abortedMessage`, so a 240s wall-clock kill, a hung `bash`, a dead model
 * backend, a loop kill and a user pressing ESC all printed the SAME four words.
 * The discriminating value was computed a line later by `childFailureReason` and
 * put in the debug trail, which a user reading a tool result never sees.
 *
 * That is not only unhelpful; it is why the `pi-worker` tool's 240s cap has no
 * base rate. 53 recorded invocations across eight repos carry 14 failures, and
 * NOTHING in the transcript says which of them ran out of time — the honest
 * bound recoverable from timestamps alone is "somewhere between 0 and 8".
 *
 * A switch, not a table: `WorkerFailure` is a discriminated union carrying a
 * different payload per arm, so the exhaustiveness check is the compiler's and a
 * ninth arm cannot be added without a message.
 */
export function describeWorkerFailure(
    f: WorkerFailure,
    /** What a genuine user cancel says. The caller's wording — only this arm is theirs. */
    abortedMessage: string,
    /** stderr for the `exit` arm; ignored by every other. */
    stderr = ''
): string {
    switch (f.kind) {
        case 'stalled':
            return (
                'Worker stopped: it produced no output and the model backend was '
                + 'unreachable. This is an infrastructure failure, not a bad question — '
                + 'retrying the same request once the backend is back is reasonable.'
            )
        case 'command-timeout':
            return (
                `Worker killed: \`${f.toolName}\` ran past its `
                + `${Math.round(f.timeoutMs / 1000)}s per-command limit and was still `
                + 'running. A command that does not terminate on its own (a dev server, a '
                + 'watcher) has to be bounded by the command itself.'
            )
        case 'stream-stall':
            return (
                `Worker killed: no output for ${Math.round(f.idleMs / 1000)}s while the `
                + 'model backend was still reachable — a hung stream, not a slow one.'
            )
        case 'worker-timeout':
            return (
                'Worker ran out of time before answering, on every attempt, and returned '
                + 'nothing. The question was too broad for one worker: narrow it to one '
                + 'directory or one question, or split it across several workers.'
            )
        case 'loop':
            return (
                'Worker killed: it repeated the same tool call without making progress. '
                + 'Nothing it had already read was answering the question as asked.'
            )
        case 'leaked-tool-call':
            return 'Worker produced a malformed tool call instead of an answer.'
        case 'aborted':
            return abortedMessage
        case 'exit':
            return `Worker exited ${f.code}.\n${stderr.trim().slice(-500) || '(no stderr)'}`
    }
}

export function classifyWorkerFailure(r: WorkerFailureInput): WorkerFailure | undefined {
    for (const rule of FAILURE_RULES) {
        const hit = rule.match(r)
        if (hit) return hit
    }
    return undefined
}
