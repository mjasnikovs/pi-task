/**
 * Failure classification — map runtime errors to task state transitions,
 * widget flash messages, and user notifications.
 */

import type {ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import {updateTaskFrontMatter} from './task-file.js'
import {flashTerminalWidget} from './widget.js'
import {LoopExhaustedError, LeakedToolCallError, USER_CANCELLED} from './child-runner.js'

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

export function classifyFailure(err: unknown, aborted: boolean): FailureClass {
    const msg = err instanceof Error ? err.message : String(err)
    if (aborted || msg === USER_CANCELLED) {
        return {state: 'cancelled', notify: 'cancelled.', level: 'warning'}
    }
    if (err instanceof LoopExhaustedError) {
        return {
            state: 'failed',
            reason: `loop detected ${err.history.length}× in ${err.phase}`,
            flash: 'loop_detected',
            notify: `failed: ${err.phase} loop detected ${err.history.length}×. Resume to retry.`,
            level: 'error'
        }
    }
    if (err instanceof LeakedToolCallError) {
        return {
            state: 'failed',
            reason: `leaked tool call in ${err.phase}: ${err.marker.trim()}`,
            flash: 'leaked_tool_call',
            notify: `failed: ${err.phase} wrote a tool call as text instead of running it — it never executed. Resume to retry.`,
            level: 'error'
        }
    }
    if (msg === 'no_verify_block') {
        return {
            state: 'failed',
            reason: 'no_verify_block',
            flash: 'no_verify_block',
            notify: 'failed: spec has no VERIFY block. Resume to edit and try again.',
            level: 'error'
        }
    }
    if (msg.startsWith('compose_invalid')) {
        return {
            state: 'failed',
            reason: msg.slice(0, 200),
            flash: 'compose_invalid',
            notify: `failed: compose produced malformed spec (${msg.replace(/^compose_invalid:\s*/, '')}). Resume to retry.`,
            level: 'error'
        }
    }
    if (/ECONNREFUSED|fetch failed|connect/i.test(msg)) {
        return {
            state: 'failed',
            reason: `model_unreachable: ${msg.slice(0, 120)}`,
            flash: 'model_unreachable',
            notify: 'failed: model unreachable.',
            level: 'error'
        }
    }
    return {
        state: 'failed',
        reason: msg.slice(0, 200),
        flash: msg.slice(0, 80),
        notify: `failed: ${msg.slice(0, 120)}`,
        level: 'error'
    }
}

export async function handleFailure(
    err: unknown,
    ctx: ExtensionCommandContext,
    cwd: string,
    id: string,
    aborted: boolean
): Promise<void> {
    const c = classifyFailure(err, aborted)
    await updateTaskFrontMatter(cwd, id, {state: c.state, reason: c.reason})
    flashTerminalWidget(ctx, c.state, id, c.flash)
    ctx.ui.notify(`${id} ${c.notify}`, c.level)
}
