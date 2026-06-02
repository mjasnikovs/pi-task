import {describe, expect, test} from 'bun:test'
import {
    REFINE_PROMPT,
    RESEARCH_CONTEXT_PROMPT,
    RESEARCH_FILES_PROMPT,
    RESEARCH_APIS_PROMPT,
    RESEARCH_TOOLING_PROMPT,
    GRILL_AUTO_ANSWER_PROMPT,
    CRITIQUE_PROMPT,
    CRITIQUE_TRIAGE_PROMPT
} from './prompts.js'

describe('REFINE_PROMPT', () => {
    test('declares four sections', () => {
        const p = REFINE_PROMPT('raw task')
        expect(p).toContain('four sections')
    })

    test('lists EXTERNAL-DEPENDENCIES as the fourth section', () => {
        const p = REFINE_PROMPT('raw task')
        expect(p).toContain('EXTERNAL-DEPENDENCIES')
        const goalIdx = p.indexOf('GOAL')
        const constraintsIdx = p.indexOf('CONSTRAINTS')
        const knownIdx = p.indexOf('KNOWN-UNKNOWNS')
        const depsIdx = p.indexOf('EXTERNAL-DEPENDENCIES')
        expect(goalIdx).toBeGreaterThan(-1)
        expect(constraintsIdx).toBeGreaterThan(goalIdx)
        expect(knownIdx).toBeGreaterThan(constraintsIdx)
        expect(depsIdx).toBeGreaterThan(knownIdx)
    })

    test('warns the model not to list npm packages here', () => {
        const p = REFINE_PROMPT('raw task')
        expect(p.toLowerCase()).toContain('npm')
    })
})

describe('RESEARCH_CONTEXT_PROMPT LIVE-DATA RULE', () => {
    test('mentions ### service: blocks as authoritative live data', () => {
        const p = RESEARCH_CONTEXT_PROMPT('task')
        expect(p).toContain('### service:')
        expect(p.toLowerCase()).toContain('authoritative')
    })

    test('mentions freshness-check skipped behaviour', () => {
        const p = RESEARCH_CONTEXT_PROMPT('task')
        expect(p).toContain('### freshness-check skipped')
        expect(p.toLowerCase()).toContain('not verified')
    })
})

describe('GRILL_AUTO_ANSWER_PROMPT LIVE-DATA RULE', () => {
    test('mentions ### service: blocks as authoritative live data', () => {
        const p = GRILL_AUTO_ANSWER_PROMPT('refined', 'research', 'question')
        expect(p).toContain('### service:')
    })

    test('mentions freshness-check skipped behaviour', () => {
        const p = GRILL_AUTO_ANSWER_PROMPT('refined', 'research', 'question')
        expect(p).toContain('### freshness-check skipped')
    })

    test('classifies implementation-approach choices as UNKNOWN, not ANSWER', () => {
        const p = GRILL_AUTO_ANSWER_PROMPT('refined', 'research', 'question')
        // The UNKNOWN section must explicitly cover how-the-task-is-solved
        // decisions so the orchestrator surfaces them to the user instead of
        // silently committing to an approach.
        expect(p.toLowerCase()).toContain('implementation approach')
        const unknownIdx = p.indexOf('UNKNOWN: accepting your default')
        const approachIdx = p.toLowerCase().indexOf('implementation approach')
        expect(unknownIdx).toBeGreaterThanOrEqual(0)
        // The approach guidance lives inside the UNKNOWN bullet.
        expect(approachIdx).toBeGreaterThan(unknownIdx)
    })
})

describe('research prompts enforce relevance / size discipline', () => {
    test('FILES prompt tells the worker to list only task-relevant paths', () => {
        const p = RESEARCH_FILES_PROMPT('task')
        expect(p).toContain('RELEVANCE')
        expect(p.toLowerCase()).toContain('smallest sufficient set')
    })

    test('APIS prompt forbids dumping the whole public surface', () => {
        const p = RESEARCH_APIS_PROMPT('task')
        expect(p).toContain('RELEVANCE')
        expect(p.toLowerCase()).toContain('entire public surface')
    })

    test('CONTEXT prompt caps bullets and demands actionable facts', () => {
        const p = RESEARCH_CONTEXT_PROMPT('task')
        expect(p).toContain('RELEVANCE')
        expect(p.toLowerCase()).toContain('implementation decision')
    })
})

describe('research prompts forbid producing the deliverable', () => {
    const cases: Array<[string, string]> = [
        ['FILES', RESEARCH_FILES_PROMPT('task')],
        ['APIS', RESEARCH_APIS_PROMPT('task')],
        ['CONTEXT', RESEARCH_CONTEXT_PROMPT('task')],
        ['TOOLING', RESEARCH_TOOLING_PROMPT('task')]
    ]
    for (const [name, prompt] of cases) {
        test(`${name} worker is told it gathers inputs, not the deliverable`, () => {
            expect(prompt).toContain('gathering INPUTS')
            expect(prompt.toLowerCase()).toContain('not performing the task')
        })
        test(`${name} worker is told not to emit code fences or preamble`, () => {
            expect(prompt.toLowerCase()).toContain('no code fences')
            expect(prompt.toLowerCase()).toContain('no preamble')
        })
    }
})

describe('CRITIQUE_TRIAGE_PROMPT', () => {
    test('asks for the CLEAN sentinel and forbids a rewrite', () => {
        const p = CRITIQUE_TRIAGE_PROMPT('spec', 'refined', 'qa')
        expect(p).toContain('CLEAN')
        expect(p.toLowerCase()).toContain('do not rewrite')
    })

    test('embeds the spec, refined task, and Q&A', () => {
        const p = CRITIQUE_TRIAGE_PROMPT('SPEC_MARK', 'REFINED_MARK', 'QA_MARK')
        expect(p).toContain('SPEC_MARK')
        expect(p).toContain('REFINED_MARK')
        expect(p).toContain('QA_MARK')
    })
})

describe('CRITIQUE_PROMPT triage-defect focus block', () => {
    test('omits the FOCUS block when no defects are supplied', () => {
        const p = CRITIQUE_PROMPT('spec', 'refined', 'qa', false)
        expect(p).not.toContain('FOCUS —')
    })

    test('injects supplied triage defects as a FOCUS block', () => {
        const p = CRITIQUE_PROMPT('spec', 'refined', 'qa', false, 'ACCEPTANCE: criterion 2 vague')
        expect(p).toContain('FOCUS —')
        expect(p).toContain('ACCEPTANCE: criterion 2 vague')
    })
})
