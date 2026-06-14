import {describe, expect, test} from 'bun:test'
import {
    parseVerifyBlock,
    parseGrillQuestions,
    parseClarifyList,
    parseAutoAnswer,
    validateSpecShape,
    stripSpecPreamble,
    deriveTitle,
    isCritiqueClean
} from './parsers.js'

describe('isCritiqueClean', () => {
    test('treats a bare CLEAN line as clean', () => {
        expect(isCritiqueClean('CLEAN')).toBe(true)
    })

    test('is case-insensitive and tolerates trailing punctuation', () => {
        expect(isCritiqueClean('clean')).toBe(true)
        expect(isCritiqueClean('Clean.')).toBe(true)
    })

    test('ignores leading blank lines before CLEAN', () => {
        expect(isCritiqueClean('\n\n  CLEAN\n')).toBe(true)
    })

    test('a defect list is not clean', () => {
        expect(isCritiqueClean('- ACCEPTANCE criterion 2 is unmeasurable')).toBe(false)
    })

    test('empty output is not clean (silent-crash guard)', () => {
        expect(isCritiqueClean('')).toBe(false)
        expect(isCritiqueClean('   \n  ')).toBe(false)
    })

    test('CLEAN as a substring of a longer first line is not clean', () => {
        expect(isCritiqueClean('not CLEAN: VERIFY is missing a build step')).toBe(false)
    })
})

describe('parseVerifyBlock', () => {
    test('returns commands from a ```sh fenced block', () => {
        const spec = 'GOAL\n…\nVERIFY:\n```sh\nnpm test\nnpm run lint\n```\n'
        const cmds = parseVerifyBlock(spec)
        expect(cmds).not.toBeNull()
        expect(cmds!.map(c => c.raw)).toEqual(['npm test', 'npm run lint'])
    })

    test('accepts ```bash fence', () => {
        const spec = 'VERIFY:\n```bash\nls\n```'
        const cmds = parseVerifyBlock(spec)
        expect(cmds!.map(c => c.raw)).toEqual(['ls'])
    })

    test('accepts bare ``` fence', () => {
        const spec = 'VERIFY:\n```\nls\n```'
        const cmds = parseVerifyBlock(spec)
        expect(cmds!.map(c => c.raw)).toEqual(['ls'])
    })

    test('returns null when VERIFY: header is missing', () => {
        expect(parseVerifyBlock('no header here')).toBeNull()
    })

    test('returns null when VERIFY: present but no fence follows', () => {
        expect(parseVerifyBlock('VERIFY:\nplain text')).toBeNull()
    })

    test('skips comment lines and blanks inside the fence', () => {
        const spec = 'VERIFY:\n```sh\n# comment\nnpm test\n\nnpm run lint\n```'
        const cmds = parseVerifyBlock(spec)
        expect(cmds!.map(c => c.raw)).toEqual(['npm test', 'npm run lint'])
    })
})

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

    test('returns unknown with no suggestion on empty input', () => {
        const r = parseAutoAnswer('')
        expect(r.kind).toBe('unknown')
        if (r.kind === 'unknown') expect(r.suggested).toBeUndefined()
    })
})

describe('stripSpecPreamble', () => {
    test('drops narration before the GOAL header', () => {
        const s =
            'Now I have all the context. Here\'s the rewritten spec:\n\nGOAL\n  do x\nVERIFY:\n```sh\nls\n```'
        expect(stripSpecPreamble(s)).toBe('GOAL\n  do x\nVERIFY:\n```sh\nls\n```')
    })

    test('leaves a clean GOAL-first spec untouched', () => {
        const s = 'GOAL\n  do x\nCONSTRAINTS\n- y'
        expect(stripSpecPreamble(s)).toBe(s)
    })

    test('returns unchanged when there is no GOAL line', () => {
        const s = 'just some text\nno goal here'
        expect(stripSpecPreamble(s)).toBe(s)
    })

    test('does NOT unwrap a fenced spec (leaves it for validateSpecShape to reject)', () => {
        const s = '```sh\nGOAL\n…\n```'
        expect(stripSpecPreamble(s)).toBe(s)
    })

    test('does NOT unwrap a cat-heredoc spec', () => {
        const s = 'cat << \'EOF\' > spec.md\nGOAL\n…'
        expect(stripSpecPreamble(s)).toBe(s)
    })

    test('a stripped preamble then passes validateSpecShape', () => {
        const s =
            'Here is the spec:\nGOAL\nx\nCONSTRAINTS\n- y\nACCEPTANCE\n- w\nVERIFY:\n```sh\nls\n```'
        expect(validateSpecShape(stripSpecPreamble(s))).toBeNull()
    })
})

describe('validateSpecShape', () => {
    test('returns null on a well-formed 4-section spec', () => {
        const good = 'GOAL\nx\nCONSTRAINTS\n- y\nACCEPTANCE\n- w\nVERIFY:\n```sh\nls\n```'
        expect(validateSpecShape(good)).toBeNull()
    })

    test('reports empty spec', () => {
        expect(validateSpecShape('   ')).toBe('spec is empty')
    })

    test('reports markdown fence at start', () => {
        expect(validateSpecShape('```sh\nGOAL\n…')).toBe('spec starts with a markdown fence')
    })

    test('reports cat heredoc at start', () => {
        expect(validateSpecShape('cat << \'EOF\' > spec.md\nGOAL\n')).toBe(
            'spec is wrapped in a cat heredoc'
        )
    })

    test('reports missing GOAL', () => {
        expect(validateSpecShape('CONSTRAINTS\n…')).toBe('spec does not start with GOAL')
    })

    test('reports missing CONSTRAINTS', () => {
        const s = 'GOAL\nx\nACCEPTANCE\n- z\nVERIFY:\n```sh\nls\n```'
        expect(validateSpecShape(s)).toBe('spec missing required section: CONSTRAINTS')
    })

    test('reports missing VERIFY', () => {
        const s = 'GOAL\nx\nCONSTRAINTS\n- a\nACCEPTANCE\n- z'
        expect(validateSpecShape(s)).toBe('spec missing required section: VERIFY')
    })

    test('passes when a legacy PLAN-OF-ATTACK section is also present', () => {
        const s =
            'GOAL\nx\nCONSTRAINTS\n- a\nPLAN-OF-ATTACK\nstrategy\nACCEPTANCE\n- z\nVERIFY:\n```sh\nls\n```'
        expect(validateSpecShape(s)).toBeNull()
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

    test('truncates with ellipsis when over 120 chars', () => {
        const long = 'x'.repeat(200)
        const title = deriveTitle(`GOAL\n${long}`)
        expect(title.length).toBe(120)
        expect(title.endsWith('…')).toBe(true)
    })

    test('falls back to first non-empty line when no GOAL section', () => {
        expect(deriveTitle('Just a sentence.\nMore.')).toBe('Just a sentence.')
    })

    test('stops at CONSTRAINTS if GOAL paragraph is empty', () => {
        expect(deriveTitle('GOAL\n\nCONSTRAINTS\n- y')).toBe('CONSTRAINTS')
    })
})
