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
 * The parameter is the STRUCTURAL MINIMUM this reads, deliberately, rather than
 * one of pi's context interfaces. Naming `ExtensionCommandContext` here would
 * exclude the plain context a TOOL is handed — and that is a real caller:
 * `workers/pi-worker.ts` reads the window through this to arm the churn rule.
 * Both pi contexts carry a `model` whose `contextWindow` is a number, so both
 * satisfy the shape.
 *
 * Returns 0 for a context with no model, and for a model with no window.
 */
export function getParentContextWindow(ctx: {model?: {contextWindow?: number}}): number {
    return ctx.model?.contextWindow ?? 0
}

/**
 * Fold a raw context snapshot into a display snapshot: prefer the child's own
 * contextWindow, else the last known one, else the parent session's; then derive
 * percent against it, falling back to the child's own reported percent when no
 * window is known at all.
 *
 * Run through all four: a child reporting 4000 uses it; a child reporting 0 with a
 * previous 8000 uses that; with neither, the parent's; and with nothing anywhere
 * the reported percent survives untouched. The derived percent clamps at 100.
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
