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

// ─── Widget lifecycle ────────────────────────────────────────────────────────

export function startWidget(
    ctx: ExtensionCommandContext,
    getState: () => WidgetState | null
): () => void {
    if (!ctx.hasUI) return () => {}
    const render = () => {
        const s = getState()
        const lines = s ? buildWidgetLines(s, ctx.ui.theme) : undefined
        const plain = s ? buildWidgetLines(s, undefined) : undefined // un-themed for the wire
        try {
            ctx.ui.setWidget(WIDGET_KEY, lines)
        } catch {
            /* stale ctx */
        }
        setTaskWidget(plain)
    }
    render()
    const timer = setInterval(render, WIDGET_REFRESH_MS)
    ;(timer as unknown as {unref?: () => void}).unref?.()
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
// id exists, so they can't use the phase widget. This loader renders the SAME
// status block — head · step/elapsed/context · ↳ last line — so planning looks
// and feels like a normal /task run while it works toward the drill dialog.

export interface AutoLoaderState {
    title: string
    step: string
    stepNum: number
    stepTotal: number
    startedAt: number
    lastLine?: string
    contextUsage?: ContextSnapshot
    /** Which /task-auto stage this loader is for. Defaults to 'planning' (the
     *  numbered clarify/decompose steps); 'enforce' is the per-task guideline
     *  pass and 'verify' is the per-task work-verification pass, neither of which
     *  has step numbering. */
    kind?: 'planning' | 'enforce' | 'verify'
}

export function buildAutoLoaderLines(s: AutoLoaderState, theme?: WidgetTheme): string[] {
    const elapsed = formatDuration(Date.now() - s.startedAt)
    const head = `/task-auto · ${s.title}`
    let detail =
        s.kind === 'enforce' ? `enforcing guidelines · ${elapsed}`
        : s.kind === 'verify' ? `verifying work · ${elapsed}`
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

/**
 * Start the planning loader widget (same cadence/look as the phase widget).
 * Returns a disposer that stops the refresh and clears the widget. No-op
 * (returns a no-op disposer) when there's no UI.
 */
export function startAutoLoader(
    ctx: ExtensionCommandContext,
    getState: () => AutoLoaderState | null
): () => void {
    if (!ctx.hasUI) return () => {}
    const render = () => {
        const s = getState()
        const lines = s ? buildAutoLoaderLines(s, ctx.ui.theme) : undefined
        const plain = s ? buildAutoLoaderLines(s, undefined) : undefined
        try {
            ctx.ui.setWidget(AUTO_WIDGET_KEY, lines)
        } catch {
            /* stale ctx */
        }
        setTaskWidget(plain)
    }
    render()
    const timer = setInterval(render, WIDGET_REFRESH_MS)
    ;(timer as unknown as {unref?: () => void}).unref?.()
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

export function flashTerminalWidget(
    ctx: ExtensionCommandContext,
    state: Exclude<TaskState, 'pending' | 'in_progress' | 'completed'>,
    taskId: string,
    reason: string | undefined
): void {
    if (!ctx.hasUI) return
    const theme = ctx.ui.theme
    let line: string
    let clearMs: number
    if (state === 'cancelled') {
        line = theme.fg('warning', `⚠ ${taskId} cancelled`)
        clearMs = NOTIFY_CLEAR_MS
    } else {
        line = theme.fg('error', `✘ ${taskId} failed${reason ? ': ' + reason : ''}`)
        clearMs = FAIL_CLEAR_MS
    }
    const plainLine =
        state === 'cancelled' ?
            `⚠ ${taskId} cancelled`
        :   `✘ ${taskId} failed${reason ? ': ' + reason : ''}`
    try {
        ctx.ui.setWidget(WIDGET_KEY, [line])
        setTaskWidget([plainLine])
    } catch {
        /* stale ctx */
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
