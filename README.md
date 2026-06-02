<div align="center">

# 🧩 pi-task

**Deterministic spec-orchestration for local models — with bundled web, docs, fetch, and worker sub-agent tools.**

[![npm](https://img.shields.io/npm/v/@mjasnikovs/pi-task?color=cb3837&logo=npm)](https://www.npmjs.com/package/@mjasnikovs/pi-task)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![pi extension](https://img.shields.io/badge/pi-extension-7c3aed)](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
[![tests](https://img.shields.io/badge/tests-326%20passing-3fb950)](#development)
[![types](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](./tsconfig.json)

</div>

---

## What it does

Local models drift. Ask one to plan a non-trivial change and it skips context, hallucinates APIs, and forgets what you actually asked. `pi-task` fixes this by **not trusting a single prompt** — it drives your request through a fixed, persisted pipeline of small, verifiable steps, then hands the main session a clean spec to execute.

```
/task add rate-limiting to the public API
        │
        ▼
  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
  │  refine  │──▶│ research │──▶│  grill   │──▶│ compose  │──▶│ critique │
  └──────────┘   └──────────┘   └──────────┘   └──────────┘   └──────────┘
   sharpen the    parallel        clarifying     assemble        triage +
   raw prompt     sub-agents:     questions      the spec        rewrite if
                  files · APIs ·  (auto- or                      the draft
                  context ·       you answer)                    isn't clean
                  tooling
        │
        ▼
  final spec ──▶ main pi session   (you keep working in the same chat)
```

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

> Requires [`pi`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) (the Earendil coding agent) ≥ 0.75.

## Slash commands

| Command | What it does |
| --- | --- |
| `/task <prompt>` | Start a new task and run it through the full pipeline. |
| `/task-list` | Open the task list in an editor dialog. |
| `/task-resume [id]` | Resume the most recent (or named) unfinished task. |
| `/task-cancel` | Cancel the running task (soft-terminal — still resumable). |

## The pipeline

| Phase | Output section | What happens |
| --- | --- | --- |
| **refine** | `refined prompt` | Sharpens your raw ask into an unambiguous, self-contained statement. |
| **research** | `research` | Fans out to parallel sub-agents (project files · APIs · domain context · tooling), enriches any referenced packages/URLs/external services with fresh docs, then **verifies tooling claims**. |
| **grill** | `grill Q&A` | Generates the clarifying questions the spec can't be written without — auto-answered from context where possible, surfaced to you where not. |
| **compose** | `spec` | Assembles refined prompt + research + Q&A into a single implementation spec. |
| **critique** | `spec` | Triages the draft; if it isn't already clean, rewrites it. The triage pass skips the expensive rewrite when the draft already holds up. |

The finished spec is delivered to your main `pi` conversation via `sendUserMessage`, so you keep working in the same chat — no context handoff, no copy-paste.

## Bundled tools

`pi-task` also registers four MCP-style worker tools (formerly `@mjasnikovs/pi-worker`). All are parallel-execution-capable, so the parent session can issue several calls in one turn.

### `pi-worker`
Spawns an isolated child `pi --print` session with read + bash tools. Use it for noisy file/code work that would otherwise flood the main context.

### `pi-worker-search`
Runs a Brave Search query and returns a compact markdown list (title · URL · snippet). Use it to discover candidate URLs before fetching.

> **Requires** `BRAVE_SEARCH_API_KEY` (also accepted as `BRAVE_API_KEY`). Grab a free key at [api.search.brave.com/app/keys](https://api.search.brave.com/app/keys).

### `pi-worker-fetch`
Fetches a URL, cleans the HTML to markdown ([Readability](https://github.com/mozilla/readability) + [Turndown](https://github.com/mixmark-io/turndown)), then hands it to an isolated child that extracts **only** the content answering your `query`. The parent never sees the raw page.

- Only `text/html` responses — PDFs, JSON, etc. return a clear error.
- Bodies over 2 MB are rejected.
- The extraction child runs with `--no-tools` to mitigate visible-text prompt injection.

### `pi-worker-docs`
Resolves an installed npm package, indexes its `.d.ts` files and README into a local SQLite cache, retrieves the most relevant chunks for your `query`, and passes them to an isolated child that extracts the focused answer. Version-pinned to whatever is in your `node_modules`.

- The package must be installed in the project's `node_modules`; otherwise a one-time auto-install into a dedicated cache dir is attempted.
- The first call for a `(package, version)` pair pays a one-time ingestion cost; later calls are FTS-only.
- Cache lives at `${XDG_CACHE_HOME:-~/.cache}/pi-worker/docs.sqlite` — delete it to reset.

## Configuration

| Variable | Used by | Notes |
| --- | --- | --- |
| `BRAVE_SEARCH_API_KEY` / `BRAVE_API_KEY` | `pi-worker-search`, research enrichment | Required for web search. |
| `XDG_CACHE_HOME` | `pi-worker-docs` | Overrides the docs cache location (defaults to `~/.cache`). |

Tasks are persisted to `<cwd>/.pi-tasks/TASK_NNNN.md`. Add `.pi-tasks/` to your `.gitignore` if you don't want them checked in.

## Development

```sh
bun install
bun test src/      # 326 tests across 28 files
bun run lint       # prettier + eslint + tsc --noEmit
bun run build      # tsc → dist/
```

Built with [Bun](https://bun.sh), TypeScript (strict), and [TypeBox](https://github.com/sinclairzx81/typebox) for tool schemas. Design docs and plans live in [`docs/`](./docs).

## License

[MIT](./LICENSE) © Edgars Mjasnikovs
