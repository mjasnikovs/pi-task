/**
 * The reasoning-mismatch startup hint.
 *
 * Like brave-warning, most of what matters here is a REFUSAL: it must not paint
 * outside a TUI, when no model has resolved, or when the model honours what was
 * asked. A hint that fires wrongly tells a working setup it is broken.
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
import {effectiveReasoning, CHILD_GROUPS} from '../../src/config/reasoning.js'

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

/** A model with no reasoning at all: every non-`inherit` level mismatches. */
const DEAD_MODEL = {name: 'Local GGUF', reasoning: false}
/** A reasoning model whose map answers `medium` with `medium`. */
const GOOD_MODEL = {
    name: 'Qwen3.8 27B',
    reasoning: true,
    thinkingLevelMap: {minimal: 'low', low: 'low', medium: 'medium', high: 'xhigh'}
}

describe('when it stays silent', () => {
    test('the SHIPPED config warns about nothing on a model that can reason', () => {
        // The anti-nag: the SHIPPED table on a model that honours it says nothing, so
        // nobody who has not opted into a level ever sees this hint.
        const ui = fakeCtx('tui', GOOD_MODEL)
        sessionStartHandler(DEFAULT_CONFIG)({}, ui.ctx)
        expect(ui.widgets).toHaveLength(0)
        expect(ui.listeners).toBe(0)
    })
})

describe('when the shipped table itself is the mismatch', () => {
    /**
     * An `off` cell is a level a model without reasoning already honours, so a table
     * of nothing but `off` would have nothing to warn about. The shipped table asks
     * for `medium` in several groups, so on a model that cannot think the DEFAULT is
     * itself a mismatch the user never chose — and those children will silently get
     * no thinking whatever the table says. Firing here is correct.
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
        expect(formatReasoningWarning([])).toBeNull()
    })

    test('names at most two groups and counts the rest', () => {
        const many = CHILD_GROUPS.map(group => ({
            group,
            modelName: 'm',
            wanted: 'medium' as const,
            actual: 'off' as const
        }))
        const line = formatReasoningWarning(many)!
        expect(line).toContain(`+${CHILD_GROUPS.length - 2} more`)
        // A line long enough to list every group is a line nobody reads.
        expect(line).toContain(`${CHILD_GROUPS[0]}@m medium→off`)
        expect(line).not.toContain(`${CHILD_GROUPS[3]}@m medium→off`)
    })

    test('each item names its OWN model, because groups can differ', () => {
        // A single leading `model "X" will not run …` is a lie about what was
        // checked the moment two groups run on different models.
        const line = formatReasoningWarning([
            {group: 'gate', modelName: 'acme/dumb', wanted: 'high', actual: 'off'},
            {group: 'phase', modelName: 'zeta/odd', wanted: 'off', actual: 'medium'}
        ])!
        expect(line).toContain('gate@acme/dumb high→off')
        expect(line).toContain('phase@zeta/odd off→medium')
    })

    test('names both the file to fix and the way out', () => {
        const line = formatReasoningWarning([
            {group: 'gate', modelName: 'm', wanted: 'off', actual: 'medium'}
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
        // The one failure the host-side clamp cannot see: a capable server described
        // to pi as having no reasoning. pi's llama.cpp provider builds every model with
        // `reasoning: false` and `compat.supportsReasoningEffort: false`, whatever the
        // server actually does — see its `toPiModel` in the installed pi package.
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
     * `formatCapabilityConflict` is pure and tested above. These cover the branch that
     * CALLS it, which needs a model carrying a `baseUrl` — no other model in this file
     * has one, so the probe would never run.
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

describe('the probe fans out over DISTINCT backends', () => {
    /**
     * Groups can now run on different models, so one probe is no longer the
     * whole story. Eleven groups usually collapse to one or two servers, and the
     * four research workers on one server must not print the same sentence four
     * times.
     */
    const served = (baseUrl: string) => ({...DEAD_MODEL, baseUrl, name: `m@${baseUrl}`})

    function handlerFor(
        models: Record<string, ReturnType<typeof served>>,
        probe: (baseUrl: string) => Promise<{supportsReasoningEffort: boolean} | null>,
        groupSpecs: Record<string, string>
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
            probe as never,
            () => groupSpecs as never
        )
        void models
        return handler!
    }

    const settle = async (): Promise<void> => {
        for (let i = 0; i < 6; i++) await Promise.resolve()
    }

    /** A ctx whose registry answers with the model named by the spec. */
    const registryCtx = (models: Record<string, ReturnType<typeof served>>, mode = 'tui') => {
        const ui = fakeCtx(mode, DEAD_MODEL)
        ;(ui.ctx as {modelRegistry: unknown}).modelRegistry = {
            find: (p: string, i: string) => models[`${p}/${i}`]
        }
        return ui
    }

    test('one probe per distinct baseUrl, however many groups share it', async () => {
        const models = {
            'a/one': served('http://one'),
            'a/two': served('http://one'),
            'b/three': served('http://two')
        }
        const probed: string[] = []
        const ui = registryCtx(models)
        // `planning`, not `gate`: the shipped table runs gate at `off`, which a
        // reasoning:false model honours, so gate never mismatches and its
        // backend is correctly never probed.
        const specs = Object.fromEntries(
            CHILD_GROUPS.map(g => [
                g,
                g === 'planning' ? 'b/three'
                : g.startsWith('research') ? 'a/one'
                : 'a/two'
            ])
        )
        handlerFor(
            models,
            async url => {
                probed.push(url)
                return {supportsReasoningEffort: false}
            },
            specs
        )({}, ui.ctx)
        await settle()
        expect([...probed].sort()).toEqual(['http://one', 'http://two'])
    })

    test('one DEAD endpoint does not blank the line for the others', async () => {
        const models = {'a/one': served('http://live'), 'b/two': served('http://dead')}
        const specs = Object.fromEntries(
            CHILD_GROUPS.map(g => [g, g === 'planning' ? 'b/two' : 'a/one'])
        )
        const ui = registryCtx(models)
        handlerFor(
            models,
            async url => {
                if (url === 'http://dead') throw new Error('connection refused')
                return {supportsReasoningEffort: true}
            },
            specs
        )({}, ui.ctx)
        await settle()
        // The refined line still landed, from the endpoint that answered.
        expect(String(ui.widgets.at(-1)!.state)).toContain('/login llama.cpp')
    })

    test('duplicate cause strings are printed once', async () => {
        const models = {'a/one': served('http://one'), 'b/two': served('http://two')}
        const specs = Object.fromEntries(
            CHILD_GROUPS.map(g => [g, g === 'planning' ? 'b/two' : 'a/one'])
        )
        const ui = registryCtx(models)
        handlerFor(models, async () => ({supportsReasoningEffort: true}), specs)({}, ui.ctx)
        await settle()
        const text = String(ui.widgets.at(-1)!.state)
        const hits = text.split('/login llama.cpp').length - 1
        expect(hits).toBe(1)
    })
})
