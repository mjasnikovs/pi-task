export const STYLES = `    :root {
      --base: #1e1e2e; --mantle: #181825; --crust: #11111b;
      --surface0: #313244; --surface1: #45475a; --surface2: #585b70;
      --text: #cdd6f4; --subtext1: #a6adc8; --subtext0: #7f849c;
      --mauve: #cba6f7; --blue: #89b4fa; --green: #a6e3a1; --red: #f38ba8;
      --yellow: #f9e2af; --peach: #fab387; --teal: #94e2d5;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--base); color: var(--text);
      font-family: ui-monospace, monospace;
      /* --app-h is set from window.innerHeight (see setAppHeight) so the column
         height is a stable pixel value across an orientation change. 100dvh is a
         fallback for first paint / no-JS: iOS Safari interpolates dvh during the
         rotation animation, which makes the whole flex column resize repeatedly
         ("spazzing out") — a fixed px height does not. */
      height: var(--app-h, 100dvh);
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
    #header .hgroup { display: flex; align-items: center; gap: 10px; }
    #bell {
      background: none; border: none; color: var(--subtext1); cursor: pointer;
      font-size: 15px; line-height: 1; padding: 2px; font-family: inherit;
    }
    #bell:hover { color: var(--text); }
    #bell.on { color: var(--mauve); }
    /* Header status chip: connection dot + model name + context usage. */
    #status-chip { display: flex; align-items: center; gap: 7px; font-size: 11px; color: var(--subtext0); }
    #status-dot {
      width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
      background: var(--surface2); transition: background 0.2s ease;
    }
    #status-dot.idle { background: var(--green); }
    #status-dot.running { background: var(--mauve); animation: dot-pulse 1.2s ease-in-out infinite; }
    #status-dot.disconnected { background: var(--red); }
    @keyframes dot-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
    @media (prefers-reduced-motion: reduce) { #status-dot.running { animation: none; } }
    #status-model { color: var(--subtext1); }
    #status-model:empty { display: none; }
    #status-ctx { color: var(--subtext0); font-variant-numeric: tabular-nums; }
    #status-ctx:empty { display: none; }
    /* Notification bell dropdown: a push toggle row + the recent-toast history. */
    #notif-panel {
      display: none; position: fixed; z-index: 80;
      top: calc(env(safe-area-inset-top, 0px) + 42px);
      right: calc(env(safe-area-inset-right, 0px) + 12px);
      width: min(320px, calc(100vw - 24px));
      background: var(--mantle); border: 1px solid var(--surface1); border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4); overflow: hidden;
    }
    #notif-panel.open { display: block; }
    #notif-toggle-row {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 12px; border-bottom: 1px solid var(--surface0);
    }
    #notif-title { font-size: 12px; color: var(--subtext1); font-weight: 700; }
    #notif-toggle {
      background: var(--surface1); color: var(--text); border: none; border-radius: 6px;
      padding: 4px 10px; font-family: inherit; font-size: 11px; cursor: pointer;
    }
    #notif-toggle:hover { filter: brightness(1.1); }
    #notif-toggle.on { background: var(--mauve); color: var(--crust); font-weight: 700; }
    #notif-list { max-height: 40dvh; overflow-y: auto; }
    #notif-empty { padding: 14px 12px; color: var(--subtext0); font-size: 11px; text-align: center; }
    .notif-item {
      display: flex; align-items: baseline; gap: 8px; padding: 7px 12px;
      border-bottom: 1px solid var(--surface0); font-size: 12px;
    }
    .notif-item:last-child { border-bottom: none; }
    .notif-item .notif-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; background: var(--blue); align-self: center; }
    .notif-item.warning .notif-dot { background: var(--peach); }
    .notif-item.error .notif-dot { background: var(--red); }
    .notif-item .notif-msg { flex: 1; min-width: 0; color: var(--text); overflow-wrap: anywhere; word-break: break-word; }
    .notif-item .notif-time { flex-shrink: 0; color: var(--subtext0); font-size: 10px; font-variant-numeric: tabular-nums; }
    #chat-wrap { position: relative; flex: 1; min-height: 0; display: flex; }
    #chat-log {
      flex: 1; min-width: 0; overflow-y: auto; overflow-x: hidden; padding: 16px;
      display: flex; flex-direction: column; gap: 8px;
    }
    /* Floating jump-to-latest button — only shown when scrolled away from the
       bottom (toggled via .visible from the scroll handler). */
    #scroll-bottom {
      display: none; position: absolute; bottom: 16px; right: 16px; z-index: 40;
      width: 36px; height: 36px; border-radius: 50%; cursor: pointer;
      background: var(--surface1); color: var(--text); border: 1px solid var(--surface2);
      font-family: inherit; font-size: 18px; line-height: 1; padding: 0;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
    }
    #scroll-bottom:hover { background: var(--surface2); color: var(--mauve); }
    #scroll-bottom.visible { display: block; }
    #chat-log::-webkit-scrollbar { width: 6px; }
    #chat-log::-webkit-scrollbar-track { background: transparent; }
    #chat-log::-webkit-scrollbar-thumb { background: var(--surface2); border-radius: 3px; }
    .bubble {
      max-width: 82%; padding: 8px 12px; border-radius: 8px;
      line-height: 1.6; white-space: pre-wrap; word-break: break-word; font-size: 13px;
    }
    .bubble.user { background: var(--surface1); color: var(--text); align-self: flex-end; }
    .bubble.assistant { background: var(--surface0); color: var(--text); align-self: flex-start; position: relative; }
    .bubble.error {
      background: var(--crust); color: var(--red); align-self: stretch;
      max-width: 100%; border: 1px solid var(--red); font-size: 12px;
    }
    /* Persistent inline system note (e.g. context compaction) — a muted centered
       divider, distinct from chat bubbles. */
    .sysnote {
      align-self: center; color: var(--subtext0); font-size: 11px;
      font-family: ui-monospace, monospace; letter-spacing: 0.5px;
      padding: 2px 10px; opacity: 0.85;
    }
    .bubble.thinking {
      display: flex; gap: 5px; align-items: center; padding: 10px 14px;
    }
    .bubble.thinking .spinner {
      color: var(--mauve); font-size: 15px; line-height: 1;
      font-family: ui-monospace, monospace;
    }
    /* Collapsed reasoning block ("✻ Thinking… (n lines)"), muted + italic. */
    .thinking-block { align-self: flex-start; max-width: 90%; font-size: 12px; }
    .thinking-block > summary {
      color: var(--subtext0); font-style: italic; cursor: pointer; list-style: none;
      user-select: none; display: flex; align-items: center; gap: 8px; padding: 2px 0;
    }
    .thinking-block > summary::-webkit-details-marker { display: none; }
    .thinking-block .thinking-spin {
      color: var(--mauve); font-style: normal; font-family: ui-monospace, monospace;
    }
    .thinking-block .thinking-body {
      color: var(--subtext0); font-style: italic; white-space: pre-wrap;
      word-break: break-word; line-height: 1.5; margin: 4px 0 0 4px;
      padding: 4px 0 2px 12px; border-left: 2px solid var(--surface1);
    }
    /* Copy buttons: on code-block headers and (floating) on finished assistant
       bubbles. Wired by one delegated click handler in the client script. */
    .copy-btn {
      background: transparent; border: none; color: var(--subtext0); cursor: pointer;
      font-family: inherit; font-size: 11px; padding: 2px 6px; border-radius: 4px;
      line-height: 1.4;
    }
    .copy-btn:hover { color: var(--text); background: var(--surface1); }
    .copy-btn.copied { color: var(--green); }
    .bubble-copy {
      position: absolute; top: 4px; right: 4px; opacity: 0;
      background: var(--surface1); transition: opacity 0.12s ease;
    }
    .bubble.assistant:hover .bubble-copy { opacity: 1; }
    /* Touch devices have no hover — keep the button faintly visible. */
    @media (hover: none) { .bubble-copy { opacity: 0.55; } }
    .tool-call {
      background: var(--crust); border-radius: 6px; align-self: flex-start;
      max-width: 90%; font-size: 12px; border: 1px solid var(--surface0);
    }
    .tool-call summary {
      padding: 6px 10px; color: var(--subtext1); cursor: pointer;
      user-select: none; list-style: none;
      display: flex; align-items: center; gap: 8px;
    }
    .tool-call summary::-webkit-details-marker { display: none; }
    .tool-call summary::before { content: "▶"; flex-shrink: 0; font-size: 9px; color: var(--subtext0); }
    .tool-call[open] > summary::before { content: "▼"; }
    .tool-call.error > summary { color: var(--red); }
    /* The summary is a single line: the label ellipsizes (full text in the title
       tooltip / on expand), badges and timing stay pinned to the right. */
    .tool-label {
      flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-family: ui-monospace, monospace;
    }
    .tool-badge { flex-shrink: 0; color: var(--subtext0); font-size: 11px; }
    .tool-elapsed { flex-shrink: 0; color: var(--subtext0); font-size: 11px; }
    .tool-call pre {
      padding: 8px 12px; overflow-y: auto;
      color: var(--subtext1); font-size: 11px; max-height: 280px;
      border-top: 1px solid var(--surface0);
      white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word;
    }
    .tool-spin { color: var(--mauve); flex-shrink: 0; font-family: ui-monospace, monospace; font-size: 13px; }
    /* Line diff for edit/write tools (tints derived from --green/--red). */
    .tool-diff { border-top: 1px solid var(--surface0); overflow-x: auto; }
    .diff { font-family: ui-monospace, monospace; font-size: 11px; padding: 4px 0; }
    .diff-line { white-space: pre; padding: 0 10px; }
    .diff-sign { display: inline-block; width: 1ch; margin-right: 8px; color: var(--subtext0); }
    .diff-add { background: color-mix(in srgb, var(--green) 14%, transparent); color: var(--green); }
    .diff-del { background: color-mix(in srgb, var(--red) 14%, transparent); color: var(--red); }
    .diff-ctx { color: var(--subtext1); }
    .code-block {
      background: var(--crust); border: 1px solid var(--surface0);
      border-radius: 6px; overflow: hidden; margin: 4px 0;
      align-self: stretch; max-width: 100%; font-size: 12px;
    }
    /* Header row above a code block: language label on the left, copy button on
       the right (the surface bar that used to live on .code-lang). */
    .code-head {
      display: flex; align-items: center; justify-content: space-between;
      background: var(--surface0);
    }
    .code-lang {
      color: var(--subtext0); font-size: 10px; padding: 3px 10px; letter-spacing: 0.05em;
    }
    .code-head .copy-btn { padding: 3px 10px; }
    .code-block code {
      display: block; padding: 10px 12px; overflow-x: auto;
      color: var(--text); white-space: pre; line-height: 1.55;
    }
    .hl-kw  { color: var(--mauve); }
    .hl-str { color: var(--green); }
    .hl-cmt { color: var(--subtext0); font-style: italic; }
    .hl-num { color: var(--blue); }
    .hl-fn  { color: var(--yellow); }
    /* Hand-rolled markdown, applied only to assistant bubbles + the recommendation
       panel (both get the .md class from setContent). Block elements lay themselves
       out, so switch off the container's pre-wrap for these. */
    .md { white-space: normal; }
    .md > :first-child { margin-top: 0; }
    .md > :last-child { margin-bottom: 0; }
    .md .md-h { color: var(--mauve); font-weight: 700; line-height: 1.3; margin: 10px 0 4px; }
    .md .md-h1 { font-size: 1.35em; }
    .md .md-h2 { font-size: 1.2em; }
    .md .md-h3 { font-size: 1.08em; }
    .md .md-h4, .md .md-h5, .md .md-h6 { font-size: 1em; }
    .md .md-p { margin: 6px 0; }
    .md .md-list { margin: 6px 0; padding-left: 22px; }
    .md .md-list li { margin: 2px 0; }
    .md .md-task { list-style: none; margin-left: -22px; }
    .md .md-check { color: var(--green); }
    .md .md-quote { border-left: 3px solid var(--surface2); margin: 6px 0; padding: 2px 0 2px 10px; color: var(--subtext1); }
    .md .md-hr { border: none; border-top: 1px solid var(--surface1); margin: 10px 0; }
    .md a { color: var(--blue); text-decoration: underline; }
    .md strong { color: var(--text); font-weight: 700; }
    .md em { font-style: italic; }
    .md del { color: var(--subtext0); }
    .md .md-code {
      background: var(--crust); border: 1px solid var(--surface0);
      border-radius: 4px; padding: 1px 4px; font-size: 0.92em;
    }
    .md .md-table { border-collapse: collapse; margin: 8px 0; font-size: 0.95em; display: block; overflow-x: auto; }
    .md .md-table th, .md .md-table td { border: 1px solid var(--surface1); padding: 4px 8px; text-align: left; }
    .md .md-table th { background: var(--surface0); color: var(--subtext1); }
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
    /* While the agent runs, Send becomes a red Stop; the armed (tap-to-confirm)
       state brightens it and adds a halo, mirroring the prompt card's cancel. */
    #send.stop { background: var(--red); color: var(--crust); }
    #send.stop.armed {
      filter: brightness(1.12);
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--red) 45%, transparent);
    }
    #reconnect-overlay {
      display: none; position: fixed; inset: 0;
      background: rgba(30,30,46,0.88); color: var(--subtext1);
      justify-content: center; align-items: center;
      font-size: 13px; z-index: 100; letter-spacing: 0.03em;
    }
    #reconnect-overlay.visible { display: flex; }
    /* Trailing stream indicator: the same braille spinner as the thinking bubble,
       inline at the end of the streaming text (not a green blinking block). */
    .cursor {
      color: var(--mauve); margin-left: 2px;
      font-family: ui-monospace, monospace;
    }
    #status-panel { padding: 6px 12px; border-bottom: 1px solid var(--surface1);
      color: var(--subtext1); white-space: pre-wrap; font-size: 13px; display: none; }
    /* Structured task widget (progress bar + phase badge + elapsed). Replaces the
       plain text lines when the server sends a structured data payload. */
    #status-panel.structured { white-space: normal; display: block; }
    /* Title gets its own line and wraps (clamped to 2) — never truncated to a stub
       the way the old single-row flex layout squeezed it on narrow/mobile widths. */
    .widget-title { display: -webkit-box; -webkit-box-orient: vertical;
      -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; color: var(--text);
      font-size: 13px; line-height: 1.3; word-break: break-word; }
    .widget-meta { display: flex; align-items: center; gap: 8px; margin-top: 5px; }
    .widget-phase { flex-shrink: 0; background: var(--surface0); color: var(--mauve);
      border-radius: 4px; padding: 1px 7px; font-size: 10px; letter-spacing: 0.03em;
      text-transform: uppercase; }
    .widget-step { flex-shrink: 0; color: var(--subtext0); font-size: 11px;
      font-variant-numeric: tabular-nums; }
    .widget-elapsed { flex-shrink: 0; margin-left: auto; color: var(--subtext0);
      font-size: 11px; font-variant-numeric: tabular-nums; }
    .widget-bar { height: 4px; background: var(--surface0); border-radius: 2px;
      overflow: hidden; margin-top: 6px; }
    .widget-bar-fill { height: 100%; background: var(--mauve); border-radius: 2px;
      transition: width 0.3s ease; }
    /* Current action — the terminal's ↳ worker trailer, one dim ellipsized line. */
    .widget-action { margin-top: 6px; color: var(--subtext0); font-size: 11px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-variant-numeric: tabular-nums; }
    /* Dim per-turn timestamp shown under a committed turn's bubble. */
    .turn-time { font-size: 10px; color: var(--subtext0); opacity: 0.55; padding: 0 4px;
      margin-top: -2px; }
    .turn-time.user { align-self: flex-end; }
    .turn-time.assistant, .turn-time.system { align-self: flex-start; }
    .turn-time.system { align-self: center; }
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
    #prompt-card .row { display: flex; gap: 8px; margin-top: 12px; align-items: stretch;
      flex-wrap: wrap; }
    /* Recommendation answers can be long sentences, so stack them as a readable list. */
    #prompt-card .row.stacked { flex-direction: column; align-items: stretch; }
    #prompt-card .row.stacked button { flex: none; text-align: left; }
    #prompt-card .row.stacked button.cancel { align-self: center; text-align: center; }
    #prompt-card button { padding: 11px 16px; border-radius: 8px; border: none; cursor: pointer;
      font-family: inherit; font-size: 14px; font-weight: 600; transition: filter .15s ease; }
    #prompt-card button:hover { filter: brightness(1.08); }
    #prompt-card button.primary { background: var(--green); color: var(--crust);
      font-weight: 700; flex: 1; min-width: 160px; }
    #prompt-card button.secondary { background: var(--surface1); color: var(--text);
      flex: 1; min-width: 160px; }
    #prompt-card button.cancel { margin-left: auto; align-self: center; background: transparent;
      color: var(--subtext0); font-size: 12px; font-weight: 500; padding: 8px 10px; }
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
    /* Desktop: center the transcript/status/input in a readable column instead of
       hugging the left edge. The scrollbar stays at the true window edge; only the
       content is inset. Mobile (below 960px) is unchanged. */
    @media (min-width: 960px) {
      #chat-log { padding-left: calc((100% - 920px) / 2); padding-right: calc((100% - 920px) / 2); }
      #status-panel { padding-left: calc((100% - 920px) / 2 + 12px); padding-right: calc((100% - 920px) / 2 + 12px); }
      #input-bar { padding-left: calc((100% - 920px) / 2); padding-right: calc((100% - 920px) / 2); }
      #cmd-suggestions { left: calc((100% - 920px) / 2 + 16px); right: calc((100% - 920px) / 2 + 16px); }
    }`
