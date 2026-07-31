# Resume prompt — nexttask 5 A/B re-run

Paste the block below into a fresh session once the run has had ~4 hours.
Everything it needs is on disk; nothing depends on the previous session.

---

Read `VALIDATION-DEBT.md` section `## OPEN — 3. worker:apis project-source
fan-out (nexttask 5B)` first — it holds the full history and the reasoning. Then
finish the nexttask-5 A/B re-run.

**State when this was written**

- Branch `nexttask5-research-restart-visibility`, everything committed and
  pushed (`f675e3b` 5A + measurement, `72fdb52` instrument fixes).
- `dist/` is built from that branch. All levers are env-gated OFF by default.
- A re-run is in flight in a FRESH results dir:
  `AB_DIR=/home/edgars/tmp/research-fanout-ab-v2`
  - baseline n=3 on TASK_0017/0019/0020/0021 → `~/tmp/rerun-baseline.log`
  - progress n=3, auto-chained by `~/tmp/chain-progress.sh` → `~/tmp/rerun-progress.log`

**What to do**

1. Check both arms finished: 12 baseline + 12 progress JSON files under
   `$AB_DIR/results/`. Fewer means the arm aborted (llama-server died) — re-run
   that arm rather than scoring partial data; recorded trials are skipped so it
   resumes where it stopped.
2. Score it:
   ```
   AB_DIR=/home/edgars/tmp/research-fanout-ab-v2 \
     bun run scripts/live-research-fanout-budget-ab.ts score progress
   ```
3. Record the verdict verbatim in `VALIDATION-DEBT.md` OPEN-3 and update
   `memory/rescue-arm-failed-grounding.md`.
4. Run `bun test` — ONLY once no harness is running
   (`src/task/real-pi.smoke.test.ts` spawns real pi).

**Rules that must not be broken**

- `AB_DIR` must be set on every command. The default dir
  (`~/tmp/research-fanout-ab`) holds trials recorded BEFORE prompt-capture
  existed. Mixing the two corpora invalidates the comparison.
- Do NOT rebuild `dist/` while an arm is running — pi children load the docs
  extension from it at spawn time.
- Do NOT re-tune an invariant to make an arm pass. Every instrument change so
  far was justified by inspecting the flagged symbols and finding them real; a
  threshold moved after seeing the number it would change is not a verdict.
- **Carry-forward must NOT ship.** Measured harmful on its own: it prepends up
  to 24,000 chars to a prompt that must still fit the same 240s cap, and
  TASK_0020 hit `exit=143` on all three attempts where baseline's third
  completed. It never fired at all in the `rescue` arm (`attempts=1` ×8), so
  that arm's clean result credited a mechanism that never ran. Only the PROGRESS
  DEADLINE is a ship candidate.
- Nothing is published. The shippable piece is 5A's restart visibility; the
  fan-out fix is not validated.

**What a PASS would and would not mean**

n=3 against a measured 26% within-fixture CV is thin. Metric 1 (timeouts) is
unambiguous at any n — baseline was 4/4, progress 0/4. A quality result at n=3
is directional, not conclusive; say so rather than rounding it up to proof.
