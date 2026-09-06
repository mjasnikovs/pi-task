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

1. **Defect 15 — the child abstains with the answer in hand.** The lever is rule
   4's mixed-question clause in `src/workers/abstention.ts`. It is written, the
   harness is built and green, and it is UNMEASURED. Run both arms over the 24
   recorded abstentions. The first screen needs no hand-labelling: how many does
   each arm still abstain on. The guard beside it is the 49 records the run
   answered, because a lever that turns a correct abstention into a guess is
   worse than the defect. A smoke run of 2 showed the mechanism firing. Two
   records decide nothing.
2. **Defect 12 — a facade package indexes to nothing.** The stopping rule is
   measured and written in `DEFECT-12-STOPPING-RULE.md`; `hspec` goes 14 chunks
   to 133 offline. Index the new corpus, then replay the four recorded `hspec`
   records against it. That closes the answer half without a run.
3. **Defect 11 — did the better index reach the ANSWERS?** Index-side is done, 0
   missed of 45 at the live retrieval limit. The answer half was filed as needing
   a live run. It does not: re-retrieve in the container, then replay. This is the
   negative result the loop has produced twice, so read the `from_str`,
   `safeParse` and `IntoResponse` answers themselves.
4. **aeson's 55 duplicate bodies.** Fixed and measured, 1326/55 to 1283/0. That is
   an index count and a live run adds nothing to it. Ship it.
5. **Defect 14 — a correct answer, and the code shipped the deprecated form.**
   The only open item no subagent can see, and the only reason to open
   `DOCS-LIVE-RUNBOOK.md`. The chain is inspectable first without a new run:
   `live-docs-rerun3-2026-09-06/trees/` holds each tree's `.pi-tasks/` with the
   specs and per-task debug logs. Understand it there before spending four hours.

## Building a new instrument

Two things a retrieval-side harness must do, and neither is optional.

**Run in the container.** Container and host returned different chunks for one
query, and that alone moved a decided A/B cell from rung 1 to rung 2.

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
