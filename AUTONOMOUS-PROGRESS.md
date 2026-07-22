# Autonomous run — mx5 run-15 research reliability (started 2026-07-22, user asleep)

Durable state so a long unattended run survives context compaction. Update after EVERY
milestone. Source of truth for what is done, what is measured, and what is merely claimed.

## HARD RULES (from the user and nexxtasks.txt — do not relax these)

- A prompt is DONE only when its live A/B is **PASS on >= 8 reps per arm** with every
  invariant green. **An ABSTAIN is not a pass.** A FAIL is not a pass.
- Never fake or overclaim completion. If a lever does not work, say so with the numbers.
- Metrics are MECHANICAL and recorded at the TOOL LAYER, never the model's self-report.
- Verdicts go through `scripts/ab-verdict.ts` (PASS=0 FAIL=1 ABSTAIN=2).
- `bun run lint` and `bun run test` must stay green. Both cover `scripts/`.
- Model: llama-server @ 127.0.0.1:8080, Qwen3.6-27B-NVFP4-MTP.gguf, started by
  `~/hub/qwen/run-Q3.6-27B.sh`. **PARALLEL=1 — only ONE live run at a time.**
  Subagents must NEVER run live model work; they would contend and corrupt timings.
- `PI_BIN=$(command -v pi)` is mandatory for any harness (unset = fork bomb).
- Probes import from `dist/`, so run `bun run build` after any `src/` change.

## STEP 0 — COMPLETE (all five items)

| item | deliverable | result |
|---|---|---|
| 1 | `live-worker-validity-baseline.ts` | **PASS** 1680 lookups, 0 err, 3.83h |
| 2 | `live-typeonly-answer-probe.ts` | F-2 **CONFIRMED** 0/8 escalation, 182 docs calls |
| 3 | `live-context-attribution-probe.ts` | **PASS** F-1 2/8 reps, 104 bullets |
| 4 | `scripts/fixtures/run15-*.json` | 210 corpus + 10 failing + 20 regression |
| 5 | logging gap | **RESOLVED, no src/ change** (199 spec / 49 impl / 0 unattributed) |

### Recorded baselines (the numbers PROMPT 1-3 must beat)

- **docs validity**: valid 61.1% (static 58.6%), per-rep 59.0-62.4, spread 3.3pp.
  unclear 382, halluc-warn 318, caveat 496, 1680 scored.
  `strict`/`caveat` are **NOT comparable** to the static table — manifest drift.
- **F-1 unsourced attribution**: **2/8 reps (25%)**, 2 hits in 104 bullets.
- **F-2 type-only termination**: across TWO real-flow runs, **14 of 17 valid reps (82%)
  terminated without escalating** (run A 6/6 hits after excluding 2 zero-docs reps; run B
  7/9). It is NOT absolute: **3 reps DID escalate**, and in the standout case (run B trial
  8) the worker fetched EXACTLY `hono.dev/docs/guides/rpc` — the spec-cited page that would
  have prevented the fatal bug. So the correct behaviour occurs spontaneously ~18% of the
  time; PROMPT 2's job is to make it reliable, not to invent it. Both probe runs PASS.
  NOTE the earlier "0/8" was the FIRST run only and was optimistic — corrected here.
- **zero-tool APIS worker** (side finding): in 3 of ~18 reps `worker:apis` emitted only 4
  log lines and made ZERO docs/search/fetch calls — it produced its APIS section from
  memory outright. Distinct from F-2 and arguably worse. Not yet a tracked task.
- **per-question churn**: `unclear` is near-deterministic (8/210 churn); `excerptVerified`
  flips on **90/210 (43%)**. Never use halluc-warn as a per-question fixture signal.
  ~48 deterministic fixture candidates survive 8 reps.

## CRITICAL: PROMPT 1's A/B AS WRITTEN IS UNDERPOWERED

Baseline p = 0.25. Its spec'd PASS ("baseline >=1 hit, treatment 0, 8 reps") is met by a
do-nothing lever with probability 0.75^8 = **10%**. Reps per arm needed:
5% -> 11, **1% -> 17**. At ~4.3 min/rep that is ~73 min/arm. **Use >= 16 reps/arm.**
Wilson CI on 2/8 is wide (3%-65%); re-estimate p from the baseline arm as it runs.

## ORDER (from nexxtasks.txt — no partial starts)

STEP 0 -> **PROMPT 1** (only one that caused total product failure; smallest change)
-> PROMPT 2 (shared root cause, costs wall-clock, needs timing invariant)
-> PROMPT 3 (highest failure count, lowest proven blast radius).

## PROMPT 1 — implemented, A/B queued (2026-07-22)

Deterministic work DONE (subagent + my verification):
- detector promoted to `src/task/context-attribution.ts` (+ test, 22 pass)
- LIVE-DATA RULE extended with API USAGE SEMANTICS + ONE CLAIM PER BULLET (prompts.ts)
- post-check wired into phaseResearch: `demoteUnsourcedAttributions` runs as `postProcess`
  BEFORE persistSection (so cache/resume are gated too). Demotes, not deletes.
- DO item 4 decided: worker:context stays ISOLATED (read,grep), forbidden from external-API
  claims by prompt + post-check.
- build 0, lint 0, test 2110 pass.

I VERIFIED the shipped gate on the verbatim fatal bullet (dist/, real blocks):
- npm-only block  → FLAGGED + demoted  (the run-15 condition)
- npm+service     → FLAGGED  (service snippet can't source semantics — subagent's fix holds)
- npm+docs        → NOT flagged, passes clean  (a real fetched doc legitimises it)
The demotion rewrites to "OPEN QUESTION (unsourced API-semantics claim about hono …)".

TWO CAVEATS carried into the A/B (both verified by me, both in the safe direction):
1. The probe scores against EMPTY external context — `research.indexOf('FILES')===0` so the
   slice is always ''. Verified against a recorded rep. Detector then runs as a strict
   SUPERSET (flags MORE than the shipped gate), biasing treatment toward FAIL not false-pass.
   Baseline 2/8 was scored the same way, so comparability holds. A/B does NOT validate the
   block taxonomy — that needs the in-phase path, already unit-verified above.
2. A/B harness `scripts/live-context-attribution-ab.ts` derives BOTH arms from ONE run:
   ungated = surviving-in-shipped + demotion-log lines; gated = surviving-in-shipped.
   16 reps (0.75^16=1% false-pass vs the spec'd 8=10%).

NEXT (must be serial — one GPU slot): run live-context-attribution-ab.ts at 16 reps AFTER
the F-2 baseline finishes. PASS = ungated shows the shape AND gated drives it to 0, with
CONTEXT not collapsing.

## PROMPT 2 — detector built + being hardened (2026-07-22)

- `src/task/type-only-answer.ts` — pure `isTypeOnlyAnswer(answer, question)`. I INDEPENDENTLY
  calibrated it over all 150 valid docs answers in research-cache.json: flags EXACTLY 1
  (the fatal hc case), 149 cleared. Zero false positives on the corpus.
- Stress test on UNSEEN shapes found 1 false NEGATIVE: behavioural-verb list matches verbs
  that appear as METHOD NAMES in a signature (`use(...handlers)` matches /use/). That is the
  F-3(a) router-fixture shape. Sent back to subagent af9171b to fix deterministically, with a
  hard no-precision-regression requirement (must still flag exactly 1/150). NOT yet verified.
- PROMPT2-NOTES.md maps all 4 DO items to file:line.
- WIRING DONE by me (2026-07-22), src only — dist deliberately NOT rebuilt while the PROMPT 1
  A/B is live, because pi children load extensions from dist/ at spawn time and a rebuild
  mid-run would swap the code under test. VERIFIED dist still has no PROMPT 2 code.
  - DO 1: `isTypeOnlyAnswer` wired at pi-worker-docs.ts after parseChildOutput. A type-only
    answer KEEPS the retrieved type but gets an "UNANSWERED — TYPE-ONLY" banner telling the
    model not to answer from memory and not to treat the type as the answer.
  - DO 2: `extractSeeUrls(concatenated)` — the banner names the `@see {@link …}` URL the
    excerpt already carries (free; F-2d found hono.dev only ever inside these links). The
    tool PROMPTS the fetch rather than performing it (parallel execution mode).
  - DO 4: `cacheable` tightened from `childExitCode === 0` to also exclude typeOnly,
    excerptVerified===false, and "unclear from this package". Stops one dead end being paid
    for many times (52 run-15 entries were cached "unclear" with hitCache true).
  - DO 3 (spec-cited URLs ranked as fetch targets): NOT implemented. Bigger change, touches
    RESEARCH_APIS_PROMPT. Deferred — DO 1/2/4 target the measured defect directly.
  - Tests: src/workers/pi-worker-docs-typeonly.test.ts (11 pass). Full suite 2139 pass.
  - NOT YET LIVE-VALIDATED. PROMPT 2 is NOT done until its A/B passes.
- WATCH: PROMPT 2 wiring touches pi-worker-docs.ts:362 (`cacheable`) and phases.ts. Its A/B
  needs the real-flow probe (live-typeonly-answer-probe.ts) as baseline = 14/17 terminate,
  and must show treatment escalates instead, WITHOUT excerptVerified===false rising (inv 2)
  and without a wall-clock blowup (inv 1). Also needs >=8 reps that consult docs.

## *** STATISTICAL POWER — THE KEY CONSTRAINT ON PROMPT 1 ***

Computed with Fisher's exact, one-tailed (verified against a hand calculation):

    baseline 2/8  vs treatment 0/16  ->  p = 0.101   NOT SIGNIFICANT
    baseline 2/8  vs treatment 0/32  ->  p = 0.036
    baseline 6/24 vs treatment 0/24  ->  p = 0.011
    baseline 8/32 vs treatment 0/32  ->  p = 0.002

So **even a PERFECT 0/16 treatment cannot prove PROMPT 1 works against a 2-hit baseline.**
The baseline's hit COUNT is what the test is starved of, so enlarging the BASELINE buys far
more power than extending the treatment. This is the same 10% as nexxtasks' own too-weak
PASS criterion.

ACTION TAKEN: `scripts/live-context-attribution-baseline-extra.ts` runs 16 MORE reps of the
genuinely PRE-CHANGE code — a git worktree pinned at HEAD (84b85b7), verified to contain
neither belt nor braces, built to its own dist/, with a runtime assertion refusing to run if
that dist ever contains the post-check. Scored by the SAME detector as the treatment arm, so
only the code under test differs. Queued behind the A/B (one GPU slot).

Expected combined baseline ~6/24 -> p ~0.011 against a 0/24 treatment.

## PROMPT 1 — RESULT SO FAR: PROMISING BUT **NOT YET PROVEN** (2026-07-22)

Measured, all live, all mechanical:

| arm | code | result |
|---|---|---|
| baseline recorded | pre-change | 2/8 |
| baseline extra    | pre-change (pinned worktree, asserted) | 2/16 |
| **baseline combined** | pre-change | **4/24 = 16.7%** |
| treatment | belt + braces, as shipped | **0/16** |

**Fisher one-tailed: p = 0.116 — NOT SIGNIFICANT.** The A/B harness ABSTAINED (correctly):
its ungated arm was also 0/16, i.e. the BELT (prompt rule) suppressed the shape before the
BRACES (post-check) ever fired — 0 demotions in 16 reps. So this run proves nothing about
the post-check, and the end-to-end claim is not yet at p<0.05.

NOT a silenced worker: 13.1 bullets/rep vs the pre-change mean of 13.0. The belt removed
the laundering shape, not the output. Invariant held.

The 2 new baseline hits are real F-1 shapes, and rep 15 is instructive — it fabricates the
OPPOSITE fact from run 15 under the same fake attribution:
  "The LIVE Hono RPC docs confirm that `hc<AppType>(baseUrl)` requires a full URL … but a
   relative path like `/ap…"
So the mechanism is FABRICATION, not a consistent memory error. Good news for the lever.

IN FLIGHT: 24 more treatment reps (pid 508102) to reach 0/40 -> p = 0.017 if still clean.
  treatment 0/24 -> p=0.055 | 0/32 -> p=0.029 | 0/40 -> p=0.017 | 0/48 -> p=0.010
If ANY hit appears in the extension, recompute honestly — do not drop it.

## LOG

- 2026-07-22 — STEP 0 complete. Baselines recorded above.
- 2026-07-22 — PROMPT 1 implemented + gate verified on fatal bullet. A/B queued behind F-2.
- 2026-07-22 — F-2 corrected to 14/17 (was optimistic 8/8). Both probe runs PASS.
- 2026-07-22 — PROMPT 1 A/B STARTED (16 reps). PROMPT 2 detector built, hardening in flight.
- 2026-07-22 — rep 1/16 of PROMPT 1 A/B: 13 bullets, 0 demoted, 0 surviving (no shape, expected).
