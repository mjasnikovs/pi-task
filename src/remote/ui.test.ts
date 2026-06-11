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
        expect(out).toContain('case \'context\'')
        expect(out).toContain('prompt_answer')
        expect(out).toContain('id="prompt-card"')
        expect(out).toContain('id="status-panel"')
    })

    it('renders a notification bell toggle in the header', () => {
        const out = html('ws://localhost:7600/ws')
        expect(out).toContain('id="bell"')
        expect(out).toContain('piRemoteNotify')
    })

    it('guards enabling notifications on permission and secure context', () => {
        const out = html('ws://localhost:7600/ws')
        expect(out).toContain('Notification.permission')
        expect(out).toContain('window.isSecureContext')
    })

    it('registers a service worker and a push subscription (works on iOS)', () => {
        const out = html('ws://localhost:7600/ws')
        expect(out).toContain('serviceWorker.register(\'/sw.js\')')
        expect(out).toContain('pushManager.subscribe')
        expect(out).toContain('/push-key')
        expect(out).toContain('/subscribe')
        // The broken in-page constructor must NOT be used to deliver notifications.
        expect(out).not.toContain('new Notification(')
    })

    it('warns iOS users to add to Home Screen', () => {
        const out = html('ws://localhost:7600/ws')
        expect(out).toContain('Add to Home Screen')
    })

    it('shows a live countdown on the reconnect overlay', () => {
        const out = html('ws://localhost:7600/ws')
        expect(out).toContain('id="reconnect-msg"')
        expect(out).toContain('retrying in')
    })

    it('clears the remote view on a reset message (new session)', () => {
        const out = html('ws://localhost:7600/ws')
        expect(out).toContain('case \'reset\'')
    })

    it('reconciles a full snapshot on (re)connect by replacing the whole view', () => {
        const out = html('ws://localhost:7600/ws')
        // The snapshot handler is the heart of the sync rebuild: it must wipe the
        // transcript and rebuild from server truth so reconnects never duplicate or
        // strand stale content.
        const m = out.match(/case 'snapshot':[\s\S]*?break;/)
        expect(m).not.toBeNull()
        const handler = m![0]
        expect(handler).toContain('chatLog.innerHTML = \'\'')
        expect(handler).toContain('renderTurn')
        expect(handler).toContain('renderLiveTurn')
        expect(handler).toContain('renderWidgets()')
    })

    it('uses a single task-widget slot, not a per-key map', () => {
        const out = html('ws://localhost:7600/ws')
        // One slot means a cleared widget always disappears; a per-key map could
        // strand an orphan (the old two-/task-widget bug).
        expect(out).toContain('taskWidgetLines')
        expect(out).not.toContain('widgets[msg.key]')
        expect(out).not.toContain('delete widgets[')
        // The widget delta no longer carries a key.
        const m = out.match(/case 'widget':[\s\S]*?break;/)
        expect(m).not.toBeNull()
        expect(m![0]).not.toContain('msg.key')
    })

    it('no longer ships a separate history replay (snapshot subsumes it)', () => {
        const out = html('ws://localhost:7600/ws')
        expect(out).not.toContain('case \'history\'')
    })

    it('renders an assistant turn as ordered parts (text + tools interleaved)', () => {
        const out = html('ws://localhost:7600/ws')
        // A turn must render its `parts` in sequence so the layout matches the
        // terminal — not one merged text blob with tools dumped at the end.
        const m = out.match(/function renderTurn\(t\) \{[\s\S]*?\n {4}\}/)
        expect(m).not.toBeNull()
        const body = m![0]
        expect(body).toContain('t.parts')
        expect(body).toContain("p.kind === 'text'")
        expect(body).toContain('renderToolPart')
        // The old flat-tools rendering is gone.
        expect(out).not.toContain('for (const tool of (t.tools')
    })

    it('renders tool results null-safely so a missing result cannot blank the view', () => {
        const out = html('ws://localhost:7600/ws')
        // A null/undefined result must not reach `JSON.stringify(...).slice()`, whose
        // `undefined.slice` throws and aborts the snapshot rebuild mid-clear.
        expect(out).toContain('function toolResultText')
        expect(out).toContain('result == null')
        // The unguarded pattern must be gone from both the snapshot and the live path.
        expect(out).not.toContain('JSON.stringify(tool.result, null, 2)')
        expect(out).not.toContain('JSON.stringify(msg.result, null, 2)')
        // The snapshot rebuild must guard each turn so one bad turn can't blank all.
        const m = out.match(/case 'snapshot':[\s\S]*?break;/)
        expect(m![0]).toContain('try { renderTurn(t)')
    })

    it('keeps long toast messages readable on narrow phone screens', () => {
        const out = html('ws://localhost:7600/ws')
        const m = out.match(/\.toast \{([^}]*)\}/)
        expect(m).not.toBeNull()
        const rule = m![1]
        // Without a width cap + wrapping, a long error toast (pinned right) runs
        // off the left edge of a phone screen and is unreadable.
        expect(rule).toContain('max-width')
        expect(rule).toMatch(/overflow-wrap|word-break/)
    })

    it('keeps the toast below the iOS status bar (safe-area inset)', () => {
        const out = html('ws://localhost:7600/ws')
        const m = out.match(/\.toast \{([^}]*)\}/)
        expect(m).not.toBeNull()
        // viewport-fit=cover makes a position:fixed toast ignore body padding and
        // render up under the notch/battery/wifi icons unless it adds the inset.
        expect(m![1]).toContain('env(safe-area-inset-top')
    })

    it('gives the header title a small Catppuccin glitch animation', () => {
        const out = html('ws://localhost:7600/ws')
        expect(out).toContain('@keyframes glitch')
        const m = out.match(/#header \.title \{([^}]*)\}/)
        expect(m).not.toBeNull()
        expect(m![1]).toContain('animation')
    })

    it('uses monochrome terminal glyphs (not emoji) for the bell toggle', () => {
        const out = html('ws://localhost:7600/ws')
        expect(out).not.toContain('1F514') // 🔔
        expect(out).not.toContain('1F515') // 🔕
        expect(out).not.toContain('🔔')
        expect(out).not.toContain('🔕')
        expect(out).toContain('25C9') // ◉ notifications on
        expect(out).toContain('25EF') // ◯ notifications off
    })

    it('renders a colored connection-status dot with no text label', () => {
        const out = html('ws://localhost:7600/ws')
        expect(out).toContain('id="conn-dot"')
        expect(out).not.toContain('id="client-label"')
        expect(out).not.toContain('client connected')
        expect(out).not.toContain('clients connected')
        expect(out).toContain('25CF') // ● connected / disconnected
        expect(out).toContain('25CB') // ○ connecting
    })

    it('uses a terminal braille spinner (not bouncing dots) for the thinking indicator', () => {
        const out = html('ws://localhost:7600/ws')
        expect(out).toContain('class="spinner spin"')
        expect(out).not.toContain('thinking-bounce')
        expect(out).toContain('280B') // a braille spinner frame
    })

    it('uses the braille spinner for the stream cursor, not a green blinking block', () => {
        const out = html('ws://localhost:7600/ws')
        // The trailing stream cursor must share the spinner ('.spin') so it animates
        // as a braille glyph, not a green blinking square.
        expect(out).toContain('cursor.className = \'cursor spin\'')
        const m = out.match(/\.cursor \{([^}]*)\}/)
        expect(m).not.toBeNull()
        const rule = m![1]
        expect(rule).not.toContain('var(--green)')
        expect(rule).not.toContain('animation')
        // The old blink keyframes are gone.
        expect(out).not.toContain('@keyframes blink')
    })

    it('anchors the input bar to the bottom safe-area so there is no gap', () => {
        const out = html('ws://localhost:7600/ws')
        const m = out.match(/#input-bar \{([^}]*)\}/)
        expect(m).not.toBeNull()
        expect(m![1]).toContain('env(safe-area-inset-bottom')
    })

    it('wraps long tool-call summaries so they stay inside the box', () => {
        const out = html('ws://localhost:7600/ws')
        const m = out.match(/\.tool-call summary \{([^}]*)\}/)
        expect(m).not.toBeNull()
        expect(m![1]).toMatch(/overflow-wrap|word-break/)
    })
})
