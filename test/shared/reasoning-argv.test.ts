/**
 * WHERE `--thinking` MAY AND MAY NOT APPEAR IN A CHILD'S ARGV.
 *
 * Three properties.
 *
 *  1. Given the EMPTY fragment, every builder emits no `--thinking` at all, so
 *     an `inherit` group leaves the child's argv exactly as it would be with no
 *     reasoning table. That is a property of the builders and holds whatever
 *     the table says.
 *  2. `childBaseArgs` never carries the flag. It is the universal builder — the
 *     three call sites outside its own module are child-runner.ts,
 *     focused-extractor.ts and pi-worker-core.ts — so a flag placed there could
 *     not vary by role. "Just put it in the base args" is the refactor this
 *     pins against.
 *  3. WHAT THE SHIPPED TABLE PUTS ON THE WIRE, group by group. Only one of the
 *     eleven groups is `inherit`, so most children really do carry a
 *     `--thinking` flag today. A cell is a behaviour change, and a behaviour
 *     change nobody asserts is one nobody notices — so the wire effect of every
 *     cell is pinned here, against DEFAULT_CONFIG rather than the live
 *     singleton.
 */
import {describe, expect, test} from 'bun:test'
import {childBaseArgs} from '../../src/shared/child-extensions.js'
import {CHILD_BASE_ARGS} from '../../src/shared/child-process.js'
import {childArgs} from '../../src/task/child-runner.js'
import {focusedChildArgs} from '../../src/workers/focused-extractor.js'
import {DEFAULT_CONFIG} from '../../src/config/config.js'
import {
    DEFAULT_REASONING_TABLE,
    REASONING_GROUPS,
    resolveReasoning,
    thinkingArgs
} from '../../src/config/reasoning.js'

describe('childBaseArgs stays universal', () => {
    test('never emits --thinking, in any config state', () => {
        // Asserted against the exported constant as well as the function, so a
        // flag smuggled into either one fails here.
        expect(CHILD_BASE_ARGS).not.toContain('--thinking')
        expect(childBaseArgs()).not.toContain('--thinking')
        expect(childBaseArgs(['/some/ext.js'])).not.toContain('--thinking')
    })
})

describe('childArgs', () => {
    test('with no fragment the argv is unchanged from before the feature', () => {
        expect(childArgs('read')).toEqual([
            ...childBaseArgs([]),
            '--mode',
            'json',
            '--tools',
            'read'
        ])
        expect(childArgs('')).toEqual([...childBaseArgs([]), '--mode', 'json', '--no-tools'])
    })

    test('the flag lands after the -e pairs and before --mode', () => {
        // Position does not matter to pi: its parser (dist/cli/args.js) is one
        // flat loop of `else if (arg === "--x")` branches over argv, each
        // consuming its own value, so any order parses the same. It matters to
        // a reader diffing two runs, who should see one contiguous insertion
        // rather than a flag threaded between the tool flags it is unrelated to.
        const args = childArgs('read', ['/ext.js'], ['--thinking', 'off'])
        const base = childBaseArgs(['/ext.js'])
        expect(args).toEqual([...base, '--thinking', 'off', '--mode', 'json', '--tools', 'read'])
    })

    test('a no-tools child still carries its level', () => {
        // critique-triage (phases.ts) and compress-label (title-label.ts) both
        // pass '' for tools, which is what becomes --no-tools. They judge text
        // they were handed, so a level of their own is exactly what they want —
        // and the no-tools branch must not drop the flag on the way.
        const args = childArgs('', [], ['--thinking', 'medium'])
        expect(args).toContain('--thinking')
        expect(args).toContain('--no-tools')
    })
})

describe('focusedChildArgs', () => {
    test('with no fragment the argv is unchanged from before the feature', () => {
        // No getConfig() anywhere in this file. The builder takes the fragment
        // like the other three, so what it emits is a function of its argument
        // and nothing else — which is the only way this assertion can be about
        // the code rather than about whoever is running it.
        expect(focusedChildArgs()).toEqual([...childBaseArgs(), '--no-tools'])
    })

    test('the shipped default puts the measured level on the wire', () => {
        // Asserted against DEFAULT_CONFIG rather than the live singleton, so the
        // test is about the code and not about whoever is running it.
        expect(DEFAULT_REASONING_TABLE.extraction).toBe('off')
        expect(thinkingArgs(resolveReasoning('extraction', DEFAULT_CONFIG))).toEqual([
            '--thinking',
            'off'
        ])
    })

    test('a fragment lands before --no-tools', () => {
        expect(focusedChildArgs(['--thinking', 'off'])).toEqual([
            ...childBaseArgs(),
            '--thinking',
            'off',
            '--no-tools'
        ])
    })
})

describe('what the shipped table puts on the wire', () => {
    /**
     * The fragment each group resolves to under the SHIPPED default, spelled
     * out rather than derived from the table — a test that recomputes the value
     * it is checking asserts nothing. Change a cell and this goes red, which is
     * the point: it is the diff a reader wants to see beside a new measurement.
     */
    const EXPECTED: Readonly<Record<string, string[]>> = {
        research: ['--thinking', 'medium'],
        // `research:files` is the one worker cell that does not follow `research`.
        'research:files': ['--thinking', 'off'],
        // apis and context ship IDENTICAL to `research`. If one of these ever
        // differs from the line above, it should say why.
        'research:apis': ['--thinking', 'medium'],
        'research:context': ['--thinking', 'medium'],
        // `research:tooling` lands on the same value as its parent, but has its
        // own cell rather than falling through, so changing `research` does not
        // silently move it.
        'research:tooling': ['--thinking', 'medium'],
        phase: ['--thinking', 'off'],
        planning: ['--thinking', 'medium'],
        plan: [],
        gate: ['--thinking', 'off'],
        extraction: ['--thinking', 'off'],
        implementation: ['--thinking', 'off']
    }

    test('every group is accounted for', () => {
        // A group added without a line above would otherwise be silently
        // unasserted, which is how a cell ships unnoticed.
        expect(Object.keys(EXPECTED).sort()).toEqual([...REASONING_GROUPS].sort())
    })

    for (const group of REASONING_GROUPS) {
        test(`${group} resolves to ${EXPECTED[group]!.join(' ') || 'no flag'}`, () => {
            expect(thinkingArgs(resolveReasoning(group, DEFAULT_CONFIG))).toEqual(EXPECTED[group]!)
        })
    }

    test('a gate child really carries the flag through childArgs', () => {
        // The real path is gate-deps.ts calling groupThinkingArgs('gate'), whose
        // fragment reaches childArgs at child-runner.ts:289. This composes the
        // same two functions, so it is the argv the model server sees rather
        // than a table lookup restated.
        const fragment = thinkingArgs(resolveReasoning('gate', DEFAULT_CONFIG))
        expect(childArgs('read', [], fragment)).toEqual([
            ...childBaseArgs([]),
            '--thinking',
            'off',
            '--mode',
            'json',
            '--tools',
            'read'
        ])
    })

    test('an inherit group is still byte-identical to the pre-feature argv', () => {
        // Asserted for a group the table leaves alone. `plan` is the only
        // `inherit` cell of the eleven — /task-plan is interactive, so the level
        // is the user's to pick and the table must not override it.
        expect(DEFAULT_REASONING_TABLE.plan).toBe('inherit')
        const fragment = thinkingArgs(resolveReasoning('plan', DEFAULT_CONFIG))
        expect(childArgs('read', [], fragment)).toEqual([
            ...childBaseArgs([]),
            '--mode',
            'json',
            '--tools',
            'read'
        ])
    })
})
