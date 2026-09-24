/**
 * Implementation-turn supervision — what happens between "the spec was delivered
 * to the main session" and "we know how the implementation turn REALLY ended".
 *
 * A single `waitForIdle` resolves for four different reasons, and three of them
 * are not "the model finished":
 *   • `aborted`     — a user ESC (or the command watchdog) cut the turn short;
 *   • `compaction`  — a threshold auto-compaction parked the turn at idle without
 *                     auto-continuing (the runtime expects a manual continue);
 *   • `error`       — the model or provider failed after pi exhausted the retries
 *                     in its own retry settings;
 *   • `stop`        — genuine completion.
 * `classifyTurnEnd` reads the session entries and names ONE of those;
 * `superviseImplementation` then resumes across compactions, lets the user steer
 * after an interrupt, and reports the terminal outcome. The orchestrator calls it
 * from one place, inside the `sendSpec` closure.
 */

import type {ExtensionAPI, ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import {SessionUI} from '../remote/bridge.js'
import {consumeGuardTermination} from './implementation-guards.js'

// ─── Turn-end classification ─────────────────────────────────────────────────

/** How the most recent implementation turn ended. See {@link classifyTurnEnd}. */
export type TurnEnd = 'stop' | 'aborted' | 'error' | 'compaction'

/**
 * The slice of a session entry the classifier reads. Structural on purpose: the
 * runtime's `SessionEntry` union is wider than we need, and the tests build
 * entries from plain literals.
 */
export type SessionEntryLike = {
    type?: string
    message?: {role?: string; stopReason?: string; errorMessage?: string; content?: unknown}
}

const isAssistant = (e: SessionEntryLike): boolean =>
    e.message !== undefined && e.message.role === 'assistant'

/**
 * Assistant messages that ended under an aborted run. stopReason cannot say so on
 * its own: an abort that lands during a tool or a pre-request compaction fails the
 * NEXT request's setup, and pi-ai records that as "error" ("This operation was
 * aborted"). An ESC during a retry backoff or a post-run compaction lands after
 * the message was recorded and changes nothing in it.
 */
const endedUnderAbort = new WeakSet<object>()

/**
 * An abort breaks out of pi's run before `agent_before_settle`, which every
 * completed run reaches. A run that settles without it was aborted, wherever
 * between its loops the abort landed.
 *
 * The message is taken at `agent_end`, not `message_end`: a `message_end` handler
 * sees the copy an earlier extension returned, while pi copies that into the
 * original object and stores the original.
 */
export function registerRunAbortTracker(pi: ExtensionAPI): void {
    let lastAssistant: object | undefined
    let settlingClean = false
    pi.on('agent_end', event => {
        lastAssistant = event.messages.findLast(m => m.role === 'assistant')
        settlingClean = false
    })
    pi.on('agent_before_settle', () => {
        settlingClean = true
    })
    pi.on('agent_settled', () => {
        if (!settlingClean && lastAssistant) endedUnderAbort.add(lastAssistant)
        lastAssistant = undefined
    })
}

function wasAborted(message: NonNullable<SessionEntryLike['message']>): boolean {
    return message.stopReason === 'aborted' || endedUnderAbort.has(message)
}

/** Index of the last assistant message and of the last compaction boundary. */
function tailPositions(entries: ReadonlyArray<SessionEntryLike>): {
    lastAssistant: number
    lastCompaction: number
} {
    let lastAssistant = -1
    let lastCompaction = -1
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i]
        if (isAssistant(e)) lastAssistant = i
        else if (e.type === 'compaction') lastCompaction = i
    }
    return {lastAssistant, lastCompaction}
}

/**
 * Classify how the most recent turn ended, from the session entries alone.
 *
 * Precedence, when several signals are present at once:
 *   1. `aborted`    — the last assistant message ended under an aborted run
 *                     ({@link registerRunAbortTracker}), whatever its stopReason.
 *                     A user ESC (or watchdog abort) wins over everything: it is
 *                     not a compaction pause, and the steer loop owns it.
 *   2. `compaction` — a `compaction` entry sits AFTER the last assistant message.
 *                     Position-based, not timestamp-based: `appendCompaction`
 *                     pushes the boundary onto the tail of the entry list, and
 *                     `getEntries()` returns that list in append order, so a
 *                     trailing compaction means we are parked with no continuation.
 *                     A finished turn ends on an assistant message. An overflow
 *                     compaction that is going to retry continues the turn itself
 *                     and never reaches us idle.
 *   3. `error`      — the last assistant message has stopReason "error": the model
 *                     or provider failed after pi exhausted its own retries.
 *   4. `stop`       — anything else, including a session with no assistant turn.
 */
export function classifyTurnEnd(entries: ReadonlyArray<SessionEntryLike>): TurnEnd {
    const {lastAssistant, lastCompaction} = tailPositions(entries)
    const last = lastAssistant >= 0 ? entries[lastAssistant].message : undefined
    if (last && wasAborted(last)) return 'aborted'
    if (lastCompaction > lastAssistant) return 'compaction'
    if (last?.stopReason === 'error') return 'error'
    return 'stop'
}

/**
 * The provider's error cause for an `error` turn end — the message the run's
 * "stopped at …" line quotes so the real cause is not lost. Undefined unless the
 * last assistant message ended with stopReason "error".
 */
export function turnErrorMessage(entries: ReadonlyArray<SessionEntryLike>): string | undefined {
    const {lastAssistant} = tailPositions(entries)
    const last = lastAssistant >= 0 ? entries[lastAssistant].message : undefined
    if (last?.stopReason !== 'error' || wasAborted(last)) return undefined
    return last.errorMessage ?? 'model error'
}

/** True when the last assistant turn was aborted (ESC / watchdog). */
const wasInterrupted = (entries: ReadonlyArray<SessionEntryLike>): boolean =>
    classifyTurnEnd(entries) === 'aborted'

// ─── Session seam ────────────────────────────────────────────────────────────

/**
 * The slice of the replacement-session context the supervision needs.
 * `sendUserMessage` lives on ReplacedSessionContext (not the base command ctx,
 * and not re-exported from the package), so we narrow to just what we call.
 */
export type SteerCtx = ExtensionCommandContext & {
    sendUserMessage(content: string, options?: {deliverAs?: 'steer' | 'followUp'}): Promise<void>
}

/**
 * What the resume/steer loops genuinely need from the session — no more. Built
 * from a live ctx by {@link turnDepsFor}; a test builds one from plain fakes.
 */
export interface ImplementationTurnDeps {
    /** The live session entries — the only thing the classifier reads. */
    entries: () => ReadonlyArray<SessionEntryLike>
    /** Test seam over the module-level one-shot; the real reader is the default. */
    consumeGuardTermination?: () => boolean
    /** Queue a follow-up user turn on the (idle) session. */
    send: (text: string) => Promise<void>
    /** Wait for the session to go idle again. */
    waitForIdle: () => Promise<void>
    /** Solicit steering text after an interrupt; undefined/empty = pause the run. */
    ask: () => Promise<string | undefined>
    /** Optional trail for the decisions taken; absent → silent. */
    log?: (msg: string) => void
}

/** Dialog copy for the post-interrupt steering prompt. */
const STEER_TITLE = 'Paused — steer the model'
const STEER_PLACEHOLDER = 'Type guidance to continue this task, or leave empty to pause'
/** Remote-card copy for the same prompt. The browser has no placeholder ghost
 *  text, so the pause affordance must be spelled out in the question itself
 *  (Skip = empty answer = pause, same as an empty local submit). */
const STEER_QUESTION =
    'Paused — the implementation was interrupted.\n'
    + 'Type guidance to continue this task, or Skip to pause the run.'

export interface SuperviseOptions {
    /**
     * Ask the user for a steering message after they interrupt (ESC) the
     * implementation turn. Return text to continue the same task as another turn,
     * or undefined/empty to pause the run. Defaults to a bridged SessionUI.ask
     * (local TUI input raced against a remote browser card); injectable so the
     * steer loop is testable without a real dialog.
     */
    promptSteer?: (ctx: ExtensionCommandContext) => Promise<string | undefined>
    log?: (msg: string) => void
}

/** Bind the supervision deps to a live session context. */
export function turnDepsFor(ctx: SteerCtx, opts: SuperviseOptions = {}): ImplementationTurnDeps {
    // Fan the prompt out through the bridge (local TUI input + remote browser
    // card, first answer wins) instead of a raw ctx.ui.input: an interrupt can
    // come from the remote Stop button just as well as a terminal ESC, and a
    // terminal-only dialog leaves the remote viewer staring at a silently
    // paused run. Remote Skip returns '' → same pause path as an empty local
    // submit.
    const ask =
        opts.promptSteer
        ?? (c =>
            new SessionUI(c).ask({
                localTitle: STEER_TITLE,
                localPlaceholder: STEER_PLACEHOLDER,
                question: STEER_QUESTION,
                allowSkip: true
            }))
    return {
        entries: () => ctx.sessionManager.getEntries() as ReadonlyArray<SessionEntryLike>,
        send: text => ctx.sendUserMessage(text, {deliverAs: 'followUp'}),
        waitForIdle: () => ctx.waitForIdle(),
        ask: () => ask(ctx),
        log: opts.log
    }
}

// ─── Resume across compactions ───────────────────────────────────────────────

/**
 * Nudge that resumes an implementation turn the runtime parked at a compaction
 * boundary. It must let a turn that was genuinely finished (then tipped over the
 * threshold by its own final message) confirm completion without inventing busywork.
 * The classifier sees only the boundary's POSITION, so it cannot tell "paused
 * mid-task by compaction" from "finished, then compacted"; the wording lets a done
 * turn end in one line.
 */
export const CONTINUE_AFTER_COMPACTION =
    'Your context was automatically compacted. Continue implementing this task from '
    + 'exactly where you left off, and keep going until it is fully done. If the '
    + 'implementation is already complete, say so in one line and stop — do not invent '
    + 'extra work or restart the task.'

/**
 * Safety cap on compaction-driven resumes for a single implementation turn. Each
 * resume follows a real compaction, which pi only runs once `shouldCompact` says
 * the context crossed its threshold. The cap exists to stop a pathological loop
 * from auto-sending forever with no user watching. Hitting it stops resuming and
 * lets the verify gate and `/task-auto-resume` catch any leftover incompleteness.
 */
export const MAX_COMPACTION_RESUMES = 20

/** How a guard-stopped turn is reported. Named so a caller can tell it from a
 *  provider error: the fix is a different task, not a retry of this one. */
export const GUARD_TERMINATED =
    'the runaway guard stopped this turn: one tool call was repeated past every warning'

/**
 * Resume an implementation turn that went idle at a threshold-compaction boundary.
 * The runtime compacts and parks at idle without auto-continuing; we send a
 * continue and wait again, repeating across successive compactions until the turn
 * ends on a real assistant message (genuine completion). A user ESC takes priority
 * (`classifyTurnEnd` ranks `aborted` above `compaction`, so the steer loop handles
 * it), and the safety cap bounds a runaway. Returns the number of resumes
 * performed (0 when the turn did not end on a compaction).
 */
export async function resumeAcrossCompactions(deps: ImplementationTurnDeps): Promise<number> {
    let resumes = 0
    while (resumes < MAX_COMPACTION_RESUMES && classifyTurnEnd(deps.entries()) === 'compaction') {
        deps.log?.(`implementation: parked at a compaction boundary — resume ${resumes + 1}`)
        await deps.send(CONTINUE_AFTER_COMPACTION)
        await deps.waitForIdle()
        resumes++
    }
    return resumes
}

// ─── Steer until done ────────────────────────────────────────────────────────

/**
 * After the implementation turn settles, honour a user ESC by letting them steer.
 *
 * `waitForIdle` resolves both on natural completion AND on an ESC (which aborts
 * the turn → idle). When the last turn was aborted, the host's main input loop is
 * blocked inside our command handler, so a message typed in the editor would only
 * queue, never run: interactive-mode's submit handler calls `onInputCallback` when
 * the session is idle, and that callback is set only inside `getUserInput()` — the
 * REPL loop we are holding — so the text lands in `pendingUserInputs` instead. We
 * therefore solicit the steering text ourselves and feed it back as another turn
 * via `sendUserMessage`, which forwards to `prompt()` and, on an idle session, runs
 * the turn rather than queueing it. Repeat until a turn finishes uninterrupted.
 *
 * A WATCHDOG abort never reaches this prompt: its recovery turn is posted from
 * `agent_settled` (recovery-turn.ts), and pi runs it before `waitForIdle`
 * resolves, so the turn read here is the recovery's own.
 *
 * Returns true when the user declined to steer (empty/cancelled) and the run
 * should pause; false when the implementation completed (steered or not).
 */
export async function steerUntilDone(deps: ImplementationTurnDeps): Promise<boolean> {
    while (wasInterrupted(deps.entries())) {
        const steer = await deps.ask()
        if (steer === undefined || steer.trim().length === 0) {
            deps.log?.('implementation: interrupted, user declined to steer — pausing')
            return true // pause
        }
        deps.log?.('implementation: interrupted, steering with user text')
        await deps.send(steer)
        await deps.waitForIdle()
    }
    return false
}

// ─── The sequence ────────────────────────────────────────────────────────────

export interface ImplementationOutcome {
    /**
     * The user interrupted the implementation (ESC) and then declined to steer
     * (empty steer prompt) — they want the run to pause rather than continue. A
     * plain ESC followed by steering text does NOT set this: that case loops on the
     * same task until a turn finishes uninterrupted.
     */
    interrupted: boolean
    /**
     * The failure cause when the turn ended with stopReason "error" (the
     * model/provider died mid-implementation after the task file was already
     * marked `completed` at spec-handoff). Undefined when the turn ended cleanly,
     * and never set alongside `interrupted`.
     */
    error?: string
    /** Compaction resumes performed before the turn reached its real end. */
    resumes: number
}

/**
 * Supervise an implementation turn from the first idle after spec delivery until
 * its REAL end: resume across any compaction boundaries first (so steering and
 * error inspection see the turn's actual end, not a compaction pause), then let
 * the user steer across interrupts, then read how the final turn ended. The
 * caller has already awaited the first idle.
 */
export async function superviseImplementation(
    ctx: SteerCtx,
    opts: SuperviseOptions = {}
): Promise<ImplementationOutcome> {
    return superviseWith(turnDepsFor(ctx, opts))
}

/** {@link superviseImplementation} over an already-bound deps object (tests). */
export async function superviseWith(deps: ImplementationTurnDeps): Promise<ImplementationOutcome> {
    const resumes = await resumeAcrossCompactions(deps)
    const interrupted = await steerUntilDone(deps)
    // A user-declined steer (interrupted) is its own paused path; otherwise
    // inspect how the turn actually ended.
    // The runaway guard ends a turn WITHOUT an error stopReason, so classifyTurnEnd
    // reads `'stop'` and the caller would verify a half-done implementation and
    // re-deliver to a model that deterministically re-thrashes. Consumed here
    // because this is the one place that reports how the turn really ended.
    const guardEnded = deps.consumeGuardTermination?.() ?? consumeGuardTermination()
    const error =
        interrupted ? undefined
        : guardEnded ? GUARD_TERMINATED
        : turnErrorMessage(deps.entries())
    return {interrupted, error, resumes}
}
