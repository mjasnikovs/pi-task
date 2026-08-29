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
    registerReasoningWarning
} from '../../src/workers/reasoning-warning.js'
import {DEFAULT_CONFIG, type PiTaskConfig} from '../../src/config/config.js'
import {effectiveReasoning, REASONING_GROUPS} from '../../src/config/reasoning.js'

type SessionStart = (event: unknown, ctx: unknown) => void

/**
 * The handler pi would have subscribed, driven by an EXPLICIT config.
 *
 * The settings source is injected rather than read from the live singleton:
 * every one of these tests would otherwise mutate `getConfig()` and put it back, which
 * still leaves the result depending on what was saved before the suite ran.
 */
function sessionStartHandler(cfg: PiTaskConfig): SessionStart {
    let handler: SessionStart | undefined
    const pi = {
        on: (event: string, h: SessionStart) => {
            if (event === 'session_start') handler = h
        }
    }
    registerReasoningWarning(pi as unknown as ExtensionAPI, () => effectiveReasoning(cfg))
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
    test('the SHIPPED config warns about nothing on a model that can reason', () => {
        // The anti-nag, on the machine the table was measured on: nobody who has
        // not opted in ever sees this.
        const ui = fakeCtx('tui', GOOD_MODEL)
        sessionStartHandler(DEFAULT_CONFIG)({}, ui.ctx)
        expect(ui.widgets).toHaveLength(0)
        expect(ui.listeners).toBe(0)
    })
})

describe('when the shipped table itself is the mismatch', () => {
    /**
     * BEHAVIOUR DELTA. Asserting silence on DEAD_MODEL
     * too, and the reason it held was that every WRITTEN cell was `off` — a
     * level a model without reasoning already honours, so there was nothing to
     * warn about. `planning: 'medium'` is the first cell that ASKS for thinking,
     * so on a model that cannot think the shipped default is now itself a
     * mismatch the user never chose. Firing is correct: the plan child will
     * silently get no thinking whatever the table says.
     */
    test('the SHIPPED config warns on a model with no reasoning at all', () => {
        const ui = fakeCtx('tui', DEAD_MODEL)
        sessionStartHandler(DEFAULT_CONFIG)({}, ui.ctx)
        expect(ui.widgets).toHaveLength(1)
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

describe('the server probe that refines the cause line', () => {
    /**
     * This whole describe was unreachable before the hint became an adapter over
     * `session-hint`: the probe was called inline on `model.baseUrl`, and no test
     * model here carries one. `formatCapabilityConflict` had four pure tests
     * while the branch that USES it had none.
     */
    const SERVED_MODEL = {...DEAD_MODEL, baseUrl: 'http://127.0.0.1:8080'}

    /** The handler, with both seams supplied. */
    function servedHandler(
        probe: (baseUrl: string) => Promise<{supportsReasoningEffort: boolean} | null>
    ): SessionStart {
        let handler: SessionStart | undefined
        const pi = {
            on: (event: string, h: SessionStart) => {
                if (event === 'session_start') handler = h
            }
        }
        registerReasoningWarning(
            pi as unknown as ExtensionAPI,
            () => effectiveReasoning(DEFAULT_CONFIG),
            probe as never
        )
        return handler!
    }

    const settle = async (): Promise<void> => {
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
    }

    test('a server that DOES support reasoning names models.json as the culprit', async () => {
        const ui = fakeCtx('tui', SERVED_MODEL)

        servedHandler(async () => ({supportsReasoningEffort: true}))({}, ui.ctx)
        await settle()

        expect(ui.widgets).toHaveLength(2)
        expect(String(ui.widgets[1].state)).toContain('reasoning:false')
        expect(String(ui.widgets[1].state)).toContain('/login llama.cpp')
    })

    test('no probe runs when the model carries no baseUrl', async () => {
        const ui = fakeCtx('tui', DEAD_MODEL)
        let probed = 0

        servedHandler(async () => {
            probed += 1
            return {supportsReasoningEffort: true}
        })({}, ui.ctx)
        await settle()

        expect(probed).toBe(0)
        expect(ui.widgets).toHaveLength(1)
    })

    test('a probe that fails leaves the warning exactly as painted', async () => {
        const ui = fakeCtx('tui', SERVED_MODEL)

        servedHandler(async () => {
            throw new Error('connection refused')
        })({}, ui.ctx)
        await settle()

        expect(ui.widgets).toHaveLength(1)
        expect(String(ui.widgets[0].state)).toContain('will not run the reasoning levels')
    })

    test('a probe that agrees with models.json adds nothing', async () => {
        const ui = fakeCtx('tui', SERVED_MODEL)

        servedHandler(async () => ({supportsReasoningEffort: false}))({}, ui.ctx)
        await settle()

        expect(ui.widgets).toHaveLength(1)
    })
})
