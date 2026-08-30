import {expect, test} from 'bun:test'
import {AUTO_CLARIFY_PROMPT, AUTO_DECOMPOSE_PROMPT} from '../../src/task/auto-prompts.js'

test('clarify prompt embeds the feature, asks for ONE question + SUGGESTED + NONE', () => {
    const p = AUTO_CLARIFY_PROMPT('add billing', '')
    expect(p).toContain('add billing')
    expect(p).toContain('clarifying question')
    expect(p).toMatch(/single numbered line/i)
    // SUGGESTED_LINE_RE is /^\s*SUGGESTED:\s*(.*)$/i and attaches the value to
    // the question above it, so the prompt has to ask for that exact token.
    expect(p).toContain('SUGGESTED:')
    // parseClarifyList returns [] on /^\s*NONE\s*$/m — the only way the loop ends.
    expect(p).toContain('NONE')
    // The placeholder the prior-Q&A slot carries on the first call.
    expect(p).toContain('(none yet)')
})

test('clarify prompt carries the prior Q&A so the next question can adapt', () => {
    const p = AUTO_CLARIFY_PROMPT('build a frontend', 'Q1: SSR or SPA?\nA1: React SPA')
    expect(p).toContain('ANSWERS SO FAR:')
    expect(p).toContain('A1: React SPA')
    expect(p).not.toContain('(none yet)')
})

test('clarify prompt forbids presenting a structure-lock as settling the whole spec (goal E belt)', () => {
    const p = AUTO_CLARIFY_PROMPT('implement @spec.md', '')
    expect(p).toContain('locks the task breakdown to ONE part or structure')
    expect(p).toContain('state how each is carried')
})

test('decompose prompt embeds feature + clarifications and demands a checkbox list', () => {
    const p = AUTO_DECOMPOSE_PROMPT('add billing', 'Q1: store?\nA1: redis')
    expect(p).toContain('add billing')
    expect(p).toContain('A1: redis')
    // parseDecomposeList also accepts '- ', '1.' and '1)', but the prompt asks
    // for the checkbox form because the plan file is written in it.
    expect(p).toMatch(/- \[ \]/)
    expect(p).not.toContain('clarifying questions')
})
