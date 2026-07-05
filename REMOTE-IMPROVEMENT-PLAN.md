# Remote client: look & feel + UX parity with Claude Code web — HANDOFF

> **Handoff prompt for a fresh session:**
> Implement this plan phase by phase, starting with Phase 0. Every claim in the
> "Validated findings" section was verified against the real code and real
> browser renders on 2026-07-05 — re-verify line numbers before editing (the
> code may have moved), but do not re-litigate the findings. Work
> phase-at-a-time; each phase must land with `bun test` + `bun run lint` +
> `bun run build` green AND screenshot-verified via the preview harness
> (recipe at the bottom — recreate it first, it lived in /tmp). Do not commit
> unless asked. Keep the Catppuccin color scheme: new CSS may only use the
> existing `:root` vars in `src/remote/ui-styles.ts` (or alpha/`color-mix`
> tints of them).

## Context

The pi-task remote web client (`src/remote/`) works, but its in-conversation
UX is far behind the official Claude Code web/mobile client. Goal: parity in
look-and-feel and interaction for the clusters the user selected —
**rendering parity, interaction parity, status & lifecycle** — with the
existing color scheme kept.

Decisions already made by the user (do not re-ask):
- Scope: rendering + interaction + status clusters. **Session management is
  deferred** (history beyond the 20-turn buffer, browsing past sessions,
  transcript search), as are auth, multi-session, and Claude-Code-cloud-only
  features (VMs, GitHub proxy, PR creation, teleport).
- Markdown/highlighting: **hand-rolled, zero-dependency** (no marked/highlight.js).
  The client stays a single self-contained HTML string, no build step.

How this was validated: full read of the client (`ui-script.ts` 903 lines,
`ui.ts`, `ui-styles.ts`, `events.ts`, `bridge.ts`, protocol/session-state),
real generated HTML rendered in headless system Chromium with an injected
fake-WebSocket session snapshot (screenshots at 390×844 and 1280×800), plus a
fetched feature inventory of Claude Code on the web (docs.claude.com
`claude-code-on-the-web`).

## Architecture snapshot (as of 2026-07-05)

- Client = one inline HTML string: `src/remote/ui.ts` embeds
  `ui-styles.ts` (CSS string, Catppuccin Mocha vars at lines 1–7) and
  `ui-script.ts` (`clientScript(wsUrl)` — vanilla JS as a template string).
- Server: `server.ts` (HTTP+WS, port 8800–8899, routes `/`, `/ws`, `/sw.js`,
  `/push-key`, `/subscribe`), `session-state.ts` (authoritative state +
  snapshot-on-reconnect), `events.ts` (mirrors pi agent events),
  `bridge.ts` (prompt race local-vs-remote, command dispatch,
  `publishLifecycleNotice`), `push.ts` (web-push/VAPID), `tailscale.ts`.
- Protocol (`protocol.ts`): Server→client: `snapshot, agent_start, text_delta,
  text_end, tool_start, tool_update, tool_end, agent_end, user_message,
  system_note, agent_error, prompt, prompt_resolved, widget, notify, viewer,
  context, reset`. Client→server: `message, prompt_answer`.
- Tests: ~12 files under `src/remote/*.test.ts`, but `ui.test.ts` checks
  template **structure only** — the client JS is never executed by any test
  (which is how finding #1 shipped).

## Validated findings (current defects/gaps)

1. **SHIPPED BUG — code blocks never render.** `setContent`
   (`ui-script.ts:154`) builds its fence regex from a plain string literal in
   which `'[\s\S]'` collapses to `[sS]` (JS drops unknown string escapes), so
   the regex matches **nothing, ever**. Fenced code always displays as literal
   ``` text and the entire syntax highlighter (`ui-script.ts:72–149`) is dead
   code in production. Proof: standalone regex test = 0 matches on a textbook
   fence; DOM dump of a rendered snapshot shows raw fences inside `.bubble`
   divs and zero `.code-block` elements in the chat log.
2. **No markdown rendering.** `**bold**`, `[links](…)`, lists, pipe tables,
   headers render as raw text (confirmed in DOM dump). Only code fences were
   ever *intended* to be transformed.
3. **Input hard-disabled while the agent runs** (`setEnabled(false)` on
   `agent_start`, re-enabled on `agent_end`) — no steering, no queued
   messages, no stop mid-run. Claude Code web supports steering + queueing.
4. **Thinking invisible.** `events.ts` `message_update` handler forwards only
   `text_delta` and `error`; thinking deltas are dropped. Client shows only a
   braille spinner bubble.
5. **Tool calls are raw JSON.** Summary = `toolName + JSON.stringify(args)`
   hard-sliced at 64 chars mid-word (`ui-script.ts:296–308`, `.slice(0, 64)`),
   e.g. `bash: {"command":"bun test src/theme --coverage --reporter=verbo`.
   No diff view for edit/write tools, no elapsed time.
6. **No max-width column** — on a 1280px window the transcript hugs the left
   edge (screenshot-verified). Claude Code centers a readable column.
7. **Status is thin** — context usage is an unlabeled 4px bar (`#context-bar`),
   no numbers/model name; task widget is pre-wrap text lines
   (`#status-panel`); toasts vanish after 4s with no history; no timestamps.
8. **Solid, do not touch:** prompt card UX (green recommended button, stacked
   two-option mode, armed cancel), reconnect overlay + instant reconnect on
   focus/online/visibility, snapshot-on-reconnect rebuild, push notification
   pipeline, iOS rotation/`--app-h` handling.

## Known unknowns (resolve during implementation; each has a verification step)

- Exact pi event variant for thinking deltas (`assistantMessageEvent` types in
  `@earendil-works/pi-coding-agent` — check the host's installed types, the
  live runtime is what matters, see memory: host runtime vs stale local copy).
- Whether `sendUserMessage` during a busy agent steers/queues or throws
  (project memory says the host supports streaming-steer while the mainloop is
  parked; verify live before relying on it).
- Which pi API interrupts a running turn (Stop button); fallback = dispatch
  the registered `/task-cancel` / `/task-auto-cancel` handlers via the bridge.
- Exact arg names of pi's edit/write tools (for diff rendering) — observe a
  real `tool_start` event or read the pi types.

---

## Phase 0 — Fix the dead code-fence renderer (standalone, ship first)

**Files:** `src/remote/ui-script.ts`, new test.

- Replace the broken `RegExp` string construction in `setContent` with a
  line-based fence parser (scan lines for ``` at line start; tolerate an
  unclosed trailing fence — the regex never could). This parser becomes the
  seam for Phase 1's markdown renderer.
- Add a test that actually **executes** the client rendering code (see
  testability seam below) and asserts a fenced block produces `.code-block`
  HTML — the missing class of test that let this ship.

## Phase 1 — Rendering parity

### Testability seam (do this first, everything else builds on it)
Split pure rendering logic out of the 900-line template string into new
template-string modules whose generated JS defines **pure string→HTML
functions**, concatenated into the page by `ui.ts` before `clientScript`:

- `src/remote/ui-render.ts` — `renderMarkdown(text)`, `escHtml`, fence parser.
- `src/remote/ui-highlight.ts` — generalized `syntaxHighlight(code, lang)`.
- `src/remote/ui-tools.ts` — `toolSummary(toolName, args)`,
  `renderDiff(oldText, newText)`.

Tests evaluate each module's emitted string with `new Function(...)` and
assert on returned HTML — no DOM needed. `ui-script.ts` keeps only
wiring/state/WS handling.

### Markdown (hand-rolled subset)
Headers, bold/italic/strikethrough, inline code, links (`<a target="_blank">`),
ordered/unordered lists, task-list checkboxes, blockquotes, `---` rules, pipe
tables, fenced code (lang label + highlighting). Applied to **assistant**
bubbles and the recommended-answer panel at `text_end`/snapshot render.
Streaming behavior unchanged: raw text nodes append during the stream, the
finished bubble is re-rendered once at `text_end` (current behavior, now with
markdown). User bubbles stay plain. Styling only via existing vars (`--mauve`
headers/links, `--surface0` table borders, etc.).

### Syntax highlighting for common languages
Generalize the existing single-pass tokenizer: shared string/comment/number
logic parameterized by per-language keyword sets + comment markers — keep
ts/js, add python, shell, json, css, html, sql, go, rust, yaml. Unknown langs
fall back to escaped plain text (as now).

### Tool-call presentation
- `toolSummary`: `bash` → `$ <command>`, `read` → `read <path>`,
  `edit`/`write` → `<path>  +N −M`, `grep`/`find` → pattern + path, fallback =
  current JSON. Kill the 64-char hard slice — CSS `text-overflow: ellipsis`,
  full summary on expand.
- **Diff view**: for edit/write, expanded body shows a line diff of old/new
  args (simple LCS over lines, client-side) with red/green tints derived from
  `--red`/`--green` (low-alpha rgba or `color-mix`). `+N −M` badge in summary.
- Add `elapsedMs` to `tool_end` + snapshot tool parts (server:
  `session-state.ts` records the `startTool` timestamp); show dimly in the
  finished summary.

### Layout
Center `#chat-log` content, `#status-panel`, and `#input-bar` contents in a
`max-width: 920px` column on desktop; mobile unchanged. Keep bubble 82%/90%
max-widths within the column.

**Files:** new `ui-render.ts`/`ui-highlight.ts`/`ui-tools.ts` (+ tests),
`ui-script.ts`, `ui-styles.ts`, `ui.ts`, `session-state.ts`, `protocol.ts`.

## Phase 2 — Interaction parity

### Steer / queue while running
Remove the hard input disable during runs; placeholder becomes "message the
agent — delivered mid-run". Server (`register.ts` `onPlain` path): verify live
whether `sendUserMessage` mid-run steers; if it throws/drops, hold the line in
a small queue in `bridge.ts`, flush on `agent_end`, echo a "queued" toast.
Input stays disabled only while a prompt card is open (unchanged).

### Stop button
While running, Send morphs into a red Stop (Claude Code pattern). New
`ClientMessage {type:'interrupt'}` → `server.ts` → `bridge.ts`: use pi's abort
API if the ctx exposes one (spike); fallback: dispatch registered cancel
commands if a task/auto run is active, else toast. Reuse the existing
double-tap-to-confirm pattern from the prompt card's cancel button.

### Thinking display
`events.ts`: forward thinking deltas via new `thinking_delta`/`thinking_end`
protocol messages; `session-state.ts` stores thinking as a part kind so
snapshots replay it. Client: collapsed-by-default `<details>` bubble
("✻ Thinking… (n lines)") in `--subtext0` italic. Keep the spinner-only bubble
when no thinking text arrives.

### Copy to clipboard
Copy button on `.code-block` headers and finished assistant bubbles (hover on
desktop / always visible on touch). `navigator.clipboard` with `execCommand`
fallback for non-secure contexts (plain-HTTP LAN URLs are common here).

**Files:** `ui-script.ts`, `ui-styles.ts`, `ui.ts`, `protocol.ts`,
`events.ts`, `session-state.ts`, `server.ts`, `bridge.ts`, `register.ts`.

## Phase 3 — Status & lifecycle

- **Header status chip**: colored dot (mauve pulsing = running, green = idle,
  red = disconnected) + `62% · 81k/131k` from the existing `contextUsage`
  payload; add model name to `agent_end`/`context`/snapshot if the ctx exposes
  it (spike; omit segment if not). The 4px bar stays.
- **Structured task widget**: extend the `widget` message with optional
  `{title, phase, done, total, elapsed}` alongside `lines` (fallback).
  Producers: the `setTaskWidget` callers in `src/task/` orchestrator +
  auto-orchestrator send both. Client renders a real progress bar (mauve fill
  on `--surface0`), phase badge, elapsed — replacing 3 pre-wrap lines.
- **Timestamps**: `session-state.ts` stamps turns; client shows dim `HH:MM`
  under the last bubble of each turn group, hover elsewhere.
- **Notification history**: client keeps last ~20 toasts in memory; bell gains
  a dropdown listing them (level-colored dots). No server change.

**Files:** `ui-script.ts`, `ui-styles.ts`, `ui.ts`, `protocol.ts`,
`session-state.ts`, `events.ts`, `setTaskWidget` call sites in `src/task/`.

---

## Screenshot preview harness (recreate first — original lived in /tmp)

Promote to `scripts/remote-preview.ts`. Recipe (worked end-to-end on this
machine, system `chromium` at /usr/bin/chromium):

1. Import `html` from `src/remote/ui.ts`, generate the page with a dummy WS
   URL.
2. Splice a stub `<script>` **before** the main `<script>` tag (string-replace
   on `'  <script>'`): define `class FakeWS` (readyState 1, `FakeWS.OPEN = 1`,
   fires `open` async, `send()` no-op, exposes
   `window.__push(m)` → fires a `message` event with `JSON.stringify(m)`),
   assign `window.WebSocket = FakeWS`, and on `load` push a rich fixture
   `snapshot` message. Support `location.hash` modes: `#prompt` also pushes a
   two-recommendation `prompt` message; `#live` pushes `agent_start` +
   `text_delta`.
3. Fixture snapshot must include: a markdown-heavy assistant bubble (bold,
   list, link, pipe table), fenced code in tsx **and** python **and** shell, a
   done `read` tool part, an error `bash` tool part, an `edit` tool part (for
   diff), a `system` note, an error turn, `taskWidget` lines, and
   `context: {percent: 62, tokens: 81000, contextWindow: 131072}`.
4. Screenshot: `chromium --headless --disable-gpu --hide-scrollbars
   --window-size=390,844 --virtual-time-budget=3000 --screenshot=<out.png>
   'file:///tmp/pi-remote-preview.html[#mode]'` — also at 1280×800.
5. Verify DOM when in doubt: same command with `--dump-dom` and grep the
   chat-log region (screenshots alone hid finding #1 behind "looks like text").

## Verification (every phase)

1. `bun test` (984+ pass today) + `bun run lint` + `bun run build`. New
   render/protocol functions all get unit tests, including a Phase-0
   regression test that executes the shipped client string.
2. Preview harness screenshots after each phase: markdown bubble, highlighted
   fences (ts/py/sh), tool summaries + diff, prompt card unchanged, desktop
   centered column, header chip, structured widget.
3. Live e2e at the end of Phase 2: start pi with remote, open the served URL,
   run a real `/task`; verify streaming, thinking block, steer mid-run, Stop,
   copy buttons, reconnect snapshot replays thinking/diff parts, push
   notification still fires on prompt.
4. Color-scheme check: grep new CSS for hex literals — only the existing
   `:root` vars (or tints of them) allowed.

## Sequencing

Phase 0 → 1 → 2 → 3. Each phase lands green and screenshot-verified before the
next. Phase 0 is a shippable one-commit fix on its own.
