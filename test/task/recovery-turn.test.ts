import {afterEach, describe, expect, test} from 'bun:test'
import {
    inRecoveryTurn,
    offTurnOver,
    onTurnOver,
    queueRecoveryTurn,
    recoveryTurnPending,
    vetoRecoveryTurn
} from '../../src/task/recovery-turn.js'
import {recoveryTurns} from '../test-utils/recovery-turns.js'

const HOOK = 'recovery-turn-test'

describe('recovery turn', () => {
    afterEach(() => {
        offTurnOver(HOOK)
        recoveryTurns().shutdown()
    })

    test('nothing queued: a settle posts nothing', async () => {
        const r = recoveryTurns()
        await r.settle()
        expect(r.sent).toEqual([])
        expect(recoveryTurnPending()).toBe(false)
    })

    test('two different reminders go out as one turn naming both', async () => {
        const r = recoveryTurns()
        queueRecoveryTurn('bash was cancelled')
        queueRecoveryTurn('fetch was cancelled')
        await r.settle()
        expect(r.sent).toEqual(['bash was cancelled\n\nfetch was cancelled'])
    })

    test('the same reminder twice is said once', async () => {
        const r = recoveryTurns()
        queueRecoveryTurn('bash was cancelled')
        queueRecoveryTurn('bash was cancelled')
        await r.settle()
        expect(r.sent).toEqual(['bash was cancelled'])
    })

    test('pending from the abort until the recovery turn starts, then never again', async () => {
        const r = recoveryTurns()
        queueRecoveryTurn('bash was cancelled')
        expect(recoveryTurnPending()).toBe(true)
        await r.settle()
        expect(recoveryTurnPending()).toBe(true)
        await r.input('bash was cancelled')
        r.start()
        expect(recoveryTurnPending()).toBe(false)
        await r.settle()
        expect(r.sent).toHaveLength(1)
    })

    test('a session shut down before its run settles never gets the reminder', async () => {
        const r = recoveryTurns()
        queueRecoveryTurn('bash was cancelled')
        r.shutdown()
        await r.settle()
        expect(r.sent).toEqual([])
        expect(recoveryTurnPending()).toBe(false)
    })

    test('marks the recovery turn from its start to its settle, and no other run', async () => {
        const r = recoveryTurns()
        r.start()
        expect(inRecoveryTurn()).toBe(false)
        queueRecoveryTurn('bash was cancelled')
        await r.settle()
        expect(inRecoveryTurn()).toBe(false)
        r.start()
        expect(inRecoveryTurn()).toBe(true)
        r.start() // a continuation inside the same prompt
        expect(inRecoveryTurn()).toBe(true)
        await r.settle()
        expect(inRecoveryTurn()).toBe(false)
    })

    test('a recovery turn with no successful tool call is not recovered again', async () => {
        const r = recoveryTurns()
        queueRecoveryTurn('bash was cancelled')
        await r.settle()
        r.start()
        r.toolEnd(true) // a failure is not progress
        queueRecoveryTurn('bash was cancelled')
        await r.settle()
        expect(r.sent).toHaveLength(1)
    })

    test('a recovery turn that got a tool call through is recovered again', async () => {
        const r = recoveryTurns()
        queueRecoveryTurn('bash was cancelled')
        await r.settle()
        r.start()
        r.toolEnd(false)
        queueRecoveryTurn('bash was cancelled')
        await r.settle()
        expect(r.sent).toHaveLength(2)
    })

    test('a veto drops what is queued and anything queued later in the run', async () => {
        const r = recoveryTurns()
        queueRecoveryTurn('bash was cancelled')
        vetoRecoveryTurn()
        queueRecoveryTurn('fetch was cancelled')
        await r.settle()
        expect(r.sent).toEqual([])
        queueRecoveryTurn('bash was cancelled')
        await r.settle()
        expect(r.sent).toHaveLength(1)
    })

    test('the turn is over at a settle with nothing to recover, not at one that posts', async () => {
        const r = recoveryTurns()
        let over = 0
        onTurnOver(HOOK, () => {
            over++
        })
        queueRecoveryTurn('bash was cancelled')
        await r.settle()
        expect(over).toBe(0)
        r.start()
        await r.settle()
        expect(over).toBe(1)
    })

    // pi tells no extension that a deferred prompt failed.
    test('another prompt before the posted one starts ends the turn', async () => {
        const r = recoveryTurns()
        let over = 0
        onTurnOver(HOOK, () => {
            over++
        })
        queueRecoveryTurn('bash was cancelled')
        await r.settle()
        await r.input('bash was cancelled')
        expect(over).toBe(0)
        await r.input('an unrelated question')
        expect(over).toBe(1)
        expect(recoveryTurnPending()).toBe(false)
        r.start()
        expect(inRecoveryTurn()).toBe(false)
    })

    test('a hook re-registered under its key replaces the old one', async () => {
        const r = recoveryTurns()
        const calls: string[] = []
        onTurnOver(HOOK, () => {
            calls.push('old')
        })
        onTurnOver(HOOK, () => {
            calls.push('new')
        })
        await r.settle()
        expect(calls).toEqual(['new'])
    })

    test('removing a hook that no longer holds its key keeps the one that does', async () => {
        const r = recoveryTurns()
        const calls: string[] = []
        const old = (): void => {
            calls.push('old')
        }
        onTurnOver(HOOK, old)
        onTurnOver(HOOK, () => {
            calls.push('new')
        })
        offTurnOver(HOOK, old)
        await r.settle()
        expect(calls).toEqual(['new'])
    })
})
