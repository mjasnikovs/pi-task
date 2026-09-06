# Step 0 — arm the keep-alive before anything else

Paste this as your first action, and nothing before it. It is mandatory, not
optional. It arms the keep-alive AND starts the work, so it is the only thing you
need to paste.

```
/loop 10m Read NEXT-SESSION-PROMPT.md and DOC_REGRESSINONS.md, then continue the docs loop. Work "The work, in order" top down, measure each item with the cheapest instrument that can move it, fix, measure again, record the number in DOC_REGRESSINONS.md. Do not stop when an item closes — start the next one. Do not ask whether to continue. Stop only when the user says stop.
```

Every 10 minutes it re-enters the loop, so a session that would have halted between
items carries on instead. The rule below says never stop; this is what enforces it.
Without it the rule is a wish.

**The `/loop` is a tool call, not a preamble.** The 2026-09-06 session read this
line, started the work, and never armed the timer — the text reads like context, so
schedule it FIRST and only then read anything.

It is session-only and expires after 7 days. Arm it again in the next session.

---

Now keep improving the docs tool. Read `DOC_REGRESSINONS.md`, all of it. None of it
needs re-deriving.

**This is a standing loop.** Measure, fix, measure, fix, and keep going. Finishing
an item is the signal to start the next one, not a place to stop and report. Do
not ask whether to continue. **Stop only when the user says stop.** Ask only if a
preflight fails or something is genuinely ambiguous. The full rule, including what
to do when "Still open" empties, is the loop section of `DOC_REGRESSINONS.md`.

## Do not start with a live run

The docs worker is a **subagent**. `docsLookup` is a function of (chunks, query)
that spawns one `--no-tools` child, so almost everything open is reachable in
minutes instead of four hours.

```
docsRaw(pkg, query, cwd)  ->  chunks          retrieval half
docsLookup(chunks, query) ->  answer          extraction half, one child
```

A full `/task-auto` run is a **discovery** instrument. It found all fifteen
defects and that job is done. What is left is **verification**, and the live run
is bad at it: 158 recorded query/module pairs over four runs, 158 of them
distinct, so two arms are never compared on the same stimulus. Its headline
number has already failed once — hs abstention went 55%, 80%, 83%, 46% across
four runs with fixes between each, and the tool was not why.

`scripts/docs-replay.ts` is the instrument for verification. 73 recorded records
carry `retrievedText` and a matching `contentSha256`, so it replays the real
prompt with no retrieval and no network.

```bash
PI_BIN=$(command -v pi) bun scripts/docs-replay.ts \
  live-docs-rerun2-2026-09-06/*.jsonl live-docs-rerun3-2026-09-06/*.jsonl \
  --only abstained --out /tmp/ledger.jsonl
```

Always `--dry-run` first. It rebuilds every prompt and sends nothing — 48 for
the abstentions above, 146 for the whole corpus.

**Run it against the same model the recording used.** The record pins the prompt.
It does not pin the model, and a host model is not the container's.

## The work, in order — and when it runs out, go back to the top of the loop

Defects 15, 12, 11 and the aeson duplicates all closed in the 2026-09-06 session
and shipped as **0.40.8**. Their numbers are in `DOC_REGRESSINONS.md`; none of
them needs re-deriving and none needs a live run.

1. **Defect 14 — refine's constraint beats research's refutation.** The chain is
   read and written down, STEP 0 is measured, and the lever is chosen. Build it.
   - The base rate is **3 fires in 13,428 task files, 3 of 3 true, 0 false**. The
     detector and the one pattern the measurement *removed* are both recorded in
     `DOC_REGRESSINONS.md`. Do not re-derive it; `/home/edgars/hub` and
     `/home/edgars/tmp` hold the 14,171 files if you want to re-run it.
   - The fix is a **sibling pass** to `src/task/refuted-constraint.ts`, not a
     widening of it. That file's own header says why its token class is narrow,
     and one of the two real cases is an un-backticked API expression it refuses
     on purpose. Read the header before touching it.
   - Two real strings to write the failing test against, both quoted in
     `DOC_REGRESSINONS.md`: ts/TASK_0001's `z.string().email()` inside an
     `(e.g. …)`, and hs/TASK_0001's backticked `` `wai-test` ``. The first drops
     to `` `adminEmail` — an email.``; the second is a plain package drop the
     existing `dropToken` already handles.
   - Keep it **subtractive**. An appended correction loses to the text it
     contradicts — that is the whole reason `refuted-constraint.ts` exists.
   - **Then, and only then, the full run.** This is the one item where no subagent
     harness can see the outcome, and the only reason to open
     `DOCS-LIVE-RUNBOOK.md`.
2. **Defect 16 — a facade package indexes to nothing, in cargo.** `trait
   IntoResponse` is declared in `axum-core`, which `axum` only re-exports, so both
   recorded `IntoResponse` records miss and no ranking fix can reach them.
   `DEFECT-12-STOPPING-RULE.md`'s candidate bound already fits; its **trigger**
   reads Haskell export lists and does not. Measure a cargo trigger on a package
   sweep the way the hackage one was measured — do not port it by analogy.
3. **Defect 17 — retrieval depends on the cache's other packages.** Measured real
   (55 of 61 records differ) and measured harmless (recall 46/46 both ways). It is
   a determinism defect. Nothing to ship; the rule it earns is in the file. Reopen
   it only if a quality metric ever moves on it.

## Building a new instrument

Two things a retrieval-side harness must do, and neither is optional.

**Run in the container.** Container and host returned different chunks for one
query, and that alone moved a decided A/B cell from rung 1 to rung 2. Defect 17
names the mechanism: `bm25()` scores over the whole FTS index, so **hold the
cache's package set fixed across arms** or you are measuring cache history.

The container is provisioned for this. `/home/agent/pi-task-replay` holds the
tree with `bun install` already done, and `/home/agent/docs-live/run/{ts,rs,hs}`
are the seeded projects `--retrieve` points at. Re-copy the repo when src moves.

**Set `PI_BIN`.** `getPiInvocation` re-invokes `process.argv[1]` when it exists,
so a script under `scripts/` that spawns a child spawns *itself*, once per record.
`docs-replay.ts` throws before the first child rather than find out late.

## Known open — do not report as new

- A query naming no type has nothing to hop to. Unsolved.
- A query whose key symbol is absent from the corpus cannot be answered. Stripping
  English stopwords was tested and REFUTED; it moves the failure elsewhere.
- Four fidelity-scorer flags are left and all four are false. No principled rule
  was found, so they stay flagged rather than guessed away.
- The recall metric can score a symbol the run never asked about.

## Discipline

Regression test first, and prove it fails on the current tree before writing the
fix. If a test cannot fail before the fix — because the fix adds the seam it tests
— say so and prove the defect on the recorded data instead.

Never guess a constant. Defect 11's hop cap was swept (3, 5, 8, uncapped) and the
measurement chose it.

`bun run test` must stay green at 4356. `bun test` alone fails; the `--isolate` in
`bun run test` is load-bearing. `npm run lint:check` must stay green.

Publish a patch version when you ship a fix, and say plainly whether `dist`
actually changed — a `scripts/`-only change ships a byte-identical build.
