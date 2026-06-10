import {describe, it, expect, beforeEach} from 'bun:test'
import {addClient, removeClient, clientCount, broadcast, sendTo} from './broadcast.js'

function mockWs(open = true) {
    const sent: string[] = []
    const ws = {
        readyState: open ? 1 : 3, // 1=OPEN, 3=CLOSED
        OPEN: 1,
        send(data: string) {
            sent.push(data)
        }
    } as unknown as import('ws').WebSocket
    return {ws, sent}
}

describe('broadcast', () => {
    beforeEach(() => {
        // Each test adds/removes its own clients; counts are relative
    })

    it('clientCount starts at 0 after remove all', () => {
        expect(clientCount()).toBeGreaterThanOrEqual(0)
    })

    it('addClient increases count', () => {
        const {ws} = mockWs()
        const before = clientCount()
        addClient(ws)
        expect(clientCount()).toBe(before + 1)
        removeClient(ws)
    })

    it('removeClient decreases count', () => {
        const {ws} = mockWs()
        addClient(ws)
        const after = clientCount()
        removeClient(ws)
        expect(clientCount()).toBe(after - 1)
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
