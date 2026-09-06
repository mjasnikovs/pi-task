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

0. **A two-tree A/B is contaminated unless it is order-balanced. Read this first.**
   Four alternating passes over one fixed 103-record set answered **76, 85, 88, 89**.
   Slot 1 is twelve points below everything after it, and the arm alternates, so
   that line is POSITION, not the constant. The budget A/B's own A/A — the same
   tree, the same cache, byte-identical content — read p = 0.0118 while the A/B
   beside it read p = 0.0636.

   `--arm` is immune: both arms of one record run back to back in one process. Only
   a build-time constant forces two trees, and only two trees order the arms in
   blocks. The protocol that survives is one warm-up pass, discarded, then **ABBA**,
   scored with `docs-replay --compare-pooled a1,a2 b1,b2`.

   **`PACKAGE_RETRIEVE_LIMIT` 8 -> 50 was decided on the contaminated design**
   (answers 67/94 -> 79/94, p = 0.0075). Its retrieval half needs no model and
   stands — defines 91/101 -> 97/101, and a sweep to 200 says 50 is the plateau.
   Its answer half was being re-run balanced when this was written; if
   `/home/agent/ledger-lim-{A1,A2,B1,B2}.jsonl` are in the container, score them and
   record the number.

1. **`RETRIEVE_CONTENT_BUDGET` is CLOSED at 24,000.** Do not re-open it without a
   design that can see a four-point effect. Direction favoured 48,000 in every cut
   and cleared its noise in none: p = 0.0636 uncontrolled, p = 0.1360 balanced,
   p = 0.2500 on retrieval. The 24k arm's own two passes span 76 and 88, wider than
   anything between the arms. Nothing about 48,000 is refuted; it is unproven.

   Also settled, and not worth re-deriving: hackage is **saturated** on defines
   (35/35 at every limit and budget tried) and so is cargo (42/42). Every gain
   either constant can still buy is npm, and it is three hono records.

2. **Re-run 7 has not been launched.** `/home/agent/docs-live/run7.sh` is written
   and ready: it archives run 6 to `prev-6`, re-seeds all three, then runs ts, rs
   and hs serially. It has not run. The seed changed since run 6 — see below — so
   this is the first run that can be read as a test of the rs fix.

   **The rs seed never declared `tower`.** axum's only in-process way to drive a
   `Router` is `tower::ServiceExt::oneshot`, and the feature's third obligation is
   to cover both responses in tests. Re-runs 4 and 6 both hand-rolled
   `poll_ready`/`call` and both failed on `use tower_service::Service`; re-run 6's
   own test file says it avoided `oneshot` because tower was not a direct
   dependency. `[dev-dependencies] tower = { version = "0.5", features = ["util"] }`
   is now in the seed. Two of six runs died on this.

3. **Defect 19 was re-diagnosed three times in one session** and only the last
   reading came from opening the file the run produced. Do not re-open the first
   two: the retrieval bound was measured at limit 8 and no longer holds, and the
   extraction omission is real, under-powered, and not fatal. The seed was the
   cause.

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
