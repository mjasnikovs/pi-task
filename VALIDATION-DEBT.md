# VALIDATION DEBT

**What this file is.** The planner's research ledger: leads that have been
**refuted** (so nobody spends a day re-proposing them), items still **open**, the
**pass condition** any fix has to clear, and the **environment** the harnesses
need. It is not a to-do list — the entries that cost the most are the dead ends.

Formerly `nexttask.txt`; code comments citing "nexttask TASK n" mean this file.
Details of anything shipped live in git history and in each script's own header,
not here. Last updated 2026-08-05.

---

## RULED OUT — do not re-propose

- **A deterministic veto over a grill auto-answer that NARROWS a design-enumerated
  set** (nexttask 7). Refuted 2026-08-05 at STEP 0, over every recorded run —
  14,561 task files, 733 run-revisions, **24,522 `(auto)` answers / 220 distinct
  (question, answer) pairs** — by `scripts/autoanswer-narrowing-baserate.ts`,
  before any lever was wired. The corpus is A/B-replicated (trial directories
  replay one task dozens of times), so DISTINCT is the honest denominator:

      not-a-set     216 / 220   98.2%      23,634 instances   96.4%
      undecidable     3 / 220    1.4%         835 instances    3.4%
      widening        0 / 220    0.0%           0 instances    0.0%
      narrowing       1 / 220    0.5%          53 instances    0.2%

  **The one narrowing IS the lead** — mx5 run 19 TASK_0001 Q1, `.env.example`
  cut from five variables to one, grounded on `DESIGN/PROJECT.md:77`. There is no
  second instance anywhere in the corpus, so the rule would be fitted to a sample
  of one and A/B-1's pre-registered PASS ("run 19's TASK_0001 Q1 resolves to the
  full five-variable set") would be satisfied by construction. nexttask 7's own
  pre-registered close condition — *"if set-selection questions are rare the
  guard's blast radius is tiny and the task should be closed as low-value — say so
  with the numbers, do not build it anyway"* — fires here. A/B-1 and A/B-2 were
  never built.
  *(a) Set-selection questions are rare and mostly UNENUMERABLE.* A loose keyword
  sweep (`only|also|just|in addition|as well as|full|all of`) flags 56 of the 220,
  but only **4** carry two parseable enumerated option lists of |U| ≥ 3. The rest
  are binary preferences ("401 or 403"), unenumerated inclusions ("or also
  additional metadata such as remaining time until expiry"), or `<!DOCTYPE html>,
  <html>, <head>, <body>` boilerplate on runs with no design at all.
  *(b) All three `undecidable`s are CORRECT abstentions, hand-read.* The design
  genuinely does not enumerate `c.var.user`'s fields (§6 says only "loads the user
  onto `c.var.user`"), does not enumerate the login response (§5 line 190 says
  "returns user"), does not contain `toolName` at all (gofer-pixel), and never
  enumerates the marketplace filter chips (§8 defers them to `marketplace.html`).
  Nothing was lost by abstaining.
  *(c) `widening` is empty, so the "veto only touches set-valued answers"
  invariant has nothing to hold it down.* The one shape it must never damage never
  occurs.
  *(d) The SUBJECT half of the grounding rule is load-bearing and was found by
  hand-read, not by design.* Without it the classifier's second hit was "what
  exact fields should `c.var.user` carry — only id, role, is_banned or also phone,
  display_name?" grounded against `` `GET /api/admin/users` → all users (id,
  phone, display_name, role, is_banned, listing count) `` — a different artifact
  that happens to list the same columns. Requiring the design line to also NAME the
  question's subject (matching across dotted extensions, which is what lets
  `.env.example` ground on the design's `.env`) drops it. Two more hand-read
  parser corrections are pinned in the module: `/` is not a list separator
  (`src/server/seed.ts` became the items `src`, `server`, `seed.ts`), and `e.g`
  is not an item.
  The classifier is kept, unwired, at **`scripts/answer-narrowing.ts`** so the base
  rate stays re-runnable; nothing in `src/` imports it.
  **What to do instead:** the run-end static check written up in `nexttask10.md` —
  every `process.env.X` in tracked source must appear in the tracked env template.
  It catches this defect and every other route to it, needs no set-shaped question,
  and does not depend on a clarification ever being asked.

- **Choosing the reassignment TARGET at the moment the owned/freeze conflict is
  found** (nexttask 2's branch 1), and **demoting the loser to CROSS-CUTTING**
  (its branch 2). Refuted 2026-08-05 at STEP 0, over all 60 recorded composed
  specs on disk (`scripts/owned-freeze-reassign-baserate.ts`), before a lever
  existed. The corpus holds exactly ONE conflict — mx5 run 19 TASK_0015, the §9
  Build & run server clause against `src/server/index.ts` — and on it:
  *(a) "exactly one other task names P" never holds.* Candidates: 3 by plan title,
  7 by research FILES, **8 either way** — a plain mention cannot tell the file's
  author from the seven tasks that import from it. Branch 1 fires 0 times; the
  lever CARRIES everything, which is a no-op dressed as a fix.
  *(b) The proposed target has already run.* nexttask 2 nominates TASK_0014;
  it completed immediately BEFORE TASK_0015, and the pair is only detectable at
  TASK_0015's own compose, so editing TASK_0014's ledger entry changes nothing
  that will ever be composed again.
  *(c) At that moment the information does not exist.* Pending tasks are bare plan
  titles — **none of run 19's 26 titles contains the string
  `src/server/index.ts`**, TASK_0017's reads "…small fetch/mutation hooks, SPA
  fallback route on server". A path-lexical target rule at detach time is BLIND IN
  PRODUCTION, exactly like the run-18 critique probe it was meant to replace. The
  same rule scores 8 candidates against RECORDED SPECS, which is why a corpus
  replay must feed each task only the artifacts it had at that moment.
  *(d) CARRY is spec inflation.* The one conflicting quote is a task-specific
  deliverable, not prohibition- or policy-shaped, so `isCrossCuttingRequirement`
  rejects it; carrying it anyway would push "the server serves static `dist/`"
  into the 11 tasks that had not yet run, none of which owns the server file.
  What replaced it (SHIPPED): **DETACH at the conflicting task, CLAIM by the task
  whose own REFINED prompt says it writes the frozen file** — over run 19's 26
  refined prompts `writeIntent` fires on exactly two, the file's creator (already
  run) and TASK_0017 (pending). See `src/task/owned-freeze-reassign.ts`.

- **Lexical obligation ranking** (`OBLIGATION_RE`, or any stricter modal subset).
  Refuted 2026-07-29. It *passes* the old mx5-only pass condition and is still
  wrong: mx5 pools A/B 9.37→10.77 and 8.43→10.27 of 16 criticals, zero losses,
  p≤0.0001 — but on a second spec the **sign reverses**, 23.77→21.70 of 31, 0
  better / 30 worse. The regex holds bare `no|not|only|every|each`: only 1 of
  mx5's 16 criticals is modal-grounded, six fire on accidents (`\bno\b` inside
  `no-explicit-any`, `not` inside `text not null`). Real obligations are often
  *declarative* ("The parser produces a lossless CST") and carry no modal at all.
  A modal-only variant is inert (+0.30 mx5, exactly 0.00 on the second spec, all
  30 runs tied) because quotes inside `must`/`required` paragraphs already bypass
  the fill via the marked set. **The dead end is lexical obligation detection
  itself**, not one regex — two strictnesses, one harmful, one inert. Re-run:
  `scripts/obligation-rank-{step0,endtoend,diagnose}.ts`.
- **k-of-n voting across extraction passes.** Any threshold ≥5 keeps all 37 schema
  rows and deletes the test-cadence line and the "non-`/api` GETs serve the built
  `index.html`" clause — the two whose loss has already cost a run each.
- **`marked.slice(0, MAX_REQUIREMENTS)` as a latent run-16 defect.** It is a
  first-N truncation and looks like one, but `marked` never exceeds 40 in 60 runs
  (max 8), so it never truncates.
- **Resolving the owned-requirement/category-freeze pair in the CRITIQUE rewrite**
  (nexttask 7). Refuted 2026-08-04, 20 trials/arm, and refuted twice over.
  *(a) The seam is blind.* `appendOwnedConstraints` — the BRACES that stamp the
  machine-marked owned bullet the detector keys on — runs AFTER
  `critiqueWithFallback` in the `critique` step, so at critique time the stamped
  line does not exist and compose's own folding is a paraphrase ("The server watch
  command must match the contract exactly: `…` — serves `/api` + static `dist/`").
  Live: **0/40 compose drafts carried a detectable pair while 11/40 carried the
  clause semantically**; both compose arms ABSTAINed for that reason.
  *(b) Forced through the controlled critique seam* on run 18's real TASK_0023
  draft, the probe drives pair-present **8/20 → 0/20 — by deleting the
  authoritative clause as often as by granting ownership**: 11/20
  requirement-dropped (0 of the 11 reassigned it to the task that owns the file;
  they rationalised — "this references an existing file; no edits are required or
  permitted") vs 9/20 scoped-ownership. Behavioural VERIFY is **6/20 in BOTH
  arms** — the delivered spec still checks the behavioural requirement by grepping
  `package.json`, which was the whole defect. `inv-no-spec-inflation` holds
  (CONSTRAINTS lines 11.2 → 10.4), and that shrink is the deletion showing up in a
  second measure. **Removal of the pair is not satisfaction of the requirement** —
  the run-16 delivery-metric lesson one level down. The detector itself is sound
  and kept UNWIRED (`src/task/owned-freeze-conflict.ts`, 16 unit tests,
  `scripts/owned-freeze-conflict-fp-suite.ts` PASS: 1 finding over 58 real specs,
  0 on 6 negatives, 3/3 positive controls). Any next attempt must act AFTER the
  braces, where the pair exists — and cannot be a model rewrite, because the
  braces are the last spec-producing step.
  **STEP 0 (`scripts/owned-vs-freeze-baserate.ts`, 58 recorded specs, 5 trees):**
  N=29 specs carry an owned requirement, n1=3 of those also carry a category
  freeze, **n2=1** is the unsatisfiable shape (mx5 TASK_0023) and n3=0 of those
  were met at HEAD. The other two co-occurrences are gofer-pixel's, and both
  EXEMPT the deliverable by name — compose usually gets this right. n2==1 means
  the rule is designed on a single instance: **generality ABSTAINS**, and the
  confirmation pool nexttask 7 nominates is gone — `~/hub/mx5` history begins at
  run 18's `base`, run 16's specs are retained nowhere on disk (which also means
  `scripts/live-owned-requirement-compose-ab.ts` now reads run-18 files from the
  paths it documents as run-16 fixtures).

- **Any lever on the docs redirect loop's auto-install hop** — negative cache,
  pre-install existence probe, or pinning the hop (nexttask 1-1). Refuted
  2026-08-05 at STEP 0, before a lever existed, on two grounds that are
  independent of each other. *(a) The cost is mostly useful work.* Of the 947 hops
  that would `npm install`, **634 (66.9%) install a package that really ships
  declarations** — 336 of 538 distinct `@types/<x>` targets exist on npm. Only 313
  can never produce anything (308 absent from npm, 5 install but ship no `.d.ts`).
  The premise that "nearly all are guaranteed-miss round trips" was wrong.
  *(b) No workload reaches them.* The hop fires only under a package that ships no
  types of its own, and a docs lookup only ever names a package the SPEC names — a
  direct dependency. Of the 947, **4 sit under a direct dep (0.4%)**: `tap-min`,
  `semantic-ui-css-offline`, `jsdom`, `start-server-and-test` — and `@types/jsdom`
  exists, so one of the four is a *useful* hop. Addressable waste ≈ 3 × 470ms, and
  only if someone asks the docs worker about those three packages. Replayed
  against run 19's own debug logs (`scripts/docs-hop-replay.ts`, 500 real lookups,
  22 distinct packages): **0 install hops**. The A/B nexttask 1-1 pre-registered
  ("installs strictly down" over that replay) is therefore **unrunnable, not
  failing** — a zero baseline, the shape ruled ABSTAIN in
  `scripts/ab-verdict.ts`. The 947 is an artifact of walking every *installed*
  package, which nothing in the product does: `gatherExternalContext`
  (`src/task/external-context.ts:64`) looks up the spec's named deps under a cap
  of 12, and never enumerates `node_modules`. Both runs of
  `scripts/docs-hop-install-baserate.ts` agree on every count; only wall clock
  moved (hit-install mean 920ms vs 682ms), which is the registry, not a decision.
  The two aggravating facts in the lead are real and stay unfixed on purpose: the
  hop passes no `versionRange` (`docs-core.ts:270`) where the top-level path
  resolves `findDeclaredRange` first (`:344`), and the shared install cache is
  never GC'd (94 top-level deps). Both are worth ~0 because the hop is worth ~0.

## METHODOLOGY RULES — each one cost real time

1. **A pooled FP suite is not an admissibility test.** The cap runs *per run*.
   Argon2id has three carriers pooled; the pooled check passed on the prose while
   the one run that extracted only the DDL row lost the obligation outright.
   Per-run check: `scripts/extraction-filter-score.ts`.
2. **Designing a rule while looking at a pool disqualifies that pool.** Draw a
   second, independent pool to confirm. Pools live in `.measure/` (gitignored,
   repo-local — a session scratchpad gets deleted with the session);
   `extraction-precision-step0.ts` takes a TAG so a confirmation pool sits beside
   its design pool.
3. **Two pools of the same spec are not a generality test.** See the refutation
   above: passed both at p=0.0001 while being harmful elsewhere.
4. **Per-rep comparison of any model-sampled quantity between divergent arms
   measures the sampler, not the rule.** Only distributional comparisons and
   rule-fired subsets are valid; lockstep sharing narrows this but does not
   remove it.
5. **Never run `bun test` while a model harness is running.**
   `src/task/real-pi.smoke.test.ts` spawns real pi and times out under
   llama-server contention (9.85s on a free server, >120s under load).
6. **A regression net pointed at a live evidence tree rots.**
   `scripts/dangling-artifact-fp-suite.ts` scanned `~/hub/mx5` at whatever HEAD it
   had; the tree kept running, run 18's autofix closed the run-13 dangle, and the
   suite sat RED for reasons unrelated to the extractor — so nobody read it. Evidence
   arms now scan `git archive` exports of NAMED commits
   (`scripts/html-asset-closure-corpus.ts`); the evidence repo is never checked out.
7. **A corpus-walk base rate is not a workload base rate.** Sweeping every
   installed package through a seam counts what the seam *could* cost, not what it
   *does*. nexttask 1-1's 947 auto-installs collapse to **0** on the replay of the
   run that motivated it, because 943 of them sit under transitive packages no
   lookup ever names. Before costing a seam, replay a real run's own logs through
   it and check the baseline is non-zero — a zero baseline means the A/B was never
   runnable, not that the lever failed.

## PASS CONDITION for any selection fix

Critical obligations reaching the shipped 40 must **rise with zero per-run
losses**, and **tail-section coverage must not regress** — on **both mx5 pools
AND a second, differently-phrased spec**. The second spec's critical list must be
written **before** its pool is drawn and must deliberately include *declarative*
obligations, which mx5's list under-represents.

    mx5:    bun run scripts/extraction-filter-endtoend.ts <pool.json>
    2nd:    SPEC_PATH=<spec> PI_BIN=$(command -v pi) \
              bun run scripts/extraction-precision-step0.ts 30 <tag>   # ~35 min
            bun run scripts/obligation-rank-endtoend.ts --spec <spec> \
              --critical <critical.json> --pools <pool.json>

A toolchain pool already exists at `.measure/extraction-pool-toolchain.json`.
The harness **abstains** when the cap engages in under half the runs — below 40
entries nothing is contested and a selection rule cannot be measured at all.

---

## OPEN — 0b. The refuted-constraint drop is WIRED; its DELIVERY claim is under-powered (nexttask 8, A/B-2)

The deletion pass is **wired and A/B-1 PASSes** (`src/task/refuted-constraint.ts`,
`scripts/refuted-constraint-ab.ts`): over **12,810 recorded task files** the count
of tasks whose CONSTRAINTS still require a token their own research refutes goes
**3 → 0**, with all five invariants holding. It is provably subtractive — the
treatment text is a strict character subsequence of the baseline — and it can
never touch an owned line, so it lands despite the A/B-2 result below.

**STEP 0 killed one third of the doc's proposed negation set, and the corpus said
so before anything was wired.** The bare shape `no \`X\` dependency` fired **300
times in 306 hits**, every one a MANIFEST-STATE bullet asserting the opposite of a
refutation — "`package.json` currently lists no `hono` or `@hono/zod-validator`
dependencies; **they must be added**". Dropping on it mutilated real constraints
("use  with the shared `loginSchema`"). The shipped rule requires an explicit
negation of NEED, and a near-miss census (985 bullets, 3 shapes) forced a
dependency-word guard onto two more patterns — "does not require" appears in 412
CONTEXT bullets and is almost always behavioural prose ("the endpoint does NOT
require authentication"). Final base rate: **6 hits / 12,810 files, all 6
hand-verified true**, all on the lead, catching both `argon2` and `bun-sql`.

**Wiring correction worth keeping.** The drop must land on the phase context's
`refined`, not on compose's local copy: `phaseCritique` is handed the refined task
as GROUND TRUTH under "CONSTRAINTS … MUST be preserved in spirit", so a deletion
only compose could see is restorable one phase later. Pinned by
`phases.test.ts` → "the drop lands on p.refined, so CRITIQUE sees it too".

**A/B-2 FAILs its pre-registered gate, and the honest reason is power, not
direction** (`scripts/refuted-constraint-delivered-ab.ts`, 20 reps/arm through the
real compose→critique chain on run 19's TASK_0001 inputs):

    scoring                     baseline   treatment   p
    clause-level (registered)     9/20        1/20      0.0084
    spec-level  (sensitivity)     3/20        0/20      0.2308
    hand-read, all 10 hits        2/20        0/20      0.4872

All 10 hits were read. Six baseline hits and the single treatment hit are scorer
artifacts on specs that PROHIBIT both tokens: an ACCEPTANCE line "No `argon2`,
`bun-sql` … are present" and VERIFY assertions like `if (p.dependencies?.argon2)
throw` carry no negation cue a clause splitter can see. Only reps 1 and 2 are the
real defect (rep 2 reproduces the shipped shape exactly — a dependency list naming
`argon2`, an ACCEPTANCE echoing it, and a VERIFY that throws when it is absent).
So the pre-registered "baseline ≥ 8/20" bar is met **only** by the contaminated
metric; the clean base rate is ~2/20 and n=20 cannot resolve it.

**What is nonetheless established:** across **60 live treatment specs** (20 chain +
40 compose-only) not one genuinely requires a refuted dependency, spec-shape
validity is 20/20 in both arms, and the treatment never sheds the REAL pinned
dependencies (`hono`, `sharp`, `react` — 20/20). The next attempt needs
**n ≈ 60/arm**, or a second stack where refine invents a design-refuted dependency,
before the delivery claim can be made.

**Methodology note that cost the most here.** The metric was wrong three times
before it was right, each caught by hand-reading a live rep, and every error ran
in the LEVER'S FAVOUR-hiding direction — bare token presence scored `do not add
\`argon2\`` as *requiring* argon2, i.e. it reported the lever's own success as its
failure. `scripts/refuted-constraint-scorer-check.ts` (11 cases: the recorded
run-19 spec, four requirement shapes, six prohibition shapes) exists so no
proportion from this harness is ever trusted before the instrument is.

## OPEN — 0a. Ownership is fixed; VERIFICATION DEPTH is not (nexttask 2, A/B-2)

The owned/freeze detach-claim pass is **wired and A/B-1 PASSes** (bookkeeping:
conflicts 1→0 on the corpus, five invariants, 82 clean specs byte-identical —
`scripts/owned-freeze-reassign-ab.ts`). Its DELIVERY half **FAILs**, and the
failure is the same shape run 18 recorded one level up.

A/B-2 (`scripts/owned-freeze-delivered-ab.ts`, 20 live trials/arm on run 19's
real TASK_0017 inputs, arms differing only in `requirements-owned.md`):

    M1  an ACCEPTANCE/VERIFY line that OBSERVES static asset serving
        baseline 0/20   treatment 0/20      (pre-registered PASS was >= 14/20)
    the clause delivered VERBATIM and AUTHORITATIVE
        baseline 0/20   treatment 20/20

So the pass does exactly what it claims — the authoritative clause reaches the
spec of the task that writes the file, and no quote is ever lost — and that
changes NOTHING about how the spec verifies it. Both arms deliver the same
ACCEPTANCE ("the SPA fallback serves `dist/index.html` for non-`/api` GETs") and
neither ever requests a built asset. The static half of "serves `/api` + static
`dist/`" is not converted into an observation by anybody.

The mechanism is visible in the delivered files: in all 20 treatment specs the
clause appears **once**, as the machine-stamped CONSTRAINTS bullet
`appendOwnedConstraints` writes AFTER critique. Compose had the same clause in
its belt block and folded it into ACCEPTANCE/VERIFY **0 times** — the run-16
measurement ("the belt alone is obeyed ~25%") is optimistic for a behavioural
clause of this shape.

The metric is not the problem: `scripts/owned-freeze-delivered-scorer-check.ts`
PASSes — 0 hits over all 60 recorded specs, 0 on 5 hand-built negatives (SPA
shell only, the run-18 `package.json` grep, build-without-request), 3/3 on
positives.

**What this rules out:** moving ownership as a route to verification depth. The
next lever has to act on the VERIFY block itself, for an owned requirement whose
behaviour is observable, and it cannot be the braces — they run after the last
model step, which is why a bullet appended there never reaches ACCEPTANCE. Note
`scripts/verify-integration-depth-step0.ts`'s refutation applies to appending a
generic boot command; a clause that names its own observable
(a request for `dist/app.css`) is a narrower target that has not been measured.

## OPEN — 0. The stem-widened failure-file extractor (measured, NOT wired)

The shipped extractor sees paths and bare basenames with a code extension. Live, that
covers 100% of tsc-shaped failures and 45% of component-test-shaped ones, because the
verifier writes "The MyListings component test …" and never a file name. A widened
variant — accept a bare IDENTIFIER that matches some tracked file's stem, so
`MyListings` resolves to `MyListings.spec.tsx` — scores **40/40 extractable, 0 wrong**
across both live arms.

It is not wired, for two reasons that are both about evidence, not taste:

1. The *disjoint* arm is its design pool (it was written after reading trial 1), so
   only the *reachable* arm counts as confirmation — and in that arm the failing file
   was ALWAYS named outright, so the widened rule was never actually load-bearing
   there. Its false-KEEP mode (an unnamed reachable failure whose prose happens to
   mention an unrelated file) was never exercised.
2. It demonstrably resolves prose nouns to files: in 3 disjoint trials the only token
   it found was "listings" → `src/server/routes/listings.ts`, a file with nothing to
   do with the failure. It scored *correct* there by luck of disjointness.

To close it: an arm where the enforce diff DOES cause the failure and the verifier
does NOT name the file (a runtime/behavioural break rather than a type error). If the
widened rule holds 0 false keeps there, wire it — the coverage win is large.

## OPEN — 1. The requirement-extraction lottery (highest leverage)

The selection half moved; the extraction half has not. Roughly **half the
critical obligations still never reach `requirements.md`**.

Measured, two independent 30-run mx5 pools: yield 20..160 (mean 73.5, sd 34.3)
and 21..150 (mean 84.0, sd 36.5) for byte-identical input. The shipped low-value
filter is real but small — 8.50→9.37 and 7.70→8.43 of 16.

Constraints on any new attempt:

- **The marked-passage priority mechanism is thin** — min 0 / median 1 / max 8
  protected quotes per run across 60 runs. Any design leaning on it is leaning on
  almost nothing.
- **Tail-section coverage is low for everyone** — of the doc's last 4 sections the
  shipped 40 touches 1.20 / 1.33, *in the baseline arm too*. `sectionFairFill`
  stops a section being wholesale dropped; it does not get the tail represented.
  Unexamined lead, and exactly where mx5 keeps its testing obligations.
- **Absolute beats budgeted on raw count and is still wrong** (24 vs 22 gains):
  its extra gains are one more obligation in an already-populated list, its one
  loss is an obligation vanishing from a run entirely. Not the same mistake.
- The positive-ranking slot now needs a signal that is **not the sentence's own
  vocabulary** — structural position within its section, or a per-quote model
  judgement (which costs calls and re-opens the stochastic channel).

## OPEN — 2. The coverage loop's split-brain gate

Continue and adopt read different signals:

    continue:  best.plan.missing.length === 0    (holistic judge free-text +
                                                  unmapped quotes + dangling artifacts)
    adopt:     droppedCoverage over the deterministic groundedCoverage set

Nothing forces a retry to address what the judge flagged, and the judge
regenerates its list from scratch each round.

**Reproduces on demand** on `scripts/fixtures/toolchain-spec.md`: round 0 hits the
coverage ceiling (37/37) in nearly every rep while the judge returns INCOMPLETE in
9/16 — the split brain with the deterministic channel pinned at maximum. The old
blocker (the requirement channel is only 38-42% reproducible) is still true but
weaker: this fixture saturates that channel, so the judge channel can be studied
alone.

The question when picked up: should the loop continue on the stochastic judge
channel at all, or only on the deterministic unmapped-requirement channel? The
judge channel is what catches areas the extractor *missed*, so deleting it trades
one blindness for another. Measure before choosing.

## OPEN — 3. worker:apis project-source fan-out (nexttask 5B)

Instrumentation (5A) is **shipped**: `runWorker` now returns `attempts`,
`totalWallMs` and a per-restart list, emits `onRestart` per discarded attempt, and
`phases.ts` logs `RESTART (attempt N discarded) reason=…` plus `attempts=/total=`
on the `done` line. Before it, a worker that burned two 240s attempts and then
answered logged **identically to a clean one** — 21 of run 18's 23 restarted
workers reported `exit=0`.

STEP 0 is **measured**, and `scripts/research-restart-baserate.ts` reproduces it
from the recorded logs on demand (mx5 run 18, 24 task logs, 96 worker runs):

    23 runs restarted, 30 discarded attempts, 120.0 min discarded
    = 42% of all worker wall time; 19 attempts / 76.0 min on the critical path
    r(project-source lookups, worker:apis wall) = 0.909, n = 24
    <=4 lookups: 1/8 restarted     >=46 lookups: 5/5 burned the FULL budget
    464 of 615 docs calls (75.4%) are project-source `.` lookups

The two candidate bounds live in `src/task/research-fanout-budget.ts`, **env-gated
and OFF** — `PI_TASK_PROJECT_DOCS_BUDGET` (cap the fan-out to fit the 240s
ceiling) and `PI_TASK_FANOUT_TIMEOUT_PER_LOOKUP_MS` + `_CEILING_MS` (scale the
ceiling to fit the fan-out). Neither may be wired on argument; the A/B is
`scripts/live-research-fanout-budget-ab.ts` and its verdict is recorded below.

**Both of those answer the wrong question.** They argue about how long a worker
may run. The defect is what happens when it runs out: the attempt is killed,
everything it produced is **discarded**, and the re-spawn gets a hint but no
findings — so it re-reads the same files against the same clock and dies in the
same place. That is why every worker at >=46 lookups burned the FULL budget
instead of converging; r=0.909 measures the amnesia, not an over-long task. The
code says it outright — `WORKER_TIMEOUT_HINT` tells the re-spawn "do not
re-explore ground you have already covered" while giving it no record of what
that ground was, and `const text = result.text ?? ''` sits in hand at the kill
site and is dropped. Judged against "the worker must return its work", CAP makes
the worker read LESS (lowering the requirement so the metric goes green) and
SCALE is a per-file constant that dies on one big file and, being wall-clock,
makes answer quality a function of the user's hardware — the same task on a
slower local model loses its work and degrades.

The third arm, **RESCUE**, is the one aimed at the fault: carry the killed
attempt's findings into the re-spawn so a restart CONVERGES, never return less
than the best attempt produced, and deadline on lack of **progress** rather than
elapsed time (`PI_TASK_WORKER_CARRY_FORWARD`, `PI_TASK_WORKER_PROGRESS_CEILING_MS`
— both OFF by default, with a unit test asserting the shipped path is unchanged).
Being *stuck* is already detected separately and correctly by the output-stall
probe (`STALL_AFTER_MS`), which resets on progress and only kills when the model
endpoint is unreachable; the 240s cap adds nothing there and only kills workers
that are provably alive and productive. RESCUE's own risk is fabrication
laundering — a half-written entry replayed under "work already done" — so the
carry is framed as unverified and the same ungrounded/anti-synthesis invariants
gate the arm.

Baseline evidence so far (1 trial each, live): TASK_0019 `timeouts=1 attempts=2
apisWall=454s lookups=30 entries=24 ungrounded=0/29`; TASK_0020 `timeouts=2
attempts=3 apisWall=702s lookups=63 entries=22 ungrounded=5/39`. More compute,
worse answer — the amnesia shape, though cross-fixture at n=1 it is suggestive
rather than established.

**VERDICT: RESCUE FAILS (exit 1). It does not ship.** 8 fixtures, baseline 1
trial each, rescue 2 trials each, one dist, env-gated arms.

    target shape (>=1 worker-timeout restart): baseline 4/5 → rescue 0/5
    inv-wall-clock-lower  HOLDS  507s → 439s over 5 shared fixtures
    inv-no-new-degrade    HOLDS  0 degraded trials (baseline degraded TASK_0021)
    inv-quality-not-worse BROKEN TASK_0019 ungrounded 0.0→2.5;
                                 TASK_0021 1.0→3.5; TASK_0022 0.0→4.0
    inv-low-fanout-untouched BROKEN TASK_0003 wall 65s→98s;
                                 TASK_0004 entries 17.0→13.0

The fault it targeted is gone: every witnessed fixture, both trials, finished in
ONE attempt with zero timeouts, while entries rose on all four (TASK_0021 5→29.5,
TASK_0020 22→34.5) on FEWER lookups (44→27 mean) — baseline's extra reads were
the same files re-read into discarded attempts.

**The quality half of that FAIL does not survive inspection**
(`scripts/inspect-ungrounded.ts` names the symbols; `scripts/rescore-ungrounded.ts`
recomputes both arms). I first reported TASK_0019's 0→2.5 as a real, reproducible
grounding regression. It is not. The flagged "API symbols" are:

  - PROSE parsed as an entry — "Now I have all the information needed. Here is
    the APIS section:" yields Now/information/needed/Here/APIS. This is most of
    it, and it lands in BOTH arms (baseline TASK_0017 and TASK_0020 carry the
    identical artifact; baseline TASK_0021's lone ungrounded symbol is the word
    `degraded` from its own degrade marker).
  - PLATFORM BUILTINS — `URL.createObjectURL`, `URL.revokeObjectURL`,
    playwright's `PageAssertions`. No project/package docs channel can hold them.
  - SYMBOLS THE TASK ASKS THE WORKER TO CREATE — TASK_0022's `AdminRoutes`,
    `AdminUsersGet`, `AdminBanPost`.

Correcting prose alone: baseline TASK_0017 4.0→0.0, baseline TASK_0020 5.0→1.0,
rescue TASK_0020 3.5→0.0. **Zero fabricated project API signatures in either
arm.** RESCUE retains more residue only because it writes far more entries
(34-79 symbols vs 5-41) and so names more builtins — TASK_0021 compares 5
baseline symbols against 59.

`apis-trajectory.ts` declines to stop-list prose on the stated grounds that "a
prose word in an entry name matches the prompt text and therefore always scores
GROUNDED". That holds when `corpus.prompt` is what its doc comment describes —
the ASSEMBLED worker:apis prompt. This harness can only supply the 1.9KB seeded
task file, so the assumption fails here and prose falls through as ungrounded.

**This does not make RESCUE a PASS, and it must not be recorded as one.** A metric
corrected after seeing the verdict cannot ship a lever. What it establishes is
that the FAIL is probably instrument-driven, which justifies fixing the
instrument and RE-RUNNING the arm. Still genuinely open and NOT explained by any
of this: **TASK_0004 lost 4 entries (17→13) on a CONTROL fixture**, which the
lever should not touch at all.

The other three breaks are instrument defects, all recorded BEFORE this verdict
existed (below): TASK_0021 inverts on absolute-vs-rate (16.7%→5.5% by rate, and
baseline "wins" only because it degraded to 6 symbols), TASK_0022's baseline draw
never posed the problem (1 lookup, unwitnessed), and TASK_0003 breaks by ONE
second (98.5s vs a 97.5s threshold). A re-score fixing gaps 1 and 2 is legitimate
and cheap — the trial JSON is on disk, no model time needed — but it must be
reported NEXT TO this pre-registered FAIL, never as a replacement for it.

Also measured: **fixture fan-out is wildly non-deterministic.** Same fixture,
same arm, adjacent trials: TASK_0020 52 vs 17 entries and 737s vs 302s;
TASK_0017 24 vs 48 entries. Per-fixture quality means at n=2 are weakly powered,
which is why metric 1 (0/10 vs 4/4 restarts) carries the weight here.

**GRAY AREAS, WORKED THROUGH.** `scripts/rescore-invariants.ts` recomputes every
invariant with the instrument defects corrected and prints the pre-registered
number beside each. Corrected, on witnessed fixtures only:

    metric 1 timeouts   baseline 4/4 → rescue 0/8
    metric 2 wall       576s → 448s   HOLDS
    metric 3 quality    BROKEN — TASK_0019 rate 0.0%→6.7%; TASK_0021 0.0%→1.7%

- **Every remaining "ungrounded" symbol is a REAL API.** `$delete` is in the
  fixture's own source (`src/client/api.ts:143`, used at `ListingDetail.tsx:84`);
  `URL.createObjectURL` is a platform builtin (verified via node). The corpus is
  the worker's own RETRIEVAL TRACE, not the project — a symbol the worker knew
  from orientation or the FILES map but did not re-read is unfalsifiably
  "ungrounded". **Zero fabricated symbols in either arm, on any fixture.**
- **TASK_0004's control entry loss (17→13) is not the lever.** All three trials
  ran `attempts=1` with no restart and 61-176s wall, so carry-forward (prompt
  changes only on restart) and the progress deadline (changes only when a timer
  fires) were both provably inert. The difference tracks PACKAGE lookups (15 vs
  2) and entry granularity: baseline wrote zod per-method (`z.object`,
  `ZodString.min`, 17 entries), rescue per-schema (`loginSchema`, 10 entries).
- **Variance quantified: mean within-fixture CV for entries is 26%** (TASK_0020
  52 vs 17, TASK_0017 24 vs 48, same arm, adjacent trials). Any between-arm
  quality difference smaller than that is not resolvable at n=2 — which covers
  both surviving "breaks".
- **The progress ceiling never fired.** Max observed wall 737s against the
  1,200,000ms ceiling — 61% used, 463s headroom. It is an arbitrary constant and
  it is provably inert; it still needs justification before shipping, but it did
  not influence this A/B.
- **The replay reproduces the fault ATTENUATED.** Run 18 gave these five fixtures
  3 attempts and 480s discarded each on 46-60 project lookups; the replay
  baseline got 2/2/3/3/1 attempts on 15/30/63/67/1 lookups — 4 of 5. The measured
  benefit is therefore a LOWER BOUND on the real-run benefit.
- **D5 (new, found in the carry arm): `witnessed` counts only `pi-worker-docs`
  project calls and ignores `read`/`grep`.** The carry arm's TASK_0017 trial
  retrieved almost entirely via direct `read`/`grep`, scoring `lookups=2` while
  its first attempt worked 239s and was killed by the 240s cap. A worker that
  fans out through the file tools therefore reads as "never posed the problem"
  while demonstrably posing it, and every witnessed count in this document
  UNDERCOUNTS true fan-out. The precondition should be retrieval volume across
  all grounding tools (`isGroundingRetrieval`), not one tool's name.
- **CARRY-FORWARD IS HARMFUL ON ITS OWN — measured, `carry` arm, FAIL.** In the
  rescue arm it never fired at all (`attempts=1` on all 8 trials, `salvaged=1`
  never logged), so half the lever was credited with a result it took no part in.
  The `carry` arm (carry ON, fixed 240s cap, so restarts still happen) put it
  under test for the first time, 4 fixtures:

      TASK_0017  1 timeout  38 entries   (baseline 35)
      TASK_0019  2 timeouts 32 entries   (baseline 24) — fabricated `Textarea`
      TASK_0020  2 timeouts  2 entries   (baseline 22) — SALVAGED, DEGRADED
      TASK_0021  2 timeouts  2 entries   (baseline  5) — SALVAGED, DEGRADED

  Two distinct harms, both mechanistic, neither visible in the rescue arm:

  1. **Prompt inflation against a fixed cap.** Carry prepends up to
     CARRY_FORWARD_LIMIT (24,000) chars, which every retry must then process
     inside the SAME 240s. On TASK_0020 baseline's third attempt SUCCEEDED with
     22 entries; with carry on, all three attempts timed out (`exit=143`) on
     near-identical retrieval (61 vs 63 lookups). It spends the budget it exists
     to save. This is why `rescue` worked and `carry` did not — the progress
     deadline gives the enlarged prompt room, and without it the carry is
     strictly negative.
  2. **Fabrication laundering, observed once.** `Textarea` — a UI component that
     does NOT exist in the fixture (`Input.tsx`, `Label.tsx`, `Select.tsx` do)
     and that the task never names — appears ONLY in the carry arm, on the trial
     with the most restarts. Absent from baseline (restarted, carry off) and from
     both rescue trials (never restarted). n=1, but it is the exact predicted
     signature on the only configuration that exercises the mechanism.

  **Salvage bug, found and FIXED.** It kept the LONGEST partial with no test for
  content, so on both degraded fixtures it shipped this as the APIS section:
  *"Now let me get more details on the specific APIs and components I need:"*.
  `hasAnswerContent()` now requires >=2 entry-shaped lines before a partial is
  kept, and because the check sits in the shared `noteRestart` branch it gates
  CARRY-FORWARD too — a contentless fragment is no longer prepended to the next
  prompt either. Regression test uses the exact string that shipped.

  **CORRECTION, from the `progress` arm:** I first read TASK_0020's 22→2 entries
  as carry's damage. It is not attributable. Progress-only produced **1 entry** on
  the same fixture with carry OFF; across five observations TASK_0020 ranges
  1-52. What survives from the carry arm is the MECHANISM — with carry on, all
  three attempts hit `exit=143` at the 240s cap where baseline's third completed
  — plus the unreplicated `Textarea`. One demonstrated harm, not two.

**THE FULL 2x2, all four cells measured:**

    arm             timeouts   wall    verdict   failed on
    baseline          4/4      576s      —       (control)
    carry only        4/4        —      FAIL     shape survived; inflation; 1 fabrication
    progress only    0/4       403s     FAIL     quality: builtins + the 1-entry outlier
    rescue (both)    0/8       448s     FAIL     quality: builtins + variance

Both timeout-fixing arms remove the fault COMPLETELY and run 20-30% faster.
Both then fail `inv-quality-not-worse`, and in both cases the break decomposes
into instrument artifacts (prose entries, `URL.createObjectURL`, `PageAssertions`)
plus fixtures whose entry counts swing 1-52. Progress-only's three breaks:
TASK_0017 signatures 34→30 (inside the 26% CV), TASK_0019 ungrounded 0→2 (both
symbols are `URL.*` builtins), TASK_0020 signatures 21→1 (the outlier above).

**Nothing ships. The instrument cannot render a verdict at this n.** The blocking
work is, in order: (1) fix the grounding corpus — prose entries, platform
builtins, parameter placeholders, and symbols the task asks the worker to CREATE
must stop counting as fabrications, and `corpus.prompt` must be the ASSEMBLED
prompt; (2) fix `witnessed` (D1: gate metrics 2-3 too; D5: count all grounding
tools, not just `pi-worker-docs`); (3) compare RATES not absolute counts (D2);
(4) raise n above the measured 26% within-fixture CV; (5) re-run. Only then is a
quality verdict on either arm worth anything.

### THE RE-RUN (n=3, fixed instrument, fresh corpus) — PROGRESS still FAILS

Blocking items (1)-(3) shipped in `72fdb52`; (4)-(5) are this run. Fresh results
dir (`AB_DIR=~/tmp/research-fanout-ab-v2`) so no trial recorded before
prompt-capture existed can contaminate it. 4 fixtures x 3 trials x 2 arms, 24
trials, all completed, none errored/quarantined. Verdict verbatim:

    fixture     arm        n  timeouts  apisWall(s)  lookups  entries  sig  ungrounded
    TASK_0017   baseline   3      3/3         507     21.0     21.7  21.0         1.0
    TASK_0017   progress   3      0/3         706     28.7     38.3  37.0         0.0
    TASK_0019   baseline   3      3/3         493     32.7     25.7  25.0         0.0
    TASK_0019   progress   3      0/3         568     41.0     32.0  31.3         0.3
    TASK_0020   baseline   3      3/3         720     51.7      9.0   8.7         0.0
    TASK_0020   progress   3      0/3         650     39.7     38.3  37.3         2.0
    TASK_0021   baseline   3      3/3         720     67.3      1.0   1.0         0.0
    TASK_0021   progress   3      0/3         510     32.3     28.7  27.3         0.3

    BASELINE  produced the shape: 12/12    TREATMENT shipped it: 0/12
    inv-quality-not-worse    BROKEN  TASK_0019 0.0%→0.8%; TASK_0020 0.0%→4.4%;
                                     TASK_0021 0.0%→0.6%
    inv-no-new-degrade       HOLDS   0 degraded trials in progress
    inv-low-fanout-untouched HOLDS   controls unchanged
    inv-wall-clock-lower     HOLDS   610s → 608s over 4 shared fixtures

    FAIL — the lever removed the shape but broke inv-quality-not-worse.

**The FAIL stands as pre-registered and the lever does not ship on it.** What
follows is diagnosis, not a re-score: no threshold was moved and no invariant was
edited after seeing these numbers.

**The fault reproduced far HARDER than in run 18.** Every baseline trial timed
out (12/12, vs 4/5 in the first replay), 8 of 12 DEGRADED, and **5 of 12 shipped
a ONE-ENTRY stub** carrying zero API symbols — TASK_0021 did it on all three
trials at 65-69 project lookups. The progress arm ran every one of those 12
trials in a SINGLE attempt with 19-56 entries.

**The quality break is a zero denominator.** Baseline's 0.0% ungrounded on
TASK_0019/0020/0021 is not a clean section; on the trials driving it there is no
section — `symbols=0`, `entries=1`. The guard compares a 28-entry answer against
a stub sentence and scores the stub as better grounded. Counting only baseline
trials that produced any symbol at all, the two arms are indistinguishable:
baseline 3/179 ungrounded symbols (1.7%), progress 8/515 (1.6%).

**Every symbol the treatment was flagged for is REAL — 12 trials, 515 symbols, 8
flags, zero fabrications.** Checked against each trial's own checkout:

  - `Textarea`, `Label`, `Badge` (TASK_0020-2) — all three files exist in that
    fixture's `src/client/components/ui/`. NOTE this is the same identifier that
    was a genuine fabrication in the carry arm: TASK_0019's fixture has no
    `Textarea.tsx`, TASK_0020's does. That earlier finding is unaffected.
  - `useLocation` (TASK_0019-1) — wouter, imported by the fixture's own
    `src/client/pages/ListingDetail.tsx:2`.
  - `$patch` (TASK_0020-1) — the Hono RPC method for
    `listings.patch('/:id', …)`, `src/server/routes/listings.ts:317`.
  - `Nav` (TASK_0020-0) — `src/client/components/Nav.tsx` exists; the rest of
    that trial's flags are playwright `locator.click` / `selectOption` /
    `setInputFiles`.
  - `writeText` (TASK_0021-0) — `navigator.clipboard.writeText`. `navigator` is
    excluded as a platform name but `writeText` is not, because PLATFORM_SYMBOLS
    is enumerated from bun's `globalThis`, which has no `clipboard`.

So the surviving flags are two known classes, both already named above: the
retrieval-gap (a real project symbol the worker knew without re-reading) and an
incomplete platform list. Neither is fabrication, which is what the guard exists
to catch.

**What is now established, and what is not.** Metric 1 is unambiguous at any n
and reproduces a second time on a fresh corpus: 12/12 → 0/12, plus 8/12 → 0/12
degraded, which the progress deadline removes by letting a provably productive
worker finish rather than killing it at 240s. The quality half is still
unrendered — the guard could not distinguish the arms here because the baseline
it measures against collapsed to empty sections, and n=3 remains under the
measured 26% within-fixture CV. Wall clock is flat (610s→608s) and should not be
read as a win either: baseline's 720s trials are pinned at the 3x240s cap, so
that column compares a truncated distribution against an untruncated one.

**Still nothing ships.** Before the progress deadline can be wired, the quality
guard needs a baseline floor that is a measurement (a degraded/zero-symbol trial
is not evidence of good grounding in either direction) and the platform channel
needs the DOM/Web surfaces bun's `globalThis` does not carry. Both are instrument
work, both are cheap, and neither may be done as part of scoring the arm they
would change.

**Both instrument fixes are now in, and the verdict did NOT move: still FAIL.**

1. `scoreQuality()` compares grounding over SCORABLE trials only (`symbols > 0`)
   and reports a fixture with none as UNSCORABLE, which now ABSTAINS the whole
   verdict via `AbSpec.unmeasured` rather than letting an unevaluated invariant
   print HOLDS. Two gaming routes are closed with it: a treatment that ships more
   empty sections than the baseline breaks the invariant outright, and signature
   coverage stays absolute over ALL trials.
2. `platformChainSymbols()` treats members reached through a platform ROOT as
   platform (`navigator.clipboard.writeText`). Rooted in the CHAIN, not a flat
   list of DOM member names — a flat list would have to include `click`, `open`,
   `remove`, `select`, and would launder a fabricated component the first time one
   collided. Playwright's `locator.selectOption` therefore stays flagged, which is
   correct: that is a package API and a retrieval gap, not a platform name.

Re-scored on the same recorded trials: TASK_0021 drops out as UNSCORABLE (0/3
baseline trials produced any symbol) and TASK_0019 + TASK_0020 still break, so
`inv-quality-not-worse` is still BROKEN and the arm is still FAIL. Note the
`ungrounded` column is baked into each trial JSON at run time, so fix 2 changes
nothing here and takes effect only on the next arm. The instrument is now honest
about what it cannot measure; it did not become friendlier to the lever.

### ROUND 2 INSTRUMENT WORK — three more false readings, all closed

All three are deterministic, re-score trials already on disk, and were written
BEFORE the n=6 arms were started. Tests: `scripts/live-research-fanout-budget-ab.test.ts`.

1. **`inv-low-fanout-untouched` reported HOLDS on ZERO control trials.** The n=3
   run never ran TASK_0001/0003/0004; the scoring loop `continue`d on each for
   want of trials, produced no breaks, and no breaks printed as "controls
   unchanged". That is the identical false pass that had just been fixed one
   metric up. `scoreLowFanout()` now reports a control fixture missing from
   either arm through `AbSpec.unmeasured`, which ABSTAINS the verdict. A control
   that RAN and broke still FAILs.
2. **The grounding corpus gained a PROJECT-SOURCE channel** — the fixture's own
   hand-authored source at the checkpoint SHA recorded in every trial JSON
   (`checkpointSourceText`, read straight out of git so a trial can be re-scored
   from its result file alone). The other four channels are RETRIEVAL channels,
   so they answer "did the worker fetch this?"; fabrication is "did the worker
   invent this?", and a symbol sitting in the project's own source was not
   invented. RETRIEVAL-GAP was recorded as a named defect class before this run,
   alongside `$delete` being flagged while sitting in the fixture's own
   `src/client/api.ts:143`.

   **The filter is the whole guard, and it is tested as such.** mx5 tracks
   `.playwright-cache/assets/*.js` — vendored minified UI bundles that contain
   `Textarea` at EVERY checkpoint. Admitting build output would ground the single
   real fabrication this experiment ever observed (carry arm, TASK_0019) and kill
   the invariant. `isProjectSourcePath` excludes build/cache/vendor/agent-owned
   paths, lockfiles, maps and `.md`, and the test asserts both directions against
   the real trees: `Textarea` absent from TASK_0019's, present in TASK_0020's.
3. **`inv-wall-clock-lower` compared censored data and is gone.** A baseline
   trial killed at 3x240s did not take 720s to answer — it never answered, and
   720s is a lower bound truncated by the cap under test. `610s → 608s HOLDS` was
   arithmetic across two scales. The raw mean is now printed as DESCRIPTIVE ONLY
   with its censoring rate, never as an invariant or a lever benefit.

   The obvious replacement is censored too, and only the v2 data showed it:
   scored as "mean over the trials that ANSWERED", baseline is represented by
   exactly the 4 of 12 trials that got there in two attempts (325-434s) while
   every trial needing a third hit 720s and answered nothing — so conditioning on
   answering selects the baseline's fastest third. Scored that way the progress
   arm, which answered 12/12, read as **390s → 637s WORSE**. `inv-time-to-answer-lower`
   is therefore evaluated only on fixtures where EVERY trial of BOTH arms
   answered, with the answer RATE printed beside it. `Invariant.unmeasured` now
   prints `NO DATA` instead of `HOLDS`, so an unevaluated side condition can no
   longer read as a satisfied one.

**Re-scored on the v2 corpus with the project-source channel** (`scripts/rescore-fanout-grounding.ts`,
no model time). It cannot reproduce the spawn-captured prompt channel, which is
in-memory only, so these bound fabrication from ABOVE:

    fixture     arm        recorded  trace-only  +projectTree  symbols
    TASK_0017   baseline        1.0         1.0           1.0     22.7
    TASK_0017   progress        0.0         0.0           0.0     44.3
    TASK_0019   baseline        0.0         0.3           0.3     27.7
    TASK_0019   progress        0.3         0.3           0.0     39.3
    TASK_0020   baseline        0.0         0.0           0.0      9.3
    TASK_0020   progress        2.0         2.7           0.7     45.0
    TASK_0021   baseline        0.0         0.0           0.0      0.0
    TASK_0021   progress        0.3         0.0           0.0     58.3

    inv-quality-not-worse    BROKEN   TASK_0020 0.0%→1.5% (0.0→0.7)
    inv-no-new-degrade       HOLDS    0 degraded trials in progress
    inv-low-fanout-untouched NO DATA  3 control fixtures were not run
    inv-time-to-answer-lower NO DATA  no fixture answered in every trial of both arms
    wall clock (descriptive) baseline 610s, 12/12 truncated, answered 4/12
                             progress 608s,  0/12 truncated, answered 12/12

    FAIL — still, on TASK_0020.

**THE VERDICT DID NOT MOVE.** The channel closed TASK_0019 (0.3→0.0) and cut
TASK_0020 by three quarters, and the arm still FAILS. What remains on TASK_0020
is `setInputFiles` (playwright `locator.setInputFiles`) and `$patch` (the Hono
RPC method) — measured against a baseline whose 0.0% comes from the ONE of three
trials that wrote a section at all.

**PACKAGE-GAP is the next named defect class, and it is NOT being fixed now.**
Both survivors are real APIs of installed dependencies that the worker did not
re-retrieve. The symmetric fix — a channel over `node_modules` — would ground
essentially any identifier, which is the same failure mode as admitting
`.playwright-cache`, and there is no observed fabrication living in a dependency
to test the filter against. Widening the corpus a second time AFTER seeing which
fixture it would rescue is tuning to the verdict, not instrument work. It is
recorded here and left open.

Instrumentation added so this stops being inferred: `onCarryForward` fires when a
carried partial is INJECTED (not merely when a restart happens — the two diverge
now that contentless partials are refused), logged as `CARRY-FORWARD injected
into attempt N (X chars onto a Y-char prompt)`, which also makes the inflation
harm directly measurable.

**Two harness gaps found DURING the rescue arm, recorded and deliberately NOT
patched mid-run** — the numbers were already visible, and a scorer edited after
seeing the numbers it would improve is not a scorer:

1. **The `witnessed` gate applies to metric 1 only.** Timeout counts are gated on
   a fixture having actually fanned out (>=10 project lookups), but wall clock and
   quality are not. TASK_0022 posed the problem in neither arm (1 lookup baseline,
   3 rescue, no timeout either side) yet still contributes to both scored means —
   396s vs 234s inflates the treatment's wall mean and 24→23 signatures registers
   as a quality break, on a lever it never exercised. Gate metrics 2 and 3 on
   `witnessed` too, then re-score from the recorded JSON (no model time needed).
2. **Quality invariants compare ABSOLUTE ungrounded counts, not rates.** A section
   that grows trips the guard even when its grounding improves: TASK_0020 went
   5/39 ungrounded (12.8%) → 4/73 (5.5%) — better on both count and rate — but a
   section that doubled while holding its rate would break the invariant purely
   for being bigger. The guard exists to catch fabrication; it should compare the
   ungrounded SHARE, with the absolute count as a secondary tripwire.

Also worth knowing when reading any verdict here: **fixture fan-out is not
deterministic.** TASK_0022 burned the full restart budget in run 18 and made ONE
project lookup on replay. At 1 trial per fixture a treatment arm can post "0
timeouts" by drawing low fan-out rather than by fixing anything, which is why the
rescue arm runs 2 trials and why the `witnessed` count, not the raw hit count, is
the number to read.

**The harness had a hole that pointed the wrong way, and it is now closed.**
llama-server died partway through the first baseline arm; the remaining six
fixtures each burned their three connection-error retries in ~46s and were
recorded as `timeouts=0 entries=0`. A dead server would therefore have scored as
this lever's strongest possible PASS — zero timeouts on every fixture — and a
partial failure was no safer: baseline TASK_0019 fanned out to 28 lookups and DID
time out, but threw afterwards and so carried `entries=0`, which would have
dropped the baseline quality floor to zero and passed `inv-quality-not-worse` for
free. A thrown trial produces no APIS section and therefore has no value for any
of the three metrics, so it is now quarantined under `results/<arm>/errored/`,
excluded from scoring, and re-run; the arm aborts outright if the server is gone.

**Do NOT build the per-file digest cache (5C) yet.** Keyed on query TEXT a cache
recovers ~3.5% on run 18 (independently reproducing the 0.7% recorded in
`scripts/live-project-docs-retrieval-ab.ts`); keyed on FILE SET it collapses 42%.
That harness poses H-cache vs H-retrieval and **has no recorded verdict**. If
retrieval is the fault, a cache memoises the bad answers.

### ROUND 3 — n=6, controls RAN, verdict FAIL and it moved to a new invariant

Corpus `~/tmp/research-fanout-ab-v3`, 42 trials per arm (7 fixtures x n=6), both
arms at `e4d4c9f`, scored by the round-2 instrument. Four trials quarantined
under `results/*/errored/` (one CUDA OOM, two `503 Loading model` off a `/health`
that lies, one mid-arm llama-server death) and re-run. **Exit 1 — FAIL.**

    fixture     arm        n  timeouts  apisWall(s)  lookups  entries  sig  ungrounded  synth
    TASK_0017   baseline   6      6/6         626     25.7     21.2  20.3         0.5    0.0
    TASK_0017   progress   6      0/6         500     22.8     36.7  35.8         0.5    0.0
    TASK_0019   baseline   6      5/6         361     29.3     26.2  26.0         0.0    0.3
    TASK_0019   progress   6      0/6         301     22.5     29.5  29.3         0.0    0.3
    TASK_0020   baseline   6      5/6         569     48.5     21.3  20.5         0.3    0.0
    TASK_0020   progress   6      0/6         420     34.3     35.0  34.7         0.3    0.0
    TASK_0021   baseline   6      6/6         652     64.8     11.0   8.3         0.8    0.0
    TASK_0021   progress   6      0/6         391     29.0     25.5  24.8         0.2    0.0
    TASK_0001   baseline   6      0/6          67      0.2      6.0   6.0         0.0    0.0   control
    TASK_0001   progress   6      0/6          51      0.0      1.8   1.7         2.0    0.0   control
    TASK_0003   baseline   6      0/6          58      0.0      6.8   6.8         0.0    0.2   control
    TASK_0003   progress   6      0/6          54      0.0      5.0   5.0         0.0    0.0   control
    TASK_0004   baseline   6      0/6         134      1.3      9.5   9.0         0.7    0.0   control
    TASK_0004   progress   6      0/6         147      1.2     10.5   9.0         2.7    0.3   control

    inv-quality-not-worse    HOLDS   signature coverage held, ungrounded rose on no
                                     high-fan-out fixture     <- was BROKEN at n=3
    inv-no-new-degrade       HOLDS   0 degraded trials in progress
    inv-low-fanout-untouched BROKEN  TASK_0001 entries 6.0→1.8; TASK_0003 6.8→5.0
    inv-time-to-answer-lower HOLDS   361s → 301s, over the 1 fixture (TASK_0019)
                                     that answered in EVERY trial of BOTH arms
    descriptive (CENSORED)   baseline 552s, 22/24 truncated, answered 16/24
                             progress 403s,  0/24 truncated, answered 24/24

**Which invariants had data, plainly:** all four. This is the first run where
`inv-low-fanout-untouched` was actually evaluated — round 2's item 1 is finished,
and the first thing it did on real data was break. That is the instrument
working, not the instrument failing.

**Metric 1 reproduced a third time: 22/24 → 0/24 witnessed timeouts.** Every
high-fan-out fixture went from mostly-or-always timing out to never. The
baseline reached a usable answer in 16/24 trials, the progress arm in 24/24.

**inv-quality-not-worse flipped BROKEN→HOLDS on more data, with no instrument
change.** The n=3 break was TASK_0020 `0.0%→1.5%`, where the baseline's 0.0%
came from the one of three trials that wrote a section at all. At n=6 the
baseline actually answers there and the comparison has two real sides:
ungrounded 0.3 vs 0.3. The n=3 FAIL on quality was a small-sample artifact of a
degenerate baseline — which is what UNSCORABLE exists to catch and did not,
because one trial did squeak through with symbols.

#### The FAIL is on a control the lever provably cannot touch

Recorded as the verdict, and NOT overturned by argument. But three facts about
it, all checked before writing this:

1. **The mechanism cannot reach these fixtures.** `progress` sets exactly one
   env var, `PI_TASK_WORKER_PROGRESS_CEILING_MS` (no carry-forward), and it
   reaches only `workerTimeout`'s abort deadline. Across all 18 control trials in
   both arms: `budgetRefusals=0`, `degraded=false`, `attempts=1`, wall 37-218s
   against a 240s per-attempt cap that was never hit. The deadline never armed,
   never fired, and can only ever push a deadline OUT. The two arms ran an
   identical code path on every one of these trials.
2. **Neither break is distinguishable from noise.** Exact permutation test on the
   difference of means, all 924 splits:

       TASK_0001  baseline 6.0 (sd 5.2, CV 87%) → 1.8   ratio 0.31   p=0.152
       TASK_0003  baseline 6.8 (sd 1.6, CV 23%) → 5.0   ratio 0.73   p=0.132
       TASK_0004  baseline 9.5 (sd 6.3, CV 66%) → 10.5  ratio 1.11   p=0.784

   Baseline TASK_0001 ran 5, 6, 15, 1, 8, 1 — it produced the same 1-entry stub
   twice in six trials on its own. `scoreLowFanout` compares raw MEANS against a
   fixed 80% floor with no variance model at all, on a metric whose within-fixture
   CV reaches 87%. It can break on a lever that did nothing.
3. **It is not the mid-arm llama-server revive.** The progress arm died after 8
   trials and was revived at 02:05. TASK_0001's first trial, recorded at 01:49
   BEFORE the revive, was already a 1-entry stub, and the stubs sit on both sides
   of it (01:49, 02:26, 03:01, 04:11, 04:37 stub; 03:33 not).

**The fix is NOT to relax `ENTRY_FLOOR`.** That threshold would be moving after
seeing the number it changes, which this file has ruled out twice. The resolution
is a NEGATIVE CONTROL: run the three control fixtures baseline-vs-baseline, n=6,
and score them through the same `scoreLowFanout`. If an entries floor breaks
between two independent samples of the SAME arm, the invariant is measuring
run-to-run variance, and that is established from data containing no treatment at
all — so it cannot be tuning to the verdict. Until that runs, the FAIL stands and
`PI_TASK_WORKER_PROGRESS_CEILING_MS` does not ship.

#### Instrument gap found while reading this verdict, pointing the OTHER way

`scoreQuality` runs over `shared = HIGH_FANOUT.filter(...)`. **Control fixtures
are never checked for fabrication at all.** This run put real numbers in that
blind spot: TASK_0001 ungrounded 0.0→2.0 and TASK_0004 0.7→2.7, neither seen by
`inv-quality-not-worse`, which reported "fabricated symbols did not rise on any
fixture" while two control fixtures had risen. Two single trials carry it
(TASK_0001-5: 1 entry, 34 symbols, 10 ungrounded; TASK_0004-3: 14 entries, 121
symbols, 14 ungrounded), so it may well be the same variance — but the guard did
not look, and "did not look" printed as "did not rise".

Recorded rather than patched mid-verdict, and noted for what it is: closing this
gap can only make the treatment look WORSE, never better, so it is the one
instrument change here that is safe to make after seeing the numbers.

#### ROUND 4 — the negative control ran. The invariant is a noise detector.

Corpus `~/tmp/research-fanout-ab-nullctl`, one `baseline` arm at n=12 over
TASK_0001/0003/0004 = 36 trials, 0 quarantined, no llama-server revive (so all
12 trials per fixture were drawn under one server state). Scored by
`scripts/lowfanout-null-control.ts` (`60c2389`), whose design was pre-registered
in its header before the corpus existed. **Exit 1.**

    924 pure-baseline 6-vs-6 splits scored (462 partitions x both orientations)
    splits with >=1 break: 419/924 = 45.3%

    276x  TASK_0001 entries …        <- every one of these is a FALSE break:
    187x  TASK_0004 entries …           both halves are the SAME arm
      1x  TASK_0003 entries …
     ~45  TASK_0001/0004 wall …s→…s  (e.g. 120s→187s, 61s→92s)

**`inv-low-fanout-untouched` breaks 45.3% of the time on data with no treatment
in it.** The round-3 FAIL is therefore uninformative about the lever — a coin
weighted 45/55 would have produced it. Both tripwires are implicated, not just
the one that fired in round 3: the `ENTRY_FLOOR` ratio dominates, and
`LOW_FANOUT_WALL_TOLERANCE = 1.5` also false-fires on TASK_0001 and TASK_0004.
The defect is structural — `scoreLowFanout` compares raw MEANS against fixed
ratios with no variance model, on count metrics whose within-fixture CV runs to
87%.

**The exit-2 on the arm was correct behaviour, not a fault.** A controls-only
arm never produces the timeout shape, so the single-arm reporter ABSTAINed rather
than reading `0/0 timeouts` as a win. The chain's revive step then fired
harmlessly against an already-healthy container and the 36/36 check let it
proceed.

**The repair, calibrated on null data only.** A directional exact permutation
test on the same 924 splits, replacing the fixed ratio:

    fixed ratio floor (shipped)                    45.3%   false-break rate
    permutation test, one-sided, p<=0.05            4.4%
    permutation test, one-sided, p<=0.01            0.9%

p<=0.05 holds its nominal size across all three fixtures. This calibration
contains **no treatment data**, which is the whole reason it is admissible after
seeing round 3 break: nothing here can be tuned toward or away from the lever's
numbers.

**What this does and does not do to the round-3 verdict.** It voids the FAIL; it
does NOT convert it to a PASS. Under the repaired rule round 3's two breaks read
p=0.152 (TASK_0001) and p=0.132 (TASK_0003) — neither significant — so a
re-score would report `inv-low-fanout-untouched HOLDS` and, with the other three
already holding, a PASS. That re-score is legitimate only because the repair was
calibrated on the independent null corpus, and it must be recorded as what it is:
a verdict rendered by an instrument repaired after the run it judges. The
honest reading is that round 3 has **no verdict on this invariant** until the
repaired scorer is wired and the v3 corpus re-scored.

#### ROUND 5 — the repaired invariant is wired, and v3 re-scores PASS

`scoreLowFanout` no longer compares means against fixed ratios. It runs a
directional exact permutation test (`permutationP`, exact to n=12 per arm,
seeded sampling above that so a re-score reports the same p). Three properties,
all measured on the null corpus and none on treatment data:

    rule                                      false-break rate on 924 null splits
    fixed ratios (ENTRY_FLOOR / 1.5x wall)                  419/924 = 45.3%
    permutation test, per-test alpha 0.05                   108/924 = 11.7%
    permutation test, Bonferroni over tests performed        14/924 =  1.5%

**The 11.7% step is the one worth remembering.** Swapping in a significance test
fixed the statistic but not the invariant: this is ONE invariant that breaks if
ANY sub-test fires, and it runs 3 fixtures x 2 metrics = 6 of them, so 0.05 per
test is not 0.05 for the invariant. Bonferroni over the tests ACTUALLY PERFORMED
(a run with fewer controls is not penalised for controls it did not run) brings
it to 1.5% — conservative, because the sub-tests are positively correlated
within a fixture.

**The correction feeds back into what counts as measurable, and that closed a
hole the first cut had.** The smallest two-sided p an exact test can report is
`2/C(nb+nt, nb)`. At n=4 that is 0.029, ABOVE the corrected 0.0083 — so a
fixed `MIN_CONTROL_N = 4` would have let three controls report HOLDS when no
arrangement of their data could ever have broken them. The floor is now computed
against the corrected alpha per run, and a fixture below it is UNMEASURED, which
abstains. With 3 controls that means n>=5.

**Power, because a guard that never fires is also useless** (same 924 splits,
regression injected into the entries of one arm):

    no regression      1.5%      <- false-positive rate
    entries at 75%    31.3%
    entries at 50%    60.6%
    entries at 25%   100.0%
    entries at 0%    100.0%

**The v3 re-score: PASS, exit 0.** All four invariants hold; metric 1 is 22/24 →
0/24. `inv-low-fanout-untouched` reads HOLDS because round 3's two breaks are
p=0.152 and p=0.132, an order of magnitude off the corrected 0.0083.

**Read it as exactly what it is.** This verdict was rendered by an instrument
repaired AFTER the run it judges. What makes that admissible rather than
verdict-shopping is that every number in the repair came from a corpus with no
treatment in it — the null control was run, and calibrated against, before the
v3 re-score was attempted. It is still weaker evidence than a PASS from an
instrument fixed beforehand, and the honest statement is: *the progress deadline
removes the timeout shape with no measured cost on any invariant this harness can
currently evaluate.* Not "the lever is validated".

Tests: `scripts/live-research-fanout-budget-ab.test.ts`, 28 cases, pinning the
p-floor derivation, the Bonferroni feedback, the calibration property, and that
round 3's control numbers were never significant. Suite 2650 pass / 1 skip / 0 fail.

#### ROUND 6 — the quality invariant had a 98.1% false-break rate

Closing the control blind spot meant measuring `scoreQuality` the same way, and
it turned out to be the worse of the two by a wide margin. Its signature clause
was `treatment mean < baseline mean` — a strict inequality with no variance
model, which is a coin flip per fixture by construction.

    scoreQuality on the null corpus, same 924 pure-baseline splits
      before   906/924 = 98.1%   (437-442 of them on the signature clause alone,
                                  per fixture, plus the ungrounded clause)
      after      3/924 =  0.3%

**Both readings matter, and they point in opposite directions.** Every BREAK
this invariant ever reported is uninformative — including the n=3 FAIL on
TASK_0020 that sent this entire investigation down the grounding-corpus path,
and which the round-2 work then "closed" by widening the corpus. But every HOLD
is strong: a guard that fires on 98% of null data and did NOT fire is saying
something real, which is why the n=6 quality HOLD survives this correction
instead of being undone by it.

Same machinery as `scoreLowFanout`: directional exact permutation test,
Bonferroni over fixtures x 3 metrics, p-floor checked against the corrected
alpha so a fixture that could never break does not report HOLDS. Power on the
same splits: 100% at a 25% signature cut, 57.1% at 50%, 100% at 6x ungrounded,
85% at 3x, and **100% when the treatment degrades to stubs**.

**Controls are now inside the invariant.** They stay excluded from metrics 2-3,
where a win measures nothing because they never posed the problem — but
collateral damage is not a benefit, and this was the one invariant that never
looked. v3 had printed "fabricated symbols did not rise on any fixture" while
TASK_0001 went 0.0→2.0 and TASK_0004 0.7→2.7.

**A bug this introduced and the tests caught, worth recording because it was
the exact hole the code already had a guard for.** Hoisting the unscorable check
into the pass that computes the correction made an all-stub treatment report
UNSCORABLE instead of breaking — reopening the gaming route the stub tripwire
exists to close. Signature coverage and the stub count are computed over ALL
trials; only grounding needs a section with symbols on both sides. Pinned by
`a treatment that ships MORE empty sections breaks the invariant`.

**v3 re-scores PASS again, exit 0**, with controls inside the quality invariant:
the two control rises are not significant. Suite 2653 pass / 1 skip / 0 fail.

#### PACKAGE-GAP — REFUTED as formulated, and superseded by an upstream defect

`scripts/package-gap-classify.ts` walks all 84 v3 trials, recomputes grounding,
and classifies every ungrounded symbol against the fixture's OWN `node_modules`
at its checkpoint by exhaustive grep. 71 occurrences, 54 distinct:

    IN-DEPS      42 distinct  — a node_modules channel WOULD ground these
                                  of which identifier-shaped:  7
                                  of which English PROSE:      35
    NOT-IN-DEPS  12 distinct  — invisible to node_modules
                                  of which identifier-shaped: 12
                                  of which English PROSE:      0

**The channel does what it was proposed to do, and it is still the wrong fix.**
It grounds `$patch` (hono `dist/types/client/types.d.ts`), `tailwindcss`,
`postcss`, `ZodObject` — real dependency APIs the worker did not re-retrieve,
exactly the RETRIEVAL-GAP argument. But 35 of the 42 symbols it grounds are
English words: `making`, `against`, `being`, `official`, `minimum`, `says`,
`modify`, `available`, `standard`, `internal`. `being` occurs in 279 files under
one fixture's `node_modules`. The debt file's prediction — "would ground
essentially any identifier" — is CONFIRMED at 78% of the residue, and 83% of
what it grounds is coincidence.

**It cannot be refuted by counterexample, and that is worth stating precisely.**
The anti-gaming test this gap was waiting for — an observed fabrication that a
node_modules channel would wrongly ground — does not exist in this corpus. All
12 NOT-IN-DEPS symbols are project-shaped invented identifiers
(`photoContentTypeAllowlist`, `ListingsQuery`, `PHOTO_CONTENT_TYPES`,
`snapshotsPathTemplate`) and dependency text does not reach any of them. So the
channel would not launder a known fabrication. It would instead mask the defect
below.

**THE ACTUAL DEFECT IS UPSTREAM: `extractSymbols` emits English prose as
symbols.** 35 of 54 distinct "ungrounded symbols" (65%) are ordinary words
lifted out of APIS prose. They inflate BOTH sides of the quality invariant —
`symbols` is its denominator and `ungroundedSymbols` its numerator — and they
are groundable by any sufficiently large text, which is the only reason a
node_modules channel looks like it helps. Adding the channel would drive the
ungrounded count down for reasons that have nothing to do with fabrication.

Named **PROSE-SYMBOLS**, and it is the next thing to fix, not the channel. Note
the split is perfectly clean in the direction that matters: every one of the 12
genuine invented identifiers is identifier-shaped, and every one of the 35 prose
tokens is not. Post-fix the residue is 19 symbols, of which the real
dependency-API cases are `$patch`, `tailwindcss`, `postcss`, `ZodObject` — at
which point PACKAGE-GAP should be re-asked against a corpus that isn't 65%
noise, rather than answered now.

**A bug in the classifier itself, caught before it was believed.** Its first cut
read `node_modules` into a string under a 60MB budget and silently truncated:
`$patch` came back NOT-IN-DEPS while sitting in hono's own type declarations —
the budget invented exactly the answer this gap had been waiting for. Replaced
with an exhaustive `grep -rhoF -f`, verified in both directions against a known
symbol and a control string that must not match.

#### Still open, and a PASS would not have closed it

`PI_TASK_WORKER_PROGRESS_CEILING_MS` ran at 1,200,000ms against a maximum
observed wall of 980s. It has never fired. An arbitrary constant that has never
fired is not shippable on a green A/B — see
`memory/fix-must-preserve-work-not-bound-it.md`. And the quality result at n=6 is
directional only: within-fixture CV for entries reaches 87% on this corpus.

---

## GRAY AREAS — carried forward, still true

- **The research cache did essentially nothing in mx5 run 18, and this is the
  fourth time that has been measured.** 151 package-scoped docs lookups, **149
  distinct** ⇒ at most 2 possible hits (1.3%), against 130 entries written. Not a
  bug and not a lead: it is the expected value on an npm stack, where the docs
  SQLite cache already serves the repeat work
  (`memory/research-cache-value-is-stack-dependent.md` — the cache is worth most
  on non-npm stacks). Recorded here so nobody measures it a fifth time.
- **`pi-worker-search` fired 3 times in 8 hours of mx5 run 18** — against 615
  `pi-worker-docs` calls and 6 `pi-worker-fetch` calls — while the run carried a
  design requirement saying "Whenever an API, signature, config, or best practice
  is unknown or unclear, use web search … before writing code".
  `memory/pi-worker-search-nudge.md` records that a trigger-framed tool
  description previously fixed exactly this skip, so the shape has moved before.
  It needs **its own base rate first** (how often is a search-worthy unknown
  present at all?) and must NOT be folded into the fan-out A/B: both levers change
  worker:apis's tool budget, and run together neither one's effect is attributable.

- The **enforce-differential attribution** filter (nexttask 4, shipped) passed its
  deterministic replay A/B (baseline = the real `HEAD:task-gates.ts`, materialised and
  imported) 1 recorded revert → 0, with the two regression fixtures and the
  unparseable-reason fixture reverting identically in both arms — but its **live arm
  FAILED its own pre-registered bar and it shipped anyway, deliberately**. Live, 20
  reps per arm against the run-18 tree with a real verify child: the *reachable* arm
  (enforce edit breaks `Admin.tsx`) named a resolvable file 20/20 and decided REVERT
  20/20; the *disjoint* arm named a file in only **9 of 20**, against a bar of ≥80%.
  The 11 misses name the UNIT rather than the file — "The MyListings component test
  … expects 4 Edit links but MOCK_LISTINGS has only 3" — no path, no extension. They
  fall through to the revert, i.e. exactly the behaviour that shipped before. The
  justification for shipping on a failed bar is that the rule is **one-sided**: 29 of
  29 extractable decisions across both arms matched ground truth, a miss costs
  nothing new, and a false KEEP would ship a real regression. Coverage is the debt,
  not correctness.
- **The run-18 flake was never reproduced.** `getByText('SOLD')` matching two elements
  is timing-dependent; on this box the tagged fixture runs 7 passed / 1.6s, 0/3 red.
  Both live arms therefore use a DETERMINISTIC stand-in (an assertion that always
  fails, placed in a file inside or outside the enforce diff as the arm requires).
  Two fixture artifacts had to be stripped before that was even measurable:
  `__screenshots__` is untracked in mx5 so `git archive` drops it, and the `screenshot
  baseline` test renders differently on this box. Neither has anything to do with
  attribution.
- **Run 14 cannot confirm this lever and never will.** Its two enforce-reverts are the
  same class, but their enforce commits were destroyed by the very reverts under
  study and `~/hub/mx5` has since been rebuilt by run 18 — no reflog holds them. The
  base rate therefore has exactly ONE incident with a recoverable enforce diff: run
  18, the incident the lever was designed on (methodology rule 2). The run-14 entries
  are reported as a conditional ("the lever keeps unless the enforce diff itself
  touched one of {test/teardown.ts, test/invite.test.ts}"), never as a flip.
- **The nexttask-4 seam analysis was half wrong, and the measurement says so.** It
  attributed run 18's failure to the authorship test ("the task touched
  `MyListings.tsx`"). It did not get that far: the FAIL text names a BARE
  `MyListings.spec.tsx:186`, and `findAccusedFile` requires a path separator, so the
  root-cause channel returned null at the extractor. `T ∩ F` is also empty
  (`MyListings.tsx` ≠ `MyListings.spec.tsx`), so with a working extractor even the
  OLD `scope: 'committed'` would have kept. The scope fix still matters for the
  general class — a FAIL naming a file the TASK touched but the ENFORCE COMMIT did
  not — but it is not what broke run 18. Both halves are now fixed.

- The **generated-HTML asset closure** (nexttask 3, shipped) passed its A/B 1/1 → 0/1
  with six invariants holding, and its base rate is honest but *thin*: across 7 trees
  the whole corpus contains **2** generated-HTML asset references, both in one file
  (`mx5@a9c6145 build.ts`) — 1 produced, 1 dev-only. Every other tree is a structural
  zero, not a passing test: none of them generates HTML into a build outdir at all, so
  the FP arms prove the *gate* (a literal must reach a write into a declared build
  outdir) and prove nothing about the *resolution rule*. The dev-only rule's
  discrimination is argued from two fixtures — one where the producer carries
  `--watch`, one where it does not — plus mx5. One real tree again.
- The generated-HTML scan is **literal-only, one file at a time**: an HTML template
  assembled from several bindings, returned by a function, imported from another
  module, or written through a variable destination is invisible. Every one of those
  errs toward silence. It also only ever fires *inside* a directory some build tool
  declared as its output (`ProducedOutputs.outdirs`); a page written to an
  undeclared directory is out of scope by construction, which is what keeps the
  `mailTemplate.ts`-shaped email bodies out.
- **`/main.js` in mx5 run 18 is unreachable and no checker sees it.** The generated
  page is served by a single catch-all `app.get('*')` returning `dist/index.html` as
  `text/html`, with **no static-asset route**, so both `/main.js` and any CSS URL
  resolve to the HTML document. Artifact closure correctly calls `/main.js` *produced*
  — it is — and cannot reason about route tables. This belongs to the **serve-entry
  checker (nexttask 2B)**, extended to assert that a tree with an SPA catch-all also
  mounts a static handler. It is deliberately NOT folded into artifact-closure.
- The **boot-skip → UNOBSERVED** lever (mx5 run 18, shipped) passed its A/B 2/11 → 0/11
  with all four invariants holding, but its **generality is unproven**: of 10 trees in
  the STEP 0 corpus a boot command was discovered AND skipped in 4, still yielded a bare
  PASS in 2, and was a *served* app in exactly **1** — mx5. Zero non-mx5 real trees
  exhibit the shape (aiz-server's boot really runs and FAILs; aiz-client is
  `expectServer false`; pi-task, gofer, IAR1 and godot-engine have no boot command at
  all). The zero-FP arms are broad (17 local repos, 0 findings) so the blast radius is
  known to be small — two trees on this box — but "this fires on projects other than
  mx5" is not evidence anyone has.
- The **non-launch boot command** rejection (nexttask 2A, shipped) passed its A/B 2/14
  → 0/14 with three invariants holding, but only **one of its two rules is validated on
  real code**. The container-orchestration rule fires on exactly one real tree (mx5) and
  one fixture; the *multiplexer-of-asset-watchers* rule fires on **no real tree at all**
  — `fx-watchers-only` is its only evidence, so that half is a fixture-only argument.
  Six of the box's repos declare `start`/`dev` and five are plain launches
  (`vite`, `nodemon`, `node dist/…`, `bun --watch`), which is why the invariants are
  cheap to hold.
- 2A **retires the real-tree arm of `scripts/boot-skip-verdict-ab.ts`**: mx5's boot
  command is now `null` (measured — `scripts/serve-entry-baserate.ts` prints it), so the
  boot-skip shape can no longer be produced there and that harness's mx5 arms will
  abstain. Its four fixture arms still exercise the lever end to end (re-run 2026-07-30:
  1/4 → 0/4, all four invariants holding). A served app whose only launch script is
  rejected now reports its own UNOBSERVED note (`rejectedLaunchScript`) so the rejection
  cannot trade an unfalsifiable skip for pure silence.
- The 2A A/B measures mx5's baseline boot **under the dockerless shim**, so its outcome
  is `skip` by construction. The docker-HAVING branch was deliberately **not** measured:
  running `docker compose up` in a clone would start real containers on this box. So
  "no tree OBSERVED to boot lost its command" is exactly as strong as it sounds — no
  tree was observed to boot. The substantive argument that nothing was lost is 2B's:
  mx5 has no bind anywhere, so no member of that chain could have served.
- The **serve-entry** check (nexttask 2B, shipped) has the same generality gap as the
  boot-skip lever: base rate `builds-an-app && !has-a-bind` is **2/9 trees, both of them
  mx5 revisions** (`scripts/serve-entry-baserate.ts`), and the FP arms are 4 real repos
  + 5 synthetic negatives at zero. It is a true positive reproduced twice, not a
  population.
- Known blind spots of the serve-entry checker, by construction: it reads **JS/TS only**
  (a Go/Python server in the same tree is invisible); constructions come from a fixed
  framework allowlist (Hono/Elysia/Koa/oak/express/fastify/polka) — a bespoke
  `http.createServer` app never registers as building one, though that shape carries its
  own bind; `.listen(` is matched loosely on purpose, so **one** `.listen(` anywhere in
  authored source silences the whole tree; and a framework-launcher dependency
  (next/nuxt/nest/wrangler/…) stands the check down **wholesale**, so a Next project
  with a broken custom server is not examined at all. Every one of those errs toward
  silence, which is the direction chosen deliberately.
- The mx5 run-18 tree needs **two disclosed environment adjustments** to reproduce its
  PASS here, both in the clone and neither touching the boot section:
  `docker`/`docker-compose` shimmed to exit 127 (this box HAS docker; run 18's sandbox
  did not, which is why its boot skipped), and the Playwright CT screenshot baselines
  re-captured (this box renders those pages 3px taller, so 8 of 51 CT tests fail on font
  metrics alone). Without the second, mx5 gates FAIL here and the target shape does not
  appear on the real tree at all. mx5 also carries a **known-flaky CT test** (its own
  TASK_0024 debt), so a single mx5 gate verdict is not repeatable — treat the fixture
  arm, not the mx5 arm, as the deterministic one.
- Running these harnesses executes mx5's own `seed`/`migrate` against the **live local
  `mx5` Postgres container**. Idempotent, and the same thing run 18 did, but it is a
  write outside the clone.

- `EMPTY_PLAN_RETRIES = 2` is a judgement call, not a measurement. The empty path
  is unit-tested only; empties cannot be forced live (0 empty draws in 28 reps).
- `MIN_REQUIREMENTS_FOR_PLAN_SHAPE (=5)` was validated for the plan-shape fork,
  **not** for the granularity floor. Reusing it there is an argument from the same
  rationale, not evidence.
- The tiebreak's plan-size benefit is **not** significant on mx5 (41.8→38.8,
  p=0.21); it is on the toolchain fixture (39.9→21.1, 9/0/7, p=0.0039). Always
  quote the fixture with the number.
- The marked/rest layering in `capRequirements` is **insurance, not a measured mx5
  win** — exactly one distinct quote per pool is both low-value and marked. It
  matters for specs whose obligations are short ("MUST log every request", which
  every length rule reads as a fragment). Do not cite it as why tail coverage
  holds.
- `scripts/fixtures/toolchain-spec.md` is **engineered** and says so in its own
  header. It is a fair test of *whether a rule survives different phrasing*; it is
  not evidence about how real specs are distributed. Its extraction is also nearly
  deterministic (yield sd 0.87 vs mx5's 34.3), so 30 runs there is closer to one
  run reproduced 30 times — trust the direction and effect size, not the p-value.
- The extraction-lottery metric is a **hand-authored critical list**. Displacement
  of obligations *outside* that list is invisible to the harness.
- The `47..153` pre-cap yield range in `extraction-stability-step0.ts` is still
  **overstated** — it unions the forced re-extraction. Clean single-pass figures
  are 20..160 and 21..150. That script's instrumentation still needs fixing.
- Two pre-existing bonus-round tests were **edited, not the code**, when the floor
  gate changed their decompose counts 5→4.
- The mx5 run in `~/hub/mx5` that started this investigation ran under the **old
  planner** and is not evidence for or against any of this.

## ENVIRONMENT

llama-server at `127.0.0.1:8080` (`curl -s 127.0.0.1:8080/health` →
`{"status":"ok"}`), started with `run-Q3.6-27B.sh`. Do **not** use `-b 512
-ub 256` — it corrupts parallel tool calls. Every harness needs `PI_BIN`:

    PI_BIN=$(command -v pi) bun run scripts/<harness>.ts <args>

Run harnesses **one at a time**; they share the one server. Costs: ~74-100s per
single extraction call on a 20KB spec, ~1.5 min/rep for a 30-rep extraction pool,
~1.5 min/rep for the toolchain A/B with lockstep sharing.
