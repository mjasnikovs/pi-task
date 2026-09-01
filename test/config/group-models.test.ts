/**
 * The model table's loader, driven with the hostile values a hand-edited config
 * can actually hold.
 *
 * The one rule worth stating twice: this checks SHAPE, never existence. A spec
 * naming a model this machine has never heard of must survive, because the only
 * alternative available here is deletion — and deleting it would lose a setting
 * the user made on their other machine, or on a day their provider extension
 * loaded. Whether a spec resolves is asked once per session, where the answer
 * can be a sentence instead of a silent erasure.
 */
import {describe, expect, test} from 'bun:test'
import {CHILD_GROUPS} from '../../src/config/groups.js'
import {
    isModelSpec,
    MODEL_INHERIT,
    modelArgs,
    sanitizeGroupModels,
    splitSpec
} from '../../src/config/group-models.js'

describe('sanitizeGroupModels', () => {
    test('always returns a COMPLETE record, whatever it was handed', () => {
        for (const hostile of [undefined, null, 0, 'x', [], [1, 2], true]) {
            const out = sanitizeGroupModels(hostile)
            expect(Object.keys(out).sort()).toEqual([...CHILD_GROUPS].sort())
            for (const g of CHILD_GROUPS) expect(out[g]).toBe(MODEL_INHERIT)
        }
    })

    test('keeps a good spec and replaces only the bad cells', () => {
        const out = sanitizeGroupModels({
            gate: 'acme/small',
            phase: 42,
            planning: '',
            plan: '   ',
            extraction: '--tools',
            research: 'acme/two words',
            'research:files': ' acme/pad '
        })
        expect(out.gate).toBe('acme/small')
        // Everything that could reshape argv falls back, and says so by falling
        // back to the one value that emits no flag at all.
        expect(out.phase).toBe(MODEL_INHERIT)
        expect(out.planning).toBe(MODEL_INHERIT)
        expect(out.plan).toBe(MODEL_INHERIT)
        expect(out.extraction).toBe(MODEL_INHERIT)
        expect(out.research).toBe(MODEL_INHERIT)
        expect(out['research:files']).toBe(MODEL_INHERIT)
    })

    test('a spec naming a model in NO registry survives', () => {
        // The two-machine case. This is the assertion that stops someone
        // "helpfully" adding an existence check to the loader.
        const out = sanitizeGroupModels({gate: 'not-a-provider/not-a-model'})
        expect(out.gate).toBe('not-a-provider/not-a-model')
    })

    test('an OpenRouter-style id with two slashes survives whole', () => {
        expect(sanitizeGroupModels({phase: 'openrouter/z-ai/glm-4.6'}).phase).toBe(
            'openrouter/z-ai/glm-4.6'
        )
    })
})

describe('isModelSpec', () => {
    test('rejects exactly what could reshape argv', () => {
        expect(isModelSpec('acme/small')).toBe(true)
        expect(isModelSpec(MODEL_INHERIT)).toBe(true)
        expect(isModelSpec('')).toBe(false)
        expect(isModelSpec('   ')).toBe(false)
        // A leading dash is read by pi's flat parser as the NEXT flag.
        expect(isModelSpec('--tools')).toBe(false)
        expect(isModelSpec('-m')).toBe(false)
        // One token here, two after any shell round-trip.
        expect(isModelSpec('acme/two words')).toBe(false)
        expect(isModelSpec('acme/tab\there')).toBe(false)
        expect(isModelSpec(' acme/small')).toBe(false)
        expect(isModelSpec(7)).toBe(false)
        expect(isModelSpec(null)).toBe(false)
    })
})

describe('modelArgs', () => {
    test('`inherit` is the empty fragment; anything else is one flag and one value', () => {
        expect(modelArgs(MODEL_INHERIT)).toEqual([])
        expect(modelArgs('acme/small')).toEqual(['--model', 'acme/small'])
    })
})

describe('splitSpec', () => {
    test('splits on the FIRST slash, so an OpenRouter id keeps its own', () => {
        expect(splitSpec('openrouter/z-ai/glm-4.6')).toEqual({
            provider: 'openrouter',
            id: 'z-ai/glm-4.6'
        })
        expect(splitSpec('local/Qwen.gguf')).toEqual({provider: 'local', id: 'Qwen.gguf'})
    })

    test('a spec with no usable slash has no provider', () => {
        expect(splitSpec(MODEL_INHERIT)).toBeUndefined()
        expect(splitSpec('/leading')).toBeUndefined()
        expect(splitSpec('trailing/')).toBeUndefined()
    })
})
