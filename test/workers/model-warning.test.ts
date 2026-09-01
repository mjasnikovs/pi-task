/**
 * The once-per-session model resolution, and the hint it produces.
 *
 * This pass is the ONLY place that can answer "can a child resolve this spec?",
 * because five of the six argv producers have no extension context and the
 * catalogue is not fully on disk. Everything downstream — whether `--model` is
 * emitted at all, and which context window arms the churn rule — reads what it
 * leaves behind, so the cases below are the whole contract.
 */
import {describe, expect, test} from 'bun:test'
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import {
    findModelProblems,
    formatModelWarning,
    registerModelWarning,
    resolveModelCells,
    type ModelLookup
} from '../../src/workers/model-warning.js'
import {
    groupWindow,
    isSpecUsable,
    setGroupWindows,
    setUnusableSpecs
} from '../../src/config/group-args.js'
import {CHILD_GROUPS, type ChildGroup} from '../../src/config/groups.js'
import {MODEL_INHERIT} from '../../src/config/group-models.js'

const specs = (over: Partial<Record<ChildGroup, string>> = {}): Record<ChildGroup, string> =>
    Object.fromEntries(CHILD_GROUPS.map(g => [g, over[g] ?? MODEL_INHERIT])) as Record<
        ChildGroup,
        string
    >

const lookup = (known: string[], fromExtension: string[] = []): ModelLookup => ({
    find: (p, i) => (known.includes(`${p}/${i}`) ? {} : undefined),
    extensionProviders: new Set(fromExtension)
})

describe('findModelProblems', () => {
    test('an all-inherit table has no problems and asks no questions', () => {
        let asked = 0
        const counting: ModelLookup = {
            find: () => {
                asked += 1
                return {}
            },
            extensionProviders: new Set()
        }
        expect(findModelProblems(counting, specs())).toEqual([])
        expect(asked).toBe(0)
    })

    test('a resolvable spec is not a problem', () => {
        expect(findModelProblems(lookup(['acme/small']), specs({gate: 'acme/small'}))).toEqual([])
    })

    test('a spec no registry knows is `unresolved`', () => {
        expect(findModelProblems(lookup([]), specs({gate: 'acme/gone'}))).toEqual([
            {group: 'gate', spec: 'acme/gone', why: 'unresolved'}
        ])
    })

    test('a spec with no provider prefix is `unresolved`, not a crash', () => {
        expect(findModelProblems(lookup([]), specs({gate: 'bare-id'}))[0]?.why).toBe('unresolved')
    })

    test('an extension-provided provider is flagged, NOT dropped', () => {
        // It works whenever that extension is whitelisted for children, and we
        // cannot tell which extension registered it. Getting it wrong exits 1
        // loudly, so a warning is enough and a drop would break a working setup.
        expect(findModelProblems(lookup(['x/one'], ['x']), specs({phase: 'x/one'}))).toEqual([
            {group: 'phase', spec: 'x/one', why: 'extension'}
        ])
    })

    test('an OpenRouter-style id is split on the FIRST slash', () => {
        const l = lookup(['openrouter/z-ai/glm-4.6'])
        expect(findModelProblems(l, specs({gate: 'openrouter/z-ai/glm-4.6'}))).toEqual([])
    })
})

describe('formatModelWarning', () => {
    test('says nothing when nothing is wrong', () => {
        expect(formatModelWarning([])).toBeNull()
    })

    test('names the cell, the effect and the fix', () => {
        const line = formatModelWarning([{group: 'gate', spec: 'acme/gone', why: 'unresolved'}])!
        expect(line).toContain('gate→acme/gone')
        expect(line).toContain('models.json')
        expect(line).toContain('/task-config')
    })

    test('the extension cause names the child whitelist, not models.json', () => {
        // Different problem, different fix. Merging the two sentences would send
        // the user to the wrong file.
        const line = formatModelWarning([{group: 'phase', spec: 'x/one', why: 'extension'}])!
        expect(line).toContain('child extensions')
        expect(line).toContain('--no-extensions')
    })

    test('at most two cells per cause, then a count', () => {
        const many = CHILD_GROUPS.map(group => ({group, spec: 'a/b', why: 'unresolved' as const}))
        const line = formatModelWarning(many)!
        expect(line).toContain(`+${CHILD_GROUPS.length - 2} more`)
    })

    test('both causes appear when both exist', () => {
        const line = formatModelWarning([
            {group: 'gate', spec: 'acme/gone', why: 'unresolved'},
            {group: 'phase', spec: 'x/one', why: 'extension'}
        ])!
        expect(line).toContain('no such model here')
        expect(line).toContain('provider comes from an extension')
    })
})

describe('the resolution pass', () => {
    const ctx = (known: Record<string, number>, fromExtension: string[] = []) =>
        ({
            model: {contextWindow: 1_000},
            modelRegistry: {
                find: (p: string, i: string) =>
                    known[`${p}/${i}`] === undefined ?
                        undefined
                    :   {contextWindow: known[`${p}/${i}`]},
                getRegisteredProviderIds: () => fromExtension
            }
        }) as never

    const reset = (): void => {
        setUnusableSpecs([])
        setGroupWindows({})
    }

    test('fills BOTH the argv drop and the window table from one walk', () => {
        try {
            resolveModelCells(ctx({'acme/big': 200_000}), specs({gate: 'acme/big'}))
            expect(isSpecUsable('acme/big')).toBe(true)
            expect(groupWindow('gate')).toBe(200_000)
        } finally {
            reset()
        }
    })

    test('an unresolvable spec is dropped from argv and keeps the parent window', () => {
        try {
            resolveModelCells(ctx({}), specs({gate: 'acme/gone'}))
            expect(isSpecUsable('acme/gone')).toBe(false)
            // 1_000 is the parent's, not a guess: too small a window kills a
            // healthy child, so an unresolved group must not invent one.
            expect(groupWindow('gate')).toBe(1_000)
        } finally {
            reset()
        }
    })

    test('an `inherit` group gets NO window, so the LIVE parent value is used', () => {
        // Storing the parent's window here would freeze a session_start snapshot
        // in front of the per-run value. Switch the session model with Ctrl+P to
        // a bigger one and every child would then be judged against the old
        // window — the churn rule fires early and kills a healthy child.
        try {
            resolveModelCells(ctx({'acme/big': 200_000}), specs({gate: 'acme/big'}))
            expect(groupWindow('gate')).toBe(200_000)
            expect(groupWindow('phase')).toBeUndefined()
        } finally {
            reset()
        }
    })

    test('a ctx whose registry THROWS degrades instead of exploding', () => {
        // `ctx.model` and `ctx.modelRegistry` are GETTERS that call
        // assertActive() and throw on a stale context. The window walk touches
        // both, so unguarded it would throw after setUnusableSpecs had already
        // run — losing the windows, the hint, and any later handler.
        //
        // The degrade is deliberate in both directions: nothing is condemned
        // (claiming every spec is unresolved would drop every --model flag on a
        // session whose runtime merely was not ready), and no window is stored.
        const hostile = {
            get model(): never {
                throw new Error('stale context')
            },
            get modelRegistry(): never {
                throw new Error('stale context')
            }
        } as never
        try {
            setUnusableSpecs(['acme/stale'])
            expect(() => resolveModelCells(hostile, specs({gate: 'acme/gone'}))).not.toThrow()
            expect(isSpecUsable('acme/gone')).toBe(true)
            // The previous session's verdict is cleared, not left to rot.
            expect(isSpecUsable('acme/stale')).toBe(true)
            expect(groupWindow('gate')).toBeUndefined()
        } finally {
            reset()
        }
    })

    test('an extension-provided spec is NOT dropped from argv', () => {
        try {
            resolveModelCells(ctx({'x/one': 5}, ['x']), specs({gate: 'x/one'}))
            expect(isSpecUsable('x/one')).toBe(true)
        } finally {
            reset()
        }
    })

    test('it runs in EVERY mode, not only in a TUI', () => {
        // registerSessionHint returns early when ctx.mode !== 'tui'. Folding the
        // pass into the hint would leave the argv drop and the churn windows
        // disarmed for every headless run, with nobody watching to notice.
        const handlers: Array<(e: unknown, c: unknown) => void> = []
        const pi = {
            on: (event: string, h: (e: unknown, c: unknown) => void) => {
                if (event === 'session_start') handlers.push(h)
            }
        }
        registerModelWarning(pi as unknown as ExtensionAPI, () => specs({gate: 'acme/gone'}))
        try {
            const headless = {...(ctx({}) as object), mode: 'print'}
            for (const h of handlers) h({}, headless)
            expect(isSpecUsable('acme/gone')).toBe(false)
        } finally {
            reset()
        }
    })
})
