/**
 * The shared per-group loader both tables use.
 *
 * It exists so "always a complete record" and the `research:*` parent fallback
 * are written once. The test that matters is the one about `fallbackFor`: it is
 * a FUNCTION of the group, because the reasoning table falls back per group to
 * its measured default while the model table falls back to one constant. A
 * scalar-fallback implementation passes every other assertion in this file.
 */
import {describe, expect, test} from 'bun:test'
import {CHILD_GROUPS, sanitizeGroupRecord, type ChildGroup} from '../../src/config/groups.js'

const isStr = (v: unknown): v is string => typeof v === 'string'

describe('sanitizeGroupRecord', () => {
    test('fills every group, from any input', () => {
        const out = sanitizeGroupRecord(undefined, isStr, () => 'fb')
        expect(Object.keys(out).sort()).toEqual([...CHILD_GROUPS].sort())
    })

    test('`fallbackFor` is called PER GROUP, not once', () => {
        const out = sanitizeGroupRecord({}, isStr, (g: ChildGroup) => `fb:${g}`)
        for (const g of CHILD_GROUPS) expect(out[g]).toBe(`fb:${g}`)
    })

    test('a research:* key absent from the store inherits its parent', () => {
        // A config written before the research split keeps meaning what it meant.
        const out = sanitizeGroupRecord({research: 'parent'}, isStr, () => 'fb')
        expect(out['research:files']).toBe('parent')
        expect(out['research:apis']).toBe('parent')
        expect(out['research:context']).toBe('parent')
        expect(out['research:tooling']).toBe('parent')
        // Not a research subgroup, so no parent to inherit from.
        expect(out.gate).toBe('fb')
    })

    test('an own key beats the parent', () => {
        const out = sanitizeGroupRecord(
            {research: 'parent', 'research:files': 'own'},
            isStr,
            () => 'fb'
        )
        expect(out['research:files']).toBe('own')
    })

    test('an INVALID parent does not poison the child', () => {
        const out = sanitizeGroupRecord({research: 42}, isStr, () => 'fb')
        expect(out['research:files']).toBe('fb')
    })
})
