/**
 * The three silent-failure modes, as named cases. Each is a way a requested
 * thinking level is quietly rewritten: pi reports none of them, which is why
 * the warning exists.
 *
 * This file pins the local copy of pi's clamp against the real thing —
 * @earendil-works/pi-ai's `getSupportedThinkingLevels` and
 * `clampThinkingLevel`. Both were run side by side with `clampToModel` and
 * `supportedThinkingLevels` on every model shape below and agreed on all of
 * them. If pi changes the rule, these cases are where it surfaces.
 */
import {describe, expect, test} from 'bun:test'
import {
    clampToModel,
    reasoningMismatches,
    supportedThinkingLevels,
    THINKING_LADDER,
    type ReasoningModelFacts
} from '../../src/shared/reasoning-capability.js'
import {CHILD_GROUPS, type GroupSetting} from '../../src/config/reasoning.js'

/** A map declaring every level, with high/xhigh/max all folded onto xhigh —
 *  the shape a real local-model entry takes. Its extended levels are DECLARED,
 *  which is what makes xhigh and max supported at all. */
const QWEN38: ReasoningModelFacts = {
    reasoning: true,
    thinkingLevelMap: {
        minimal: 'low',
        low: 'low',
        medium: 'medium',
        high: 'xhigh',
        xhigh: 'xhigh',
        max: 'xhigh'
    }
}

describe('the three silent failures pi never reports', () => {
    test('1. reasoning:false erases the level instead of rejecting it', () => {
        // `reasoning: false` is the first line of pi's own
        // getSupportedThinkingLevels: it returns ["off"] and never consults the
        // map, so EVERY requested level collapses to off. No error, no warning.
        const model: ReasoningModelFacts = {reasoning: false}
        expect(supportedThinkingLevels(model)).toEqual(['off'])
        expect(clampToModel(model, 'medium')).toBe('off')
        expect(clampToModel(model, 'high')).toBe('off')
    })

    test('2. off:null clamps UP — thinking stays on when you turned it off', () => {
        // The clamp scans UPWARD from the requested index before it scans down,
        // so a nulled `off` resolves to the next level that IS available.
        // Asking for off leaves thinking ON. This is the mirror of "reasoning on
        // but unsupported", and it is why the warning reports both directions.
        const model: ReasoningModelFacts = {
            reasoning: true,
            thinkingLevelMap: {off: null, minimal: null, low: null, medium: 'medium'}
        }
        expect(clampToModel(model, 'off')).toBe('medium')
    })

    test('3. a null level clamps to the next one up', () => {
        // Same upward scan: a nulled level resolves to the next one available.
        const model: ReasoningModelFacts = {
            reasoning: true,
            thinkingLevelMap: {off: null, minimal: null, low: null, medium: 'medium'}
        }
        expect(clampToModel(model, 'low')).toBe('medium')
        expect(clampToModel(model, 'minimal')).toBe('medium')
    })
})

describe('supportedThinkingLevels', () => {
    test("the live Qwen3.8 entry supports every level pi's UI offers", () => {
        const supported = supportedThinkingLevels(QWEN38)
        for (const level of ['off', 'minimal', 'low', 'medium', 'high'] as const) {
            expect(supported).toContain(level)
        }
    })

    test('an absent map supports the standard levels but NOT xhigh/max', () => {
        // The asymmetry that decides which levels /task-config may offer. In pi's
        // filter, xhigh and max are kept only when `mapped !== undefined`, while
        // every other level is kept unless explicitly null — so the extended two
        // are opt-in and an absent map excludes exactly those two.
        const supported = supportedThinkingLevels({reasoning: true})
        expect(supported).toEqual(['off', 'minimal', 'low', 'medium', 'high'])
    })

    test('a declared xhigh is supported', () => {
        expect(supportedThinkingLevels(QWEN38)).toContain('xhigh')
    })
})

describe('clampToModel', () => {
    test('a supported level is returned unchanged — the mismatch test depends on it', () => {
        for (const level of THINKING_LADDER) {
            if (!supportedThinkingLevels(QWEN38).includes(level)) continue
            expect(clampToModel(QWEN38, level)).toBe(level)
        }
    })

    test('walks DOWN only when nothing above is available', () => {
        const model: ReasoningModelFacts = {
            reasoning: true,
            thinkingLevelMap: {
                minimal: null,
                low: null,
                medium: null,
                high: null,
                xhigh: null,
                max: null
            }
        }
        expect(clampToModel(model, 'high')).toBe('off')
    })
})

describe('reasoningMismatches', () => {
    const every = (setting: GroupSetting): Record<(typeof CHILD_GROUPS)[number], GroupSetting> =>
        Object.fromEntries(CHILD_GROUPS.map(group => [group, setting])) as Record<
            (typeof CHILD_GROUPS)[number],
            GroupSetting
        >

    /** The same model for every group — the all-`inherit`-models case. */
    const one =
        (facts: ReasoningModelFacts | undefined, name = 'acme/one') =>
        () =>
            facts === undefined ? undefined : {name, ...facts}

    test('says nothing when every group inherits — the shipped state', () => {
        // The real anti-nag: an all-`inherit` table asks for nothing, so nothing
        // can be erased and even a reasoning:false model warrants no warning.
        // Setting a group back to inherit is therefore what silences the hint.
        expect(reasoningMismatches(one({reasoning: false}), every('inherit'))).toEqual([])
    })

    test('says nothing for a group whose model has not resolved', () => {
        expect(reasoningMismatches(one(undefined), every('medium'))).toEqual([])
    })

    test('reports every group a reasoning:false model will erase', () => {
        const out = reasoningMismatches(one({reasoning: false}), every('medium'))
        expect(out).toHaveLength(CHILD_GROUPS.length)
        expect(out[0]).toEqual({
            group: CHILD_GROUPS[0]!,
            modelName: 'acme/one',
            wanted: 'medium',
            actual: 'off'
        })
    })

    test('reports the OFF direction too', () => {
        const model: ReasoningModelFacts = {
            reasoning: true,
            thinkingLevelMap: {off: null, minimal: null, low: null, medium: 'medium'}
        }
        const out = reasoningMismatches(one(model), every('off'))
        expect(out).toHaveLength(CHILD_GROUPS.length)
        expect(out[0]?.wanted).toBe('off')
        expect(out[0]?.actual).toBe('medium')
    })

    test('says nothing when the model honours what was asked', () => {
        expect(reasoningMismatches(one(QWEN38), every('medium'))).toEqual([])
        expect(reasoningMismatches(one(QWEN38), every('off'))).toEqual([])
    })

    test('TWO groups on two different models each carry their OWN name', () => {
        // The whole reason `modelFor` is a function. A single leading
        // `model "X" will not run …` is a lie about what was checked the moment
        // two groups differ.
        const out = reasoningMismatches(
            group =>
                group === 'gate' ?
                    {name: 'acme/dumb', reasoning: false}
                :   {name: 'acme/smart', reasoning: true},
            {...every('inherit'), gate: 'high', phase: 'high'}
        )
        expect(out).toEqual([
            {group: 'gate', modelName: 'acme/dumb', wanted: 'high', actual: 'off'}
        ])
    })

    test('a group whose model is unresolvable is skipped, not reported', () => {
        const out = reasoningMismatches(
            group => (group === 'gate' ? undefined : {name: 'acme/one', reasoning: false}),
            {...every('inherit'), gate: 'high'}
        )
        expect(out).toEqual([])
    })
})
