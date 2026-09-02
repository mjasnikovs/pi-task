/**
 * The live-config bridge, driven through the function production calls.
 *
 * `groupChildArgs` is what every production argv builder calls. Asserting
 * `thinkingArgs(resolveReasoning(...))` instead only retypes its body, and leaves
 * its one stated invariant — the config is read PER CALL, never cached at module
 * scope — asserted nowhere, so hoisting the read would keep the whole suite green.
 * The per-call property is asserted for BOTH halves, because they are two reads.
 */
import {describe, expect, test} from 'bun:test'
import {
    groupChildArgs,
    groupModelArgs,
    groupThinkingArgs,
    setGroupModels
} from '../../src/config/group-args.js'
import {DEFAULT_CONFIG, type PiTaskConfig} from '../../src/config/config.js'
import {effectiveReasoning, CHILD_GROUPS} from '../../src/config/reasoning.js'

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
        for (const group of CHILD_GROUPS) custom.reasoningLevels[group] = 'inherit'
        expect(groupThinkingArgs('planning', custom)).toEqual([])
    })

    test('agrees with the whole-table answer for every group', () => {
        // The bridge and the table cannot drift: one is the other, per group.
        const cfg = cfgIn('default')
        const levels = effectiveReasoning(cfg)
        for (const group of CHILD_GROUPS) {
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

/** DEFAULT_CONFIG with one model cell set. Never the live singleton. */
const withModel = (group: string, spec: string): PiTaskConfig => ({
    ...DEFAULT_CONFIG,
    groupModels: {...DEFAULT_CONFIG.groupModels, [group]: spec}
})

describe('groupModelArgs', () => {
    test('`inherit` emits nothing', () => {
        expect(groupModelArgs('gate', DEFAULT_CONFIG)).toEqual([])
    })

    test('a spec emits exactly one flag and one value', () => {
        expect(groupModelArgs('gate', withModel('gate', 'acme/small'))).toEqual([
            '--model',
            'acme/small'
        ])
    })

    test('reads its config PER CALL, like the thinking half', () => {
        const cfg = withModel('phase', 'acme/small')
        expect(groupModelArgs('phase', cfg)).toEqual(['--model', 'acme/small'])
        cfg.groupModels.phase = 'acme/big'
        expect(groupModelArgs('phase', cfg)).toEqual(['--model', 'acme/big'])
    })
})

describe('a spec this session proved unresolvable', () => {
    // The snapshot is module state, so every test here puts it back.
    const clear = (): void => setGroupModels({})
    const gone = (): void =>
        setGroupModels({gate: {spec: 'acme/gone', usable: false, problem: 'unresolved'}})

    test('is dropped, and only it', () => {
        try {
            gone()
            expect(groupModelArgs('gate', withModel('gate', 'acme/gone'))).toEqual([])
            expect(groupModelArgs('gate', withModel('gate', 'acme/here'))).toEqual([
                '--model',
                'acme/here'
            ])
        } finally {
            clear()
        }
    })

    test('the verdict is per CELL: another group on the same spec is emitted', () => {
        // The snapshot proves what THIS group's cell resolved to. A host that
        // has not proven another group's cell must leave pi to decide.
        try {
            gone()
            expect(groupModelArgs('phase', withModel('phase', 'acme/gone'))).toEqual([
                '--model',
                'acme/gone'
            ])
        } finally {
            clear()
        }
    })

    test('a cell changed since session_start is emitted — the verdict was about another spec', () => {
        try {
            gone()
            expect(groupModelArgs('gate', withModel('gate', 'acme/new'))).toEqual([
                '--model',
                'acme/new'
            ])
        } finally {
            clear()
        }
    })

    test('dropping the model leaves the thinking half alone', () => {
        // Half-applying is the failure this avoids: the child runs the model it
        // ran last week, at the level the user chose, and the hint names the cell.
        try {
            gone()
            expect(groupChildArgs('gate', withModel('gate', 'acme/gone'))).toEqual([
                '--thinking',
                'off'
            ])
        } finally {
            clear()
        }
    })

    test('an EMPTY snapshot emits everything — a host with no session_start is unchanged', () => {
        clear()
        expect(groupModelArgs('gate', withModel('gate', 'acme/anything'))).toEqual([
            '--model',
            'acme/anything'
        ])
    })
})

describe('groupChildArgs', () => {
    test('is exactly model-then-thinking, concatenated', () => {
        const cfg = withModel('planning', 'acme/big')
        expect(groupChildArgs('planning', cfg)).toEqual([
            ...groupModelArgs('planning', cfg),
            ...groupThinkingArgs('planning', cfg)
        ])
        expect(groupChildArgs('planning', cfg)).toEqual([
            '--model',
            'acme/big',
            '--thinking',
            'medium'
        ])
    })

    test('both halves inherit ⇒ the empty fragment', () => {
        const cfg = withModel('plan', 'inherit')
        expect(groupChildArgs('plan', cfg)).toEqual([])
    })
})
