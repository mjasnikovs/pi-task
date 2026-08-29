/**
 * /task-plan's two prompt builders.
 *
 * The interesting assertion is not "the string contains the word question" —
 * it is that the FORMAT the prompt teaches is the format {@link parseClarifyList}
 * reads. The examples embedded in the prompt are parsed here with the real
 * parser, so an example that drifts out of the contract fails this file rather
 * than silently producing an unparseable question at runtime.
 */

import {describe, expect, test} from 'bun:test'
import {parseClarifyList} from '../../src/task/parsers.js'
import {PLAN_ANSWER_PROMPT, PLAN_QUESTION_PROMPT} from '../../src/task/plan-prompts.js'

/** The blank-line-separated blocks of the prompt's own EXAMPLES section. */
function exampleBlocks(prompt: string): string[] {
    const tail = prompt.slice(prompt.indexOf('EXAMPLES'))
    return tail
        .split('\n\n')
        .map(b => b.trim())
        .filter(b => /^\d+\.\s/m.test(b) || /^NONE$/m.test(b))
}

describe('PLAN_QUESTION_PROMPT', () => {
    test('embeds the task and the prior decisions verbatim', () => {
        const p = PLAN_QUESTION_PROMPT(
            '  add a retry to the http client  ',
            '  Q1: where?\nA1: wrapper  '
        )
        expect(p).toContain('add a retry to the http client')
        expect(p).toContain('DECISIONS SO FAR:\nQ1: where?\nA1: wrapper')
        expect(p).not.toContain('(none yet)')
    })

    test('falls back to (none yet) when nothing has been decided', () => {
        expect(PLAN_QUESTION_PROMPT('add billing', '')).toContain('DECISIONS SO FAR:\n(none yet)')
        expect(PLAN_QUESTION_PROMPT('add billing', '   \n  ')).toContain('(none yet)')
    })

    test('trims the task so a pasted block does not open with blank lines', () => {
        expect(PLAN_QUESTION_PROMPT('\n\n  ship it  \n\n', '')).toContain('TASK:\nship it\n')
    })

    test('demands the three tokens parseClarifyList reads', () => {
        const p = PLAN_QUESTION_PROMPT('add billing', '')
        expect(p).toMatch(/single numbered line/i)
        expect(p).toContain('SUGGESTED: ')
        expect(p).toContain('ALT: ')
        expect(p).toContain('NONE')
    })

    test('rules out the split/sequence questions that belong to /task-auto', () => {
        const p = PLAN_QUESTION_PROMPT('add billing', '')
        expect(p).toContain('ONE task, implemented in ONE run')
        expect(p).toMatch(/Do NOT ask how the work should be\s+split/)
    })

    test('forbids a SUGGESTED that defers back to the user', () => {
        const p = PLAN_QUESTION_PROMPT('add billing', '')
        expect(p).toContain('The SUGGESTED must DECIDE')
        expect(p).toMatch(/never recommend waiting, deferring/)
    })

    test('its own examples parse with the real parser', () => {
        const blocks = exampleBlocks(PLAN_QUESTION_PROMPT('add billing', ''))
        expect(blocks).toHaveLength(3)

        const open = parseClarifyList(blocks[0])
        expect(open).toHaveLength(1)
        expect(open[0].question).toContain('Which existing callers must keep working unchanged?')
        expect(open[0].suggested).toBeTruthy()
        expect(open[0].alt).toBeUndefined()

        const fork = parseClarifyList(blocks[1])
        expect(fork).toHaveLength(1)
        expect(fork[0].suggested).toContain('client wrapper')
        expect(fork[0].alt).toContain('each call site')

        expect(parseClarifyList(blocks[2])).toEqual([])
    })
})

describe('PLAN_ANSWER_PROMPT', () => {
    test('embeds task, decisions and the user question', () => {
        const p = PLAN_ANSWER_PROMPT(
            'add billing',
            'Q1: store?\nA1: redis',
            '  which file owns retries?  '
        )
        expect(p).toContain('add billing')
        expect(p).toContain('A1: redis')
        expect(p).toContain("THE USER'S QUESTION:\nwhich file owns retries?")
    })

    test('falls back to (none yet) with no decisions yet', () => {
        const p = PLAN_ANSWER_PROMPT('add billing', '', 'where do I start?')
        expect(p).toContain('DECISIONS SO FAR:\n(none yet)')
    })

    test('carries the abstention rule — a planning answer may say it could not confirm', () => {
        const p = PLAN_ANSWER_PROMPT('add billing', '', 'does the repo have a retry helper?')
        expect(p).toContain(
            'Name only files, symbols, commands, and options you have VERIFIED exist'
        )
        expect(p).toContain('"I could not confirm X" is a correct answer here')
    })

    test('bounds the reply and bans code fences', () => {
        const p = PLAN_ANSWER_PROMPT('add billing', '', 'why?')
        expect(p).toContain('at most 8 short lines')
        expect(p).toContain('no code fences')
    })

    test('does not carry the question-generator format tokens', () => {
        const p = PLAN_ANSWER_PROMPT('add billing', '', 'why?')
        expect(p).not.toContain('SUGGESTED:')
        expect(p).not.toContain('ALT:')
    })
})
