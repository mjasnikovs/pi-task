NEXTTASK — validation debt after the 2026-07-29 session
=======================================================

WHAT CLOSED THIS SESSION (both were TASK 1 and TASK 2 of the previous list)

  TASK 1 — C GENERALITY: CLOSED, PASSED.
    The zero-gain tiebreak now reproduces off mx5. New fixture
    scripts/fixtures/toolchain-spec.md (ENGINEERED, labelled as such in its own
    header): non-web Rust AOT compiler + toolchain, 10KB, 12 named subsystems,
    40 grounded requirements / 37 ownable.
      16 reps (pre-registered N): baseline 9/16 -> C 0/16, Fisher p=0.0008
      12 reps (earlier, separate run): baseline 5/12 -> C 0/12, p=0.0373
      all three invariants hold in both; COVERAGE IDENTICAL (37.00 vs 37.00)
      plan size: baseline mean 39.9 / median 48 -> C mean 21.1 / median 15,
                 sign test 9 smaller / 0 larger / 7 tied, p=0.0039
    The 16-rep run was run CLEAN, not topped up from the 12 — adding reps after
    seeing p=0.0373 would have been optional stopping.

  TASK 2 — FILTER SIGNIFICANCE: CLOSED, SHIPPED (see "what shipped" below).

WHAT SHIPPED (uncommitted at time of writing — src + tests + harnesses)
  src/task/requirements.ts
    - isLowValueQuote(): the 4 measured junk shapes (truncated mid-expression,
      length-gated dependency pin, schema/DDL row, fragment).
    - budgetedByObligation(): deprioritises them INSIDE capRequirements, applied
      to the UNMARKED remainder only, and only as far as the 40-slot budget
      requires.
  src/task/requirements.test.ts — FP suite (verbatim pool quotes) + 5 behaviour
    tests. Full suite 2500 tests green, lint clean.

  DEVIATION FROM THE OLD PLAN, on purpose: the old note said to ship this in
  keepGroundedRequirements. It went into capRequirements instead.
  keepGroundedRequirements is the anti-synthesis grounding guard and must not
  silently delete; allocating a bounded budget is the cap's job.

------------------------------------------------------------------------------
METHODOLOGY BUGS FOUND — these cost real time, do not re-learn them
------------------------------------------------------------------------------
  a) A POOLED FP SUITE IS NOT AN ADMISSIBILITY TEST. The old suite asked whether
     some quote carrying an obligation survives anywhere in the 237-quote pool.
     The cap runs PER RUN. Argon2id has three carriers pooled — two prose, one
     DDL row — so the pooled check passed on the prose while the one run that
     extracted only the DDL row lost the obligation outright. The per-run check
     is now in scripts/extraction-filter-score.ts and it is the one that counts.
  b) THE MEASUREMENT POOLS LIVED IN A SESSION SCRATCHPAD and were deleted with
     the session. They are now repo-local and gitignored under .measure/, and
     extraction-precision-step0.ts takes a TAG so a confirmation pool sits beside
     its design pool instead of overwriting it.
  c) DESIGNING A RULE WHILE LOOKING AT A POOL DISQUALIFIES THAT POOL. The budget
     clause was written after seeing the Argon2id loss, so a second independent
     30-run pool was drawn to confirm it. Do this again for any selection change.
  d) `bun test` CONCURRENTLY WITH A MODEL HARNESS gives a false failure:
     src/task/real-pi.smoke.test.ts spawns real pi (3-10s/call normally) and hit
     its 120s timeout under llama-server contention. It passes in 9.85s on a free
     server. Run the suite when nothing else is using the server.

------------------------------------------------------------------------------
TASK 1 (was TASK 3) — THE REQUIREMENT-EXTRACTION LOTTERY (still the big one)
------------------------------------------------------------------------------
STATUS: PARTIALLY ADDRESSED. The selection half moved; the extraction half has
not. This is still the highest-leverage open item.

WHAT IS NOW MEASURED (two INDEPENDENT 30-run pools, byte-identical 20402-char
mx5 spec; both in .measure/, regenerate with extraction-precision-step0.ts)
    pool A: yield 20..160, mean 73.5, sd 34.3, 237 distinct quotes
    pool B: yield 21..150, mean 84.0, sd 36.5, 238 distinct quotes
  Critical obligations (of 16) reaching the shipped 40:
    pool A  baseline 8.50 -> 9.37 shipped rule  (10 better / 0 worse, p=0.0020)
    pool B  baseline 7.70 -> 8.43 shipped rule  (12 better / 0 worse, p=0.0005)
  So the shipped filter is real but SMALL: roughly half the critical obligations
  STILL never reach requirements.md. The lottery is not fixed.

NEW FINDINGS FROM THIS SESSION — use these, they cost 2 hours of model time
  - THE MARKED-PASSAGE PRIORITY MECHANISM IS THIN. Quotes covering an enumerated
    obligation-marked passage are min 0 / median 1 / max 8 per run across 60 runs.
    One protected quote in a shipped 40. Any design that leans on it is leaning
    on almost nothing.
  - `marked.slice(0, MAX_REQUIREMENTS)` IS NOT A LATENT RUN-16 DEFECT. It is a
    first-N truncation and looked like one, but marked never exceeds 40 in 60
    runs (max 8), so it never truncates. REFUTED — do not re-investigate.
  - TAIL-SECTION COVERAGE IS LOW FOR EVERYONE. Of the doc's last 4 sections, the
    shipped 40 touches 1.20 (pool A) / 1.33 (pool B) — in the BASELINE arm too.
    sectionFairFill stops a section being wholesale dropped; it does not get the
    tail properly represented. This is an unexamined lead and it is exactly where
    mx5 keeps its testing obligations.
  - The absolute (non-budgeted) filter scored marginally higher on raw count
    (24 gains vs 22 across both pools) and was rejected anyway: its extra gains
    are one more obligation in an already-populated list, its one loss is an
    obligation vanishing from a run entirely. Not the same size of mistake.

STILL RULED OUT — DO NOT RE-PROPOSE
  LEXICAL OBLIGATION RANKING (OBLIGATION_RE or any stricter modal subset of it) —
  refuted 2026-07-29, see "what was tried" below; harmful on a second spec.
  k-of-n VOTING across passes. Any threshold >=5 keeps all 37 schema rows and
  DELETES the test-cadence line and the "non-/api GETs serve the built
  index.html" clause — the two whose loss has already cost a run each.

WHAT WAS TRIED — OBLIGATION_RE AS A RANKING KEY: REFUTED 2026-07-29. DO NOT
RE-PROPOSE. It PASSES the pass condition below and is still WRONG; that is the
point of this entry.
  The candidate was the one named here last session: promote OBLIGATION_RE from a
  measurement proxy to a ranking key inside sectionFairFill's IN-BUCKET order
  (section fairness untouched, obligating sentences preferred within a section).
  Scored offline, no model calls, on both 30-run mx5 pools —
  scripts/obligation-rank-endtoend.ts (transcribes the cap so an unshipped
  variant needs no production seam, and PROVES the transcription against the real
  capRequirements on every run before printing a number).

    mx5 pool A  9.37 -> 10.77 of 16  (15 better / 0 worse / 15 tied, p=0.0001)
    mx5 pool B  8.43 -> 10.27 of 16  (19 better / 0 worse / 11 tied, p<0.0001)
    tail-section coverage unchanged on both, 0 regressions.

  That is a bigger win than the shipped low-value filter, on both pools, with
  zero losses. It is an ARTIFACT. Two independent checks killed it:

  1. MECHANISM (scripts/obligation-rank-diagnose.ts). OBLIGATION_RE contains bare
     `no|not|only|always|every|each|min|max`. Of mx5's 16 critical obligations only
     ONE is modal-grounded; SIX fire ACCIDENTAL-ONLY — `no-explicit-any` matches
     \bno\b inside the LINT RULE'S OWN NAME, `password_hash text not null` matches
     `not`, `printWidth 120` rides "no semicolons". The key was promoting the right
     quotes for a reason that has nothing to do with obligation.
  2. GENERALITY (30-run pool on scripts/fixtures/toolchain-spec.md, criticals
     PRE-REGISTERED in scripts/fixtures/toolchain-critical.json before the pool was
     drawn). THE SIGN REVERSES:
       toolchain  23.77 -> 21.70 of 31  (0 better / 30 WORSE / 0 tied, p<0.0001)
     It loses "LLVM is explicitly out of scope", "preserves trivia", "ELF, Mach-O
     and COFF", "one version per package", "machine-readable JSON output". 17 of
     that fixture's 31 criticals NEVER fire the key and 10 more fire
     accidental-only. Real obligations are frequently DECLARATIVE ("The parser
     produces a lossless concrete syntax tree") and carry no modal at all, so a
     modal-keyed ranking demotes them beneath prose containing "every"/"only".

  A MODAL-ONLY variant (bare non-modals struck out) was also pre-registered and is
  INERT, for a structural reason worth keeping: quotes lying inside a
  "must"/"required" paragraph are ALREADY protected by capRequirements' marked
  bypass (pooled, only 61/2206 and 78/2520 entries), so the fill only ever ranks
  the ~98% that carry no such marker — and MODAL_ONLY fires on just 8% of those.
    mx5 A +0.37 (9/0/21, p=0.0039)   mx5 B +0.30 (6/0/24, p=0.0313)
    toolchain +0.00 (0 better / 0 worse / 30 TIED — literally no effect)
  Not worth shipping: it buys ~0.3 of an obligation on one spec and nothing on
  another, for a permanent ranking rule.

  THE REAL LESSON, and it outranks the result: LEXICAL OBLIGATION-DETECTION IS THE
  DEAD END, not this particular regex. Both variants are the same idea at two
  strictnesses; one is harmful and one is inert. Anything shaped like "rank quotes
  by whether they contain obligation words" should be considered answered. If the
  positive-ranking slot is attacked again it needs a signal that is not the
  sentence's own vocabulary — e.g. structural position within its section, or an
  actual model judgement per quote (which costs calls and re-opens the stochastic
  channel this whole line of work is trying to escape).

PASS CONDITION FOR ANY SELECTION FIX — NOW REQUIRES GENERALITY. The old condition
was mx5-only and this candidate PASSED IT AT p=0.0001 WHILE BEING HARMFUL. Both
pools are the same 20KB web spec; two pools give you sampling robustness and tell
you NOTHING about a second document.
  Critical obligations reaching the shipped 40 must rise with ZERO per-run losses
  AND tail-section coverage must not regress, ON BOTH mx5 POOLS **AND** ON A
  SECOND, DIFFERENTLY-PHRASED SPEC. mx5 numbers come from
  scripts/extraction-filter-endtoend.ts <pool.json>; the second-spec pool is drawn
  with SPEC_PATH=<spec> ...extraction-precision-step0.ts 30 <tag> (the toolchain
  pool already exists at .measure/extraction-pool-toolchain.json, ~35 min to
  redraw) and scored via the --spec/--critical/--pools flags on
  scripts/obligation-rank-endtoend.ts. Its critical list must be written BEFORE
  the pool is drawn and must deliberately include DECLARATIVE obligations, which
  is exactly what mx5's list under-represents.
  The harness ABSTAINS when the cap engages in under half the runs — below 40
  entries nothing is contested and a selection rule cannot be measured at all.

------------------------------------------------------------------------------
TASK 2 (was TASK 4) — THE COVERAGE LOOP'S SPLIT-BRAIN GATE
------------------------------------------------------------------------------
STATUS: OPEN, still deferred, but NO LONGER HARD TO REPRODUCE.

THE DEFECT (unchanged)
  The loop's CONTINUE condition and its ADOPT condition read different signals:
    continue: best.plan.missing.length === 0   (holistic judge free-text +
              unmapped requirement quotes + dangling artifacts)
    adopt:    droppedCoverage over the deterministic groundedCoverage set
  Nothing forces a retry to address what the judge flagged, and the judge
  regenerates its list from scratch each round.

NEW: THE TOOLCHAIN FIXTURE REPRODUCES IT ON DEMAND
  In the 16-rep run, round 0 reached the coverage CEILING (37/37) in nearly every
  rep while the judge returned INCOMPLETE in 9/16 — that is the split brain,
  visible directly, with the deterministic channel pinned at maximum. Any
  redesign of what the gate reads can now be A/B'd against this fixture instead
  of against a 20KB web spec where the two channels move together.

WHY IT WAS BLOCKED, AND WHETHER IT STILL IS
  The old reason was that the requirement channel is only 38-42% reproducible.
  That is still true. But the toolchain fixture decouples the question: its
  requirement channel saturates, so the judge channel can be studied alone.
  Judgement call for whoever picks this up — the blocker is weaker than it was.

WHEN UNBLOCKED, THE QUESTION IS
  Should the loop continue on the stochastic judge channel at all, or only on the
  deterministic unmapped-requirement channel? The judge channel is what catches
  areas the extractor MISSED, so deleting it trades one blindness for another.
  Measure before choosing.

------------------------------------------------------------------------------
HARNESS CHANGES MADE THIS SESSION (so nobody re-derives them)
------------------------------------------------------------------------------
  scripts/live-coverage-adoption-ab.ts
    - takes a NAMED FIXTURE: 'mx5' or the stem of scripts/fixtures/<stem>-spec.md
      (was a hardcoded etl/mx5 toggle).
    - `probe` mode runs the BASELINE ARM ONLY and reports whether the fixture
      produces the target shape at all. A fixture that cannot make the baseline
      misbehave makes the full A/B ABSTAIN; find that out for half a rep.
    - runs both arms IN LOCKSTEP, sharing one candidate draw while the arms hold
      the SAME plan and drawing separately the moment they diverge. This is a
      pairing, not the replay the file header rejects: a shared draw is only ever
      used where both arms would have issued a byte-identical prompt.
    - reports Fisher two-sided on the target-shape table (verified: it reproduces
      the recorded 7/24 vs 0/24 -> p=0.0094 exactly).
  scripts/extraction-filter-endtoend.ts
    - three arms (baseline / absolute / budgeted), per-run sign tests, and
      TAIL-SECTION COVERAGE, which is the constraint a ranking change breaks.
    - takes a pool path argument.
    - baseline arm calls capRequirements(..., deprioritiseLowValue=false), an A/B
      seam on the shipped function, so the score cannot drift from production.
      The seam is the only reason there is no transcribed copy of sectionFairFill.

------------------------------------------------------------------------------
GRAY AREAS — carried forward, still true
------------------------------------------------------------------------------
  a) EMPTY_PLAN_RETRIES = 2 is a JUDGEMENT CALL, not a measurement. The empty
     path is unit-tested only; empties cannot be forced live. (0 empty draws in
     28 reps this session, so it stayed unexercised again.)
  b) MIN_REQUIREMENTS_FOR_PLAN_SHAPE (=5) was validated for the plan-shape fork,
     NOT for the granularity floor. Reusing it there is an argument from the same
     rationale, not evidence.
  c) The plan-size benefit of the tiebreak was NOT significant on mx5 (41.8 ->
     38.8, p=0.21). It IS significant on the toolchain fixture (39.9 -> 21.1,
     sign test 9/0/7, p=0.0039). Quote the fixture with the number.
  d) Two pre-existing bonus-round tests were EDITED, not the code, when the floor
     gate changed their decompose counts 5 -> 4.
  e) Per-rep comparison of ANY model-sampled quantity between DIVERGENT arms
     measures the sampler, not the rule. Only distributional comparisons and
     rule-fired subsets are valid. Lockstep sharing (above) narrows but does not
     remove this.
  f) The 47..153 pre-cap yield range in extraction-stability-step0.ts is still
     OVERSTATED — it unions the forced re-extraction. The clean single-pass
     figures are 20..160 and 21..150 (extraction-precision-step0.ts, 30 reps
     each). That script still needs its instrumentation fixed.
  g) The mx5 run in ~/hub/mx5 that started this investigation ran under the OLD
     planner and is not evidence for or against any of this.
  h) NEW — the marked/rest layering in capRequirements is INSURANCE, not a
     measured mx5 win: exactly one distinct quote per pool is both low-value and
     marked, and it is genuinely truncated. It matters for specs whose
     obligations are SHORT ("MUST log every request", 22 chars, which every
     length rule reads as a fragment). Do NOT cite it as the reason tail coverage
     holds — tail coverage is identical with the filter applied before the split.

ENVIRONMENT (unchanged)
  llama-server at 127.0.0.1:8080 (curl -s 127.0.0.1:8080/health -> {"status":"ok"}),
  started with run-Q3.6-27B.sh. Do NOT use `-b 512 -ub 256` — it corrupts parallel
  tool calls. Every harness needs PI_BIN:
      PI_BIN=$(command -v pi) bun run scripts/<harness>.ts <args>
  Run harnesses ONE AT A TIME; they share the one server.
  Measured this session: ~74-100s per single extraction call (20KB spec),
  ~1.5 min/rep for the 30-rep extraction pool, ~1.5 min/rep for the toolchain A/B
  with lockstep sharing (16 reps in 24 min — far cheaper than the old estimate).
