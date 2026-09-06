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

A full `/task-auto` run is a **discovery** instrument, and the 2026-09-06 run is
the proof: it found defect 18 and nothing else, because the defect-14 condition it
was launched to verify **did not recur**. Its query set has never repeated — five
runs, every recorded query distinct — so two arms are never compared on the same
stimulus.

`scripts/docs-replay.ts` is the instrument for verification. Records carry
`retrievedText` and a matching `contentSha256`, so it replays the real prompt with
no retrieval and no network. `--retrieve <project>` is the exception, for index
fixes, and it must run in the container.

```bash
PI_BIN=$(command -v pi) bun scripts/docs-replay.ts \
  live-docs-rerun2-2026-09-06/*.jsonl live-docs-rerun3-2026-09-06/*.jsonl \
  --only abstained --out /tmp/ledger.jsonl
```

Always `--dry-run` first. It rebuilds every prompt and sends nothing.

**Run it against the same model the recording used.** The record pins the prompt.
It does not pin the model, and a host model is not the container's.

## The work, in order — and when it runs out, go back to the top of the loop

Defects 14, 16, 18, 20, 21 and 24, the recall gate and seven self-review or
scorer bugs all closed in the 2026-09-06 session, shipped as **0.40.10** through
**0.40.13**. Defects 19, 22 and 23 are mechanised and have no lever. Their numbers
are in `DOC_REGRESSINONS.md`; none needs re-deriving.

One number for the whole session, 0.40.8 against HEAD on the defines harness:
**80/101 -> 90/101 paired, p = 0.0129**.

**"Still open" is empty.** Every item is shipped, refuted, or filed with its
mechanism. So the next round starts at the top of the loop: the full run in
`DOCS-LIVE-RUNBOOK.md` is the only remaining DISCOVERY instrument, and it paid
twice — re-run 4's three HARD FAILs produced defects 19 to 23, and re-run 5
verified defect 18 live AND surfaced defect 24 and a scorer artifact that an
earlier fix in the same session had created.

1. **`PACKAGE_RETRIEVE_LIMIT` 8 against 50, on the ANSWER side.** The retrieval
   side is measured over all 101 pairs and favours 50: defines 91 -> 97, monotone
   through 24 and 32, flat at 100, seven gains against one loss, **p = 0.0703**.
   It was not changed on that, because the cost is +57% of text into the
   extraction child and this metric cannot see the child. Run `docs-replay
   --retrieve` with two arms, limit 8 and limit 50, over the recorded records.
   `PROJECT_RETRIEVE_LIMIT` is already 50 and this file records that nobody knows
   why the two differ, so a decision here also closes that.

   Do NOT re-sweep the retrieval side, and do not trust the older npm-only sweep
   that said the plateau is 16 — it covered zod and hono only.

   Defect 24's other half is already REFUTED: dropping `IDENTIFIER_SHAPED` reads
   90/101 to 88/101, cargo 26/26 to 23/26, at the same wall clock. Hops sit at the
   FRONT of the content budget, so an extra hop displaces a better chunk.
2. **Run the defines harness before and after anything you change.** It is real
   now, with tests. `bun scripts/docs-defines.ts … --out a.jsonl` then
   `--compare a.jsonl b.jsonl` for an exact paired McNemar. Two arms means two
   trees and two `XDG_CACHE_HOME`s, never one cache re-indexed.
3. **Defect 14 has no live evidence and may never get it cheaply.** The lever is
   measured on 12,568 task files (3 fires, 3 true, 0 false) and is precise live
   (two correct non-fires in the 2026-09-06 ts run, both robust to a deliberately
   loosened token class). But the failing CONDITION did not recur. Do not burn
   four hours hoping it recurs. If you want live evidence, build a stimulus that
   forces it rather than waiting for one.
4. **Defect 17 — determinism only.** Measured real (55 of 61 records differ) and
   measured harmless (recall 46/46 both ways). Nothing to ship. Note that defect
   20 showed the same crosstalk INSIDE one package: two axum/tower queries
   retrieved fewer bytes after axum gained chunks, with nothing removed.

## Building a new instrument

Two things a retrieval-side harness must do, and neither is optional.

**Run in the container.** Container and host returned different chunks for one
query, and that alone moved a decided A/B cell from rung 1 to rung 2. Defect 17
names the mechanism: `bm25()` scores over the whole FTS index, so **hold the
cache's package set fixed across arms** or you are measuring cache history.

The container is provisioned for this. `/home/agent/pi-task-replay` holds the
tree with `bun install` already done, and `/home/agent/docs-live/run/{ts,rs,hs}`
are the seeded projects `--retrieve` points at. Re-copy the repo when src moves.
For a retrieval-only probe you do not need to reinstall the extension: unpack the
built `dist` beside the installed package as
`~/.pi/agent/npm/node_modules/@mjasnikovs/pi-task-next` and import `docs-core.js`
from there by path, with its own `XDG_CACHE_HOME`. That leaves a running
`/task-auto` untouched.

**Set `PI_BIN`.** `getPiInvocation` re-invokes `process.argv[1]` when it exists,
so a script under `scripts/` that spawns a child spawns *itself*, once per record.
`docs-replay.ts` throws before the first child rather than find out late.

## Known open — do not report as new

- A query whose key symbol is absent from the corpus cannot be answered. Stripping
  English stopwords was tested and REFUTED; it moves the failure elsewhere.
- A query naming no type: **REFUTED at STEP 0**, 1 of 158 and that one is the
  literal query `test`. Not a class.
- Four fidelity-scorer flags are left and all four are false. A query-echo guard
  was measured and NOT shipped — there is no confirmed fabrication in the corpus
  for it to protect.
- The project corpus cannot see a manifest. Measured at 2 of 158; below the bar,
  and the one-line glob would produce garbage chunks.
- Three of the audit's six metrics have never discriminated. Do not quote them.

## Discipline

Regression test first, and prove it fails on the current tree before writing the
fix. If a test cannot fail before the fix — because the fix adds the seam it tests
— say so and prove the defect on the recorded data instead.

**Never believe a one-line filter without opening what it selected.** Three did
that in the 2026-09-06 session and all three produced clean, plausible, false
findings. They are listed under item 4r in `DOC_REGRESSINONS.md`.

**Self-review your own fix before you ship it.** Five real bugs in that session's
own new code were found this way and none by the test suite: a whitespace collapse
that ate a nested bullet's indent, a rename split that turned `Hasher` into `H`, a
lock read from the crate's root instead of the project's (a machine-dependent
index), an undefined identifier that reached a test run because lint output was
discarded, and a content hash that did not cover the rule it was hashing for.

**A fix to how a chunk is SHAPED must move `contentFingerprint()`.** Three
separate fixes have now hidden one level below a `String(fn)` — the chunker,
the export-gap helpers, and `surface`, which cargo declares as a wrapper. Each
would have shipped inert. If you add a function that changes chunk content, add
it to that ecosystem's fingerprint in the same commit.

Never guess a constant. Defect 11's hop cap was swept (3, 5, 8, uncapped) and the
measurement chose it; defect 14's marker window was swept 20 to 4,000, found flat,
and **deleted** in favour of a clause boundary.

`bun run test` must stay green at 4448. `bun test` alone fails; the `--isolate` in
`bun run test` is load-bearing. `npm run lint:check` must stay green — and read ALL of
its output. Discarding it let an undefined identifier reach a test run; reading
only its `tail` let a syntax error reach a commit, because the failure was above
the cut.

Publish a patch version when you ship a fix, and say plainly whether `dist`
actually changed — a `scripts/`-only change ships a byte-identical build.
