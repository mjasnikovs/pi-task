/**
 * Tests for APIS_SEMANTICS_CONTRACT — the STAGE 2 lever text.
 *
 * The lever is UNWIRED (its A/B FAILED invariant 2a; see src/task/prompts.ts and nexxtasks.txt
 * "STAGE 2"). The module and these tests are KEPT as the durable asset — the measurement rig is
 * re-runnable at ~3h of model time and no new code — the same way src/task/spec-urls.ts survived
 * PROMPT 4's failure. If anyone revisits this lever, these pin what the text must contain for the
 * A/B to be measuring what it claims; that prompts.test.ts asserts it is NOT in the shipped prompt
 * is the guard against an accidental re-wire.
 */
import {describe, expect, test} from 'bun:test'
import {APIS_SEMANTICS_CONTRACT} from './apis-contract.js'

describe('APIS_SEMANTICS_CONTRACT', () => {
    test('the lever is that a SIGNATURE does not complete an entry', () => {
        // Stage 1's mechanism is completion-by-format: worker:apis stops when every entry has a
        // signature. Without this sentence the block is advice and the mechanism is untouched.
        expect(APIS_SEMANTICS_CONTRACT).toContain('A TYPE SIGNATURE IS NOT A SEMANTICS CLAUSE')
        expect(APIS_SEMANTICS_CONTRACT).toContain('SEMANTICS')
    })

    test('the fallback is ordered docs-behaviour-question -> escalate -> abstain', () => {
        const c = APIS_SEMANTICS_CONTRACT
        const ask = c.indexOf('ASK `pi-worker-docs` A BEHAVIOUR QUESTION')
        const escalate = c.indexOf('ESCALATE')
        const abstain = c.indexOf('UNVERIFIED')
        expect(ask).toBeGreaterThan(-1)
        expect(escalate).toBeGreaterThan(ask)
        expect(abstain).toBeGreaterThan(escalate)
    })

    test('ABSTENTION IS MANDATORY — the fabrication guard the A/B proved the model ignores', () => {
        // The A/B measured the model using this escape 0 times in 40 reps, fabricating instead.
        // The text still MUST offer it: forbidding abstention is how F-1 manufactured the
        // confident wrong claim (hc<AppType>('/api') -> /api/api/... -> the product API 404s).
        expect(APIS_SEMANTICS_CONTRACT).toContain('THIS IS A CORRECT AND REQUIRED OUTCOME')
        expect(APIS_SEMANTICS_CONTRACT).toContain('NEVER fill this field from memory')
    })
})
