import {describe, it, expect} from 'bun:test'
import {HistoryBuffer} from './history.js'

describe('HistoryBuffer', () => {
    it('starts empty', () => {
        const buf = new HistoryBuffer()
        expect(buf.getEntries()).toEqual([])
    })

    it('addUserMessage appends a user Turn', () => {
        const buf = new HistoryBuffer()
        buf.addUserMessage('hello')
        expect(buf.getEntries()).toEqual([{role: 'user', text: 'hello', ts: expect.any(Number)}])
    })

    it('addAssistantTurn appends an assistant Turn with ordered parts', () => {
        const buf = new HistoryBuffer()
        const parts = [
            {kind: 'text' as const, text: 'let me check'},
            {
                kind: 'tool' as const,
                toolCallId: 't1',
                toolName: 'bash',
                args: {command: 'ls'},
                result: 'file.txt',
                isError: false,
                done: true
            },
            {kind: 'text' as const, text: 'done'}
        ]
        buf.addAssistantTurn(parts)
        expect(buf.getEntries()).toEqual([{role: 'assistant', parts, ts: expect.any(Number)}])
    })

    it('addSystemNote appends a system Turn', () => {
        const buf = new HistoryBuffer()
        buf.addSystemNote('Context compacted')
        expect(buf.getEntries()).toEqual([
            {role: 'system', text: 'Context compacted', ts: expect.any(Number)}
        ])
    })

    it('addError appends an assistant Turn flagged as error', () => {
        const buf = new HistoryBuffer()
        buf.addError('Connection error.')
        expect(buf.getEntries()).toEqual([
            {role: 'assistant', text: 'Connection error.', error: true, ts: expect.any(Number)}
        ])
    })

    it('respects limit: evicts oldest entry', () => {
        const buf = new HistoryBuffer(3)
        buf.addUserMessage('a')
        buf.addAssistantTurn([{kind: 'text', text: 'b'}])
        buf.addUserMessage('c')
        buf.addUserMessage('d') // evicts "a"
        const entries = buf.getEntries()
        expect(entries.length).toBe(3)
        expect(entries[0].parts?.[0]).toEqual({kind: 'text', text: 'b'})
        expect(entries[2].text).toBe('d')
    })

    it('getEntries returns a copy, not the internal array', () => {
        const buf = new HistoryBuffer()
        buf.addUserMessage('test')
        const entries = buf.getEntries()
        entries.push({role: 'user', text: 'injected'})
        expect(buf.getEntries().length).toBe(1)
    })
})
