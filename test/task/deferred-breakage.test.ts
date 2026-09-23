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
        'the migrate test will fail but that is out of scope for this task',
        // A hedge is still a decision. These are the shapes a model reaches for
        // first, so a modal that cancelled the phrase let the guard be rephrased
        // away.
        'I would flag it as a known issue and move on.',
        'We could flag the failing suite as a known issue.',
        'It might be simplest to leave the suite red for now.',
        'This would be owned by whoever maintains the test suite.',
        // Naming a person who does not exist is a deferral whatever the clause is
        // about.
        'Leave it for whoever owns that module.',
        'Ownership belongs to the module owner.',
        // A semicolon joins clauses of one thought; the breakage it defers sits in
        // the other half.
        'This is out of scope; the test can stay red.',
        // A condition does not reach across a semicolon. What follows one is the
        // decision, not an option the condition weighs.
        'The test fails only if the fixture is stale; I would flag it as a known issue and move on.',
        'Either way the suite is red; I would leave the test failing for whoever owns it.',
        // A condition reaches no further than its own half, whoever the modal is about.
        'The test fails only if the fixture is stale; it could be flagged as a known issue.',
        // ...and a comma is not a semicolon, so the condition must not reach the
        // decision that follows one either.
        'The test fails only if the fixture is stale, so I would flag it as a known issue and move on.',
        'The suite fails only if the fixture is stale and I would leave it red for the test owner.',
        // A ROLE is nobody. No release manager or QA sits in a /task-auto run.
        'Ownership rests with the release manager.',
        'Ownership belongs to QA.',
        'Ownership lies with the on-call engineer.',
        // One option word must not wave a hedged deferral through. Each of these is
        // a shipped catch above with a pronoun or a clause swapped — the rephrasings
        // a model reaches for first.
        'Either way the suite is red; it could be left failing for whoever owns it.',
        'Option B — write plain CREATE TABLE matching §4 verbatim; the suite would be left failing for the test owner.',
        'Otherwise the suite is red; the test could be left failing for whoever owns the fixture.',
        'That is not an option; the tests could be left failing for the test owner.',
        // ...and an option weighed in a LATER clause cannot reach back to cancel the
        // decision the sentence already made.
        'The test could be left failing for whoever owns it; either way this task is done.',
        'This would be owned by whoever maintains the test suite; the alternative is churn.',
        'My preference would be to leave it red for the test owner; either choice is defensible.',
        'Either way the suite is red; it would be flagged as a known issue for the test owner.',
        'Otherwise, my plan would be to flag it as a known issue for the test owner.',
        // A condition stops at the conclusion the sentence draws, comma or not.
        'The test fails only if the fixture is stale, so it could be flagged as a known issue for the test owner.',
        // Nobody is still nobody with a collective noun appended.
        'Ownership belongs to a later team.',
        'Ownership belongs to someone on another team.',
        'Ownership belongs to whoever the platform team assigns later.',
        'Ownership rests with a later maintainer group.',
        'Ownership rests with the owners of the squad backlog.',
        // A filename is not a team.
        'Ownership rests with the module maintainer of `teams.ts`.',
        // "Change" the verb is work on an existing test, whatever the tense.
        'a later task should change test/migrate.test.ts',
        'test/migrate.test.ts will be changed in a follow-up'
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
        // Writing NEW tests later is a plan. Only a check this sentence calls broken,
        // or an existing test left for someone else to update, is a deferral.
        'Add integration tests in a follow-up task.',
        'Write the unit tests in a later step once the API settles.',
        'Use Vitest; the test suite for the parser is out of scope.',
        'Defer the e2e tests to the next milestone.',
        // "Change" the noun names the unit of work, not work on an existing test.
        'Adding tests for the parser is deferred to a follow-up change.',
        'Tests for the new endpoint belong in a separate change.',
        'Integration tests are out of scope for this change.',
        'The e2e tests are deferred to a later fix.',
        'Use option B, leave the existing seed data untouched, and update test/migrate.test.ts so the suite stays green',
        // Weighing an option is not choosing it.
        "IF NOT EXISTS is not in §4, and it would still leave the test's assertions failing",
        // ...including across a semicolon: the options were posed before it, and the
        // clause weighing them is not the decision the sentence goes on to make.
        "Either update the assertions or add IF NOT EXISTS; the latter would leave the test's assertions failing, so I will update test/migrate.test.ts.",
        'Either drop the column or keep it; keeping it would leave the suite failing, so update the migration.',
        // Ownership of a named team is not ownership by nobody.
        'Ownership belongs to the platform team, who already have the fix queued.',
        'Ownership rests with the release engineering group.',
        // Ownership TAKEN is the answer this guard exists to protect, and the file
        // header names the first of these as the correct mx5-n answer.
        'Ownership belongs to the runner, not the migration; update test/migrate.test.ts here.',
        'Ownership belongs to this task, and I will update test/migrate.test.ts now.',
        'Ownership belongs to Alice.',
        'Ownership rests with the platform org.',
        'Ownership lies with the caller.',
        'Ownership rests with src/migrate.ts, so update it there.',
        // A team stays a team through a comma, a parenthesis and a wrapped line.
        'Ownership belongs to Dave, the platform team lead.',
        'Ownership belongs to Bob (the platform team lead).',
        'Ownership belongs to the platform\nteam, who have the fix queued.',
        // Weighing an option in the first person is still weighing it.
        'We could either update the assertions or leave the tests failing for the test owner, so we will update the assertions.',
        'I could either flag it as a known issue or update the test; I will update the test.',
        'We could flag it as a known issue for the test owner, but that option defers to nobody, so I will update test/migrate.test.ts.',
        // A quoted subscript is an identifier, not the pronoun "I".
        'Either drop the column or keep it; `arr[i]` would leave the suite failing, so update the migration.',
        // A refusal to defer is a refusal whichever apostrophe it is typed with.
        'I don\u2019t leave the tests failing; I update test/migrate.test.ts.',
        "We won't leave the tests failing; we update test/migrate.test.ts.",
        "I wouldn't leave the tests failing; I update test/migrate.test.ts."
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
        // Per trial, not per arm: two compensating flips leave the counts at 8/3
        // while the published result rests on a different set of answers.
        const verdicts = (arm: string): boolean[] =>
            trials.filter(r => r.arm === arm).map(r => defersBreakage(r.decision))
        expect(verdicts('A')).toEqual([true, true, true, true, true, true, true, true])
        expect(verdicts('B')).toEqual([true, false, false, false, false, false, true, true])
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
