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
**0.40.14**. Defects 22 and 23 are mechanised and have no lever. Defect 19 turned
out to be the seed — see item 2. Their numbers are in `DOC_REGRESSINONS.md`; none
needs re-deriving.

The later 2026-09-06 session shipped **no `src/` change at all**. Everything it
moved was instrument: the seed, the audit and the replay harness. That is not a
quiet session — a two-tree A/B that could not tell a constant from a slot had
already decided a production constant, and an audit that scored a killed run PASS
had already reported one.

One number for the earlier half, 0.40.8 against HEAD on the defines harness:
**80/101 -> 90/101 paired, p = 0.0129**. It uses no model and is not affected by
the position confound below.

The full run in `DOCS-LIVE-RUNBOOK.md` is still the only DISCOVERY instrument, and
it paid a third time — re-run 6 is what exposed both the seed defect and the fact
that the byte budget had become binding.

0. **Read this first: every instrument in this project has been wrong this month,
   and four of them were found in one night.** Not the docs tool — the things that
   MEASURE it. Defects 26 to 31 are all instrument, and each one had already changed
   a verdict before it was found:

   ```
   26  the audit could not see a requirement DROPPED     ts would have read PASS
   27  a partial answer scored as an abstention          every replay abstention
                                                         inflated by a third to a half
   28  a stitched excerpt refused the cache              a quarter of all answers
   29  taskProgress counted specs written, not planned   hs read 1 of 1 against 3
   30  the suite leaked 252 temp dirs per run            filled /tmp, broke docker exec
   31  waitForSettle called a run settled mid-implement  hs built half-written, RED
   ```

   Two of them share a shape worth naming: **a predicate whose docstring justified
   itself on a premise a later fix had quietly invalidated.** Defect 15's clause made
   `isAbstention`'s substring match unsafe; defect 18's classifier made
   `excerptVerified` unusable as a fabrication signal. Both fixes left their consumer
   behind. When a measurement disagrees with a mechanism you have opened and read,
   suspect the instrument.

1. **Two constants are CLOSED. Do not re-open either without a new lever.**

   ```
   RETRIEVE_CONTENT_BUDGET   24,000 -> 48,000   p = 0.3323 balanced.  STAYS at 24,000
   PACKAGE_RETRIEVE_LIMIT    8 -> 50            p = 0.1796 balanced.  STAYS at 50,
                                                on its retrieval half, which needs
                                                no model
   MIN_TOKEN_LEN             2 -> 3             the peak moves to 2 the moment one
                                                two-letter symbol enters TRUTH
   ```

   The limit's shipped answer-side claim (67/94 -> 79/94, p = 0.0075) does NOT
   replicate. Three measurements now agree that retrieved VOLUME is not what makes
   this child answer. **Stop tuning volume.** What the text IS, is what moves — see
   defect 25.

   A two-tree A/B still needs one warm-up pass then **ABBA**, scored with
   `docs-replay --compare-pooled a1,a2 b1,b2`. The effect is five points, not the
   twelve first reported; that first reading was mostly defect 27.

2. **Defect 25 is the shape that pays: what the chunks ARE.** 3.8% of chunks held
   51.1% of all indexed bytes, cut at 8 KiB byte offsets. Two fixes shipped — every
   slice keeps its path line, and an oversized declaration splits at its members —
   for defines 137/153 -> 148/153, p = 0.0034. Splitting CLASS members too was
   measured and buys nothing (p = 1.0000); the patch is not kept.

3. **Still open on defines, 8 of 159, and none of it is a constant.**

   ```
   bun:test:describe 5/6   bun:test:expect 5/6   bun:test:it 3/6
   hono:Hono 12/13   hono:json 10/11   node:fs/promises:readFile 1/2
   ```

   Refuted on the way here, do not redo: `enforceBudget`'s `break` (packing is worse,
   150 -> 149, the hops get evicted), and teaching the alias hop to see
   `export const` (151 -> 149, the hop evicts the declaration it was chasing a type
   for). Both are pinned by tests that say "on purpose".

4. **The residual is a RANKING problem and adding chunks cannot fix it.** Every
   symbol still missing on defines has a 66-to-225-byte declaration in its own
   package; `zod:email`'s five misses each retrieve 17 to 38 chunks and 21.5 to 24 KB
   without it. Three levers that FETCH one all lost, because
   `enforceBudget([kept[0], ...hops, ...kept.slice(1)])` evicts a ranked chunk for
   every chunk added:

   ```
   enforceBudget `break` -> `continue`         150/157 -> 149/157   p = 1.0000
   alias hop reads `export const`              151/159 -> 149/159   p = 0.5000
   definitionChunk for the query's symbols     151/159 -> 147/159   p = 0.2891
   ```

   **Promotion is the one direction that is not negative.** It reorders rather than
   adds — a chunk declaring a query symbol sorts ahead of one that only uses it:

   ```
   159 pairs   151 -> 154   p = 0.5078
   173 pairs   160 -> 165   p = 0.2266     npm 84/97 -> 90/97
   ```

   Not shipped at p = 0.2266, against a budget refused at 0.1360 tonight. More corpus
   halved its p-value once and would again. Do NOT sort the promoted group
   smallest-first — measured, 6 for 6, exactly nothing. What is untested is a bm25
   rank ADJUSTED by declaration rather than partitioned on it.

5. **Write a TRUTH entry the way the last four were, or not at all: named by a
   recorded query, declared by the published docs.** Reading the index for candidates
   is how a truth set stops being one. The member split was REJECTED at 125/128 and
   then shipped at p = 0.0005 on the same data, because `TRUTH` had no entry for a
   single package it repairs. `TruthEntry.named` exists for `Bun.file` vs
   `function file`; selection is whole-token since `queryAsks`.

6. **Three live runs now say the same thing about ts, and it is not a docs defect.**
   The tool named `z.email()` correctly in every run since the dead-major fix, and
   the code shipped `z.string().email()` twice and `z.string()` once. Nothing in
   retrieval or extraction is implicated. Defect 26's obligation check is what sees
   the third case at all.

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
