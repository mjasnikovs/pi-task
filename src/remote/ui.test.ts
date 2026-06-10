import {describe, it, expect} from 'bun:test'
import {html} from './ui.js'

describe('html()', () => {
    it('returns a string', () => {
        expect(typeof html('ws://localhost:7600/ws')).toBe('string')
    })

    it('embeds the wsUrl as a fallback in the output', () => {
        const out = html('ws://192.168.1.5:7601/ws')
        expect(out).toContain('ws://192.168.1.5:7601/ws')
    })

    it('derives the WebSocket URL from the page origin so LAN and Tailscale URLs both connect', () => {
        const out = html('ws://192.168.1.5:7601/ws')
        // WS must follow whatever host served the page, not a baked-in IP.
        expect(out).toContain('location.host')
        expect(out).toContain('\'wss://\'')
        expect(out).toContain('\'ws://\'')
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

    it('emits a syntactically valid <script> (no unescaped newlines etc.)', () => {
        const out = html('ws://1.2.3.4:8800/ws')
        const m = out.match(/<script>([\s\S]*?)<\/script>/)
        expect(m).not.toBeNull()
        // A syntax error anywhere kills the whole script, leaving the client stuck
        // at "connecting…". Parsing the body catches stray literal newlines/tokens.
        expect(() => new Function(m![1])).not.toThrow()
    })

    it('contains WebSocket connect() call', () => {
        const out = html('ws://localhost:7600/ws')
        expect(out).toContain('new WebSocket(WS_URL)')
    })

    it('includes prompt card, status panel, and the new message handlers', () => {
        const out = html('ws://localhost:7600/ws')
        expect(out).toContain('case \'prompt\'')
        expect(out).toContain('case \'prompt_resolved\'')
        expect(out).toContain('case \'widget\'')
        expect(out).toContain('case \'notify\'')
        expect(out).toContain('case \'viewer\'')
        expect(out).toContain('prompt_answer')
        expect(out).toContain('id="prompt-card"')
        expect(out).toContain('id="status-panel"')
    })

    it('renders a notification bell toggle in the header', () => {
        const out = html('ws://localhost:7600/ws')
        expect(out).toContain('id="bell"')
        expect(out).toContain('piRemoteNotify')
    })

    it('guards notifications on permission, secure context, and backgrounded tab', () => {
        const out = html('ws://localhost:7600/ws')
        expect(out).toContain('Notification.permission')
        expect(out).toContain('window.isSecureContext')
        expect(out).toContain('document.hidden')
    })

    it('uses the agreed titles for the three notification events', () => {
        const out = html('ws://localhost:7600/ws')
        expect(out).toContain('pi needs your input')
        expect(out).toContain('Task finished')
        expect(out).toContain('Agent error')
    })

    it('warns iOS users to add to Home Screen', () => {
        const out = html('ws://localhost:7600/ws')
        expect(out).toContain('Add to Home Screen')
    })
})
