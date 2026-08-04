# nexttask 5 — 30 invisible research-worker timeouts: 120 min burned, 76 min on the critical path

**Priority P1.** The largest measured time sink in mx5 run 18, and none of it
appears in any log or timing widget.

---

## EVIDENCE (mx5 run 18 — all figures computed from `~/hub/mx5/.pi-tasks/TASK_00*-debug.log`)

Run wall clock: `06:59:19.015Z → 15:03:16.155Z` = **484.0 min**.

Each research worker logs one line on completion:

    2026-07-30T14:31:23.164Z worker:apis: done exit=143 wait=779ms work=239278ms

Comparing that against the wall clock between its own `start` and `done` lines,
summed over all 96 worker runs in the 24 task logs:

    reported wait+work total : 164.5 min
    actual wall-clock total  : 284.5 min
    UNREPORTED               : 120.0 min   (42% of all worker wall time)

23 of 96 worker runs show wall > 1.5× reported. **Every single discrepancy is an
exact multiple of 240 000 ms** — e.g. `TASK_0011 context` 279s wall / 39s
reported (diff 240s), `TASK_0017 apis` 648s / 168s (diff 480s), `TASK_0022 apis`
645s / 165s (diff 480s). That is `RESEARCH_WORKER_TIMEOUT_MS = 240_000`
(`src/workers/pi-worker-core.ts:70`). Total: **30 timeouts, 120 min of compute
discarded**; **19 of them on the critical (slowest) worker = 76 min = 15.7% of
the entire run**.

**21 of the 23 restarted workers reported `exit=0`.** The run treated them as
clean successes. The 2 that did not are TASK_0024's `apis` and `context`, which
burned all 3 attempts and degraded:

    2026-07-30T14:31:23.170Z worker:apis: degraded — timed out after restarts
    2026-07-30T14:31:23.188Z worker:context: degraded — timed out after restarts

`.pi-tasks/TASK_0024.md` consequently shipped:

    APIS
    (degraded: research APIS worker timed out after restarts; this section may be incomplete)
    CONTEXT
    (degraded: research CONTEXT worker timed out after restarts; this section may be incomplete)

The final polish task's spec was authored on degraded research.

The user-facing widget in the same file compounds it:

    research            730.1s
      worker:apis work      239.3s
      worker:context work   239.4s
      workers               722.2s

722s of "workers" whose longest member reads 239s. The 3× gap is printed and
unexplained.

## SEAM A — the metric (certain, free, no behaviour change)

`src/workers/pi-worker-core.ts:429-432`

    for (;;) {
        …
        const tStart = Date.now()
        let tFirstByte: number | null = null

`tStart` is **inside** the retry loop, so `waitMs`/`workMs` at lines 516-517
describe only the final attempt. The doc comment at line 266 already says so
("not summed across restarts"). There is also **no logging hook anywhere in
`pi-worker-core.ts`** — `grep -n "onRestart\|debugLog\|onDebug" src/workers/pi-worker-core.ts`
returns nothing — so the 5 restart branches (loop at :526, command-kill at :535,
stream-stall at :551, timeout at :559, connection at :588, leak at :600) are
structurally invisible.

Fix: keep a `tAttemptStart` per attempt for the existing fields, add
`attempts`, `totalWallMs`, and a per-attempt outcome list to the result, and emit
one debug line per restart via a new optional `onRestart` callback that
`src/task/phases.ts:1092` logs alongside the existing `done` line.

## SEAM B — the cause (measured, r = 0.909)

`worker:apis` fans out `pi-worker-docs(module: ".")` project-source lookups.
Counting them per task against that worker's wall clock:

    task       proj_lookups  apis_wall_s  240s-timeouts
    TASK_0001             0           79        0
    TASK_0003             0           57        0
    TASK_0004             3           94        0
    TASK_0008            11          188        0
    TASK_0007            15          380        1
    TASK_0010            25          365        1
    TASK_0009            26          392        1
    TASK_0024            36          720        2  (degraded)
    TASK_0022            46          645        2
    TASK_0019            53          666        2
    TASK_0020            53          663        2
    TASK_0017            58          648        2
    TASK_0021            60          660        2

    Pearson r(project-lookups, apis wall-clock) = 0.909   n = 24

0–4 lookups ⇒ 0 timeouts, every time. ≥46 lookups ⇒ the **full** 2-restart
budget burned, every time (`MAX_LOOP_RESTARTS = 2`,
`src/task/child-runner.ts:36`). Totals: 615 `pi-worker-docs` calls, of which
**464 (75.4%) are project-source `"."` lookups**.

## RULED OUT — do not re-propose (refuted in this investigation, 2026-07-30)

**"Cache `.` lookups within a worker's restart chain."** The idea is that a
restarted worker re-asks the same questions, so the tree cannot have changed and
memoising is safe and free. **Measured false.** Duplicate `"."` queries inside
the restart-heavy tasks:

    TASK_0017  58 total / 56 distinct / 2 dup
    TASK_0019  53 / 53 / 0
    TASK_0020  53 / 49 / 4
    TASK_0021  60 / 57 / 3
    TASK_0022  46 / 34 / 12
    TASK_0024  36 / 36 / 0

Mean ≈ 3.5% duplication. The restart hint changes the worker's questions, so a
query-text cache recovers nothing. This independently reproduces the finding
already recorded in the header of `scripts/live-project-docs-retrieval-ab.ts`
(1 exact repeat in 141 calls on run 13, 0.7%).

Keyed on **file set** instead of query text, run 18 collapses 344 path-naming
calls into 198 distinct `(task, file-set)` keys — **42%** (run 13 measured 74%).
That is the live hypothesis, and it is **already an open question with a harness
written for it**: `scripts/live-project-docs-retrieval-ab.ts` poses H-cache vs
H-retrieval and has no recorded verdict. **Do not build a per-file cache before
that harness reports.** Its whole point is that if retrieval is the fault, a
cache memoises 22 bad answers.

## LEVER — three parts, in this order, each independently landable

**5A (unconditional, no A/B needed — it is instrumentation, not behaviour).**
Fix the timing and log restarts, as in SEAM A. Land this **first**: every
measurement below depends on it, and today the numbers have to be reconstructed
from timestamp arithmetic.

**5B (the safe time lever, A/B required).** Bound the fan-out. The 240s ceiling
and a 46+-call fan-out are jointly unsatisfiable, so the worker is *guaranteed*
to time out on codebase-heavy tasks and then repeat the whole attempt twice more.
Options, to be decided by the A/B not by argument:
 - cap `"."` lookups per worker attempt and tell the worker its budget;
 - scale `timeoutMs` with the observed fan-out;
 - both.

**5C (gated).** Per-file digest cache keyed on `(path, mtime)` — **only** after
`scripts/live-project-docs-retrieval-ab.ts` settles H-cache vs H-retrieval.

## STEP 0 — base rate, BEFORE 5B

With 5A landed, re-run one full mx5-shaped task set (or replay from the recorded
logs) and report, per worker: attempts, per-attempt outcome, `"."` lookup count,
total wall. **This makes 30/96 the measured baseline instead of an inference.**
Confirm the 30 count and the 19 critical-path count against live instrumentation
before spending model time on 5B.

## A/B for 5B — required, model in the loop

`scripts/live-research-fanout-budget-ab.ts`.

    baseline   worker:apis exactly as shipped (no cap, 240s, 2 restarts)
    treatment  the chosen bound

Fixture: the mx5 run-18 refined prompts + orientation for the five tasks that
burned the full budget — TASK_0017, 0019, 0020, 0021, 0022 — replayed against
`~/hub/mx5 @ evidence/run18-task24` (see nexttask 4 for the tags). These are the
tasks the lever exists for; using low-fan-out tasks would ABSTAIN by
construction.

Pre-registered metrics, all mechanical:
 1. **timeouts per worker** (the target shape: ≥1 timeout);
 2. **worker wall-clock**;
 3. **QUALITY GUARD — the APIS section must not get worse.** Score with the
    existing deterministic instruments: `src/task/apis-contract.ts` signature
    coverage and `src/task/api-synthesis.ts` anti-synthesis. A faster worker that
    ships a thinner APIS section is a regression, not a win.

    PASS     baseline ≥1 timeout per fixture; treatment 0 timeouts;
             AND wall-clock strictly lower; AND quality invariants hold.  exit 0
    FAIL     timeouts remain, or quality regressed.                       exit 1
    ABSTAIN  baseline produced 0 timeouts — the fixture does not exercise
             the lever. Extend the fixture; do NOT wire.                  exit 2

Invariants:
- `inv-quality-not-worse` — APIS signature coverage ≥ baseline on every fixture,
  and fabricated-semantics count not higher. This is the load-bearing one: the
  lesson of `memory/apis-contract-stage2-failed.md` is that a lever can move
  behaviour 20/20 while fabricating 15% of it.
- `inv-no-new-degrade` — treatment produces no `degraded — timed out after
  restarts` on any fixture.
- `inv-low-fanout-untouched` — TASK_0001/0003/0004 (0–3 lookups) show no change
  in wall clock or APIS content.

Use `reportAb` / `reportArm` from `scripts/ab-verdict.ts`; ABSTAIN exits 2.

## SEPARATE, CHEAP, INDEPENDENT FINDINGS — record, do not bundle

- **The research cache did essentially nothing this run.** 151 package-scoped
  docs lookups, **149 distinct** ⇒ ≤2 possible hits (1.3%); 130 entries written.
  Consistent with `memory/research-cache-value-is-stack-dependent.md` (worth most
  on non-npm stacks; mx5 is npm). Not a bug. Worth one line in
  `VALIDATION-DEBT.md` so nobody re-measures it a fourth time.
- **`pi-worker-search` fired 3 times in 8 hours** vs 615 docs calls
  (`pi-worker-fetch`: 6), against a *carried* design requirement — "Whenever an
  API, signature, config, or best practice is unknown or unclear, use web search
  … before writing code". `memory/pi-worker-search-nudge.md` records that a
  trigger-framed tool description previously fixed exactly this skip. Worth its
  own base-rate measurement; **do not fold it into 5B.**

## ENVIRONMENT

5A is deterministic (unit tests only). 5B needs llama-server at
`127.0.0.1:8080`, `run-Q3.6-27B.sh`, never `-b 512 -ub 256`. One harness at a
time; they share the one server. Never run `bun test` while a harness runs —
`src/task/real-pi.smoke.test.ts` spawns real pi.

    bun test src/workers/pi-worker-core.test.ts            # 5A
    PI_BIN=$(command -v pi) bun run scripts/live-research-fanout-budget-ab.ts <arm> [TRIALS]
