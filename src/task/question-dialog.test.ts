import {test, expect, describe} from 'bun:test'
import {
    resolveAnswer,
    buildOptionCards,
    isTwoOption,
    settleQuestion,
    type PendingQuestion,
    type SettleQuestionInput
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

describe('settleQuestion — the whole dialog, once', () => {
    /**
     * The COMPOSITION grill and clarify each used to write out at ~50 lines: YOLO
     * short-circuit, cards, ask, cancel, record. The pieces were already shared;
     * this is what was not, and the two copies had drifted on `recommended2`.
     */
    interface Recorded {
        kind: string
        question: string
        answer: string
    }

    function harness(reply: string | undefined): {
        asked: Array<Record<string, unknown>>
        recorded: Recorded[]
        ui: SettleQuestionInput['ui']
        transcript: SettleQuestionInput['transcript']
    } {
        const asked: Array<Record<string, unknown>> = []
        const recorded: Recorded[] = []
        return {
            asked,
            recorded,
            ui: {
                ask: spec => {
                    asked.push(spec as unknown as Record<string, unknown>)
                    return Promise.resolve(reply)
                }
            },
            transcript: {
                add: (kind, question, answer) => recorded.push({kind, question, answer})
            }
        }
    }

    const base = {
        plain: 'Which store?',
        shown: 'Which store?',
        render: (md: string) => `«${md}»`,
        yolo: null
    }

    test('an empty submit is recorded as an acceptance of the recommendation', async () => {
        const h = harness('')
        const out = await settleQuestion({...base, ...h, suggested: 'postgres'})

        expect(out).toBe('settled')
        expect(h.recorded).toEqual([
            {kind: 'accepted', question: 'Which store?', answer: 'postgres'}
        ])
    })

    test('a typed reply is recorded verbatim', async () => {
        const h = harness('sqlite, for now')
        const out = await settleQuestion({...base, ...h, suggested: 'postgres'})

        expect(out).toBe('settled')
        expect(h.recorded[0]).toEqual({
            kind: 'typed',
            question: 'Which store?',
            answer: 'sqlite, for now'
        })
    })

    test('a bare "B" on a fork resolves to the alternative, not the letter', async () => {
        const h = harness('B')
        await settleQuestion({...base, ...h, suggested: 'postgres', alt: 'sqlite'})

        expect(h.recorded[0]?.answer).toBe('sqlite')
    })

    test('a fork offers both recommendations and no skip', async () => {
        const h = harness('')
        await settleQuestion({...base, ...h, suggested: 'postgres', alt: 'sqlite'})

        // `recommended2` was passed unconditionally by one caller and
        // conditionally by the other; it is now conditional, once.
        expect(h.asked[0]!.recommended).toBe('postgres')
        expect(h.asked[0]!.recommended2).toBe('sqlite')
        expect(h.asked[0]!.allowSkip).toBe(false)
        expect(h.asked[0]!.options).toEqual([
            {label: 'A: «postgres»', value: 'postgres'},
            {label: 'B: «sqlite»', value: 'sqlite'}
        ])
    })

    test('a question with nothing to recommend allows a skip and carries no second option', async () => {
        const h = harness('whatever you think')
        await settleQuestion({...base, ...h})

        expect(h.asked[0]!.allowSkip).toBe(true)
        expect('recommended2' in h.asked[0]!).toBe(false)
        expect(h.asked[0]!.options).toBeUndefined()
    })

    test('a cancel is RETURNED, not thrown — the one thing the two callers disagree on', async () => {
        const h = harness(undefined)
        const out = await settleQuestion({...base, ...h, suggested: 'postgres'})

        expect(out).toBe('cancelled')
        expect(h.recorded).toEqual([])
    })

    test('a YOLO answer records without ever building the prompt', async () => {
        const h = harness('never reached')
        const out = await settleQuestion({
            ...base,
            ...h,
            suggested: '`postgres`',
            yolo: {kind: 'answer', answer: '`postgres`'}
        })

        expect(out).toBe('settled')
        expect(h.asked).toEqual([])
        // Stored plain: the transcript is model input, not display.
        expect(h.recorded).toEqual([{kind: 'yolo', question: 'Which store?', answer: 'postgres'}])
    })

    test('a YOLO skip records the note and asks nothing', async () => {
        const h = harness('never reached')
        await settleQuestion({
            ...base,
            ...h,
            yolo: {kind: 'skip', note: 'no recommended option to take'}
        })

        expect(h.asked).toEqual([])
        expect(h.recorded[0]).toEqual({
            kind: 'yolo-skip',
            question: 'Which store?',
            answer: '(skipped — no recommended option to take)'
        })
    })

    test('onAsk runs before the ask, and never on the YOLO path', async () => {
        // grill's "awaiting Qn" widget line. Firing it under YOLO would leave the
        // widget claiming a prompt that was never shown.
        const order: string[] = []
        const h = harness('')
        await settleQuestion({
            ...base,
            ui: {
                ask: spec => {
                    order.push('ask')
                    h.asked.push(spec as unknown as Record<string, unknown>)
                    return Promise.resolve('')
                }
            },
            transcript: h.transcript,
            suggested: 'postgres',
            onAsk: () => order.push('onAsk')
        })
        expect(order).toEqual(['onAsk', 'ask'])

        const y = harness('')
        let fired = false
        await settleQuestion({
            ...base,
            ...y,
            suggested: 'postgres',
            yolo: {kind: 'answer', answer: 'postgres'},
            onAsk: () => {
                fired = true
            }
        })
        expect(fired).toBe(false)
    })
})
