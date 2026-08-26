/**
 * The reasoning-mismatch startup hint.
 *
 * Like brave-warning, almost everything that matters is a REFUSAL: it must not
 * paint outside a TUI, when every group inherits, when no model has resolved, or
 * when the model honours what was asked. A hint that fires wrongly tells a
 * working setup it is broken.
 *
 * The one thing it must do is fire on the shape nobody else can see: a level the
 * user set and the model will silently change.
 */
import {describe, expect, test} from 'bun:test'
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import {
    formatCapabilityConflict,
    formatReasoningWarning,
    registerReasoningWarning,
    settingsFrom
} from './reasoning-warning.js'
import {DEFAULT_CONFIG, type PiTaskConfig} from '../config/config.js'
import {REASONING_GROUPS} from '../config/reasoning.js'

type SessionStart = (event: unknown, ctx: unknown) => void

/**
 * The handler pi would have subscribed, driven by an EXPLICIT config.
 *
 * The settings source is injected rather than read from the live singleton:
 * every one of these tests used to mutate `getConfig()` and put it back, which
 * still leaves the result depending on what was saved before the suite ran.
 */
function sessionStartHandler(cfg: PiTaskConfig): SessionStart {
    let handler: SessionStart | undefined
    const pi = {
        on: (event: string, h: SessionStart) => {
            if (event === 'session_start') handler = h
        }
    }
    registerReasoningWarning(pi as unknown as ExtensionAPI, () => settingsFrom(cfg))
    return handler!
}

/** An explicit config in a given mode. Never `getConfig()`. */
const cfgIn = (mode: PiTaskConfig['reasoningMode']): PiTaskConfig => ({
    ...DEFAULT_CONFIG,
    reasoningLevels: {...DEFAULT_CONFIG.reasoningLevels},
    reasoningMode: mode
})

interface FakeUi {
    widgets: Array<{key: string; state: unknown}>
    listeners: number
    press: () => void
    ctx: unknown
}

/** `throwOn` makes the named ui call throw, standing in for a stale ctx. */
function fakeCtx(mode: string, model: unknown, throwOn?: 'setWidget'): FakeUi {
    const widgets: Array<{key: string; state: unknown}> = []
    const handlers = new Set<() => unknown>()
    const ui = {
        theme: {fg: (_slot: string, s: string) => s},
        setWidget: (key: string, state: unknown) => {
            if (throwOn === 'setWidget') throw new Error('stale ctx')
            widgets.push({key, state})
        },
        onTerminalInput: (h: () => unknown) => {
            handlers.add(h)
            return () => handlers.delete(h)
        }
    }
    return {
        widgets,
        get listeners() {
            return handlers.size
        },
        press: () => {
            for (const h of [...handlers]) h()
        },
        ctx: {mode, ui, model}
    }
}

/** A model with no reasoning at all — the strongest mismatch source there is. */
const DEAD_MODEL = {name: 'Local GGUF', reasoning: false}
/** The live Qwen3.8 entry from this machine's models.json. */
const GOOD_MODEL = {
    name: 'Qwen3.8 27B',
    reasoning: true,
    thinkingLevelMap: {minimal: 'low', low: 'low', medium: 'medium', high: 'xhigh'}
}

describe('when it stays silent', () => {
    test('the SHIPPED config warns about nothing, even on a model with no reasoning', () => {
        // The real anti-nag: with every group on `inherit`, nobody who has not
        // opted in ever sees this — not even on a model with no reasoning at all.
        const ui = fakeCtx('tui', DEAD_MODEL)
        sessionStartHandler(DEFAULT_CONFIG)({}, ui.ctx)
        expect(ui.widgets).toHaveLength(0)
        expect(ui.listeners).toBe(0)
    })

    test('never paints outside a TUI', () => {
        for (const mode of ['print', 'json', 'rpc']) {
            const ui = fakeCtx(mode, DEAD_MODEL)
            sessionStartHandler(cfgIn('on'))({}, ui.ctx)
            expect(ui.widgets).toHaveLength(0)
        }
    })

    test('says nothing when no model has resolved', () => {
        const ui = fakeCtx('tui', undefined)
        sessionStartHandler(cfgIn('on'))({}, ui.ctx)
        expect(ui.widgets).toHaveLength(0)
    })

    test('says nothing when the model honours what was asked', () => {
        const ui = fakeCtx('tui', GOOD_MODEL)
        sessionStartHandler(cfgIn('on'))({}, ui.ctx)
        expect(ui.widgets).toHaveLength(0)
    })
})

describe('when it fires', () => {
    test('warns once and names the model it checked', () => {
        const ui = fakeCtx('tui', DEAD_MODEL)
        sessionStartHandler(cfgIn('on'))({}, ui.ctx)
        expect(ui.widgets).toHaveLength(1)
        expect(JSON.stringify(ui.widgets[0])).toContain('Local GGUF')
    })

    test('fires on the OFF direction too', () => {
        // A model whose map nulls `off` clamps UP: the user turned thinking off
        // and still pays for it. Same predicate, opposite direction.
        const clampsUp = {
            name: 'Clamps Up',
            reasoning: true,
            thinkingLevelMap: {off: null, minimal: null, low: null, medium: 'medium'}
        }
        const ui = fakeCtx('tui', clampsUp)
        sessionStartHandler(cfgIn('off'))({}, ui.ctx)
        expect(ui.widgets).toHaveLength(1)
        expect(JSON.stringify(ui.widgets[0])).toContain('off→medium')
    })

    test('clears on the first keystroke and drops its listener', () => {
        const ui = fakeCtx('tui', DEAD_MODEL)
        sessionStartHandler(cfgIn('on'))({}, ui.ctx)
        expect(ui.listeners).toBe(1)
        ui.press()
        expect(ui.widgets.at(-1)?.state).toBeUndefined()
        expect(ui.listeners).toBe(0)
    })

    test('a stale ctx is swallowed, not thrown at the session', () => {
        const ui = fakeCtx('tui', DEAD_MODEL, 'setWidget')
        expect(() => sessionStartHandler(cfgIn('on'))({}, ui.ctx)).not.toThrow()
        expect(ui.listeners).toBe(0)
    })
})

describe('formatReasoningWarning', () => {
    test('is null when there is nothing to say', () => {
        expect(formatReasoningWarning('m', [])).toBeNull()
    })

    test('names at most two groups and counts the rest', () => {
        const many = REASONING_GROUPS.map(group => ({
            group,
            wanted: 'medium' as const,
            actual: 'off' as const
        }))
        const line = formatReasoningWarning('m', many)!
        expect(line).toContain(`+${REASONING_GROUPS.length - 2} more`)
        // A line long enough to list seven groups is a line nobody reads.
        expect(line).toContain(`${REASONING_GROUPS[0]} medium→off`)
        expect(line).not.toContain(`${REASONING_GROUPS[3]} medium→off`)
    })

    test('names both the file to fix and the way out', () => {
        const line = formatReasoningWarning('m', [
            {group: 'gate', wanted: 'off', actual: 'medium'}
        ])!
        expect(line).toContain('models.json')
        expect(line).toContain('inherit')
    })
})

describe('formatCapabilityConflict', () => {
    test('says nothing when the server could not be read', () => {
        expect(formatCapabilityConflict(null, true)).toBeNull()
        expect(formatCapabilityConflict(null, false)).toBeNull()
    })

    test('says nothing when server and models.json agree', () => {
        expect(formatCapabilityConflict(true, true)).toBeNull()
        expect(formatCapabilityConflict(false, false)).toBeNull()
    })

    test('names the /login llama.cpp dead-knob case explicitly', () => {
        // The one failure the host-side clamp cannot see: a capable server
        // described to pi as having no reasoning, because pi's built-in
        // llama.cpp provider hardcodes reasoning:false.
        const line = formatCapabilityConflict(true, false)!
        expect(line).toContain('/login llama.cpp')
        expect(line).toContain('models.json')
    })

    test('names the reverse — a template that cannot do levels', () => {
        expect(formatCapabilityConflict(false, true)).toContain('on/off')
    })
})
