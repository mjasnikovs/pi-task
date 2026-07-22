import {describe, expect, test} from 'bun:test'
import {APIS_SEMANTICS_CONTRACT} from './apis-contract.js'
import {
    REFINE_PROMPT,
    RESEARCH_CONTEXT_PROMPT,
    RESEARCH_FILES_PROMPT,
    RESEARCH_APIS_PROMPT,
    RESEARCH_TOOLING_PROMPT,
    GRILL_AUTO_ANSWER_PROMPT,
    COMPOSE_PROMPT,
    CRITIQUE_PROMPT,
    CRITIQUE_TRIAGE_PROMPT
} from './prompts.js'

describe('COMPOSE_PROMPT API CORRECTIONS', () => {
    test('treats an API CORRECTIONS research section as authoritative', () => {
        const p = COMPOSE_PROMPT('refined', 'research', 'qa', null)
        expect(p).toContain('API CORRECTIONS')
        expect(p).toContain('AUTHORITATIVE')
        expect(p.toLowerCase()).toContain('add a constraint')
    })
})

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

    test('omits the scope fence and starts with the refine body when no planContext', () => {
        const p = REFINE_PROMPT('raw task')
        expect(p.startsWith('You receive a')).toBe(true)
        expect(p).not.toContain('PLAN CONTEXT')
    })

    test('prepends planContext ahead of the refine body when supplied', () => {
        const fence = 'PLAN CONTEXT — this task is STEP 1 of 3 …'
        const p = REFINE_PROMPT('raw task', fence)
        expect(p.startsWith(fence)).toBe(true)
        expect(p.indexOf(fence)).toBeLessThan(p.indexOf('You receive a'))
        expect(p).toContain('Task: raw task')
    })

    test('inserts an existingFiles block (between the rules and the task) when supplied', () => {
        const block = 'EXISTING FILES ON DISK — AUTHORITATIVE\n=== package.json ===\n{…}'
        const p = REFINE_PROMPT('raw task', undefined, block)
        expect(p).toContain(block)
        // It must sit AFTER the rules and BEFORE the task, so the model reads it as
        // authoritative grounding rather than part of the verbatim task text.
        expect(p.indexOf(block)).toBeGreaterThan(p.indexOf('EXTERNAL-DEPENDENCIES'))
        expect(p.indexOf(block)).toBeLessThan(p.indexOf('Task: raw task'))
    })

    test('omits the existingFiles region entirely when not supplied (byte-identical to bare)', () => {
        expect(REFINE_PROMPT('raw task', undefined, '')).toBe(REFINE_PROMPT('raw task'))
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
        // The REVERSIBILITY TEST must explicitly cover approach/algorithm decisions
        // so the orchestrator surfaces them to the user instead of silently committing.
        expect(p.toLowerCase()).toContain('approach')
        const unknownIdx = p.indexOf('UNKNOWN: costly to reverse')
        const approachIdx = p.toLowerCase().indexOf('approach')
        expect(unknownIdx).toBeGreaterThanOrEqual(0)
        expect(approachIdx).toBeGreaterThan(unknownIdx)
    })

    test('treats version-pin questions as UNKNOWN and forbids stale-memory downgrades', () => {
        const p = GRILL_AUTO_ANSWER_PROMPT('refined', 'research', 'question')
        expect(p).toContain('VERSION-PIN')
        expect(p.toLowerCase()).toContain('older major')
    })

    test('instructs model to emit ALT: for binary A-or-B questions', () => {
        const p = GRILL_AUTO_ANSWER_PROMPT('refined', 'research', 'question')
        expect(p).toContain('ALT:')
        // ALT must come after UNKNOWN in the format description
        const unknownIdx = p.indexOf('UNKNOWN: <primary')
        const altIdx = p.indexOf('ALT: <')
        expect(unknownIdx).toBeGreaterThanOrEqual(0)
        expect(altIdx).toBeGreaterThan(unknownIdx)
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

    test('APIS prompt tells the worker to verify runtime builtin imports, not echo them', () => {
        const p = RESEARCH_APIS_PROMPT('task')
        expect(p).toContain('RUNTIME BUILTINS')
        // Names the concrete phantom and its real replacement so the worker emits
        // the canonical import instead of the spec doc's invented colon-specifier.
        expect(p).toContain('bun:sql')
        expect(p).toContain('import { sql } from "bun"')
        expect(p.toLowerCase()).toContain('do not echo')
    })

    /**
     * STAGE 2 — the APIS OUTPUT CONTRACT lever is UNWIRED. Its A/B (scripts/
     * live-apis-contract-ab.ts) drove behaviour-class package queries 20/20 vs 2/20 — the one
     * lever of three that moved worker:apis at all — but FAILED invariant 2a: the ungrounded-
     * symbol rate rose 1.0% -> 4.7% (p = 0.0010) because the model filled every semantics field
     * and used the mandatory `UNVERIFIED:` abstention zero times. So the shipped APIS prompt
     * must NOT carry it. This test is a regression guard against an accidental re-wire; the
     * contract's own text is tested on the module in src/task/apis-contract.test.ts.
     */
    test('APIS prompt does NOT carry the (failed, unwired) semantics contract', () => {
        const p = RESEARCH_APIS_PROMPT('task')
        expect(p).not.toContain(APIS_SEMANTICS_CONTRACT)
        expect(p).not.toContain('A TYPE SIGNATURE IS NOT A SEMANTICS CLAUSE')
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

    test('names the synthesized-wiring seam-bug defect type (F3, gen side)', () => {
        const p = CRITIQUE_TRIAGE_PROMPT('spec', 'refined', 'qa')
        expect(p).toContain('synthesized interface WIRING')
        expect(p).toContain('SEAM BUG')
    })

    test('embeds the cross-slice contracts block when supplied, omits it otherwise', () => {
        const withC = CRITIQUE_TRIAGE_PROMPT('spec', 'refined', 'qa', 'CONTRACTS_MARK')
        expect(withC).toContain('CONTRACTS_MARK')
        const without = CRITIQUE_TRIAGE_PROMPT('spec', 'refined', 'qa', '')
        expect(without).not.toContain('CONTRACTS_MARK')
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

    test('carries the wiring-vs-pinned-facts reconcile rule and the contracts block', () => {
        const p = CRITIQUE_PROMPT('spec', 'refined', 'qa', false, null, 'CONTRACTS_MARK')
        expect(p).toContain('WIRING vs pinned facts')
        expect(p).toContain('CONTRACTS_MARK')
        expect(CRITIQUE_PROMPT('spec', 'refined', 'qa', false, null, '')).not.toContain(
            'CONTRACTS_MARK'
        )
    })
})

describe('REFINE_PROMPT cite-not-synthesize wiring rule (F3, gen side)', () => {
    test('instructs the model to cite, not synthesize, interface wiring', () => {
        const p = REFINE_PROMPT('raw task')
        expect(p).toContain('CITE interface WIRING')
        expect(p).toContain('seam bug')
    })
})
