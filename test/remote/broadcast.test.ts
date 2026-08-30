import {describe, it, expect, beforeEach} from 'bun:test'
import {addClient, removeClient, broadcast, sendTo} from '../../src/remote/broadcast.js'

function mockWs(open = true) {
    const sent: string[] = []
    const ws = {
        // The installed `ws` numbers its states CONNECTING 0, OPEN 1, CLOSING 2,
        // CLOSED 3, so these two are the real values a live socket reports.
        readyState: open ? 1 : 3,
        OPEN: 1,
        send(data: string) {
            sent.push(data)
        }
    } as unknown as import('ws').WebSocket
    return {ws, sent}
}

describe('broadcast', () => {
    beforeEach(() => {
        // Deliberately empty. The client Set lives on globalThis and survives
        // between tests, so each test adds its own client and removes it again
        // rather than relying on a reset here.
    })

    it('broadcast sends JSON to open clients', () => {
        const {ws, sent} = mockWs(true)
        addClient(ws)
        broadcast({type: 'test', value: 42})
        expect(sent).toEqual(['{"type":"test","value":42}'])
        removeClient(ws)
    })

    it('broadcast skips closed clients', () => {
        const {ws, sent} = mockWs(false)
        addClient(ws)
        broadcast({type: 'test'})
        expect(sent).toEqual([])
        removeClient(ws)
    })

    it('sendTo sends JSON to a single open client', () => {
        const {ws, sent} = mockWs(true)
        sendTo(ws, {type: 'hello'})
        expect(sent).toEqual(['{"type":"hello"}'])
    })

    it('sendTo skips closed client', () => {
        const {ws, sent} = mockWs(false)
        sendTo(ws, {type: 'hello'})
        expect(sent).toEqual([])
    })
})
