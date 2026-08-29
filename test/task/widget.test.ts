import {describe, expect, test} from 'bun:test'
import {
    buildAutoLoaderLines,
    buildImplLines,
    buildWidgetData,
    buildAutoLoaderData,
    buildImplData,
    formatContextDetail,
    WIDGET_LAST_LINE_MAX,
    type AutoLoaderState,
    type ImplState,
    type WidgetState,
    startWidget
} from '../../src/task/widget.js'
import {getState, _setSink, reset} from '../../src/remote/session-state.js'

describe('buildAutoLoaderLines', () => {
    const base: AutoLoaderState = {
        title: 'Add dark mode',
        step: 'clarify',
        stepNum: 1,
        stepTotal: 2,
        startedAt: Date.now()
    }

    test('renders the same /task-style block: head + planning step/elapsed', () => {
        const lines = buildAutoLoaderLines(base)
        expect(lines).toHaveLength(2)
        expect(lines[0]).toBe('/task-auto · Add dark mode')
        expect(lines[1]).toContain('planning 1/2 clarify · ')
    })

    test('appends the latest child output line as a muted ↳ trailer', () => {
        const lines = buildAutoLoaderLines({...base, lastLine: 'reading src/index.ts'})
        expect(lines).toHaveLength(3)
        expect(lines[2]).toBe('↳ reading src/index.ts')
    })

    test('truncates an over-long child output line', () => {
        const long = 'x'.repeat(WIDGET_LAST_LINE_MAX + 50)
        const lines = buildAutoLoaderLines({...base, lastLine: long})
        expect(lines[2].length).toBeLessThanOrEqual(WIDGET_LAST_LINE_MAX + 2) // "↳ " prefix
        expect(lines[2].endsWith('…')).toBe(true)
    })

    test('shows context usage with a bar when a window is known', () => {
        const lines = buildAutoLoaderLines({
            ...base,
            contextUsage: {tokens: 12_000, contextWindow: 200_000, percent: 6}
        })
        expect(lines[1]).toContain('12k/200k')
    })

    test('kind "enforce" renders the guideline pass, not a numbered planning step', () => {
        const lines = buildAutoLoaderLines({...base, kind: 'enforce'})
        expect(lines[0]).toBe('/task-auto · Add dark mode')
        expect(lines[1]).toContain('enforcing guidelines · ')
        expect(lines[1]).not.toContain('planning')
    })

    test('kind "enforce" shows the context bar like the planning loader', () => {
        const lines = buildAutoLoaderLines({
            ...base,
            kind: 'enforce',
            contextUsage: {tokens: 12_000, contextWindow: 200_000, percent: 6}
        })
        expect(lines[1]).toContain('enforcing guidelines · ')
        expect(lines[1]).toContain('12k/200k')
    })

    test('kind "enforce" still appends the latest child output trailer', () => {
        const lines = buildAutoLoaderLines({
            ...base,
            kind: 'enforce',
            lastLine: 'editing eslint.config.mjs'
        })
        expect(lines[2]).toBe('↳ editing eslint.config.mjs')
    })
})

describe('buildImplLines', () => {
    const base: ImplState = {
        taskId: 'TASK_0007',
        title: 'Add dark mode',
        startedAt: Date.now()
    }

    test('renders the /task-style head + an "implementing" detail line', () => {
        const lines = buildImplLines(base)
        expect(lines).toHaveLength(2)
        expect(lines[0]).toBe('TASK_0007 · Add dark mode')
        expect(lines[1]).toContain('implementing · ')
        expect(lines[1]).not.toContain('phase')
    })

    test('shows the host context bar like the phase widget', () => {
        const lines = buildImplLines({
            ...base,
            contextUsage: {tokens: 48_000, contextWindow: 200_000, percent: 24}
        })
        expect(lines[1]).toContain('implementing · ')
        expect(lines[1]).toContain('48k/200k')
    })

    test('appends the latest tool line as a muted ↳ trailer', () => {
        const lines = buildImplLines({...base, lastLine: 'read src/index.ts'})
        expect(lines).toHaveLength(3)
        expect(lines[2]).toBe('↳ read src/index.ts')
    })
})

describe('formatContextDetail', () => {
    test('renders tokens/window with a progress bar', () => {
        expect(formatContextDetail({tokens: 12_000, contextWindow: 200_000, percent: 6})).toContain(
            '12k/200k'
        )
    })

    test('renders bare token count when window is unknown', () => {
        expect(formatContextDetail({tokens: 1500, contextWindow: 0, percent: 0})).toBe('1.5k')
    })

    test('returns null when there is nothing to show', () => {
        expect(formatContextDetail({tokens: 0, contextWindow: 0, percent: 0})).toBeNull()
    })
})

describe('structured WidgetData builders', () => {
    test('buildWidgetData carries title, phase badge, progress, and elapsed', () => {
        const d = buildWidgetData({
            taskId: 'TASK_0001',
            title: 'demo',
            phase: 'grill',
            startedAt: Date.now()
        })
        expect(d.title).toBe('TASK_0001 · demo')
        expect(d.phase).toBe('grill')
        expect(d.done).toBeGreaterThan(0)
        expect(d.total).toBeGreaterThan(0)
        expect(d.elapsed).toMatch(/^\d+:\d{2}$/)
        expect(d.action).toBeUndefined()
    })

    test('buildWidgetData carries the current action from lastLine (capped)', () => {
        const d = buildWidgetData({
            taskId: 'TASK_0001',
            title: 'demo',
            phase: 'grill',
            startedAt: Date.now(),
            lastLine: 'worker:tooling: read: src/index.ts'
        })
        expect(d.action).toBe('worker:tooling: read: src/index.ts')

        const long = buildWidgetData({
            taskId: 'TASK_0001',
            title: 'demo',
            phase: 'grill',
            startedAt: Date.now(),
            lastLine: 'x'.repeat(400)
        })
        expect(long.action).toHaveLength(200)
        expect(long.action?.endsWith('…')).toBe(true)
    })

    test('buildAutoLoaderData numbers the planning stage but not the enforce pass', () => {
        const planning = buildAutoLoaderData({
            title: 'Add dark mode',
            step: 'clarify',
            stepNum: 1,
            stepTotal: 2,
            startedAt: Date.now(),
            lastLine: 'decompose: 4 tasks'
        })
        expect(planning.title).toBe('/task-auto · Add dark mode')
        expect(planning.phase).toBe('clarify')
        expect(planning.done).toBe(1)
        expect(planning.total).toBe(2)
        expect(planning.action).toBe('decompose: 4 tasks')

        const enforce = buildAutoLoaderData({
            title: 'Add dark mode',
            step: 'clarify',
            stepNum: 1,
            stepTotal: 2,
            startedAt: Date.now(),
            kind: 'enforce'
        })
        expect(enforce.phase).toBe('enforcing guidelines')
        expect(enforce.done).toBeUndefined()
        expect(enforce.total).toBeUndefined()
    })

    test('buildImplData is an unnumbered "implementing" phase', () => {
        const d = buildImplData({taskId: 'TASK_0002', title: 'x', startedAt: Date.now()})
        expect(d.title).toBe('TASK_0002 · x')
        expect(d.phase).toBe('implementing')
        expect(d.done).toBeUndefined()
    })
})

test('startWidget mirrors the rendered lines to the single task slot', () => {
    reset()
    const sent: unknown[] = []
    _setSink(msg => sent.push(msg))
    const state: WidgetState = {taskId: 'TASK_0001', title: 'demo', phase: 'grill', startedAt: 0}
    const ctx = {
        hasUI: true,
        ui: {theme: {fg: (_: string, s: string) => s}, setWidget: () => {}}
    } as unknown as import('@earendil-works/pi-coding-agent').ExtensionCommandContext
    const stop = startWidget(ctx, () => state)
    expect(getState().taskWidget).not.toBeNull()
    expect(sent.some(m => (m as {type: string}).type === 'widget')).toBe(true)
    stop()
    // Stopping must clear the remote slot too, otherwise the browser keeps
    // showing the status panel after handoff. (Symmetric with startAutoLoader.)
    expect(getState().taskWidget).toBeNull()
    expect(
        sent.some(m => {
            const w = m as {type: string; lines?: unknown}
            return w.type === 'widget' && w.lines === null
        })
    ).toBe(true)
})
