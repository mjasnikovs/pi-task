/**
 * Context-usage resolution — shared by the single-task widget (TaskRunner) and
 * the /task-auto planning loader (defaultDeps), which both mirror a child's
 * context_usage events into a display snapshot with identical math.
 */

import type {ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import type {ContextSnapshot} from '../shared/child-process.js'

/** The parent session's context window, or 0 when the model doesn't expose it. */
export function getParentContextWindow(ctx: ExtensionCommandContext): number {
    return (
        ((ctx as unknown as {model?: {contextWindow?: number}}).model?.contextWindow as
            | number
            | undefined) ?? 0
    )
}

/**
 * Fold a raw context_usage snapshot into a display snapshot: prefer the child's
 * own contextWindow, else the last known one, else the parent session's; then
 * derive percent against it — falling back to the child's reported percent when
 * no window is known at all.
 */
export function resolveContextUsage(
    snapshot: ContextSnapshot,
    prev: ContextSnapshot | undefined,
    parentContextWindow: number
): ContextSnapshot {
    const cw =
        snapshot.contextWindow > 0 ?
            snapshot.contextWindow
        :   prev?.contextWindow || parentContextWindow
    const percent = cw > 0 ? Math.min(100, (snapshot.tokens / cw) * 100) : snapshot.percent
    return {tokens: snapshot.tokens, contextWindow: cw, percent}
}
