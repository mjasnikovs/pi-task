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
        expect(buf.getEntries()).toEqual([{role: 'user', text: 'hello', tools: []}])
    })

    it('addAssistantTurn appends an assistant Turn', () => {
        const buf = new HistoryBuffer()
        const tools = [
            {toolName: 'bash', args: {command: 'ls'}, result: 'file.txt', isError: false}
        ]
        buf.addAssistantTurn('done', tools)
        expect(buf.getEntries()).toEqual([{role: 'assistant', text: 'done', tools}])
    })

    it('addError appends an assistant Turn flagged as error', () => {
        const buf = new HistoryBuffer()
        buf.addError('Connection error.')
        expect(buf.getEntries()).toEqual([
            {role: 'assistant', text: 'Connection error.', tools: [], error: true}
        ])
    })

    it('respects limit: evicts oldest entry', () => {
        const buf = new HistoryBuffer(3)
        buf.addUserMessage('a')
        buf.addAssistantTurn('b', [])
        buf.addUserMessage('c')
        buf.addUserMessage('d') // evicts "a"
        const entries = buf.getEntries()
        expect(entries.length).toBe(3)
        expect(entries[0].text).toBe('b')
        expect(entries[2].text).toBe('d')
    })

    it('getEntries returns a copy, not the internal array', () => {
        const buf = new HistoryBuffer()
        buf.addUserMessage('test')
        const entries = buf.getEntries()
        entries.push({role: 'user', text: 'injected', tools: []})
        expect(buf.getEntries().length).toBe(1)
    })
})
