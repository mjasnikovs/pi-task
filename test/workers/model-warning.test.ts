/**
 * The once-per-session model resolution, and the hint it produces.
 *
 * This pass is the ONLY place that can answer "can a child resolve this spec?",
 * because five of the six argv producers have no extension context and the
 * catalogue is not fully on disk. Everything downstream — whether `--model` is
 * emitted at all, which context window arms the churn rule, and which url the
 * dead-backend probe asks — reads what it leaves behind, so the cases below are
 * the whole contract. The resolution rules themselves are pinned in
 * shared/model-resolve.test.ts; this is the publishing and the rendering.
 */
import {describe, expect, test} from 'bun:test'
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import {
    formatModelWarning,
    modelProblems,
    registerModelWarning
} from '../../src/workers/model-warning.js'
import {
    groupModelArgs,
    groupWindow,
    modelEndpoint,
    setGroupModels,
    setModelEndpoints
} from '../../src/config/group-args.js'
import {resolveGroupModels} from '../../src/shared/model-resolve.js'
import {DEFAULT_CONFIG, type PiTaskConfig} from '../../src/config/config.js'
import {CHILD_GROUPS, type ChildGroup} from '../../src/config/groups.js'
import {MODEL_INHERIT} from '../../src/config/group-models.js'

const specs = (over: Partial<Record<ChildGroup, string>> = {}): Record<ChildGroup, string> =>
    Object.fromEntries(CHILD_GROUPS.map(g => [g, over[g] ?? MODEL_INHERIT])) as Record<
        ChildGroup,
        string
    >

/** A ctx whose registry knows the given specs, each with a window and a url. */
const ctx = (known: Record<string, number>, fromExtension: string[] = []) =>
    ({
        model: {contextWindow: 1_000},
        modelRegistry: {
            find: (p: string, i: string) =>
                known[`${p}/${i}`] === undefined ?
                    undefined
                :   {
                        provider: p,
                        id: i,
                        contextWindow: known[`${p}/${i}`],
                        baseUrl: `http://${p}`
                    },
            getRegisteredProviderIds: () => fromExtension,
            getAvailable: () =>
                Object.entries(known).map(([spec, contextWindow]) => {
                    const [provider, id] = spec.split('/') as [string, string]
                    return {provider, id, contextWindow, baseUrl: `http://${provider}`}
                })
        }
    }) as never

const problemsFor = (c: never, s: Record<ChildGroup, string>) =>
    modelProblems(resolveGroupModels(c, s))

describe('modelProblems', () => {
    test('an all-inherit table has no problems', () => {
        expect(problemsFor(ctx({}), specs())).toEqual([])
    })

    test('a resolvable spec is not a problem', () => {
        expect(problemsFor(ctx({'acme/small': 1}), specs({gate: 'acme/small'}))).toEqual([])
    })

    test('a spec no registry knows is `unresolved`', () => {
        expect(problemsFor(ctx({}), specs({gate: 'acme/gone'}))).toEqual([
            {group: 'gate', spec: 'acme/gone', why: 'unresolved'}
        ])
    })

    test('a spec with no provider prefix is `unresolved`, not a crash', () => {
        expect(problemsFor(ctx({}), specs({gate: 'bare-id'}))[0]?.why).toBe('unresolved')
    })

    test('an extension-provided provider is flagged, NOT dropped', () => {
        expect(problemsFor(ctx({'x/one': 1}, ['x']), specs({phase: 'x/one'}))).toEqual([
            {group: 'phase', spec: 'x/one', why: 'extension'}
        ])
    })

    test('problems come out in group order, whatever the table order', () => {
        const out = problemsFor(ctx({}), specs({implementation: 'a/b', research: 'a/c'}))
        expect(out.map(p => p.group)).toEqual(['research', 'implementation'])
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

describe('the session_start pass', () => {
    /** Register against a fake pi and fire its session_start with `c`. */
    const sessionStart = (c: unknown, s: Record<ChildGroup, string>): void => {
        const handlers: Array<(e: unknown, c: unknown) => void> = []
        const pi = {
            on: (event: string, h: (e: unknown, c: unknown) => void) => {
                if (event === 'session_start') handlers.push(h)
            }
        }
        registerModelWarning(pi as unknown as ExtensionAPI, () => s)
        for (const h of handlers) h({}, c)
    }

    const withModel = (group: ChildGroup, spec: string): PiTaskConfig => ({
        ...DEFAULT_CONFIG,
        groupModels: {...DEFAULT_CONFIG.groupModels, [group]: spec}
    })

    const reset = (): void => {
        setGroupModels({})
        setModelEndpoints(new Map())
    }

    test('fills the argv drop, the window table AND the endpoint map from one walk', () => {
        try {
            sessionStart(ctx({'acme/big': 200_000}), specs({gate: 'acme/big'}))
            expect(groupModelArgs('gate', withModel('gate', 'acme/big'))).toEqual([
                '--model',
                'acme/big'
            ])
            expect(groupWindow('gate')).toBe(200_000)
            expect(modelEndpoint('acme/big')).toBe('http://acme')
        } finally {
            reset()
        }
    })

    test('an unresolvable spec is dropped from argv and keeps NO window', () => {
        try {
            sessionStart(ctx({}), specs({gate: 'acme/gone'}))
            expect(groupModelArgs('gate', withModel('gate', 'acme/gone'))).toEqual([])
            // No window, not a guess: the caller falls back to the LIVE parent
            // value. Too small a window kills a healthy child.
            expect(groupWindow('gate')).toBeUndefined()
        } finally {
            reset()
        }
    })

    test('an `inherit` group gets NO window, so the LIVE parent value is used', () => {
        try {
            sessionStart(ctx({'acme/big': 200_000}), specs({gate: 'acme/big'}))
            expect(groupWindow('gate')).toBe(200_000)
            expect(groupWindow('phase')).toBeUndefined()
        } finally {
            reset()
        }
    })

    test('a ctx whose registry THROWS degrades instead of exploding', () => {
        // `ctx.model` and `ctx.modelRegistry` are GETTERS that call
        // assertActive() and throw on a stale context. The degrade is deliberate
        // in both directions: nothing is condemned (claiming every spec is
        // unresolved would drop every --model flag on a session whose runtime
        // merely was not ready), and no window or url is stored.
        const hostile = {
            get model(): never {
                throw new Error('stale context')
            },
            get modelRegistry(): never {
                throw new Error('stale context')
            }
        }
        try {
            setGroupModels({gate: {spec: 'acme/stale', usable: false, problem: 'unresolved'}})
            setModelEndpoints(new Map([['acme/stale', 'http://stale']]))
            expect(() => sessionStart(hostile, specs({gate: 'acme/gone'}))).not.toThrow()
            expect(groupModelArgs('gate', withModel('gate', 'acme/gone'))).toEqual([
                '--model',
                'acme/gone'
            ])
            // The previous session's verdict is cleared, not left to rot.
            expect(groupWindow('gate')).toBeUndefined()
            expect(modelEndpoint('acme/stale')).toBeUndefined()
        } finally {
            reset()
        }
    })

    test('an extension-provided spec is NOT dropped from argv', () => {
        try {
            sessionStart(ctx({'x/one': 5}, ['x']), specs({gate: 'x/one'}))
            expect(groupModelArgs('gate', withModel('gate', 'x/one'))).toEqual(['--model', 'x/one'])
        } finally {
            reset()
        }
    })

    test('it runs in EVERY mode, not only in a TUI', () => {
        // registerSessionHint returns early when ctx.mode !== 'tui'. Folding the
        // pass into the hint would leave the argv drop and the churn windows
        // disarmed for every headless run, with nobody watching to notice.
        try {
            sessionStart({...(ctx({}) as object), mode: 'print'}, specs({gate: 'acme/gone'}))
            expect(groupModelArgs('gate', withModel('gate', 'acme/gone'))).toEqual([])
        } finally {
            reset()
        }
    })
})
