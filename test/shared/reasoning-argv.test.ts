/**
 * WHERE `--thinking` MAY AND MAY NOT APPEAR IN A CHILD'S ARGV.
 *
 * Three properties now, and the third replaced the one that used to lead.
 *
 *  1. Given the EMPTY fragment, every builder produces argv byte-identical to
 *     the version before reasoning profiles existed. That is a property of the
 *     builders, and it holds whatever the table says.
 *  2. `childBaseArgs` never carries the flag. It is the one universal builder,
 *     shared by all four paths, so a flag placed there could not vary by role —
 *     and "just put it in the base args" is the refactor this pins against.
 *  3. WHAT THE SHIPPED TABLE ACTUALLY PUTS ON THE WIRE, group by group.
 *     "All-`inherit`, so nothing changed" was true when PR 1 shipped and is NOT
 *     true now: `gate` and `implementation` are measured `off`, so gate children
 *     really do carry `--thinking off` today. A cell is a behaviour change, and
 *     a behaviour change nobody asserts is one nobody notices — so the wire
 *     effect of every cell is pinned here, against DEFAULT_CONFIG rather than
 *     the live singleton.
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
        // Position matters only in that pi parses flags in any order, but a
        // reader diffing two runs should see one contiguous insertion, not a
        // flag threaded between the tool flags it has nothing to do with.
        const args = childArgs('read', ['/ext.js'], ['--thinking', 'off'])
        const base = childBaseArgs(['/ext.js'])
        expect(args).toEqual([...base, '--thinking', 'off', '--mode', 'json', '--tools', 'read'])
    })

    test('a no-tools child still carries its level', () => {
        // critique-triage and compress-label are --no-tools, and they are the
        // children most likely to want a level of their own.
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
        // WAS "resolves to no fragment", asserting the all-`inherit` property.
        // That property is gone for this group: extraction was measured at
        // n=20/arm on 2026-08-26 and is the table's one RUNG 1 cell. Asserted
        // against DEFAULT_CONFIG rather than the live singleton, so the test is
        // about the code and not about whoever is running it.
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
        // `research:files` is MEASURED — ledger-research.jsonl, n=12/arm, rung
        // 3 — and is the one worker cell that does not follow `research`.
        'research:files': ['--thinking', 'off'],
        // apis and context ship IDENTICAL to `research` — no axis survived
        // STEP 0 for either, so the cell is the prior, not a reading. If one of
        // these ever differs from the line above, check it carries a ledger.
        'research:apis': ['--thinking', 'medium'],
        'research:context': ['--thinking', 'medium'],
        // `research:tooling` is MEASURED and lands on the SAME value by a
        // different route: n=20/arm, off 13/20 vs medium 20/20, p=0.0083, RUNG
        // 1. The wire byte is unchanged; the reason behind it is not.
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
        // Resolved through the same builder gate-deps and child-runner use, so
        // this is the argv the model server sees, not a table lookup restated.
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
        // The half of the original claim that survives, now asserted where it
        // is actually true: for a group the table leaves alone. `plan` is the
        // only one left — /task-plan is interactive, so the level is the user's
        // to pick and the table must not override it.
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
