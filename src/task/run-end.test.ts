/**
 * How a run ended, and what each ending implies.
 *
 * `TaskRunner.run` returned `void`, so `runSingleTask` re-read the task file's
 * front matter to learn what it had just done and narrowed that to `ok: boolean`.
 * A `/task-cancel` writes `cancelled`, which is not `completed`, so `ok` was
 * false, so the `!ok` arm ran: `markResumable` overwrote `cancelled` with
 * `failed` and the user got a red "stopped — fix and run /task-resume" for a stop
 * they asked for.
 */
import {describe, expect, test} from 'bun:test'
import {RUN_END_POLICY, runSucceeded, type RunEndKind} from './run-end.js'

const KINDS: RunEndKind[] = ['completed', 'cancelled', 'failed', 'interrupted', 'no-session']

describe('RUN_END_POLICY', () => {
    test('every ending has a policy — a new member is a compile error until it does', () => {
        for (const k of KINDS) expect(RUN_END_POLICY[k]).toBeDefined()
        expect(Object.keys(RUN_END_POLICY).sort()).toEqual([...KINDS].sort())
    })

    test('a USER STOP is never marked resumable-as-failed', () => {
        // The whole point. `markResumable` writes `failed`; doing that to a
        // cancelled run lies in the ledger and turns a deliberate stop into a red
        // error. This is the arm `/task-cancel` used to land in.
        expect(RUN_END_POLICY.cancelled.resumable).toBe(false)
        expect(RUN_END_POLICY.cancelled.failsRun).toBe(false)
        expect(RUN_END_POLICY.cancelled.level).toBe('warning')
    })

    test('only a FAULT is an error, and only a fault fails the containing plan', () => {
        for (const k of KINDS) {
            expect(RUN_END_POLICY[k].level === 'error').toBe(k === 'failed')
            expect(RUN_END_POLICY[k].failsRun).toBe(k === 'failed')
        }
    })

    test('failsRun is strictly narrower than resumable', () => {
        // A declined-steer interrupt leaves the inner task resumable but the PLAN in
        // progress, so /task-auto-resume re-delivers that task's spec rather than
        // reporting the whole run as failed.
        expect(RUN_END_POLICY.interrupted.resumable).toBe(true)
        expect(RUN_END_POLICY.interrupted.failsRun).toBe(false)
        for (const k of KINDS) {
            if (RUN_END_POLICY[k].failsRun) expect(RUN_END_POLICY[k].resumable).toBe(true)
        }
    })

    test('a run that could not start a session is not the task’s fault', () => {
        expect(RUN_END_POLICY['no-session'].resumable).toBe(false)
        expect(RUN_END_POLICY['no-session'].failsRun).toBe(false)
    })
})

describe('runSucceeded', () => {
    test('exactly one ending means a spec was delivered', () => {
        for (const k of KINDS) {
            expect(runSucceeded({kind: k} as {kind: 'completed'})).toBe(k === 'completed')
        }
    })
})
