import {expect, test} from 'bun:test'
import {AUTO_CLARIFY_PROMPT, AUTO_DECOMPOSE_PROMPT} from './auto-prompts.js'

test('clarify prompt embeds the feature and demands a numbered list + NONE', () => {
    const p = AUTO_CLARIFY_PROMPT('add billing')
    expect(p).toContain('add billing')
    expect(p).toContain('clarifying questions')
    expect(p).toMatch(/numbered list/i)
    expect(p).toContain('NONE') // matches parseGrillQuestions empty signal
})

test('decompose prompt embeds feature + clarifications and demands a checkbox list', () => {
    const p = AUTO_DECOMPOSE_PROMPT('add billing', 'Q1: store?\nA1: redis')
    expect(p).toContain('add billing')
    expect(p).toContain('A1: redis')
    expect(p).toMatch(/- \[ \]/) // checkbox format parseDecomposeList accepts
    expect(p).not.toContain('clarifying questions')
})
