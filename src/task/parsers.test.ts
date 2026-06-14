import {describe, expect, test} from 'bun:test'
import {
    parseGrillQuestions,
    parseClarifyList,
    parseAutoAnswer,
    autoAnswerHasTag,
    deriveTitle
} from './parsers.js'

describe('parseGrillQuestions', () => {
    test('parses numbered lines with "."', () => {
        const out = parseGrillQuestions('1. first\n2. second\n3. third')
        expect(out).toEqual(['first', 'second', 'third'])
    })

    test('parses numbered lines with ")"', () => {
        const out = parseGrillQuestions('1) one\n2) two')
        expect(out).toEqual(['one', 'two'])
    })

    test('ignores non-numbered lines', () => {
        const out = parseGrillQuestions('hello\n1. real question\nworld')
        expect(out).toEqual(['real question'])
    })

    test('caps at MAX_GRILL_QUESTIONS (10)', () => {
        const text = Array.from({length: 20}, (_, i) => `${i + 1}. q${i + 1}`).join('\n')
        const out = parseGrillQuestions(text)
        expect(out.length).toBe(10)
    })

    test('returns empty array on empty input', () => {
        expect(parseGrillQuestions('')).toEqual([])
    })

    test('treats lone NONE sentinel as zero questions', () => {
        expect(parseGrillQuestions('NONE')).toEqual([])
        expect(parseGrillQuestions('  NONE  ')).toEqual([])
        expect(parseGrillQuestions('NONE\n')).toEqual([])
    })

    test('NONE on its own line wins over surrounding noise', () => {
        expect(parseGrillQuestions('some preamble\nNONE\nmore noise')).toEqual([])
    })
})

describe('parseClarifyList', () => {
    test('pairs each question with its SUGGESTED default', () => {
        const out = parseClarifyList(
            '1. Where do photos live?\nSUGGESTED: local disk via Bun file APIs\n'
                + '2. Auth model?\nSUGGESTED: cookie sessions'
        )
        expect(out).toEqual([
            {question: 'Where do photos live?', suggested: 'local disk via Bun file APIs'},
            {question: 'Auth model?', suggested: 'cookie sessions'}
        ])
    })

    test('a question without a SUGGESTED line has no default', () => {
        const out = parseClarifyList('1. Which store?\n2. Cache?\nSUGGESTED: Redis')
        expect(out).toEqual([{question: 'Which store?'}, {question: 'Cache?', suggested: 'Redis'}])
    })

    test('only the first SUGGESTED after a question attaches', () => {
        const out = parseClarifyList('1. Q\nSUGGESTED: first\nSUGGESTED: second')
        expect(out).toEqual([{question: 'Q', suggested: 'first'}])
    })

    test('ignores a SUGGESTED line before any question', () => {
        const out = parseClarifyList('SUGGESTED: stray\n1. Real?')
        expect(out).toEqual([{question: 'Real?'}])
    })

    test('treats lone NONE as zero questions', () => {
        expect(parseClarifyList('NONE')).toEqual([])
        expect(parseClarifyList('preamble\nNONE\nnoise')).toEqual([])
    })

    test('caps at MAX_GRILL_QUESTIONS (10) keeping each suggestion', () => {
        const text = Array.from(
            {length: 20},
            (_, i) => `${i + 1}. q${i + 1}\nSUGGESTED: s${i + 1}`
        ).join('\n')
        const out = parseClarifyList(text)
        expect(out.length).toBe(10)
        expect(out[9]).toEqual({question: 'q10', suggested: 's10'})
    })

    test('splits a SUGGESTED that the model wrote inline on the question line', () => {
        const out = parseClarifyList(
            '1. Real-time or polling? This must be resolved. SUGGESTED: REST polling with a cursor.'
        )
        expect(out).toEqual([
            {
                question: 'Real-time or polling? This must be resolved.',
                suggested: 'REST polling with a cursor.'
            }
        ])
    })

    test('still parses a SUGGESTED on its own line', () => {
        const out = parseClarifyList('1. Real-time or polling?\nSUGGESTED: REST polling')
        expect(out).toEqual([{question: 'Real-time or polling?', suggested: 'REST polling'}])
    })

    test('inline SUGGESTED takes precedence over a later own-line SUGGESTED', () => {
        const out = parseClarifyList('1. Q? SUGGESTED: inline wins\nSUGGESTED: own line loses')
        expect(out).toEqual([{question: 'Q?', suggested: 'inline wins'}])
    })

    test('preserves markdown verbatim (rendering/stripping happens at the call site)', () => {
        const out = parseClarifyList(
            '1. **What transport should messaging use?** Native `WebSockets` or polling?\n'
                + 'SUGGESTED: **Native WebSockets** via `Bun.serve`'
        )
        expect(out).toEqual([
            {
                question:
                    '**What transport should messaging use?** Native `WebSockets` or polling?',
                suggested: '**Native WebSockets** via `Bun.serve`'
            }
        ])
    })

    test('pairs a binary fork with its SUGGESTED and ALT options on their own lines', () => {
        const out = parseClarifyList('1. npm or pnpm?\nSUGGESTED: npm\nALT: pnpm')
        expect(out).toEqual([{question: 'npm or pnpm?', suggested: 'npm', alt: 'pnpm'}])
    })

    test('only the first ALT after a question attaches', () => {
        const out = parseClarifyList('1. A or B?\nSUGGESTED: A\nALT: B\nALT: C')
        expect(out).toEqual([{question: 'A or B?', suggested: 'A', alt: 'B'}])
    })

    test('splits inline SUGGESTED and ALT written on the question line', () => {
        const out = parseClarifyList('1. npm or pnpm? SUGGESTED: npm ALT: pnpm')
        expect(out).toEqual([{question: 'npm or pnpm?', suggested: 'npm', alt: 'pnpm'}])
    })

    test('an open-ended question has no alt', () => {
        const out = parseClarifyList('1. Where do photos live?\nSUGGESTED: local disk')
        expect(out).toEqual([{question: 'Where do photos live?', suggested: 'local disk'}])
    })
})

describe('parseAutoAnswer', () => {
    test('parses ANSWER: line as answered', () => {
        const r = parseAutoAnswer('ANSWER: npm')
        expect(r.kind).toBe('answered')
        if (r.kind === 'answered') expect(r.text).toBe('npm')
    })

    test('tolerates common ANSWER typos (ANSER, ANSWR, ANWER, ANWSER)', () => {
        for (const typo of ['ANSER', 'ANSWR', 'ANWER', 'ANWSER']) {
            const r = parseAutoAnswer(`${typo}: do the thing`)
            expect(r.kind).toBe('answered')
            if (r.kind === 'answered') expect(r.text).toBe('do the thing')
        }
    })

    test('parses UNKNOWN: with inline text as suggestion', () => {
        const r = parseAutoAnswer('UNKNOWN: just guess')
        expect(r.kind).toBe('unknown')
        if (r.kind === 'unknown') expect(r.suggested).toBe('just guess')
    })

    test('parses UNKNOWN: followed by next-line suggestion', () => {
        const r = parseAutoAnswer('UNKNOWN:\nbest guess')
        expect(r.kind).toBe('unknown')
        if (r.kind === 'unknown') expect(r.suggested).toBe('best guess')
    })

    test('falls back to first non-empty line as suggestion when no marker', () => {
        const r = parseAutoAnswer('probably this\nor maybe that')
        expect(r.kind).toBe('unknown')
        if (r.kind === 'unknown') expect(r.suggested).toBe('probably this')
    })

    test('does not surface a preamble heading (trailing colon) as the suggestion', () => {
        const r = parseAutoAnswer(
            "This is a concrete implementation decision with trade-offs. Here's the analysis:"
        )
        expect(r.kind).toBe('unknown')
        if (r.kind === 'unknown') expect(r.suggested).toBeUndefined()
    })

    test('skips a preamble heading and salvages the first real line', () => {
        const r = parseAutoAnswer('Here is the analysis:\ndefer the phone column')
        expect(r.kind).toBe('unknown')
        if (r.kind === 'unknown') expect(r.suggested).toBe('defer the phone column')
    })
})

describe('autoAnswerHasTag', () => {
    test('true for ANSWER/UNKNOWN/ALT lines, including typos and leading space', () => {
        expect(autoAnswerHasTag('ANSWER: npm')).toBe(true)
        expect(autoAnswerHasTag('UNKNOWN: use npm\nALT: use pnpm')).toBe(true)
        expect(autoAnswerHasTag('  UNKNOWN:')).toBe(true)
        expect(autoAnswerHasTag('ANSER: do the thing')).toBe(true)
    })

    test('false when the model wrote free-form prose with no tag', () => {
        expect(
            autoAnswerHasTag(
                "This is a concrete implementation decision. Here's the analysis:"
            )
        ).toBe(false)
        expect(autoAnswerHasTag('')).toBe(false)
    })

    test('returns unknown with no suggestion on empty input', () => {
        const r = parseAutoAnswer('')
        expect(r.kind).toBe('unknown')
        if (r.kind === 'unknown') expect(r.suggested).toBeUndefined()
    })

    test('parses ALT: line as second recommendation', () => {
        const r = parseAutoAnswer('UNKNOWN: use npm\nALT: use pnpm')
        expect(r.kind).toBe('unknown')
        if (r.kind === 'unknown') {
            expect(r.suggested).toBe('use npm')
            expect(r.alt).toBe('use pnpm')
        }
    })

    test('parses ALT: when UNKNOWN: has no inline text', () => {
        const r = parseAutoAnswer('UNKNOWN:\nbest guess\nALT: other guess')
        expect(r.kind).toBe('unknown')
        if (r.kind === 'unknown') {
            expect(r.suggested).toBe('best guess')
            expect(r.alt).toBe('other guess')
        }
    })

    test('no ALT: means alt is undefined', () => {
        const r = parseAutoAnswer('UNKNOWN: use npm')
        expect(r.kind).toBe('unknown')
        if (r.kind === 'unknown') {
            expect(r.suggested).toBe('use npm')
            expect(r.alt).toBeUndefined()
        }
    })

    test('returns unknown with no suggestion when UNKNOWN: has no content', () => {
        const r = parseAutoAnswer('UNKNOWN:')
        expect(r.kind).toBe('unknown')
        if (r.kind === 'unknown') expect(r.suggested).toBeUndefined()
    })
})

describe('deriveTitle', () => {
    test('returns (untitled) for empty input', () => {
        expect(deriveTitle('')).toBe('(untitled)')
    })

    test('extracts first non-empty line after GOAL', () => {
        expect(deriveTitle('GOAL\nDo the thing\nCONSTRAINTS\n- foo')).toBe('Do the thing')
    })

    test('handles "GOAL:" with colon', () => {
        expect(deriveTitle('GOAL:\nFix the bug')).toBe('Fix the bug')
    })

    test('handles markdown heading on GOAL', () => {
        expect(deriveTitle('# GOAL\nShip it')).toBe('Ship it')
    })

    test('handles bold markdown on GOAL (**GOAL**)', () => {
        expect(deriveTitle('**GOAL**\nConfigure ESLint\n**CONSTRAINTS**\n- foo')).toBe(
            'Configure ESLint'
        )
    })

    test('keeps long titles intact (no truncation at storage)', () => {
        const long = 'x'.repeat(200)
        const title = deriveTitle(`GOAL\n${long}`)
        expect(title).toBe(long)
    })

    test('falls back to first non-empty line when no GOAL section', () => {
        expect(deriveTitle('Just a sentence.\nMore.')).toBe('Just a sentence.')
    })

    test('stops at CONSTRAINTS if GOAL paragraph is empty', () => {
        expect(deriveTitle('GOAL\n\nCONSTRAINTS\n- y')).toBe('CONSTRAINTS')
    })
})
