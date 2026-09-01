/**
 * Context-usage resolution — the one piece of math every child-status mirror
 * shares. `ChildStatus` (child-status.ts) folds it into its `onContextUsage` for
 * the planning and gate children; the single-task widget (TaskRunner) calls it
 * directly, because its state is the whole-run `WidgetState`, not one child's.
 */

import type {ContextSnapshot} from '../shared/child-process.js'
import {getConfig, type PiTaskConfig} from '../config/config.js'
import {MODEL_INHERIT, splitSpec} from '../config/group-models.js'
import type {ChildGroup} from '../config/groups.js'

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
 * The window for the model ONE GROUP's children will actually run on.
 *
 * This number drives the widget and, more importantly, `StallDetector`'s
 * context-churn rule, and the two error directions are not symmetric. A parent
 * window LARGER than the child's makes churn fire late — degraded, and the
 * no-new-ground rule still covers it. A parent window SMALLER makes churn fire
 * early and KILL A HEALTHY CHILD. A big-context research model under a small
 * host model is a real false positive, which is why this exists at all.
 *
 * For the same reason there is no `min(parent, group)`: that would import the
 * dangerous direction on purpose.
 *
 * `inherit`, an unresolvable spec, or a model with no declared window all return
 * exactly `getParentContextWindow(ctx)` — byte-identical to the behaviour before
 * per-group models existed.
 *
 * Callers WITHOUT a ctx read `groupWindow` from config/group-args.ts instead,
 * which the session pass fills from this. One producer, so the two views cannot
 * describe different models.
 */
export function contextWindowForGroup(
    ctx: {
        model?: {contextWindow?: number}
        modelRegistry?: {find: (p: string, i: string) => unknown}
    },
    group: ChildGroup,
    cfg: PiTaskConfig = getConfig()
): number {
    return contextWindowForSpec(ctx, cfg.groupModels[group])
}

/**
 * The same answer for a spec the caller already has.
 *
 * The session pass needs this: it walks an INJECTED spec table, and reaching for
 * `getConfig()` here would let the window it stores describe a different model
 * from the one it just checked.
 */
export function contextWindowForSpec(
    ctx: {
        model?: {contextWindow?: number}
        modelRegistry?: {find: (p: string, i: string) => unknown}
    },
    spec: string
): number {
    if (spec === MODEL_INHERIT) return getParentContextWindow(ctx)
    const parts = splitSpec(spec)
    const found = parts && ctx.modelRegistry?.find(parts.provider, parts.id)
    const window = (found as {contextWindow?: number} | undefined)?.contextWindow ?? 0
    return window > 0 ? window : getParentContextWindow(ctx)
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
