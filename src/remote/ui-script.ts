/** The remote web client script (vanilla JS shipped as a string).
 * `wsUrl` is the LAN/Tailscale fallback baked in as FALLBACK_WS_URL. */
export function clientScript(wsUrl: string): string {
    return `    // Connect the WebSocket back to whatever host served this page (LAN or
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
      setStatusChip(usage);
    }
    // Compact token count for the header chip (mirrors formatContextTokens).
    function fmtTokens(n) {
      if (n == null) return '';
      if (n < 1000) return String(n);
      if (n < 10000) return (n / 1000).toFixed(1) + 'k';
      if (n < 1000000) return Math.round(n / 1000) + 'k';
      return (n / 1000000).toFixed(1) + 'M';
    }
    function setStatusChip(usage) {
      if (!usage) return;
      var parts = [];
      if (usage.percent != null) parts.push(Math.round(usage.percent) + '%');
      if (usage.tokens != null && usage.contextWindow) {
        parts.push(fmtTokens(usage.tokens) + '/' + fmtTokens(usage.contextWindow));
      }
      statusCtx.textContent = parts.join(' \\u00B7 ');
    }
    function setModelName(name) {
      if (name && name !== modelName) { modelName = name; statusModel.textContent = name; }
    }
    // Connection dot: red disconnected, mauve pulsing while running, green idle.
    function updateStatusDot() {
      statusDot.className = !connected ? 'disconnected' : (agentRunning ? 'running' : 'idle');
    }
    const reconnectOverlay = document.getElementById('reconnect-overlay');
    const reconnectMsg = document.getElementById('reconnect-msg');
    const cmdSuggestions = document.getElementById('cmd-suggestions');
    const statusPanel = document.getElementById('status-panel');
    const statusDot = document.getElementById('status-dot');
    const statusModel = document.getElementById('status-model');
    const statusCtx = document.getElementById('status-ctx');
    const notifPanel = document.getElementById('notif-panel');
    const notifList = document.getElementById('notif-list');
    const notifToggle = document.getElementById('notif-toggle');
    // Last ~20 toasts, newest first, for the bell dropdown history.
    let notifHistory = [];
    let modelName = '';
    // Widgets are keyed (e.g. 'pi-tasks', 'pi-task-auto'); track them per key so a
    // clear for one key can't be masked by a stale message from another.
    // Single authoritative task-widget slot. The snapshot and the live 'widget'
    // delta both set this; null hides the panel. (No more per-key map that could
    // strand an orphaned widget on screen.)
    let taskWidgetLines = null;
    let taskWidgetData = null;
    function renderWidgets() {
      // Structured payload wins (progress bar + phase badge + elapsed); the plain
      // text lines are the fallback for older/unstructured producers.
      if (taskWidgetData) { renderStructuredWidget(taskWidgetData); return; }
      statusPanel.classList.remove('structured');
      if (taskWidgetLines && taskWidgetLines.length) {
        statusPanel.textContent = taskWidgetLines.join('\\n');
        statusPanel.style.display = 'block';
      } else {
        statusPanel.style.display = 'none';
      }
    }
    function renderStructuredWidget(d) {
      statusPanel.classList.add('structured');
      statusPanel.style.display = 'block';
      // Title on its own line (wraps to 2, never truncated to a stub).
      var title = '<div class="widget-title">' + escHtml(d.title || '') + '</div>';
      // Meta row: phase badge · step count · elapsed clock.
      var meta = '<div class="widget-meta">'
        + (d.phase ? '<span class="widget-phase">' + escHtml(d.phase) + '</span>' : '')
        + (d.total > 0 && d.done != null ? '<span class="widget-step">' + d.done + '/' + d.total + '</span>' : '')
        + (d.elapsed ? '<span class="widget-elapsed">' + escHtml(d.elapsed) + '</span>' : '')
        + '</div>';
      var bar = '';
      if (d.total > 0 && d.done != null) {
        var pct = Math.max(0, Math.min(100, Math.round((d.done / d.total) * 100)));
        bar = '<div class="widget-bar"><div class="widget-bar-fill" style="width:' + pct + '%"></div></div>';
      }
      // Current action — the terminal's last worker/child line, one ellipsized line.
      var action = d.action ? '<div class="widget-action">↳ ' + escHtml(d.action) + '</div>' : '';
      statusPanel.innerHTML = title + meta + bar + action;
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
    let activeRecommended2 = '';
    let cancelArmTimer = null;
    const toolCallMap = {};
    let currentBubble = null;
    let streamText = '';
    // Composer state: input is enabled whenever connected AND no prompt card is
    // open (messages typed mid-run steer the live turn); the Send button morphs
    // into a red Stop while the agent is running.
    let agentRunning = false;
    let connected = false;
    // Whether the current live turn produced any content — gates the trailing
    // turn-timestamp so an empty/aborted turn doesn't leave a stray clock.
    let turnHadContent = false;
    let stopArmed = false;
    let stopArmTimer = null;
    // The live thinking (<details>) block being streamed, and its accumulated text.
    let currentThinking = null;
    let thinkingText = '';
    let autoScroll = true;
    let reconnectDelay = 1000;
    let reconnectAnim = null;
    let reconnectTimer = null;
    let ws = null;

    // Render assistant text as markdown (headers, lists, tables, emphasis, links)
    // with fenced code blocks syntax-highlighted. renderMarkdown/syntaxHighlight are
    // the pure functions from ui-render.ts / ui-highlight.ts, concatenated into this
    // same <script> ahead of clientScript. innerHTML is safe because renderMarkdown
    // escapes every span of literal text and only emits a fixed set of known tags.
    function setContent(el, text) {
      el.classList.add('md');
      el.innerHTML = renderMarkdown(text);
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

    const scrollBtn = document.getElementById('scroll-bottom');
    function atBottom() {
      const { scrollTop, scrollHeight, clientHeight } = chatLog;
      return scrollTop + clientHeight >= scrollHeight - 24;
    }
    // Show the jump-to-latest button only when the user has scrolled up away
    // from the newest text; hide it once they're back at the bottom.
    function updateScrollBtn() {
      scrollBtn.classList.toggle('visible', !atBottom());
    }
    chatLog.addEventListener('scroll', () => {
      autoScroll = atBottom();
      updateScrollBtn();
    });
    scrollBtn.addEventListener('click', () => {
      autoScroll = true;
      chatLog.scrollTop = chatLog.scrollHeight;
      updateScrollBtn();
    });

    function scrollBottom() {
      if (autoScroll) chatLog.scrollTop = chatLog.scrollHeight;
      // New content can push the bottom away while the user is scrolled up;
      // keep the button's visibility in sync on every append, not just on scroll.
      updateScrollBtn();
    }

    function addBubble(role, text) {
      const el = document.createElement('div');
      el.className = 'bubble ' + role;
      // Only assistant text is markdown-rendered; user/error bubbles stay plain so a
      // user's literal *asterisks* or backticks show verbatim.
      if (role === 'assistant') { setContent(el, text); attachBubbleCopy(el, text); }
      else el.textContent = text;
      chatLog.appendChild(el);
      scrollBottom();
      return el;
    }

    let thinkingEl = null;
    let spinTimer = null;
    let spinIdx = 0;
    const SPIN = '\\u280B\\u2819\\u2839\\u2838\\u283C\\u2834\\u2826\\u2827\\u2807\\u280F';
    // One braille ticker drives every '.spin' element — the thinking bubble AND the
    // trailing stream cursor — so they share the same frame and look identical.
    function spinPaint() {
      const g = SPIN[spinIdx % SPIN.length];
      const els = document.getElementsByClassName('spin');
      for (let i = 0; i < els.length; i++) els[i].textContent = g;
    }
    function startSpin() {
      spinPaint();
      if (spinTimer) return;
      spinTimer = setInterval(function () {
        spinIdx = (spinIdx + 1) % SPIN.length;
        spinPaint();
      }, 90);
    }
    // Stop the ticker once nothing on screen needs spinning.
    function stopSpinIfIdle() {
      if (spinTimer && !document.querySelector('.spin')) {
        clearInterval(spinTimer); spinTimer = null;
      }
    }
    function showThinking() {
      if (!thinkingEl) {
        thinkingEl = document.createElement('div');
        thinkingEl.className = 'bubble assistant thinking';
        thinkingEl.innerHTML = '<span class="spinner spin"></span>';
      }
      chatLog.appendChild(thinkingEl); // append (or move) to bottom
      startSpin();
      scrollBottom();
    }
    function hideThinking() {
      if (thinkingEl) thinkingEl.remove();
      stopSpinIfIdle();
    }

    // A finished/running tool card. args is the RAW args (object or JSON string) —
    // toolSummary/toolBadge/toolDiffHtml (ui-tools.ts) turn it into a readable
    // one-line summary, a +N −M badge, and (for edit/write) an expandable line diff.
    function addToolCall(toolName, args, isError) {
      const d = document.createElement('details');
      d.className = 'tool-call' + (isError ? ' error' : '');
      const s = document.createElement('summary');
      const label = document.createElement('span');
      label.className = 'tool-label';
      label.textContent = toolSummary(toolName, args);
      s.title = label.textContent;
      s.appendChild(label);
      const badge = toolBadge(toolName, args);
      if (badge && (badge.added || badge.removed)) {
        const b = document.createElement('span');
        b.className = 'tool-badge';
        b.textContent = '+' + badge.added + ' \\u2212' + badge.removed;
        s.appendChild(b);
      }
      d.appendChild(s);
      const diffHtml = toolDiffHtml(toolName, args);
      if (diffHtml) {
        const dv = document.createElement('div');
        dv.className = 'tool-diff';
        dv.innerHTML = diffHtml;
        d.appendChild(dv);
      }
      chatLog.appendChild(d);
      scrollBottom();
      return d;
    }

    // Dim "· 1.2s" appended to a finished tool summary.
    function appendElapsed(d, elapsedMs) {
      const txt = fmtElapsed(elapsedMs);
      if (!txt) return;
      const s = d.querySelector('summary');
      if (!s || s.querySelector('.tool-elapsed')) return;
      const e = document.createElement('span');
      e.className = 'tool-elapsed';
      e.textContent = '\\u00B7 ' + txt;
      s.appendChild(e);
    }

    // Reconcile the composer (input + Send/Stop button) with the current state.
    // The input is disabled ONLY while disconnected or a prompt card is open — a
    // running agent no longer locks it, so messages can steer the live turn.
    function refreshComposer() {
      updateStatusDot();
      const promptOpen = activePromptId !== null;
      inputEl.disabled = !connected || promptOpen;
      inputEl.placeholder = agentRunning
        ? 'message the agent — delivered mid-run'
        : 'type a message\\u2026 (/ for commands)';
      if (agentRunning && !promptOpen) {
        // Send morphs into a red Stop that interrupts the running turn.
        sendBtn.classList.add('stop');
        sendBtn.disabled = !connected;
        if (!stopArmed) sendBtn.textContent = 'Stop';
      } else {
        disarmStop();
        sendBtn.classList.remove('stop');
        sendBtn.textContent = 'Send';
        sendBtn.disabled = !connected || promptOpen;
      }
    }

    function disarmStop() {
      stopArmed = false;
      if (stopArmTimer) { clearTimeout(stopArmTimer); stopArmTimer = null; }
      sendBtn.classList.remove('armed');
      if (agentRunning) sendBtn.textContent = 'Stop';
    }

    function sendInterrupt() {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'interrupt' }));
      }
    }

    // Stop needs a two-tap confirm (same pattern as the prompt card's cancel):
    // first tap arms it, a second tap within 3s actually interrupts.
    function onSendClick() {
      if (agentRunning && activePromptId === null) {
        if (stopArmed) { disarmStop(); sendInterrupt(); return; }
        stopArmed = true;
        sendBtn.classList.add('armed');
        sendBtn.textContent = 'Tap to stop';
        if (stopArmTimer) clearTimeout(stopArmTimer);
        stopArmTimer = setTimeout(function () {
          stopArmed = false;
          sendBtn.classList.remove('armed');
          if (agentRunning) sendBtn.textContent = 'Stop';
          stopArmTimer = null;
        }, 3000);
        return;
      }
      sendMessage();
    }

    // Copy source text to the clipboard, flashing the button. Falls back to a
    // hidden textarea + execCommand for non-secure (plain-http LAN) contexts where
    // navigator.clipboard is unavailable.
    function flashCopied(btn) {
      if (!btn) return;
      const prev = btn.textContent;
      btn.textContent = 'Copied';
      btn.classList.add('copied');
      setTimeout(function () { btn.textContent = prev; btn.classList.remove('copied'); }, 1200);
    }
    function fallbackCopy(text, btn) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.top = '0';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        flashCopied(btn);
      } catch (e) {}
    }
    function copyText(text, btn) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { flashCopied(btn); },
          function () { fallbackCopy(text, btn); });
      } else {
        fallbackCopy(text, btn);
      }
    }
    // One delegated handler for every copy button (code-block headers live inside
    // markdown HTML; bubble buttons are appended in JS). Resolve the source text
    // from whichever container the button sits in.
    chatLog.addEventListener('click', function (e) {
      const btn = e.target && e.target.closest ? e.target.closest('.copy-btn') : null;
      if (!btn) return;
      const block = btn.closest('.code-block');
      if (block) {
        const code = block.querySelector('code');
        copyText(code ? code.textContent : '', btn);
        return;
      }
      const bub = btn.closest('.bubble');
      if (bub) copyText(bub.__copyText != null ? bub.__copyText : bub.textContent, btn);
    });

    // Attach a copy button to a finished assistant bubble and stash its raw text
    // (the pre-markdown source) so the delegated handler copies the original.
    function attachBubbleCopy(el, text) {
      el.__copyText = text;
      const b = document.createElement('button');
      b.className = 'copy-btn bubble-copy';
      b.type = 'button';
      b.setAttribute('aria-label', 'Copy message');
      b.textContent = 'Copy';
      el.appendChild(b);
    }

    // "✻ Thinking… (n lines)" collapsed-block summary.
    function thinkingSummary(n) {
      return '\\u273B Thinking\\u2026 (' + n + (n === 1 ? ' line' : ' lines') + ')';
    }
    function thinkingLineCount(text) {
      return text ? text.split('\\n').length : 0;
    }
    // Build a collapsed thinking <details>. A live block keeps a spinner in the
    // summary and stays open to further deltas; otherwise it's a finished, static one.
    function makeThinkingEl(text, live) {
      const d = document.createElement('details');
      d.className = 'thinking-block';
      const s = document.createElement('summary');
      const lbl = document.createElement('span');
      lbl.className = 'thinking-label';
      lbl.textContent = thinkingSummary(thinkingLineCount(text));
      s.appendChild(lbl);
      if (live) {
        const sp = document.createElement('span');
        sp.className = 'thinking-spin spin';
        s.appendChild(sp);
      }
      d.appendChild(s);
      const body = document.createElement('div');
      body.className = 'thinking-body';
      body.textContent = text || '';
      d.appendChild(body);
      return d;
    }
    // Close out the live thinking block (drop its spinner) — called when the model
    // moves on to text/tools, or the turn ends.
    function finalizeThinking() {
      if (currentThinking) {
        const sp = currentThinking.querySelector('.thinking-spin');
        if (sp) { sp.remove(); stopSpinIfIdle(); }
        currentThinking = null;
      }
      thinkingText = '';
    }

    // Pull the human-readable text out of a tool result. Many tools (Read, Bash,
    // MCP tools) return Anthropic content-block shapes — { content: [{type:'text',
    // text:'...'}] } or a bare array of such blocks — which JSON.stringify would
    // render as escaped, unreadable JSON. Extract the text blocks and join them;
    // return null when there's nothing text-shaped so the caller falls back to JSON.
    function contentBlocksText(result) {
      const blocks = Array.isArray(result) ? result
        : (result && Array.isArray(result.content)) ? result.content
        : null;
      if (!blocks) return null;
      const parts = [];
      for (const b of blocks) {
        if (typeof b === 'string') parts.push(b);
        else if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      }
      return parts.length ? parts.join('\\n') : null;
    }

    // Stringify a tool result safely. A null/undefined result (e.g. a tool that
    // hasn't produced output) must NOT become the JS value undefined, whose
    // .slice() throws — a throw here aborts the whole snapshot rebuild after the
    // log was already cleared, blanking the transcript on reconnect.
    function toolResultText(result) {
      if (result == null) return '';
      if (typeof result === 'string') return result.slice(0, 8000);
      const text = contentBlocksText(result);
      const r = text != null ? text : JSON.stringify(result, null, 2);
      return (r == null ? '' : r).slice(0, 8000);
    }

    // Render one tool part from the ordered parts list (running or finished).
    function renderToolPart(p) {
      const d = addToolCall(p.toolName, p.args, p.isError);
      if (p.done) {
        appendElapsed(d, p.elapsedMs);
        const pre = document.createElement('pre');
        pre.textContent = toolResultText(p.result);
        d.appendChild(pre);
      } else {
        const sp = document.createElement('span');
        sp.className = 'tool-spin spin';
        d.querySelector('summary').appendChild(sp);
        startSpin();
        toolCallMap[p.toolCallId] = d;
      }
      return d;
    }

    // Dim HH:MM shown under a turn's last bubble (local time).
    function fmtClock(ts) {
      if (!ts) return '';
      var d = new Date(ts);
      var pad = function (n) { return (n < 10 ? '0' : '') + n; };
      return pad(d.getHours()) + ':' + pad(d.getMinutes());
    }
    function addTurnTime(ts, roleClass) {
      var clock = fmtClock(ts || Date.now());
      if (!clock) return;
      var el = document.createElement('div');
      el.className = 'turn-time ' + roleClass;
      el.textContent = clock;
      chatLog.appendChild(el);
      scrollBottom();
    }

    // A muted, centered system note (e.g. "Context compacted").
    function addSystemLine(text) {
      const el = document.createElement('div');
      el.className = 'sysnote';
      el.textContent = text;
      chatLog.appendChild(el);
      scrollBottom();
      return el;
    }

    // Render one committed transcript turn. Assistant turns are an ordered list of
    // parts (text segments + tool calls), so the layout matches the terminal's
    // interleaving instead of one merged blob with tools dumped at the end.
    function renderTurn(t) {
      if (t.error) { addBubble('error', t.text); addTurnTime(t.ts, 'assistant'); return; }
      if (t.role === 'system') { addSystemLine(t.text); addTurnTime(t.ts, 'system'); return; }
      if (t.role === 'user') { addBubble('user', t.text); addTurnTime(t.ts, 'user'); return; }
      for (const p of (t.parts || [])) {
        if (p.kind === 'text') { if (p.text) addBubble('assistant', p.text); }
        else if (p.kind === 'thinking') {
          if (p.text) { chatLog.appendChild(makeThinkingEl(p.text, false)); scrollBottom(); }
        }
        else renderToolPart(p);
      }
      addTurnTime(t.ts, 'assistant');
    }

    // Render the in-progress assistant turn from a snapshot, preserving order. The
    // trailing OPEN text segment becomes the live streaming bubble (cursor + spin)
    // so subsequent text_delta frames keep flowing into it.
    function renderLiveTurn(live) {
      const parts = live.parts || [];
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const last = i === parts.length - 1;
        if (p.kind === 'text') {
          if (last && live.textOpen) {
            currentBubble = document.createElement('div');
            currentBubble.className = 'bubble assistant';
            const cursor = document.createElement('span');
            cursor.className = 'cursor spin';
            currentBubble.appendChild(cursor);
            if (p.text) currentBubble.insertBefore(document.createTextNode(p.text), cursor);
            chatLog.appendChild(currentBubble);
            streamText = p.text || '';
            startSpin();
            scrollBottom();
          } else if (p.text) {
            addBubble('assistant', p.text);
          }
        } else if (p.kind === 'thinking') {
          if (last && !p.done) {
            // Reconnected mid-thinking: keep the block live so further deltas flow in.
            currentThinking = makeThinkingEl(p.text || '', true);
            thinkingText = p.text || '';
            chatLog.appendChild(currentThinking);
            startSpin();
            scrollBottom();
          } else if (p.text) {
            chatLog.appendChild(makeThinkingEl(p.text, false));
            scrollBottom();
          }
        } else {
          renderToolPart(p);
        }
      }
    }

    function showToast(message, level) {
      const t = document.createElement('div');
      t.className = 'toast ' + (level || 'info');
      t.textContent = message;
      document.body.appendChild(t);
      setTimeout(function () { t.remove(); }, 4000);
      recordNotif(message, level);
    }

    // Keep the last ~20 toasts (newest first) for the bell's history dropdown.
    function recordNotif(message, level) {
      notifHistory.unshift({message: message, level: level || 'info', ts: Date.now()});
      if (notifHistory.length > 20) notifHistory.pop();
      renderNotifList();
    }
    function renderNotifList() {
      if (!notifHistory.length) {
        notifList.innerHTML = '<div id="notif-empty">No notifications yet.</div>';
        return;
      }
      var html = '';
      for (var i = 0; i < notifHistory.length; i++) {
        var n = notifHistory[i];
        html += '<div class="notif-item ' + escHtml(n.level) + '">'
          + '<span class="notif-dot"></span>'
          + '<span class="notif-msg">' + escHtml(n.message) + '</span>'
          + '<span class="notif-time">' + fmtClock(n.ts) + '</span></div>';
      }
      notifList.innerHTML = html;
    }

    let notifOpen = false;
    function setNotifOpen(open) {
      notifOpen = open;
      notifPanel.classList.toggle('open', open);
      notifPanel.setAttribute('aria-hidden', open ? 'false' : 'true');
      if (open) { renderNotifList(); updateNotifToggle(); }
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
      updateNotifToggle();
    }
    function updateNotifToggle() {
      var on = notifyEnabled();
      notifToggle.textContent = on ? 'On' : 'Enable';
      notifToggle.classList.toggle('on', on);
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

    // The bell opens the notification dropdown (history + push toggle); the push
    // enable/disable lives on the toggle inside it.
    bell.addEventListener('click', function (e) {
      e.stopPropagation();
      setNotifOpen(!notifOpen);
    });
    document.addEventListener('click', function (e) {
      if (notifOpen && !notifPanel.contains(e.target) && e.target !== bell) setNotifOpen(false);
    });

    function togglePush() {
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
    }
    notifToggle.addEventListener('click', togglePush);

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
      activeRecommended2 = '';
      if (cancelArmTimer) { clearTimeout(cancelArmTimer); cancelArmTimer = null; }
      refreshComposer();
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

    function renderButtons(buttons, stacked) {
      promptButtons.className = stacked ? 'row stacked' : 'row';
      promptButtons.innerHTML = '';
      for (let i = 0; i < buttons.length; i++) promptButtons.appendChild(buttons[i]);
      promptButtons.appendChild(makeCancelBtn());
    }

    // Manual-entry view: empty textarea + Submit, reachable from the
    // recommendation view via "Manual answer".
    function showManualEntry() {
      promptRec.style.display = 'none';
      promptInput.style.display = 'block';
      promptInput.value = '';
      renderButtons([
        makeBtn('Submit', 'primary', function () { answer(promptInput.value); }),
        makeBtn('← Back', 'secondary', function () { showRecommendation(); })
      ]);
      promptInput.focus();
    }

    // Recommendation view: 2-button mode when both options present, panel mode for one.
    function showRecommendation() {
      promptInput.style.display = 'none';
      const buttons = [];
      if (activeRecommended2) {
        // Two-option mode: each recommendation is a direct-accept button.
        promptRec.style.display = 'none';
        buttons.push(makeBtn(activeRecommended, 'primary', function () { answer(activeRecommended); }));
        buttons.push(makeBtn(activeRecommended2, 'secondary', function () { answer(activeRecommended2); }));
        buttons.push(makeBtn('✎ Manual answer', 'secondary', function () { showManualEntry(); }));
        // Answer buttons hold full sentences — stack them so long text stays readable.
        renderButtons(buttons, true);
        return;
      }
      // Single recommendation: show it in the green panel.
      promptRec.style.display = 'block';
      buttons.push(makeBtn('✓ Accept', 'primary', function () { answer(activeRecommended); }));
      buttons.push(makeBtn('✎ Manual answer', 'secondary', function () { showManualEntry(); }));
      renderButtons(buttons);
    }

    function showPrompt(msg) {
      activePromptId = msg.id;
      promptQ.textContent = msg.question;
      activeRecommended = msg.recommended || '';
      activeRecommended2 = msg.recommended2 || '';
      if (msg.recommended) {
        // Mode A: recommendation(s) present. Render markdown in the panel so a
        // recommendation with code/emphasis reads the same as an assistant bubble.
        setContent(promptRecText, msg.recommended);
        showRecommendation();
      } else {
        // Mode B: no recommendation — the user must type an answer (or skip).
        promptRec.style.display = 'none';
        promptInput.style.display = 'block';
        promptInput.value = '';
        const buttons = [makeBtn('Submit', 'primary', function () { answer(promptInput.value); })];
        if (msg.allowSkip) {
          buttons.push(makeBtn('Skip', 'secondary', function () { answer(''); }));
        }
        renderButtons(buttons);
        promptInput.focus();
      }
      promptCard.style.display = 'block';
      refreshComposer();
    }

    function handleMsg(msg) {
      switch (msg.type) {
        case 'snapshot': {
          // Authoritative full state on every (re)connect: replace the WHOLE view.
          // This is what kills duplicated transcript / stale-orphaned widgets —
          // whatever was on screen is discarded and rebuilt from server truth.
          chatLog.innerHTML = '';
          closePrompt();
          hideThinking();
          currentThinking = null; thinkingText = '';
          currentBubble = null; streamText = '';
          for (const k in toolCallMap) delete toolCallMap[k];
          // Per-turn try/catch: one malformed turn must never abort the rebuild
          // and leave the (already-cleared) transcript blank.
          for (const t of (msg.turns || [])) { try { renderTurn(t); } catch (e) {} }
          if (msg.live) { try { renderLiveTurn(msg.live); } catch (e) {} }
          taskWidgetLines = (msg.taskWidget && msg.taskWidget.length) ? msg.taskWidget : null;
          taskWidgetData = msg.taskWidgetData || null;
          renderWidgets();
          setModelName(msg.model);
          if (msg.context) setContextBar(msg.context); else contextFill.style.width = '0%';
          agentRunning = !!msg.agentRunning;
          turnHadContent = !!(msg.live && msg.live.parts && msg.live.parts.length);
          if (msg.prompt) showPrompt(msg.prompt);
          refreshComposer();
          if (msg.agentRunning && !msg.live) showThinking();
          break;
        }
        case 'agent_start':
          autoScroll = true;
          streamText = '';
          currentBubble = null;
          turnHadContent = false;
          agentRunning = true;
          setModelName(msg.model);
          refreshComposer();
          showThinking();
          break;
        case 'thinking_delta':
          turnHadContent = true;
          hideThinking(); // drop the spinner-only bubble
          if (!currentThinking) {
            currentThinking = makeThinkingEl('', true);
            chatLog.appendChild(currentThinking);
            thinkingText = '';
            startSpin();
          }
          thinkingText += msg.delta;
          currentThinking.querySelector('.thinking-body').textContent = thinkingText;
          currentThinking.querySelector('.thinking-label').textContent =
            thinkingSummary(thinkingLineCount(thinkingText));
          scrollBottom();
          break;
        case 'thinking_end':
          finalizeThinking();
          // Model moves to text/tool next — show the spinner meanwhile.
          showThinking();
          break;
        case 'text_delta':
          turnHadContent = true;
          if (!currentBubble) {
            hideThinking();
            finalizeThinking();
            currentBubble = document.createElement('div');
            currentBubble.className = 'bubble assistant';
            const cursor = document.createElement('span');
            cursor.className = 'cursor spin';
            currentBubble.appendChild(cursor);
            chatLog.appendChild(currentBubble);
            startSpin();
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
            if (streamText) { setContent(currentBubble, streamText); attachBubbleCopy(currentBubble, streamText); }
            // Close this message's bubble so the next text segment (after a tool or
            // the next message) starts a fresh bubble — matching the terminal.
            currentBubble = null;
            streamText = '';
            stopSpinIfIdle();
          }
          break;
        case 'tool_start': {
          turnHadContent = true;
          hideThinking();
          finalizeThinking();
          const d = addToolCall(msg.toolName, msg.args, false);
          const sp = document.createElement('span');
          sp.className = 'tool-spin spin';
          d.querySelector('summary').appendChild(sp);
          startSpin();
          toolCallMap[msg.toolCallId] = d;
          break;
        }
        case 'tool_end': {
          const d = toolCallMap[msg.toolCallId];
          if (d) {
            const sp = d.querySelector('.tool-spin');
            if (sp) { sp.remove(); stopSpinIfIdle(); }
            if (msg.isError) d.classList.add('error');
            appendElapsed(d, msg.elapsedMs);
            const pre = document.createElement('pre');
            pre.textContent = toolResultText(msg.result);
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
          addTurnTime(Date.now(), 'user');
          break;
        case 'system_note':
          addSystemLine(msg.text);
          addTurnTime(Date.now(), 'system');
          break;
        case 'agent_error':
          hideThinking();
          finalizeThinking();
          if (currentBubble) {
            const c = currentBubble.querySelector('.cursor');
            if (c) c.remove();
            if (streamText) { setContent(currentBubble, streamText); attachBubbleCopy(currentBubble, streamText); }
            currentBubble = null;
            streamText = '';
            stopSpinIfIdle();
          }
          addBubble('error', msg.message || 'Error');
          if (turnHadContent) addTurnTime(Date.now(), 'assistant');
          turnHadContent = false;
          agentRunning = false;
          refreshComposer();
          break;
        case 'agent_end':
          hideThinking();
          finalizeThinking();
          currentBubble = null;
          streamText = '';
          if (turnHadContent) addTurnTime(Date.now(), 'assistant');
          turnHadContent = false;
          agentRunning = false;
          setModelName(msg.model);
          refreshComposer();
          setContextBar(msg.contextUsage);
          break;
        case 'context':
          // Seeds the bar for a client that joined mid-session.
          setContextBar(msg.contextUsage);
          break;
        case 'prompt':
          showPrompt(msg);
          break;
        case 'prompt_resolved':
          if (activePromptId === msg.id) closePrompt();
          break;
        case 'widget':
          taskWidgetLines = (msg.lines && msg.lines.length) ? msg.lines : null;
          taskWidgetData = msg.data || null;
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
          finalizeThinking();
          currentBubble = null; streamText = '';
          turnHadContent = false;
          closePrompt();
          agentRunning = false;
          refreshComposer();
          taskWidgetLines = null;
          taskWidgetData = null;
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
      // The server records the message via addUserTurn and broadcasts a
      // user_message back to every client (us included), which renders the
      // bubble. Don't render it here too, or the sender sees it twice.
      // Mid-run the message steers the live turn (no state change here); when
      // idle, optimistically show the spinner until agent_start lands.
      if (!agentRunning) showThinking();
    }

    sendBtn.addEventListener('click', onSendClick);
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
      // Capture the socket locally so a superseded socket's late events (a
      // delayed 'close' after we already opened a replacement) can't touch the
      // overlay or schedule a second reconnect — every handler bails unless it's
      // still the current socket.
      const sock = new WebSocket(WS_URL);
      ws = sock;
      sock.addEventListener('open', () => {
        if (ws !== sock) return;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        if (reconnectAnim) { clearInterval(reconnectAnim); reconnectAnim = null; }
        reconnectOverlay.classList.remove('visible');
        reconnectDelay = 1000;
        connected = true;
        refreshComposer();
        // Self-heal on every (re)connect, not just page load: if the server
        // restarted it may have lost (or be rehydrating) our subscription, and
        // browsers can rotate it. Re-registering here covers reconnects the
        // disk-persisted server store can't see yet. The server dedupes by
        // endpoint, so a redundant re-POST is harmless.
        if (notifyEnabled()) { subscribePush().catch(function () {}); }
      });
      sock.addEventListener('message', (e) => {
        if (ws !== sock) return;
        try { handleMsg(JSON.parse(e.data)); } catch {}
      });
      sock.addEventListener('close', () => {
        if (ws !== sock) return;
        connected = false;
        refreshComposer();
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
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          reconnectDelay = Math.min(reconnectDelay * 2, 30000);
          connect();
        }, reconnectDelay);
      });
    }

    // Reconnect immediately instead of waiting out the exponential backoff. A
    // phone that backgrounds the PWA throttles our retry timer and the radio
    // drops, so by the time it foregrounds reconnectDelay can be pinned at 30s —
    // leaving the user staring at a spinner (over an already-updated question)
    // while the server is reachable RIGHT NOW. Returning to the tab, regaining
    // network, or refocusing the window should all retry at once. No-op if a
    // socket is already open or a connect is in flight.
    function connectNow() {
      if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      reconnectDelay = 1000; // a deliberate return shouldn't inherit a stale 30s backoff
      connect();
    }
    document.addEventListener('visibilitychange', () => { if (!document.hidden) connectNow(); });
    window.addEventListener('online', connectNow);
    window.addEventListener('focus', connectNow);

    // Pin the column to window.innerHeight (a stable px value) instead of letting
    // it ride 100dvh, which iOS Safari interpolates DURING the rotation animation
    // and makes the whole layout resize repeatedly ("spazzing out"). A rotation
    // also fires several resize events and changes scrollHeight, so coalesce the
    // updates in one rAF and re-pin to the bottom when the user was already there.
    let appHeightRaf = null;
    let appHeightPin = false;
    function setAppHeight() {
      const h = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
      document.documentElement.style.setProperty('--app-h', h + 'px');
      // Snapshot autoScroll synchronously, before the post-rotation reflow can fire
      // a scroll event that flips it. When several resize events coalesce into one
      // frame, the LATEST snapshot must win — otherwise a stale "was at bottom"
      // capture (e.g. the load-time call, when the empty log counts as at-bottom)
      // would yank a since-scrolled-up reader to the bottom on the next rotate.
      appHeightPin = autoScroll;
      if (appHeightRaf) return;
      appHeightRaf = requestAnimationFrame(function () {
        appHeightRaf = null;
        if (appHeightPin) chatLog.scrollTop = chatLog.scrollHeight;
        updateScrollBtn();
      });
    }
    setAppHeight();
    window.addEventListener('resize', setAppHeight);
    window.addEventListener('orientationchange', setAppHeight);

    connect();`
}
