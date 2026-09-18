import {describe, expect, test} from 'bun:test'
import {readFileSync} from 'node:fs'
import * as path from 'node:path'
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
        'that ownership belongs to migrate.ts/the test, not the migration',
        // A negation cancels a phrase in its own clause only.
        'Proceed without touching the test file, accepting that its assertions fail',
        'Keep option B with no schema changes and flag the test as a known issue',
        'Leave test/migrate.test.ts failing',
        'Skip updating the tests — they will be fixed in a follow-up task',
        'the migrate test will fail but that is out of scope for this task'
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
        'the runner owns schema_migrations; do not create it here',
        // Plans, not deferrals: nothing in the clause is a check.
        'Use bun 1.1.30 — 1.1.29 has a known issue with fs.watch',
        'Add pagination as a follow-up; keep this step to the list endpoint',
        'the later step will update the router to mount this handler',
        'Use the file owner permissions (0644)',
        'the module owner field in package.json',
        'update the failing test in test/x.test.ts, since the router is out of scope',
        'Use option B, leave the existing seed data untouched, and update test/migrate.test.ts so the suite stays green',
        // Weighing an option is not choosing it.
        "IF NOT EXISTS is not in §4, and it would still leave the test's assertions failing"
    ])('passes: %s', text => {
        expect(defersBreakage(text)).toBe(false)
    })

    // The published A/B (scripts/ab-green-suite.ts) is scored by this function. A
    // change here that moves a recorded verdict changes a result already reported.
    test('the recorded A/B answers score as published: A 8/8, B 3/8, re-asks 0/3', () => {
        const ledger = (name: string): Array<{arm?: string; decision: string}> =>
            readFileSync(path.join(import.meta.dir, '../../scripts/ledgers', name), 'utf8')
                .split('\n')
                .filter(l => l.trim().length > 0)
                .map(l => JSON.parse(l) as {arm?: string; decision: string})
        const trials = ledger('green-suite-2026-09-18.jsonl')
        const deferrals = (arm: string): number =>
            trials.filter(r => r.arm === arm && defersBreakage(r.decision)).length
        expect([deferrals('A'), deferrals('B')]).toEqual([8, 3])
        expect(
            ledger('green-suite-reask-2026-09-18.jsonl').filter(r => defersBreakage(r.decision))
        ).toEqual([])
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
