// Screenshot preview harness for the remote web client (src/remote/).
//
// Renders the REAL generated client HTML in headless Chromium against a fake
// WebSocket that replays a rich fixture snapshot — so we can eyeball (and DOM-
// grep) markdown, code fences, tool cards, the prompt card, and the desktop
// column without a running server. This is the acceptance instrument for every
// phase of REMOTE-IMPROVEMENT-PLAN.md.
//
// Usage:
//   bun scripts/remote-preview.ts                 # all modes, both sizes
//   bun scripts/remote-preview.ts --mode=default  # one mode
//   bun scripts/remote-preview.ts --dump-dom      # also write .html DOM dumps
//
// Screenshots + DOM dumps land in /tmp/pi-remote-preview.*.  A screenshot alone
// hid the shipped fence bug behind "looks like text" — always grep the DOM dump
// for `.code-block` presence, not just the pixels.

import {execFileSync} from 'node:child_process'
import {writeFileSync} from 'node:fs'
import {html} from '../src/remote/ui.js'

const CHROMIUM = process.env.CHROMIUM_BIN || '/usr/bin/chromium'
const OUT_HTML = '/tmp/pi-remote-preview.html'

// ─── Fixture: a rich snapshot exercising every renderer ──────────────────────
// Markdown-heavy assistant text (bold, list, link, pipe table) + fenced code in
// tsx, python, and shell, interleaved with tool parts exactly as a real turn is.
const MD = [
    '## Theme system',
    '',
    'The palette is **Catppuccin Mocha**, wired through `:root` vars. Key points:',
    '',
    '- Colors are *never* hard-coded in components.',
    '- See the [Catppuccin docs](https://catppuccin.com) for the ramp.',
    '- [ ] migrate the last `#hex` literal',
    '- [x] centralize the ramp',
    '',
    '| token | hex | role |',
    '| --- | --- | --- |',
    '| base | #1e1e2e | background |',
    '| mauve | #cba6f7 | accent |',
    '',
    '> Keep new CSS to the existing vars.',
    '',
    'A tsx snippet:',
    '',
    '```tsx',
    'export function Swatch({name}: {name: string}) {',
    '  // pull the CSS var by name',
    '  const v = `var(--${name})`',
    '  return <div style={{background: v}}>{name}</div>',
    '}',
    '```',
    '',
    'The generator in python:',
    '',
    '```python',
    'def ramp(base: str, n: int = 5) -> list[str]:',
    '    """Return n tints of base."""',
    '    return [mix(base, i / n) for i in range(n)]',
    '```',
    '',
    'And the build step:',
    '',
    '```sh',
    'bun run build && echo "themed ✓"',
    '```'
].join('\n')

const snapshot = {
    type: 'snapshot',
    turns: [
        {role: 'user', text: 'Show me the theme code and run the tests.'},
        {
            role: 'assistant',
            parts: [
                {
                    kind: 'thinking',
                    text: 'The user wants the theme code and a test run.\nLet me read the styles first, then run the theme suite.\nIf a test fails I will patch the ramp helper and re-check.',
                    done: true
                },
                {kind: 'text', text: MD},
                {
                    kind: 'tool',
                    toolCallId: 't1',
                    toolName: 'read',
                    args: {path: 'src/remote/ui-styles.ts'},
                    result: {content: [{type: 'text', text: ':root {\n  --base: #1e1e2e;\n  --mauve: #cba6f7;\n}'}]},
                    isError: false,
                    done: true,
                    elapsedMs: 120
                },
                {kind: 'text', text: 'Now running the theme tests:'},
                {
                    kind: 'tool',
                    toolCallId: 't2',
                    toolName: 'bash',
                    args: {command: 'bun test src/theme --coverage --reporter=verbose --bail'},
                    result: {content: [{type: 'text', text: 'error: 2 tests failed\n  ✗ ramp() returns n tints\n  ✗ no hex literals in components'}]},
                    isError: true,
                    done: true,
                    elapsedMs: 8400
                },
                {kind: 'text', text: 'Two failures — patching the ramp helper:'},
                {
                    kind: 'tool',
                    toolCallId: 't3',
                    toolName: 'edit',
                    args: {
                        path: 'src/theme/ramp.ts',
                        old_string: 'return [mix(base, i) for i in range(n)]',
                        new_string: 'return [mix(base, i / n) for i in range(n)]'
                    },
                    result: {content: [{type: 'text', text: 'Applied 1 edit to src/theme/ramp.ts'}]},
                    isError: false,
                    done: true,
                    elapsedMs: 340
                }
            ]
        },
        {role: 'system', text: 'Context compacted'},
        {role: 'assistant', text: 'Model error: connection reset while streaming the summary.', error: true}
    ],
    live: null,
    agentRunning: false,
    taskWidget: ['TASK_0003 · auth routes', 'phase 4/8 refine · 2:14'],
    taskWidgetData: {
        title: 'TASK_0003 · auth routes',
        phase: 'refine',
        done: 4,
        total: 8,
        elapsed: '2:14'
    },
    prompt: null,
    context: {percent: 62, tokens: 81000, contextWindow: 131072},
    model: 'Qwen3.6 27B'
}

// Stamp the committed turns so the client renders dim HH:MM timestamps.
{
    let t = Date.now() - 6 * 60 * 1000
    for (const turn of snapshot.turns as {ts?: number}[]) {
        turn.ts = t
        t += 90 * 1000
    }
}

const promptMsg = {
    type: 'prompt',
    id: 'p1',
    question: 'The design pins Hono on the Bun adapter. Keep the page/offset pagination contract, or switch to cursor pagination as some routes hint?',
    recommended: 'Keep page/offset — it is the documented contract in the spec.',
    recommended2: 'Switch to cursor pagination for the feed routes only.',
    allowSkip: true
}

// ─── Fake WebSocket stub, spliced in BEFORE the real client script ───────────
const stub = `  <script>
    (function () {
      class FakeWS extends EventTarget {
        constructor(url) {
          super();
          this.url = url;
          this.readyState = 1;
          window.__ws = this;
          setTimeout(() => { this.dispatchEvent(new Event('open')); }, 0);
        }
        send() {}
        close() {}
      }
      FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;
      window.WebSocket = FakeWS;
      window.__push = function (m) {
        if (window.__ws) window.__ws.dispatchEvent(new MessageEvent('message', {data: JSON.stringify(m)}));
      };
      const SNAPSHOT = ${JSON.stringify(snapshot)};
      const PROMPT = ${JSON.stringify(promptMsg)};
      window.addEventListener('load', function () {
        window.__push(SNAPSHOT);
        if (location.hash === '#prompt') window.__push(PROMPT);
        if (location.hash === '#live') {
          window.__push({type: 'agent_start'});
          window.__push({type: 'text_delta', delta: 'Streaming a **live** reply with a fence:\\n\\n\`\`\`ts\\nconst x = 1;\\n\`\`\`'});
        }
        // #think: agent running with a live thinking block streaming (Stop button
        // visible, collapsed "✻ Thinking…" bubble with its spinner).
        if (location.hash === '#think') {
          window.__push({type: 'agent_start'});
          window.__push({type: 'thinking_delta', delta: 'Let me reason about the theme system.\\n'});
          window.__push({type: 'thinking_delta', delta: 'It reads CSS vars off :root and never hard-codes hex.\\n'});
          window.__push({type: 'thinking_delta', delta: 'So the ramp helper must mix by name — I will verify that next.'});
        }
        // #notif seeds a few toasts into history and opens the bell dropdown.
        if (location.hash === '#notif') {
          window.__push({type: 'notify', message: 'Task 3/8 started — auth-routes', level: 'info'});
          window.__push({type: 'notify', message: 'Context full — compacting…', level: 'warning'});
          window.__push({type: 'notify', message: '/task-auto failed: lint errors', level: 'error'});
          setTimeout(function () { var b = document.getElementById('bell'); if (b) b.click(); }, 60);
        }
        // #open expands every tool card so the diff body is visible in the shot.
        if (location.hash === '#open') {
          setTimeout(function () {
            var ds = document.querySelectorAll('details.tool-call, details.thinking-block');
            for (var i = 0; i < ds.length; i++) ds[i].open = true;
          }, 50);
        }
      });
    })();
  </script>
  <script>`

function buildHtml(): string {
    const page = html('ws://127.0.0.1:8800/ws')
    if (!page.includes('  <script>')) throw new Error('splice anchor "  <script>" not found in ui.ts output')
    // Only the FIRST occurrence (the main client script's opening tag).
    return page.replace('  <script>', stub)
}

interface Shot {
    mode: string
    hash: string
    size: string
}

const SHOTS: Shot[] = [
    {mode: 'default', hash: '', size: '390,844'},
    {mode: 'tall', hash: '', size: '430,2400'},
    {mode: 'default-wide', hash: '', size: '1280,800'},
    {mode: 'open', hash: '#open', size: '430,2400'},
    {mode: 'prompt', hash: '#prompt', size: '390,844'},
    {mode: 'live', hash: '#live', size: '390,844'},
    {mode: 'think', hash: '#think', size: '390,844'},
    {mode: 'notif', hash: '#notif', size: '390,844'}
]

function shoot(shot: Shot, dumpDom: boolean): void {
    const out = `/tmp/pi-remote-preview.${shot.mode}.png`
    const url = `file://${OUT_HTML}${shot.hash}`
    execFileSync(
        CHROMIUM,
        [
            '--headless',
            '--disable-gpu',
            '--hide-scrollbars',
            `--window-size=${shot.size}`,
            '--virtual-time-budget=3000',
            `--screenshot=${out}`,
            url
        ],
        {stdio: 'inherit'}
    )
    console.log(`  screenshot → ${out}  (${shot.size}${shot.hash})`)
    if (dumpDom) {
        const domFile = `/tmp/pi-remote-preview.${shot.mode}.html`
        const dom = execFileSync(
            CHROMIUM,
            ['--headless', '--disable-gpu', '--virtual-time-budget=3000', '--dump-dom', url],
            {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024}
        )
        writeFileSync(domFile, dom)
        const codeBlocks = (dom.match(/class="code-block"/g) || []).length
        console.log(`  dom       → ${domFile}  (.code-block count: ${codeBlocks})`)
    }
}

function main(): void {
    const args = process.argv.slice(2)
    const dumpDom = args.includes('--dump-dom')
    const modeArg = args.find((a) => a.startsWith('--mode='))?.slice('--mode='.length)
    writeFileSync(OUT_HTML, buildHtml())
    console.log(`page → ${OUT_HTML}`)
    const shots = modeArg ? SHOTS.filter((s) => s.mode === modeArg) : SHOTS
    if (shots.length === 0) throw new Error(`no shot matches --mode=${modeArg} (have: ${SHOTS.map((s) => s.mode).join(', ')})`)
    for (const s of shots) shoot(s, dumpDom)
}

main()
