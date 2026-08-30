import {describe, expect, test} from 'bun:test'
import {
    parseVerifyBlock,
    parseVerifyBlockStrict,
    isCritiqueClean,
    stripSpecPreamble,
    validateSpecShape,
    validateRefineShape
} from '../../src/task/spec-validation.js'

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

    test('an UNCLOSED fence swallows the rest of the file — strict rejects it', () => {
        // An unclosed fence has no end, so every later line — a timings table, an
        // appended trail — parses as a "command". Harmless for "is anything
        // runnable here"; accept-debt.ts pulls a command out of this list and
        // stores it, so it calls the strict form.
        const runaway = 'VERIFY:\n```sh\nnpm test\n\n## phase timings\nrefine 22.2s\n'
        expect(parseVerifyBlock(runaway)!.map(c => c.raw)).toEqual(['npm test', 'refine 22.2s'])
        expect(parseVerifyBlockStrict(runaway)).toBeNull()
    })

    test('strict returns the same commands when the fence IS closed', () => {
        const spec = 'VERIFY:\n```sh\nnpm test\n```\n\n## trail\nanything at all\n'
        expect(parseVerifyBlockStrict(spec)!.map(c => c.raw)).toEqual(['npm test'])
        expect(parseVerifyBlockStrict('no header here')).toBeNull()
    })
})

describe('stripSpecPreamble', () => {
    test('drops narration before the GOAL header', () => {
        const s =
            "Now I have all the context. Here's the rewritten spec:\n\nGOAL\n  do x\nVERIFY:\n```sh\nls\n```"
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
        const s = "cat << 'EOF' > spec.md\nGOAL\n…"
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
        expect(validateSpecShape("cat << 'EOF' > spec.md\nGOAL\n")).toBe(
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

describe('validateRefineShape', () => {
    const FOUR =
        'GOAL\nDo the thing.\n\nCONSTRAINTS\n- keep x\n\n'
        + 'KNOWN-UNKNOWNS\n- which y\n\nEXTERNAL-DEPENDENCIES\n- Twitch  twitch helix api'

    test('accepts the four bare headings', () => {
        expect(validateRefineShape(FOUR)).toBeNull()
    })

    test('accepts a preamble before GOAL — 31/56 of the real corpus has one', () => {
        expect(validateRefineShape('Here is the rewritten task.\n\n' + FOUR)).toBeNull()
    })

    test('accepts an EXTERNAL-DEPENDENCIES section with zero bullets, as the prompt allows', () => {
        const s = 'GOAL\nx\nCONSTRAINTS\n- a\nKNOWN-UNKNOWNS\n- q\nEXTERNAL-DEPENDENCIES\n'
        expect(validateRefineShape(s)).toBeNull()
    })

    test('reports an empty answer', () => {
        expect(validateRefineShape('   \n')).toBe('refined prompt is empty')
    })

    test('reports one missing section', () => {
        const s = 'GOAL\nx\nCONSTRAINTS\n- a\nEXTERNAL-DEPENDENCIES\n- Twitch  helix'
        expect(validateRefineShape(s)).toBe(
            'refined prompt missing required section(s): KNOWN-UNKNOWNS'
        )
    })

    test('reports every missing section at once', () => {
        expect(validateRefineShape('GOAL\njust a paragraph')).toBe(
            'refined prompt missing required section(s):'
                + ' CONSTRAINTS, KNOWN-UNKNOWNS, EXTERNAL-DEPENDENCIES'
        )
    })

    test('rejects a heading that is not alone on its line — the consumers need it bare', () => {
        // extractCapsSection compares `l.trim() === heading`, so `## GOAL` and
        // `GOAL: do the thing` are both invisible to it.
        const s = '## GOAL\nx\nCONSTRAINTS\n- a\nKNOWN-UNKNOWNS\n- q\nEXTERNAL-DEPENDENCIES\n'
        expect(validateRefineShape(s)).toBe('refined prompt missing required section(s): GOAL')
    })

    test('is not fooled by the heading word appearing in prose', () => {
        const s =
            'GOAL\nRecord the CONSTRAINTS and KNOWN-UNKNOWNS somewhere.\nEXTERNAL-DEPENDENCIES\n'
        expect(validateRefineShape(s)).toBe(
            'refined prompt missing required section(s): CONSTRAINTS, KNOWN-UNKNOWNS'
        )
    })
})
