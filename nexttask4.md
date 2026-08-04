# nexttask 4 — the enforce differential attributes failures to the TASK's files, not to the ENFORCE diff

**Priority P1.** Cost in run 18: one correct change reverted, one permanent
false verify-FAIL defect written against work that was fine, and the identical
change re-made by the final gate five minutes later.

---

## ⚠ STEP MINUS-ONE — PRESERVE THE EVIDENCE BEFORE ANYTHING ELSE

The reverted commit is reachable **only from the reflog** and will be garbage
collected. Do this first:

    cd ~/hub/mx5
    git tag evidence/run18-enforce-revert ee65661
    git tag evidence/run18-task24        4880e79
    git tag evidence/run18-final-autofix a9c6145

Verify: `git show evidence/run18-enforce-revert --stat` must list
`.pi-tasks/TASK_0024.md` and `src/client/pages/Admin.tsx`. Every harness below
depends on those three revisions existing.

## EVIDENCE (mx5 run 18, measured)

The reverted enforce commit `ee65661`, in full, minus the task-file bookkeeping:

    diff --git a/src/client/pages/Admin.tsx b/src/client/pages/Admin.tsx
    @@ -84,7 +84,7 @@
    -                    setApiError((usersData).error ?? 'Failed to load users')
    +                    setApiError(usersData.error ?? 'Failed to load users')

One line. Redundant parentheses removed. It was reverted because the re-verify
reported `MyListings.spec.tsx:186` failing.

**`Admin.tsx` cannot reach that test.** The CT import graph is
`MyListings.stories.tsx → MyListings.tsx → {react, wouter, ../api, ../components/Nav,
../components/PartCard}`. `Nav.tsx` contains the *string* `"Admin"` twice as a
link label; it imports nothing from `Admin.tsx`. Playwright CT bundles per story.

The verifier said so itself, in the trail (`.pi-tasks/verify-debug.log`, 14:57:38):

    bash: cd /workspace && git diff HEAD~1 -- src/client/pages/MyListings.tsx \
            src/client/pages/MyListings.spec.tsx
    ↳ bash [ok]: (no output)

and wrote the verdict as *"a **pre-existing** flaky locator collision … this test
file was NOT modified b[y this task]"*. The differential reverted anyway.

**The failure was real, and pre-existing.** The final-gate autofix fixed it 5
minutes later (`git show a9c6145 -- src/client/pages/MyListings.spec.tsx`):

    -    await expect(component.getByText('SOLD', {exact: true})).toBeVisible()
    +    // Use .first() because MOCK_LISTINGS already has one sold listing
    +    await expect(component.getByText('SOLD', {exact: true}).first()).toBeVisible()

MOCK_LISTINGS already contains one `status: 'sold'` row, so after clicking
"Mark as Sold" two elements match and strict mode throws. Timing-dependent: the
same suite ran `51 passed` at 14:52:54 and 14:53:08 on the same code.

And the same autofix commit **re-applied the identical `Admin.tsx` paren
change**. The run reverted a good change and then made it again.

Cost recorded permanently in `.pi-tasks/accept-debt.md`:

    TASK_0024  work did not verify: 1 of 51 Playwright CT tests fails … however,
               this test file was NOT modified b…            enforce-revert

which is 1 of the 4 "STILL unresolved at run end" defects the run ended on.

## SEAM (exact — the mechanism already exists and was asked the wrong question)

`src/task/task-gates.ts:809`

    const rootCause = after.ok ? null : await routeRootCause(afterReason, '', 'committed')

`routeRootCause` (`task-gates.ts:365-393`) builds its candidate with

    touched: await deps.touchedFiles(p.cwd, scope)      // scope = 'committed'

`scope: 'committed'` is **the task's own commit**. Run 18's TASK_0024 commit
(`git show --stat 4880e79 -- src/`) touched 9 files including
`src/client/pages/MyListings.tsx` (66 lines). So `findRepairCandidate` correctly
concluded "this task touched the file", declined the KEEP path, and fell through
to the conservative revert at `task-gates.ts:820`. **The mechanism worked as
documented. The question was wrong.**

At this seam the differential is deciding whether to discard the **enforce
commit**. The causal question is therefore *"could the enforce diff have caused
this?"* — not *"could the task have?"*. The enforce pass touched exactly
`src/client/pages/Admin.tsx`.

## LEVER

At the enforce differential only (`task-gates.ts:809`), attribute against the
**enforce commit's** file set:

    const enforceTouched = await deps.touchedFiles(p.cwd, 'enforce-commit')

and add a **pre-filter before the revert**: if the failing check's named file(s)
are disjoint from the enforce diff, do not revert — keep the edits and route the
defect (the existing `recordRootCauseDebt` + `recordRepairCandidate` path).

Do **not** touch the `scope: 'worktree'` call at `task-gates.ts:581`; that one is
about the task's own verify and its current question is correct.

Optional second gate, only if the file-set filter proves insufficient in STEP 0:
re-run the failing check against the pre-enforce tree and revert only if it
passes there (a two-sided differential). Costs one extra check run per enforce
FAIL. Do not build it until the numbers say the cheap filter is not enough.

## STEP 0 — base rate, BEFORE the change

`scripts/enforce-revert-attribution-baserate.ts`. Replay every recorded
enforce-revert across the evidence you have — run 18 (`~/hub/mx5/.pi-tasks`),
and run 14's two reverts, which are already documented in
`task-gates.ts:797-806` as the same class. For each, record:

    enforce diff file set        E
    failing check's named files  F
    task commit file set         T
    E ∩ F empty?                 (→ the lever would have KEPT)
    T ∩ F empty?                 (→ shipped code would have kept)
    was it actually reverted?

**Report how many historical reverts the lever would flip, and how many it would
wrongly keep.** A lever that flips 1 of 1 is a lever measured on its own design
sample — say so, and treat run 14 as the independent confirmation pool
(methodology rule 2: designing a rule while looking at a pool disqualifies that
pool).

## A/B — required. Two harnesses; the second is the one that matters.

### `scripts/enforce-revert-attribution-replay-ab.ts` (deterministic)

Replay the recorded incidents through the real `task-gates` enforce block with
`deps.verify` stubbed to the **recorded** verdict text.

    baseline   task-gates.ts as shipped
    treatment  attribution against the enforce diff

Metric, pre-registered: `(reverted?, debt recorded?, repair queued?)` per
incident. Target shape: *a revert whose failing file is disjoint from the enforce
diff*.

    PASS     baseline reverts ≥1 disjoint-file incident; treatment reverts 0 of them,
             AND reverts every non-disjoint incident exactly as before.  exit 0
    FAIL     treatment keeps a revert it should have dropped, or drops one it
             should have kept.                                           exit 1
    ABSTAIN  no recorded incident has a disjoint file set.               exit 2

Invariants:
- `inv-real-regression-still-reverts` — a synthetic incident where the enforce
  diff DOES touch the failing file still reverts. Two fixtures minimum.
- `inv-unparseable-reason-reverts` — when no file can be extracted from the
  failure text, fall through to revert (the conservative pre-existing behaviour
  documented at `task-gates.ts:800-806`). Never keep on ignorance.
- `inv-debt-still-recorded` — on the new KEEP path the defect is still written
  to `accept-debt.md` and a repair task is still queued. Keeping the edits must
  not mean losing the finding — that was mx5 run 5's mistake
  (`task-gates.ts:770-781`).

### `scripts/live-enforce-attribution-ab.ts` (model in the loop) — REQUIRED

The replay uses recorded verdict text. Whether a *live* verifier names the file
precisely enough for extraction is a separate, model-dependent question, and
`memory/prompt4-spec-urls-failed.md` is the standing lesson that delivery alone
proves nothing.

Fixture: a repo at `evidence/run18-task24` plus a synthetic enforce edit
confined to `Admin.tsx`, with the pre-`.first()` `MyListings.spec.tsx` restored.
Run the real verify child; per trial record whether the reason text names a file
the extractor can resolve.

    PASS     ≥ 80% of trials over ≥ 20 reps yield an extractable file name,
             and the lever's decision matches ground truth in every extractable trial.
    FAIL     below that.
    ABSTAIN  the fixture does not reproduce the CT failure in the baseline arm
             (it is timing-dependent — see below).

**The fixture is timing-dependent and may not fail on demand.** In this
investigation the test passed 10/10 in isolation and 6/6 in the full suite on a
different box. If the baseline arm cannot make it fail, ABSTAIN and instead
construct a *deterministic* stand-in: any check that fails on a file the enforce
diff does not touch. Say clearly in the writeup that the flake itself was not
reproduced.

## GRAY AREAS — closed here

- *"Add flake tolerance — retry the failing test N times."* — **Rejected as the
  primary lever.** It papers over attribution with statistics and would have
  hidden the genuinely broken assertion (`getByText('SOLD')` matching two
  elements is a real bug, which the final gate correctly fixed). Attribution is
  the root fix; retries are a point fix
  (`memory/prefer-root-fix-over-point-fix.md`).
- *"The verifier called it 'pre-existing' — just trust that phrase."* —
  **Rejected.** That is a model self-report, and the house rule is that the
  differential is the arbiter, never the child's claim
  (`final-gate-fix.ts:15`). Use the diff, which is mechanical.
- *"Was the CT failure real or a flake?"* — **Real, and pre-existing.** Settled
  above by the autofix diff. Do not re-litigate.
- *"Should the KEEP path also cover `scope: 'worktree'` at line 581?"* —
  **No.** Out of scope, different question, different arms.

## ENVIRONMENT

Replay harness: deterministic, no `PI_BIN`.
Live harness: llama-server at `127.0.0.1:8080`
(`curl -s 127.0.0.1:8080/health` → `{"status":"ok"}`), started with
`run-Q3.6-27B.sh`; never `-b 512 -ub 256`
(`memory/parallel2-kv-tool-call-corruption.md`). One harness at a time.

    bun run scripts/enforce-revert-attribution-baserate.ts
    bun run scripts/enforce-revert-attribution-replay-ab.ts
    PI_BIN=$(command -v pi) bun run scripts/live-enforce-attribution-ab.ts <arm> [TRIALS]
