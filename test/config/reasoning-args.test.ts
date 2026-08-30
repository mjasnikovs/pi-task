/**
 * The live-config bridge, driven through the function production calls.
 *
 * `groupThinkingArgs` is what six production call sites use to build their
 * `--thinking` fragment. Asserting `thinkingArgs(resolveReasoning(...))` instead
 * only retypes its body, and leaves its one stated invariant — the config is read
 * PER CALL, never cached at module scope — asserted nowhere, so hoisting the read
 * would keep the whole suite green.
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
        // The contract stated on `groupThinkingArgs` itself. It is assertable only
        // because the config is an OPTIONAL PARAMETER: `cfg ?? getConfig()` is
        // evaluated inside the function, so mutating the same object between two
        // calls must change the answer. Hoisting that read to module scope would
        // answer the first call's value forever, and every other test here would
        // still pass.
        const cfg = cfgIn('custom')
        cfg.reasoningLevels.planning = 'off'
        expect(groupThinkingArgs('planning', cfg)).toEqual(['--thinking', 'off'])

        cfg.reasoningLevels.planning = 'high'
        expect(groupThinkingArgs('planning', cfg)).toEqual(['--thinking', 'high'])
    })
})
