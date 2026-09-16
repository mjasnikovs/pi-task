import {describe, expect, test} from 'bun:test'
import {
    annotateConstraints,
    anyBinding,
    constraintWeight,
    renderConstraintPolicy,
    weightTag
} from '../../src/task/constraint-policy.js'
import {buildVerifyPrompt} from '../../src/task/verify-work.js'
import {extractProhibitions, findProhibitionViolations} from '../../src/task/prohibition-probe.js'
import type {ConstraintProvenance} from '../../src/task/spec-model.js'

describe('constraintWeight', () => {
    const table: Array<[ConstraintProvenance, 'binding' | 'advisory']> = [
        ['typed', 'binding'],
        ['host-set', 'binding'],
        ['spec', 'binding'],
        ['accepted', 'binding'],
        ['auto', 'advisory'],
        ['yolo', 'advisory'],
        ['yolo-skip', 'advisory'],
        ['auto-resolved', 'advisory'],
        ['derived', 'advisory']
    ]
    for (const [provenance, weight] of table) {
        test(`${provenance} → ${weight}`, () => {
            expect(constraintWeight(provenance)).toBe(weight)
        })
    }
})

describe('annotateConstraints', () => {
    test('each line carries its weight and its source', () => {
        expect(
            annotateConstraints([
                {text: 'keep the export surface', provenance: 'typed'},
                {text: 'prefer the documented adapter', provenance: 'auto'}
            ])
        ).toBe(
            '- keep the export surface [binding: typed]\n'
                + '- prefer the documented adapter [advisory: auto]'
        )
    })

    test('no constraints → no block', () => {
        expect(annotateConstraints([])).toBeNull()
    })
})

describe('the rendered rule', () => {
    test('one renderer, two headings, one policy', () => {
        const verify = renderConstraintPolicy('4b.').join('\n')
        const judge = renderConstraintPolicy('5.').join('\n')
        expect(verify.startsWith('4b.')).toBe(true)
        expect(judge.startsWith('5.')).toBe(true)
        expect(verify.slice(3)).toBe(judge.slice(2))
    })

    test('it states the advisory exit', () => {
        const text = renderConstraintPolicy('4b.').join('\n')
        expect(text).toContain('a FAIL only')
        expect(text).toContain('ACCEPTANCE bullet ALSO fails')
    })
})

/** One spec, two provenances for the same ban — the only difference under test. */
const specWith = (tag: string): string =>
    [
        'GOAL',
        'ship the client',
        '',
        'CONSTRAINTS',
        `- Do NOT modify \`src/client/api.ts\`${tag}`,
        '',
        'ACCEPTANCE',
        '- the client builds',
        '',
        'VERIFY:',
        '```sh',
        'bun run build',
        '```'
    ].join('\n')

const violations = (spec: string, kind: 'typed' | 'auto'): string[] =>
    findProhibitionViolations(
        extractProhibitions(spec, () => kind),
        [{path: 'src/client/api.ts', addedLines: 1}]
    )

describe('an advisory-only violation is not a FAIL', () => {
    test('a BINDING prohibition keeps the no-waiver FAIL wording', () => {
        const findings = violations(specWith(' [from: Q1]'), 'typed')
        expect(anyBinding(findings)).toBe(true)
        expect(findings[0]).toContain(weightTag('typed'))
        const prompt = buildVerifyPrompt('GOAL\nship', {prohibition: findings})
        expect(prompt).toContain('the verdict is FAIL naming the forbidden')
    })

    test('an ADVISORY prohibition yields no FAIL wording in its notice', () => {
        const findings = violations(specWith(' [from: Q1]'), 'auto')
        expect(anyBinding(findings)).toBe(false)
        expect(findings[0]).toContain(weightTag('auto'))
        const prompt = buildVerifyPrompt('GOAL\nship', {prohibition: findings})
        expect(prompt).not.toContain('the verdict is FAIL naming the forbidden')
        expect(prompt).toContain('NOT fail the work for it unless an ACCEPTANCE criterion')
    })

    test('an untagged constraint is advisory — automation may not mint an unwaivable rule', () => {
        expect(anyBinding(violations(specWith(''), 'typed'))).toBe(false)
    })
})

describe('the verify prompt shows the weights', () => {
    test("the spec's constraints are annotated for the child", () => {
        const prompt = buildVerifyPrompt(specWith(' [from: Q1]'), {}, {qaRecord: 'Q1: x\nA1: y'})
        expect(prompt).toContain("THE SPEC'S CONSTRAINTS, BY WEIGHT")
        // No suffix on A1 ⇒ `typed` ⇒ binding.
        expect(prompt).toContain(`Do NOT modify \`src/client/api.ts\` ${weightTag('typed')}`)
    })

    test('the same constraint is advisory when the answer was auto-resolved', () => {
        const prompt = buildVerifyPrompt(
            specWith(' [from: Q1]'),
            {},
            {qaRecord: 'Q1: x\nA1: y (auto)'}
        )
        expect(prompt).toContain(`Do NOT modify \`src/client/api.ts\` ${weightTag('auto')}`)
    })
})
