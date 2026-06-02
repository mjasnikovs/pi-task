/**
 * Terminal widget for the pi-task orchestrator.
 *
 * Renders a live-updating status block showing task id, phase, elapsed time,
 * context usage, and the latest child-process line.
 */

import type {ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import {PHASE_INDEX, PHASE_ORDER, type PhaseName, type TaskState} from './task-file.js'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WidgetState {
    taskId: string
    title: string
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

export function buildWidgetLines(s: WidgetState, theme?: WidgetTheme): string[] {
    const elapsed = formatDuration(Date.now() - s.startedAt)
    const head = `${s.taskId} · ${s.title}`
    const idx = PHASE_INDEX[s.phase]
    const total = PHASE_ORDER.length
    const stepNum = Math.min(idx + 1, total)
    let detail = `phase ${stepNum}/${total} ${s.phase} · ${elapsed}`
    if (s.contextUsage) {
        const {tokens, contextWindow, percent} = s.contextUsage
        if (contextWindow > 0) {
            const text = `${formatContextTokens(tokens)}/${formatContextTokens(contextWindow)} ${contextProgressBar(percent)}`
            detail += ` · ${theme ? contextThresholdColor(theme, percent, text) : text}`
        } else if (tokens > 0) {
            detail += ` · ${formatContextTokens(tokens)}`
        }
    }
    const lines = [head, detail]
    if (s.lastLine) {
        const t =
            s.lastLine.length > WIDGET_LAST_LINE_MAX ?
                s.lastLine.slice(0, WIDGET_LAST_LINE_MAX - 1) + '…'
            :   s.lastLine
        const raw = `↳ ${t}`
        lines.push(theme ? theme.fg('muted', raw) : raw)
    }
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
        try {
            ctx.ui.setWidget(WIDGET_KEY, s ? buildWidgetLines(s, ctx.ui.theme) : undefined)
        } catch {
            /* stale ctx */
        }
    }
    render()
    const timer = setInterval(render, WIDGET_REFRESH_MS)
    ;(timer as unknown as {unref?: () => void}).unref?.()
    return () => clearInterval(timer)
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
    try {
        ctx.ui.setWidget(WIDGET_KEY, [line])
    } catch {
        /* stale ctx */
    }
    setTimeout(() => {
        try {
            ctx.ui.setWidget(WIDGET_KEY, undefined)
        } catch {
            /* stale ctx */
        }
    }, clearMs)
}
