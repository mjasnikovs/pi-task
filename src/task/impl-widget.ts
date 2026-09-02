/**
 * Implementation-turn status widget.
 *
 * `TaskRunner._deliverSpec` is preceded by `_disposeWidget()`, so the phase widget
 * (widget.ts) is gone before the spec is handed off. Without this module the host
 * agent's implementation turn — the longest, most visible part of a run — would
 * show only pi's own working indicator, whose default message is the literal
 * `"Working..."`. This keeps the SAME rich status block alive across that turn
 * (task id · implementing/elapsed/context bar · ↳ last tool), driven by the host's
 * own live `ctx.getContextUsage()`, which pi declares as
 * `getContextUsage(): ContextUsage | undefined`.
 *
 * Event-driven rather than poll-wrapped, because the two delivery paths differ:
 *
 *   • /task (fire-and-forget): the command returns right after
 *     `piApi.sendUserMessage(spec, {deliverAs: 'followUp'})`, so the host runs the
 *     impl turn AFTER this code is gone and only an `agent_start` handler can pick
 *     it up. Armed one-shot, and `agent_end` disarms it.
 *   • /task-auto (awaited): the caller blocks across `waitForIdle` plus any resume
 *     or steer turns. Armed sticky — each `agent_start` re-shows the widget,
 *     `agent_end` only hides it between turns, and the caller disarms in a
 *     `finally` once the whole implementation phase has settled.
 *
 * `_deliverSpec` picks between them with `oneShot: !this._implAwaited`.
 *
 * A single module-level slot is enough because only one task runs at a time —
 * `orchestrator.ts` keeps one module-level `activeTask`.
 */

import type {ExtensionAPI, ExtensionContext} from '@earendil-works/pi-coding-agent'
import {
    WIDGET_KEY,
    WIDGET_REFRESH_MS,
    buildImplLines,
    buildImplData,
    type ContextSnapshot,
    type ImplState
} from './widget.js'
import {setTaskWidget} from '../remote/session-state.js'

export interface ImplWidgetMeta {
    taskId: string
    title: string
    label?: string
}

interface ArmedState {
    meta: ImplWidgetMeta
    oneShot: boolean
    startedAt: number
}

let armed: ArmedState | null = null
let lastLine: string | undefined
let timer: ReturnType<typeof setInterval> | null = null
let activeCtx: ExtensionContext | null = null

/** Map the host's live context usage to the widget snapshot, or undefined when the
 *  token count is unknown. pi types `ContextUsage.tokens` as `number | null` and
 *  documents the null as "right after compaction, before next LLM response". */
function snapshot(ctx: ExtensionContext): ContextSnapshot | undefined {
    const u = ctx.getContextUsage?.()
    if (!u || u.tokens == null) return undefined
    return {tokens: u.tokens, contextWindow: u.contextWindow, percent: u.percent ?? 0}
}

function render(): void {
    if (!armed || !activeCtx) return
    const ctx = activeCtx
    const state: ImplState = {
        taskId: armed.meta.taskId,
        title: armed.meta.title,
        label: armed.meta.label,
        startedAt: armed.startedAt,
        lastLine,
        contextUsage: snapshot(ctx)
    }
    try {
        ctx.ui.setWidget(WIDGET_KEY, buildImplLines(state, ctx.ui.theme))
    } catch {
        /* stale ctx */
    }
    setTaskWidget(buildImplLines(state, undefined), buildImplData(state)) // un-themed for the wire
}

function startTimer(): void {
    if (timer) return
    render()
    timer = setInterval(render, WIDGET_REFRESH_MS)
    ;(timer as unknown as {unref?: () => void}).unref?.()
}

function stopTimer(): void {
    if (timer) {
        clearInterval(timer)
        timer = null
    }
}

function clearWidget(): void {
    try {
        activeCtx?.ui.setWidget(WIDGET_KEY, undefined)
    } catch {
        /* stale ctx */
    }
    setTaskWidget(undefined)
}

/** One-line summary of a host tool call for the `↳` trailer (best-effort). */
function formatToolLine(toolName: string, args: unknown): string {
    const a = (args ?? {}) as Record<string, unknown>
    const field = a.path ?? a.file_path ?? a.command ?? a.pattern ?? a.prompt ?? a.query ?? a.url
    const detail = typeof field === 'string' ? ' ' + field.replace(/\s+/g, ' ').trim() : ''
    return `${toolName}${detail}`
}

/**
 * Arm the implementation widget just before the spec is handed off. `oneShot`
 * true (fire-and-forget /task) lets `agent_end` disarm it after the single turn;
 * false (awaited /task-auto) keeps it armed until `disarmImplWidget` is called.
 */
export function armImplWidget(meta: ImplWidgetMeta, opts: {oneShot: boolean}): void {
    armed = {meta, oneShot: opts.oneShot, startedAt: Date.now()}
    lastLine = undefined
}

/** Tear down the widget and clear the armed slot (sticky/awaited path). */
export function disarmImplWidget(): void {
    stopTimer()
    clearWidget()
    armed = null
    activeCtx = null
    lastLine = undefined
}

/** @internal Test seam: is a turn currently showing the widget? */
export function implWidgetArmed(): boolean {
    return armed !== null
}

/** Wire the agent-lifecycle handlers that drive the widget. Call once at setup.
 *  All three events are pi's own: `agent_start`, `tool_execution_start` and
 *  `agent_end` each have an `on()` overload, and ToolExecutionStartEvent carries
 *  the `toolName` and `args` read below. */
export function setupImplWidget(pi: ExtensionAPI): void {
    pi.on('agent_start', (_event, ctx) => {
        if (!armed) return
        activeCtx = ctx
        lastLine = undefined
        startTimer()
    })

    pi.on('tool_execution_start', (event, _ctx) => {
        if (!armed) return
        lastLine = formatToolLine(event.toolName, event.args)
    })

    pi.on('agent_end', (_event, _ctx) => {
        if (!armed) return
        stopTimer()
        clearWidget()
        // Fire-and-forget /task: the single impl turn is over, so disarm. Awaited
        // /task-auto leaves the slot armed so the next compaction-resume / steer
        // turn re-shows it; the caller disarms when the phase truly settles.
        if (armed.oneShot) {
            armed = null
            activeCtx = null
            lastLine = undefined
        }
    })
}
