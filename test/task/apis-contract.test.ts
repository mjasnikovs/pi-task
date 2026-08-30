/**
 * Tests for APIS_SEMANTICS_CONTRACT, an output-contract clause for the APIS
 * research prompt that is NOT wired in. See its module header for what it would
 * change and why it is kept unwired.
 *
 * Nothing splices it into RESEARCH_APIS_PROMPT: the only references to it in the
 * tree are this file and prompts.test.ts, which asserts the shipped prompt does
 * NOT contain it. That assertion is the guard against an accidental re-wire;
 * these three pin what the text must contain for it to be worth trying at all.
 */
import {describe, expect, test} from 'bun:test'
import {APIS_SEMANTICS_CONTRACT} from '../../src/task/apis-contract.js'

describe('APIS_SEMANTICS_CONTRACT', () => {
    test('the lever is that a SIGNATURE does not complete an entry', () => {
        // worker:apis treats an entry as finished once it has a SIGNATURE,
        // because that is what its output format asks for. So a lever has to
        // move the format's bar. Without this sentence the block is advice and
        // the stopping rule is untouched.
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
        // The escape must be offered even though a worker rarely reaches for it.
        // A worker that may NOT abstain has nowhere to put an uncheckable fact
        // except into a confident claim, and a plausible wrong claim about a base
        // URL or a default is the most damaging thing this section can carry.
        expect(APIS_SEMANTICS_CONTRACT).toContain('THIS IS A CORRECT AND REQUIRED OUTCOME')
        expect(APIS_SEMANTICS_CONTRACT).toContain('NEVER fill this field from memory')
    })
})
