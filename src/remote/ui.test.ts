import {describe, it, expect} from 'bun:test'
import {html} from './ui.js'

describe('html()', () => {
    it('returns a string', () => {
        expect(typeof html('ws://localhost:7600/ws')).toBe('string')
    })

    it('embeds the wsUrl in the output', () => {
        const out = html('ws://192.168.1.5:7601/ws')
        expect(out).toContain('ws://192.168.1.5:7601/ws')
    })

    it('contains required DOM element ids', () => {
        const out = html('ws://localhost:7600/ws')
        for (const id of [
            'context-bar-fill',
            'chat-log',
            'input',
            'send',
            'reconnect-overlay',
            'client-status'
        ]) {
            expect(out).toContain(`id="${id}"`)
        }
    })

    it('contains Catppuccin Mocha base color', () => {
        const out = html('ws://localhost:7600/ws')
        expect(out).toContain('#1e1e2e')
    })

    it('contains WebSocket connect() call', () => {
        const out = html('ws://localhost:7600/ws')
        expect(out).toContain('new WebSocket(WS_URL)')
    })

    it('includes prompt card, status panel, and the new message handlers', () => {
        const out = html('ws://localhost:7600/ws')
        expect(out).toContain("case 'prompt'")
        expect(out).toContain("case 'prompt_resolved'")
        expect(out).toContain("case 'widget'")
        expect(out).toContain("case 'notify'")
        expect(out).toContain("case 'viewer'")
        expect(out).toContain('prompt_answer')
        expect(out).toContain('id="prompt-card"')
        expect(out).toContain('id="status-panel"')
    })
})
