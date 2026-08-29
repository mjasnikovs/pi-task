/**
 * Context-usage resolution — the one piece of math every child-status mirror
 * shares. `ChildStatus` (child-status.ts) folds it into its `onContextUsage` for
 * the planning and gate children; the single-task widget (TaskRunner) calls it
 * directly, because its state is the whole-run `WidgetState`, not one child's.
 */

import type {ContextSnapshot} from '../shared/child-process.js'

/**
 * The parent session's context window, or 0 when the model doesn't expose it.
 *
 * The parameter is the STRUCTURAL MINIMUM this reads, not one of pi's context
 * interfaces. It took `ExtensionCommandContext` and immediately cast it away,
 * which is a lie that also excluded the plain `ExtensionContext` a TOOL is
 * handed — the very caller (`workers/pi-worker.ts`) that needs the window to arm
 * the churn rule. Both pi contexts satisfy this shape.
 */
export function getParentContextWindow(ctx: {model?: {contextWindow?: number}}): number {
    return ctx.model?.contextWindow ?? 0
}

/**
 * Fold a raw context snapshot into a display snapshot: prefer the child's
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
