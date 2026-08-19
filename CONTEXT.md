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
  > **`TaskRunnerOptions`** — the single-task runner takes one options object, not
  > ten positionals (`RunSingleTaskOptions` was already a bag that got
  > re-flattened into them). It carries `runChild?: PhaseDeps['runChild']` straight
  > through into `PhaseDeps`, so a runner-driven test answers phase children BY
  > NAME (`scriptedChildren({refine, 'grill-gen', compose, critique, …})`) instead
  > of matching prompt prose. `spawn` stays beside it for the two orchestrator
  > tests that ARE about the ladder (empty completion, loop exhaustion). The one
  > thing `runChild` cannot reach from a `TaskRunner` is the four research workers:
  > `PHASES.research` calls `phaseResearch(d, p.refined)` with no
  > `PhaseResearchDeps`, so `runWorker(label, input)` is unreachable from the runner
  > and those four remain prompt-keyed in `orchestrator.test.ts` — labelled as
  > such, and the next seam to thread.
- **Implementation turn** — the supervision that runs between "spec delivered" and
  "we know how the implementation REALLY ended" (`task/implementation-turn.ts`). A
  single `waitForIdle` resolves for four reasons and only one is completion;
  `classifyTurnEnd(entries)` names it — `aborted` > `compaction` > `error` >
  `stop`, the precedence the old three booleans (`wasInterrupted`,
  `endedAtCompactionBoundary`, `implementationError`) applied by call order — so a
  new terminal state is one enum member, not a fourth boolean.
  `superviseImplementation(ctx, opts)` owns resume-across-compactions →
  steer-until-done → read-the-error behind `ImplementationTurnDeps` (`entries`,
  `send`, `waitForIdle`, `ask`, `watchdog`, `log?`), bound from a live ctx by
  `turnDepsFor`; `runSingleTask` calls it once. The steer prompt still fans out
  through `SessionUI` (local input + remote card) — that binding moved with it,
  unchanged.
- **ChildStatus** — the live status of the child pi running under a status
  loader: its latest stream line and its context gauge, plus the loader ritual
  around one child (`track`: reset, raise a loader whose every tick is the frame
  merged over the live status, run, always stop). `task/child-status.ts`. It was
  `let lastLine; let contextUsage;` + two callbacks + a reset + a loader in three
  places — `/task-auto`'s planning `runChild`, `/task-plan`'s `child`, and
  `buildGateDeps` (an accessor box handed to `makeGateChild`) — and the first two
  were the same 25 lines. `runPlanningChild` is what both are thin adapters over;
  what genuinely varied (tool set, head command, per-tick step label, task id,
  read-once extension, debug log) is a parameter, and the read-only tree diff
  stays `/task-plan`'s own. The status OUTLIVES a track: the gate shares one
  across every gate child, and the verify gate's gate-wide loader reads it over a
  child that renders none (`frame: null`).
  > The fourth mirror, `TaskRunner`'s `_widgetState`, is deliberately NOT one: its
  > state is the whole-run `WidgetState`, shared by reference with `PhaseContext`
  > and written by the phases themselves; only the two callbacks overlap.
- **Run bracket** — what "a command owns the session" means, in one place:
  `withRun(ctx, {onCancel?}, fn)` (`task/run-bracket.ts`) holds mid-run input
  (`beginRun`/`endRun`) and arms the raw-stdin interception
  (`armCancelListener`/`disarm…`) for exactly `fn`'s duration, releases both on
  return and on throw, and reports the held lines that never found a turn. It was
  written out at four sites in two files whose `finally` halves disagreed on order
  (the orchestrator disarmed first, `/task-auto` ended first) — an order that is
  not observable, so there is one order, not an option. `/task-plan` was the fifth
  owner and never bracketed; it does now, so a line typed during a planning child
  is held for the handed-off run's first turn instead of firing from pi's queue
  after the plan. `TaskRunner.run` used to begin ~65 lines before its `try`, so a
  throw in task-file setup leaked both refcounts for the process lifetime; wrapping
  the whole body closes that. The two refcounts (`runDepth`, `armed.depth`) stay
  two — read by different consumers with no ctx in hand, armed alone by the cancel
  harness — but the bracket is now the ONLY production caller of either pair,
  which is what prevents drift. `announceTerminal(ctx, msg, level, {push?})` is
  the terminal triplet (toast + remote bubble + web push) that `announceDone`,
  `/task`'s `announce` and `/task-plan`'s two endings each hand-rolled;
  `/task-plan` opts out of the push because a plan is a conversation, not a task —
  the run it hands off to pushes its own ending.
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
  > Every phase child goes through the `PhaseDeps.runChild(name, tools, prompt)`
  > seam, and every research worker through `PhaseResearchDeps.runWorker(label,
  > input)`. Both default to the real implementation when absent, so production is
  > untouched. They take a NAME because the name is what a caller branches on: it
  > used to be discarded before reaching the only injectable boundary (`spawn`), so
  > `phases.test.ts` reconstructed it by matching prompt PROSE against
  > `prompts.ts` — 27 routing decisions keyed on sentences this codebase reworders
  > and A/B's for a living. `spawn` stays: the Error-triage ladder's own tests must
  > drive a real process. The seams are for callers to whom the child is a premise.
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
  > The eight bound probes reach the table as ONE dep, `VerificationDeps.probes:
  > VerifyProbes` — a mapped type over `ProbeRaw`, the interface where each
  > channel's raw shape is declared once (`ProbeKey = keyof ProbeRaw`). A row reads
  > `deps.probes[key]` by default; only skip-escape overrides its `source`, because
  > it is text analysis of the spec the deps already carry and is never bound. The
  > collectors meet the table in exactly one place, `buildVerifyProbes` in
  > `task/gate-deps.ts` (`buildGateDeps.verify` is now: read spec, build probes, run
  > verify), and `readSpecForVerification` is the one spec read all four gate sites
  > share instead of four copies of the same try/catch. Adding a probe is a
  > `ProbeRaw` line, a table row and a binding line; deleting one, the compiler
  > names the row and the binding. Skip-when-absent and degrade-to-empty stay in
  > the row's `run` — the binder needs no try/catch and a fault in one probe cannot
  > reach another. `BOUND_PROBE_KEYS` is derived from the table so the binder is
  > checked against the rows, not a hand-kept list.
- **Closure scan** — a run-level static check that reads the tree and emits
  failure lines, fault-isolated so a scanner bug can never break the gate. Rows
  in `CLOSURE_SCANS` (`task/final-gate.ts`) carry an id, a `stage`
  (pre-discovery vs post-boot — a real fact about when the check is meaningful,
  not scheduling), a rank, and a generator so partial findings survive a
  mid-scan fault. Only the three uniform scans are in the table; repo-health,
  launch-contract, launch-config-gap and the boot check are deliberately outside
  it, because each would need its own escape hatch in the row type.
- **Gate tally** — what the run-end gate's sections RECORD, and the one pure
  function that turns the record into a `FinalGateOutcome`. `GateTally`
  (`task/gate-tally.ts`) replaces the twelve mutable locals
  `runFinalIntegrationGate` threaded through ~400 lines by closure — the ranked
  failure list, four dynamic counters, three note lists, warnings, the boot
  verdict. Each section calls a method named for what it means (`attempted(bin)`,
  `observed()`, `unobserve()` for the config-gap un-count that used to be
  `dynObserved -= 1`, `failObserved()` for a probe that looked), and
  `verdict(debts)` is the ONLY place the PASS / FAIL / UNOBSERVED polarity, note
  ordering (boot note, zero-observation verdict, config gaps, inert contract) and
  debt attachment live — testable with no tree, where before it was reachable only
  through temp dirs and `node -e`. `observabilityGapFailure` and
  `unobservedVerdict` moved with the counters they read; `final-gate.ts`
  re-exports them.
  > The zero-discovery return now asks the tally (`!boot && tally.silent()`) and
  > sits AFTER the launch-script loop, which is the one-line fix for the f5d7110
  > finding: a declared, present, non-boot-class launch script RUNS on a tree with
  > no discoverable integration/lockfile/boot command. It still returns before the
  > boot `else` branch and the post-boot closure scans: `stage` is a statement
  > about when a scan is meaningful, and this did not change it. Repo-health,
  > launch-contract, config-gap and boot remain outside `CLOSURE_SCANS`.
- **Deep-render driver halves** — `deep-render-check.ts`'s `drive()` is launch →
  session → close, split at the `Cdp` seam it already had. `launchBrowser(bin,
  userDataDir, {signal})` is everything that touches a process or a socket:
  spawn, read the DevTools banner, connect, and a `close` that is idempotent,
  never throws, and is also what the caller's abort `signal` fires — so a budget
  timeout reaches a browser that never listened, which two hold-callbacks used to
  do by hand. `driveSession(cdp: CdpLike, {url, credentials, judge, quietMs})` is
  the protocol body unchanged, over the two methods it actually calls (`send`,
  `on`) — defined from the consumer, not from `Cdp`, so a scripted fake is a dozen
  lines. `judge` is a parameter because `drive` is where the recorder hook wraps
  `judgeDeepSession`; the session only gathers facts.
  `deep-render-driver.test.ts` keeps its fake Chrome on disk for the launch half;
  `deep-render-check.session.test.ts` is the branch table for the session half.
  > `Cdp` itself did not move and `runDeepRenderCheck` still owns the temp profile
  > dir: the split is at the process/protocol boundary, not a re-shaping of the
  > client.
- **Debt origin** — why a debt entered the ledger. `DEBT_LABELS`
  (`task/accept-debt.ts`) is the registry: a `Record<DebtOrigin, string>`, so a
  new union member is a compile error until it has a label. One writer,
  `recordDebt(cwd, taskId, reason, origin)`, replaced eight byte-identical
  recorders; the parser reads the same table instead of a hand-maintained
  whitelist. Adding an origin is three edits.
  > The ACCEPT-debt re-check — `deriveOpenDebts` and `rerunDebtVerifyCommand` —
  > lives here too, with the ledger it reads and writes; `runVerifyCommandLine`
  > lives in `command-run.ts` with the other command drivers. `final-gate.ts`
  > re-exports all three so the orchestrator and the harnesses under `scripts/`
  > are unchanged.
- **Ledger** — a run-level line file under `.pi-tasks/` with one read-modify-write
  ritual: read (any error → ''), parse, key, drop what is already stored, cap to
  the newest `max` (oldest dropped), mkdir, write the whole file back (`join('\n')
  + '\n'`, plain `writeFile`, not atomic), swallow every fault. `makeLedger`
  (`task/ledger.ts`) is the one implementation; contracts, launch-contract,
  env-notes, accept-debt, repair-queue and both requirements files are
  **adapters** that declare file/max/key/serialize/parse and call
  `read`/`append`/`write`. Six copies of the ritual agreed on everything except ONE
  rule — what an append does when it adds nothing new: the four batch ledgers
  rewrite (re-cap, canonicalise), the two single-record ledgers (`recordDebt`,
  `recordRepairCandidate`) return without touching the file. That is `onNoop:
  'rewrite' | 'skip'`, an option rather than a unification, because the two are
  observable once a file has drifted from what its writer produces. `recordDebt`
  is still the ONLY debt writer; the ledger is what it calls, not a second door.
  > Stored contract/requirement lines are kept VERBATIM and keyed by the
  > normalised first quoted span; a new entry carries the key of its quote
  > directly (`{line, key}`), so the dedupe rule is unchanged even for a quote
  > containing `"`. Not atomic and not made atomic — no site was.
- **Boot probe** — does the assembled product actually START, and does the page it
  serves actually render? `task/boot-probe.ts`: shell-chain lexing and non-launch
  detection, boot-command discovery, listener enumeration (ss/netstat/lsof), port
  reservation, `runBootCheck`, orphan-port recovery and `bootSkipVerdict`. It was
  42% of `final-gate.ts` and the largest of that file's seven concerns, while
  nothing inside `src/` imported any of it except the one call site in
  `runFinalIntegrationGate` — the boundary already existed in the CONSUMERS, seven
  harnesses under `scripts/` that import exactly this surface. The gate re-exports
  the public names so those keep working, the same way `taskThatIntroduced` does.
  > Still deliberately NOT a `CLOSURE_SCANS` row: it is async, stateful and
  > port-binding, and would need its own escape hatch in the row type. This was a
  > file move, not a re-shaping.
- **The two gate halves** — `runGatesForTask` is a thin spine over
  `resolveVerifyGate` (the VERIFY resolution loop: 8 mutable locals, four terminal
  exits) and `runEnforcePass` (the ENFORCE differential: one local, always falls
  through), joined by ONE boolean — `cleanPass`, the genuine-clean-pass signal that
  decides whether enforce may edit in place. `GateDeps.reVerify` is the enforce
  differential's own field: it and `verify` answer different questions, and while
  they shared one field the only way to answer them differently was to count
  invocations — a `verifyCalls` state machine whose first return existed solely to
  unlock `mode === 'edit'`, re-invented in the suite and again in
  `scripts/enforce-revert-attribution-replay-ab.ts`.
  > This is a split WITHIN one loop. It does not reopen "the two resolution loops
  > stay two", which is about sharing a spine BETWEEN `runGatesForTask` and
  > `runFinalGateStage` at different altitudes.
- **`FinalGateOptions`** — the run-end gate takes an options object, not a
  positional tail (the production call site read `runFinalIntegrationGate(cwd,
  undefined, undefined, undefined, planText)`, and `timeoutMs`/`bootGraceMs` are
  adjacent numbers that swap without a type error). `run`, `envClosure` and
  `trackedFiles` are seams by the `GateDeps` test. `run` completes a
  `CommandRunner` seam `runGateCommand`, `runVerifyCommandLine` and
  `rerunDebtVerifyCommand` already had; the two git reads make the CONFIG-GAP
  demotion reachable in test at all — it needs a tracked env template in a real git
  tree, so every launch-contract test (bare `makeDir`, no `git init`) missed it by
  construction. That branch decides whether a failing launch script FAILS the run or
  is demoted to UNOBSERVED debt.
  > The env-gap classification tests keep REAL spawns — "a mocked spawn would test
  > the mock" is right for 127-detection, ENOENT and timeout. Only the tests where
  > the exit code is a premise script it.
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

- **Type-redirect walk** — `resolveTypeSource` (`workers/docs-resolve.ts`): follow
  the `@types/<name>` + triple-slash `<reference types>` chain from a package that
  ships no usable types to the one that holds them (`bun` → `@types/bun` →
  `bun-types`), bounded to three hops. `resolveHop` is injected — the one thing its
  two call sites disagree about (the docs pipeline auto-installs, the phantom-import
  checker resolves sync and never installs).
  > It lived as two byte-identical copies in `docs-core.ts` and
  > `phantom-imports.ts` while its four predicates were exported and covered by 35
  > test references. Neither copy was tested: both pinned the zero-hop case only, so
  > the multi-hop behaviour cited by name in five doc comments was asserted nowhere.
  > This is the shape where pure functions get extracted for testability and the
  > real logic stays in how they are CALLED.
- **Cache policy predicates** — each cacheable Worker tool's `cacheable`/`cacheKey`/
  `cachePkg` are NAMED exports (`docsCacheable`, `fetchCacheable`, …), not anonymous
  properties of the adapter literal. They were reachable only through `registerTool
  → execute()`, so two test files hand-retyped them under "keep in sync" comments —
  ten tests asserting against copies a change to the shipped rule would leave green.
  These are the F-2(e) rules whose PREVIOUS drift is documented at length in
  `abstention.ts` and cost a real bug.
- **Retrieval limits** — `PACKAGE_RETRIEVE_LIMIT` (8) and `PROJECT_RETRIEVE_LIMIT`
  (50) live in `workers/docs-retrieve.ts`, the module that owns the query language.
  They were three declarations across three files at two values, so the divergence
  was invisible; no comment in the history explains WHY the two corpora differ.
  Recorded as-is rather than harmonised — changing either is a retrieval-policy
  change with its own A/B.

> `pi-worker-search` is the outlier: it is a direct Brave API call with **no
> child pi**, so it registers through `makeWorkerTool` but has no child-failure.
