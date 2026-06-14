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
  > `runSingleTask`/`TaskRunner` is the shared core: `auto-orchestrator`'s loop
  > calls it per task (`deps.runTask`), so there is no separate "task-runner
  > base" to extract. `PhaseDeps` (phase callbacks) and `AutoDeps`
  > (runChild/runTask/commit) are deliberately different abstractions. Their one
  > real overlap — mirroring child context_usage into the widget — lives in
  > `task/context-usage.ts` (`getParentContextWindow`, `resolveContextUsage`).
- **Child pi** — an isolated `pi` process spawned to do bounded work (a phase
  step, a worker lookup). Spawned and parsed through `shared/child-process.ts`
  (`runChild`).
- **JsonEventSink** — the parser for a child's `--mode json` event stream
  (`shared/child-process.ts`). Holds the cross-chunk line buffer and text
  assembly, turning events into assistant `text` + side effects (caller
  callbacks, loop-kill via an `onLoopKill` signal). Lifted out of `runChild`'s
  closure so event interpretation is unit-testable without spawning a child.
- **External context** — the `EXTERNAL CONTEXT` block the research phase prepends
  to every worker prompt: live npm versions, package docs, fetched URLs, and
  service searches, gathered from targets parsed out of the refined spec.
  Assembled by `gatherExternalContext` (`task/external-context.ts`); target
  parsing is the pure `enrichment.ts`. `phaseResearch` calls it, then runs the
  four research workers (data-driven `workerSpecs`, assembled by `section`).
  > `phaseAutoAnswer` still has its own near-duplicate enrichment block (uses the
  > *focused* worker variants, not the *raw* ones) — a tracked candidate to unify
  > once the focused-extractor seam exists.

## Remote web view

- **Remote client** — the single-page web UI streamed to a browser over
  WebSocket (`remote/`). `ui.ts` composes the page from `ui-markup`-style head +
  `ui-styles.ts` (`STYLES`, the CSS) + `ui-script.ts` (`clientScript(wsUrl)`,
  the vanilla-JS client). The split is for navigability only — the three
  concatenate to a byte-identical page.
  > The client JS ships as a string (there is no bundler). A real
  > transport/state/render split with a Node-unit-testable reducer would need a
  > build step not justified for one screen; until then the client is covered by
  > source string-match tests in `ui.test.ts`.

## Spec validation

- **Spec gate** — the guards that decide whether a composed spec is acceptable
  at handoff: `validateSpecShape` (well-formed GOAL/CONSTRAINTS/ACCEPTANCE/VERIFY
  shape), its partner `stripSpecPreamble`, `parseVerifyBlock` (runnable VERIFY
  commands), and `isCritiqueClean` (critique came back CLEAN). They live in
  `task/spec-validation.ts` — separate from the informational parsers in
  `parsers.ts` (grill questions, clarify list, auto-answer, tooling output,
  title) because the gate answers a yes/no the orchestrator and critique phase
  act on. Self-contained, so the gate doesn't drag in the phase pipeline.

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
