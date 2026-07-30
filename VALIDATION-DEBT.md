# VALIDATION DEBT

**What this file is.** The planner's research ledger: leads that have been
**refuted** (so nobody spends a day re-proposing them), items still **open**, the
**pass condition** any fix has to clear, and the **environment** the harnesses
need. It is not a to-do list — the entries that cost the most are the dead ends.

Formerly `nexttask.txt`; code comments citing "nexttask TASK n" mean this file.
Details of anything shipped live in git history and in each script's own header,
not here. Last updated 2026-07-30.

---

## RULED OUT — do not re-propose

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

---

## GRAY AREAS — carried forward, still true

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
