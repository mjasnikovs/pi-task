/**
 * The live-config bridge, driven through the function production calls.
 *
 * `groupThinkingArgs` had seven call sites and no test at all: every assertion
 * about it was written against `thinkingArgs(resolveReasoning(...))`, which is
 * its body retyped. Its one stated invariant — read PER CALL, never cached at
 * module scope — was therefore asserted nowhere, and hoisting the read would
 * have left the whole suite green.
 */
import {describe, expect, test} from 'bun:test'
import {groupThinkingArgs} from '../../src/config/reasoning-args.js'
import {DEFAULT_CONFIG, type PiTaskConfig} from '../../src/config/config.js'
import {effectiveReasoning, REASONING_GROUPS} from '../../src/config/reasoning.js'

/** An explicit config in a given mode. Never the live singleton. */
const cfgIn = (mode: PiTaskConfig['reasoningMode']): PiTaskConfig => ({
    ...DEFAULT_CONFIG,
    reasoningLevels: {...DEFAULT_CONFIG.reasoningLevels},
    reasoningMode: mode
})

describe('groupThinkingArgs', () => {
    test('emits the fragment for the group the config says', () => {
        expect(groupThinkingArgs('extraction', cfgIn('off'))).toEqual(['--thinking', 'off'])
        expect(groupThinkingArgs('extraction', cfgIn('on'))).toEqual(['--thinking', 'medium'])
    })

    test('an `inherit` group emits nothing — the pre-feature argv', () => {
        const custom = cfgIn('custom')
        for (const group of REASONING_GROUPS) custom.reasoningLevels[group] = 'inherit'
        expect(groupThinkingArgs('planning', custom)).toEqual([])
    })

    test('agrees with the whole-table answer for every group', () => {
        // The bridge and the table cannot drift: one is the other, per group.
        const cfg = cfgIn('default')
        const levels = effectiveReasoning(cfg)
        for (const group of REASONING_GROUPS) {
            const expected = levels[group] === 'inherit' ? [] : ['--thinking', levels[group]]
            expect(groupThinkingArgs(group, cfg)).toEqual(expected)
        }
    })

    test('reads its default config PER CALL, not once at module scope', () => {
        // The contract this module's header states. It is assertable only because
        // the config is a parameter: a module-scope read would answer the first
        // call's value forever, and every other test here would still pass.
        const cfg = cfgIn('custom')
        cfg.reasoningLevels.planning = 'off'
        expect(groupThinkingArgs('planning', cfg)).toEqual(['--thinking', 'off'])

        cfg.reasoningLevels.planning = 'high'
        expect(groupThinkingArgs('planning', cfg)).toEqual(['--thinking', 'high'])
    })
})
