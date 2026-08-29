/**
 * The three silent-failure modes, as named cases.
 *
 * Each was captured live on 2026-08-25 against this machine's llama-server, with
 * a logging proxy reading the actual request body pi sent. They are the reason
 * the warning exists, so if this file ever goes green for the wrong reason the
 * warning has stopped being able to see them.
 *
 * This also pins the local copy of pi's clamp against the real thing
 * (@earendil-works/pi-ai's getSupportedThinkingLevels / clampThinkingLevel). If
 * pi changes the rule, these cases are where it surfaces.
 */
import {describe, expect, test} from 'bun:test'
import {
    clampToModel,
    reasoningMismatches,
    supportedThinkingLevels,
    THINKING_LADDER,
    type ReasoningModelFacts
} from '../../src/shared/reasoning-capability.js'
import {REASONING_GROUPS, type GroupSetting} from '../../src/config/reasoning.js'

/** The live models.json entry for Qwen3.8 on this box, verbatim. */
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
        // LIVE: a model with reasoning:false given `--thinking medium` produced a
        // request body with NO reasoning field at all. No error, no warning.
        const model: ReasoningModelFacts = {reasoning: false}
        expect(supportedThinkingLevels(model)).toEqual(['off'])
        expect(clampToModel(model, 'medium')).toBe('off')
        expect(clampToModel(model, 'high')).toBe('off')
    })

    test('2. off:null clamps UP — thinking stays on when you turned it off', () => {
        // LIVE: thinkingLevelMap {off:null} given `--thinking off` sent
        // enable_thinking:true with reasoning_effort "medium".
        // This is the mirror of "reasoning on but unsupported", and it is why the
        // warning reports both directions.
        const model: ReasoningModelFacts = {
            reasoning: true,
            thinkingLevelMap: {off: null, minimal: null, low: null, medium: 'medium'}
        }
        expect(clampToModel(model, 'off')).toBe('medium')
    })

    test('3. a null level clamps to the next one up', () => {
        // LIVE: `--thinking low` where low:null became medium, silently.
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
        // The asymmetry that decides which levels /task-config may offer: the
        // extended two are opt-in and must be declared, so a model with no map
        // would be sent the raw string.
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
    const every = (
        setting: GroupSetting
    ): Record<(typeof REASONING_GROUPS)[number], GroupSetting> =>
        Object.fromEntries(REASONING_GROUPS.map(group => [group, setting])) as Record<
            (typeof REASONING_GROUPS)[number],
            GroupSetting
        >

    test('says nothing when every group inherits — the shipped state', () => {
        // This is the real anti-nag. With the shipped all-inherit table, a model
        // with no reasoning at all still produces no warning.
        expect(reasoningMismatches({reasoning: false}, every('inherit'))).toEqual([])
    })

    test('says nothing when no model has resolved yet', () => {
        expect(reasoningMismatches(undefined, every('medium'))).toEqual([])
    })

    test('reports every group a reasoning:false model will erase', () => {
        const out = reasoningMismatches({reasoning: false}, every('medium'))
        expect(out).toHaveLength(REASONING_GROUPS.length)
        expect(out[0]).toEqual({group: REASONING_GROUPS[0]!, wanted: 'medium', actual: 'off'})
    })

    test('reports the OFF direction too', () => {
        const model: ReasoningModelFacts = {
            reasoning: true,
            thinkingLevelMap: {off: null, minimal: null, low: null, medium: 'medium'}
        }
        const out = reasoningMismatches(model, every('off'))
        expect(out).toHaveLength(REASONING_GROUPS.length)
        expect(out[0]?.wanted).toBe('off')
        expect(out[0]?.actual).toBe('medium')
    })

    test('says nothing when the model honours what was asked', () => {
        expect(reasoningMismatches(QWEN38, every('medium'))).toEqual([])
        expect(reasoningMismatches(QWEN38, every('off'))).toEqual([])
    })
})
