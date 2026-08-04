<div align="center">

![pi-task — Deterministic Local AI Workflows. Every request runs a fixed pipeline: refine to clarify and structure it, research to gather information in parallel, grill to cross-examine the findings, compose to write the implementation spec, critique to check it for quality and completeness.](https://raw.githubusercontent.com/mjasnikovs/pi-task/main/assets/hero.svg)

# pi-task

**Deterministic spec-orchestration for local models — with bundled web, docs, fetch, and worker sub-agent tools.**

[![npm](https://img.shields.io/npm/v/@mjasnikovs/pi-task?color=cb3837&logo=npm)](https://www.npmjs.com/package/@mjasnikovs/pi-task)
[![license](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](./LICENSE)
[![pi extension](https://img.shields.io/badge/pi-extension-7c3aed)](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
[![tests](https://img.shields.io/badge/tests-2077%20passing-3fb950)](#development)
[![types](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](./tsconfig.json)

</div>

---

## What it does

Local models drift. Ask one to plan a non-trivial change and it skips context, hallucinates APIs, and forgets what you actually asked. `pi-task` fixes this by **not trusting a single prompt** — it drives your request through a fixed, persisted pipeline of small, verifiable steps (shown above), then hands the main session a clean spec to execute.

Every phase boundary is written to `.pi-tasks/TASK_NNNN.md`, so a task survives a crash, a restart, or a `/task-cancel` — pick it back up with `/task-resume`.

## Why it's different

- **Deterministic by construction.** The phase order is fixed code, not a model's free choice. The orchestrator loops over a config table; each phase has one job and one output section.
- **Parallel research, focused output.** The research phase fans out to isolated child agents — one indexing project files, others digging into APIs, context, and tooling — and **verifies tooling claims** before they reach the spec.
- **Context stays clean.** Noisy file/code spelunking, page fetches, and docs lookups run in throwaway child sessions. The parent only ever sees the distilled answer, never the raw page or the 4k-line file.
- **Built for local LLMs.** A loop detector and failure classifier catch the stalls, repetitions, and malformed output that smaller models produce, and retry with sharper emphasis instead of giving up.
- **Crash-safe.** State is a plain Markdown file you can read, diff, and edit by hand.

## Install

```sh
pi install npm:@mjasnikovs/pi-task
```

> Requires [`pi`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) (the Earendil coding agent) ≥ 0.80.

## Quickstart

One change — `/task` runs it through the full pipeline and hands the finished spec back in the same chat:

```
/task add rate limiting to the /api/upload endpoint
```

A whole plan — `/task-auto` splits it into an ordered task list and runs each one through `/task`:

```
/task-auto Implement @MY_DETAILED_AND_LARGE_PLAN.md
```

`@`-mentioning a file inlines its **contents**, so point it at the design doc you already wrote — no copy-paste.

## Slash commands

| Command | What it does |
| --- | --- |
| `/task <prompt>` | Start a new task and run it through the full pipeline. |
| `/task-list` | Open the task list in an editor dialog. |
| `/task-resume [id]` | Resume the most recent (or named) unfinished task. |
| `/task-cancel` | Cancel the running task (soft-terminal — still resumable). |
| `/task-auto <feature>` | Plan a feature into a task list and run each title through `/task` in order (resumable). |
| `/task-auto-resume [--unattended]` | Resume the active `/task-auto` run at the next unfinished task. `--unattended` is the boot-hook form: in-flight runs only. |
| `/task-auto-cancel` | Stop the `/task-auto` loop after the current task (still resumable). |
| `/task-config` | Toggle pi-task settings in an editor dialog: remote control, compress thinking, auto-commit, verify work, enforce guidelines, project tour, command timeout, stuck reply retry, debug logs, and one `ext:` toggle per installed host extension. |
| `/remote` | Show the QR code & URLs for the web view (`/remote stop` to stop). Answer grill questions, start tasks, and watch progress from your phone. |

## The pipeline

<div align="center">

![pi-task pipeline: a /task request runs through refine, research, grill, compose and critique, then the final spec is delivered to your main pi session in the same chat. Every phase boundary is persisted to .pi-tasks/TASK_NNNN.md, so the task is crash-safe and resumable.](https://raw.githubusercontent.com/mjasnikovs/pi-task/main/assets/pipeline.svg)

</div>

| Phase | Output section | What happens |
| --- | --- | --- |
| **refine** | `refined prompt` | Sharpens your raw ask into an unambiguous, self-contained statement. |
| **research** | `research` | Fans out to parallel sub-agents (project files · APIs · domain context · tooling), enriches any referenced packages/URLs/external services with fresh docs, then **verifies tooling claims**. |
| **grill** | `grill Q&A` | Generates the clarifying questions the spec can't be written without — auto-answered from context where possible, surfaced to you where not. |
| **compose** | `spec` | Assembles refined prompt + research + Q&A into a single implementation spec. |
| **critique** | `spec` | Triages the draft; if it isn't already clean, rewrites it. The triage pass skips the expensive rewrite when the draft already holds up. |

The finished spec is delivered to your main `pi` conversation via `sendUserMessage`, so you keep working in the same chat — no context handoff, no copy-paste.

## Orchestrating multiple tasks — `/task-auto`

A real feature is usually several tasks, not one. `/task-auto` is a thin planner on top of the single-task pipeline:

<div align="center">

![/task-auto plans a feature: it clarifies the gray areas, decomposes the answers into an ordered list of task titles written to TASK_AUTO_NNNN.md, then runs each unchecked title through the full /task pipeline one at a time, ticking the box before moving on.](https://raw.githubusercontent.com/mjasnikovs/pi-task/main/assets/task-auto.svg)

</div>

- **It only produces titles.** All the depth — refine, research, grill, compose, critique — is `/task`'s job, run fresh per title. `/task-auto` never researches or specs anything itself.
- **Clarify first.** It asks the few clarifying questions whose answers change how the feature splits, then decomposes the answers into an ordered list of task titles written to `.pi-tasks/TASK_AUTO_NNNN.md`.
- **Sequential, blocking.** Each title runs through `/task` to a spec, the spec is implemented, and the loop waits for that to finish before starting the next title. No overlap.
- **Crash- and cancel-safe.** Progress is the markdown checkboxes in the AUTO file. `/task-auto-resume` (no id) automatically picks up the active run at the first unchecked title. If a title's `/task` run fails, the loop stops and leaves the run resumable.
- **Restart-safe, unattended.** `/task-auto-resume --unattended` is the same resume with no human in the loop — for a boot hook or a container entrypoint. It continues **in-flight** runs only: a `failed` or `cancelled` run stopped for a reason a power cycle does not clear, so it is reported and left alone rather than re-entered against the same wall. Either way the resume banner states exactly what it measured — how long since the run last wrote, and that nothing was rolled back — and attributes no cause, because a stopped host, a hung child, and a slow task look identical from here. Pair it with `restart: unless-stopped` on long-running containers and an overnight outage costs minutes instead of the whole night.
- **One commit per task.** When **auto-commit** is on (the default) and you're in a git repo, the working tree is snapshotted into a single commit after each title passes, so the run produces a clean per-task history. It's best-effort: outside a repo, with nothing to commit, or on any git error, the loop reports the reason and keeps going. Toggle it in `/task-config`.

## Remote — drive a task from your phone

The remote server is **on by default** — it starts automatically with each session, with nothing taking up screen space (disable it in `/task-config`). Run `/remote` any time to pop a QR code and the connection URLs: a **Tailscale** line and a **LAN** line when both are available (the QR encodes the Tailscale-preferred one). Open the URL on any device that can reach the host and you get a live view of the session: streaming output, tool calls, and the `/task` status block (phase, elapsed, context). It's bidirectional — the browser can:

- **Answer grill / `/task-auto` clarify questions.** Each question appears as a card with the recommended default pre-filled (Accept), a free-text box (Submit), Skip, or Cancel task.
- **Start and control tasks.** Type `/task …`, `/task-auto …`, `/task-cancel`, `/task-resume`, etc. — they run on the host.
- **Send plain messages** to the agent.

Prompts use a **first-answer-wins race**: the same question shows in the local TUI *and* every connected browser, and whoever answers first wins — the other surfaces dismiss. With nobody connected, `/task` behaves exactly as before; the remote path is purely additive.

### Push notifications

Tap the bell (◯ → ◉) in the remote header to get pushed a notification — even with the app backgrounded or the phone locked — when:

- a **grill / clarify question** needs answering (*"pi needs your input"*),
- a **task finishes** (*"Task finished"*), or
- the agent hits an **error** (*"Agent error"*).

Delivery is **server → push service → device** over the [Web Push](https://developer.mozilla.org/en-US/docs/Web/API/Push_API) standard (service worker + VAPID), so it reaches a suspended device. It works on desktop browsers and on iOS home-screen PWAs.

**iOS setup** (these are Apple's requirements, not ours):

1. Open the **HTTPS** Tailscale URL (`/remote` lists it). iOS only allows push from a secure context — the plain `http://` LAN URL won't work.
2. **Share → Add to Home Screen**, then open the app from that icon. iOS only permits notifications for installed PWAs.
3. Launch the app, **tap the bell**, and **Allow** when prompted.

Subscriptions are mirrored to `${XDG_DATA_HOME:-~/.local/share}/pi-task/subscriptions.json` and reloaded on startup, so they survive a full `pi` restart — the server keeps reaching a backgrounded device without waiting for it to re-register. Notifications are suppressed while the app is focused in the foreground — the in-page UI already shows the prompt there.

VAPID keys are generated once and persisted to `${XDG_DATA_HOME:-~/.local/share}/pi-task/vapid.json` (deleting them invalidates existing subscriptions). The JWT contact (`sub`) defaults to the project URL; override it with `PI_REMOTE_PUSH_SUBJECT` (e.g. your own `mailto:you@domain.com`). To debug delivery, set `PI_REMOTE_PUSH_DEBUG=1` and tail `/tmp/pi-task-push.log` — it records each push and the **push-service HTTP status** (`201` delivered, `403`/`400` token/key problem, `410` stale subscription).

`/remote stop` shuts the server down for the rest of the session (it comes back on the next session start). There is **no authentication** — it's a personal LAN/Tailscale tool. Don't expose the port to untrusted networks.

## Bundled tools

`pi-task` also registers four MCP-style worker tools (formerly `@mjasnikovs/pi-worker`). All are parallel-execution-capable, so the parent session can issue several calls in one turn.

### `pi-worker`
Spawns an isolated child `pi --print` session with read + bash tools. Use it for noisy file/code work that would otherwise flood the main context.

### `pi-worker-search`
Runs a web search and returns a compact markdown list (title · URL · snippet). Use it to discover candidate URLs before fetching. The search engine is set in `/task-config` (default: **Exa**):

| Provider | Key required? |
| --- | --- |
| **Exa** (default) | No |
| **DuckDuckGo** | No |
| **Brave** | Yes — `BRAVE_SEARCH_API_KEY` (also accepted as `BRAVE_API_KEY`). Grab a free key at [api.search.brave.com/app/keys](https://api.search.brave.com/app/keys). |

### `pi-worker-fetch`
Fetches a URL, cleans HTML to markdown ([Readability](https://github.com/mozilla/readability) + [Turndown](https://github.com/mixmark-io/turndown)), then hands it to an isolated child that extracts **only** the content answering your `query`. The parent never sees the raw page.

- HTML is cleaned; text formats (plain text, markdown, JSON, XML/feeds, `llms.txt`, …) pass through verbatim. Binary responses — PDFs, images, octet-streams — return a clear error.
- Bodies over 2 MB are rejected.
- The extraction child runs with `--no-tools` to mitigate visible-text prompt injection.

### `pi-worker-docs`
Resolves an installed npm package, indexes its `.d.ts` files and README into a local SQLite cache, retrieves the most relevant chunks for your `query`, and passes them to an isolated child that extracts the focused answer. Version-pinned to whatever is in your `node_modules`.

- The package must be installed in the project's `node_modules`; otherwise a one-time auto-install into a dedicated cache dir is attempted.
- The first call for a `(package, version)` pair pays a one-time ingestion cost; later calls are FTS-only.
- Cache lives at `${XDG_CACHE_HOME:-~/.cache}/pi-worker/docs.sqlite` — delete it to reset.

## Settings — `/task-config`

Run `/task-config` to toggle pi-task's behavior in an editor dialog. Settings persist to `~/.config/pi-task/config.json`.

| Setting | Default | What it does |
| --- | --- | --- |
| **remote control** | on | The remote UI server (QR code, phone access). Turn off to never start it. |
| **compress thinking** | on | After each message, compresses the model's `<think>` blocks down to the decisions/constraints/facts that matter later — keeping long local-model runs from drowning their own context in self-talk. |
| **auto-commit** | on | Snapshots the working tree into one git commit per `/task-auto` sub-task (see above). |
| **verify work** | on | After each `/task` (and `/task-auto` task) implements — but **before** it's checked off or committed — actually **runs** the spec's own `VERIFY` block in the real workspace. pi-task otherwise only _authors_ a VERIFY block and never executes it, so a task that doesn't build is indistinguishable from one that works. A fresh `read` + `bash` child of the same local model runs the declared check, observes the real output, and reports **PASS/FAIL** (a legitimately no-op VERIFY is a PASS). On FAIL the run doesn't dead-stop: you get a boxed picker — **Autofix** (re-run the implementation turn against the failure, then re-verify; no attempt cap) or **Accept** (override a misjudged artifact) — and dismissing it pauses the run, resumable. A genuine clean pass is also the behavioral signal that lets **enforce guidelines** fix in place (see below). |
| **enforce guidelines** | on | After each `/task` (and `/task-auto` task) is committed, re-checks that commit's work against the project's `AGENTS.md` / `CLAUDE.md` (in the working directory). A bare fix-in-place pass trashes working code (A/B-proven), so enforcement is gated on the **verify work** signal. **With** a genuine verify pass: a fresh `read` + `edit` child of the same local model reads the **last commit's** diff and fixes violations in place; its fixes are committed **separately** as an `ENFORCE GUIDELINES` commit, then the verify signal is re-run against the enforced tree — a regression **reverts** the enforce commit and keeps the verified work. **Without** that signal (verify off, no spec, or an accept-override): the pass runs read-only and only **reports** violations, never rewrites logic. Either way a violation it can't clear (or a pass that can't run) only **warns** — the task commit already landed, so the run continues. Skipped when nothing was committed for the task. |
| **project tour** | on | Pre-reads the project's core files (manifest, config, domain types, schema, entrypoints, API surface) once and hands the contents to the read-heavy research workers, so they skip re-discovering the same files cold. Bounded by a hard byte budget; applied only where it helps (FILES/APIS workers). |
| **parallel research** | off | Run the four research workers concurrently instead of one at a time. Leave off on a single-GPU local backend (concurrent streams split the GPU and slow each other down); turn on only for a parallel-capable model server. |
| **research cache** | on | Cache docs/search/fetch worker results for the duration of one `/task-auto` run so sibling tasks re-asking the same package/URL + query reuse the first pipeline's digest instead of re-fetching. Per-run isolated, external-only (project-source `.` lookups excluded), success-only. |
| **search engine** | Exa | Engine behind `pi-worker-search` and freshness/enrichment checks. **Exa** (default) and **DuckDuckGo** need no API key; **Brave** requires `BRAVE_SEARCH_API_KEY`. |
| **command timeout** | 15 min | Wall-clock ceiling on a **single** tool execution. Local models routinely run a command that never returns (a hung build, a dev server, a check with no timeout) and the run wedges until you abort by hand — pi's bash tool has an optional timeout with no default, so this is the missing one. One knob, two surfaces: in the main session the overrun call is cancelled (killing the tool's whole process tree) plus a reminder turn; in the verify/fix gate children the child is killed and re-spawned with a hint, halving the ceiling on repeat hangs. Choices: 5/10/15/30 min or **off** — off unguards both surfaces, gates included. |
| **stuck reply retry** | 10 min | Inactivity ceiling on the **model stream**. A hung or silently-dropped stream throws nothing at all, so neither the connection-error retry (it needs a reported error) nor the **command timeout** (tool calls only) nor the dead-backend stall guard (a reachable endpoint reads as proof of life) can see it — an mx5 run lost ~2.9h to three of them while the model server stayed healthy. Measured as time since the **last stream event of any kind**, so a slow model emitting one token every 30s is never touched, and it pauses while a tool runs. On expiry the main session aborts the turn (through the same channel the command watchdog uses) and posts a resume reminder; a child is killed and routed into the existing connection-error retry. Choices: 5/10/20/30 min or **off**. Keep it generous on local backends — prompt processing on a large context legitimately emits nothing for minutes. |
| **yolo mode** | off | **Unattended runs.** Wherever pi-task would stop and ask, it takes the option already marked RECOMMENDED, stamps the artifact `(YOLO)` so an audit can tell a machine decided, and shows no prompt at all — clarify/grill answers, the verify-FAIL picker (auto-**Accept**, recorded as a yolo debt), and the final-gate picker (autofix while the budget lasts, then leave the run FAILED). A question with no recommendation is **skipped**, never invented. For throwaway/test projects nobody is watching; a real run should decide these itself. |
| **debug logs** | events | How much of a run is written to `.pi-tasks/*-debug.log`. **`events`** keeps decisions and guard actions — which phase ran, why a worker was retried, what the git-state guard restored, what a write-capable child changed on disk, why a gate returned FAIL — a few lines per task. **`full`** adds every line the child model emitted and every tool result; that's ~85% of the bytes (a real 247 KB `verify-debug.log` is 1315 lines, 521 of them tool dumps) and is what you want while actively debugging. **`off`** writes nothing. Nothing in pi-task ever reads these files back, so the setting cannot change how a run behaves — only whether you can explain it afterwards, and a log not written can't be recovered later. |
| **ext: …** | all off | One toggle per installed host `pi` extension, loading it into every child session by explicit path. Children otherwise run with extensions off, so a provider registered by an extension (e.g. `pi-lmstudio`) doesn't exist in them and they can't resolve the default model. Children also inherit the extension's tools and hooks, so only enable ones you trust. The list is strictly additive (discovery stays off), and an entry whose file is gone is skipped at spawn time, never fatal. |

## Configuration

| Variable | Used by | Notes |
| --- | --- | --- |
| `BRAVE_SEARCH_API_KEY` / `BRAVE_API_KEY` | `pi-worker-search`, research enrichment | Required only when the **Brave** search engine is selected in `/task-config`. |
| `XDG_CACHE_HOME` | `pi-worker-docs` | Overrides the docs cache location (defaults to `~/.cache`). |
| `XDG_DATA_HOME` | remote push | Where the VAPID keypair is stored (defaults to `~/.local/share`). |
| `PI_REMOTE_PUSH_SUBJECT` | remote push | VAPID JWT `sub` contact. Defaults to the project URL; set your own `mailto:you@domain.com` or `https://…`. |
| `PI_REMOTE_PUSH_DEBUG` | remote push | When set (e.g. `1`), logs push delivery and push-service HTTP status. Off by default. |
| `PI_REMOTE_PUSH_LOG` | remote push | Path for the debug log (defaults to `/tmp/pi-task-push.log`). |
| `PI_TASK_DEBUG_LOG` | task trail | Overrides the **debug logs** setting for one session: `off`, `events`, or `full`. For reproducing a report without walking someone through `/task-config`. An unrecognised value is ignored, not treated as `off`. |

Tasks are persisted to `<cwd>/.pi-tasks/TASK_NNNN.md`. Add `.pi-tasks/` to your `.gitignore` if you don't want them checked in.

## Development

```sh
bun install
bun run test       # 2078 tests across 129 files
bun run lint       # prettier + eslint + tsc --noEmit
bun run build      # tsc → dist/
```

Built with [Bun](https://bun.sh), TypeScript (strict), and [TypeBox](https://github.com/sinclairzx81/typebox) for tool schemas. Design docs and plans live in [`docs/`](./docs).

## License

[AGPL-3.0-only](./LICENSE) © Edgars Mjasnikovs

Free and open source under the GNU Affero General Public License v3.0: you may
use, modify, and redistribute it, but any modified version you run — **including
over a network as a hosted service** — must make its complete source available
under the same license. Contributions are accepted under the
[Contributor License Agreement](./CLA.md), which allows dual-licensing;
for a commercial license that does not carry the AGPL's copyleft obligations,
contact the author.
