import {describe, expect, test} from 'bun:test'
import {
    yoloPickAnswer,
    yoloPickAutoAnswer,
    yoloVerifyResolution,
    yoloFinalGateChoice,
    isYoloMode,
    YOLO_STAMP
} from '../../src/task/yolo.js'
import type {AutoAnswer} from '../../src/task/parsers.js'
import {getConfig} from '../../src/config/config.js'
import {MAX_FINAL_GATE_AUTOFIX} from '../../src/task/final-gate-fix.js'

describe('yolo policy fires ONLY with the flag on', () => {
    test('every site returns null (= ask the human) when disabled', () => {
        expect(yoloPickAnswer(false, {suggested: 'use SQLite'})).toBeNull()
        expect(
            yoloPickAutoAnswer(false, {kind: 'answered', text: 'use SQLite', raw: ''})
        ).toBeNull()
        expect(yoloVerifyResolution(false)).toBeNull()
        expect(yoloFinalGateChoice(false, true)).toBeNull()
        expect(yoloFinalGateChoice(false, false)).toBeNull()
    })

    test('the shipped default is OFF — a normal run never auto-picks', () => {
        expect(getConfig().yoloMode).toBe(false)
        expect(isYoloMode()).toBe(false)
    })
})

describe('yoloPickAnswer — take the RECOMMENDED option, else step aside', () => {
    test('takes `suggested` (index 0 / the green card)', () => {
        expect(yoloPickAnswer(true, {suggested: 'use SQLite', alt: 'use Postgres'})).toEqual({
            kind: 'answer',
            answer: 'use SQLite'
        })
    })

    test('falls back to the B-side when only ALT is offered', () => {
        expect(yoloPickAnswer(true, {alt: 'use Postgres'})).toEqual({
            kind: 'answer',
            answer: 'use Postgres'
        })
    })

    test('a question with NO recommendation is skipped, never guessed', () => {
        expect(yoloPickAnswer(true, {})).toEqual({
            kind: 'skip',
            note: 'no recommended option to take'
        })
        // Whitespace is not a recommendation either.
        expect(yoloPickAnswer(true, {suggested: '   '})?.kind).toBe('skip')
    })

    test('an explicitly unsafe recommendation is skipped with its reason', () => {
        expect(
            yoloPickAnswer(true, {suggested: 'call Bun.mkdirSync', unsafe: 'hallucinated'})
        ).toEqual({kind: 'skip', note: 'hallucinated'})
    })
})

describe('yoloPickAutoAnswer — the anti-synthesis unknown is never auto-accepted', () => {
    const demoted: AutoAnswer = {
        kind: 'unknown',
        suggested: 'use `Bun.mkdirSync(dir)` to create the upload directory',
        raw: '',
        reason: 'api-synthesis'
    }

    test('an ANTI-SYNTHESIS demotion is SKIPPED, not accepted (would re-promote the hallucination)', () => {
        const pick = yoloPickAutoAnswer(true, demoted)
        expect(pick?.kind).toBe('skip')
        expect(pick).not.toMatchObject({kind: 'answer'})
        // The note names the class so the skipped question is auditable in the task file.
        expect((pick as {note: string}).note).toMatch(/unverified API/i)
    })

    test('the OTHER two unknown producers keep their recommendation', () => {
        // integration-unknown: research could not ground it, but the answer is a
        // best-effort recommendation — exactly what the green card would show.
        expect(
            yoloPickAutoAnswer(true, {
                kind: 'unknown',
                suggested: 'mount the client at /',
                raw: '',
                reason: 'integration'
            })
        ).toEqual({kind: 'answer', answer: 'mount the client at /'})
        // threw: no recommendation exists at all ⇒ skip.
        expect(
            yoloPickAutoAnswer(true, {kind: 'unknown', raw: '(threw: boom)', reason: 'threw'})?.kind
        ).toBe('skip')
    })

    test('a plain answered auto-answer is taken as-is', () => {
        expect(yoloPickAutoAnswer(true, {kind: 'answered', text: 'use SQLite', raw: ''})).toEqual({
            kind: 'answer',
            answer: 'use SQLite'
        })
    })

    test('an untagged unknown (legacy shape) is treated as an ordinary recommendation', () => {
        expect(
            yoloPickAutoAnswer(true, {kind: 'unknown', suggested: 'use SQLite', raw: ''})
        ).toEqual({kind: 'answer', answer: 'use SQLite'})
    })
})

describe('yolo bounded-loop policies', () => {
    test('verify-FAIL picker auto-picks ACCEPT, never AUTOFIX (the budget is already spent)', () => {
        expect(yoloVerifyResolution(true)).toEqual({action: 'accept'})
    })

    test('final gate autofixes only WHILE the card is offered, then leaves the run FAILED', () => {
        expect(yoloFinalGateChoice(true, true)).toEqual({action: 'autofix'})
        // canAutofix goes false at MAX_FINAL_GATE_AUTOFIX — never 'accept', which
        // would complete a run whose whole-repo gate is red.
        expect(yoloFinalGateChoice(true, false)).toEqual({action: 'leave'})
    })
})

test("YOLO cannot exceed the final-gate autofix cap — replaying the loop's own budget", () => {
    // Drive the policy the way AutofixLedger does: canAutofix() is
    // `attempts < budget` with the budget set to MAX_FINAL_GATE_AUTOFIX, and every
    // 'autofix' spends one attempt. The loop must terminate at the cap, never spin.
    let fixAttempts = 0
    const actions: string[] = []
    for (let guard = 0; guard < 20; guard++) {
        const canAutofix = fixAttempts < MAX_FINAL_GATE_AUTOFIX
        const choice = yoloFinalGateChoice(true, canAutofix)!
        actions.push(choice.action)
        if (choice.action !== 'autofix') break
        fixAttempts += 1
    }
    expect(actions.filter(a => a === 'autofix')).toHaveLength(MAX_FINAL_GATE_AUTOFIX)
    expect(actions[actions.length - 1]).toBe('leave')
})

test('the provenance stamp is a literal marker artifacts can be grepped for', () => {
    expect(YOLO_STAMP).toBe('(YOLO)')
})
