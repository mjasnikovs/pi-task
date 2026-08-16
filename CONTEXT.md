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
- **Plan stage** — one step of `planAuto`, the `/task-auto` planning pipeline:
  ORIENT → ELICIT → DECOMPOSE → COVER → persist. Each is its own function in
  `task/auto-orchestrator.ts`, taking what the earlier stages settled and
  returning what the later ones read (`OrientedFeature`, `DecomposedPlan`,
  `CoveredPlan`), so a stage can be driven on its own instead of through a whole
  plan run. `orientFeature` asks nobody anything — it reads the feature and the
  tree, so the plan-shape fork has a real requirement count to judge with before
  clarify runs. `elicitClarifications` is the ONLY stage that talks to the user,
  and so the only one that can be dismissed (`null` = cancelled, already
  announced). `decomposePlan` returns its own prompt and parser because COVER
  re-prompts with the identical prompt and must reconcile the reply identically —
  rebuilding either is how the two paths drift. `coverPlan` returns the whole
  `ScoredPlan`: `best.accounting` is read as late as the coverage note, and
  splitting the plan from its accounting is a bug this codebase has already had.
  > `planAuto`'s tail is deliberately NOT a stage. The two grounded extractions
  > (contracts, launch scripts) and the four ledger writes are ordered against
  > each other, not against the pipeline. What DID move is the empty-plan guard:
  > it now runs BEFORE the extractions, which used to spend two children and
  > append to two run-level artifacts for a plan that was discarded one line
  > later.
- **Plan session** — the interactive planning loop `/task-plan` runs before a task
  exists (`task/plan-session.ts`). Same adaptive one-question-at-a-time shape as
  grill and clarify, and it reuses their parser, duplicate backstop, picker and
  YOLO policy; what it adds is a control surface where every prompt also offers
  "ask the model a question" and "proceed to execution". Its output is a
  **transcript** of `PlanEntry`s — decisions (authoritative, handed to `/task`)
  and notes (advisory, kept in the plan file only) — persisted to
  `.pi-tasks/TASK_PLAN_NNNN.md` via the same task-file machinery as TASK_AUTO.
  Read-only by contract (`plan-readonly.ts`): planning children run under
  `PLAN_TOOLS` (one tool, `read` — which pi applies to extension tools too), and
  the working tree is diffed around every child so a hole in that prevention is
  reported, never silently tolerated. The contract ends at the handoff.
- **Child pi** — an isolated `pi` process spawned to do bounded work (a phase
  step, a worker lookup). Spawned and parsed through `shared/child-process.ts`
  (`runChild`).
- **Error-triage ladder** — the fixed four-rung verdict a phase applies to a
  finished Child pi: non-zero exit throws, a connection-class error backs off and
  retries, an empty completion retries, a leaked tool call retries with a
  correction hint. One implementation, `triageChildResult`
  (`task/child-runner.ts`); `runPhaseChild` and `runPhaseWithLoopGuard` pass
  their own budget and their own log verb (`retry` vs `restart`, the only
  externally visible difference). Loop-hit detection stays in the wrapper that
  has it, because it must consume the hit *before* the ladder runs.
- **`makeGit` (seam)** — the one git runner (`shared/git-runner.ts`). Returns
  `{stdout, exitCode}` and never throws, carries the abort signal, and takes an
  injectable `spawnFn` so git-touching modules are testable without a repo.
  Async by contract: the sync git callers (`trackedFiles`, `taskThatIntroduced`,
  `rerunDebtVerifyCommand`) are deliberately still their own, because converting
  them would change signatures across the gate. Harness scripts get the matching
  fixture, `scratchRepo` (`scripts/scratch-repo.ts`), which owns temp-dir
  creation, `git init` with one fixed identity, seeding and teardown.
- **JsonEventSink** — the parser for a child's `--mode json` event stream
  (`shared/child-process.ts`). Holds the cross-chunk line buffer and text
  assembly, turning events into assistant `text` + side effects (caller
  callbacks, loop-kill via an `onLoopKill` signal). Lifted out of `runChild`'s
  closure so event interpretation is unit-testable without spawning a child.
- **External context** — the `EXTERNAL CONTEXT` block the research phase prepends
  to every worker prompt: live npm versions, package docs, fetched URLs, and
  service searches, gathered from targets parsed out of the refined spec.
  Assembled by `buildExternalContext` (`task/external-context.ts`); target
  parsing is the pure `enrichment.ts`. `phaseResearch` calls it, then runs the
  four research workers (data-driven `workerSpecs`, assembled by `section`).
  The grill auto-answer builds the same block from the same function — the two
  copies differed only in POLICY (`ExternalContextPolicy`: target/service caps,
  version lookups, timing sub-step, early return) and in the worker variant
  (`ExternalContextLookups`: *raw* workers for research, *focused* ones for
  auto-answer, expressible since the focused-extractor seam landed).
  `gatherExternalContext` is the research-phase binding.
- **Research retry gate** — a deterministic handle inside `runSpec`
  (`task/phases.ts`) that re-runs ONE worker once with a forced preamble and
  keeps the retry only if a named measure improved. There are three, and they
  stay three rather than becoming a row table, because they disagree on the
  thing a table would have to unify: the ZERO-RETRIEVAL and SILENT gates
  DISCARD a failed retry and ship the original, so neither can ever fail the
  phase; the EMPTY-SECTION gate PROPAGATES it, and that is how a worker that
  answers twice with silence becomes a loud failure instead of a quiet empty
  section. The empty-section gate is also the only one with no row field — it
  runs for every worker — and it produces `confirmedEmpty`, which the silent
  gate reads as a precondition and the section body reads as its answer. The
  shared body is five lines behind six varying parameters; a table over it
  would be an interface wider than its implementation.

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

## Gates

- **Probe** — a deterministic per-task check whose findings are handed to the
  verify child as a NOTICE plus a numbered rule. The eight probes are rows in
  `PROBE_ADAPTERS` (`task/verify-work.ts`), each an **adapter**: a key, the dep
  field it reads, its empty value, a findings mapper, a notice block, and a rule
  id. The loop owns the ritual — the skip-when-absent, the degrade-to-empty on
  throw, the stage label, the notice ordering, and the rule ordering (two
  different orders, both derived from the table). `buildVerifyPrompt` takes a
  findings bag, not nine positional parameters.
- **Closure scan** — a run-level static check that reads the tree and emits
  failure lines, fault-isolated so a scanner bug can never break the gate. Rows
  in `CLOSURE_SCANS` (`task/final-gate.ts`) carry an id, a `stage`
  (pre-discovery vs post-boot — a real fact about when the check is meaningful,
  not scheduling), a rank, and a generator so partial findings survive a
  mid-scan fault. Only the three uniform scans are in the table; repo-health,
  launch-contract, launch-config-gap and the boot check are deliberately outside
  it, because each would need its own escape hatch in the row type.
- **Debt origin** — why a debt entered the ledger. `DEBT_LABELS`
  (`task/accept-debt.ts`) is the registry: a `Record<DebtOrigin, string>`, so a
  new union member is a compile error until it has a label. One writer,
  `recordDebt(cwd, taskId, reason, origin)`, replaced eight byte-identical
  recorders; the parser reads the same table instead of a hand-maintained
  whitelist. Adding an origin is three edits.
- **Final gate stage** — the run-end decision path, once every task is done:
  run the gate, trail the verdict, surface UNOBSERVED, re-derive open ACCEPT
  debts, run the resolution picker, bound the autofix, handle stranded fixes.
  `runFinalGateStage` (`task/run-final-gate.ts`) behind a 6-field
  `FinalGateStageDeps` — the run-level twin of `runGatesForTask`, and seamed the
  same way so it tests with no temp dirs and no spawns. It touches none of the
  task loop's state, which is why it could leave `runAutoLoop`.
  > `GateDeps` is behaviour-shaped, not import-shaped. The fields that survive
  > are the ones a test genuinely needs to observe or substitute (`record`
  > writes a different artifact; `revert` and `discardEdits` close over the
  > abort signal; `introducedBy` would otherwise demand a real git history).
  > A field that only forwards to an import is not a seam — import it.
  >
  > `recordDebt` and `ownedRequirements` ARE seams by that test, and are now
  > fields: both write or read a durable ledger, which is exactly what a
  > scenario wants to observe. Each defaults to the real implementation when
  > absent, so production wiring is untouched — the twin's "absent → documented
  > earlier behaviour" contract, with the earlier behaviour being the import.
  > They were the only reason all 25 of this stage's tests needed a real
  > temp dir.

- **The two resolution loops stay two.** `runGatesForTask` and
  `runFinalGateStage` share a policy SHAPE — run a check, negotiate a FAIL
  through a picker whose recommended card may be auto-taken, apply, loop — and
  sharing their spine was examined and REJECTED. Of `GateDeps`' 18 fields only
  `commit` is exactly shared; ~13 have no run-level counterpart at all.
  `UNOBSERVED` has OPPOSITE polarity (a FAIL flag per task, a PASS variant per
  run). `GateResult` carries `ctx` on every kind because a task autofix can
  replace the live session; `FinalGateStageResult` structurally cannot. The
  autofix bounds count different events (task: unattended invocations only, so
  manual retries are unbounded; run: every attempt, and the card is withdrawn
  when spent). Dismissing the picker is its own terminal state per task and is
  folded into "leave" per run. A shared spine needs an altitude conditional at
  each of those points — worse than the duplication it removes.

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
- **Focused extractor (seam)** — running a `--no-tools` child pi that answers ONE
  question over content already in hand and cites a verbatim `<excerpt>`, then
  checking that citation. `runFocusedExtraction`
  (`workers/focused-extractor.ts`) is the single implementation; its four call
  sites (`fetchFocused`, `docsFocused`, and both `pi-worker-docs.ts` paths) are
  **adapters** that supply the three things that genuinely vary: the prompt
  body, the **verify target**, and what the answer MEANS. Everything else — the
  `--no-tools` argv (`focusedChildArgs`), invocation, `runChild`,
  `parseChildOutput`, and no-retry — is the seam's.
  > The **verify target** is a named parameter because the sites disagree on
  > purpose: the docs paths verify against exactly the content they prompted
  > with; fetch verifies against the FULL cleaned page while prompting with only
  > the anchored `#fragment` slice, so fragment anchoring cannot weaken the
  > hallucination check. A failed child returns no `answer` at all (the result
  > is a discriminated union), and every site now receives the rich
  > `ExcerptVerification` rather than a bare boolean.

> `pi-worker-search` is the outlier: it is a direct Brave API call with **no
> child pi**, so it registers through `makeWorkerTool` but has no child-failure.
