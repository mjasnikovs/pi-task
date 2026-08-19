# Magic numbers that measure the machine, not the work

Inventory of hardcoded constants in pi-task that assume a particular
environment. A constant belongs here when changing the **model speed**, the
**repo size**, the **spec size**, or the **context window** can make it fire on
healthy work — a false kill, a false truncation, or a fabricated verdict.

Audited 2026-08-17 against `src/` at v0.38.11 (`dist/` and `*.test.ts` excluded).

Only six constants in the whole codebase are tunable at all: `requestTimeoutMs`
and `streamInactivityMs` via `/task-config`, plus four `PI_TASK_*` env vars in
`research-fanout-budget.ts`. Everything below is a bare literal with no knob.

---

## The measurement that started this

`/task-auto` on the mx5-n marketplace spec, local Qwen3.8-27B NVFP4, decompose
child replayed with the real captured prompt. One knob: `enable_thinking`.
Server samplers, tools, workspace and prompt byte-identical across arms.

| arm | answered | titles | seconds (median) | tool calls |
|---|---|---|---|---|
| thinking **off** | 1 / 10 | 0 in nine of ten | 233 (call-cap) | 200+ |
| thinking **on** | 8 / 8 | 26–40 | ~860 | 0 |

Thinking off: the child re-reads the same 3–8 files 190+ times and never emits a
plan. Thinking on: it always emits a correct plan, and **always takes 610–927
seconds against a 600-second cap**.

So the cap kills the arm that works. That is the defect class.

Two supporting facts, both verified live:

- The server streams `reasoning_content` deltas token by token. A **progress**
  signal exists; a clock is not needed to know a planner is alive.
- `src/workers/pi-worker-core.ts:325-405` already implements the right shape:
  `timeoutMs` means *time without progress*, reset by `onToolCall`,
  `onToolResult` **and `onLine`**, bounded by an absolute ceiling. Its own doc
  comment names this defect class — *"how slow is a property of the user's
  machine, not of the task."* **No other timeout in the codebase copied it.**

---

## TIER 1 — fires on healthy work AND loses work or fabricates a verdict

### 1. `repo-health-check.ts:201,294` — `timeoutMs = 600_000` → **silent false PASS**

Ten minutes for the project's entire lint/typecheck. On timeout `spawnSync`
returns `status: null`, which `classifyHealthRun:161` buckets with "tool not
installed" → `'skip'`. The loop continues and line 224 returns
`{ok: true, reason: '<ecosystem>: static checks passed'}`. `final-gate.ts:946`
feeds `stat.ok` straight into the final verdict.

**A command that never finished is reported as passed.** The file's own comment
measures 15s (mx5) and 69s (aiz-client); `tsc --noEmit` on a large strict
monorepo crossing ten minutes converts a real break into a clean gate.

Highest consequence in the list — the only entry that manufactures a *green*.

Related, same path: `final-gate.ts:946` calls the **synchronous**
`runRepoHealthCheck`, whose own docstring at `:196-199` says gate callers must
use `runRepoHealthCheckAsync` because it blocks the event loop 15–69s.

### 2. `child-runner.ts:61` — `PHASE_CHILD_TIMEOUT_MS = 600_000` → **kills the run**

> **FIXED 2026-08-17** (`fea7bbb`). The default is now `0` — off. The runaway it
> guarded is bounded by `task/stall-detector.ts` instead, on two dimensionless
> rules: consecutive tool RESULTS that are errors or bytes already delivered, and
> total tool output past a multiple of the child's own context window. Neither
> has to be re-tuned for a slower model or a bigger repo.
>
> Two more defects surfaced while measuring, both the same class — a guard keyed
> on a name instead of on what the child actually learned — and both fixed in the
> same commit:
>
> - `single-read-guard.ts` keyed on the file PATH, so a file bigger than one read
>   was a trap. The planner paged `marketplace.html` with `limit: 80` (of 743
>   lines) and its request for offset 80 was refused. **197 of 200 tool calls in
>   the failing runs were this guard's own refusal.** It caused the thrash it was
>   there to stop. Now keyed on the line range.
> - `loop-detector.ts` rule 2 compared read OFFSETS, so `{offset:80, limit:400}`
>   after `{offset:80, limit:300}` scored as a revisit despite covering 100 unseen
>   lines. Now compares the range.
>
> Measured, captured decompose request, reasoning off, n=10 per cell:
> 1/10 → 7/10 (stall detector) → 8/9 (all three). Controls with the same stimulus
> and no guard ever firing: Qwen3.6-27B 10/10, Gemma4-12B 10/10.
>
> Qwen3.8 with thinking off still fails sometimes. That is a model property.

The measured defect above. Three things beyond the cap itself:

- `phaseTimeout` (`child-runner.ts:84-109`) is a bare `setTimeout` with **no
  progress reset** — unlike its sibling at `pi-worker-core.ts:325`. The
  docstring at `:80` says *"pi-worker-core.ts has the same shape… not shared
  because that module imports FROM this one"*. The shapes have since diverged:
  one got the progress fix, one did not.
- Firing costs 3× the budget, then hard-fails. `child-runner.ts:487-497`:
  timeout → retry with `PHASE_TIMEOUT_HINT`, up to `MAX_LEAK_RETRIES` (2), then
  `throw new PhaseTimeoutError`. **Nothing catches `PhaseTimeoutError`** — grep
  finds only the definition and the throw. A healthy 700-second decompose burns
  30 minutes and takes `/task-auto` down with it.
- `runWithEmphasisRetry` (`child-runner.ts:682-703`) doubles it: 2 × 3 × 600s =
  60 minutes worst case.
- No override in production. `deps.timeoutMs` is set at exactly one site:
  `gate-child.ts:173`, to `0` (disabled — the correct shape).
- Provenance: measured, but on one machine — *"Sized against measured HEALTHY
  planning children on the same local 27B backend"* (`child-runner.ts:52`).

### 3. `requirements.ts:40` — `MAX_REQUIREMENTS = 40` → **silent obligation loss**

Enforced at `:121-142`. The fair-fill logic (documented with p=0.0020 /
p=0.0005 measurements) protects only the *unmarked* bucket; the
obligation-marked bucket gets a plain `marked.slice(0, MAX_REQUIREMENTS)` at
`:142`. A spec with 55 grounded obligation-marked quotes loses #41+ in
extraction order.

Silent: the recall-floor check (`uncoveredPassages`) runs **before** the cap
(`auto-orchestrator.ts:644-657`), so the cap's own drops are never re-validated.
The debug log records survivors only.

Cascade: `granularityFloor(ownable) = ceil(ownable / 2)`
(`decompose-granularity.ts:63`) reads the **capped** count — so the plan's
minimum task count can never exceed 20 however large the spec.

### 4. `serve-entry.ts:218-219` — `MAX_SCAN_FILES = 3000` / `MAX_FILE_BYTES = 400_000` → **false FAIL**

`scanCandidates:222-252` walks `readdirSync().sort()` (alphabetical DFS) and
hard-stops at 3000 files. `findMissingServeEntry:355` fires when an app
construct was found and no bind was found. If the app construct sorts before
file #3000 and the `Bun.serve(` / `.listen(` sorts after, the gate emits
*"NOTHING in the tree ever starts a listener… so the app cannot be started at
all"* — on a project that starts fine.

Same effect for any single server-entry file over 400KB (`:244`).

### 5. `enforce-attribution.ts:86` — `MAX_NAMED = 24` → **false KEEP of a regression**

`extractFailingFiles` silently stops recording distinct file names at 24
(`if (out.length < MAX_NAMED) out.push(cleaned)`). `attributeEnforceFailure`
(`:226-254`) then returns `verdict: 'keep', why: 'disjoint-from-enforce-diff'`
when no named file overlaps the enforce diff. If the overlapping file was name
#25 in a cascading multi-file typecheck FAIL, revert flips to keep and a genuine
regression is committed.

The comment is defensive only (*"a pathological reason cannot make this scan
unbounded"*) — nothing measures how many files a real large-repo FAIL names.

### 6. `phantom-imports.ts:138` — `MAX_TYPE_BYTES = 4_000_000` → **rewrites the spec wrongly**

`readRuntimeTypeText:140-169` concatenates a runtime's `.d.ts` files via a
`stack.pop()` DFS and returns early at 4MB. `classifyRuntimeImport:74` then does
`declared.has(spec)` against whatever survived — a real `declare module
"bun:sql"` past the cut yields `real: false`. That verdict feeds
`rewritePhantomSpecifiers:290-320`, which **actively edits the design/spec text
handed to the implementer** (`phases.ts:1918`, `auto-orchestrator.ts:602`),
rewriting a correct import into a wrong one.

The only Tier-1 entry with **zero recorded rationale** — bare literal, no doc
comment.

### 7. `final-gate.ts:933` — `bootGraceMs = 10_000` → **hard FAIL**

Ten seconds for a boot command to open a listening socket. Fired at
`boot-probe.ts:790-816`: when `canEnumerateListeners()` is true (the normal
Linux/CI case) and nothing bound, `onGrace` emits a real `outcome: 'fail'` —
*"still running after 10000ms but never opened a listening socket."*

A Next.js/webpack dev server doing a first compile on a large app routinely
exceeds this. Note the surrounding code is otherwise carefully fail-safe: every
*capability* gap degrades to the survival rule (`boot-probe.ts:417-425`). This
number is the exception.

### 8. `deep-render-check.ts:437-438` — `SETTLE_CAP_MS = 8_000` / `POST_SUBMIT_CAP_MS = 12_000` → **false FAIL**

`settle():589-600` returns on quiet **or** on cap, with no way to tell which.
The caller inspects the DOM as of that instant, and `judgeDeepSession:392-402`
turns `!leftAuthWall` into *"signed in but the client NEVER LEFT THE SIGN-IN
WALL."* A cold-start serverless auth backend, or any redirect chain over 12s,
produces that verdict on a working app.

Bare literals, no measurement comment.

### 9. `render-check.ts:156` — `VIRTUAL_TIME_BUDGET_MS = 8_000` → **false blank-page FAIL**

Chrome dumps the DOM at budget expiry and exits 0 regardless of mount state;
`judgeRenderedDom:128-152` judges whatever existed → *"the rendered body is
EMPTY after client JS executed"*, `outcome: 'fail'`.

The file's measurement comment (`:61-62`) covers **browser launch latency
only** — nothing measures page-JS mount time, which is what this number actually
bounds. A code-split SPA with a heavy hydration payload is the breaking case.

---

## TIER 2 — fires plausibly; silent loss or a weakened guard

| file:line | constant | breaks on | on firing |
|---|---|---|---|
| `workers/single-read-guard.ts:39-55` | 1 read per resolved path | Keyed on path, **offset deliberately ignored** (`single-read-extension.ts:23`). A 5000-line file read at `offset=0` then `offset=2000` — page two is blocked. **Measured: this is what loops the thinking-off decompose child.** | Model told *"write your final answer now"* → partial grounding, or a loop |
| `task/contracts.ts:36,148` | `MAX_CONTRACTS = 40` | `slice(-40)` — pure recency, no fair-fill. A design pinning 50+ endpoints/env vars | Silent. Dropped contracts cause the exact cross-slice seam bugs the module exists to prevent |
| `task/accept-debt.ts:36,269` | `MAX_DEBTS = 60` | `slice(-60)` on the ledger the final gate re-checks at run end. A 40-task plan with many accepted debts | Early debts stop being tracked → final gate reports clean on defects it recorded |
| `task/env-notes.ts:41,158`, `task/launch-contract.ts:32,154` | `MAX_NOTES = 40`, `MAX_SCRIPTS = 40` | Same recency slice. Long run's earliest env facts; a monorepo with 60+ scripts | Silent |
| `task/external-context.ts:37,247,253` | `RAW_BODY_LIMIT = 4000` | Any doc page over 4000 chars — i.e. most | `.slice(0,4000)` with **no ellipsis, no marker**. Contrast `clamp-output.ts` and `file-inventory.ts`, which both mark |
| `workers/docs-retrieve.ts:27,28,31,38,39` | `PACKAGE_RETRIEVE_LIMIT=8`, `PROJECT_RETRIEVE_LIMIT=50`, `RETRIEVE_CONTENT_BUDGET=24_000`, `FALLBACK_DTS_CHARS=12_000` | A package with 300 exported symbols. The fallback picks the **alphabetically first** `.d.ts`, not the entry point | `enforceBudget:102-117` just `break`s — no flag that chunks were dropped. Own comment admits *"no comment in the history explains WHY an npm package gets 8"* |
| `task/requirements.ts:331` | inline `if (out.length >= 20) break` | Obligation-passage recall checklist. A spec with 60 must/required paragraphs covers only the first 20 in doc order | Silently weakens the safety net Tier-1 #3 depends on. Unnamed inline literal |
| `task/verify-work.ts:1049,1077,1087` | retry budget of exactly 1 (`attempt === 1`) | A verify child that dies verdict-less twice — the code names *"budget/context death mid-investigation"*, which scales with repo/spec size | Hard FAIL *"no verdict emitted (after verify retry)"* on an unjudged artifact, burning a full impl re-run |
| `task/requirements.ts:42`, `contracts.ts:38` | `MAX_*_LENGTH = 300` | A dense compound obligation over 300 chars | **Discarded entirely, not truncated** (`continue` at `requirements.ts:65`). No trace |
| `workers/docs-project.ts:49` | `timeout: 5000` + default 1 MiB `maxBuffer` (unset) | `git ls-files` over a monorepo: ~25k TS paths exceeds 1 MiB → ENOBUFS; a cold/network FS exceeds 5s | Falls back to `walkTsFiles`, which honours a hardcoded `SKIP` set and **not `.gitignore`**. A different, larger file set is indexed with no signal |
| `task/child-runner.ts:36` | `MAX_LOOP_RESTARTS = 2` | Shared across loop kills, command kills, stream stalls, timeouts and connection errors (`pi-worker-core.ts:664-760`). One blip plus one command timeout leaves a single attempt | Worker gives up; `CARRY_FORWARD_LIMIT = 24_000` salvages part |
| `task/auto-orchestrator.ts:128,145` | `MAX_CLARIFY_QUESTIONS = 8`, `MAX_COVERAGE_ROUNDS = 2` | A spec with 15 genuine unknowns; a 40-task plan needing 3+ coverage rounds | Questions never asked / coverage gaps left. The coverage comment concedes adoption is monotone, so *"extra rounds can only hold or grow coverage"* — the cap is now a latency bound sitting on a correctness loop |
| `workers/fetch-core.ts:7-9`, `docs-core.ts:31-32` | `CONTENT_BUDGET=30_000`, `HEAD=25_000`, `TAIL=5_000` | A long changelog whose relevant section sits in the dropped middle | Marker inserted (partial signal), unrecoverable |
| `task/final-gate.ts:665` | `DEBT_RERUN_TIMEOUT_MS = 300_000` | A debt whose VERIFY command is a full e2e suite on a slow box | Classified `gap` → debt stays open forever. Fail-safe direction, but a genuinely-fixed defect never auto-closes |
| `task/enrichment.ts:24,31` | `ENRICH_CAP = 3`, `ENRICH_VERSION_CAP = 12` | A task naming 5 external services or 15 npm packages | Items past the cap get no version/docs data, silently |
| `task/file-inventory.ts:11` | `DEFAULT_MAX_LINES = 2000` | An 8000-file monorepo — alphabetically-late paths omitted | **Marked** (`(truncated: N more files)`) — the one honest cap in this group |
| `task/task-gates.ts:304`, `final-gate-fix.ts:67` | `MAX_AUTO_AUTOFIX = 3`, `MAX_FINAL_GATE_AUTOFIX = 3` | A weaker/slower model needing 5 rounds to converge | Normally hands to a human picker (safe). **Under `yoloMode` the run takes YOLO ACCEPT** and ships the defect as a debt. Defended by measurement (2709/2709 never reached the cap) — on the models measured |
| `workers/html-clean.ts:52` | `DEFAULT_MAX_BYTES = 2MB` | A large all-in-one API reference page | Hard reject with a clear error — signalled, but rejects healthy content |
| `workers/docs-chunk.ts:29` | `MAX_CHUNK_BYTES = 8 * 1024` | A single generated interface over 8KB | Sliced; only the **first** slice carries its `// relPath` label, so continuations retrieve as unlabeled fragments |
| `task/gate-deps.ts:511-512` | `MAX_PROBE_FILES = 4000`, `MAX_PROBE_FILE_BYTES = 512KB` | A >4000-file monorepo | Honest degrade — documented *"a sharpener, never a blocker"* |
| `workers/research-cache.ts:110` | `MAX_ENTRIES = 250` | A large multi-task run with heavy research | Eviction costs re-fetch time only, no correctness loss |
| `task/runner-resolve.ts:65` | `timeout: 8_000` on `bin --version` | A loaded box or cold NFS | Runner unresolved → statics skipped → feeds the Tier-1 #1 false-PASS path |

---

## Two interaction risks

- **`command-run.ts:164` `outputTail(limit = 400)` → `final-gate-progress.ts:145-159`.**
  `isNonProgress` string-compares two attempts' normalised failure detail, which
  is already clamped to the last ~400 chars. With verbose build output, two
  *different* real failures can share boilerplate in that tail, normalise equal,
  and demote a still-broken check to `UNOBSERVED debt` after two attempts. The
  authors are alert to this false-equality class (`BARE_PORT`/`SOURCE_LOCATION`
  collapsing at `:61-80`) — but only for ports and paths, not tail truncation.

- **`final-gate.ts:946` uses the synchronous `runRepoHealthCheck`** against its
  own docstring. Sits directly on the Tier-1 #1 path.

---

## Unsure, included anyway

- `auto-orchestrator.ts:168-169` — `SUSPECT_PLAN_MIN_SPEC_CHARS = 4000`,
  `SUSPECT_PLAN_MAX_TITLES = 2`. Spec-size-keyed, but only ever forces a
  regeneration; a model that insists twice still ships. Semantic more than
  environmental.
- `docs-resolve.ts:352` — `for (let hop = 0; hop < 3; hop++)`. A 4-deep `@types`
  re-export chain fails resolution silently. Dependency-shape dependent.
- `prompts.ts:11` `MAX_GRILL_QUESTIONS = 20`, `plan-session.ts:69`
  `MAX_PLAN_QUESTIONS = 8`. Arguably UX caps, but both scale with spec ambiguity.

## Excluded as environment-independent

Search-provider result counts and network fetch timeouts (`exa`/`ddg`/`brave`,
`npm-version.ts:15`); research-cache lock/rename/stale timers (fail-soft,
filesystem-bound); all TUI widths and refresh intervals (`widget.ts`,
`timings.ts`, `question-box.ts`, `config/register.ts`, `remote/ui-styles.ts`);
`ORIENTATION_*` (`orientation.ts:30-42` — purely additive prefill, skipped files
are cold-read as before, and it carries real measurement); `git-state-guard.ts:220
ITEMIZE_CAP` (display-only; the restore loop is uncapped); `clamp-output.ts`,
`repo-health-check.ts:58-59`, `gate-deps.ts:76` (diagnostic text on an
already-decided verdict); `gate-deps.ts:485 MAX_IGNORED_PROBE_PATHS` (returns
inconclusive, never downgrades); `boot-probe.ts` socket-tool timeouts
(documented degrade to the survival rule); `gate-child.ts:173 timeoutMs: 0`
(deliberately unbounded — the correct shape).
