import {expect, test} from 'bun:test'
import {isClientMessage, type ServerMessage, type PromptMessage} from './protocol.js'

test('isClientMessage accepts a prompt_answer with string value', () => {
    expect(isClientMessage({type: 'prompt_answer', id: '1', value: 'hello'})).toBe(true)
})

test('isClientMessage accepts a prompt_answer with undefined value (cancel)', () => {
    expect(isClientMessage({type: 'prompt_answer', id: '1', value: undefined})).toBe(true)
})

test('isClientMessage accepts a plain message', () => {
    expect(isClientMessage({type: 'message', text: 'hi'})).toBe(true)
})

test('isClientMessage accepts an interrupt (browser Stop button)', () => {
    expect(isClientMessage({type: 'interrupt'})).toBe(true)
})

test('isClientMessage rejects unknown and malformed', () => {
    expect(isClientMessage({type: 'nope'})).toBe(false)
    expect(isClientMessage(null)).toBe(false)
    expect(isClientMessage({type: 'prompt_answer'})).toBe(false) // missing id
})

test('ServerMessage prompt shape is constructable', () => {
    const m: PromptMessage = {
        type: 'prompt',
        id: '7',
        question: 'Which DB?',
        recommended: 'postgres',
        allowSkip: false
    }
    const s: ServerMessage = m
    expect(s.type).toBe('prompt')
})
