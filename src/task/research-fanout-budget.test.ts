import {describe, expect, test} from 'bun:test'
import {
    FANOUT_TIMEOUT_CEILING_ENV,
    FANOUT_TIMEOUT_PER_LOOKUP_ENV,
    PROJECT_DOCS_BUDGET_ENV,
    fanoutTimeoutPolicy,
    projectDocsBudget,
    projectDocsBudgetExhausted,
    projectDocsBudgetNotice
} from './research-fanout-budget.js'

const env =
    (vars: Record<string, string>) =>
    (k: string): string | undefined =>
        vars[k]

describe('research fan-out budget (nexttask 5B, UNWIRED)', () => {
    test('both levers are OFF by default — the shipped configuration', () => {
        expect(projectDocsBudget(env({}))).toBeNull()
        expect(fanoutTimeoutPolicy(env({}))).toBeNull()
    })

    test('a garbage or non-positive budget is OFF, not a cap of zero', () => {
        // A typo'd env var must never silently forbid every project lookup — that
        // would be a silent, total behaviour change dressed as a no-op.
        for (const raw of ['0', '-3', 'twenty', '']) {
            expect(projectDocsBudget(env({[PROJECT_DOCS_BUDGET_ENV]: raw}))).toBeNull()
        }
        expect(projectDocsBudget(env({[PROJECT_DOCS_BUDGET_ENV]: '20'}))).toBe(20)
    })

    test('the scale policy needs BOTH halves — an extension with no ceiling is unbounded', () => {
        expect(fanoutTimeoutPolicy(env({[FANOUT_TIMEOUT_PER_LOOKUP_ENV]: '8000'}))).toBeNull()
        expect(fanoutTimeoutPolicy(env({[FANOUT_TIMEOUT_CEILING_ENV]: '900000'}))).toBeNull()
        expect(
            fanoutTimeoutPolicy(
                env({
                    [FANOUT_TIMEOUT_PER_LOOKUP_ENV]: '8000',
                    [FANOUT_TIMEOUT_CEILING_ENV]: '900000'
                })
            )
        ).toEqual({perLookupMs: 8000, ceilingMs: 900_000})
    })

    test('the notice states the number, and the refusal states it too', () => {
        // Both halves must name the same budget: the worker rations against the
        // notice and only learns it was real from the refusal.
        expect(projectDocsBudgetNotice(20)).toContain('20')
        expect(projectDocsBudgetNotice(20)).toContain('pi-worker-docs')
        expect(projectDocsBudgetExhausted(20)).toContain('20')
        // The refusal must not invite a retry — a rephrase costs another tool call.
        expect(projectDocsBudgetExhausted(20)).toContain('Do NOT retry')
    })
})
