# Resume prompt — nexttask 5, round 3 (read the n=6 verdict)

Paste the block below into a fresh session. Everything it needs is on disk;
nothing depends on the previous session, and no process in it belongs to a
terminal that may have been closed.

---

Read `VALIDATION-DEBT.md` section `## OPEN — 3. worker:apis project-source
fan-out (nexttask 5B)`, including the last subsection `### ROUND 2 INSTRUMENT
WORK — three more false readings, all closed`. Then do the work items below.

## STATE ON DISK — all of it, no ambiguity

- `main` = `e4d4c9f` (`fix(ab-instrument): control invariant with no controls,
  retrieval-gap grounding, censored wall clock`). **`main` is 1 commit AHEAD of
  `origin/main` — e4d4c9f is NOT pushed.** Working tree clean apart from
  untracked `nexttask1-7.md` and this file (notes, not deliverables).
- `bun run lint` clean; `bun test` 2643 pass / 1 skip / 0 fail — as of e4d4c9f,
  BEFORE the run below finished. **Do not run `bun test` while an arm is live**
  (see rules).
- `dist/` is built from this tree and the running arms load it. Do not rebuild.
- npm `latest` is still 0.28.0 (= `c534059`). Nothing from round 2 is published,
  and nothing should be until there is a verdict.

**Shipped so far:** 5A restart visibility only. **Both fan-out levers remain
env-gated OFF** in `src/task/research-fanout-budget.ts`:

    PI_TASK_PROJECT_DOCS_BUDGET             cap the fan-out          (wrong lever)
    PI_TASK_FANOUT_TIMEOUT_PER_LOOKUP_MS    scale the ceiling        (wrong lever)
    PI_TASK_WORKER_CARRY_FORWARD            carry findings forward   (HARMFUL)
    PI_TASK_WORKER_PROGRESS_CEILING_MS      progress deadline        (only candidate)

## WHAT ROUND 2 DID (items 1-3, all in e4d4c9f, all deterministic)

1. **`inv-low-fanout-untouched` no longer reports HOLDS on zero data.**
   `scoreLowFanout` emits an `unmeasured` line for any control fixture with no
   trials in either arm, routed through `AbSpec.unmeasured`. `Invariant` gained
   an `unmeasured` flag and `ab-verdict.ts` renders it `NO DATA`, not `HOLDS`.
2. **The grounding corpus gained a fifth channel, `projectTree`** — the fixture's
   own hand-authored source at its checkpoint commit, via
   `checkpointSourceText()` in `scripts/run15-fixture-tree.ts`. This closes the
   RETRIEVAL-GAP class: a real project symbol known from orientation but never
   re-read no longer scores as a fabrication.
   **The anti-gaming property is pinned by a test and must stay pinned.** mx5
   commits vendored minified UI bundles under `.playwright-cache/assets/*.js`
   that contain `Textarea` at EVERY checkpoint; an "all tracked files" channel
   would have grounded the only fabrication ever observed and killed the guard.
   `isProjectSourcePath` denies build/cache/vendor dirs, lockfiles, `.map` and
   `.min.*`. Verified in both directions: `Textarea` has 0 hits at TASK_0019's
   tree (`e6440894…`) and 6 at TASK_0020's (`154f02f3…`).
3. **The wall clock is now reported as CENSORED, descriptive only.**
   `inv-wall-clock-lower` is gone. `scoreTimeToAnswer` compares time to a USABLE
   answer and only over fixtures where **every** trial of **both** arms produced
   one; otherwise it reports NO DATA and abstains. My first version of this was
   itself censored (it compared means over answering trials and reported
   `390s → 637s BROKEN`); baseline had answered in only 4/12 trials, exactly the
   ones that finished inside two attempts. Do not re-introduce that shape.

**The instrument got more honest, not friendlier.** Re-scoring the v2 corpus
through it left the verdict unchanged — still `FAIL`, still on
`inv-quality-not-worse`:

    fixture     arm        recorded  trace-only  +projectTree  symbols
    TASK_0017   baseline        1.0         1.0           1.0     22.7
    TASK_0017   progress        0.0         0.0           0.0     44.3
    TASK_0019   baseline        0.0         0.3           0.3     27.7
    TASK_0019   progress        0.3         0.3           0.0     39.3
    TASK_0020   baseline        0.0         0.0           0.0      9.3
    TASK_0020   progress        2.0         2.7           0.7     45.0
    TASK_0021   baseline        0.0         0.0           0.0      0.0
    TASK_0021   progress        0.3         0.0           0.0     58.3

    inv-quality-not-worse    BROKEN   TASK_0020 ungrounded 0.0%→1.5% (0.0→0.7)
    inv-no-new-degrade       HOLDS    0 degraded trials in progress
    inv-low-fanout-untouched NO DATA  no control fixture was run
    inv-time-to-answer-lower NO DATA  baseline answered in only 4/12 trials
    descriptive (CENSORED)   baseline 610s, 12/12 truncated, answered 4/12
                             progress 608s,  0/12 truncated, answered 12/12

**Deliberately NOT done: a `node_modules` grounding channel.** The residue after
`projectTree` is `setInputFiles` / `$patch` — symbols that live in a dependency.
Admitting `node_modules` would ground nearly any identifier (the same failure
mode as admitting `.playwright-cache`), there is no observed fabrication living
in a dependency to test the filter against, and widening the corpus after seeing
which fixture it rescues is tuning to the verdict. Recorded as **PACKAGE-GAP** in
`VALIDATION-DEBT.md` and left open on purpose.

## ITEM 4 IS RUNNING RIGHT NOW — DETACHED

A chain script owns both arms and the scoring. It runs in its own session
(`setsid`), so it survives the terminal that started it.

    script   /tmp/claude-1000/-home-edgars--pi-agent-extensions-pi-task/
             4c3a0485-5c94-4b55-b2c9-65630eef5f00/scratchpad/overnight.sh
    corpus   ~/tmp/research-fanout-ab-v3          <- the durable artifact
    logs     <same scratchpad>/overnight.log      <- chain state, one line per arm
             <same scratchpad>/v3-baseline.log
             <same scratchpad>/v3-progress.log
             <same scratchpad>/v3-score.log       <- the verdict, written last

Started 2026-08-03 20:56. Fixtures: `TASK_0017 0019 0020 0021` plus controls
`TASK_0001 0003 0004`, **n=6**, so **42 trials per arm**. Estimated ~5h per arm
from the v2 measurement (mean `phaseWallMs` 665s baseline / 627s progress);
expect the verdict some time after 07:00 on 2026-08-04.

**The logs are in `/tmp` and may be swept. The corpus is not — the trial JSONs
under `~/tmp/research-fanout-ab-v3/results/{baseline,progress}/` are the record,
and `score` can always be re-run over them.**

### Check it, in this order

    ls ~/tmp/research-fanout-ab-v3/results/baseline/*.json | wc -l   # want 42
    ls ~/tmp/research-fanout-ab-v3/results/progress/*.json | wc -l   # want 42
    ls ~/tmp/research-fanout-ab-v3/results/*/errored/                # want empty
    cat <scratchpad>/overnight.log
    cat <scratchpad>/v3-score.log
    pgrep -af 'overnight.sh|budget-ab.ts'                            # empty = finished

If `v3-score.log` is missing or the counts are short, re-score or resume by hand
— recorded trials are skipped, so the same command resumes in place:

    AB_DIR=~/tmp/research-fanout-ab-v3 PI_BIN=$(command -v pi) \
      bun run scripts/live-research-fanout-budget-ab.ts progress 6 \
      TASK_0017 TASK_0019 TASK_0020 TASK_0021 TASK_0001 TASK_0003 TASK_0004
    AB_DIR=~/tmp/research-fanout-ab-v3 \
      bun run scripts/live-research-fanout-budget-ab.ts score progress

Exit code is the verdict: **0 PASS / 1 FAIL / 2 ABSTAIN**. ABSTAIN is non-zero on
purpose — a run that proved nothing must never look like a pass.

### What already went wrong in this run, so you recognise it

Three trials sit under `results/baseline/errored/` and are correctly excluded
from scoring:

- one llama-server CUDA OOM in the flash-attention path (`alloc at
  ggml-cuda.cu:594`), container `Exited (0)` mid-arm;
- two `503 {"message":"Loading model"}` — `/health` answered `{"status":"ok"}`
  about 20s after `docker start` while the model was still loading, and the arms
  were relaunched on that. **`/health` is not a readiness signal here. Only a
  real completion is**, which is what the chain now polls for.

The running container is `-c 240000 --parallel 2` = 120k context per slot, TWO
slots — not the `run-Q3.6-27B.sh` defaults (`CONTEXT=140000 PARALLEL=4`;
`CONTEXT` is total and is divided across slots). The harness sets
`cfg.parallelResearchWorkers = true` and fires FOUR concurrent research workers,
so four requests contend for two slots. **That contention is run 18's
configuration and part of the fault under test — do not tune `PARALLEL` or
`CONTEXT` to make the run smoother.** `docker start llama-turboquant` restarts
the existing container unchanged and is safe; the run script does `docker rm -f`
+ `docker create` and is not.

## THE WORK, ONCE THE VERDICT IS IN

1. **Record it in `VALIDATION-DEBT.md`** under the same OPEN section, with the
   per-fixture table, and say plainly which invariants had data and which did
   not. If `inv-low-fanout-untouched` still reads NO DATA, the controls did not
   run and item 1's whole point is unfinished.
2. **Then, and only then, decide about `PI_TASK_WORKER_PROGRESS_CEILING_MS`.**
3. Push `e4d4c9f` (and whatever round 3 adds) once there is something to say.

## OPEN, AND NOT FIXABLE BY INSTRUMENT WORK

`PI_TASK_WORKER_PROGRESS_CEILING_MS` was run at **1,200,000ms** and the maximum
wall ever observed is 980s. It is an arbitrary constant that has never fired, and
"above everything we have seen" is not a derivation. **A PASS on this A/B does
not make it shippable.** Before the lever ships, that number needs a derivation —
or the deadline needs to be expressed in progress terms with no wall-clock
constant in it at all, which is the whole argument in
`memory/fix-must-preserve-work-not-bound-it.md`.

## RULES THAT MUST NOT BE BROKEN

- **`AB_DIR` on every command.** The default (`~/tmp/research-fanout-ab`) holds
  trials recorded before prompt-capture existed, and v2 was scored under the OLD
  instrument. Mixing corpora invalidates the comparison. v3 is the live corpus.
- **Do NOT rebuild `dist/` while an arm is running** — pi children load the docs
  extension from it at spawn time.
- **Do NOT run `bun test` while a harness is running.**
  `src/task/real-pi.smoke.test.ts` spawns real pi and they share the one GPU.
- **Never run the two arms concurrently.** They contend for the same two
  llama-server slots, and wall clock is one of the things being measured.
- **NEVER `git stash` in this checkout.** Concurrent agent sessions share it; a
  stash has already eaten another session's live work.
- **Never re-tune an invariant to make an arm pass.** Every instrument change so
  far was justified by inspecting the flagged symbols and finding them real, and
  BOTH rounds of fixes deliberately did not move the verdict. A threshold moved
  after seeing the number it would change is not a verdict.
- **Carry-forward must NOT ship**, on any argument. It never fired in the
  `rescue` arm (`attempts=1` x8), so that arm's clean result credited a mechanism
  that never ran. Isolated, it prepends up to 24,000 chars to a prompt that must
  still fit the SAME 240s cap: TASK_0020 hit `exit=143` on all three attempts
  where baseline's third completed, and it produced the only observed fabrication
  (`Textarea` on TASK_0019). **Only the PROGRESS DEADLINE is a ship candidate.**
- **A one-arm run cannot render a verdict.** Run both, then `score`.

## WHAT A PASS WOULD AND WOULD NOT MEAN

Metric 1 (timeouts) is unambiguous at any n and is already reproduced twice —
12/12 → 0/12, plus 8/12 → 0/12 degraded. That is the fault being fixed, and it is
the thing worth shipping.

A quality PASS at n=6 would be directional evidence that the deadline does not
degrade the answer. It would NOT be proof: within-fixture CV for entries is 26%
(TASK_0020 has ranged 1-52 entries on the same fixture and arm). Say so in the
verdict rather than rounding it up. And a PASS obtained on any fixture where the
baseline degraded to a stub is not a PASS at all — that is what UNSCORABLE exists
to say out loud. The wall-clock line is CENSORED and descriptive; it is not a
lever benefit in either direction.
