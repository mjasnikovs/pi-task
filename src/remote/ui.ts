export function html(wsUrl: string): string {
    const iconSvg = encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180">`
            + `<rect width="180" height="180" rx="38" fill="#1e1e2e"/>`
            + `<text x="90" y="130" font-family="Georgia,serif" font-size="100" `
            + `text-anchor="middle" fill="#cba6f7">π</text></svg>`
    )
    const iconUrl = `data:image/svg+xml,${iconSvg}`
    const manifest = encodeURIComponent(
        JSON.stringify({
            name: 'pi-task remote',
            short_name: 'pi-task remote',
            display: 'standalone',
            background_color: '#1e1e2e',
            theme_color: '#1e1e2e',
            icons: [{src: iconUrl, sizes: 'any', type: 'image/svg+xml'}]
        })
    )
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="pi-task remote">
  <meta name="theme-color" content="#1e1e2e">
  <link rel="apple-touch-icon" href="${iconUrl}">
  <link rel="manifest" href="data:application/manifest+json,${manifest}">
  <title>pi-task remote</title>
  <style>
    :root {
      --base: #1e1e2e; --mantle: #181825; --crust: #11111b;
      --surface0: #313244; --surface1: #45475a; --surface2: #585b70;
      --text: #cdd6f4; --subtext1: #a6adc8; --subtext0: #7f849c;
      --mauve: #cba6f7; --blue: #89b4fa; --green: #a6e3a1; --red: #f38ba8;
      --yellow: #f9e2af; --peach: #fab387; --teal: #94e2d5;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--base); color: var(--text);
      font-family: ui-monospace, monospace; height: 100dvh;
      display: flex; flex-direction: column; overflow: hidden;
      padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px)
               0px env(safe-area-inset-left, 0px);
    }
    #context-bar { height: 4px; background: var(--surface0); flex-shrink: 0; }
    #context-bar-fill { height: 100%; background: var(--mauve); width: 0%; transition: width 0.4s ease; }
    #header {
      background: var(--mantle); padding: 8px 16px;
      display: flex; justify-content: space-between; align-items: center;
      font-size: 13px; flex-shrink: 0; border-bottom: 1px solid var(--surface0);
    }
    #header .title { font-weight: bold; color: var(--mauve); letter-spacing: 0.05em;
      position: relative; animation: glitch 5s steps(1) infinite; }
    @keyframes glitch {
      0%, 88%, 100% { text-shadow: none; transform: translate(0, 0); }
      90% { text-shadow: -1px 0 var(--red), 1px 0 var(--teal); transform: translate(1px, -1px); }
      92% { text-shadow: 1px 0 var(--red), -1px 0 var(--blue); transform: translate(-1px, 1px); }
      94% { text-shadow: -1px 0 var(--blue), 1px 0 var(--red); transform: translate(1px, 0); }
      96% { text-shadow: 1px 0 var(--teal), -1px 0 var(--red); transform: translate(-1px, 0); }
    }
    @media (prefers-reduced-motion: reduce) { #header .title { animation: none; } }
    #header .status { color: var(--subtext0); font-size: 11px; display: inline-flex; align-items: center; gap: 5px; }
    #header .cdot { color: var(--yellow); }
    #header .cdot.up { color: var(--green); }
    #header .cdot.down { color: var(--red); }
    #header .hgroup { display: flex; align-items: center; gap: 10px; }
    #bell {
      background: none; border: none; color: var(--subtext1); cursor: pointer;
      font-size: 15px; line-height: 1; padding: 2px; font-family: inherit;
    }
    #bell:hover { color: var(--text); }
    #bell.on { color: var(--mauve); }
    #chat-log {
      flex: 1; min-width: 0; overflow-y: auto; overflow-x: hidden; padding: 16px;
      display: flex; flex-direction: column; gap: 8px;
    }
    #chat-log::-webkit-scrollbar { width: 6px; }
    #chat-log::-webkit-scrollbar-track { background: transparent; }
    #chat-log::-webkit-scrollbar-thumb { background: var(--surface2); border-radius: 3px; }
    .bubble {
      max-width: 82%; padding: 8px 12px; border-radius: 8px;
      line-height: 1.6; white-space: pre-wrap; word-break: break-word; font-size: 13px;
    }
    .bubble.user { background: var(--surface1); color: var(--text); align-self: flex-end; }
    .bubble.assistant { background: var(--surface0); color: var(--text); align-self: flex-start; }
    .bubble.error {
      background: var(--crust); color: var(--red); align-self: stretch;
      max-width: 100%; border: 1px solid var(--red); font-size: 12px;
    }
    .bubble.thinking {
      display: flex; gap: 5px; align-items: center; padding: 10px 14px;
    }
    .bubble.thinking .spinner {
      color: var(--mauve); font-size: 15px; line-height: 1;
      font-family: ui-monospace, monospace;
    }
    .tool-call {
      background: var(--crust); border-radius: 6px; align-self: flex-start;
      max-width: 90%; font-size: 12px; border: 1px solid var(--surface0);
    }
    .tool-call summary {
      padding: 6px 10px; color: var(--subtext1); cursor: pointer;
      user-select: none; list-style: none;
      overflow-wrap: anywhere; word-break: break-word;
    }
    .tool-call summary::-webkit-details-marker { display: none; }
    .tool-call summary::before { content: "▶  "; }
    .tool-call[open] > summary::before { content: "▼  "; }
    .tool-call.error > summary { color: var(--red); }
    .tool-call pre {
      padding: 8px 12px; overflow-y: auto;
      color: var(--subtext1); font-size: 11px; max-height: 280px;
      border-top: 1px solid var(--surface0);
      white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word;
    }
    .code-block {
      background: var(--crust); border: 1px solid var(--surface0);
      border-radius: 6px; overflow: hidden; margin: 4px 0;
      align-self: stretch; max-width: 100%; font-size: 12px;
    }
    .code-lang {
      background: var(--surface0); color: var(--subtext0);
      font-size: 10px; padding: 3px 10px; letter-spacing: 0.05em;
    }
    .code-block code {
      display: block; padding: 10px 12px; overflow-x: auto;
      color: var(--text); white-space: pre; line-height: 1.55;
    }
    .hl-kw  { color: var(--mauve); }
    .hl-str { color: var(--green); }
    .hl-cmt { color: var(--subtext0); font-style: italic; }
    .hl-num { color: var(--blue); }
    .hl-fn  { color: var(--yellow); }
    #input-bar {
      background: var(--mantle); padding: 10px 16px calc(10px + env(safe-area-inset-bottom, 0px));
      display: flex; gap: 8px; flex-shrink: 0;
      border-top: 1px solid var(--surface0);
      position: relative;
    }
    #cmd-suggestions {
      display: none; position: absolute; bottom: 100%; left: 16px; right: 16px;
      background: var(--mantle); border: 1px solid var(--surface1);
      border-bottom: none; border-radius: 8px 8px 0 0;
      overflow: hidden; z-index: 10;
    }
    .cmd-item {
      display: flex; align-items: baseline; gap: 10px;
      padding: 7px 12px; cursor: pointer; font-size: 12px;
      border-bottom: 1px solid var(--surface0);
    }
    .cmd-item:last-child { border-bottom: none; }
    .cmd-item:hover, .cmd-item.active { background: var(--surface0); }
    .cmd-item .cmd-name { color: var(--blue); font-weight: bold; flex-shrink: 0; }
    .cmd-item .cmd-desc { color: var(--subtext0); }
    #input {
      flex: 1; background: var(--surface0); color: var(--text);
      border: none; border-radius: 6px; padding: 8px 12px;
      font-family: inherit; font-size: 13px; resize: none;
      outline: none; line-height: 1.5; min-height: 36px; max-height: 120px;
    }
    #input::placeholder { color: var(--subtext0); }
    #input:focus { box-shadow: 0 0 0 1px var(--mauve); }
    #send {
      background: var(--blue); color: var(--crust); border: none;
      border-radius: 6px; padding: 8px 16px; font-weight: bold;
      cursor: pointer; font-size: 13px; font-family: inherit;
      white-space: nowrap; align-self: flex-end;
    }
    #send:disabled, #input:disabled { opacity: 0.45; cursor: not-allowed; }
    #reconnect-overlay {
      display: none; position: fixed; inset: 0;
      background: rgba(30,30,46,0.88); color: var(--subtext1);
      justify-content: center; align-items: center;
      font-size: 13px; z-index: 100; letter-spacing: 0.03em;
    }
    #reconnect-overlay.visible { display: flex; }
    .cursor {
      display: inline-block; width: 7px; height: 1em; vertical-align: text-bottom;
      background: var(--green); animation: blink 1s step-end infinite; margin-left: 1px;
    }
    @keyframes blink { 50% { opacity: 0; } }
    #status-panel { padding: 6px 12px; border-bottom: 1px solid var(--surface1);
      color: var(--subtext1); white-space: pre-wrap; font-size: 13px; display: none; }
    #prompt-card { position: fixed; left: 0; right: 0; bottom: 0; background: var(--mantle);
      border-top: 2px solid var(--mauve); padding: 16px 14px calc(16px + env(safe-area-inset-bottom, 0px));
      display: none; z-index: 50; max-height: 80dvh; overflow-y: auto; }
    #prompt-card .q-label { color: var(--mauve); font-size: 11px; font-weight: 700;
      text-transform: uppercase; letter-spacing: .6px; margin-bottom: 6px; }
    #prompt-card .q { color: var(--text); margin-bottom: 12px; white-space: pre-wrap;
      font-size: 15px; line-height: 1.5; }
    #prompt-card .rec-panel { background: var(--surface0); border-left: 3px solid var(--green);
      border-radius: 6px; padding: 10px 12px; margin-bottom: 12px; }
    #prompt-card .rec-label { color: var(--green); font-size: 11px; font-weight: 700;
      text-transform: uppercase; letter-spacing: .5px; margin-bottom: 4px; }
    #prompt-card .rec-text { color: var(--text); font-size: 15px; line-height: 1.5;
      white-space: pre-wrap; overflow-wrap: anywhere; }
    #prompt-card textarea { width: 100%; background: var(--surface0); color: var(--text);
      border: 1px solid var(--surface2); border-radius: 6px; padding: 10px; font-size: 15px;
      font-family: inherit; line-height: 1.5; resize: vertical; margin-bottom: 4px; }
    #prompt-card .row { display: flex; gap: 8px; margin-top: 12px; align-items: center;
      flex-wrap: wrap; }
    #prompt-card button { padding: 11px 16px; border-radius: 8px; border: none; cursor: pointer;
      font-family: inherit; font-size: 14px; font-weight: 600; transition: filter .15s ease; }
    #prompt-card button:hover { filter: brightness(1.08); }
    #prompt-card button.primary { background: var(--green); color: var(--crust);
      font-weight: 700; flex: 1; min-width: 160px; }
    #prompt-card button.secondary { background: var(--surface1); color: var(--text);
      flex: 1; min-width: 160px; }
    #prompt-card button.cancel { margin-left: auto; background: transparent; color: var(--subtext0);
      font-size: 12px; font-weight: 500; padding: 8px 10px; }
    #prompt-card button.cancel:hover { color: var(--red); filter: none; }
    #prompt-card button.cancel.armed { background: var(--red); color: var(--crust); font-weight: 700; }
    .toast { position: fixed; top: calc(env(safe-area-inset-top, 0px) + 12px);
      right: calc(env(safe-area-inset-right, 0px) + 12px); max-width: calc(100vw - 24px);
      padding: 8px 12px; border-radius: 6px; overflow-wrap: anywhere; word-break: break-word;
      background: var(--surface1); color: var(--text); z-index: 60; }
    .toast.warning { background: var(--peach); color: var(--crust); }
    .toast.error { background: var(--red); color: var(--crust); }
    #viewer { position: fixed; inset: 24px; background: var(--mantle); border: 1px solid var(--surface2);
      border-radius: 8px; padding: 16px; overflow: auto; white-space: pre-wrap;
      overflow-wrap: anywhere; word-break: break-word; display: none; z-index: 70; }
    #viewer .close { position: absolute; top: 8px; right: 12px; cursor: pointer; color: var(--subtext0); }
  </style>
</head>
<body>
  <div id="context-bar"><div id="context-bar-fill"></div></div>
  <div id="header">
    <span class="title">pi-task remote</span>
    <div class="hgroup">
      <span class="status" id="client-status"><span class="cdot" id="conn-dot">&#x25CB;</span></span>
      <button id="bell" aria-label="Toggle notifications" title="Notifications">&#x25EF;</button>
    </div>
  </div>
  <div id="chat-log"></div>
  <div id="status-panel"></div>
  <div id="input-bar">
    <div id="cmd-suggestions"></div>
    <textarea id="input" placeholder="type a message… (/ for commands)" rows="1" disabled></textarea>
    <button id="send" disabled>Send</button>
  </div>
  <div id="reconnect-overlay"><span id="reconnect-msg">reconnecting…</span></div>
  <div id="prompt-card">
    <div class="q-label">pi needs your input</div>
    <div class="q" id="prompt-q"></div>
    <div class="rec-panel" id="prompt-rec" style="display:none">
      <div class="rec-label">Recommended answer</div>
      <div class="rec-text" id="prompt-rec-text"></div>
    </div>
    <textarea id="prompt-input" rows="3" placeholder="Type your answer…" style="display:none"></textarea>
    <div class="row" id="prompt-buttons"></div>
  </div>
  <div id="viewer"><span class="close" id="viewer-close">&#x2715;</span><div id="viewer-body"></div></div>
  <script>
    // Connect the WebSocket back to whatever host served this page (LAN or
    // Tailscale), not a server-baked IP — otherwise opening the LAN URL on a
    // non-Tailscale device tries to reach the Tailscale IP and hangs. Fall back
    // to the server-provided URL only if location is somehow unavailable.
    const FALLBACK_WS_URL = ${JSON.stringify(wsUrl)};
    const WS_URL = (location && location.host)
      ? (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'
      : FALLBACK_WS_URL;
    const chatLog = document.getElementById('chat-log');
    const inputEl = document.getElementById('input');
    const sendBtn = document.getElementById('send');
    const contextFill = document.getElementById('context-bar-fill');
    function setContextBar(usage) {
      if (usage && usage.percent != null) contextFill.style.width = usage.percent + '%';
    }
    const connDot = document.getElementById('conn-dot');
    // state: 'connecting' (○ yellow) | 'up' (● green) | 'down' (● red)
    function setConn(state) {
      connDot.textContent = state === 'connecting' ? '\\u25CB' : '\\u25CF';
      connDot.className = 'cdot' + (state === 'up' ? ' up' : state === 'down' ? ' down' : '');
    }
    const reconnectOverlay = document.getElementById('reconnect-overlay');
    const reconnectMsg = document.getElementById('reconnect-msg');
    const cmdSuggestions = document.getElementById('cmd-suggestions');
    const statusPanel = document.getElementById('status-panel');
    // Widgets are keyed (e.g. 'pi-tasks', 'pi-task-auto'); track them per key so a
    // clear for one key can't be masked by a stale message from another.
    const widgets = {};
    function renderWidgets() {
      let all = [];
      for (const k in widgets) if (widgets[k] && widgets[k].length) all = all.concat(widgets[k]);
      if (all.length) {
        statusPanel.textContent = all.join('\\n');
        statusPanel.style.display = 'block';
      } else {
        statusPanel.style.display = 'none';
      }
    }
    const promptCard = document.getElementById('prompt-card');
    const promptQ = document.getElementById('prompt-q');
    const promptRec = document.getElementById('prompt-rec');
    const promptRecText = document.getElementById('prompt-rec-text');
    const promptInput = document.getElementById('prompt-input');
    const promptButtons = document.getElementById('prompt-buttons');
    const viewer = document.getElementById('viewer');
    const viewerBody = document.getElementById('viewer-body');
    document.getElementById('viewer-close').onclick = function () { viewer.style.display = 'none'; };
    let activePromptId = null;
    let activeRecommended = '';
    let cancelArmTimer = null;
    const toolCallMap = {};
    let currentBubble = null;
    let streamText = '';
    let autoScroll = true;
    let reconnectDelay = 1000;
    let reconnectAnim = null;
    let ws = null;

    const BT = String.fromCharCode(96);
    const JS_LANGS = new Set(['js','jsx','mjs','cjs','javascript','ts','tsx','typescript']);
    const JS_KW = new Set(['break','case','catch','class','const','continue','debugger',
      'default','delete','do','else','export','extends','finally','for','from','function',
      'if','import','in','instanceof','let','new','of','return','static','super','switch',
      'this','throw','try','typeof','var','void','while','with','yield','async','await',
      'type','interface','enum','implements','abstract','as','declare','namespace',
      'readonly','undefined','null','true','false','override','satisfies']);

    function escHtml(s) {
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    function syntaxHighlight(code, lang) {
      if (!JS_LANGS.has((lang || '').toLowerCase())) return escHtml(code);
      let r = '', i = 0;
      while (i < code.length) {
        const ch = code[i];
        // Template literal
        if (ch === BT) {
          let j = i + 1;
          while (j < code.length) {
            if (code[j] === '\\\\') { j += 2; continue; }
            if (code[j] === BT) { j++; break; }
            j++;
          }
          r += '<span class="hl-str">' + escHtml(code.slice(i, j)) + '</span>';
          i = j; continue;
        }
        // Single / double quoted string
        if (ch === '"' || ch === "'") {
          let j = i + 1;
          while (j < code.length) {
            if (code[j] === '\\\\') { j += 2; continue; }
            if (code[j] === ch || code[j] === '\\n') break;
            j++;
          }
          if (code[j] === ch) j++;
          r += '<span class="hl-str">' + escHtml(code.slice(i, j)) + '</span>';
          i = j; continue;
        }
        // Line comment
        if (ch === '/' && code[i + 1] === '/') {
          let j = i + 2;
          while (j < code.length && code[j] !== '\\n') j++;
          r += '<span class="hl-cmt">' + escHtml(code.slice(i, j)) + '</span>';
          i = j; continue;
        }
        // Block comment
        if (ch === '/' && code[i + 1] === '*') {
          let j = i + 2;
          while (j < code.length && !(code[j] === '*' && code[j + 1] === '/')) j++;
          j += 2;
          r += '<span class="hl-cmt">' + escHtml(code.slice(i, j)) + '</span>';
          i = j; continue;
        }
        // Number
        if (ch >= '0' && ch <= '9') {
          let j = i;
          if (code[i] === '0' && /[xXoObB]/.test(code[i + 1] || '')) {
            j += 2; while (j < code.length && /[0-9a-fA-F_]/.test(code[j])) j++;
          } else {
            while (j < code.length && (code[j] >= '0' && code[j] <= '9' || code[j] === '_')) j++;
            if (code[j] === '.') { j++; while (j < code.length && code[j] >= '0' && code[j] <= '9') j++; }
            if (code[j] === 'e' || code[j] === 'E') {
              j++; if (code[j] === '+' || code[j] === '-') j++;
              while (j < code.length && code[j] >= '0' && code[j] <= '9') j++;
            }
            if (code[j] === 'n') j++;
          }
          r += '<span class="hl-num">' + escHtml(code.slice(i, j)) + '</span>';
          i = j; continue;
        }
        // Identifier / keyword / function call
        if (/[a-zA-Z_$]/.test(ch)) {
          let j = i;
          while (j < code.length && /[a-zA-Z0-9_$]/.test(code[j])) j++;
          const word = code.slice(i, j);
          if (JS_KW.has(word)) {
            r += '<span class="hl-kw">' + word + '</span>';
          } else if (code[j] === '(') {
            r += '<span class="hl-fn">' + escHtml(word) + '</span>';
          } else {
            r += escHtml(word);
          }
          i = j; continue;
        }
        r += escHtml(ch); i++;
      }
      return r;
    }

    function setContent(el, text) {
      el.innerHTML = '';
      const BT3 = BT + BT + BT;
      const re = new RegExp(BT3 + '([^\\n' + BT + ']*)\\n([\\s\\S]*?)' + BT3, 'g');
      let last = 0, m;
      while ((m = re.exec(text)) !== null) {
        if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
        const lang = m[1].trim();
        const code = m[2];
        const wrap = document.createElement('div');
        wrap.className = 'code-block';
        if (lang) { const lb = document.createElement('div'); lb.className = 'code-lang'; lb.textContent = lang; wrap.appendChild(lb); }
        const pre = document.createElement('pre');
        const codeEl = document.createElement('code');
        codeEl.innerHTML = syntaxHighlight(code, lang);
        pre.appendChild(codeEl);
        wrap.appendChild(pre);
        el.appendChild(wrap);
        last = m.index + m[0].length;
      }
      if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
    }

    const COMMANDS = [
      { name: '/task',             desc: 'Start a new task' },
      { name: '/task-list',        desc: 'List tasks in this project' },
      { name: '/task-resume',      desc: 'Resume a task' },
      { name: '/task-cancel',      desc: 'Cancel the currently running task' },
      { name: '/task-auto',        desc: 'Plan a feature into tasks and run them' },
      { name: '/task-auto-resume', desc: 'Resume the active /task-auto run' },
      { name: '/task-auto-cancel', desc: 'Stop the running /task-auto loop after the current task' },
      { name: '/new',              desc: 'Start a new session' },
      { name: '/clear',            desc: 'Clear the conversation' },
      { name: '/compact',          desc: 'Compact context to save tokens' },
      { name: '/help',             desc: 'Show available commands' },
      { name: '/fast',             desc: 'Toggle fast mode' },
      { name: '/remote stop',      desc: 'Stop the remote server' },
    ];
    let cmdActive = [];
    let cmdIndex = -1;

    function renderSuggestions() {
      if (cmdActive.length === 0) { cmdSuggestions.style.display = 'none'; return; }
      cmdSuggestions.style.display = 'block';
      cmdSuggestions.innerHTML = '';
      cmdActive.forEach((cmd, i) => {
        const el = document.createElement('div');
        el.className = 'cmd-item' + (i === cmdIndex ? ' active' : '');
        el.innerHTML = '<span class="cmd-name">' + cmd.name + '</span><span class="cmd-desc">' + cmd.desc + '</span>';
        el.addEventListener('mousedown', (e) => { e.preventDefault(); pickCmd(i); });
        cmdSuggestions.appendChild(el);
      });
    }

    function updateSuggestions() {
      const val = inputEl.value;
      if (!val.startsWith('/')) { cmdActive = []; cmdIndex = -1; renderSuggestions(); return; }
      cmdActive = COMMANDS.filter(c => c.name.startsWith(val));
      cmdIndex = cmdActive.length === 1 ? 0 : -1;
      renderSuggestions();
    }

    function pickCmd(i) {
      if (!cmdActive[i]) return;
      inputEl.value = cmdActive[i].name + ' ';
      cmdActive = []; cmdIndex = -1; renderSuggestions();
      inputEl.focus();
    }

    chatLog.addEventListener('scroll', () => {
      const { scrollTop, scrollHeight, clientHeight } = chatLog;
      autoScroll = scrollTop + clientHeight >= scrollHeight - 24;
    });

    function scrollBottom() { if (autoScroll) chatLog.scrollTop = chatLog.scrollHeight; }

    function addBubble(role, text) {
      const el = document.createElement('div');
      el.className = 'bubble ' + role;
      setContent(el, text);
      chatLog.appendChild(el);
      scrollBottom();
      return el;
    }

    let thinkingEl = null;
    let spinTimer = null;
    let spinIdx = 0;
    const SPIN = '\\u280B\\u2819\\u2839\\u2838\\u283C\\u2834\\u2826\\u2827\\u2807\\u280F';
    function showThinking() {
      if (!thinkingEl) {
        thinkingEl = document.createElement('div');
        thinkingEl.className = 'bubble assistant thinking';
        thinkingEl.innerHTML = '<span class="spinner"></span>';
      }
      if (!spinTimer) {
        var sp = thinkingEl.firstChild;
        sp.textContent = SPIN[spinIdx % SPIN.length];
        spinTimer = setInterval(function () {
          spinIdx = (spinIdx + 1) % SPIN.length;
          sp.textContent = SPIN[spinIdx];
        }, 90);
      }
      chatLog.appendChild(thinkingEl); // append (or move) to bottom
      scrollBottom();
    }
    function hideThinking() {
      if (spinTimer) { clearInterval(spinTimer); spinTimer = null; }
      if (thinkingEl) thinkingEl.remove();
    }

    function addToolCall(toolName, argsStr, isError) {
      const label = (toolName + ': ' + argsStr).slice(0, 64);
      const d = document.createElement('details');
      d.className = 'tool-call' + (isError ? ' error' : '');
      const s = document.createElement('summary');
      s.textContent = label;
      d.appendChild(s);
      chatLog.appendChild(d);
      scrollBottom();
      return d;
    }

    function setEnabled(on) {
      const allow = on && activePromptId === null;
      inputEl.disabled = !allow;
      sendBtn.disabled = !allow;
    }

    function showToast(message, level) {
      const t = document.createElement('div');
      t.className = 'toast ' + (level || 'info');
      t.textContent = message;
      document.body.appendChild(t);
      setTimeout(function () { t.remove(); }, 4000);
    }

    const bell = document.getElementById('bell');
    const NOTIFY_KEY = 'piRemoteNotify';

    function notifyEnabled() {
      return localStorage.getItem(NOTIFY_KEY) === '1'
        && typeof Notification !== 'undefined'
        && Notification.permission === 'granted';
    }

    function updateBell() {
      // ◉ (mauve) when armed, ◯ (dim) when off/unavailable.
      var on = notifyEnabled();
      bell.textContent = on ? '\\u25C9' : '\\u25EF';
      bell.classList.toggle('on', on);
    }

    // Why notifications can't be enabled here, or null if they can.
    function notifyEnvIssue() {
      if (typeof Notification === 'undefined') return "This browser doesn't support notifications.";
      if (!window.isSecureContext) return 'Notifications need HTTPS. Open the Tailscale https:// URL, or open via localhost.';
      const isIOS = /iP(hone|ad|od)/i.test(navigator.userAgent);
      const standalone = navigator.standalone === true
        || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
      if (isIOS && !standalone) return 'On iOS: Share \\u2192 Add to Home Screen first, then enable notifications.';
      return null;
    }

    bell.addEventListener('click', function () {
      // Turning OFF always works regardless of environment.
      if (localStorage.getItem(NOTIFY_KEY) === '1') {
        localStorage.setItem(NOTIFY_KEY, '0'); updateBell(); return;
      }
      const issue = notifyEnvIssue();
      if (issue) { showToast(issue, 'warning'); return; }
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        showToast('This browser doesn\\u2019t support push notifications.', 'warning'); return;
      }
      Notification.requestPermission().then(function (perm) {
        if (perm !== 'granted') {
          showToast('Notifications blocked in browser settings.', 'warning');
          updateBell(); return;
        }
        subscribePush().then(function (ok) {
          if (ok) { localStorage.setItem(NOTIFY_KEY, '1'); showToast('Notifications on.', 'info'); }
          else { showToast('Could not register for notifications.', 'warning'); }
          updateBell();
        }).catch(function (e) {
          showToast('Notification setup failed: ' + (e && e.message ? e.message : e), 'warning');
          updateBell();
        });
      });
    });

    // VAPID public key (base64url) -> Uint8Array for applicationServerKey.
    function urlB64ToUint8Array(base64) {
      const pad = '='.repeat((4 - base64.length % 4) % 4);
      const b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
      const raw = atob(b64);
      const arr = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
      return arr;
    }

    // Register the service worker, subscribe via the Push API, and hand the
    // subscription to the server. The server (not the page) sends notifications,
    // so they arrive even when this PWA is backgrounded/suspended on iOS.
    function subscribePush() {
      return navigator.serviceWorker.register('/sw.js')
        .then(function () { return navigator.serviceWorker.ready; })
        .then(function (reg) {
          return fetch('/push-key').then(function (r) { return r.text(); }).then(function (key) {
            return reg.pushManager.getSubscription().then(function (existing) {
              return existing || reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlB64ToUint8Array(key.trim())
              });
            });
          });
        })
        .then(function (subscription) {
          return fetch('/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(subscription)
          }).then(function (res) { return res.ok; });
        });
    }

    updateBell();
    // Self-heal: if notifications were enabled before, re-register the
    // subscription on load (the server keeps subscriptions in memory and may
    // have restarted, and browsers can rotate the subscription).
    if (notifyEnabled()) { subscribePush().catch(function () {}); }

    function answer(value) {
      if (activePromptId === null) return;
      ws.send(JSON.stringify({ type: 'prompt_answer', id: activePromptId, value: value }));
      closePrompt();
    }

    function closePrompt() {
      activePromptId = null;
      promptCard.style.display = 'none';
      promptInput.value = '';
      promptInput.style.display = 'none';
      promptRec.style.display = 'none';
      if (cancelArmTimer) { clearTimeout(cancelArmTimer); cancelArmTimer = null; }
      setEnabled(true);
    }

    function makeBtn(label, cls, onClick) {
      const btn = document.createElement('button');
      btn.textContent = label;
      if (cls) btn.className = cls;
      btn.onclick = onClick;
      return btn;
    }

    // "Cancel task" aborts the whole run, so it's deliberately small and needs a
    // two-step confirm: first tap arms it, second tap (within 3s) confirms.
    function makeCancelBtn() {
      const btn = makeBtn('Cancel task', 'cancel', null);
      let armed = false;
      btn.onclick = function () {
        if (armed) { answer(undefined); return; }
        armed = true;
        btn.classList.add('armed');
        btn.textContent = 'Tap again to cancel';
        if (cancelArmTimer) clearTimeout(cancelArmTimer);
        cancelArmTimer = setTimeout(function () {
          armed = false;
          btn.classList.remove('armed');
          btn.textContent = 'Cancel task';
          cancelArmTimer = null;
        }, 3000);
      };
      return btn;
    }

    function renderButtons(buttons) {
      promptButtons.innerHTML = '';
      for (let i = 0; i < buttons.length; i++) promptButtons.appendChild(buttons[i]);
      promptButtons.appendChild(makeCancelBtn());
    }

    // Manual-entry view: editable textarea + Submit, reachable from the
    // recommendation view via "Answer manually".
    function showManualEntry(prefill) {
      promptRec.style.display = 'none';
      promptInput.style.display = 'block';
      promptInput.value = prefill || '';
      renderButtons([
        makeBtn('Submit answer', 'primary', function () { answer(promptInput.value); }),
        makeBtn('← Back', 'secondary', function () { showRecommendation(); })
      ]);
      promptInput.focus();
    }

    // Recommendation view (Mode A): show the suggested answer and let the user
    // accept it in one tap or switch to manual entry.
    function showRecommendation() {
      promptInput.style.display = 'none';
      promptRec.style.display = 'block';
      renderButtons([
        makeBtn('✓ Accept recommended', 'primary', function () { answer(''); }),
        makeBtn('✎ Answer manually', 'secondary', function () { showManualEntry(activeRecommended); })
      ]);
    }

    function showPrompt(msg) {
      activePromptId = msg.id;
      promptQ.textContent = msg.question;
      activeRecommended = msg.recommended || '';
      if (msg.recommended) {
        // Mode A: there's a recommendation — lead with "Accept recommended".
        promptRecText.textContent = msg.recommended;
        showRecommendation();
      } else {
        // Mode B: no recommendation — the user must type an answer (or skip).
        promptRec.style.display = 'none';
        promptInput.style.display = 'block';
        promptInput.value = '';
        const buttons = [makeBtn('Submit answer', 'primary', function () { answer(promptInput.value); })];
        if (msg.allowSkip) {
          buttons.push(makeBtn('Skip question', 'secondary', function () { answer(''); }));
        }
        renderButtons(buttons);
        promptInput.focus();
      }
      promptCard.style.display = 'block';
      setEnabled(false);
    }

    function handleMsg(msg) {
      switch (msg.type) {
        case 'history':
          for (const t of (msg.turns || [])) {
            if (t.error) { addBubble('error', t.text); continue; }
            addBubble(t.role, t.text);
            for (const tool of (t.tools || [])) {
              const d = addToolCall(tool.toolName, JSON.stringify(tool.args), tool.isError);
              const pre = document.createElement('pre');
              const r = typeof tool.result === 'string' ? tool.result : JSON.stringify(tool.result, null, 2);
              pre.textContent = r.slice(0, 8000);
              d.appendChild(pre);
            }
          }
          break;
        case 'agent_start':
          autoScroll = true;
          streamText = '';
          currentBubble = null;
          setEnabled(false);
          showThinking();
          break;
        case 'text_delta':
          if (!currentBubble) {
            hideThinking();
            currentBubble = document.createElement('div');
            currentBubble.className = 'bubble assistant';
            const cursor = document.createElement('span');
            cursor.className = 'cursor';
            currentBubble.appendChild(cursor);
            chatLog.appendChild(currentBubble);
          }
          streamText += msg.delta;
          {
            const c = currentBubble.querySelector('.cursor');
            currentBubble.insertBefore(document.createTextNode(msg.delta), c);
          }
          scrollBottom();
          break;
        case 'text_end':
          if (currentBubble) {
            const c = currentBubble.querySelector('.cursor');
            if (c) c.remove();
            if (streamText) setContent(currentBubble, streamText);
          }
          break;
        case 'tool_start': {
          hideThinking();
          const argsStr = typeof msg.args === 'string' ? msg.args : JSON.stringify(msg.args);
          toolCallMap[msg.toolCallId] = addToolCall(msg.toolName, argsStr, false);
          break;
        }
        case 'tool_end': {
          const d = toolCallMap[msg.toolCallId];
          if (d) {
            if (msg.isError) d.classList.add('error');
            const pre = document.createElement('pre');
            const r = typeof msg.result === 'string' ? msg.result : JSON.stringify(msg.result, null, 2);
            pre.textContent = r.slice(0, 8000);
            d.appendChild(pre);
            delete toolCallMap[msg.toolCallId];
          }
          // Tool finished: model is thinking about the result next.
          currentBubble = null;
          streamText = '';
          showThinking();
          break;
        }
        case 'user_message':
          addBubble('user', msg.text);
          break;
        case 'agent_error':
          hideThinking();
          if (currentBubble) {
            const c = currentBubble.querySelector('.cursor');
            if (c) c.remove();
            if (streamText) setContent(currentBubble, streamText);
            currentBubble = null;
            streamText = '';
          }
          addBubble('error', msg.message || 'Error');
          setEnabled(true);
          break;
        case 'agent_end':
          hideThinking();
          currentBubble = null;
          streamText = '';
          setEnabled(true);
          setContextBar(msg.contextUsage);
          break;
        case 'context':
          // Seeds the bar for a client that joined mid-session.
          setContextBar(msg.contextUsage);
          break;
        case 'client_count':
          setConn('up');
          break;
        case 'prompt':
          showPrompt(msg);
          break;
        case 'prompt_resolved':
          if (activePromptId === msg.id) closePrompt();
          break;
        case 'widget':
          if (msg.lines && msg.lines.length) widgets[msg.key] = msg.lines;
          else delete widgets[msg.key];
          renderWidgets();
          break;
        case 'notify':
          showToast(msg.message, msg.level);
          break;
        case 'viewer':
          viewerBody.textContent = msg.text;
          viewer.style.display = 'block';
          break;
        case 'reset':
          // A new session started — wipe the previous session's transcript.
          chatLog.innerHTML = '';
          hideThinking();
          currentBubble = null; streamText = '';
          closePrompt();
          for (const k in widgets) delete widgets[k];
          renderWidgets();
          contextFill.style.width = '0%';
          break;
      }
    }

    function sendMessage() {
      const text = inputEl.value.trim();
      if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'message', text }));
      inputEl.value = '';
      inputEl.style.height = 'auto';
      cmdActive = []; cmdIndex = -1; renderSuggestions();
      // Slash commands are handled server-side and produce no chat turn.
      if (text.startsWith('/')) return;
      // Optimistic echo: remote-typed messages arrive as source "extension",
      // which the server does not broadcast back, so render locally now.
      addBubble('user', text);
      setEnabled(false);
      showThinking();
    }

    sendBtn.addEventListener('click', sendMessage);
    inputEl.addEventListener('keydown', (e) => {
      if (cmdActive.length > 0) {
        if (e.key === 'ArrowDown') { e.preventDefault(); cmdIndex = Math.min(cmdIndex + 1, cmdActive.length - 1); renderSuggestions(); return; }
        if (e.key === 'ArrowUp')   { e.preventDefault(); cmdIndex = Math.max(cmdIndex - 1, 0); renderSuggestions(); return; }
        if (e.key === 'Tab')       { e.preventDefault(); pickCmd(cmdIndex >= 0 ? cmdIndex : 0); return; }
        if (e.key === 'Escape')    { cmdActive = []; cmdIndex = -1; renderSuggestions(); return; }
        if (e.key === 'Enter' && !e.shiftKey && cmdIndex >= 0) { e.preventDefault(); pickCmd(cmdIndex); return; }
      }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    inputEl.addEventListener('input', () => {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
      updateSuggestions();
    });

    function connect() {
      ws = new WebSocket(WS_URL);
      ws.addEventListener('open', () => {
        if (reconnectAnim) { clearInterval(reconnectAnim); reconnectAnim = null; }
        reconnectOverlay.classList.remove('visible');
        reconnectDelay = 1000;
        setConn('up');
        setEnabled(true);
      });
      ws.addEventListener('message', (e) => {
        try { handleMsg(JSON.parse(e.data)); } catch {}
      });
      ws.addEventListener('close', () => {
        setEnabled(false);
        setConn('down');
        reconnectOverlay.classList.add('visible');
        // Animate the same braille spinner used elsewhere, with a live countdown.
        const until = Date.now() + reconnectDelay;
        let frame = 0;
        const paint = () => {
          const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
          const glyph = SPIN[frame++ % SPIN.length];
          reconnectMsg.textContent = left > 0
            ? glyph + '  connection lost — retrying in ' + left + 's'
            : glyph + '  reconnecting…';
        };
        if (reconnectAnim) clearInterval(reconnectAnim);
        paint();
        reconnectAnim = setInterval(paint, 90);
        setTimeout(() => { reconnectDelay = Math.min(reconnectDelay * 2, 30000); connect(); }, reconnectDelay);
      });
    }

    connect();
  </script>
</body>
</html>`
}
