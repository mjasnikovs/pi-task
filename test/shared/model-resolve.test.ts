/**
 * The one spec → Model seam. Every rule that used to be re-decided per caller —
 * the first-slash split, exact `find`, what `inherit` means, a getter that
 * throws — is pinned here once, because a caller can no longer get it wrong on
 * its own.
 */
import {describe, expect, test} from 'bun:test'
import {
    resolveGroupModels,
    resolveModel,
    resolveModelEndpoints,
    specOf,
    type ModelContext,
    type PiModel
} from '../../src/shared/model-resolve.js'
import {CHILD_GROUPS, type ChildGroup} from '../../src/config/groups.js'
import {MODEL_INHERIT} from '../../src/config/group-models.js'

/** As much of pi's `Model` as this seam reads; the rest is never touched. */
const model = (over: Partial<PiModel> = {}): PiModel =>
    ({
        provider: 'acme',
        id: 'big',
        name: 'Acme Big',
        reasoning: true,
        baseUrl: 'http://one',
        contextWindow: 200_000,
        ...over
    }) as PiModel

/** A ctx whose registry knows exactly the given models, keyed `provider/id`. */
const ctx = (
    known: Record<string, PiModel>,
    over: {session?: PiModel; fromExtension?: string[]; asked?: string[]} = {}
): ModelContext => ({
    ...(over.session ? {model: over.session} : {}),
    modelRegistry: {
        find: (p, i) => {
            over.asked?.push(`${p}|${i}`)
            return known[`${p}/${i}`]
        },
        getRegisteredProviderIds: () => over.fromExtension ?? [],
        getAvailable: () => Object.values(known)
    }
})

const stale: ModelContext = {
    get model(): never {
        throw new Error('stale context')
    },
    get modelRegistry(): never {
        throw new Error('stale context')
    }
}

const specs = (over: Partial<Record<ChildGroup, string>> = {}): Record<ChildGroup, string> =>
    Object.fromEntries(CHILD_GROUPS.map(g => [g, over[g] ?? MODEL_INHERIT])) as Record<
        ChildGroup,
        string
    >

describe('specOf', () => {
    test('is the inverse of the first-slash split', () => {
        expect(specOf({provider: 'openrouter', id: 'z-ai/glm-4.6'})).toBe('openrouter/z-ai/glm-4.6')
    })
})

describe('resolveModel', () => {
    test('`inherit` is the SESSION model, named by its own spec', () => {
        const session = model({provider: 'local', id: 'Qwen.gguf'})
        const r = resolveModel(ctx({}, {session}), MODEL_INHERIT)
        expect(r?.spec).toBe('local/Qwen.gguf')
        expect(r?.handle).toBe(session)
    })

    test('`inherit` with no session model is undefined, not a crash', () => {
        expect(resolveModel(ctx({}), MODEL_INHERIT)).toBeUndefined()
    })

    test('an OpenRouter-style spec is split on the FIRST slash', () => {
        const asked: string[] = []
        const m = model({provider: 'openrouter', id: 'z-ai/glm-4.6'})
        const r = resolveModel(
            ctx({'openrouter/z-ai/glm-4.6': m}, {asked}),
            'openrouter/z-ai/glm-4.6'
        )
        expect(asked).toEqual(['openrouter|z-ai/glm-4.6'])
        expect(r?.spec).toBe('openrouter/z-ai/glm-4.6')
        expect(r?.handle).toBe(m)
    })

    test('a spec the registry does not know is undefined', () => {
        expect(resolveModel(ctx({}), 'acme/gone')).toBeUndefined()
    })

    test('a spec with no provider prefix asks nothing and is undefined', () => {
        const asked: string[] = []
        expect(resolveModel(ctx({'acme/big': model()}, {asked}), 'bare-id')).toBeUndefined()
        expect(asked).toEqual([])
    })

    test('a ctx whose getters THROW is undefined, in both spellings', () => {
        // `ctx.model` and `ctx.modelRegistry` call assertActive() and throw on a
        // stale context. A session hint must not take the session down.
        expect(resolveModel(stale, MODEL_INHERIT)).toBeUndefined()
        expect(resolveModel(stale, 'acme/big')).toBeUndefined()
    })

    test('a ctx with no registry at all resolves only `inherit`', () => {
        const session = model()
        expect(resolveModel({model: session}, 'acme/big')).toBeUndefined()
        expect(resolveModel({model: session}, MODEL_INHERIT)?.handle).toBe(session)
    })

    test('fromExtension names a provider a host extension registered', () => {
        const c = ctx(
            {'x/one': model({provider: 'x', id: 'one'}), 'acme/big': model()},
            {
                fromExtension: ['x']
            }
        )
        expect(resolveModel(c, 'x/one')?.fromExtension).toBe(true)
        expect(resolveModel(c, 'acme/big')?.fromExtension).toBe(false)
    })

    test('fromExtension for `inherit` is judged on the session model’s provider', () => {
        const session = model({provider: 'x', id: 'one'})
        expect(
            resolveModel(ctx({}, {session, fromExtension: ['x']}), MODEL_INHERIT)?.fromExtension
        ).toBe(true)
    })

    test('the facts the reasoning check wants are carried verbatim', () => {
        const m = model({name: '', thinkingLevelMap: {off: null}, baseUrl: '', contextWindow: 0})
        const r = resolveModel(ctx({'acme/big': m}), 'acme/big')!
        // No name → the id, so the warning can still say which model.
        expect(r.name).toBe('big')
        expect(r.reasoning).toBe(true)
        expect(r.thinkingLevelMap).toEqual({off: null})
        // Empty is ABSENT: a probe cannot be aimed at '', and `||` must fall
        // through to the parent window on 0.
        expect('baseUrl' in r).toBe(false)
        expect(r.contextWindow).toBe(0)
    })
})

describe('resolveGroupModels', () => {
    test('an `inherit` cell is usable and carries NO window', () => {
        // Storing the parent's window would freeze a session_start snapshot in
        // front of the live per-run value: switch the session model with Ctrl+P
        // to a bigger one and every child is judged against the old window —
        // the churn rule fires early and kills a healthy child.
        const snap = resolveGroupModels(ctx({}, {session: model()}), specs())
        for (const g of CHILD_GROUPS) expect(snap[g]).toEqual({spec: MODEL_INHERIT, usable: true})
    })

    test('an all-inherit table asks the registry nothing', () => {
        const asked: string[] = []
        resolveGroupModels(ctx({'acme/big': model()}, {asked}), specs())
        expect(asked).toEqual([])
    })

    test('a resolved cell carries its window', () => {
        const snap = resolveGroupModels(ctx({'acme/big': model()}), specs({gate: 'acme/big'}))
        expect(snap.gate).toEqual({spec: 'acme/big', usable: true, contextWindow: 200_000})
    })

    test('a model declaring no window gets no window key', () => {
        const m = model({contextWindow: 0, baseUrl: ''})
        const snap = resolveGroupModels(ctx({'acme/big': m}), specs({gate: 'acme/big'}))
        expect(snap.gate).toEqual({spec: 'acme/big', usable: true})
    })

    test('an unknown spec is `unresolved`, unusable, and has no window', () => {
        const snap = resolveGroupModels(ctx({}), specs({gate: 'acme/gone', phase: 'bare-id'}))
        expect(snap.gate).toEqual({spec: 'acme/gone', usable: false, problem: 'unresolved'})
        expect(snap.phase).toEqual({spec: 'bare-id', usable: false, problem: 'unresolved'})
    })

    test('an extension-provided spec is flagged and still USABLE', () => {
        // It works whenever that extension is whitelisted for children, and we
        // cannot tell which extension registered it. Getting it wrong exits 1
        // loudly, so a warning is enough and a drop would break a working setup.
        const c = ctx({'x/one': model({provider: 'x', id: 'one'})}, {fromExtension: ['x']})
        expect(resolveGroupModels(c, specs({gate: 'x/one'})).gate).toEqual({
            spec: 'x/one',
            usable: true,
            contextWindow: 200_000,
            problem: 'extension'
        })
    })

    test('a registry that THROWS condemns nothing and stores no window', () => {
        // Claiming every spec unresolved would drop every --model flag on a
        // session whose runtime merely was not ready.
        const snap = resolveGroupModels(stale, specs({gate: 'acme/gone'}))
        expect(snap.gate).toEqual({spec: 'acme/gone', usable: true})
    })
})

describe('resolveModelEndpoints', () => {
    test('maps every available model with a url, by spec', () => {
        const c = ctx({
            'acme/big': model(),
            'local/q': model({provider: 'local', id: 'q', baseUrl: 'http://two'}),
            'acme/mute': model({id: 'mute', baseUrl: ''})
        })
        expect([...resolveModelEndpoints(c)]).toEqual([
            ['acme/big', 'http://one'],
            ['local/q', 'http://two']
        ])
    })

    test('empty for a registry that throws or cannot enumerate', () => {
        expect(resolveModelEndpoints(stale).size).toBe(0)
        expect(resolveModelEndpoints({modelRegistry: {find: () => undefined}}).size).toBe(0)
    })
})
