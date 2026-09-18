import {describe, expect, test} from 'bun:test'
import {defersBreakage, deferredBreakageReaskHint} from '../../src/task/deferred-breakage.js'
import {yoloPickAutoAnswer} from '../../src/task/yolo.js'
import {GRILL_GREEN_SUITE_CHECK, GRILL_AUTO_ANSWER_PROMPT} from '../../src/task/prompts.js'

// The answer that turned mx5-n's suite red for the rest of the run (TASK_0004 A1).
const MX5_A1 =
    '(B) — write plain CREATE TABLE / CREATE INDEX exactly matching §4 verbatim (one-shot), '
    + 'and flag the test/migrate.test.ts breakage (strict-equality applied/afterLength assertions '
    + 'and the drop-schema_migrations-but-leave-tables re-apply hazard) as a known issue for the '
    + "test owner; do not add IF NOT EXISTS, since the one-shot guarantee is the runner's and the "
    + 'spec pins the DDL verbatim.'

describe('defersBreakage', () => {
    test('catches the recorded mx5-n answer', () => {
        expect(defersBreakage(MX5_A1)).toBe(true)
    })

    test.each([
        'flag it as a known issue for the test owner',
        "accepting that the test's strict-equality assertions will still fail",
        'owned by whoever revisits the test',
        'leave the suite red; a later step will fix it',
        'a later task should update test/migrate.test.ts',
        "accept that test/migrate.test.ts's strict-equality assertions (toEqual([{filename: GOOD_FILE}]) and toHaveLength(1)) will fail once 0001_init.sql exists, and flag that test as the owned follow-up to fix",
        'the strict-equality assertions still fail and are left for whoever owns test/migrate.test.ts',
        'that ownership belongs to migrate.ts/the test, not the migration'
    ])('catches: %s', text => {
        expect(defersBreakage(text)).toBe(true)
    })

    test.each([
        '(B) write plain CREATE TABLE, and update test/migrate.test.ts so the suite stays green',
        'But do NOT defer: updating that test is in scope as part of this change, not a deferral to a "test owner" (naming the file to update: test/migrate.test.ts).',
        'update the test now rather than flag it as a known issue',
        'report a summary with counts and representative examples',
        'add a test for the new route in the same change',
        'use npm',
        'the runner owns schema_migrations; do not create it here'
    ])('passes: %s', text => {
        expect(defersBreakage(text)).toBe(false)
    })

    test('the re-ask hint quotes the deferring answer', () => {
        expect(deferredBreakageReaskHint(MX5_A1)).toContain('write plain CREATE TABLE')
    })
})

describe('deferred-breakage unknowns are never taken unattended', () => {
    test('yolo skips a deferred-breakage unknown', () => {
        const pick = yoloPickAutoAnswer(true, {
            kind: 'unknown',
            suggested: MX5_A1,
            raw: '',
            reason: 'deferred-breakage'
        })
        expect(pick?.kind).toBe('skip')
        expect((pick as {note: string}).note).toMatch(/owner that does not exist/)
    })
})

describe('GREEN-SUITE CHECK is the first triage check', () => {
    test('the prompt carries it before ALREADY-DECIDED', () => {
        const p = GRILL_AUTO_ANSWER_PROMPT('refined', 'research', 'q')
        expect(p).toContain(GRILL_GREEN_SUITE_CHECK)
        expect(p.indexOf('GREEN-SUITE CHECK')).toBeLessThan(p.indexOf('ALREADY-DECIDED CHECK'))
        expect(GRILL_GREEN_SUITE_CHECK.startsWith('1. ')).toBe(true)
    })
})
