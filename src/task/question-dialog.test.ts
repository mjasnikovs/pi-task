import {test, expect, describe} from 'bun:test'
import {
    resolveAnswer,
    buildOptionCards,
    isTwoOption,
    type PendingQuestion
} from './question-dialog.js'

// The mapping these cover used to exist in three places — grill, clarify and the
// plan session — and the plan session's own docstring said the other two were
// mirrors of it. They were not: they had drifted in three ways. These tests now
// hold for all three call sites at once.

const fork: PendingQuestion = {
    plain: 'One task or split per call site?',
    shown: 'One task or split per call site?',
    suggested: 'one task',
    alt: 'split per call site'
}
const single: PendingQuestion = {
    plain: 'Which port?',
    shown: 'Which port?',
    suggested: '3000'
}
const open: PendingQuestion = {plain: 'Anything else?', shown: 'Anything else?'}

describe('resolveAnswer', () => {
    test('an empty submit accepts the recommendation', () => {
        expect(resolveAnswer(single, '')).toEqual({answer: '3000', source: 'accepted'})
        expect(resolveAnswer(fork, '')).toEqual({answer: 'one task', source: 'accepted'})
    })

    test('an empty submit with nothing to accept is a skip', () => {
        expect(resolveAnswer(open, '   ')).toEqual({answer: '(skipped)', source: 'skipped'})
    })

    test('a bare A/B maps back to the option full text', () => {
        // Load-bearing: a remote user, or the picker's free-text fallback, can
        // still type the letter. Storing it leaves the next generation call a
        // dangling reference it cannot decode.
        for (const a of ['a', 'A', 'a.', 'A)', ' b ', 'B.']) {
            const r = resolveAnswer(fork, a)
            expect(r.source).toBe('chosen')
            expect(['one task', 'split per call site']).toContain(r.answer)
        }
        expect(resolveAnswer(fork, 'a').answer).toBe('one task')
        expect(resolveAnswer(fork, 'b').answer).toBe('split per call site')
    })

    test('a bare A/B on a NON-fork is taken verbatim — there is no B to mean', () => {
        expect(resolveAnswer(single, 'a')).toEqual({answer: 'a', source: 'typed'})
    })

    test('pressing the single green card has the same provenance as accepting it', () => {
        // The divergence that mattered: clarify stamps an accepted recommendation
        // in its transcript, and both routes to an accept must be stamped alike.
        expect(resolveAnswer(single, '3000')).toEqual({answer: '3000', source: 'accepted'})
    })

    test('picking one side of a FORK is a choice, not an acceptance', () => {
        expect(resolveAnswer(fork, 'one task')).toEqual({answer: 'one task', source: 'chosen'})
        expect(resolveAnswer(fork, 'split per call site')).toEqual({
            answer: 'split per call site',
            source: 'chosen'
        })
    })

    test('anything else is the user own words, verbatim', () => {
        expect(resolveAnswer(fork, 'split, but keep one entry point')).toEqual({
            answer: 'split, but keep one entry point',
            source: 'typed'
        })
    })

    test('surrounding whitespace never changes the outcome', () => {
        expect(resolveAnswer(single, '  3000  ').source).toBe('accepted')
        expect(resolveAnswer(fork, '  A  ').answer).toBe('one task')
    })
})

describe('buildOptionCards', () => {
    test('a fork gets two lettered cards, recommendation first', () => {
        expect(buildOptionCards(fork)).toEqual([
            {label: 'A: one task', value: 'one task'},
            {label: 'B: split per call site', value: 'split per call site'}
        ])
    })

    test('a single recommendation gets one UNLETTERED card', () => {
        expect(buildOptionCards(single)).toEqual([{label: '3000', value: '3000'}])
    })

    test('an open question gets undefined, not an empty list', () => {
        // undefined is what makes ui.ask fall back to a bare text prompt; an empty
        // array would render an empty picker.
        expect(buildOptionCards(open)).toBeUndefined()
    })

    test('the DISPLAY form labels the card while the PLAIN form is the value', () => {
        const md: PendingQuestion = {
            ...fork,
            shownSuggested: 'one \x1b[1mtask\x1b[0m',
            shownAlt: 'split per \x1b[1mcall site\x1b[0m'
        }
        const cards = buildOptionCards(md)!
        expect(cards[0].label).toBe('A: one \x1b[1mtask\x1b[0m')
        expect(cards[0].value).toBe('one task')
    })
})

test('isTwoOption needs BOTH sides', () => {
    expect(isTwoOption(fork)).toBe(true)
    expect(isTwoOption(single)).toBe(false)
    expect(isTwoOption(open)).toBe(false)
})
