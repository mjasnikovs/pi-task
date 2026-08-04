# nexttask 1 — a SKIPPED boot check must be a verdict, not a silence

**Priority P0.** This is the single defect that let mx5 run 18 ship an app with no
HTTP server behind a converged final gate.

---

## EVIDENCE (mx5 run 18, `~/hub/mx5`, 2026-07-30, READ-ONLY)

The gate trail in `.pi-tasks/TASK_AUTO_0001.md` ends:

    2026-07-30T15:03:16.153Z final-gate: autofix converged — statics +
      `bun install --frozen-lockfile --dry-run`, `bun run test`, `bun run test:ct`,
      `bun run build`, `bun run lint`, `bun run seed`, `bun run migrate` passed

No boot command appears in that list. The app it blessed:

    $ cd ~/hub/mx5 && DATABASE_URL=postgres://x:x@127.0.0.1:5432/x \
        timeout 15 bun run src/server/index.ts ; echo "EXIT=$?"
    EXIT=0            # exits immediately — no listener, ever

`src/server/index.ts` ends at `export {app}`. There is no `Bun.serve`, no
`export default app`, no `serve()`, and no `start` script in `package.json`.
The product cannot be started at all. 24/24 tasks green, gate PASS.

## SEAM (exact)

`src/task/final-gate.ts:1382`

    if (b.outcome !== 'skip') dynObserved += 1
    else if (b.spawnFailed) dynSpawnFailures += 1

A boot `skip` contributes **nothing** to `dynObserved`. The full-skip blindness
guard at `final-gate.ts:1406` (`observabilityGapFailure`) only fires when
`observed === 0` across *all* dynamic commands. In run 18 `bun run test`,
`bun run test:ct`, `bun run build`, `bun run lint`, `bun run seed` and
`bun run migrate` all ran, so `dynObserved > 0` and the guard stayed quiet.

Consequence: **"the app was never observed to boot" and "the app booted fine"
produce byte-identical gate output.** That is the same class of defect
`scripts/ab-verdict.ts` was written to kill one layer up — absence of evidence
rendered in the shape of evidence.

## WHY THE BOOT SKIPPED (validated, needed for nexttask 2 — not for this one)

`discoverBootCommand` (`final-gate.ts:266`) resolves `start` → `dev`. There is no
`start`, so it returned `bun run dev`, whose body is
`docker compose -f docker-compose.dev.yml up -d && until … pg_isready …`.
Docker is absent in the gate sandbox, so the command fell into the env-gap /
exit-127 branch (`final-gate.ts:1030-1035`) → `skip`. **This task does not
change that resolution** (nexttask 2 does). This task only makes the skip loud.

## LEVER

A discovered-but-skipped boot command becomes a third outcome that:

1. sets `unobserved` on the `FinalGateResult` (the field already exists,
   `final-gate.ts:110-119`, and already drives the UNOBSERVED warning +
   `recordFinalGateUnobservedDebt` in `auto-orchestrator.ts:1600-1610`);
2. names itself in the reason string, so the trail reads
   `boot check: \`bun run dev\` NEVER RAN (env gap) — the app was not observed to start`;
3. is **not** cancellable by unit/component tests. `dynObserved` from non-boot
   commands must not suppress it.

Do **not** make it a hard FAIL. A boot skip on a docker-less box is a real
environment gap, and turning it into FAIL re-creates the run-16 mistake in the
other direction. UNOBSERVED is the correct verdict and already blocks nothing
while being loud and durable.

## STEP 0 — base rate, BEFORE any code change

Required by methodology rule "measure the base rate BEFORE"
(`VALIDATION-DEBT.md`, and `memory/prompt2-typeonly-baserate.md`).

Build `scripts/boot-skip-baserate.ts`. For each recorded evidence tree, run the
**shipped** `runFinalGate` with real `discoverBootCommand` and record:

    boot command discovered?   yes/no
    boot outcome               pass | fail | skip | orphan-port
    dynObserved (non-boot)     n
    gate verdict               PASS | UNOBSERVED | FAIL

Corpus (all present locally, all READ-ONLY):

    ~/hub/mx5                     run 18 tree @ HEAD a9c6145   → expect skip + PASS  (the defect)
    ~/hub/mx5 @ 4880e79           run 18 pre-autofix           → expect skip + FAIL(4)
    the pi-task repo itself       no start/dev script          → expect "nothing to boot"
    aiz-server, aiz-client, gofer real local repos             → record whatever happens

**Report the fraction of trees where a boot command was discovered and skipped
while the gate still returned PASS.** If that fraction is 0 outside mx5, say so
in the writeup — the lever is then mx5-shaped and its generality is unproven,
which is a finding, not a blocker.

## A/B — required, deterministic (no model in the loop)

`scripts/boot-skip-verdict-ab.ts`, arms in one process over the same corpus:

    baseline   runFinalGate with final-gate.ts EXACTLY as shipped today
    treatment  runFinalGate with the skip→UNOBSERVED lever

Metric, **pre-registered, mechanical**: for each tree, the tuple
`(verdict, reason contains the boot label, unobserved set)`. The lever's target
shape is *a tree where the boot command was discovered, skipped, and the gate
returned a bare PASS*.

Use `reportAb` from `scripts/ab-verdict.ts`. Verdicts:

    PASS     baseline produced ≥1 bare-PASS-with-skipped-boot; treatment produced 0,
             AND every invariant below held.                          exit 0
    FAIL     treatment still produced ≥1.                             exit 1
    ABSTAIN  baseline produced 0 — the corpus never exercises the lever.
             Do NOT wire. Extend the corpus first.                    exit 2

**Invariants (all must hold, all reported):**

- `inv-no-new-fail` — no tree moves PASS→FAIL or UNOBSERVED→FAIL. This lever
  must never block a run.
- `inv-boot-pass-untouched` — every tree whose boot outcome is `pass` keeps a
  byte-identical verdict and reason.
- `inv-nothing-to-boot` — a tree with **no** boot command discovered (`null`)
  keeps its current verdict. "Nothing to boot" ≠ "boot not observed"; a library
  or CLI-less repo must not start emitting UNOBSERVED.
- `inv-cli-unaffected` — `expectServer === false` trees are unchanged.

## ZERO-FP REQUIREMENT

Before wiring, `inv-nothing-to-boot` and `inv-cli-unaffected` must be green on
**pi-task itself** and on at least two non-mx5 local repos. Model the suite on
`scripts/dangling-artifact-fp-suite.ts` (same arms shape: real trees, expected
zero findings, any hit is an extractor bug not an excuse).

## WIRE ONLY ON PASS

On PASS: land the lever, add unit coverage in `src/task/final-gate.test.ts` for
`(discovered, skip)` → `unobserved` set and reason mentions the label, and add
the harness name to the file header. On ABSTAIN or FAIL: do not wire, record the
outcome in `VALIDATION-DEBT.md` under OPEN with the numbers.

## GRAY AREAS — explicitly closed here, do not re-open silently

- *"Should a skipped boot FAIL instead?"* — **No.** Decided above with a reason
  (run-16 direction). If someone wants FAIL, that is a separate A/B with its own
  base rate, not a variation of this one.
- *"Is `spawnFailed` enough to distinguish?"* — **No.** Run 18's skip came from
  the ENV_GAP_OUTPUT_RE branch at `final-gate.ts:1034`, which returns
  `spawnFailed: false`. Both skip flavours must set `unobserved`.
- *"Does `bun run test:ct` count as observing the app?"* — **No, and this is the
  trap.** Playwright CT mounts *components* in a browser; it never assembles or
  starts the server. Run 18 had 51 CT tests green and no server. The lever must
  not treat CT as boot evidence.

## ENVIRONMENT

Deterministic — no llama-server, no `PI_BIN`. Run with

    bun run scripts/boot-skip-baserate.ts
    bun run scripts/boot-skip-verdict-ab.ts

Never run `bun test` while any model harness is running elsewhere
(`src/task/real-pi.smoke.test.ts` spawns real pi).
