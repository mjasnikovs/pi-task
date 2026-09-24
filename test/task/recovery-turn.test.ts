import {afterEach, describe, expect, test} from 'bun:test'
import {
    inRecoveryTurn,
    queueRecoveryTurn,
    recoveryTurnPending
} from '../../src/task/recovery-turn.js'
import {recoveryTurns} from '../test-utils/recovery-turns.js'

describe('recovery turn', () => {
    afterEach(() => recoveryTurns().shutdown())

    test('nothing queued: a settle posts nothing', () => {
        const r = recoveryTurns()
        r.settle()
        expect(r.sent).toEqual([])
        expect(recoveryTurnPending()).toBe(false)
    })

    test('two different reminders go out as one turn naming both', () => {
        const r = recoveryTurns()
        queueRecoveryTurn('bash was cancelled')
        queueRecoveryTurn('fetch was cancelled')
        r.settle()
        expect(r.sent).toEqual(['bash was cancelled\n\nfetch was cancelled'])
    })

    test('the same reminder twice is said once', () => {
        const r = recoveryTurns()
        queueRecoveryTurn('bash was cancelled')
        queueRecoveryTurn('bash was cancelled')
        r.settle()
        expect(r.sent).toEqual(['bash was cancelled'])
    })

    test('pending from the abort until the recovery turn starts, then never again', () => {
        const r = recoveryTurns()
        queueRecoveryTurn('bash was cancelled')
        expect(recoveryTurnPending()).toBe(true)
        r.settle()
        expect(recoveryTurnPending()).toBe(true)
        r.start()
        expect(recoveryTurnPending()).toBe(false)
        r.settle()
        expect(r.sent).toHaveLength(1)
    })

    test('a session shut down before its run settles never gets the reminder', () => {
        const r = recoveryTurns()
        queueRecoveryTurn('bash was cancelled')
        r.shutdown()
        r.settle()
        expect(r.sent).toEqual([])
        expect(recoveryTurnPending()).toBe(false)
    })

    test('marks the recovery turn from its start to its settle, and no other run', () => {
        const r = recoveryTurns()
        r.start()
        expect(inRecoveryTurn()).toBe(false)
        queueRecoveryTurn('bash was cancelled')
        r.settle()
        expect(inRecoveryTurn()).toBe(false)
        r.start()
        expect(inRecoveryTurn()).toBe(true)
        r.start() // a continuation inside the same prompt
        expect(inRecoveryTurn()).toBe(true)
        r.settle()
        expect(inRecoveryTurn()).toBe(false)
    })
})
