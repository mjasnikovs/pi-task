# pi-task — domain vocabulary

The shared language for this codebase. Architecture reviews and design conversations should use
these terms exactly. New deepened modules that name a concept get that concept recorded here.

## Core concepts

- **Spec** — the deterministic feature description pi-task produces and then executes. The output of
  the phase pipeline.
- **Phase** — one stage of the single-task pipeline: refine → research → grill → compose → critique.
  Phases live in `task/phases.ts` and are driven by the orchestrator.
    > Every `PHASES` row's `run` is a NAMED exported function (`refinePhase`, `researchPhase`,
    > `grillPhase`, `composePhase`, `critiquePhase`), so `PHASES` is a table with no bodies. Four of
    > the five were anonymous closures carrying real decisions and reachable only through a whole
    > `TaskRunner` run: the parts were exported and covered, but the COMPOSITION — which is where
    > this codebase's phase defects have lived — was asserted by a test that RETYPED the order.
    > `critiquePhase` is the case that matters: the braces (`appendOwnedConstraints`) write the
    > stamp the detach (`resolveOwnedFreezeForThisTask`) reads, and a critique-time probe once
    > measured 0/40 because the stamp did not exist yet. `owned-freeze-wiring.test.ts` drives the
    > row now, and reversing the two inside it fails.
- **Phase carry** — the pure, idempotent transform a phase performs on `PhaseContext` fields OTHER
  than its own `field` (`PhaseConfig.carry`). It runs on BOTH arms of the orchestrator loop: before
  `run` on the live path (`runPhaseRow`), and in place of `run` on the resume path
  (`replayPhaseCarry`). It mutates `pc` and RETURNS its trail lines rather than writing them, so a
  replay cannot duplicate a `## gates` line the live run already recorded. Compose is the only row
  that has one (`composeCarry`).
    > A row's `section` restores exactly ONE field on resume, and compose settled two: it dropped
    > constraints research REFUTED from `refined` while its `field` is `spec`. So a resume past
    > compose restored `## refined prompt` — deliberately left as refine WROTE it — and never
    > re-applied the drop, handing critique the refuted constraint back under a prompt that calls
    > the refined task GROUND TRUTH whose CONSTRAINTS "MUST be preserved in spirit". That is the mx5
    > run-19 defect (`argon2` shipped as a dependency of a repo that never imports it), restored by
    > the machinery that closed it. `dropRefutedConstraints`' own doc comment claimed "a resumed run
    > re-deriving `refined` from the task file lands in the same place"; it did not, because the
    > skip branch never ran the body that said so. Reachable on the ORDINARY path:
    > `cancelCheckpoint('phase:compose')` exists to land a resume at critique, the costliest phase.
    > The single resume test resumed at `grill`. **`postCommit` is a row field for the same reason**
    > — it was a `phase.name !== 'refine'` string test inside one function, so the compiler could
    > not say which rows have a post-commit effect, and `phases.test.ts` drove it through a
    > hand-retyped `{name: 'refine', …} as PhaseConfig` literal that would have asserted nothing
    > once the effect moved onto the row. **`runPhaseRow` is the row's test surface.** Calling
    > `row.run` alone tests PAST the interface and is exactly what missed the carry.
- **Orchestrator** — drives a task through its phases, spawning child pi sessions, tracking
  context/widget state, and persisting for resumability. `task/orchestrator.ts` runs a single task;
  `task/auto-orchestrator.ts` plans a feature into many tasks and runs them one at a time.
    > `runSingleTask`/`TaskRunner` is the shared core: `auto-orchestrator`'s loop calls it per task
    > (`deps.runTask`), so there is no separate "task-runner base" to extract. `PhaseDeps` (phase
    > callbacks) and `AutoDeps` (runChild/runTask/commit) are deliberately different abstractions.
    > Their one real overlap — mirroring child context_usage into the widget — lives in
    > `task/context-usage.ts` (`getParentContextWindow`, `resolveContextUsage`).
    > **`TaskRunnerOptions`** — the single-task runner takes one options object, not ten positionals
    > (`RunSingleTaskOptions` was already a bag that got re-flattened into them). It carries
    > `runChild?: PhaseDeps['runChild']` straight through into `PhaseDeps`, so a runner-driven test
    > answers phase children BY NAME
    > (`scriptedChildren({refine, 'grill-gen', compose, critique, …})`) instead of matching prompt
    > prose. `spawn` stays beside it for the two orchestrator tests that ARE about the ladder (empty
    > completion, loop exhaustion).
    >
    > **`PhaseDeps` carries every phase seam.** `runWorker`, `getFileInventory` and the EXTERNAL
    > CONTEXT lookups (`docsRaw`, `fetchRaw`, `npmVersionLookup`, `searchFn`, `docsFocused`,
    > `fetchFocused`) are fields on it, defaulting to the real implementations exactly as `runChild`
    > does. They were two trailing `= {}` dep bags (`PhaseResearchDeps`, `PhaseAutoAnswerDeps`) on
    > `phaseResearch` and `phaseAutoAnswer` — nine injectable seams no production caller could
    > reach, because `PhaseConfig.run` takes `(deps, pc)` and a row physically cannot pass a third
    > argument. `TaskRunnerOptions` forwards them (`runWorker`, `lookups`), so
    > `orchestrator.test.ts` answers a research worker BY LABEL (`worker:files`) and states the
    > `RunWorkerResult` fields a gate reads, instead of matching a marker SENTENCE lifted out of
    > `prompts.ts` against a fake process emitting JSON events. `searchFn` is ONE field, not two:
    > research and auto-answer differ in the doc/url worker VARIANT (raw vs focused) and in POLICY,
    > never in how they search.
- **Run end** — how one `/task` run stopped, named once: `RunEnd` (`task/run-end.ts`), a union of
  `completed | cancelled | failed{reason} | interrupted | no-session`, plus `RUN_END_POLICY` — the
  table saying whether each ending marks the task resumable and whether it fails the containing
  plan. `TaskRunner.run` returns it and `handleFailure` hands back the `FailureClass` it already
  computed.
    > It returned `void`. `runSingleTask` learned what it had just done by RE-READING the task
    > file's front matter, narrowed that to `ok: boolean`, and smuggled the rest out of the
    > `withSession` closure through three mutable captures — while `classifyFailure` had named the
    > ending exactly and thrown the name away. The report was wrong for it: `/task-cancel` writes
    > `cancelled`, which is not `completed`, so `ok` was false, so `!res.ok` ran `markResumable`
    > (which writes `failed`) and announced a red _"stopped — fix and run /task-resume"_ for a stop
    > the user asked for. `/task-auto` hit the same arm and papered over it by consulting
    > `isCancelRequested()`, a module global `/task-cancel` never sets. `failsRun` is strictly
    > narrower than `resumable`, and that gap is load-bearing: a declined-steer interrupt leaves the
    > inner task resumable but the PLAN in progress, so `/task-auto-resume` re-delivers that task's
    > spec. The WORDING stays per-command (`/task-resume` vs `/task-auto-resume`); only the policy
    > is shared. The task file is still written — it is what a RESUME reads — but it is no longer
    > the channel this process uses to talk to itself.
- **Implementation turn** — the supervision that runs between "spec delivered" and "we know how the
  implementation REALLY ended" (`task/implementation-turn.ts`). A single `waitForIdle` resolves for
  four reasons and only one is completion; `classifyTurnEnd(entries)` names it — `aborted` >
  `compaction` > `error` > `stop`, the precedence the old three booleans (`wasInterrupted`,
  `endedAtCompactionBoundary`, `implementationError`) applied by call order — so a new terminal
  state is one enum member, not a fourth boolean. `superviseImplementation(ctx, opts)` owns
  resume-across-compactions → steer-until-done → read-the-error behind `ImplementationTurnDeps`
  (`entries`, `send`, `waitForIdle`, `ask`, `watchdog`, `log?`), bound from a live ctx by
  `turnDepsFor`; `runSingleTask` calls it once. The steer prompt still fans out through `SessionUI`
  (local input + remote card) — that binding moved with it, unchanged.
- **ChildStatus** — the live status of the child pi running under a status loader: its latest stream
  line and its context gauge, plus the loader ritual around one child (`track`: reset, raise a
  loader whose every tick is the frame merged over the live status, run, always stop).
  `task/child-status.ts`. It was `let lastLine; let contextUsage;` + two callbacks + a reset + a
  loader in three places — `/task-auto`'s planning `runChild`, `/task-plan`'s `child`, and
  `buildGateDeps` (an accessor box handed to `makeGateChild`) — and the first two were the same 25
  lines. `runPlanningChild` is what both are thin adapters over; what genuinely varied (tool set,
  head command, per-tick step label, task id, read-once extension, debug log) is a parameter, and
  the read-only tree diff stays `/task-plan`'s own. The status OUTLIVES a track: the gate shares one
  across every gate child, and the verify gate's gate-wide loader reads it over a child that renders
  none (`frame: null`).
    > The fourth mirror, `TaskRunner`'s `_widgetState`, is deliberately NOT one: its state is the
    > whole-run `WidgetState`, shared by reference with `PhaseContext` and written by the phases
    > themselves; only the two callbacks overlap.
- **Run bracket** — what "a command owns the session" means, in one place:
  `withRun(ctx, {onCancel?}, fn)` (`task/run-bracket.ts`) holds mid-run input (`beginRun`/`endRun`)
  and arms the raw-stdin interception (`armCancelListener`/`disarm…`) for exactly `fn`'s duration,
  releases both on return and on throw, and reports the held lines that never found a turn. It was
  written out at four sites in two files whose `finally` halves disagreed on order (the orchestrator
  disarmed first, `/task-auto` ended first) — an order that is not observable, so there is one
  order, not an option. `/task-plan` was the fifth owner and never bracketed; it does now, so a line
  typed during a planning child is held for the handed-off run's first turn instead of firing from
  pi's queue after the plan. `TaskRunner.run` used to begin ~65 lines before its `try`, so a throw
  in task-file setup leaked both refcounts for the process lifetime; wrapping the whole body closes
  that. The two refcounts (`runDepth`, `armed.depth`) stay two — read by different consumers with no
  ctx in hand, armed alone by the cancel harness — but the bracket is now the ONLY production caller
  of either pair, which is what prevents drift. `announceTerminal(ctx, msg, level, {push?})` is the
  terminal triplet (toast + remote bubble + web push) that `announceDone`, `/task`'s `announce` and
  `/task-plan`'s two endings each hand-rolled; `/task-plan` opts out of the push because a plan is a
  conversation, not a task — the run it hands off to pushes its own ending.
- **Task attempt bracket** — the pre-task facts and post-task integrity checks of ONE `/task-auto`
  iteration, paired structurally. The stash ref is captured before the task and `reportStashDrift`
  runs in a `finally`, so every exit — the two mid-attempt returns and a throw included — passes
  through it once.
    > It was a captured local and a check ~120 lines and THREE returns apart, sitting at the very
    > end of the clean fall-through. So the orphan-stash guard — whose own message says "an orphan
    > stash later pops as an unresolvable conflict", and whose reason for existing is mx5 run 6 —
    > ran only when the task SUCCEEDED and the gate said `done`. On a failed or interrupted task the
    > user is told to run `/task-auto-resume` and walks straight onto the landmine the guard exists
    > to name. Nothing in the parts was wrong; the bug was where they were composed. No test could
    > tell "the guard ran and found nothing" from "the guard never ran", because the only path that
    > reached it was the clean one. The FULL `withTaskAttempt(cwd, deps, {…}, fn)` — folding in the
    > checkpoint commit and the unmerged-paths refusal, `withRun`'s shape one altitude down — was
    > NOT built: it means restructuring ~180 lines of the hot loop to turn two `return`s into a
    > sentinel. The `finally` gets the pairing property that mattered; the rest is open.
- **Plan stage** — one step of `planAuto`, the `/task-auto` planning pipeline: ORIENT → ELICIT →
  DECOMPOSE → COVER → persist. Each is its own function in `task/auto-orchestrator.ts`, taking what
  the earlier stages settled and returning what the later ones read (`OrientedFeature`,
  `DecomposedPlan`, `CoveredPlan`), so a stage can be driven on its own instead of through a whole
  plan run. `orientFeature` asks nobody anything — it reads the feature and the tree, so the
  plan-shape fork has a real requirement count to judge with before clarify runs.
  `elicitClarifications` is the ONLY stage that talks to the user, and so the only one that can be
  dismissed (`null` = cancelled, already announced). `decomposePlan` returns its own prompt and
  parser because COVER re-prompts with the identical prompt and must reconcile the reply identically
  — rebuilding either is how the two paths drift. `coverPlan` returns the whole `ScoredPlan`:
  `best.accounting` is read as late as the coverage note, and splitting the plan from its accounting
  is a bug this codebase has already had.
    > `planAuto`'s tail is deliberately NOT a stage. The two grounded extractions (contracts, launch
    > scripts) and the four ledger writes are ordered against each other, not against the pipeline.
    > What DID move is the empty-plan guard: it now runs BEFORE the extractions, which used to spend
    > two children and append to two run-level artifacts for a plan that was discarded one line
    > later.
- **Q&A transcript** — what one adaptive dialog RECORDS: numbering, formatting and the provenance
  table, in one value. `QaTranscript` (`task/qa-transcript.ts`) takes a `QaPolicy` and offers two
  renderings — `forRecord()` (persisted, handed on) and `forGenerator()` (fed back into the next
  question-generation prompt). An entry states its KIND (`auto`, `auto-resolved`, `host-set`,
  `yolo`, `yolo-skip`, `accepted`, `typed`); `QA_PROVENANCE` gives each kind a suffix, so a new kind
  is a compile error until it has one.
    > `question-dialog.ts` unified the ANSWER side of these loops. What the loop RECORDS was eight
    > retyped push sites across two files, each choosing a suffix by hand according to which branch
    > of an `if/else` it stood in. `phases.ts` stated the invariant in a comment — _"No provenance
    > stamp here… this string is fed back VERBATIM into the next grill-gen prompt, so a
    > `(accepted recommendation)` suffix would become model input"_ — and TWELVE LINES ABOVE it, the
    > YOLO branch pushed `${answer} ${YOLO_STAMP}` into that very array. The rule lived in prose;
    > the decision lived at each push. **`generatorSeesProvenance` is an option, not a
    > unification.** The two dialogs genuinely disagree and both say so: grill's feedback is
    > verbatim model input, so a suffix there describes how an answer was obtained rather than what
    > it was; clarify deliberately shows its generator the provenance, so a question the triage
    > already settled reads as settled and is not re-asked. Observable either way — the `makeLedger`
    > `onNoop` shape. Grill's `accepted` is deliberately NOT in its record set while clarify's is.
    > Whether the two should agree is a prompt question with its own A/B; today's answer is
    > preserved rather than harmonised. `plan-session`'s `PlanEntry` is NOT folded in: decisions vs
    > advisory notes, its own persistence, no `Qn:`/`An:` numbering.
- **Question source** — where the NEXT question comes from: `makeQuestionSource`
  (`task/question-source.ts`). One method, `next()`, returning a question or an `exhausted` reason
  (`none | cap | dups`). Behind it: the cap, the duplicate backstop and its strike budget, the
  NONE-vs-unparseable distinction, `pickQuestion`, the one-shot re-prompt budget shared by every
  quality rule, and the hint precedence between a format re-prompt and a duplicate one. `generate`
  is the **seam** — each site's own child and prompt. `reopen()` clears the strike budget when the
  caller supplies new context (`/task-plan` lets the user ask mid-session).
    > The other half of `question-dialog.ts`, whose own docstring makes the argument: _"It was
    > written three times… the two mirrors were never converted, and they had already drifted apart
    > in three ways."_ Clarify and plan use the SAME parser on the SAME prompt format and had
    > drifted five ways — clarify took `parsed[0]` blindly (so a numbered analysis note became the
    > question and the `SUGGESTED` attached further down was lost), treated an UNPARSEABLE reply as
    > "no questions left" (one formatting slip ⇒ the whole feature decomposed with ZERO
    > clarifications), re-typed the NONE regex in a second file, spent no re-prompt on a missing
    > `SUGGESTED`, and had no deferral guard at all. **Only the DEFERRAL rule crosses to clarify.**
    > `PLAN_QUALITY_RULES` has three; `CLARIFY_QUALITY_RULES` has one. The other two were MEASURED
    > on the plan path (10/15 fork-shaped questions shipped one option) but each costs an extra
    > child call every time it fires, and clarify is the most A/B'd path here — moving them is its
    > own experiment, not a side effect of sharing a state machine. The deferral rule crosses
    > because it costs nothing on the happy path and because its bug is the same bug one command
    > over: an accepted "clarify with the user before proceeding" rode into `/task`'s handoff as an
    > AUTHORITATIVE decision, and clarify's answers reach decompose with the same authority.
    > **Grill's loop is NOT folded in.** It uses `parseGrillQuestions` (bare strings) and has no
    > `SUGGESTED` at generation time — its recommendation comes from `phaseAutoAnswer` one step
    > later — so every quality rule is inapplicable. A generic over the parsed shape with one
    > consumer opting out of the whole table is a wider interface for less behaviour.
    > `exhausted.why` has FOUR members, not three: a second unreadable reply exhausts as
    > `unparseable`, never as `none`. Recording it as a NONE would put "model has no further
    > questions" on the trail for a run where the model emitted two malformed replies — the same
    > conflation, one level down. `CLARIFY_QUALITY_RULES` references `DEFERRAL_RULE` directly, not
    > `PLAN_QUALITY_RULES.find(r => r.id === '…')!` — a rename of that `id` would otherwise yield
    > `[undefined]` with no compile error and throw on the first clarify question of every run.
- **Coverage ledger** — what the COVER loop records and the decisions that record makes:
  `CoverageLedger` (`task/plan-rounds.ts`), `GateTally`'s twin one phase earlier. `consider(cand)`
  compares, replaces the plan WHOLE, and grants the one-shot bonus round IN THE SAME CALL that
  adopts; `mayRetry`, `startRound`, `best`, `unresolved` are the rest. No I/O — no `logPlanDebug`,
  no notify — for the same reason `GateTally` performs none.
    > Five locals threaded by closure through a ~90-line loop, plus a snapshot-before-overwrite pair
    > (`priorCovered`, `priorMissing`) that existed ONLY because the bonus-round decision was made
    > downstream from the evidence it needed. The last real bug here says the shape out loud in the
    > loop's own comment: _"This used to be two assignments, and the second one kept the OLD plan's
    > accounting whenever the new plan's coverage-map child faulted — binding requirements to titles
    > they were never mapped against."_ `AutofixLedger`'s indictment verbatim. `consider` closes it
    > by construction rather than by comment. The suite could previously observe the bonus-round
    > policy only by grepping a debug string through `planAuto` with a temp dir, a fake ctx and four
    > scripted children (`expect(log).toContain('bonus round granted')`). `normMissingArea` moved to
    > `coverage-loop.ts`, beside the adoption rule that is its only consumer. **DECOMPOSE's two
    > retry budgets are deliberately NOT here.** They look like this shape and are not: that loop
    > keys on `isSuspectPlan`, a predicate over the SPEC LENGTH rather than a title-count floor. A
    > class that does not model `isSuspectPlan` would move the code without concentrating the
    > decision.
- **Plan session** — the interactive planning loop `/task-plan` runs before a task exists
  (`task/plan-session.ts`). Same adaptive one-question-at-a-time shape as grill and clarify, and it
  reuses their parser, duplicate backstop, picker and YOLO policy; what it adds is a control surface
  where every prompt also offers "ask the model a question" and "proceed to execution". Its output
  is a **transcript** of `PlanEntry`s — decisions (authoritative, handed to `/task`) and notes
  (advisory, kept in the plan file only) — persisted to `.pi-tasks/TASK_PLAN_NNNN.md` via the same
  task-file machinery as TASK_AUTO. Read-only by contract (`plan-readonly.ts`): planning children
  run under `PLAN_TOOLS` (one tool, `read` — which pi applies to extension tools too), and the
  working tree is diffed around every child so a hole in that prevention is reported, never silently
  tolerated. The contract ends at the handoff.
- **Child pi** — an isolated `pi` process spawned to do bounded work (a phase step, a worker
  lookup). Spawned and parsed through `shared/child-process.ts` (`runChild`).
    > Every phase child goes through the `PhaseDeps.runChild(name, tools, prompt)` seam, and every
    > research worker through `PhaseResearchDeps.runWorker(label, input)`. Both default to the real
    > implementation when absent, so production is untouched. They take a NAME because the name is
    > what a caller branches on: it used to be discarded before reaching the only injectable
    > boundary (`spawn`), so `phases.test.ts` reconstructed it by matching prompt PROSE against
    > `prompts.ts` — 27 routing decisions keyed on sentences this codebase reworders and A/B's for a
    > living. `spawn` stays: the Error-triage ladder's own tests must drive a real process. The
    > seams are for callers to whom the child is a premise.
- **Error-triage ladder** — the fixed four-rung verdict a phase applies to a finished Child pi:
  non-zero exit throws, a connection-class error backs off and retries, an empty completion retries,
  a leaked tool call retries with a correction hint. One implementation, `triageChildResult`
  (`task/child-runner.ts`), called from ONE loop.
    > **`runPhaseChild` is that loop.** `runPhaseWithLoopGuard` is deleted. Two ~70-line loops drove
    > the same child through the same ladder, and the one thing keeping them apart — the loop
    > guard's `buildPrompt(loopHint)` callback — was the exact identity `runPhaseChild` performs
    > internally (`prependHint(hint, prompt)`) at 2 of 2 call sites. The generality was dead, and
    > each loop was missing something the other had: the guard silently dropped
    > `deps.childExtensions` and `deps.timeoutMs` (latent — only the planning child sets the first
    > and only tests set the second), and `runPhaseChild` never wrote the `loop events` trail.
    > `PhaseChildOptions` carries the two things that genuinely varied: `degradeOnExhaustion` (one
    > caller, refine) and `verb` (`'retry'` by default, `'restart'` for refine and grill-gen) — the
    > log word is the SINGLE externally visible difference the collapse preserved, and
    > `LADDER_CALL_SITES` runs all four rungs through both option sets to keep it the only one. The
    > loop trail is now written for every phase child and is best-effort, because six sites that
    > never had one do not all own a task file on disk.
- **`makeGit` (seam)** — the one git runner (`shared/git-runner.ts`). Returns `{stdout, exitCode}`
  and never throws, carries the abort signal, and takes an injectable `spawnFn` so git-touching
  modules are testable without a repo. Async by contract: the sync git callers (`trackedFiles`,
  `taskThatIntroduced`, `rerunDebtVerifyCommand`) are deliberately still their own, because
  converting them would change signatures across the gate. Harness scripts get the matching fixture,
  `scratchRepo` (`scripts/scratch-repo.ts`), which owns temp-dir creation, `git init` with one fixed
  identity, seeding and teardown.
- **JsonEventSink** — the parser for a child's `--mode json` event stream
  (`shared/child-process.ts`). Holds the cross-chunk line buffer and text assembly, turning events
  into assistant `text` + side effects (caller callbacks, loop-kill via an `onLoopKill` signal).
  Lifted out of `runChild`'s closure so event interpretation is unit-testable without spawning a
  child.
- **External context** — the `EXTERNAL CONTEXT` block the research phase prepends to every worker
  prompt: live npm versions, package docs, fetched URLs, and service searches, gathered from targets
  parsed out of the refined spec. Assembled by `buildExternalContext` (`task/external-context.ts`);
  target parsing is the pure `enrichment.ts`. `phaseResearch` calls it, then runs the four research
  workers (data-driven `workerSpecs`, assembled by `section`). The grill auto-answer builds the same
  block from the same function — the two copies differed only in POLICY (`ExternalContextPolicy`:
  target/service caps, version lookups, timing sub-step, early return) and in the worker variant
  (`ExternalContextLookups`: _raw_ workers for research, _focused_ ones for auto-answer, expressible
  since the focused-extractor seam landed). `gatherExternalContext` is the research-phase binding.
- **Research retry gate** — a deterministic handle inside `runSpec` (`task/phases.ts`) that re-runs
  ONE worker once with a forced preamble and keeps the retry only if a named measure improved. There
  are three, and they stay three rather than becoming a row table, because they disagree on the
  thing a table would have to unify: the ZERO-RETRIEVAL and SILENT gates DISCARD a failed retry and
  ship the original, so neither can ever fail the phase; the EMPTY-SECTION gate PROPAGATES it, and
  that is how a worker that answers twice with silence becomes a loud failure instead of a quiet
  empty section. The empty-section gate is also the only one with no row field — it runs for every
  worker — and it produces `confirmedEmpty`, which the silent gate reads as a precondition and the
  section body reads as its answer. The shared body is five lines behind six varying parameters; a
  table over it would be an interface wider than its implementation.

- **Research worker** — ONE research worker, cache-skip to persist:
  `runResearchWorker(spec, run, prior)` (`task/research-worker.ts`). A `ResearchWorkerSpec` is the
  row (section, label, prompt, and the three optional gate preambles); `ResearchWorkerRun` is
  everything about THIS RUN (one `runWorker`, where cached output is read and written, the timing
  recorder, the 5B knobs). Behind it: the cache skip, the three retry gates in their fixed
  precedence, the classification ladder, the marker ladder and `postProcess`.
    > It was a 228-line closure inside `phaseResearch` over ELEVEN locals, and the cost was in the
    > tests. `phases.test.ts` used `fakeSpawnByPrompt` 50 times and `runWorker:` once: every gate
    > test needed a temp dir, a real task file, a route on a prompt sentence lifted out of
    > `prompts.ts`, AND a second route on a sentence lifted out of a module-private preamble
    > constant to tell attempt 1 from attempt 2. This is a codebase whose whole workflow is
    > re-wording prompts and measuring what changed — so a reworded preamble silently stopped the
    > gate tests from testing the gate. **`readCached` is a seam, symmetric with `persistSection`.**
    > The cache skip is one of the driver's four outcomes and reaching it used to require a real
    > task file, which is most of why the gate tests needed a temp dir at all. The INVARIANT, stated
    > once where the gates live: the empty gate runs FIRST and is the only one that can throw; the
    > other two discard a failed retry and ship the original; `confirmedEmpty` suppresses the silent
    > gate. That last guard is belt-and-braces and `research-worker.test.ts` SAYS SO — an empty body
    > is silent-but-not-a-loss, so the gate declines it anyway; what the test pins is the observable
    > cost (exactly two children), which is what the branch comment claims.
- **Settling a question** — the whole one-question dialog, once: `settleQuestion(input)`
  (`task/question-dialog.ts`). YOLO short-circuit → cards → `ui.ask` → cancel → record, returning
  `'settled' | 'cancelled'`.
    > `question-dialog.ts` had already unified the PIECES and its own docstring says the mapping
    > "was written three times". The COMPOSITION was still written out twice at ~50 lines each —
    > grill and clarify — and had drifted: grill passed `recommended2` unconditionally, clarify
    > conditionally, harmless only because `remote/bridge.ts:137` re-guards it. That is the shape
    > this file already indicts under `resolveTypeSource`: pure functions extracted for testability
    > while the real logic stays in how they are called. **`yolo` is a PARAMETER, not a hook** —
    > `yolo.ts`'s "WHY PER-SITE, NOT ONE HOOK" header is the reason, and settling a question must
    > not become the place that decides a YOLO policy. **Cancel is RETURNED, not thrown**, because
    > that is the one thing the two callers genuinely disagree about: grill throws `USER_CANCELLED`
    > into the phase ladder, clarify announces and returns null from the plan. `plan-session` stays
    > out — `buildQuestionSpec` adds control actions and `allowSkip: false`.
- **`ChildRun`** — one child-pi invocation as a VALUE (`task/child-runner.ts`), plus
  `phaseChildRun(deps, over)`, which says once what a phase child's invocation carries.
    > `runChild` took thirteen ordered positionals and the thirteenth carried its own
    > `DEBT: convert to an options bag`. Two production callers reached it and they had drifted: the
    > degrade attempt wrote three bare `undefined`s to reach the later slots and passed the RAW
    > signal, so the ONE attempt made after a loop budget was spent was also the only one that could
    > hang forever. **BEHAVIOUR DELTA**: it now runs under the same wall clock as the strikes, which
    > is what its own comment ("the degrade changes the TOOLS, not the role") already claimed.
- **`PhaseSeams`** — every injectable phase seam in ONE field on `TaskRunnerOptions`, derived as
  `Omit<PhaseDeps, …runner-owned>` so a new seam joins it with no second edit.
    > `spawnFn`, `runChild`, `runWorker` and a seven-name `Pick` called `lookups` were four separate
    > fields; `RunSingleTaskOptions` re-picked all four and `runSingleTask` re-forwarded each by
    > name. Four coordinated edits, none of which failed to compile if you skipped one — the
    > `ConfigItem` indictment, one altitude up. Four seams had in fact been left behind:
    > `timeoutMs`, `sleepFor`, `childExtensions` and `logDebug`, so a runner-driven test of the
    > connection-error rung really slept and the ~39 trail decisions could not be asserted at all. A
    > caller-supplied `logDebug` now WINS over the per-task file writer (production never sets one).
    > **The GATE's autofix re-runner is deliberately NOT plumbed.** Reaching `gateRunTask` with
    > seams needs a field on `GateParams` and another on `GateDeps`, and nothing — production or
    > test — would set either: the gate is reached through two orchestrators that build their params
    > from a task file. An unused field on a seam roster is the `WorkerOutcome.reason` shape
    > (written twelve times, read by nothing), so it stays unplumbed until a test needs it.

## Remote web view

- **Remote client** — the single-page web UI streamed to a browser over WebSocket (`remote/`).
  `ui.ts` composes the page from `ui-markup`-style head + `ui-styles.ts` (`STYLES`, the CSS) +
  `ui-script.ts` (`clientScript(wsUrl)`, the vanilla-JS client). The split is for navigability only
  — the three concatenate to a byte-identical page.
    > The client JS ships as a string (there is no bundler). A real transport/state/render split
    > with a Node-unit-testable reducer would need a build step not justified for one screen; until
    > then the client is covered by source string-match tests in `ui.test.ts`.

## Spec validation

- **Spec gate** — the guards that decide whether a composed spec is acceptable at handoff:
  `validateSpecShape` (well-formed GOAL/CONSTRAINTS/ACCEPTANCE/VERIFY shape), its partner
  `stripSpecPreamble`, `parseVerifyBlock` (runnable VERIFY commands), and `isCritiqueClean`
  (critique came back CLEAN). They live in `task/spec-validation.ts` — separate from the
  informational parsers in `parsers.ts` (grill questions, clarify list, auto-answer, tooling output,
  title) because the gate answers a yes/no the orchestrator and critique phase act on.
  Self-contained, so the gate doesn't drag in the phase pipeline.

## Gates

- **Probe** — a deterministic per-task check whose findings are handed to the verify child as a
  NOTICE plus a numbered rule. The eight probes are rows in `PROBE_ADAPTERS`
  (`task/verify-work.ts`), each an **adapter**: a key, the dep field it reads, its empty value, a
  findings mapper, a notice block, and a rule id. The loop owns the ritual — the skip-when-absent,
  the degrade-to-empty on throw, the stage label, the notice ordering, and the rule ordering (two
  different orders, both derived from the table). `buildVerifyPrompt` takes a findings bag, not nine
  positional parameters.
    > The eight bound probes reach the table as ONE dep, `VerificationDeps.probes: VerifyProbes` — a
    > mapped type over `ProbeRaw`, the interface where each channel's raw shape is declared once
    > (`ProbeKey = keyof ProbeRaw`). A row reads `deps.probes[key]` by default; only skip-escape
    > overrides its `source`, because it is text analysis of the spec the deps already carry and is
    > never bound. The collectors meet the table in exactly one place, `buildVerifyProbes` in
    > `task/gate-deps.ts` (`buildGateDeps.verify` is now: read spec, build probes, run verify), and
    > `readSpecForVerification` is the one spec read all four gate sites share instead of four
    > copies of the same try/catch. Adding a probe is a `ProbeRaw` line, a table row and a binding
    > line; deleting one, the compiler names the row and the binding. Skip-when-absent and
    > degrade-to-empty stay in the row's `run` — the binder needs no try/catch and a fault in one
    > probe cannot reach another. `BOUND_PROBE_KEYS` is derived from the table so the binder is
    > checked against the rows, not a hand-kept list.
- **Closure scan** — a run-level static check that reads the tree and emits failure lines,
  fault-isolated so a scanner bug can never break the gate. Rows in `CLOSURE_SCANS`
  (`task/final-gate.ts`) carry an id, a `stage` (pre-discovery vs post-boot — a real fact about when
  the check is meaningful, not scheduling), a rank, and a generator so partial findings survive a
  mid-scan fault. Only the three uniform scans are in the table; repo-health, launch-contract,
  launch-config-gap and the boot check are deliberately outside it, because each would need its own
  escape hatch in the row type.
- **Shipped source** — what counts as the authored, shipping tree every run-level closure scan
  reads. `task/shipped-source.ts`: one skip policy (`isSkippedDir`/`isSkippedFile`), one bounded
  deterministic walk (`shippedSources`, 3000 files / 400 KB), one comment strip. `serve-entry` and
  `artifact-closure` are **adapters** over it, differing only in the extension set and in
  artifact-closure's per-run `excludeRoots` (a produced tree re-referencing its own chunks is noise,
  and which dirs are produced is discovered per run).
    > `CLOSURE_SCANS` deepened the DRIVER — fault isolation, rank, stage — and left the INPUT
    > triplicated. `scanCandidates` existed TWICE, near-byte-identical, and the two skip sets had
    > drifted: serve-entry carried `bench|benchmarks` and `*.bench.*`, artifact-closure did not, so
    > a dangling artifact reference in a benchmark was a run-level finding while the same file was
    > invisible to the sibling scan. The same extension regex was declared under two names
    > (`SCAN_RE`, `SCAN_JS_RE`) and `stripCommentLines` was byte-identical in both. `.pi-tasks` was
    > hardcoded rather than derived from `TASKS_DIR_NAME`. The locality proof is the suite:
    > `artifact-closure.test.ts` had 28 references to the pure extractors and 5 calls to the driver,
    > and NO test in the cluster asserted a skip set at all — the `resolveTypeSource` shape, pure
    > functions extracted for testability while the real logic stayed in how they are CALLED.
    > **`env-template-closure` is deliberately NOT an adapter.** It asks a different question —
    > which TRACKED files could read an env var, including `.py`/`.go`, including tests — and its
    > comment rule is a per-line predicate that also treats `#` as an opener, which it must and
    > which would be wrong for JS/TS. Answering it over this walk would silently change which env
    > findings a run produces. Recorded as a real divergence; changing it is an env-policy change
    > with its own A/B.
- **Fix-child ladder** — the four rungs every bounded fix pass applies to its child: a cancel THROWS
  (so the caller's `USER_CANCELLED` path is unchanged), a thrown child is an `error`, a
  self-declared marker is `blocked`, anything else is `done`. `runFixChild` (`task/fix-child.ts`),
  with `parseFixMarker` owning the last-match-wins rule; `parseFinalFixMarker` is now one line over
  it.
    > Not the rejected sharing: "the two resolution loops stay two" is `runGatesForTask` vs
    > `runFinalGateStage`, the LOOPS. This is the single child invocation inside each, where they
    > had actually drifted. **BLOCKED supplies a REASON; the CHECK still decides.** The marker is
    > scraped last-match-wins out of arbitrary child output and the fix child carries bash, so its
    > own command output is in that text — and a child can genuinely converge and THEN block
    > (`eslint --fix` clears the last finding, the model still reports BLOCKED). Returning
    > not-applied on the marker alone sent the gate to `deps.recommend(...)` with a `failReason`
    > that no longer described the tree, skipping the re-verify and burning an implementation re-run
    > on findings already gone, while the child's edits sat in the working tree. So the re-run is
    > NOT skipped; only the reported reason changes. Skipping it was the other half of the win and
    > is not worth that. **The lint-fix marker was a DEAD protocol.** `buildLintFixPrompt`
    > instructed the child to end with `LINT-FIX: DONE` / `BLOCKED <why>`, and the call site was
    > `await deps.runChild(...)` with the return value DISCARDED — nothing in `src/` or `scripts/`
    > parsed it, while the twin parsed its own marker to skip the expensive re-run. So a BLOCKED
    > lint-fix child still paid a whole repo-health run (15–69s measured) to be told
    > `did not converge: <health.reason>` instead of its own stated reason. The suite fed
    > `'LINT-FIX: DONE'` as fake output, so it stayed green whether the marker was parsed or
    > deleted. **The BLOCKED rung is consulted AFTER the guards, not instead of them** — a child can
    > discard work and then block, and an early return would have made blocking a way to leave
    > destroyed work in the tree. `lint-fix.ts` was also the ONE production site in `src/` re-typing
    > `'__user_cancelled__'` instead of importing `USER_CANCELLED`, and `LintFixDeps` had no `log`
    > field at all, so all four of its guard trips were invisible while the twin logged three of its
    > own. **A `WriteGuard` row table over the post-child guard stacks was examined and REJECTED**,
    > for the reason repo-health and boot stay outside `CLOSURE_SCANS`: the revert guard restores a
    > snapshot and notes, the frozen-path guard reverts WITHOUT rejecting, and the deletion guard
    > restores from HEAD — each needs its own escape hatch in the row type.
- **Verify fail class** — WHICH KIND of verify FAIL this is, as data. `VerifyOutcome.failClass`
  (`task/verify-work.ts`), a union whose members each declare a display prefix in
  `VERIFY_FAIL_PREFIX`, so a new class is a compile error until it has one.
  `verifyFailClass(outcome)` prefers the field; `failClassOfReason(text)` is the ONE surviving
  prefix match, for a debt read back off disk as a bare string.
    > `unobserved: true` was already carried as a typed field and read as one. Its sibling was not:
    > `verify-work.ts` minted `` `repo health: ${reason}` `` and THREE independent production sites
    > recovered the class by re-typing the literal with two different matchers — the graduated
    > lint-fix gate, the frozen-blocked contradiction test, and `isStaticClassDebt`, the only
    > auto-closing debt class. A reword of the mint disabled all three, with no compile error and a
    > green suite. This is the `observedFailures` finding one altitude down: the outcome CLASS never
    > travelled with the failure TEXT, so every classifier downstream had to guess. `static-checks`
    > is the RUN-level twin of `repo-health` — `final-gate.ts` minted `static checks: …` for the
    > same concept at the other altitude, so `isStaticClassDebt` was structurally blind to every
    > run-level static failure that reached the ledger. Both mints now read the registry, and
    > `isStaticClass` pairs them. The `reason` WORDING is byte-frozen: the debt ledger stores it
    > verbatim, so the registry exists to keep minting and matching from drifting, not to make the
    > wording editable. **Every mint reads the registry, and a test pins that.** The first cut
    > shipped ALREADY drifted — the `harness-fault` prefix read `verify pass could not run:` while
    > the only site minting that class emitted `verification pass could not run:`, so
    > `failClassOfReason` returned `undefined` for it. Asserting the prefixes are non-empty did not
    > catch it; asserting a minted reason classifies back to its own class does.
- **Gate tally** — what the run-end gate's sections RECORD, and the one pure function that turns the
  record into a `FinalGateOutcome`. `GateTally` (`task/gate-tally.ts`) replaces the twelve mutable
  locals `runFinalIntegrationGate` threaded through ~400 lines by closure — the ranked failure list,
  four dynamic counters, three note lists, warnings, the boot verdict. Each section calls a method
  named for what it means (`attempted(bin)`, `observed()`, `unobserve()` for the config-gap un-count
  that used to be `dynObserved -= 1`, `failObserved()` for a probe that looked), and
  `verdict(debts)` is the ONLY place the PASS / FAIL / UNOBSERVED polarity, note ordering (boot
  note, zero-observation verdict, config gaps, inert contract) and debt attachment live — testable
  with no tree, where before it was reachable only through temp dirs and `node -e`.
  `observabilityGapFailure` and `unobservedVerdict` moved with the counters they read;
  `final-gate.ts` re-exports them.
    > The zero-discovery return now asks the tally (`!boot && tally.silent()`) and sits AFTER the
    > launch-script loop, which is the one-line fix for the f5d7110 finding: a declared, present,
    > non-boot-class launch script RUNS on a tree with no discoverable integration/lockfile/boot
    > command. It still returns before the boot `else` branch and the post-boot closure scans:
    > `stage` is a statement about when a scan is meaningful, and this did not change it.
    > Repo-health, launch-contract, config-gap and boot remain outside `CLOSURE_SCANS`.
- **`BootChild` (seam)** — the boot child, defined from what `runBootCheck` CALLS: a pid, two output
  streams, an `error` event and an `exit` event carrying `(status, signal)`. `BootDeps.spawnBoot`
  and `BootDeps.killGroup` inject it and its teardown; both default to the real `spawn` / group
  kill, and `runBootCheck`'s exported signature is unchanged, so the seven harnesses under
  `scripts/` that drive it are untouched.
    > `BootDeps` injected NINE things the check LOOKS AT — `findPortHolder`, `reap`,
    > `groupHasListener`, `groupListeningPort`, `renderProbe`, `deepRenderProbe`,
    > `enumerationCapable`, `pickPort`, `preferredPort`, `httpProbe` — and not the thing it looks
    > THROUGH. `spawn` was a direct import, so a ~220-line `new Promise` body carrying seven closure
    > locals, four `BootOutcome` kinds and a five-armed exit ladder was reachable only through a
    > real process on a real clock: 52 tests / 13.6s, with 300–5000ms grace windows scripted as real
    > `process.execPath -e` children. Defined from the CONSUMER, exactly as
    > `driveSession(cdp: CdpLike, …)` was defined from the two `Cdp` methods it calls rather than
    > from `Cdp`. A scripted fake is a dozen lines, and `boot-probe.child.test.ts` covers the exit
    > ladder, the listener rules, both render probes and the orphan-port branch in 5s. **The
    > `probing` re-arm is the branch this was for.** A browser session outlives the grace window by
    > design; settling there would kill the server under it and discard its verdict. It is a race
    > between a 500ms interval, a re-armed grace timer and an async probe, and nothing could drive
    > it deterministically before. The pid guard stays TRUTHINESS (`if (!child.pid) return`),
    > deliberately: `process.kill(-0, sig)` signals the CALLER's own process group, so a pid of 0
    > would turn a best-effort teardown into self-termination. Node's `spawn` never yields 0 — but
    > `spawnBoot` is a seam now, and a fake can. **Timers are NOT injected.** The existing
    > `deepRenderProbe` seam already decides when a session resolves, which is enough to drive the
    > re-arm against a short `graceMs`; a timer port would be a wider interface for behaviour
    > already reachable. The ANTI-PATTERN avoided: extracting three pure classifiers
    > (`classifyBootExit`, `classifyGraceEnd`, `renderVerdict`) would be the no-locality shape
    > CONTEXT.md indicts under `resolveTypeSource` — the ORDERING is what has bugs, so the seam goes
    > UNDER it, not beside it.
- **Deep-render driver halves** — `deep-render-check.ts`'s `drive()` is launch → session → close,
  split at the `Cdp` seam it already had. `launchBrowser(bin, userDataDir, {signal})` is everything
  that touches a process or a socket: spawn, read the DevTools banner, connect, and a `close` that
  is idempotent, never throws, and is also what the caller's abort `signal` fires — so a budget
  timeout reaches a browser that never listened, which two hold-callbacks used to do by hand.
  `driveSession(cdp: CdpLike, {url, credentials, judge, quietMs})` is the protocol body unchanged,
  over the two methods it actually calls (`send`, `on`) — defined from the consumer, not from `Cdp`,
  so a scripted fake is a dozen lines. `judge` is a parameter because `drive` is where the recorder
  hook wraps `judgeDeepSession`; the session only gathers facts. `deep-render-driver.test.ts` keeps
  its fake Chrome on disk for the launch half; `deep-render-check.session.test.ts` is the branch
  table for the session half.
    > `Cdp` itself did not move and `runDeepRenderCheck` still owns the temp profile dir: the split
    > is at the process/protocol boundary, not a re-shaping of the client.
- **Debt origin** — why a debt entered the ledger. `DEBT_LABELS` (`task/accept-debt.ts`) is the
  registry: a `Record<DebtOrigin, string>`, so a new union member is a compile error until it has a
  label. One writer, `recordDebt(cwd, taskId, reason, origin)`, replaced eight byte-identical
  recorders; the parser reads the same table instead of a hand-maintained whitelist. Adding an
  origin is three edits.
    > The ACCEPT-debt re-check — `deriveOpenDebts` and `rerunDebtVerifyCommand` — lives here too,
    > with the ledger it reads and writes; `runVerifyCommandLine` lives in `command-run.ts` with the
    > other command drivers. `final-gate.ts` re-exports all three so the orchestrator and the
    > harnesses under `scripts/` are unchanged.
- **Ledger** — a run-level line file under `.pi-tasks/` with one read-modify-write ritual: read (any
  error → ''), parse, key, drop what is already stored, cap to the newest `max` (oldest dropped),
  mkdir, write the whole file back (`join('\n')
    - '\n'`, plain `writeFile`, not atomic), swallow every fault. `makeLedger` (`task/ledger.ts`) is the one implementation; contracts, launch-contract, env-notes, accept-debt, repair-queue and both requirements files are **adapters** that declare file/max/key/serialize/parse and call `read`/`append`/`write`. Six copies of the ritual agreed on everything except ONE rule — what an append does when it adds nothing new: the four batch ledgers rewrite (re-cap, canonicalise), the two single-record ledgers (`recordDebt`, `recordRepairCandidate`) return without touching the file. That is `onNoop:
      'rewrite' |
      'skip'`, an option rather than a unification, because the two are observable once a file has drifted from what its writer produces. `recordDebt`
      is still the ONLY debt writer; the ledger is what it calls, not a second door.
        > Stored contract/requirement lines are kept VERBATIM and keyed by the normalised first
        > quoted span; a new entry carries the key of its quote directly (`{line, key}`), so the
        > dedupe rule is unchanged even for a quote containing `"`. Not atomic and not made atomic —
        > no site was.
- **Command runner** — running one project command and deciding what its ending MEANS.
  `CommandRunner` (`task/command-run.ts`) is `(CommandSpec) => Promise<CommandRun>`; `spawnCommand`
  is the real async spawn; `classifyCommandRun` is the pure gap ladder (`GAP_RULES`). One runner,
  one ladder, for repo-health, the lockfile/integration/launch sections and every ACCEPT-debt
  re-run.
    > **ASYNC by contract, and that is the point.** It was `(spec) => CommandRun`, so the only
    > possible implementation was `spawnSync` and the run-end gate blocked the event loop end to end
    > — repo-health under a 600s cap, then every gate command under 900s, then every debt re-run
    > under 300s, with no loader able to paint and no cancel able to be noticed. The freeze is
    > MEASURED (0 of 686 expected 100ms ticks during a 69s run), the same class was already fixed on
    > the VERIFY path, and `repo-health-check.ts`'s own doc comment told gate callers not to do it
    > while `final-gate.ts` was a gate caller doing exactly that. `FinalGateOptions.signal` now
    > reaches every command the gate spawns. This reopened the deferral recorded under `makeGit`
    > ("converting them would change signatures across the gate"); the measured freeze is what paid
    > for it. **repo-health is an ADAPTER over it.** `HealthRun`, `classifyHealthRun` and
    > `spawnHealthCommand` are deleted — a second statement of the same gap ladder with no
    > injectable runner, so every classification case in its suite spawned a real shell.
    > `runRepoHealthCheck` is now discovery + `CommandRunner` + its own output policy:
    > `captureHealthOutput` keeps 40 lines of a linter's report where the ladder's `tail` keeps 400
    > characters, so the run is CLASSIFIED, not consumed — the verdict decides, the raw streams are
    > what we show.
- **Boot probe** — does the assembled product actually START, and does the page it serves actually
  render? `task/boot-probe.ts`: shell-chain lexing and non-launch detection, boot-command discovery,
  listener enumeration (ss/netstat/lsof), port reservation, `runBootCheck`, orphan-port recovery and
  `bootSkipVerdict`. It was 42% of `final-gate.ts` and the largest of that file's seven concerns,
  while nothing inside `src/` imported any of it except the one call site in
  `runFinalIntegrationGate` — the boundary already existed in the CONSUMERS, seven harnesses under
  `scripts/` that import exactly this surface. The gate re-exports the public names so those keep
  working, the same way `taskThatIntroduced` does.
    > Still deliberately NOT a `CLOSURE_SCANS` row: it is async, stateful and port-binding, and
    > would need its own escape hatch in the row type.
    > **`runBootSection(cwd, {planText, graceMs, deps})` is the re-shaping** the file move left
    > open. It returns a `BootSectionVerdict` — what was attempted, whether a probe LOOKED, the
    > UNOBSERVED note, the one failure with its rank and whether it was observed, the label that
    > RAN, and the render warnings — and `final-gate.ts`'s boot branch is now that call plus tally
    > writes. Everything else moved inside: served-app detection, the
    > `renderProbe`/`deepRenderProbe`/`preferredPort` defaults (which are `BootDeps`' own now,
    > matching `findPortHolder`), the four-armed `BootOutcome` destructure, orphan-port recovery,
    > the port-holder diagnosis sentence (which used to reach back into `BootDeps` a SECOND time
    > from the gate), `bootSkipVerdict` and the rejected-launch-script branch. `recoverOrphanPort`
    > takes an options object rather than four trailing positionals — `graceMs` and a boolean sat
    > adjacent and swapped without a type error. `runBootCheck` stays exported unchanged: seven
    > harnesses drive it directly.
- **The two gate halves** — `runGatesForTask` is a thin spine over `resolveVerifyGate` (the VERIFY
  resolution loop: 8 mutable locals, four terminal exits) and `runEnforcePass` (the ENFORCE
  differential: one local, always falls through), joined by ONE boolean — `cleanPass`, the
  genuine-clean-pass signal that decides whether enforce may edit in place. `GateDeps.reVerify` is
  the enforce differential's own field: it and `verify` answer different questions, and while they
  shared one field the only way to answer them differently was to count invocations — a
  `verifyCalls` state machine whose first return existed solely to unlock `mode === 'edit'`,
  re-invented in the suite and again in `scripts/enforce-revert-attribution-replay-ab.ts`.
    > This is a split WITHIN one loop. It does not reopen "the two resolution loops stay two", which
    > is about sharing a spine BETWEEN `runGatesForTask` and `runFinalGateStage` at different
    > altitudes.
- **`FinalGateOptions`** — the run-end gate takes an options object, not a positional tail (the
  production call site read
  `runFinalIntegrationGate(cwd, undefined, undefined, undefined, planText)`, and
  `timeoutMs`/`bootGraceMs` are adjacent numbers that swap without a type error). `run`,
  `envClosure` and `trackedFiles` are seams by the `GateDeps` test. `run` completes a
  `CommandRunner` seam `runGateCommand`, `runVerifyCommandLine` and `rerunDebtVerifyCommand` already
  had; the two git reads make the CONFIG-GAP demotion reachable in test at all — it needs a tracked
  env template in a real git tree, so every launch-contract test (bare `makeDir`, no `git init`)
  missed it by construction. That branch decides whether a failing launch script FAILS the run or is
  demoted to UNOBSERVED debt.
    > The env-gap classification tests keep REAL spawns — "a mocked spawn would test the mock" is
    > right for 127-detection, ENOENT and timeout. Only the tests where the exit code is a premise
    > script it.
- **Autofix ledger** — what the run-end RESOLUTION LOOP records, and the decisions that record
  makes: the attempt count and its bound, the accumulated gitignored writes, the stranded sub-fixes,
  the previous failure signature, the demoted set and the rejected-edits flag. `AutofixLedger`
  (`task/autofix-ledger.ts`), `GateTally`'s twin one altitude up. Methods named for what they mean —
  `attempt()`, `canAutofix()`, `judge(outcome, edited)`, `remaining(outcome)`, `wroteIgnored()`,
  `mayCommitTree()`.
    > Six mutable locals threaded by closure through a ~235-line loop before, with
    > `final-gate-progress.ts`'s five pure functions each called from exactly ONE site inside it —
    > extracted for testability while the ORDERING and CARRY-FORWARD decisions stayed in the caller.
    > That is the shape `isNonProgress`'s own comment indicts: _"the bug is that the decision was
    > made downstream from the evidence"_ — mx5 run 21 shipped a product whose every page was blank
    > as a `completed` run through that gap. `judge` enters the demoted signature and breaks the
    > previous-signature chain in the SAME call that decides to demote, so a demotion cannot
    > cascade; the observed check reads `observedFailures` off the same outcome the failure came
    > from. The suite could previously only observe this loop through trail strings
    > (`startsWith('final-gate: check DEMOTED')`). The ledger performs no I/O — no picker, no ledger
    > file, no commit — for the same reason `GateTally` does not: a record that performs effects
    > cannot be driven by a test that only wants the verdict.
- **Final gate stage** — the run-end decision path, once every task is done: run the gate, trail the
  verdict, surface UNOBSERVED, re-derive open ACCEPT debts, run the resolution picker, bound the
  autofix, handle stranded fixes. `runFinalGateStage` (`task/run-final-gate.ts`) behind a 6-field
  `FinalGateStageDeps` — the run-level twin of `runGatesForTask`, and seamed the same way so it
  tests with no temp dirs and no spawns. It touches none of the task loop's state, which is why it
  could leave `runAutoLoop`.

    > `GateDeps` is behaviour-shaped, not import-shaped. The fields that survive are the ones a test
    > genuinely needs to observe or substitute (`record` writes a different artifact; `revert` and
    > `discardEdits` close over the abort signal; `introducedBy` would otherwise demand a real git
    > history). A field that only forwards to an import is not a seam — import it.
    >
    > **`FinalGateOutcome` crosses the autofix pass WHOLE.** `FinalFixDeps.gate` returns it,
    > `FinalFixResult` carries `gate?: FinalGateOutcome`, and demotion is
    > `FinalGateOutcome → FinalGateOutcome`. It used to be re-declared structurally on the way in,
    > re-flattened into four `gate*` fields on the way out, and rebuilt as a literal three times
    > after — each literal silently dropping `openDebts`. That loss is the mx5 run-18 defect, and
    > the fix at the time was `reconcileDebts` RE-DERIVING the field rather than keeping the value;
    > 19A then had to push `observedFailures` across the same wall as a third parallel field and
    > re-pair it downstream by `gateObservedFailures?.includes(detail)`, a membership test that
    > existed only because the pairing was broken in transit. `reconcileDebts` stays — re-deriving
    > debts against the FINAL tree is a real fact about the tree — but it is no longer the only
    > thing restoring a field the assignment threw away.
    >
    > `recordDebt` and `ownedRequirements` ARE seams by that test, and are now fields: both write or
    > read a durable ledger, which is exactly what a scenario wants to observe. Each defaults to the
    > real implementation when absent, so production wiring is untouched — the twin's "absent →
    > documented earlier behaviour" contract, with the earlier behaviour being the import. They were
    > the only reason all 25 of this stage's tests needed a real temp dir.

- **The two resolution loops stay two.** `runGatesForTask` and `runFinalGateStage` share a policy
  SHAPE — run a check, negotiate a FAIL through a picker whose recommended card may be auto-taken,
  apply, loop — and sharing their spine was examined and REJECTED. Of `GateDeps`' 18 fields only
  `commit` is exactly shared; ~13 have no run-level counterpart at all. `UNOBSERVED` has OPPOSITE
  polarity (a FAIL flag per task, a PASS variant per run). `GateResult` carries `ctx` on every kind
  because a task autofix can replace the live session; `FinalGateStageResult` structurally cannot.
  The autofix bounds count different events (task: unattended invocations only, so manual retries
  are unbounded; run: every attempt, and the card is withdrawn when spent). Dismissing the picker is
  its own terminal state per task and is folded into "leave" per run. A shared spine needs an
  altitude conditional at each of those points — worse than the duplication it removes.

## Worker tools

- **Worker tool** — a tool the main agent calls to gather external context without flooding its own
  context: `pi-worker` (general subagent), `pi-worker-search` (Brave web search), `pi-worker-fetch`
  (fetch + focus a URL), `pi-worker-docs` (focused npm/project docs). Each lives in
  `workers/pi-worker-*.ts`.
- **`makeWorkerTool` (seam)** — the single adapter factory every worker tool registers through
  (`workers/shared.ts`). It owns the registration ritual — `registerTool`, parallel execution mode,
  and wrapping the result in `textResult`. Each worker is an **adapter**: a name/label/schema, a
  `run` that returns `{text, details}`, and a `renderCall`. Adding a worker is an adapter, not
  copied boilerplate.
- **Worker outcome** — what a worker tool PRODUCED: `WorkerOutcome<TDetails>` (`workers/shared.ts`),
  `{kind: 'answer'}` or `{kind: 'unavailable', reason}`, built by `workerAnswer` /
  `workerUnavailable`. `makeWorkerTool` stores only an `answer`, so a non-answer is unrepresentable
  as a research-cache entry, and `cacheable` shrinks to what it is actually about — answer QUALITY
  (`typeOnly`, abstention, `excerptVerified`).
    > It was a bare `{text, details}` bag, and "did it succeed" was re-derived downstream from
    > `details.childExitCode === 0`. That derivation was wrong in the one case it most needed to be
    > right: `runChild` reports `exitCode: code ?? 0`, so a SIGTERM-killed child arrives with exit
    > code 0. REPRODUCED against the shipped rule —
    > `docsCacheable({childExitCode: 0}, "Docs lookup aborted.")` returned `true`, so a cancelled
    > lookup was memoised for the whole run and re-served to every later sibling with escalation
    > unable to re-fire. That is exactly the failure `abstention.ts` exists to stop.
    > `docsFailureResult`'s own contract said it recorded the code "NOT as 0"; the value it copied
    > was 0, and `DocsDetails.aborted` was written and read by nothing, which is what let it hide.
    > `reason` comes from `childFailureReason`, which asks `classifyWorkerFailure` — the one ordered
    > ladder — rather than re-deriving the precedence.
- **`adhoc` clock screen (STEP 1 / STEP 2)** — the two-part measurement of whether the `adhoc`
  profile should take the `research` profile's progress deadline.
  `scripts/live-adhoc-clock-ab.ts` screens; `scripts/live-adhoc-clock-step2.ts` pairs only what the
  screen finds; `scripts/adhoc-clock-score.ts` is the shared scorer, unit-tested away from the GPU.
    > **One arm, then two, and the split is the point.** Under a fixed cap no single attempt can
    > exceed 240s, so "would the shipped profile have killed this?" is answered by the treatment arm
    > ALONE — running a baseline to watch that is measuring arithmetic. What the baseline is
    > genuinely needed for is the risk side, and only for the trials the screen finds over the line.
    > **The corpus is recovered, not invented**: all 45 prompts are real `pi-worker` calls from pi's
    > session transcripts, the only place the tool is recorded — it is unreachable from every
    > pipeline child and appears in ZERO of ~119k logged child tool calls. Inventing prompts of the
    > "right shape" would choose the answer, because breadth is what drives duration:
    > `worker:files`, identical tool set but a fixed narrow prompt, exceeds 240s in 1 of 68 runs.
    > Pinned to a NAMED SHA per repo, and the 23 prompts carrying absolute paths were rewritten to
    > the copy — a prompt naming a live tree would have the worker reading a moving target through
    > `read`. **The scorer is the part most likely to be wrong**, and this repo has rejected this
    > exact axis once for being the thing that was losing (`phase-path-axis-audit.ts`, 56.2% on
    > refine's OWN output). Its CATEGORY-CLEAN rules are lifted verbatim plus the one residual that
    > audit named and did not fix, `src/` prefix elision. A first validation attempt scored
    > known-good answers at 79.0% — and that was the VALIDATION SET failing, not the scorer: those
    > answers were written against trees that have since moved, so the fit set is answers written
    > against the pin. The statistic is paired because the design is
    > (`mcnemarExact`), and the verdict is pre-registered in the STEP 2 header.

- **Worker guard profile** — WHICH KIND of worker child a run is, as one word, and therefore the
  whole guard policy it runs under. `WORKER_PROFILES` (`workers/worker-profiles.ts`) has three rows
  — `research`, `gate`, `adhoc` — and `RunWorkerInput.profile` is required, so no caller can take a
  policy by taking nothing. A `WorkerGuardPolicy` is keyed on `WorkerKillId`: one row per way a
  worker can die, because a guard exists to prevent a specific death. The two facts a profile cannot
  know are `policyInputs` — the gate's two config ceilings, and which research worker is
  docs-capable — and `override` is whole-rows-only and TESTS ONLY.
    > Ten guard knobs sat on `RunWorkerInput` in four different shapes, and three callers each
    > hand-picked a different subset. "A gate child runs unbounded but with a per-command watchdog;
    > a research worker is the reverse" existed only as three option literals in three files, and
    > each literal carried whichever justification someone had needed to write down: `gate-child.ts`
    > explained why it disables the path-revisit rule and said nothing about why it takes no
    > progress deadline, and `pi-worker.ts` named nothing at all. That last one is the cost — the
    > ad-hoc tool turns out to be the STRICTEST-clocked of the three children (a FIXED 240s cap,
    > where a research worker doing the same read-only exploration gets 240s WITHOUT PROGRESS up to
    > twenty minutes), and nobody chose that; it is the residue of never having had a place to write
    > a choice down. It is preserved exactly and now says on its own row that it is unmeasured.
    > **Keying on `WorkerKillId` is the leverage**: adding a tenth cause to `WORKER_KILLS` fails to
    > compile in `worker-profiles.ts` until every profile decides about it, and the three causes with
    > no dial (`leaked-tool-call`, `aborted`, `exit`) say `null` in the table instead of being
    > absent from it. The key does NOT partition the knobs one-per-row and the row types say so:
    > `worker-timeout` holds the cap, the progress ceiling and the fan-out extension because all
    > three move the SAME timer, and `loop` holds both runaway detectors because a `StallDetector`
    > hit IS a `LoopHit` and the restart ladder has one rule for both. **Deliberately NOT unified**:
    > `carryForward` is not a row (it is one switch, and WHICH causes honour it is already derived
    > from the roster as `CARRY_FORWARD_IDS`); the reasoning group is not the profile (`pi-worker`
    > runs `adhoc` guards and the `research` thinking level, and folding them would silently re-level
    > a gate child); `projectDocsBudget` stays out (it bounds what a worker ASKS FOR, not how it
    > dies); and `RESTART_ORDER`/`FAILURE_ORDER` stay two. The proof is a chain, not a diff:
    > `worker-profiles.test.ts` holds a hand-written literal per profile, `gate-child.test.ts` and
    > `research-worker.test.ts` assert their call site still NAMES its profile, and `onPolicy`
    > reports the resolved policy out of the real `runWorker` so "the profile resolved right" and
    > "the body then read it right" are separately observable. Four wrong wirings were introduced and
    > each turned a test red.
- **Worker failure message** — what a kill cause SAYS to whoever asked for the work.
  `describeWorkerFailure` (`workers/worker-failure.ts`) is a compiler-exhaustive switch over the
  `WorkerFailure` union, and `formatChildFailure` (`workers/shared.ts`) ASKS it instead of
  re-deriving.
    > `formatChildFailure` answered `if (aborted) return abortedMessage`, and every kill path also
    > sets `aborted` — so a 240s wall-clock kill, a hung `bash`, a dead model backend, a loop kill
    > and a user pressing ESC all printed the same four words. It was handed a `ChildOutcome`
    > (`{aborted, exitCode, stderr}`) which cannot even REPRESENT the difference, while
    > `childFailureReason` — one line later at the only caller holding the richer result — computed
    > the cause exactly and put it in a debug trail no user reads. Same shape as the bug this
    > module's own header records, one layer out: a second author of a taxonomy the module exists
    > to own. **The cost was measured, not argued**: across 53 recorded `pi-worker` invocations in
    > eight repos, 14 failed and nothing in the transcript said which of them ran out of time — the
    > bound recoverable from timestamps alone was "between 0 and 8", so the `adhoc` profile's FIXED
    > 240s cap has no production base rate and could not have one. A switch rather than a table
    > because `WorkerFailure` carries a different payload per arm; a ninth arm fails to compile
    > until it has a message. A caller holding only a `ChildOutcome` (`focused-extractor`) is
    > unchanged: with no kill flags the ladder falls through to `aborted`/`exit`, which
    > `shared.test.ts` pins byte-for-byte alongside the two tests that fail on the before-tree.

- **Kill-cause ladder (one author, four consumers)** — `classifyWorkerFailure`
  (`workers/worker-failure.ts`) is the ONLY statement of kill-cause precedence, and `runWorker`'s
  `finalAttemptFailed` asks it rather than restating it.
    > It was an inline eight-term disjunction 990 lines below `RESTART_RULES` and in a different
    > file from the ladder — a fifth author of a taxonomy the module exists to own — and it was
    > missing two of `FAILURE_RULES`' rows: `leakedToolCall` and a plain non-zero `exitCode`. Both
    > are cases where an attempt that produced nothing usable counted as NOT failed, so SALVAGE was
    > skipped and a good discarded partial was overwritten by the crash's leftovers — the exact
    > outcome the salvage comment forbids ("a restart budget is meant to buy more chances at an
    > answer, not to overwrite a good attempt with a worse one"). The two non-kill terms — an empty
    > answer and a `modelError` on a run that still produced text — stay explicit, because
    > `worker-failure.ts` deliberately excludes them as CONSUMER policy.
- **Package acquisition** — getting one package onto disk and resolved: `acquirePackage`
  (`workers/docs-core.ts`) resolves from `cwd` and, on `not_installed`, installs at the range the
  PROJECT declares before resolving again from the install dir. It returns a discriminated outcome
  naming the STAGE it failed at (`resolve` | `install` | `reresolve`), so `docsRaw` shapes its own
  rich error results and the redirect-hop adapter (`tryResolveOrInstall`) just returns `null`.
    > CONTEXT.md already recorded the redirect WALK as unified (`resolveTypeSource`) and its
    > `resolveHop` seam as "the one thing its two call sites disagree about". The acquisition UNDER
    > it was still written twice, and the copies had drifted on all three things that matter.
    > **Signal**: the hop copy passed it; the primary copy wrote a bare `undefined` into the slot to
    > reach the fourth positional, while `DocsRawInput.signal` was honoured on either side of that
    > call — so a user cancel during the MAIN `npm install` of a model-chosen package was not
    > delivered. `runAutoInstall` takes `AutoInstallOptions` now, so that hole cannot be typed.
    > **Pin**: `findDeclaredRange` had exactly ONE call site, the primary copy; the hop installed
    > `latest` unconditionally, on the hop most likely to be the declared one — `declarationChain`
    > exists precisely because "a project that uses Bun declares `@types/bun`, not `bun`".
    > **Provenance**: `autoInstalled` and `autoInstallPin` were `docsRaw` locals, so a package
    > acquired only through a hop got no version banner. The suite asserted the pinning property on
    > the primary path, and no test in the repo named `tryResolveOrInstall` — the copy silently
    > doing the opposite.
- **Child-failure** — the standard outcome of a worker's child pi failing (aborted, or non-zero exit
  with an stderr tail). Formatted in exactly one place, `formatChildFailure` (`workers/shared.ts`),
  so the rule never drifts across workers. Returns `null` when the child succeeded.
- **`httpRequest` (seam)** — the one bounded HTTP request (`workers/http-request.ts`):
  `httpRequest(url, opts, handle)` owns the internal `AbortController`, the wall clock, the
  `userAborted` flag and the `finally` that clears both, and throws
  `HttpRequestError{kind: 'aborted' | 'network'}`. The handler runs INSIDE the clock — `fetch`
  resolves on headers, so a seam that returned the `Response` and cleared its own timer would leave
  the body read unbounded.
    > Five modules hand-rolled the same ~12 lines (`brave-search`, `exa-search`, `ddg-search`,
    > `html-clean`, `npm-version`), and the copies had DRIFTED: `npm-version.ts` never grew the
    > `userAborted` flag, so a user cancel returned `null` — indistinguishable from a registry that
    > is down. It throws now; every caller already wrapped it in `.catch(() => null)`, so the
    > degraded answer is unchanged and the distinction is available. What is shared is the BOUNDING,
    > not the interpretation: each caller keeps its own status policy (DDG treats 429/403 as
    > throttling, Brave splits auth from rate-limit, npm treats every non-OK as "no answer") and its
    > own error type. What they cannot differ on is whether the request was cancelled, timed out, or
    > was refused.
- **Search provider (adapter)** — an engine is a row: `SEARCH_ADAPTERS` (`workers/search-core.ts`)
  carries `run`, the missing-key message, and which throws already carry a finished user-facing
  message. Its key requirement is `SEARCH_PROVIDER_KEY_ENV` in `search-types.ts`, beside the ids.
    > `SearchProvider` was a union with nothing behind it, so every consumer branched on it by hand:
    > `search()` had a brave special case plus a two-arm ternary, the three engine functions arrived
    > as three separate seams on `SearchCoreInput`, the three error classes were reconciled by
    > matching `err.name` as a STRING, and brave's key pair was stated a second time in `phases.ts`
    > under a comment saying it "mirrors search-core's lookup". `searchConfigured` asks the same row
    > now — and it is the thing that decides whether the APIS research worker is handed the search
    > tool at all. Brave was also the ONE provider without an injectable `fetchImpl`, so its status
    > ladder — the widest of the three — could not be driven at the request level; the seam gives
    > every provider the same door.
- **Focused extractor (seam)** — running a `--no-tools` child pi that answers ONE question over
  content already in hand and cites a verbatim `<excerpt>`, then checking that citation.
  `runFocusedExtraction` (`workers/focused-extractor.ts`) is the single implementation; its four
  call sites (`fetchFocused`, `docsFocused`, and both `pi-worker-docs.ts` paths) are **adapters**
  that supply the three things that genuinely vary: the prompt body, the **verify target**, and what
  the answer MEANS. Everything else — the `--no-tools` argv (`focusedChildArgs`), invocation,
  `runChild`, `parseChildOutput`, and no-retry — is the seam's.

    > The **verify target** is a named parameter because the sites disagree on purpose: the docs
    > paths verify against exactly the content they prompted with; fetch verifies against the FULL
    > cleaned page while prompting with only the anchored `#fragment` slice, so fragment anchoring
    > cannot weaken the hallucination check. A failed child returns no `answer` at all (the result
    > is a discriminated union), and every site now receives the rich `ExcerptVerification` rather
    > than a bare boolean.

- **Worker channel** — what a worker TOOL is, as data: a row in `WORKER_CHANNELS`
  (`workers/worker-channels.ts`) carrying the tool `name`, the `-e` `entryPath` that registers it,
  whether it `grounding`s a claim, how to `summarize` its arguments for the debug log, and any
  per-tool predicate. `channelSet(names)` returns the tools string and the `-e` paths TOGETHER,
  because they are one fact.
    > `spec.name` never left the registration closure, so the same names were re-typed as literals
    > in three directories and had to agree by hand: `phases.ts` paired a tools string with an
    > extension path list by eye, `GROUNDING_RETRIEVAL_TOOLS` was a second copy, and
    > `summarizeToolArgs` a third that also re-stated each tool's parameter shape. Worst for
    > locality: `runWorker` — the GENERIC child runner — hardcoded one tool's identity AND its
    > parameter (`call.name === 'pi-worker-docs' && args.module === '.'`) to decide a fan-out
    > deadline extension; it asks the row's `isProjectSourceLookup` now. A rename was five edits
    > with no compile error linking them. `read`/`grep` are NOT rows — they are pi's own built-ins.
    > They are in the grounding set because grounding is about RETRIEVAL, not about which extension
    > supplies the tool.
- **Type-redirect walk** — `resolveTypeSource` (`workers/docs-resolve.ts`): follow the
  `@types/<name>` + triple-slash `<reference types>` chain from a package that ships no usable types
  to the one that holds them (`bun` → `@types/bun` → `bun-types`), bounded to three hops.
  `resolveHop` is injected — the one thing its two call sites disagree about (the docs pipeline
  auto-installs, the phantom-import checker resolves sync and never installs).
    > It lived as two byte-identical copies in `docs-core.ts` and `phantom-imports.ts` while its
    > four predicates were exported and covered by 35 test references. Neither copy was tested: both
    > pinned the zero-hop case only, so the multi-hop behaviour cited by name in five doc comments
    > was asserted nowhere. This is the shape where pure functions get extracted for testability and
    > the real logic stays in how they are CALLED.
- **Cache policy predicates** — each cacheable Worker tool's `cacheable`/`cacheKey`/ `cachePkg` are
  NAMED exports (`docsCacheable`, `fetchCacheable`, …), not anonymous properties of the adapter
  literal. They were reachable only through `registerTool → execute()`, so two test files
  hand-retyped them under "keep in sync" comments — ten tests asserting against copies a change to
  the shipped rule would leave green. These are the F-2(e) rules whose PREVIOUS drift is documented
  at length in `abstention.ts` and cost a real bug.
- **Retrieval limits** — `PACKAGE_RETRIEVE_LIMIT` (8) and `PROJECT_RETRIEVE_LIMIT` (50) live in
  `workers/docs-retrieve.ts`, the module that owns the query language. They were three declarations
  across three files at two values, so the divergence was invisible; no comment in the history
  explains WHY the two corpora differ. Recorded as-is rather than harmonised — changing either is a
  retrieval-policy change with its own A/B.

> `pi-worker-search` is the outlier: it is a direct Brave API call with **no child pi**, so it
> registers through `makeWorkerTool` but has no child-failure.

- **Worker kill** — the ROSTER of ways a worker child can die (`workers/worker-kill.ts`): one
  `WORKER_KILLS` row per cause, carrying the `RunWorkerResult` field that reports it, whether its
  partial output is worth carrying forward, and whether it restarts and/or is reported.
  `CARRY_FORWARD_IDS` is derived; `WorkerRestartReason` is derived from `RESTART_ORDER`, which is
  `as const satisfies readonly WorkerKillId[]` — an annotation instead collapses that type to the
  whole union and lets `noteRestart('aborted')` compile for a cause the ladder has no rule for.
    > One cause used to be named in SIX unlinked places — a `RunWorkerInput` guard option, a
    > `RunWorkerResult` field, the `WorkerRestartReason` union, a `RESTART_RULES` row,
    > `CARRY_FORWARD_REASONS`, and a `FAILURE_RULES` row — and only two of them failed to compile if
    > you skipped one. `worker-failure.ts` fixed the READER side after that cost a shipped bug
    > (`streamStalled` reached the result and the restart ladder but never grew an arm in the
    > enforce ladder, so a child killed for a hung model stream was reported as a user cancel). This
    > closes the AUTHOR side. **The two ORDERINGS stay two.** They genuinely disagree and each says
    > why: `RESTART_ORDER` leads with `loop` (its hint names the offending call), `FAILURE_ORDER`
    > leads with `stalled` (the diagnosis most easily lost behind the `aborted` every kill path also
    > sets). Folding two precedences into one row type needs an escape hatch per row — the objection
    > that got a `WriteGuard` row table rejected. What they gain is that neither can name a cause
    > with no row nor omit one, checked in `worker-kill.test.ts`.
- **Docs corpus** — what a docs lookup READS, as a row (`workers/docs-lookup.ts`).
  `docsLookup(input)` is the tail — concatenate, extract, verify, format — and `DocsCorpus` is the
  two things that vary: the prompt and the header the answer is introduced by (plus the abort
  wording). `packageCorpus(pkg)` lives with `buildPrompt`/`packageHeader`; `projectCorpus(name)`
  with `buildProjectPrompt`.
    > The tail existed THREE times: `pi-worker-docs`'s project arm, its package arm, and
    > `docsFocused`. The fetch channel is the proof it was avoidable — `fetchFocused` is one core
    > and `pi-worker-fetch.run` is 60 lines, against 293 for the same job over two corpora. The
    > copies had drifted where hand-flattening always drifts: the package arm's ERROR path dropped
    > `autoInstallPin`, which both sibling arms keep, so a package auto-installed and then failed to
    > re-resolve lost its `versionSource`/`declaredRange`. Deleted on the way: the
    > `DocsRawResult.not_installed` variant, which was CONSTRUCTED NOWHERE and handled in three
    > places, one of them a guard against an arm that could not occur.
- **Session hint** — a one-line startup hint in the TUI and the whole widget lifetime around it:
  `registerSessionHint(pi, key, compose)` (`workers/session-hint.ts`). `compose` is the seam and
  returns text; nothing about widgets, keystrokes or teardown reaches it.
    > Two hints (`brave-warning`, `reasoning-warning`) had written the ritual out down to a
    > byte-identical comment. The REFINE half is why this is not just deduplication: a hint may
    > learn something after it has painted, and the rule that a refinement must never repaint a
    > widget the user already dismissed lived in one closure variable in one of the two files. The
    > reasoning hint's probe branch had ZERO tests — no test model carried a `baseUrl` — while
    > `formatCapabilityConflict` beside it had four. The probe is injected now.

## Settings

- **Config loader** — how one setting's STORED value becomes a safe in-memory value.
  `CONFIG_LOADERS` (`config/config.ts`) is a mapped type over `PiTaskConfig` — one loader per key,
  keyed on the config's own type — and `loadConfig(raw)` is the pure function that applies the whole
  table. The module-eval read is now `readFileSync → JSON.parse → loadConfig`.
    > `ConfigItem` (`config/register.ts`) already made this argument and stopped one edit short. Its
    > own header: _"Adding one enum setting meant FOUR coordinated edits (row, format arm, parse
    > arm, sanitizer) and NONE of them failed to compile if you forgot it."_ Three were absorbed;
    > the sanitizer stayed in another directory as a hand-ordered statement ladder covering 7 of 14
    > keys, then spreading `parsed` wholesale. Of the EIGHT booleans exactly one — `yoloMode` — was
    > guarded, and its guard's comment (_"a hand-edited `"yoloMode": "false"` is a truthy string"_)
    > was true verbatim of the other seven: a stale `"verifyWork": "off"` read as truthy,
    > `"autoCommit": 0` as falsy. `booleanItem` already knew every one of those keys was a boolean
    > and was not consulted at load. A new field on `PiTaskConfig` is now a compile error until it
    > declares a loader (verified: adding one breaks the build at both `DEFAULT_CONFIG` and
    > `CONFIG_LOADERS`). The spread also had a shape bug the seam closes:
    > `{...DEFAULT_CONFIG, ...'ab'}` produces numeric index keys, so a config file holding a bare
    > JSON string reached `getConfig()` as junk. `loadConfig` answers a non-object with the
    > defaults, and drops keys the table does not know rather than carrying them. **The seam is why
    > the composition is testable at all.** Every sanitizer was covered in isolation; WHICH keys got
    > one, and what the trailing spread did to the rest, had zero coverage — `config.test.ts` says
    > so twice ("asserted through the sanitizer, not getConfig, so a developer's own
    > ~/.config/pi-task/config.json cannot flip the test"). `loadConfig` takes parsed JSON, so the
    > hostile-value property runs over the whole table without reading this machine.
- **`ConfigItem` covers the DISCOVERED rows too.** `id` is `string`, not `keyof PiTaskConfig`, so
  the reasoning groups and the per-tool / per-extension toggles are rows rather than bypasses.
  `configRows(installed, tools)` is every row; `renderRows(cfg, rows)` renders them under their
  section headers; and `syncRows(cfg, rows, list)` re-asks every row's `format` after any change.
    > While the id was narrow, each of the three dynamic families re-invented both directions by
    > hand — a builder, an apply function, and an arm in a four-way prefix ladder 300 lines away.
    > `PanelItem.currentValue` was a SNAPSHOT where `ConfigItem.format` is a function, which is the
    > whole cause of the regression pinned in `reasoning-rows.test.ts` ("the menu showed
    > `reasoning off` beside seven `think:` rows still reading `inherit`") — and the fix was a
    > fourth function, `refreshReasoningRows`, whose only job was to undo the snapshot. That
    > function ran after EVERY change but hard-coded the seven reasoning ids plus `reasoningMode`
    > and touched none of the other ~30 rows, so the next cross-row dependency needed a fifth. It is
    > deleted. `config-items.test.ts`'s round-trip properties now cover every family; `ext:` and
    > `tool:` had none at all.
- **`effectiveReasoning(cfg)`** — the WHOLE reasoning table as this config will run it
  (`config/reasoning.ts`). `resolveReasoning` stays for the single-group question and is still the
  only place the four modes are interpreted.
    > Every real caller wanted the whole table, so the loop over `resolveReasoning` was written four
    > times — and one of them invented a THIRD shape (`Array<{group, setting}>`) that leaked into
    > `reasoningMismatches` and came back as an `as LadderLevel` cast. `settingsFrom` failed the
    > deletion test and is gone. `groupThinkingArgs(group, cfg?)` takes the config as a parameter
    > now: it has seven call sites and had zero tests, and its stated invariant — read PER CALL,
    > never cached at module scope — was assertable nowhere, so hoisting the read would have left
    > the whole suite green.
- **`REASONING_GROUP_BY_CHILD` covers the four research workers.** Keyed on `spec.label`
  (`worker:files`, …) — the same name the loader, the debug trail and the A/B ledgers already print.
    > There were TWO name-keyed maps in two directories with two failure modes. The research one
    > (`RESEARCH_WORKER_GROUPS`, keyed on the SECTION heading) fell back to `research` silently, and
    > its guard sliced `phases.ts` source between two string offsets from the config directory. It
    > failed the deletion test — its own docstring admitted it existed "so the wiring is one table
    > rather than four string literals" — so it was folded into the one that earns its keep. One
    > roster, one scanner, one failure mode: a build failure. Workers resolve their level through
    > `thinkingForChild` like every other named child, so the `?? 'research'` fallback is gone as
    > well.
