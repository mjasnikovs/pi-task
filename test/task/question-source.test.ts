import {describe, expect, test} from 'bun:test'
import {
    makeQuestionSource,
    pickQuestion,
    isNoneReply,
    MAX_DIALOG_QUESTIONS,
    type QuestionRule
} from '../../src/task/question-source.js'
import {MAX_DUP_STRIKES} from '../../src/task/question-dedup.js'

/**
 * The whole state machine, driven as strings. `makeQuestionSource` takes its
 * generator as a parameter, so every exit below — a question, a NONE, an
 * unparseable reply, a duplicate strike-out — is reachable without a temp dir, a
 * fake ctx or a scripted child.
 */

const FORMAT_HINT = '[FORMAT]'

/** A generator that replays a script, recording the hint it was called with. */
function scripted(replies: string[]) {
    const hints: Array<string | null> = []
    let i = 0
    return {
        hints,
        generate: (hint: string | null): Promise<string> => {
            hints.push(hint)
            return Promise.resolve(replies[Math.min(i++, replies.length - 1)])
        }
    }
}

const Q = (n: string, suggested = 'do the thing') =>
    `1. **${n}** rationale\nSUGGESTED: ${suggested}`

describe('pickQuestion', () => {
    // A model that opens with a numbered analysis note leaves the SUGGESTED line on
    // a later entry, so taking parsed[0] would drop the recommendation.
    test('prefers the first entry carrying a SUGGESTED line', () => {
        const parsed = [
            {question: 'a note', suggested: undefined},
            {question: 'real?', suggested: 'yes'}
        ]
        expect(pickQuestion(parsed)?.question).toBe('real?')
    })

    test('falls back to the first entry when none has one', () => {
        const parsed = [
            {question: 'a?', suggested: undefined},
            {question: 'b?', suggested: undefined}
        ]
        expect(pickQuestion(parsed)?.question).toBe('a?')
    })

    test('an empty SUGGESTED does not count as one', () => {
        const parsed = [
            {question: 'a?', suggested: ''},
            {question: 'b?', suggested: 'yes'}
        ]
        expect(pickQuestion(parsed)?.question).toBe('b?')
    })
})

describe('isNoneReply', () => {
    test('the deliberate sentinel, and only it', () => {
        expect(isNoneReply('NONE')).toBe(true)
        expect(isNoneReply('  NONE  \n')).toBe(true)
        expect(isNoneReply('blah\nNONE\n')).toBe(true)
        expect(isNoneReply('NONE of these apply')).toBe(false)
        expect(isNoneReply('I have no more questions.')).toBe(false)
    })
})

describe('makeQuestionSource', () => {
    test('yields a parsed question with a 1-based index', async () => {
        const s = scripted([Q('Which store?')])
        const src = makeQuestionSource({generate: s.generate, formatHint: FORMAT_HINT})
        const r = await src.next()
        expect(r.kind).toBe('question')
        if (r.kind === 'question') {
            expect(r.plain).toBe('Which store? rationale')
            expect(r.index).toBe(1)
            expect(r.q.suggested).toBe('do the thing')
        }
        expect(src.asked()).toEqual(['Which store? rationale'])
    })

    test('a deliberate NONE exhausts with why: none', async () => {
        const s = scripted(['NONE'])
        const src = makeQuestionSource({generate: s.generate, formatHint: FORMAT_HINT})
        expect(await src.next()).toEqual({kind: 'exhausted', why: 'none'})
        expect(s.hints).toHaveLength(1)
    })

    // An unreadable reply and "no questions left" are different endings. Treating
    // the first as the second means one formatting slip decomposes the whole
    // feature with zero clarifications asked.
    test('an UNPARSEABLE reply buys one format re-prompt, not silence', async () => {
        const s = scripted(['I think we should consider a few things first.', Q('Which store?')])
        const src = makeQuestionSource({generate: s.generate, formatHint: FORMAT_HINT})
        const r = await src.next()
        expect(r.kind).toBe('question')
        expect(s.hints).toEqual([null, FORMAT_HINT])
    })

    // …and the exhaustion reason says which ending it was. Reporting `none` here
    // would put "the model has no further questions" on the trail for a run where
    // it only ever produced malformed replies.
    test('a SECOND unparseable reply exhausts as `unparseable`, not as NONE', async () => {
        const s = scripted(['garbage', 'still garbage', 'still garbage'])
        const src = makeQuestionSource({generate: s.generate, formatHint: FORMAT_HINT})
        expect(await src.next()).toEqual({kind: 'exhausted', why: 'unparseable'})
        expect(s.hints).toEqual([null, FORMAT_HINT])
    })

    test('a NONE after a format re-prompt is still a NONE', async () => {
        const s = scripted(['garbage', 'NONE'])
        const src = makeQuestionSource({generate: s.generate, formatHint: FORMAT_HINT})
        expect(await src.next()).toEqual({kind: 'exhausted', why: 'none'})
    })

    test('a numbered analysis note before the question does not become the question', async () => {
        const s = scripted([
            '1. gateDebugWriter in orchestrator.ts — wraps a raw append function\n'
                + '2. **Which store should the cache use?** rationale\n'
                + 'SUGGESTED: sqlite'
        ])
        const src = makeQuestionSource({generate: s.generate, formatHint: FORMAT_HINT})
        const r = await src.next()
        expect(r.kind).toBe('question')
        if (r.kind === 'question') {
            expect(r.plain).toBe('Which store should the cache use? rationale')
            expect(r.q.suggested).toBe('sqlite')
        }
    })

    test('a duplicate is re-prompted, then strikes out', async () => {
        const s = scripted([
            Q('Which store?'),
            Q('which store'),
            Q('which store'),
            Q('which store')
        ])
        const src = makeQuestionSource({generate: s.generate, formatHint: FORMAT_HINT})
        expect((await src.next()).kind).toBe('question')
        expect(await src.next()).toEqual({kind: 'exhausted', why: 'dups'})
        // One draw for Q1, then MAX_DUP_STRIKES draws that were all dups.
        expect(s.hints.length).toBe(1 + MAX_DUP_STRIKES)
    })

    test('the cap exhausts before the generator is called again', async () => {
        const distinct = [
            Q('Which database engine should back the cache?'),
            Q('How should uploaded avatars be resized on ingest?'),
            Q('What retention window applies to audit log rows?')
        ]
        let n = 0
        const src = makeQuestionSource({
            generate: () => Promise.resolve(distinct[Math.min(n++, distinct.length - 1)]),
            formatHint: FORMAT_HINT,
            cap: 2
        })
        expect((await src.next()).kind).toBe('question')
        expect((await src.next()).kind).toBe('question')
        expect(await src.next()).toEqual({kind: 'exhausted', why: 'cap'})
    })

    test('the default cap is the one both dialogs used', () => {
        expect(MAX_DIALOG_QUESTIONS).toBe(8)
    })

    describe('quality rules', () => {
        const deferral: QuestionRule = {
            id: 'deferral',
            detect: q => (q.suggested?.startsWith('ask the user') ? '[DECISIVE]' : null),
            repair: q => ({...q, suggested: q.alt, alt: undefined})
        }

        test('a rule fires once and the corrected draw is yielded', async () => {
            const s = scripted([Q('Which store?', 'ask the user'), Q('Which store?', 'sqlite')])
            const src = makeQuestionSource({
                generate: s.generate,
                formatHint: FORMAT_HINT,
                rules: [deferral]
            })
            const r = await src.next()
            expect(r.kind).toBe('question')
            if (r.kind === 'question') expect(r.q.suggested).toBe('sqlite')
            expect(s.hints).toEqual([null, '[DECISIVE]'])
        })

        // A question with a bad default still beats no question.
        test('a defect that SURVIVES its re-prompt degrades, it does not discard', async () => {
            const s = scripted([
                '1. **Which store?** why\nSUGGESTED: ask the user\nALT: sqlite',
                '1. **Which store?** why\nSUGGESTED: ask the user\nALT: sqlite'
            ])
            const src = makeQuestionSource({
                generate: s.generate,
                formatHint: FORMAT_HINT,
                rules: [deferral]
            })
            const r = await src.next()
            expect(r.kind).toBe('question')
            if (r.kind === 'question') {
                expect(r.q.suggested).toBe('sqlite')
                expect(r.q.alt).toBeUndefined()
            }
            expect(s.hints).toHaveLength(2)
        })

        // The backstop must not pay for a question it is about to throw away.
        test('the duplicate backstop runs BEFORE any quality rule', async () => {
            let ruleFired = 0
            const counting: QuestionRule = {
                id: 'counting',
                detect: () => {
                    ruleFired++
                    return null
                }
            }
            const s = scripted([
                Q('Which store?'),
                Q('which store'),
                Q('which store'),
                Q('which store')
            ])
            const src = makeQuestionSource({
                generate: s.generate,
                formatHint: FORMAT_HINT,
                rules: [counting]
            })
            await src.next()
            await src.next()
            // Only the first, non-duplicate question was ever offered to the rule.
            expect(ruleFired).toBe(1)
        })

        test('the one-shot budget resets for the next question', async () => {
            const s = scripted([
                Q('Which database engine should back the cache?', 'ask the user'),
                Q('Which database engine should back the cache?', 'sqlite'),
                Q('How should uploaded avatars be resized on ingest?', 'ask the user'),
                Q('How should uploaded avatars be resized on ingest?', 'postgres')
            ])
            const src = makeQuestionSource({
                generate: s.generate,
                formatHint: FORMAT_HINT,
                rules: [deferral]
            })
            const a = await src.next()
            const b = await src.next()
            expect(a.kind).toBe('question')
            expect(b.kind).toBe('question')
            if (b.kind === 'question') expect(b.q.suggested).toBe('postgres')
            expect(s.hints).toEqual([null, '[DECISIVE]', null, '[DECISIVE]'])
        })
    })
})
