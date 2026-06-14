# pi-task — domain vocabulary

The shared language for this codebase. Architecture reviews and design
conversations should use these terms exactly. New deepened modules that name a
concept get that concept recorded here.

## Core concepts

- **Spec** — the deterministic feature description pi-task produces and then
  executes. The output of the phase pipeline.
- **Phase** — one stage of the single-task pipeline: refine → research → grill →
  compose → critique. Phases live in `task/phases.ts` and are driven by the
  orchestrator.
- **Orchestrator** — drives a task through its phases, spawning child pi
  sessions, tracking context/widget state, and persisting for resumability.
  `task/orchestrator.ts` runs a single task; `task/auto-orchestrator.ts` plans a
  feature into many tasks and runs them one at a time.
- **Child pi** — an isolated `pi` process spawned to do bounded work (a phase
  step, a worker lookup). Spawned and parsed through `shared/child-process.ts`
  (`runChild`).

## Worker tools

- **Worker tool** — a tool the main agent calls to gather external context
  without flooding its own context: `pi-worker` (general subagent), `pi-worker-search`
  (Brave web search), `pi-worker-fetch` (fetch + focus a URL), `pi-worker-docs`
  (focused npm/project docs). Each lives in `workers/pi-worker-*.ts`.
- **`makeWorkerTool` (seam)** — the single adapter factory every worker tool
  registers through (`workers/shared.ts`). It owns the registration ritual —
  `registerTool`, parallel execution mode, and wrapping the result in
  `textResult`. Each worker is an **adapter**: a name/label/schema, a `run` that
  returns `{text, details}`, and a `renderCall`. Adding a worker is an adapter,
  not copied boilerplate.
- **Child-failure** — the standard outcome of a worker's child pi failing
  (aborted, or non-zero exit with an stderr tail). Formatted in exactly one
  place, `formatChildFailure` (`workers/shared.ts`), so the rule never drifts
  across workers. Returns `null` when the child succeeded.
- **Focused extractor** — the still-duplicated pattern (in `fetch-core.ts` and
  both `pi-worker-docs.ts` paths) of running a no-tools child that emits
  `<answer>`/`<excerpt>`, then verifying the excerpt. Not yet behind a seam — a
  tracked deepening candidate.

> `pi-worker-search` is the outlier: it is a direct Brave API call with **no
> child pi**, so it registers through `makeWorkerTool` but has no child-failure.
