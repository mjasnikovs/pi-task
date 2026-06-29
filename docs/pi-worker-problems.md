# pi-worker failure classes (#1, #2, #3) — work prompt

Validated against current source on 2026-06-29 from a full `/task-auto` run of a
frontend project (34 tasks). Findings are grounded in `file:line` evidence and the
run's logs, not guessed. Each section is a self-contained work item: problem →
evidence → why it generalizes → proposed fix → acceptance / A/B.

The run's surface symptom was "the built app shipped completely unstyled — CSS did
not load", but the design *comprehension* was fine (design tokens were captured
exactly, components used them 418×). Every actual failure lived in the worker /
orchestration seams below. Fix these, not the project.

---

## #1 — Docs worker is biased to **npm-latest**, exactly when the project pins an older major

### Problem
When a package is **not yet installed** (every greenfield / scaffolding task), the
docs worker resolves its answer against the **latest published version on npm**, not
the version the project pins or intends to install. The implementation model then
receives next-major API semantics for a project that ships an older major, and mixes
the two into an incoherent setup.

### Evidence (current source)
- `src/workers/docs-core.ts:227-242` — on `ResolveError{kind:'not_installed'}` the
  worker calls `runAutoInstall(spawn, parentPkg, …)` with **no version specifier**,
  i.e. `npm/bun install <pkg>` → **latest**, then documents that.
- `src/workers/docs-core.ts:149-167` (`tryResolveOrInstall`) — same latest-install
  fallback on the type-redirect path.
- `src/workers/npm-version.ts:2-11` — the parallel version anchor explicitly fetches
  the registry **`dist-tag 'latest'`**. Its own header comment says the point is to
  stop models answering from a stale training cutoff — but in a scaffolding task
  "latest" is the *wrong* anchor when the project targets an older major.

### Observed failure (the run)
The docs worker reported (task spec, APIS section): *"tailwindcss … for Tailwind CSS
**v4** … `tailwind.config.ts` does NOT work in v4 … use the `@theme` directive."* The
project pinned `tailwindcss@^3.4.19`. The model then built a v3 config + v3 directives
(correct for v3) while carrying v4 mental model — and never got correct v3 build-wiring.

### Why it generalizes
Hits any library with a major API break across versions: Tailwind 3→4, ESLint flat
config, React Router 6/7, Express 4/5, etc. Worst precisely in setup/scaffold tasks,
which is when version intent matters most.

### Proposed fix
Before falling back to npm-latest, resolve the **intended** version, in priority order:
1. the installed version (already available via `docs-resolve.ts` → `pkg.version`);
2. the range in the project's `package.json` / lockfile, if the dep is declared but
   not yet installed — install/answer for that range's resolved version, not latest;
3. a version named in the task spec.

When none exists and the worker must use latest, the answer must **lead with** an
explicit banner: *"Answer based on npm latest vX. Your project may target a different
major — verify against your pinned version."* Today the resolved version is buried in
`details`, not asserted in the prose the impl model reads.

### Acceptance / A/B
- Unit: given a `package.json` declaring `^3.x` for an uninstalled pkg whose npm latest
  is `4.x`, the worker answers for `3.x` (or banners latest explicitly), never silently `4.x`.
- A/B on live local model: feed two docs answers (silent-latest vs version-pinned/bannered)
  into the impl turn for a v3-pinned project; measure whether the impl produces a
  version-coherent setup. Expect the pinned/bannered arm to stop the v3/v4 mismatch.

---

## #2 — A flagged KNOWN-UNKNOWN dies as prose; there is no escalation path

### Problem
The pipeline asks the model to surface `KNOWN-UNKNOWNS`, and it does — but a flagged
unknown is written into the spec text and then **nothing consumes it**. It is not
routed to a worker to resolve, and not hoisted into the user clarify gate. The impl
turn then *guesses* on the open question, and the guess becomes a silent landmine.

### Evidence (current source)
- `src/task/prompts.ts:83` and `:219` — KNOWN-UNKNOWNS are authored and refined
  (research may "drop unknowns it resolved"), but the surviving unknowns have no
  downstream consumer.
- `src/task/auto-orchestrator.ts:306` — known-unknowns are only **scope-fenced** to the
  task slice; there is no "route this unknown to fetch/docs/user" step.
- No code path links a surviving KNOWN-UNKNOWN to `pi-worker-fetch`, `pi-worker-docs`,
  or the clarify question batch (grep of `src` confirms the only matches are the prompt
  strings + the scope fence).

### Observed failure (the run)
The model itself wrote, verbatim, in a task's KNOWN-UNKNOWNS: *"the spec mentions
`bun-plugin-tailwind` for the build pipeline but does not define how to wire it … should
the CSS import structure in `index.html` be modified?"* — the exact integration question
whose wrong guess shipped the unstyled build. It was logged and then guessed, never resolved.

### Why it generalizes
"I don't know how X integrates / is wired" is the highest-risk sentence in any build.
Today it produces a guess instead of an action, on every project.

### Proposed fix
Classify surviving known-unknowns. An unknown that names an external tool / integration /
build-wiring not covered by installed-package docs should **auto-trigger** a follow-up
worker query (fetch the named tool's README / docs) before impl; if still unresolved,
**hoist it into the user clarify batch** rather than letting impl proceed on a guess.
A confidence/unknown → action mapping, not free-text that evaporates.

### Acceptance / A/B
- Unit: a spec carrying an integration-class KNOWN-UNKNOWN produces a fetch/docs follow-up
  task or a clarify question; a benign unknown does not.
- A/B on live local model: run a task whose only ambiguity is a build-wiring unknown,
  with routing OFF vs ON; expect OFF to guess (and break), ON to resolve or ask.

---

## #3 — `pi-worker-fetch` (and research `pi-worker`) are effectively unreachable to the local model

### Problem
The worker ensemble is, in practice, single-tool. Across the entire 34-task run, only
`pi-worker-docs` was ever spawned (**107×**); `pi-worker-fetch` and the research
`pi-worker` were invoked **0×** — including for the very unknown in #2 that a fetch of
the tool's README would have resolved. The local model defaults to one worker and never
reaches for fetch, even when it has explicitly flagged an external-doc gap.

### Evidence (current source + run)
- Run: `grep pi-worker-* .pi-tasks/TASK_*-debug.log` → `pi-worker-docs` only; fetch/research = 0.
- `src/workers/pi-worker-fetch.ts:51-56` — the tool description frames fetch as *"Use
  after `pi-worker-search` (or with a known URL)"*. It is not framed as the tool to reach
  for when "I don't know how X integrates" — so the model never selects it for that intent.

### Why it generalizes
A worker that is never selected may as well not exist. Same pattern already validated and
fixed for search via a trigger-framed description (see memory `pi-worker-search-nudge`):
the local model selects tools by surface framing, not capability inventory.

### Proposed fix
1. Trigger-frame the `pi-worker-fetch` description toward the intent that should invoke
   it (e.g. *"When you need to know how a library/tool is configured or wired and the
   installed docs don't cover it, fetch its README/official docs"*), mirroring the
   search-nudge fix.
2. Orchestrator heuristic: when a KNOWN-UNKNOWN (see #2) references a URL/plugin/integration
   absent from installed-package docs, auto-run `pi-worker-fetch` rather than relying on the
   model to choose it.

### Acceptance / A/B
- A/B on live local model (validation method from `pi-worker-search-nudge`): old vs
  trigger-framed description; measure fetch-selection rate on an integration-unknown task.
  Expect the reframed description to lift fetch usage from ~0.

---

### Cross-cutting note
#1 feeds #2 (a wrong-version answer creates an integration unknown), and #2 feeds #3
(the unknown should trigger a fetch that never happens). They are one chain:
**the pipeline grounds work in the wrong version, flags the resulting gap, then has no
reachable worker to close it** — so the impl turn guesses. Fixing #2's routing and #3's
reachability together is higher leverage than either alone.
