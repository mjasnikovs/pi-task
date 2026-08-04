# nexttask 6 — open defects are dropped on a converged autofix, so the run ends with no recovery path

**Priority P1.** This is the mechanism behind the run's final message: four
verify-FAIL defects reported as STILL UNRESOLVED, immediately followed by
`complete — all 24 tasks done`, with no picker, no exit-code change, and no code
path that could ever clear them.

---

## EVIDENCE (mx5 run 18)

Terminal output, in order:

    Warning: TASK_AUTO_0001: 4 recorded verify-FAIL defect(s) are STILL unresolved
             at run end — see the gate trail.
    TASK_AUTO_0001 complete — all 24 tasks done.

Gate trail (`.pi-tasks/TASK_AUTO_0001.md`), also in order:

    14:58:29.150  final-gate: FAIL — 4 failures (ranked, most load-bearing first)
    14:58:29.153  defect STILL OPEN — TASK_0007: …
    14:58:29.153  defect STILL OPEN — TASK_0008: …
    14:58:29.154  defect STILL OPEN — TASK_0019: …
    14:58:29.154  defect STILL OPEN — TASK_0024: …
    14:58:29.155  final-gate: auto-chose AUTOFIX (YOLO)
    15:03:16.153  final-gate: autofix converged — … passed

Every `defect STILL OPEN` line is stamped **14:58:29**, i.e. from the gate run
that happened **before** the autofix. Nothing re-evaluated them at 15:03.

**Current truth of those four, checked against `~/hub/mx5` HEAD today:**

| defect | still real? | evidence |
|---|---|---|
| TASK_0007 `sql.unsafe()` ×3 | **YES** | `src/server/routes/listings.ts:139,142,388` |
| TASK_0008 VERIFY path mismatch | **YES** | spec runs `src/server/routes/listings.test.ts`; file is at `test/listings.test.ts` |
| TASK_0019 constraint violation | historical | already-shipped edit to `src/server/index.ts` |
| TASK_0024 enforce-revert | **NO — already fixed** | the same autofix commit `a9c6145` added the `.first()` that fixes it (see nexttask 4) |

So one of the four was fixed by the very autofix that ran after the warning, and
still reported STILL OPEN. Two remain real and got no channel.

## SEAM (exact)

`src/task/auto-orchestrator.ts:1622-1633` — the debts are surfaced from the
**first** gate result:

    if (fin.openDebts && fin.openDebts.length > 0) {
        for (const d of fin.openDebts) { await recGate(`defect STILL OPEN — …`) }
        active.ui.notify(`${id}: ${fin.openDebts.length} recorded verify-FAIL defect(s)
                          are STILL unresolved at run end — see the gate trail.`, 'warning')
    }

`src/task/auto-orchestrator.ts:1802` — the converged autofix rebuilds `fin`
**without** them:

    fin = {ok: true, reason: fix.reason}
    break

`openDebts` is `FinalGateResult.openDebts` (`src/task/final-gate.ts:110`,
populated at `:1214-1222`). The resolution picker is `while (!fin.ok)`
(`auto-orchestrator.ts:1695`), and the debts are informational by design — the
comment at `:1616-1620` says so explicitly: *"Informational: the per-task ACCEPT
was already a human decision, so this reports, it does not re-fail."*

Consequence: the debts can never make `fin.ok` false, and after convergence they
are not merely un-actioned — **they are gone from the value**. There is no code
path that can clear, re-check, or act on them.

## LEVER — two parts. Part 1 is not optional; part 2 is a decision to be measured.

**6A — carry and recompute (mechanical, no policy change).**
Preserve `openDebts` across the converged path and re-derive them against the
post-autofix tree, then re-emit the trail lines and the notify from the **final**
state, not the first. Reuse the existing derivation
(`final-gate.ts:1214`, `annotateDebtConflicts` + `taskThatIntroduced`) — that is
already the "did a later task fix this?" machinery
(`memory/accept-debt-recheck-b3.md`); it simply is not re-run here.

Expected effect on run 18: `4 STILL OPEN` becomes `2 STILL OPEN`, and the two
survivors are both genuinely present in HEAD.

**6B — give the survivors somewhere to go (needs a measured decision).**
Today a surviving debt is a warning and nothing else. The options, in ascending
order of intrusiveness:

  (i) keep it informational, but make the *run outcome* say so — the run
      completes, and its terminal summary names them;
  (ii) route each surviving debt through the existing
       `recordRepairCandidate` / root-cause repair channel
       (`src/task/root-cause-repair.ts`) so the next run schedules a scoped
       repair task;
  (iii) re-offer the final-gate picker (Leave / Autofix / Accept) once for
        surviving debts even when `fin.ok`.

**Do not pick by argument.** (iii) risks an unbounded loop in unattended mode
and contradicts the YOLO comment at `auto-orchestrator.ts:1717-1723` ("Never
'accept'"). (ii) is the shape the codebase already uses elsewhere. Measure.

## STEP 0 — base rate, BEFORE any change

`scripts/open-debt-lifecycle-baserate.ts`. Over every recorded run with an
`accept-debt.md` (run 18 at `~/hub/mx5/.pi-tasks/accept-debt.md`, plus any
retained earlier trees), for each recorded debt determine mechanically:

    recorded at        task id + timestamp
    still true at HEAD yes / no / undecidable
    class              static (grep-checkable) | dynamic | prose-only

Run 18's ground truth is in the table above: 2 yes, 1 historical, 1 no.
**Report the fraction of debts that were already fixed by the time the run
ended.** That fraction is exactly what 6A recovers, and it is the number that
justifies (or does not justify) 6B.

## A/B — required, deterministic

### `scripts/open-debt-recompute-ab.ts` (for 6A)

    baseline   auto-orchestrator's converged path as shipped (openDebts dropped)
    treatment  openDebts carried + re-derived against the post-autofix tree

Driven by replaying run 18's recorded gate sequence with `deps.finalGateFix`
stubbed to the recorded converged outcome, against the tagged revisions
`evidence/run18-task24` (pre) and `evidence/run18-final-autofix` (post) from
nexttask 4.

Pre-registered metric: the **set** of debt ids reported STILL OPEN at run end.

    PASS     baseline reports the 4-element set; treatment reports exactly
             {TASK_0007, TASK_0008} (+ TASK_0019 if it is judged still true —
             fix the expectation in the script, not at review time);
             AND no debt that is still true at HEAD is dropped.        exit 0
    FAIL     treatment drops a still-true debt, or keeps a fixed one.  exit 1
    ABSTAIN  no recorded run has a converged autofix with open debts.  exit 2

Invariants:
- `inv-no-false-clear` — a debt whose text is not mechanically checkable
  (prose-only) is **never** auto-cleared. Unfalsifiable ⇒ stays open. This
  mirrors `memory/final-gate-nonprogress-and-partial-commit.md`.
- `inv-fail-path-unchanged` — when the gate does NOT converge, the reporting is
  byte-identical to today.
- `inv-no-new-block` — the run still completes. 6A must not turn a completing
  run into a blocked one; that is 6B's question, not this one.

### `scripts/open-debt-routing-ab.ts` (for 6B, only after 6A is green)

Arms are options (i) vs (ii) above. Metric: does a surviving debt appear as a
scheduled repair task in the next run's plan, and does that run close it?
Requires two chained runs per arm — expensive. Do not start it until STEP 0 says
how many debts actually survive.

## GRAY AREAS — closed here

- *"Should surviving debts fail the run?"* — **Not decided by this task, and not
  by opinion.** 6B measures it. Until then the run still completes; only the
  accounting is corrected.
- *"Is re-deriving a debt safe?"* — Only for mechanically checkable ones. The
  `inv-no-false-clear` invariant is the boundary and is non-negotiable: silently
  clearing an unverifiable debt is strictly worse than the current behaviour.
- *"The warning fired before the autofix — is that just a display-order bug?"* —
  **No.** It is a value-lifetime bug: line 1802 discards the field. Reordering
  the notify without carrying `openDebts` would report the stale set from a later
  line, which is the same defect with better timestamps.

## ENVIRONMENT

Deterministic. No llama-server, no `PI_BIN`. Needs the git tags created in
nexttask 4 step minus-one.

    bun run scripts/open-debt-lifecycle-baserate.ts
    bun run scripts/open-debt-recompute-ab.ts
