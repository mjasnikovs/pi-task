/**
 * Terminal widget for the pi-task orchestrator.
 *
 * Renders a live-updating status block showing task id, phase, elapsed time,
 * context usage, and the latest child-process line.
 */

import type {ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import {PHASE_INDEX, PHASE_ORDER, type PhaseName, type TaskState} from './task-types.js'
import {titleForDisplay} from './parsers.js'
import {setTaskWidget} from '../remote/session-state.js'
import type {WidgetData} from '../remote/protocol.js'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WidgetState {
    taskId: string
    title: string
    /** Short display label compressed from `title`; falls back to a truncation when absent. */
    label?: string
    phase: PhaseName
    startedAt: number
    lastLine?: string
    contextUsage?: ContextSnapshot
}

export interface ContextSnapshot {
    tokens: number
    contextWindow: number
    percent: number
}

export type WidgetTheme = ExtensionCommandContext['ui']['theme']

// ─── Constants ───────────────────────────────────────────────────────────────

export const WIDGET_KEY = 'pi-tasks'
export const AUTO_WIDGET_KEY = 'pi-task-auto'
export const WIDGET_REFRESH_MS = 500
export const WIDGET_LAST_LINE_MAX = 120
export const NOTIFY_CLEAR_MS = 3000
export const FAIL_CLEAR_MS = 4000
export const CTX_BAR_WIDTH = 8
export const CTX_BAR_FILLED = '▓'
export const CTX_BAR_EMPTY = '░'
export const CTX_WARN_PERCENT = 80
export const CTX_ERROR_PERCENT = 90

// ─── Formatting helpers ──────────────────────────────────────────────────────

export function formatDuration(ms: number): string {
    const total = Math.floor(ms / 1000)
    const m = Math.floor(total / 60)
    const s = total % 60
    return `${m}:${String(s).padStart(2, '0')}`
}

export function formatContextTokens(count: number): string {
    if (count < 1_000) return count.toString()
    if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`
    if (count < 1_000_000) return `${Math.round(count / 1_000)}k`
    if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`
    return `${Math.round(count / 1_000_000)}M`
}

export function contextProgressBar(percent: number): string {
    const clamped = Math.max(0, Math.min(100, percent))
    const filled = Math.round((clamped / 100) * CTX_BAR_WIDTH)
    return `[${CTX_BAR_FILLED.repeat(filled)}${CTX_BAR_EMPTY.repeat(CTX_BAR_WIDTH - filled)}]`
}

export function contextThresholdColor(theme: WidgetTheme, percent: number, text: string): string {
    if (percent >= CTX_ERROR_PERCENT) return theme.fg('error', text)
    if (percent >= CTX_WARN_PERCENT) return theme.fg('warning', text)
    return text
}

/** Render the `tokens/window [bar]` context suffix, or null when there's nothing to show. */
export function formatContextDetail(usage: ContextSnapshot, theme?: WidgetTheme): string | null {
    const {tokens, contextWindow, percent} = usage
    if (contextWindow > 0) {
        const text = `${formatContextTokens(tokens)}/${formatContextTokens(contextWindow)} ${contextProgressBar(percent)}`
        return theme ? contextThresholdColor(theme, percent, text) : text
    }
    if (tokens > 0) return formatContextTokens(tokens)
    return null
}

/** The current-action string for the structured widget. The browser's
 *  `.widget-action` is `white-space: nowrap` + `text-overflow: ellipsis`, so it
 *  ellipsizes to one line itself — send it capped at 200 rather than truncated to
 *  the terminal's narrower WIDGET_LAST_LINE_MAX. */
function widgetAction(lastLine: string | undefined): string | undefined {
    if (!lastLine) return undefined
    return lastLine.length > 200 ? lastLine.slice(0, 199) + '…' : lastLine
}

/** Render the muted `↳ lastLine` trailer (truncated), or null when there's no line. */
function lastLineTrailer(lastLine: string | undefined, theme?: WidgetTheme): string | null {
    if (!lastLine) return null
    const t =
        lastLine.length > WIDGET_LAST_LINE_MAX ?
            lastLine.slice(0, WIDGET_LAST_LINE_MAX - 1) + '…'
        :   lastLine
    const raw = `↳ ${t}`
    return theme ? theme.fg('muted', raw) : raw
}

export function buildWidgetLines(s: WidgetState, theme?: WidgetTheme): string[] {
    const elapsed = formatDuration(Date.now() - s.startedAt)
    const head = `${s.taskId} · ${titleForDisplay(s)}`
    const idx = PHASE_INDEX[s.phase]
    const total = PHASE_ORDER.length
    const stepNum = Math.min(idx + 1, total)
    let detail = `phase ${stepNum}/${total} ${s.phase} · ${elapsed}`
    if (s.contextUsage) {
        const ctxDetail = formatContextDetail(s.contextUsage, theme)
        if (ctxDetail) detail += ` · ${ctxDetail}`
    }
    const lines = [head, detail]
    const trailer = lastLineTrailer(s.lastLine, theme)
    if (trailer) lines.push(trailer)
    return lines
}

/** Structured mirror of buildWidgetLines for the browser's progress widget. */
export function buildWidgetData(s: WidgetState): WidgetData {
    const idx = PHASE_INDEX[s.phase]
    const total = PHASE_ORDER.length
    const d: WidgetData = {
        title: `${s.taskId} · ${titleForDisplay(s)}`,
        phase: s.phase,
        done: Math.min(idx + 1, total),
        total,
        elapsed: formatDuration(Date.now() - s.startedAt)
    }
    const action = widgetAction(s.lastLine)
    if (action) d.action = action
    return d
}

// ─── Widget lifecycle ────────────────────────────────────────────────────────

export function startWidget(
    ctx: ExtensionCommandContext,
    getState: () => WidgetState | null
): () => void {
    // pi's `ctx.ui` getter calls `runner.assertActive()`, which THROWS once the
    // ctx goes stale (/reload, session replacement) — so the theme read belongs
    // INSIDE the guard, not one line above it. render() runs from a timer, and a
    // throw out of a timer callback is an uncaughtException that terminates the
    // process. Merely swallowing it would throw again every tick, so the stale
    // flag latches and the timer is cleared.
    let stale = false
    const render = () => {
        if (stale) return
        const s = getState()
        // The wire half FIRST, and unguarded: it needs no ctx, so gating it on a
        // local terminal that may not exist would leave a headless host's browser
        // with no phase, no progress and no failure flash.
        setTaskWidget(s ? buildWidgetLines(s, undefined) : undefined, s ? buildWidgetData(s) : null)
        if (!ctx.hasUI) return
        try {
            const lines = s ? buildWidgetLines(s, ctx.ui.theme) : undefined
            ctx.ui.setWidget(WIDGET_KEY, lines)
        } catch {
            stale = true
            clearInterval(timer)
        }
    }
    // The timer is created BEFORE the first render so `timer` is always bound
    // when render's catch reaches for it. Calling render() first instead would
    // hit the `const timer` temporal dead zone — "Cannot access 'timer' before
    // initialization" — on a ctx that is already stale at the first paint.
    const timer = setInterval(render, WIDGET_REFRESH_MS)
    ;(timer as unknown as {unref?: () => void}).unref?.()
    render()
    return () => {
        clearInterval(timer)
        try {
            ctx.ui.setWidget(WIDGET_KEY, undefined)
        } catch {
            /* stale ctx */
        }
        setTaskWidget(undefined)
    }
}

// ─── Auto-planning loader ──────────────────────────────────────────────────
// /task-auto's feature-level children (clarify, decompose) run before any TASK
// id exists, so they can't use the phase widget, and they have no UI of their
// own. This loader renders the SAME status block — head · step/elapsed/context ·
// ↳ last line — so planning is never silent.

export interface AutoLoaderState {
    title: string
    step: string
    stepNum: number
    stepTotal: number
    startedAt: number
    lastLine?: string
    contextUsage?: ContextSnapshot
    /** Which stage this loader is for. Defaults to 'planning', the numbered
     *  clarify/decompose steps — the ONLY kind that carries step numbering. The
     *  other five mirror `GateChildKind` in gate-child.ts: 'enforce' is the
     *  guideline pass, 'verify' the work-verification pass, 'recommend' the
     *  research that picks the recommended action after a verify FAIL, 'lint-fix'
     *  the bounded fix pass for a repo-health verify FAIL, and 'final-fix' the
     *  bounded fix pass for a final-integration-gate FAIL. */
    kind?: 'planning' | 'enforce' | 'verify' | 'recommend' | 'lint-fix' | 'final-fix'
    /** Command shown in the head line. Defaults to '/task-auto'; plan-orchestrator
     *  is the one producer that overrides it, with '/task-plan'. */
    command?: string
}

export function buildAutoLoaderLines(s: AutoLoaderState, theme?: WidgetTheme): string[] {
    const elapsed = formatDuration(Date.now() - s.startedAt)
    const head = `${s.command ?? '/task-auto'} · ${s.title}`
    let detail =
        s.kind === 'enforce' ? `enforcing guidelines · ${elapsed}`
        : s.kind === 'verify' ? `verifying work · ${elapsed}`
        : s.kind === 'recommend' ? `assessing the failure · ${elapsed}`
        : s.kind === 'lint-fix' ? `fixing static findings · ${elapsed}`
        : s.kind === 'final-fix' ? `fixing the final gate · ${elapsed}`
        : `planning ${s.stepNum}/${s.stepTotal} ${s.step} · ${elapsed}`
    if (s.contextUsage) {
        const ctxDetail = formatContextDetail(s.contextUsage, theme)
        if (ctxDetail) detail += ` · ${ctxDetail}`
    }
    const lines = [head, detail]
    const trailer = lastLineTrailer(s.lastLine, theme)
    if (trailer) lines.push(trailer)
    return lines
}

/** Structured mirror of buildAutoLoaderLines. Only the planning kind (or an
 *  absent one) carries done/total; the other five kinds are unnumbered, and the
 *  browser draws its progress bar only when both are present. */
export function buildAutoLoaderData(s: AutoLoaderState): WidgetData {
    const phase =
        s.kind === 'enforce' ? 'enforcing guidelines'
        : s.kind === 'verify' ? 'verifying work'
        : s.kind === 'recommend' ? 'assessing the failure'
        : s.kind === 'lint-fix' ? 'fixing static findings'
        : s.kind === 'final-fix' ? 'fixing the final gate'
        : s.step
    const d: WidgetData = {
        title: `${s.command ?? '/task-auto'} · ${s.title}`,
        phase,
        elapsed: formatDuration(Date.now() - s.startedAt)
    }
    if (!s.kind || s.kind === 'planning') {
        d.done = s.stepNum
        d.total = s.stepTotal
    }
    const action = widgetAction(s.lastLine)
    if (action) d.action = action
    return d
}

/**
 * Start the planning loader widget (same cadence/look as the phase widget).
 * Returns a disposer that stops the refresh and clears the widget. No-op
 * (returns a no-op disposer) when there's no UI.
 */
export function startAutoLoader(
    ctx: ExtensionCommandContext,
    getState: () => AutoLoaderState | null
): () => void {
    // Same staleness hazard as startWidget, and the same wire-half-first order.
    let stale = false
    const render = () => {
        if (stale) return
        const s = getState()
        setTaskWidget(
            s ? buildAutoLoaderLines(s, undefined) : undefined,
            s ? buildAutoLoaderData(s) : null
        )
        if (!ctx.hasUI) return
        try {
            const lines = s ? buildAutoLoaderLines(s, ctx.ui.theme) : undefined
            ctx.ui.setWidget(AUTO_WIDGET_KEY, lines)
        } catch {
            stale = true
            clearInterval(timer)
        }
    }
    // The timer is created BEFORE the first render so `timer` is always bound
    // when render's catch reaches for it. Calling render() first instead would
    // hit the `const timer` temporal dead zone — "Cannot access 'timer' before
    // initialization" — on a ctx that is already stale at the first paint.
    const timer = setInterval(render, WIDGET_REFRESH_MS)
    ;(timer as unknown as {unref?: () => void}).unref?.()
    render()
    return () => {
        clearInterval(timer)
        try {
            ctx.ui.setWidget(AUTO_WIDGET_KEY, undefined)
        } catch {
            /* stale ctx */
        }
        setTaskWidget(undefined)
    }
}

// ─── Implementation-turn loader ──────────────────────────────────────────────
// `TaskRunner` calls `_disposeWidget()` before `_deliverSpec`, so the phase widget
// is gone by the time the host agent builds the spec. Without these builders that
// turn would show only pi's own working indicator, whose default message is the
// literal "Working...". They render the SAME status block (head ·
// implementing/elapsed/context · ↳ last line); impl-widget.ts owns the lifecycle
// that drives them from the host's live context usage.

export interface ImplState {
    taskId: string
    title: string
    /** Short display label compressed from `title`; falls back to a truncation when absent. */
    label?: string
    startedAt: number
    lastLine?: string
    contextUsage?: ContextSnapshot
}

export function buildImplLines(s: ImplState, theme?: WidgetTheme): string[] {
    const elapsed = formatDuration(Date.now() - s.startedAt)
    const head = `${s.taskId} · ${titleForDisplay(s)}`
    let detail = `implementing · ${elapsed}`
    if (s.contextUsage) {
        const ctxDetail = formatContextDetail(s.contextUsage, theme)
        if (ctxDetail) detail += ` · ${ctxDetail}`
    }
    const lines = [head, detail]
    const trailer = lastLineTrailer(s.lastLine, theme)
    if (trailer) lines.push(trailer)
    return lines
}

/** Structured mirror of buildImplLines. The host implementation turn has no step
 *  numbering, so `done`/`total` stay unset and the browser draws no progress bar —
 *  just the phase badge and the elapsed clock. */
export function buildImplData(s: ImplState): WidgetData {
    const d: WidgetData = {
        title: `${s.taskId} · ${titleForDisplay(s)}`,
        phase: 'implementing',
        elapsed: formatDuration(Date.now() - s.startedAt)
    }
    const action = widgetAction(s.lastLine)
    if (action) d.action = action
    return d
}

export function flashTerminalWidget(
    ctx: ExtensionCommandContext,
    state: Exclude<TaskState, 'pending' | 'in_progress' | 'completed'>,
    taskId: string,
    reason: string | undefined
): void {
    const plainLine =
        state === 'cancelled' ?
            `⚠ ${taskId} cancelled`
        :   `✘ ${taskId} failed${reason ? ': ' + reason : ''}`
    const clearMs = state === 'cancelled' ? NOTIFY_CLEAR_MS : FAIL_CLEAR_MS
    setTaskWidget([plainLine])
    // The wire half is already done, so a missing or stale local ctx no longer
    // costs the browser the flash as well. Same staleness hazard as the render
    // timers: bail rather than throw.
    if (ctx.hasUI) {
        try {
            const theme: WidgetTheme = ctx.ui.theme
            const tint = state === 'cancelled' ? 'warning' : 'error'
            ctx.ui.setWidget(WIDGET_KEY, [theme.fg(tint, plainLine)])
        } catch {
            /* stale ctx */
        }
    }
    setTimeout(() => {
        try {
            ctx.ui.setWidget(WIDGET_KEY, undefined)
            setTaskWidget(undefined)
        } catch {
            /* stale ctx */
        }
    }, clearMs)
}
