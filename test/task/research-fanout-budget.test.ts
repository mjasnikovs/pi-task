import {describe, expect, test} from 'bun:test'
import {
    DEFAULT_WORKER_PROGRESS_CEILING_MS,
    FANOUT_TIMEOUT_CEILING_ENV,
    FANOUT_TIMEOUT_PER_LOOKUP_ENV,
    PROJECT_DOCS_BUDGET_ENV,
    WORKER_CARRY_FORWARD_ENV,
    WORKER_PROGRESS_CEILING_ENV,
    fanoutTimeoutPolicy,
    projectDocsBudget,
    projectDocsBudgetExhausted,
    projectDocsBudgetNotice,
    workerCarryForward,
    workerProgressCeilingMs
} from '../../src/task/research-fanout-budget.js'

const env =
    (vars: Record<string, string>) =>
    (k: string): string | undefined =>
        vars[k]

describe('research fan-out budget', () => {
    test('CAP and SCALE are OFF by default', () => {
        expect(projectDocsBudget(env({}))).toBeNull()
        expect(fanoutTimeoutPolicy(env({}))).toBeNull()
    })

    // The progress deadline is the one lever here that is ON by default, so its env
    // var is an OFF switch rather than an on switch. These four cases are its whole
    // contract; the last is the one that bites, because turning it off has to be
    // spelled out explicitly.
    test('the progress ceiling is ON by default, and the env var turns it OFF', () => {
        expect(workerProgressCeilingMs(env({}))).toBe(DEFAULT_WORKER_PROGRESS_CEILING_MS)
        expect(workerProgressCeilingMs(env({[WORKER_PROGRESS_CEILING_ENV]: ''}))).toBe(
            DEFAULT_WORKER_PROGRESS_CEILING_MS
        )
        for (const off of ['0', 'off', 'OFF', ' off ']) {
            expect(workerProgressCeilingMs(env({[WORKER_PROGRESS_CEILING_ENV]: off}))).toBeNull()
        }
        expect(workerProgressCeilingMs(env({[WORKER_PROGRESS_CEILING_ENV]: '600000'}))).toBe(
            600_000
        )
    })

    test('a garbage progress ceiling keeps the SHIPPED behaviour, it does not disable it', () => {
        // Opposite of the budget rule below, and deliberately so: there, the
        // shipped value is "off" and a typo must not switch a lever on; here the
        // shipped value is "on" and a typo must not switch one off.
        for (const raw of ['twenty', '-3', 'null']) {
            expect(workerProgressCeilingMs(env({[WORKER_PROGRESS_CEILING_ENV]: raw}))).toBe(
                DEFAULT_WORKER_PROGRESS_CEILING_MS
            )
        }
    })

    test('carry-forward is OFF by default', () => {
        // The two levers are independent: the progress deadline defaults ON,
        // carry-forward defaults OFF and needs its env var set to exactly '1'.
        expect(workerCarryForward(env({}))).toBe(false)
        expect(workerCarryForward(env({[WORKER_CARRY_FORWARD_ENV]: '1'}))).toBe(true)
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
