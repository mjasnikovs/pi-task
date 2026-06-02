import {describe, expect, test} from 'bun:test'
import {
    parseVerifyBlock,
    parseGrillQuestions,
    parseAutoAnswer,
    validateSpecShape,
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
