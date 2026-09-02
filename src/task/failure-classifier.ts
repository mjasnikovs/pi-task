/**
 * Failure classification — map runtime errors to task state transitions,
 * widget flash messages, and user notifications.
 */

import type {ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import {updateTaskFrontMatter} from './task-io.js'
import {flashTerminalWidget} from './widget.js'
import {publishLifecycleNotice} from '../remote/bridge.js'
import {ChildFailureError, USER_CANCELLED} from './child-runner.js'
import {streamStallCause} from '../shared/stream-watchdog.js'

// ─── Types ───────────────────────────────────────────────────────────────────

export type NotifyLevel = 'info' | 'warning' | 'error'

export interface FailureClass {
    state: 'failed' | 'cancelled'
    reason?: string
    flash?: string
    notify: string
    level: NotifyLevel
}

// ─── Classifier ──────────────────────────────────────────────────────────────

const failed = (reason: string, flash: string, notify: string): FailureClass => ({
    state: 'failed',
    reason,
    flash,
    notify,
    level: 'error'
})

/**
 * What one phase child failure says to the user. A switch over the cause, so a
 * new arm cannot be added to `ChildFailure` without a notice.
 */
function classifyChildFailure(e: ChildFailureError): FailureClass {
    const f = e.failure
    switch (f.kind) {
        case 'stalled':
            return failed(
                `model_unreachable: ${e.message}`,
                'model_unreachable',
                'failed: model unreachable — restart the model, then resume.'
            )
        // The fix is in the SPEC, not the model, so the notify says which command.
        case 'command-timeout':
            return failed(
                e.message.slice(0, 200),
                'command_timeout',
                `failed: \`${f.toolName}\` never returned on any attempt. Resume to bound it in VERIFY.`
            )
        case 'loop':
            return failed(
                `loop detected ${f.strikes}× in ${e.phase}`,
                'loop_detected',
                `failed: ${e.phase} loop detected ${f.strikes}×. Resume to retry.`
            )
        case 'leaked-tool-call':
            return failed(
                `leaked tool call in ${e.phase}: ${f.text.trim()}`,
                'leaked_tool_call',
                `failed: ${e.phase} wrote a tool call as text instead of running it — it never executed. Resume to retry.`
            )
        case 'model-error':
        case 'stream-stall': {
            const cause = f.kind === 'model-error' ? f.cause : streamStallCause(f.idleMs)
            return failed(
                `model_error in ${e.phase}: ${cause.slice(0, 160)}`,
                'model_error',
                `failed: ${e.phase} — model error: ${cause.slice(0, 120)}. Restart the model, then resume.`
            )
        }
        case 'worker-timeout':
            return failed(
                e.message.slice(0, 200),
                'child_timeout',
                `failed: ${e.phase} ran out of time on every attempt. Resume to retry.`
            )
        case 'aborted':
        case 'exit':
        case 'empty-answer':
            return unreachable(e.message) ?? generic(e.message)
    }
}

const generic = (msg: string): FailureClass =>
    failed(msg.slice(0, 200), msg.slice(0, 80), `failed: ${msg.slice(0, 120)}`)

/**
 * A failure whose only evidence of a dead backend is an errno in its text: a
 * child's stderr, the research phase's own network calls, a probe.
 */
function unreachable(msg: string): FailureClass | undefined {
    if (!/ECONNREFUSED|fetch failed|connect/i.test(msg)) return undefined
    return failed(
        `model_unreachable: ${msg.slice(0, 120)}`,
        'model_unreachable',
        'failed: model unreachable.'
    )
}

export function classifyFailure(err: unknown, aborted: boolean): FailureClass {
    const msg = err instanceof Error ? err.message : String(err)
    if (aborted || msg === USER_CANCELLED) {
        return {state: 'cancelled', notify: 'cancelled.', level: 'warning'}
    }
    if (err instanceof ChildFailureError) return classifyChildFailure(err)
    if (msg === 'no_verify_block') {
        return failed(
            'no_verify_block',
            'no_verify_block',
            'failed: spec has no VERIFY block. Resume to edit and try again.'
        )
    }
    if (msg.startsWith('compose_invalid')) {
        return failed(
            msg.slice(0, 200),
            'compose_invalid',
            `failed: compose produced malformed spec (${msg.replace(/^compose_invalid:\s*/, '')}). Resume to retry.`
        )
    }
    return unreachable(msg) ?? generic(msg)
}

/**
 * Persist, flash and announce a failure, and return the classification.
 *
 * `TaskRunner.run` builds its `RunEnd` from the returned `state` and `reason`.
 * The front-matter write here is what a later resume reads, not the channel
 * this process uses to learn how the run ended.
 */
export async function handleFailure(
    err: unknown,
    ctx: ExtensionCommandContext,
    cwd: string,
    id: string,
    aborted: boolean
): Promise<FailureClass> {
    const c = classifyFailure(err, aborted)
    await updateTaskFrontMatter(cwd, id, {state: c.state, reason: c.reason})
    flashTerminalWidget(ctx, c.state, id, c.flash)
    ctx.ui.notify(`${id} ${c.notify}`, c.level)
    // Mirror to remote viewers. `ctx.ui.notify` reaches the terminal UI only, so
    // without this call the remote view shows nothing when a task fails.
    publishLifecycleNotice(`${id} ${c.notify}`, c.level)
    return c
}
