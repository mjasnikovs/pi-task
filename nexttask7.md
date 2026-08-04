# nexttask 7 — the owned-requirement channel DELIVERED and the requirement was still lost

**Priority P2 by ordering, P0 by consequence.** This is the compose-time root
cause of nexttask 1 and 2. It is also a *repeat*: the same design clause was lost
in mx5 run 16, a lever was built and A/B'd for it, the lever now demonstrably
works — and the clause was lost again by a different mechanism.

---

## EVIDENCE

**The clause.** `~/hub/mx5/DESIGN/PROJECT.md:285`:

    **Server:** `bun run --watch src/server/index.ts` — serves `/api` + static `dist/`.

**Run 16 lost it by dropping it.** Documented verbatim in the header of
`scripts/live-owned-requirement-compose-ab.ts`: *"TASK_0008's pipeline SAW the
clause (its grill question quotes it verbatim) and the composed spec still
shipped without it — narrowed to 'SPA fallback serves index.html' — so the
server never served the client bundle and the app was permanently blank behind a
green run."* The fix — `buildOwnedRequirementsBlock`, written to
`requirements-owned.md` at plan time — was A/B'd on the metric *"does the
composed spec's CONSTRAINTS+ACCEPTANCE carry the clause"* and wired.

**Run 18: the lever worked.** `.pi-tasks/requirements-owned.md:21` carries it,
and `.pi-tasks/TASK_0023.md` CONSTRAINTS carries it **verbatim and marked
authoritative**:

    - "**Server:** `bun run --watch src/server/index.ts` — serves `/api` + static `dist/`."
      [9. Build & run] — owned requirement from the source design
      (AUTHORITATIVE; satisfy it in this task, do not narrow it)

**And the requirement was still not met.** From the same composed spec:

    CONSTRAINTS
      - Do not modify `docker-compose.dev.yml`, `.env.example`, `build.ts`,
        `tsconfig.json`, `eslint.config.js`, or any source files outside of `package.json`.
      - The server watch command must match the contract exactly:
        `bun run --watch src/server/index.ts`.
    ACCEPTANCE
      - `package.json` contains a new `dev` script that starts Postgres, waits …
      - No files other than `package.json` are modified.
    VERIFY:
      node -e "… if (!s.dev) process.exit(1) …"          # greps package.json
      node -e "… if (!s.includes('bun run --watch src/server/index.ts')) …"

The behavioural clause *"serves `/api` + static `dist/`"* was converted into a
**string-match on `package.json`**, and the only file that could implement it —
`src/server/index.ts` — was simultaneously **frozen**. The requirement was
structurally unsatisfiable inside its owning task.

`TASK_0023 verify: PASS` is therefore honest: the spec's own VERIFY block does
exactly what it says. The shipped result is proven in nexttask 2:
`bun run src/server/index.ts` exits 0 with no listener and no static route.

**Two runs, one clause, two different loss mechanisms. The delivery metric
passed and the outcome did not change.** This is `memory/prompt4-spec-urls-failed.md`
("instruction alone doesn't move termination") restated one level up: *delivery
of an authoritative requirement is not satisfaction of it.*

## SEAM

`src/task/frozen-conflict.ts` is the existing detector for exactly this shape —
"an UNSATISFIABLE spec pair at compose time". It did not fire here, for two
identifiable reasons, both visible in its own header:

1. **The freeze is a CATEGORY, not a named path.** The detector's statement side
   requires `pathNamedIn(...)` (`frozen-conflict.ts`, imported from
   `frozen-path-guard.ts`). Run 18's freeze says *"or any source files outside of
   `package.json`"* — it names no path, so `src/server/index.ts` is never matched.
2. **The statement side must match one of four measured phrasing families** —
   passive registration ("must also be included"), unless-added ("won't be
   type-checked unless added"), directional active ("requires adding … to"), and
   prose surrender ("will not be covered … since `X` is not modified"). A plain
   behavioural claim — *"serves `/api` + static `dist/`"* — matches none of them.

## LEVER — a fifth statement family, tightly scoped

An **owned requirement** whose named path falls inside a **category freeze** in
the same spec is an unsatisfiable pair, and the finding is forced into the
critique rewrite exactly as the existing four families are.

Why this is high-precision by construction:
- owned-requirement lines are **machine-marked** already
  (`buildOwnedRequirementsBlock` emits the `AUTHORITATIVE; satisfy it in this
  task, do not narrow it` tail), so the statement side needs no NLP;
- the requirement text names its path literally (`src/server/index.ts`);
- category freezes are a small closed lexical set — *"any source files outside
  of X"*, *"any files other than X"*, *"only X may be modified"*, *"no files
  outside X"*.

Resolution shapes the rewrite must produce (mirroring the existing detector's
contract): either **grant scoped ownership** (`MAY edit \`src/server/index.ts\`
ONLY to satisfy the owned requirement`) or **reassign** the requirement to a task
that can edit the file. Never a prose surrender.

## STEP 0 — base rate, BEFORE the change

`scripts/owned-vs-freeze-baserate.ts`. Over every recorded composed spec you
have — run 18's 24 in `~/hub/mx5/.pi-tasks/TASK_00*.md`, plus run 16's if
retained — count:

    specs carrying ≥1 owned requirement                       N
    of those, specs with a CATEGORY freeze                    n1
    of those, owned requirement names a path inside it        n2   ← the target shape
    of those, was the requirement actually met in HEAD?       n3

Report n2 and n3 explicitly. Run 18's known member is TASK_0023. **If n2 == 1,
say so: the rule is then designed on a single instance and its generality is
unproven** (methodology rule 2 in `VALIDATION-DEBT.md`: designing a rule while
looking at a pool disqualifies that pool). Draw run 16's specs as the independent
confirmation pool, or ABSTAIN and record it.

## A/B — required. Two harnesses; both must pass before wiring.

### `scripts/owned-freeze-conflict-fp-suite.ts` (deterministic, precision)

Model on the FP discipline already used for `frozen-conflict` ("FP-swept over
the 26 real mx5 run-12 specs") and on `scripts/dangling-artifact-fp-suite.ts`.

    arm 1  all 24 run-18 specs + all retained run-12/16 specs
           → expected findings: ONLY TASK_0023 (plus any confirmed by STEP 0)
    arm 2  hand-built negatives that must NOT fire:
           - a SCOPED freeze ("MAY edit `X` ONLY to register …") + owned requirement
           - an owned requirement whose path is NOT inside the freeze category
           - a category freeze with no owned requirement at all
           - an owned requirement that is itself prohibition-shaped

    PASS     arm 1 == expected set exactly AND arm 2 == 0 findings.  exit 0
    FAIL     any extra or missing finding.                            exit 1
    ABSTAIN  spec corpus unavailable.                                 exit 2

### `scripts/live-owned-freeze-conflict-ab.ts` (model in the loop) — the real test

Follow `scripts/live-frozen-conflict-ab.ts` exactly, including its
**controlled critique-seam** pair of modes, because compose does not reliably
echo the pair into the draft:

    baseline            real phaseCompose + critique flow WITHOUT the new probe
    treatment           real phaseCompose + real phaseCritique WITH the probe
    critique-baseline   draft FIXED to run 18's TASK_0023 spec verbatim → old flow
    critique-treatment  same fixed draft → probe-forced rewrite

**Metric — pre-registered, and deliberately NOT a delivery metric.** The run-16
lever already proved delivery. Score the *satisfiability* of the delivered spec,
mechanically:

  M1 `pair-present` — does the final spec still carry (category freeze ∧ owned
     requirement naming a path inside it)? Deterministic, via the new detector.
  M2 `resolution-shape` — when resolved: scoped-ownership grant, or requirement
     reassigned, or (failure) prose surrender / requirement dropped.
  M3 **`verify-can-fail`** — does the spec's VERIFY block contain at least one
     command that could observe the owned requirement's *behaviour*, as opposed
     to only asserting the presence of a string in a config file? Run 18's
     TASK_0023 VERIFY scores 0 here and that is the whole defect. Implement M3
     with the existing instruments: `src/task/verify-quality.ts`
     (`findGrepOnlyVerify`) and `src/task/substitution-probe.ts`.

    PASS     baseline carries the pair in ≥ 1/3 of trials; treatment drives
             pair-present to 0; AND M2 is never prose-surrender or requirement-dropped;
             AND M3 strictly improves (more trials with a behavioural VERIFY).  exit 0
    FAIL     any of those.                                                       exit 1
    ABSTAIN  baseline never carries the pair — nothing to remove.                exit 2

≥ 20 trials per arm. Use `reportArm` from `scripts/ab-verdict.ts` (one arm per
invocation; ABSTAIN exits 2).

Invariant `inv-no-spec-inflation`: treatment specs must not grow the frozen-path
list or the task's file scope beyond what the resolution needs. Compare
CONSTRAINTS line counts distributionally, not per-rep
(`VALIDATION-DEBT.md` methodology rule 4).

## GRAY AREAS — closed here

- *"Just stop freezing files."* — **No.** The freeze is what stopped run 12's
  cross-task damage and what `frozen-path-guard.ts` enforces. The defect is a
  freeze **and** an owned requirement that needs the frozen file, in the same
  spec. Resolve the pair; do not remove the mechanism.
- *"The owned-requirement A/B already passed, so the channel is fine."* — It
  passed on a **delivery** metric. Run 18 shows delivery at 100% and satisfaction
  at 0%. Update that harness's header to say so, so the next reader does not
  treat its PASS as covering this.
- *"Is `TASK_0023 verify: PASS` a verify-gate defect?"* — **No.** The VERIFY
  block does exactly what it claims. The defect is upstream, in what compose
  wrote. M3 is what makes a grep-only VERIFY for a behavioural requirement
  visible, and it belongs to this task.
- *"Could the final gate have caught it instead?"* — Yes, and that is nexttask 1
  and 2. They are the backstop; this is the cause. **Land 1 and 2 first** — they
  are deterministic and cheap, and they convert this class from silent to loud
  regardless of whether this compose-time lever ever passes.

## ENVIRONMENT

FP suite: deterministic. Live A/B: llama-server at `127.0.0.1:8080`
(`curl -s 127.0.0.1:8080/health` → `{"status":"ok"}`), `run-Q3.6-27B.sh`, never
`-b 512 -ub 256`. One harness at a time. Never run `bun test` while a harness
runs.

    bun run scripts/owned-vs-freeze-baserate.ts
    bun run scripts/owned-freeze-conflict-fp-suite.ts
    PI_BIN=$(command -v pi) bun run scripts/live-owned-freeze-conflict-ab.ts <arm> [TRIALS]

Cost reference from `VALIDATION-DEBT.md`: ~1.5 min/rep for a compose/critique A/B
with lockstep sharing ⇒ budget ~1 h per arm for 20 trials.
