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

import type {ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import {SessionUI} from '../remote/bridge.js'
import {consumeWatchdogAbort, WATCHDOG_CANCEL_MARKER} from './command-watchdog.js'

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
 *   1. `aborted`    — the last assistant message has stopReason "aborted". A user
 *                     ESC (or watchdog abort) wins over everything: it is not a
 *                     compaction pause, and the steer loop owns it.
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
    if (last?.stopReason === 'aborted') return 'aborted'
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
    if (last?.stopReason !== 'error') return undefined
    return last.errorMessage ?? 'model error'
}

/** True when the last assistant turn was aborted (ESC / watchdog). */
const wasInterrupted = (entries: ReadonlyArray<SessionEntryLike>): boolean =>
    classifyTurnEnd(entries) === 'aborted'

/**
 * True when the watchdog's reminder follow-up has been DELIVERED into the session
 * after the aborted assistant turn but its own turn has not finished yet — the
 * artifact that confirms a pending watchdog recovery. Scoped after the LAST
 * assistant entry so an earlier fire's reminder (already answered by its own
 * turn) never matches.
 */
export function watchdogReminderDelivered(entries: ReadonlyArray<SessionEntryLike>): boolean {
    const {lastAssistant} = tailPositions(entries)
    for (let i = lastAssistant + 1; i < entries.length; i++) {
        const m = entries[i].message
        if (m === undefined || m.role !== 'user') continue
        const content = m.content
        const text =
            typeof content === 'string' ? content
            : Array.isArray(content) ?
                content
                    .map(b =>
                        b !== null && typeof b === 'object' && 'text' in b ?
                            String((b as {text: unknown}).text)
                        :   ''
                    )
                    .join(' ')
            :   ''
        if (text.includes(WATCHDOG_CANCEL_MARKER)) return true
    }
    return false
}

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
 * Timing knobs for the watchdog-abort guard in {@link steerUntilDone}, injectable
 * so a test can exercise the grace expiry without waiting it out. `graceMs`
 * bounds how long the loop waits for the watchdog's follow-up to be DELIVERED,
 * not to finish: once it lands, the wait for its turn is unbounded. `onFire`
 * sends the follow-up in the same block that raised the flag, so the grace
 * expires only when the flag was already stale.
 */
export interface SteerWatchdogDeps {
    consume: () => boolean
    graceMs: number
    pollMs: number
}

const STEER_WATCHDOG_DEFAULTS: SteerWatchdogDeps = {
    consume: consumeWatchdogAbort,
    graceMs: 10_000,
    pollMs: 100
}

/**
 * What the resume/steer loops genuinely need from the session — no more. Built
 * from a live ctx by {@link turnDepsFor}; a test builds one from plain fakes.
 */
export interface ImplementationTurnDeps {
    /** The live session entries — the only thing the classifier reads. */
    entries: () => ReadonlyArray<SessionEntryLike>
    /** Queue a follow-up user turn on the (idle) session. */
    send: (text: string) => Promise<void>
    /** Wait for the session to go idle again. */
    waitForIdle: () => Promise<void>
    /** Solicit steering text after an interrupt; undefined/empty = pause the run. */
    ask: () => Promise<string | undefined>
    /** The watchdog one-shot flag and the bounded wait for its follow-up. */
    watchdog: SteerWatchdogDeps
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
    /** Watchdog-guard timing overrides (tests); absent → production defaults. */
    watchdog?: Partial<SteerWatchdogDeps>
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
        watchdog: {...STEER_WATCHDOG_DEFAULTS, ...opts.watchdog},
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
 * Wait for a watchdog abort's queued follow-up turn instead of prompting. The
 * abort and the reminder follow-up are two separate steps in the watchdog's
 * onFire, so the steer loop can observe the aborted turn before the reminder is
 * delivered — poll (bounded) until it lands or the follow-up turn has already
 * completed. True = recovery observed, re-check the loop; false = grace expired
 * with no reminder (stale flag) — fall back to the human prompt.
 */
async function awaitWatchdogFollowUp(deps: ImplementationTurnDeps): Promise<boolean> {
    const wd = deps.watchdog
    const deadline = Date.now() + wd.graceMs
    for (;;) {
        if (!wasInterrupted(deps.entries())) return true // follow-up turn already completed
        if (watchdogReminderDelivered(deps.entries())) {
            await deps.waitForIdle() // let the follow-up turn run to completion
            return true
        }
        if (Date.now() >= deadline) return false
        await new Promise<void>(r => setTimeout(r, wd.pollMs))
    }
}

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
 * A WATCHDOG abort also ends the turn with stopReason 'aborted' — indistinguishable
 * from a human ESC by the session entries alone at that instant. The watchdog
 * queues its own recovery follow-up, so prompting there would show a steering
 * dialog to an empty room and wedge an unattended run on the race. The one-shot
 * flag (set synchronously before the abort) routes that case to
 * {@link awaitWatchdogFollowUp} instead; a stale flag degrades to a bounded wait
 * followed by the ordinary prompt, never to a suppressed one.
 *
 * Returns true when the user declined to steer (empty/cancelled) and the run
 * should pause; false when the implementation completed (steered or not).
 */
export async function steerUntilDone(deps: ImplementationTurnDeps): Promise<boolean> {
    while (wasInterrupted(deps.entries())) {
        if (deps.watchdog.consume() && (await awaitWatchdogFollowUp(deps))) {
            deps.log?.('implementation: watchdog abort recovered by its own follow-up')
            continue
        }
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
    const error = interrupted ? undefined : turnErrorMessage(deps.entries())
    return {interrupted, error, resumes}
}
