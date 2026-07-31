# Resume prompt — nexttask 5, round 2 (instrument, then re-run)

Paste the block below into a fresh session. Everything it needs is on disk;
nothing depends on the previous session.

---

Read `VALIDATION-DEBT.md` section `## OPEN — 3. worker:apis project-source
fan-out (nexttask 5B)` first, ending with the subsection `### THE RE-RUN (n=3,
fixed instrument, fresh corpus)`. Then do the four work items below, in order.

## STATE ON DISK — all of it, no ambiguity

- `main` = `c534059` (`chore(release): v0.28.0`), pushed. `@mjasnikovs/pi-task`
  **0.28.0 is PUBLISHED to npm as `latest`**. Working tree clean apart from
  untracked `nexttask1-7.md` (deliberate — those are notes, not deliverables).
- Branch `nexttask5-research-restart-visibility` is merged into main (merge
  commit `f5d7e63`) and also pushed. Nothing is left unmerged.
- `bun run lint` clean; `bun test` 2628 pass / 1 skip / 0 fail.
- `dist/` is built from this tree.

**What shipped:** 5A restart visibility only — `runWorker` returns
`attempts`/`totalWallMs`/per-restart list, fires `onRestart` and `onCarryForward`,
and `phases.ts` logs `RESTART (attempt N discarded) reason=…` plus
`attempts=/total=`. Before it, 21 of run 18's 23 restarted workers reported
`exit=0` and logged identically to clean ones.

**What did NOT ship, and must not without a verdict:** both fan-out levers, in
`src/task/research-fanout-budget.ts`, env-gated OFF, with a unit test asserting
the shipped path is unchanged —

    PI_TASK_PROJECT_DOCS_BUDGET             cap the fan-out          (wrong lever)
    PI_TASK_FANOUT_TIMEOUT_PER_LOOKUP_MS    scale the ceiling        (wrong lever)
    PI_TASK_WORKER_CARRY_FORWARD            carry findings forward   (HARMFUL)
    PI_TASK_WORKER_PROGRESS_CEILING_MS      progress deadline        (only candidate)

## THE MEASUREMENT SO FAR

Two full A/B runs, one dist, env-gated arms, `AB_DIR=~/tmp/research-fanout-ab-v2`
(24 trials, 4 fixtures x 3 trials x 2 arms, none errored). Verdict, verbatim:

    fixture     arm        n  timeouts  apisWall(s)  lookups  entries  sig  ungrounded
    TASK_0017   baseline   3      3/3         507     21.0     21.7  21.0         1.0
    TASK_0017   progress   3      0/3         706     28.7     38.3  37.0         0.0
    TASK_0019   baseline   3      3/3         493     32.7     25.7  25.0         0.0
    TASK_0019   progress   3      0/3         568     41.0     32.0  31.3         0.3
    TASK_0020   baseline   3      3/3         720     51.7      9.0   8.7         0.0
    TASK_0020   progress   3      0/3         650     39.7     38.3  37.3         2.0
    TASK_0021   baseline   3      3/3         720     67.3      1.0   1.0         0.0
    TASK_0021   progress   3      0/3         510     32.3     28.7  27.3         0.3

    BASELINE produced the shape 12/12   TREATMENT shipped it 0/12
    quality UNSCORABLE — TASK_0021 (0/3 baseline trials produced any symbol)
    inv-quality-not-worse    BROKEN  TASK_0019 0.0%→0.8%; TASK_0020 0.0%→4.4%
    inv-no-new-degrade       HOLDS   0 degraded trials in progress
    inv-low-fanout-untouched HOLDS   ← FALSE. No control fixture was run. See item 1.
    inv-wall-clock-lower     HOLDS   610s → 608s  ← censored data. See item 3.

    FAIL — the lever removed the shape but broke inv-quality-not-worse.

Established beyond argument: baseline killed and discarded work on **12/12**
trials, **8/12 degraded**, and **5/12 shipped a one-entry stub** (`symbols=0`).
The progress arm ran all 12 in a SINGLE attempt with 19-56 entries and zero
degrades. Metric 1 has now reproduced on two independent corpora.

NOT established: any quality claim, in either direction. n=3 is under the
measured 26% within-fixture CV, and on three of four fixtures the baseline it is
measured against collapsed to empty sections.

Every symbol the treatment was flagged for was checked by hand against that
trial's own checkout and is REAL — `Textarea`/`Label`/`Badge` (all three files
exist in TASK_0020's `src/client/components/ui/`), `useLocation` (wouter,
imported at `ListingDetail.tsx:2`), `$patch` (`listings.patch('/:id')`,
`src/server/routes/listings.ts:317`), `Nav` (`components/Nav.tsx`), `writeText`
(`navigator.clipboard.writeText`). **Zero fabrications across 12 trials and 515
symbols.** They are all one class: the RETRIEVAL GAP — see item 2, the blocker.

## WORK ITEMS, IN ORDER

Items 1-3 are deterministic, cost no model time, and re-score the trials already
on disk. Item 4 is the only one that needs the GPU. Do not reorder: running item
4 first re-measures the same artifact.

**1. `inv-low-fanout-untouched` reported HOLDS on ZERO data.** The v2 run never
ran TASK_0001/0003/0004, and `scripts/live-research-fanout-budget-ab.ts:831-832`
does `if (b.length === 0 || t.length === 0) continue`, so no control trials ⇒ no
breaks ⇒ HOLDS. This is the identical defect that was just fixed one metric up.
Route it through `AbSpec.unmeasured` (`scripts/ab-verdict.ts`) exactly as
`scoreQuality` at `:704` now does, so a control invariant with no controls under
it ABSTAINs instead of passing. Add the test beside the ones in
`scripts/live-research-fanout-budget-ab.test.ts`.

**2. THE BLOCKER — add a PROJECT-TREE channel to the grounding corpus.**
`corpusOf` (`scripts/live-research-fanout-budget-ab.ts:427`) builds the corpus
from the worker's own retrieval TRACE, so a real project symbol the worker knew
from orientation but did not re-read scores as a fabrication. That is 100% of
what still breaks TASK_0019 and TASK_0020. Add a fifth channel: the fixture's own
source tree at its checkpoint commit (the SHA is recorded in every trial JSON as
`commit`; `scripts/run15-fixture-tree.ts` materialises it). A symbol that exists
in the repo was not invented — that is the definition `inv-quality-not-worse`
claims to test, and it is exactly how all 8 flags above were adjudicated by hand.

This is legitimate to do now and NOT post-hoc tuning: RETRIEVAL-GAP is recorded
as a named defect class in `VALIDATION-DEBT.md` from BEFORE this run, alongside
`$delete` being flagged while sitting in the fixture's `src/client/api.ts:143`.

The anti-gaming property is mandatory and must have a test: `Textarea` on
**TASK_0019** (that fixture has no `Textarea.tsx`; TASK_0020 does) must still
score as a fabrication after the change. If it does not, the channel is too wide
and the guard is dead. `findSynthesizedApis` still covers wrong-signature claims
about symbols that do exist.

**3. Stop reading `inv-wall-clock-lower` as-is — it compares censored data.**
Baseline's 720s trials are pinned at the 3x240s cap, so 610s→608s is arithmetic
over a truncated distribution against an untruncated one. Either compare
time-to-a-usable-answer on trials that produced one, or mark the metric censored
and report it as descriptive only. Do not present it as a lever benefit.

**4. Only then, raise n and re-run.** New FRESH `AB_DIR` again (the v2 corpus was
scored under the old instrument; do not mix). Both arms, n=6, the 4 high-fan-out
fixtures **plus TASK_0001/0003/0004 as controls** so item 1's invariant has data.

    AB_DIR=~/tmp/research-fanout-ab-v3 PI_BIN=$(command -v pi) \
      bun run scripts/live-research-fanout-budget-ab.ts baseline 6
    AB_DIR=~/tmp/research-fanout-ab-v3 PI_BIN=$(command -v pi) \
      bun run scripts/live-research-fanout-budget-ab.ts progress 6
    AB_DIR=~/tmp/research-fanout-ab-v3 \
      bun run scripts/live-research-fanout-budget-ab.ts score progress

Budget roughly 5-6 hours per arm. Trials are one JSON each and recorded trials
are skipped, so an aborted arm resumes by re-running the same command.

## OPEN, AND NOT FIXABLE BY INSTRUMENT WORK

`PI_TASK_WORKER_PROGRESS_CEILING_MS` was run at **1,200,000ms** and the maximum
wall ever observed is 980s. It is an arbitrary constant that has never fired, and
"above everything we have seen" is not a derivation. Before the lever ships, that
number needs one — or the deadline needs to be expressed in progress terms with
no wall-clock constant in it at all, which is the whole argument in
`memory/fix-must-preserve-work-not-bound-it.md`.

## RULES THAT MUST NOT BE BROKEN

- **`AB_DIR` on every command.** The default (`~/tmp/research-fanout-ab`) holds
  trials recorded before prompt-capture existed. Mixing corpora invalidates the
  comparison. v2 (`~/tmp/research-fanout-ab-v2`) is the current recorded corpus.
- **Do NOT rebuild `dist/` while an arm is running** — pi children load the docs
  extension from it at spawn time.
- **Do NOT run `bun test` while a harness is running.**
  `src/task/real-pi.smoke.test.ts` spawns real pi and they share the one GPU.
- **NEVER `git stash` in this checkout.** Concurrent agent sessions share it; a
  stash has already eaten another session's live work.
- **Never re-tune an invariant to make an arm pass.** Every instrument change so
  far was justified by inspecting the flagged symbols and finding them real, and
  the last round of fixes deliberately did NOT move the verdict. A threshold
  moved after seeing the number it would change is not a verdict.
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
baseline degraded to a stub is not a PASS at all — that is what UNSCORABLE now
exists to say out loud.
