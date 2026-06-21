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
    }
    const reconnectOverlay = document.getElementById('reconnect-overlay');
    const reconnectMsg = document.getElementById('reconnect-msg');
    const cmdSuggestions = document.getElementById('cmd-suggestions');
    const statusPanel = document.getElementById('status-panel');
    // Widgets are keyed (e.g. 'pi-tasks', 'pi-task-auto'); track them per key so a
    // clear for one key can't be masked by a stale message from another.
    // Single authoritative task-widget slot. The snapshot and the live 'widget'
    // delta both set this; null hides the panel. (No more per-key map that could
    // strand an orphaned widget on screen.)
    let taskWidgetLines = null;
    function renderWidgets() {
      if (taskWidgetLines && taskWidgetLines.length) {
        statusPanel.textContent = taskWidgetLines.join('\\n');
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
    let activeRecommended2 = '';
    let cancelArmTimer = null;
    const toolCallMap = {};
    let currentBubble = null;
    let streamText = '';
    let autoScroll = true;
    let reconnectDelay = 1000;
    let reconnectAnim = null;
    let reconnectTimer = null;
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
      setContent(el, text);
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

    function addToolCall(toolName, argsStr, isError) {
      // argsStr can be undefined (no args / JSON.stringify(undefined)); don't let
      // that render as the literal "name: undefined" in the collapsed summary.
      const label = (toolName + (argsStr ? ': ' + argsStr : '')).slice(0, 64);
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
      const argsStr = typeof p.args === 'string' ? p.args : JSON.stringify(p.args);
      const d = addToolCall(p.toolName, argsStr, p.isError);
      if (p.done) {
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
      if (t.error) { addBubble('error', t.text); return; }
      if (t.role === 'system') { addSystemLine(t.text); return; }
      if (t.role === 'user') { addBubble('user', t.text); return; }
      for (const p of (t.parts || [])) {
        if (p.kind === 'text') { if (p.text) addBubble('assistant', p.text); }
        else renderToolPart(p);
      }
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
        // Mode A: recommendation(s) present.
        promptRecText.textContent = msg.recommended;
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
      setEnabled(false);
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
          currentBubble = null; streamText = '';
          for (const k in toolCallMap) delete toolCallMap[k];
          // Per-turn try/catch: one malformed turn must never abort the rebuild
          // and leave the (already-cleared) transcript blank.
          for (const t of (msg.turns || [])) { try { renderTurn(t); } catch (e) {} }
          if (msg.live) { try { renderLiveTurn(msg.live); } catch (e) {} }
          taskWidgetLines = (msg.taskWidget && msg.taskWidget.length) ? msg.taskWidget : null;
          renderWidgets();
          if (msg.context) setContextBar(msg.context); else contextFill.style.width = '0%';
          if (msg.prompt) showPrompt(msg.prompt);
          setEnabled(!msg.agentRunning && !msg.prompt);
          if (msg.agentRunning && !msg.live) showThinking();
          break;
        }
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
            if (streamText) setContent(currentBubble, streamText);
            // Close this message's bubble so the next text segment (after a tool or
            // the next message) starts a fresh bubble — matching the terminal.
            currentBubble = null;
            streamText = '';
            stopSpinIfIdle();
          }
          break;
        case 'tool_start': {
          hideThinking();
          const argsStr = typeof msg.args === 'string' ? msg.args : JSON.stringify(msg.args);
          const d = addToolCall(msg.toolName, argsStr, false);
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
          break;
        case 'system_note':
          addSystemLine(msg.text);
          break;
        case 'agent_error':
          hideThinking();
          if (currentBubble) {
            const c = currentBubble.querySelector('.cursor');
            if (c) c.remove();
            if (streamText) setContent(currentBubble, streamText);
            currentBubble = null;
            streamText = '';
            stopSpinIfIdle();
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
        case 'prompt':
          showPrompt(msg);
          break;
        case 'prompt_resolved':
          if (activePromptId === msg.id) closePrompt();
          break;
        case 'widget':
          taskWidgetLines = (msg.lines && msg.lines.length) ? msg.lines : null;
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
          taskWidgetLines = null;
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
        setEnabled(true);
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
        setEnabled(false);
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

    connect();`
}
