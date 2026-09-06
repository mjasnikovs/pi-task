# Docs live test — findings

Working notes for the docs test across TypeScript, Rust and Haskell. Everything
below was checked on this machine.

Defects 1-3, 5-10 and 13 are closed and collapsed to one line each at the bottom.
The full `/task-auto` loop is in `DOCS-LIVE-RUNBOOK.md`.

---

# The loop

This is a standing loop, not a task list. Measure, fix, measure, fix, and keep
going.

```
pick the top open item
  -> cheapest instrument that can move it
  -> measure
  -> fix
  -> measure again on the same instrument
  -> record the number here
  -> pick the next item
```

**Do not stop when a round finishes.** A closed item is not a stopping point, it
is the signal to start the next one. Do not stop to report and wait. Do not ask
whether to continue.

**Stop only when the user says stop.** That is the one exit. A failed preflight or
a genuinely ambiguous choice is worth one question, then carry on.

**Arm the keep-alive at the start of every session**, before any other work. A rule
that says "do not stop" enforces nothing on a session that has already stopped.

```
/loop 10m Continue the docs loop in DOC_REGRESSINONS.md …
```

The full line is step 0 of `NEXT-SESSION-PROMPT.md`. It re-enters this loop every
ten minutes, so an item closing no longer ends the session. It is session-only, so
it is armed fresh each time.

**An empty "Still open" is not the end either.** Replay and retrieval VERIFY; they
cannot discover. When nothing is left to verify, run the full loop in
`DOCS-LIVE-RUNBOOK.md`. It finds new defects, and it records fresh
`retrievedText` answers that become the next replay corpus. That is what makes
this a cycle rather than a queue.

Each round leaves three things behind, and a round that skips them did not happen:
the number in this file, a regression test that failed before the fix, and a
published patch version saying plainly whether `dist` actually changed.

**Never guess a constant.** Defect 11's hop cap was swept (3, 5, 8, uncapped) and
the measurement chose it.

**A negative result closes an item.** "Fixed the index, the answer did not move"
is the result this loop has produced twice. Write it down and move on. Do not
re-run the same measurement hoping for a different number.

---

# Read this first: most of what is left does not need a full run

The docs worker is a **subagent**. `docsLookup` takes chunks plus a query, spawns
one `--no-tools` child, and returns the answer. No session, no task state.

```
docsRaw(pkg, query, cwd)  ->  chunks          retrieval half
docsLookup(chunks, query) ->  answer          extraction half, one child
```

So there are three instruments, not one. Pick the cheapest that can move the item.

| instrument | what it drives | cost | environment |
|---|---|---|---|
| **replay** — `scripts/docs-replay.ts` | extraction only, on recorded `retrievedText` | minutes | any, same model |
| **retrieval** — not written | `docsRaw` only, scored on what came back | minutes | container, pinned deps |
| **full run** — `DOCS-LIVE-RUNBOOK.md` | `/task-auto` end to end | 3-4 h | container |

## The replay corpus already exists

158 recorded answers over four runs. `retrievedText` was added with the defect 9
fix, so **73 of them replay with no retrieval at all** — re-run 2 and re-run 3.

```
73 records   24 abstentions   13 excerptVerified=false   16 modules, 3 ecosystems
```

Every record carries `query` verbatim, `retrievedText` (the exact bytes the child
was shown) and `excerptCheck.contentSha256`. All 73 hash clean, so the drift that
moved a decided A/B cell a whole rung cannot reach a replay.

```bash
PI_BIN=$(command -v pi) bun scripts/docs-replay.ts \
  live-docs-rerun2-2026-09-06/*.jsonl live-docs-rerun3-2026-09-06/*.jsonl \
  --only abstained --out /tmp/ledger.jsonl
```

`--dry-run` rebuilds every prompt and sends nothing, which is the preflight.
`--arm treatment|control`, `--trials N`, `--limit N`, `--only abstained|answered`.

Three properties make its verdict worth having.

- **The treatment arm is production, byte for byte.** It calls `packageCorpus` /
  `projectCorpus` and their `buildPrompt`, recovering registry, name and version
  out of the recorded `toolText`. 73 of 73 recover.
- **The control arm is production minus one clause**, deleted from the built
  string. If the wording in `abstention.ts` changes, the harness throws rather
  than run both arms on the same prompt and report a tie.
- **It refuses drifted material.** A record whose bytes no longer hash to
  `contentSha256` is skipped, never scored.

Excerpt verification is counted over ANSWERED trials only. Rule 4 tells an
abstaining child to cite the closest related text, which verifies for free, so a
pooled rate rewards the arm that abstains more — the exact direction under test.

**It must run against the same model the recording did.** The prompt is pinned by
the record; the model is not.

---

# Still open

| # | item | half | instrument | state |
|---|---|---|---|---|
| 4r | a query naming no type has nothing to hop to | retrieval | recorded corpus | **REFUTED**, 1 of 158 and it is junk input |
| — | a key symbol absent from the corpus | retrieval | — | **limit, not a defect** |
| 11 | English question loses the declaration | both | retrieval + replay | **closed**: `from_str` fixed, `IntoResponse` is defect 16 |
| 12 | a facade package indexes to nothing | both | retrieval + replay | **closed on hackage**, 3 of 4 answered |
| 15 | child abstains with the answer in hand | extraction | **replay** | **SHIPPED**, p=0.0386 paired over 73 |
| — | aeson keeps 55 duplicate bodies | index | offline | **measured fixed** |
| 16 | a facade package indexes to nothing, in **cargo** | index | retrieval | **SHIPPED**, 3 of 4 axum queries reach the trait |
| 17 | retrieval depends on the cache's other packages | retrieval | retrieval | **real, and measured harmless** |
| 14 | correct answer, deprecated code shipped | neither | **full run** | lever BUILT, 3/3 on the corpus; live run pending |

## 4's residue. A query that names no type — REFUTED at STEP 0

`the handler monad` and `handler type for a route` still miss, and the
name-directed hop has no name to chase. What was never measured is how often a
real query looks like that.

```
158 recorded queries, four runs
157 name a symbol
  1 does not   <- module ".", query "test"
```

The one is degenerate input, not a class. Both failing strings above came from a
probe an earlier session wrote by hand, never from a run. A lever for one junk
query in 158 is not worth building, so this closes as refuted rather than unfixed.

**The first classifier was wrong, and it invented a finding.** Its symbol test
missed `Bun.file`, `decodeFile`, `Data.Text.Text` and `configSchema`, which put
19 queries in the nameless bucket and reported a 68.4% abstention rate against
30.2% for the rest — a large, clean, entirely fictional gap. The shapes it needed
were all present in the corpus it was reading. Read the bucket before believing
the rate.

## A query whose key symbol is absent from the corpus

FTS matches whole tokens, so `decodeFile` matches nothing when only
`decodeFileStrict` is indexed, and `Data.Aeson` tokenises to `Data` + `Aeson`,
which every chunk carries. Nothing in such a query discriminates. Stripping
English stopwords was tested and **refuted** — it moves the failure to a different
wrong file. This cost hs seven lookups.

Filed as a known limit. No candidate fix is open.

## Defect 11. An English question loses the declaration the bare symbol wins

`from_str` is the cargo ground-truth symbol, and two re-runs answered that its
signature was not retrieved. It is indexed, 91 bytes, one line in `src/de.rs`.

```
rank of the declaration: NOT RETRIEVED of 6   <- "What is the exact signature of from_str? What error type does it return?"
rank of the declaration: 1 of 17              <- "from_str"
```

The 1159-byte `from_slice` chunk ranks 3rd on the prose query, because its doc
comments match `signature`, `error`, `type` and `return`. BM25 gives the English
half of the question as much say as the symbol, and the English half matches the
chunks that talk *about* the API rather than the one that *is* it.

Base rate before the fix: 17 of 35 declarations never retrieved, 48.6%. `hopNames`
only accepted `/^[A-Z]/` and `definitionChunk` only found TYPE declarations, so
`from_str`, `safeParse`, `into_make_service` and `parseJSON` were never
candidates. Both were widened, with a whole-word smallest-first fallback for
values, and the hop cap was swept rather than guessed. Cost over the same 22
queries: mean bytes 15,965 -> 16,083, +0.7%.

Re-measured at the live retrieval limit with a whole-word test: **0 missed of 45**.
The earlier residue of 8 was a substring test counting `decodeFile` as declared
because `decodeFileStrict` is.

### Re-retrieved in the container, on the run's own nine queries

`--retrieve` against the seeded `ts` and `rs` trees. "DECL" means the retrieved
bytes carry the declaration itself — `fn from_str`, `safeParse(`, `trait
IntoResponse` — not prose about it.

```
symbol         records   recorded            live
from_str          3      1 DECL, 2 none      3 DECL
safeParse         4      4 DECL              4 DECL
IntoResponse      2      0 DECL              0 DECL
```

`from_str` is closed: the two queries whose declaration the run never saw now
retrieve it. `safeParse` never had the problem in these records.

**`IntoResponse` is not a ranking failure, and that is the finding.** The bare
symbol retrieves 8 chunks and none of them declares it. `pub trait IntoResponse`
is declared in `axum-core-0.5.6/src/response/into_response.rs`; `axum` only
`pub use`s it. So this is **defect 12 in a second ecosystem** — the facade class,
in cargo — and no amount of hop-widening can reach it. The stopping rule's
candidate bound already fits: `axum-core` is a `build-depends` sibling sharing
`axum`'s name prefix. What does not fit is the trigger: `hackageExportGap` reads
Haskell export lists, and `supplements` is a hackage-only profile hook.

Filed below as defect 16 rather than fixed here.

## Defect 12. A facade package indexes to nothing

hs abstained three times on `hspec`, every time with the same 1915 characters,
because the entire `hspec` index is 14 chunks — an export list and a re-export
module. Every signature is in `hspec-core`, a transitive dependency the indexer
never opens. The tool returned everything it had and the child correctly abstained.

Distinct from the note above: here the symbol is present with no signature
attached. Facade packages are the norm on hackage.

Measured against re-run 3's corpus: 14 chunks -> 133, and the three questions the
runs asked go from NONE/NONE/NONE to carrying `it`, `describe`, `shouldBe` and
`shouldReturn`. See `DEFECT-12-STOPPING-RULE.md`.

### The retrieval half, on all four recorded `hspec` queries

`scripts/docs-replay.ts --retrieve <project>` re-runs `docsRaw` in the container
against the seeded `hs` tree, whose `plan.json` still names `hspec-core`, and
extracts over what comes back. Recorded bytes against live bytes, same queries:

```
                                                recorded            live
Minimal API to run a stub test suite …          1915 B  NONE        4088 B  it ::
Signatures of: main, it, Spec, SpecWith …       1915 B  NONE        3567 B  it ::
type signature of `assert` in Test.Hspec…       1915 B  NONE        3641 B  NONE
hspec runner, describe/it/shouldBe basics       1967 B  NONE        3113 B  it :: describe :: shouldBe ::
```

Three of four now carry the signature that was asked for. The fourth is the
stopping rule's stated cost, not a miss: `assert` is HUnit's, and `HUnit` shares
no name prefix with `hspec`, so it is never a supplement candidate. A `docsRaw`
for the bare token `assert` returns one chunk with no `assert` line in it — the
symbol is absent from `hspec` and `hspec-core` both. Same class as the `cookie`
limitation already written down in `DEFECT-12-STOPPING-RULE.md`.

### The answer half — CLOSED

Re-retrieved and extracted, both arms, the same four records. The run abstained on
all four. Against the new corpus:

```
arm        recorded-abstain -> still abstains
treatment          1/4     25%
control            3/4     75%
```

The three treatment answers carry the signatures the run asked for and never got:

```
it :: (HasCallStack, Example a) => String -> a -> SpecWith (Arg a)
hspec :: Spec -> IO ()
describe :: HasCallStack => String -> SpecWith a -> SpecWith a
shouldBe :: (HasCallStack, Show a, Eq a) => a -> a -> Expectation
```

Defect 12 is answered end to end: index, retrieval, and answer. The one still
abstaining is the "Minimal API … Spec type, main entry point" record, and it is
the same crosstalk case defect 17 is about.

## Defect 15. The child abstains with the answer in the corpus

Of re-run 3's 11 abstentions, 6 are correct and **5 had part of the answer in hand**:

- **`text`** — 4,459 bytes retrieved containing `data Text = Text …`. Answered `unclear`.
- **`zod`** — the `.email()` question. A sibling answer from the same corpus answered it.
- **`serde`** — corpus has `trait Deserialize` and `trait Serialize`; only the
  `#[serde(rename)]` half is missing.
- **`aeson`** — `decodeFile` is absent; the blanket-instance half is not.
- **`zod`** — `ZodError.issues` is answerable; the enumeration of `code` values is not.

All five are **compound questions where one part is unanswerable**, and the child
discards the answerable parts with it. Not every compound question does this — one
aeson lookup asks two things and neither is in the corpus, and abstaining is right.
The trigger is a *mixed* question.

Rule 4 of the extraction prompt now names the case: answer the parts the content
covers, name the parts it does not, and abstain only when it covers no part.

```
src/workers/abstention.ts
```

### Measured, n=24, one trial per arm

Both arms over all 24 recorded abstentions, in the container, against the same
llama-server the recording used (`Qwen3.8-27B-UD-Q4_K_XL.gguf`, build b10734).

```
arm        trials fail  recorded-abstain -> still abstain   excerpt ok (answered)
treatment     24   0            15/24    63%                    7/8    88%
control       24   0            19/24    79%                    5/5   100%
```

Paired, the same 24 stimuli: **4 records flip to answered under treatment, 0 flip
the other way.** Sign test on 4 discordant pairs is p=0.125 two-sided — a clean
direction, not yet a significant one. Underpowered by design at one trial.

The four are `hspec` (minimal API), `serde` (Deserialize derive), `serde_json`
(`from_str`) and `zod` (`ZodError.issues`). Read the answers, because "answered"
is not the claim worth making:

- `serde_json` returns `serde_json::Result<T>`, names the `Deserialize` bound, and
  says the literal `'de` signature and the `Error` variants are not shown.
- `zod` gives `$ZodIssue` with `path`, `message`, `code`, and says the enumeration
  of `code` values is not covered.
- `hspec` names the two signatures the corpus does carry and says the four asked
  for are absent.
- `serde` says only that the macro is re-exported from `serde_derive`.

**Not one of the four guesses.** Each states a covered part and names the
uncovered part, which is exactly the rule's wording. Excerpt verification holds
at 7/8 on a larger answered pool against control's 5/5 on a smaller one.

Two of the five records defect 15 predicted would flip did (`serde`, `zod`
issues); three did not (`text`, `zod .email`, `aeson`), and two the write-up did
not predict flipped instead.

### The guard, n=49, the records the run ANSWERED

The fear was a lever that turns a correct abstention into a guess. Measured on the
other 49 records, it goes the other way:

```
arm        trials fail  recorded-answer -> now abstains   excerpt ok (answered)
treatment     49   0            3/49     6%                  30/45   67%
control       49   0            7/49    14%                  27/40   68%
```

Treatment abstains on *fewer* answerable records than control, and excerpt
verification is a tie — 67% against 68% — so the extra answers are no less
grounded than the ones both arms give.

### The verdict, paired over all 73

Both pools are the same design: one corpus, both arms, same stimulus. Pooled and
counted pairwise, exact sign test on the discordant pairs:

| pool | treatment-only answered | control-only answered | p |
|---|---|---|---|
| the 24 abstentions | 4 | 0 | 0.1250 |
| the 49 answers | 6 | 2 | 0.2891 |
| **all 73** | **10** | **2** | **0.0386** |
| all 73, leak-corrected | 11 | 2 | 0.0225 |

Neither pool decides alone. Pooled, the lever moves ten records from abstention
to answer and two the other way, and that is significant at one trial per record.

**Read the flips, not the count.** The ten are `serde_json` naming
`serde_json::Result<T>` and the `Deserialize` bound while saying the literal
signature is absent; `aeson` giving `decode`, `decode'` and `eitherDecode'` and
correcting the question's own premise (`Either String a`, not
`Either DecodeError a`); `zod` twice answering "partial coverage" with the
declaration it does have; `bun:test` listing the real exports. Not one is a guess.

**The one real loss** is `zod` "what does safeParse return on failure" — control
answered it well and treatment abstained. One of 73.

### The leak correction, and why it is stated separately

Three of the 146 replayed rows (2%) came back with a `<tool_call>` or a stray
`<answer>` tag in the answer text, which `isAbstention` scores as an answer. One
is treatment, two are control, so it is not an arm effect. The correction was
applied to both arms by the same rule and both numbers are in the table above;
the direction does not depend on it. **0 of 73 recorded** answers leak this way,
so it is an artefact of replaying, not a live defect.

## Defect 16. A facade package indexes to nothing, in cargo

Defect 12's class, in a second ecosystem, found while closing defect 11.

`pub trait IntoResponse` is declared in `axum-core-0.5.6/src/response/into_response.rs`.
`axum` only `pub use`s it. So `docsRaw("axum", "IntoResponse")` returns 8 chunks
and not one of them declares the trait — no ranking fix can reach it, because the
declaration is not in the index at all. Both recorded `IntoResponse` records miss,
before the defect 11 fix and after it.

The stopping rule in `DEFECT-12-STOPPING-RULE.md` already fits the candidate
half: `axum-core` is a `build-depends` sibling sharing `axum`'s name prefix, which
is exactly the `hspec`/`hspec-core` shape. What does not fit is the **trigger**.
`hackageExportGap` reads Haskell export lists to find a name the package exports
and declares nowhere; Rust has no export list, it has `pub use`. And `supplements`
is a hackage-only hook on the ecosystem profile.

### STEP 0 — the cargo sweep, measured, not ported

Twenty-two crates, sources pulled from `static.crates.io`, no indexer involved.
Rust has no export list, so the trigger reads `pub use <dep>::…` where the leading
path segment is a declared dependency: those are the names the crate publishes and
may not declare.

**The ratio does not transfer, and that is the same answer hackage gave.** Hackage
put facades at 87.7% and ordinary packages under 3%. Cargo will not draw that line:
`axum-core`, `clap`, `rand`, `itertools` and `tokio-util` all read 100% on one to
seven re-exports, and most crates re-export nothing at all. So no threshold — which
is exactly what `DEFECT-12-STOPPING-RULE.md` already concluded for hackage. **The
trigger is the hole**, and in cargo the hole is directly readable rather than
inferred.

The depth-1 table, the number that actually decides the rule:

| crate | unresolved | resolved in 1 hop | fetched |
|---|---|---|---|
| **axum** | **22** | **20 (91%)** | **axum-core axum-macros** |
| futures | 55 | 53 (96%) | futures-{channel,core,executor,io,sink,task,util} |
| tracing | 15 | 14 | tracing-attributes tracing-core |
| tokio | 6 | 6 | tokio-macros |
| rand | 7 | 5 | rand_chacha rand_core |
| tower | 5 | 4 | tower-layer tower-service |
| clap | 5 | 4 | clap_builder clap_derive |
| hyper | 12 | 0 | — (suppliers are http, bytes, http-body) |
| reqwest | 3 | 0 | — (http, url) |
| axum-core, itertools, tokio-util | 1 | 0 | — (tracing, either, bytes) |
| serde, serde_json, regex, chrono, uuid, anyhow, thiserror, bytes, http, tower-http | 0 | — | never fires |

`IntoResponse` is named in axum's 20:

```
supplied by axum-core:  AppendHeaders ErrorResponse IntoResponse IntoResponseParts
                        ResponseParts Result BoxError RequestExt RequestPartsExt
                        DefaultBodyLimit FromRef FromRequest FromRequestParts
                        OptionalFromRequest OptionalFromRequestParts Request Body
                        BodyDataStream
supplied by axum-macros: debug_handler debug_middleware
still open:              http  Bytes
```

**Self-limiting, same as hackage.** Ten of the twenty-two have no hole, so the pass
never fires for them however many prefix-named dependencies they declare — `serde`
has two, `regex` two, `uuid` one, and all four resolve nothing because there is
nothing to resolve.

**`[dependencies]` only, measured against the wider set.** Scanning dev- and
build-dependencies too fetches `tokio-test`, `clap-cargo`, `regex-test` and
`tower-test` and resolves **not one extra name**: 20/6/53/4/4/14/5 either way.
Runtime-only is the same answer for fewer fetches, so it is the rule.

**The bound's cost, stated rather than hidden** — the same shape as scotty/cookie
on hackage. `hyper` re-exports twelve names from `http`/`bytes`/`http-body`,
`reqwest` three from `http`/`url`, and axum's own `pub use http;` and `Bytes` stay
open. A prefix rule cannot see any of them.

### IMPLEMENTED — and the indexer stopped knowing Haskell

The gap was hardcoded to hackage in `docs-index.ts`: it called
`hackageExportGap`, read a `module X` header out of the source, and intersected
with `declaredInSurface`, all of which are Haskell. Rust names its module by file
location and states its gap in `pub use`, so none of it ports.

The fix is one hook. `EcosystemProfile.exportGap` returns three answers —
`empty`, `wholesale(relPath, source)`, `fillsHole(chunk)` — and the indexer asks
those three questions without knowing either language.

```
src/workers/export-gap.ts   the type, and why it is shared
eco-hackage.ts              hackageExportGap  — export list  + `module X`
eco-cargo.ts                cargoExportGap    — `pub use`    + `pub use x::y::*`
```

**End to end through the real `docsRaw`, in the container, on the seeded `rs`
project, one cold cache per arm.** Published 0.40.9 against this tree:

| query | 0.40.9 | this tree |
|---|---|---|
| `IntoResponse` | no declaration | **`trait IntoResponse`** |
| `trait IntoResponse signature` | no declaration | **`trait IntoResponse`** |
| `FromRequestParts extractor trait` | no declaration | **`trait FromRequestParts`** |
| `how do I return a custom response from a handler` | no declaration | no declaration |

The fourth is the standing open item, not a new one: the query names no type, so
there is nothing to hop to.

**Cost.** axum goes 381 chunks to 403 — twenty-two, because rule 3 keeps only the
hole. The `packages` table still holds exactly `axum`: a supplement is folded into
the asking crate's rows and never registered as a package of its own.

Five tests mirror the hackage ones on a `tiny-axum`/`tiny-axum-core` fixture, and
three of the five were confirmed to FAIL with the hook commented out. The two that
survive are the negative guards ("the trait is absent alone", "the unrelated
helper is never indexed"), which is what a negative guard is supposed to do.

**One thing fixed in passing, in both ecosystems.** `supplementCandidates` sorted
with `localeCompare`, which orders `-` and `_` differently under a different
`LANG` — and that sort decides the order supplement chunks enter the index. Both
call sites now compare code units. A machine-dependent index is the exact failure
`DEFECT-12-STOPPING-RULE.md` refuses elsewhere.

**What this does not claim** — the same caveat the hackage half carries. This is a
retrieval-side result. Defect 11 is the standing proof that a better index is not
a better answer, and no recorded cargo record has been replayed against the new
corpus yet.

## Defect 17. Retrieval depends on which OTHER packages share the cache

`retrieveChunks` orders by `bm25(chunks_fts)` and filters the package with a
`WHERE` on the joined table. BM25 takes its term statistics from the whole FTS
index, and the `WHERE` is applied to rows that are already scored. So the ranking
for one package is a function of every other package in `docs.sqlite`.

Demonstrated causally on one query, one package, one content hash:

```
hspec alone in the cache                9 chunks  4088 B  sha a47fcefb00  it:: yes
after zod is indexed into the same db   9 chunks  2978 B  sha b8b315b738  it:: yes
```

Nothing about `hspec` changed — same version, same 133 chunks, same
`content_hash`. Only the neighbours moved.

**Size of it.** Every package record in the recorded corpus, retrieved twice: once
from a cache holding only that package, once from a cache holding all of them.

```
55 of 61 records return different content.   6 identical.
```

**Cost of it — measured, and it is nil.** Two metrics, both on the same 
alone-vs-shared pair:

```
ground-truth symbol the query names      alone 46/46   shared 46/46   0 lost, 0 gained
the DECLARATION the query names          alone 25/39   shared 27/39   1 lost, 3 gained
```

The declaration metric is 4 discordant records, 3 of them favouring the shared
cache. p=0.625. There is no quality effect to fix.

**So it is a determinism defect, not a quality one, and that is worth more than a
fix here.** It names the mechanism behind a caution this file has carried
unexplained since the start — "container and host returned different chunks for
one query, and that moved a decided A/B cell from rung 1 to rung 2". The two
machines had different package sets in their caches. The standing rule that
follows is not "ship a fix", it is: **a retrieval-side A/B must hold the cache's
package set fixed across arms, or it is measuring cache history.**

The one live cost seen so far is the fourth `hspec` record above, which retrieves
`it ::` from a cache holding only `hspec` and does not from the shared one.

## aeson keeps 55 duplicate bodies

Different component from defect 7: the hackage surface extractor truncates a
multi-line instance head to its first line, so `instance {-# OVERLAPPING #-}`
becomes a content-free chunk. 4% of the package, all internal generic machinery,
no public API lost. Fixed and measured against re-run 3's corpus, 1326/55 ->
1283/0. That is an index count. A live run adds nothing to it.

## Defect 14. A correct docs answer, and the code shipped the deprecated form

Re-run 3's ts HARD FAIL is `adminEmail: z.string().email()` in `src/config.ts` —
the zod 3 form, and a stale-major marker.

The docs tool answered correctly, twice, naming `z.email()` as the v4 API and
`.email()` as `@deprecated`. The timestamps close it: `worker:apis` asked at
01:38:11, and the commit that shipped `z.string().email()` is 01:45, same task.

This is a delivery failure one level further out, and **the one open item no
subagent harness can see**. Defect 11's lesson was that a better index is not a
better answer. This is that a correct answer is not correct code. `.email()` still
exists in 4.5.4, so the build is green and only the marker sweep catches it.

### The chain, read out of the artifact — no run needed

`ts/.pi-tasks/TASK_0001.md` holds the whole thing in one file, in phase order
(`refine 17.5s → research 128.8s → grill → compose → critique`).

```
refine    CONSTRAINTS
          "`adminEmail` — an email (e.g. z.string().email())"      <- written from memory
research  APIS
          "z.email()  top-level v4 email string schema … (z.string().email() still
           exists in 4.5.4 but is @deprecated; z.email() is canonical)"   <- CORRECT
research  CONTEXT
          "Open question (unverified): … the constraint text says to use
           `z.string().email()`, but I cannot confirm v4 semantics"       <- lost it
compose   spec
          "`adminEmail` as an email string (e.g. `z.string().email()`)"   <- constraint won
```

So the defect is not "the answer did not arrive". It arrived, in the same file,
one section above. **Refine writes an API example into CONSTRAINTS before research
runs, and compose prefers the constraint over the research finding that refutes
it.** Downstream, TASK_0002/0003/0004 then freeze it — "must not change",
"preserve `src/config.ts` as-is" — so one refine line propagates through four
tasks.

Base rate for the *shape*: **9 of 9 tasks in this run put an API call inside a
refined-prompt CONSTRAINTS bullet.** That is normal and mostly harmless. What is
not harmless is a constraint the run's own research contradicts.

### STEP 0 — how often does research refute the constraint's API?

A detector, run over every task file on this machine: a research line carrying a
deprecation claim (`deprecated`, `superseded`, `merged into`, `no longer
recommended/supported/maintained`) in which a code-shaped token also appears
verbatim in that task's CONSTRAINTS section.

```
14,171 task files scanned
13,428 with a non-empty CONSTRAINTS and a research section
     3 fires        <- 3 of 3 TRUE, 0 false positives
```

Two are defect 14 itself; the third is the same defect in Haskell, and it is worse
because the run's own research spelled out the consequence:

```
ts/TASK_0001  z.email()  … (z.string().email() … is @deprecated)
ts/TASK_0002  Open question: … `z.string().email()` may be superseded by `z.email()`
hs/TASK_0001  wai-test  test-suite dep REQUIRED by constraints BUT deprecated on
              hackage: "Since WAI 3.0, this code has been merged into wai-extra";
              last real release … will NOT resolve
```

`\breplaced by\b` was in the first pattern set and was **removed by the
measurement**: it fired on `src/shared/index.ts  Empty file to be replaced by
schema.ts exports`, a claim about a file, and it was the only false positive in
the corpus. Dropping it loses none of the three.

Rare — 3 in 13,428 — because it needs a pinned major the model predates, which is
the exact condition this whole live test was built to create. Inside that
condition it is 3 of the run's 9 tasks, and it caused the ts HARD FAIL.

### The lever, and why it is a second pass and not a wider first one

`src/task/refuted-constraint.ts` already deletes a refine-invented constraint that
research refutes, subtractively, before compose. Its mechanics fit — `dropToken`
even collapses an emptied `(e.g., )`. Three things it does not do:

- it reads research **CONTEXT** only, and two of the three fires are in **APIS**;
- its negation set is about **need** ("no `X` dependency is needed"), not about
  **deprecation**;
- `isPackageToken` rejects an API expression on purpose, and the zod constraint's
  `z.string().email()` is an un-backticked API expression, not a package.

The hs case is the easy half: `` `wai-test` `` is backticked and is a package, so
only the source section and the negation family are missing. The ts case needs a
token class the existing pass deliberately refuses, so widening that pass would
loosen the dependency channel it was built to keep narrow. A sibling pass.

### BUILT — `src/task/deprecated-constraint.ts`, chained after the sibling

Same shape, same invariant (`inv-no-line-invention`: the output is a character
subsequence of the input). Three rules, and each one was forced by a real string
rather than chosen:

- **Sources.** research `APIS` *and* `CONTEXT`. Two of the three fires are in APIS.
- **`marker-adjacent`.** A call expression (`z.string().email()` — at least one `.`
  and one `()`) whose deprecation marker sits **ahead of it in the same clause**.
  Forward-only, so "X is deprecated, use Y" never indicts Y.
- **`apis-symbol`.** An APIS row is `symbol␣␣description`, so the row's leading
  symbol is what the row is about — used **only** when no expression sits next to
  the marker. On `z.email()  … (z.string().email() … is @deprecated)` the leading
  symbol is the replacement, and the adjacent expression is the casualty.

Re-measured on the same corpus, with the shipped code rather than the probe:

```
13,997 task files scanned  (the 9 recorded run tasks folded in)
12,568 with a non-empty CONSTRAINTS and a research section
     3 fires        <- the same 3, 3 of 3 TRUE, 0 false
```

`apis-symbol` is load-bearing, not decoration: without it the sweep returns **2**
fires, losing hs/TASK_0001 entirely.

**The character window was measured and DELETED.** The first cut bounded the
marker to N characters past the token. Swept at 20/30/41/50/60/80/120/160/240/400/
800/4000 it is **flat from 41 to 4,000** — every value in that range returns the
same 3 fires — so the corpus cannot choose one and any pick would be a guess. The
clause boundary (`;` `(` `)` em/en dash `. `) reproduces all 3 with no constant,
and it is what actually stops `z.email()` at the head of the ts line from
inheriting the verdict on the expression inside its own parenthetical.

Applied to the three real artifacts, chained after `applyRefutations`:

```
ts/TASK_0001  … `adminEmail` — an email (e.g. z.string().email()). All three …
           ->  … `adminEmail` — an email. All three …
ts/TASK_0002  … `adminEmail` `z.string().email()`).   ->  … `adminEmail`).
hs/TASK_0001  … must additionally include `wai-test` on top of `aeson` …
           ->  … must additionally include on top of `aeson` …
```

The hs result is grammatically mangled and deliberately left that way: the pass
may only delete, and the sibling's `dropToken` behaves identically wherever a
token is not in a list. It no longer *requires* the unresolvable dependency, which
is the whole job.

**Residue, stated so it is not rediscovered as new.** The drop touches CONSTRAINTS
only. GOAL still restates `wai-test` and `z.string().email()` verbatim, because
GOAL is refine's copy of the raw prompt and rewriting it is not a deletion this
pass can make. Whether that residue is enough to re-cause the failure is exactly
what the live run measures.

`bun run test` 4388 pass / 0 fail; `npm run lint:check` green.

**Still needs the full run.** This is the one item where the subagent harnesses
cannot see the outcome.

---

# Gray areas in the subagent approach

Four, and each one bounds a claim a replay can make.

**Query generation is frozen.** All 158 recorded pairs are distinct — no query has
ever repeated across four runs. The query is a tool parameter written by the
calling worker, not by the docs worker. So a replay measures extraction over a
fixed query set and can say nothing about whether a fix changes *what gets asked*.
The headline metric of this whole exercise, abstention rate per package, is partly
a property of the caller. **A subagent harness cannot reproduce that number.**

**There are two docs paths and only one has a child.** `external-context.ts` calls
`docsRaw` directly with `docsQuery` — the first non-empty line of the refined
request — and pastes raw chunks into plan context. No extraction, no answer log.
Defects 1 and 2 lived there. "The docs subagent" does not name it.

**Retrieval is environment-dependent, extraction is not.** Container and host
returned different chunks for the same query, and that moved a decided A/B cell
from rung 1 to rung 2. Any retrieval-side harness runs in the container against
pinned deps or its verdict is about the machine. Replay off `retrievedText` is
immune, which is exactly why the field exists.

**85 of 158 records cannot be replayed.** The baseline and re-run 1 predate
`retrievedText`. They keep the sha and nothing to check it against.

---

# Two standing cautions about the instrument

**The recall metric could score a symbol the run never asked about — FIXED, and
the fix exposed that the metric is saturated.**

`scotty:ActionM` was reported missed in re-run 3. It is indexed, a query naming it
retrieves it, and no scotty query in that run named it. The gate was the PACKAGE:
ask about scotty at all and every scotty truth symbol is scored.

It is now the SYMBOL. A truth entry counts when a query named it, or when an
answer carried it anyway — the second half matters, because the tool volunteering
the right name is the behaviour being measured and gating that away is the
opposite error. `scoreRecall` is extracted and unit-tested; four tests, all of
which fail on the old package gate.

Re-scored over all four recorded runs it moves **exactly one cell**:

```
run 1   ts 4/4  rs 3/3  hs 4/4        unchanged
run 2   ts 4/4  rs 3/3  hs 2/2        unchanged
run 3   ts 4/4  rs 3/3  hs 2/2        unchanged
run 4   ts 4/4  rs 4/4  hs 3/4 -> 3/3   scotty:ActionM dropped
```

**And that is the real finding.** 43 of 44 before the fix, 44 of 44 after. A metric
that reads 100% in eleven of twelve cells across four runs and three ecosystems is
not measuring anything — it is the "verify that cannot fail" this file has caught
twice already. The correction is worth having because a false miss sends the next
session hunting a defect that is not there. The number itself should stop being
quoted as evidence.

**The fidelity scorer had known false-positive families.** Four are now guarded: a
language literal (`false`), a member of a language global (`stringify` of
`JSON.stringify`), a `node:` stdlib path (`promises` of `node:fs/promises`), and a
case-fold of a known symbol, covering both `adminEmail` for `admin_email` and
`router` for `Router`. Rescored over both recorded re-runs, flags fell **8 -> 4**:
ts 10/13 -> 11/13 and 13/15 -> 15/15, rs 5/7 -> 5/7.

Four flags are left and all are still false: `fields are` and `assert` are English
inside a code span, `error_value` is a placeholder binding in an example, and
`router` names axum's type inside a *tower* answer, whose corpus does not carry it.
No principled rule was found, so they stay flagged rather than guessed away.

---

# Run history

Artifacts in `live-docs-run-2026-09-05/`, `live-docs-rerun-2026-09-05/`,
`live-docs-rerun2-2026-09-06/`, `live-docs-rerun3-2026-09-06/`.

| run | build | ts | rs | hs |
|---|---|---|---|---|
| baseline 09-05 | pre-fix | PASS, 24% abstained | **HARD FAIL**, 29% | **HARD FAIL**, 55% |
| re-run 1, 09-05 | 0.40.2 | PASS, 7% | PASS, 20% | PASS, 80% |
| re-run 2, 09-06 | 0.40.3 | PASS, 24% | PASS, 40% | PASS, 83% |
| re-run 3, 09-06 | 0.40.5 | **HARD FAIL**, 17% | PASS, 22% | PASS, 46% |

Read the verdict the right way round. TypeScript passed the baseline *with* three
hono non-answers, because the model knew hono already. A green run does not mean
the docs tool worked. It means the tool's failures were survivable that time.
Haskell is the honest test, because there the model had nothing to fall back on.

Two things held in every run. The abstention path is honest, and version resolution
is exact — 7/7 pins from three version sources, no run drifted off a pinned major.

Baseline abstention per package, which is what a full re-run diffs against:

```
hs   aeson            11 calls,  8 abstained     73%
hs   scotty            7 calls,  3 abstained     43%
ts   hono              6 calls,  3 abstained     50%
rs   axum              6 calls,  2 abstained     33%
rs   tower             4 calls,  1 abstained     25%
ts   zod               5 calls,  0 abstained      0%
```

---

# Closed defects

| # | defect | fix | measured |
|---|---|---|---|
| 1 | Backticked filenames installed from npm as packages | enrich only declared deps; research no longer fans packages out to a docs body | 45 bogus names pre-fix, 0 after; cache holds only real deps in three re-runs |
| 2 | Answered about undeclared transitive dependencies | per-ecosystem `manifestDeps`; `[DEPENDENCY]` banner | `tower` warned in re-run 2, the run that finally reached for it |
| 3 | Retrieval could not follow a type alias | `hopNames` / `definitionChunk` fetch the definition behind a ranked alias | hono `HandlerInterface` signature arrived with the `get:` alias; 3 abstentions -> 0 |
| 5 | A dead major indexed as current | `dropDeadMajors` skips a mismatching top-level `vN/` | zod 414 `v3/` chunks -> 0 |
| 6 | Every `.d.cts` a second copy of its `.d.ts` | `dropParallelDeclarations`, and the file-selection rule joined the content hash | zod 2565 chunks -> 1078 |
| 7 | A chunk cut in half by a match inside a match | `splitAtMatches` refuses to cut inside the last accepted match | serde 448/98 dupes -> 297/0; axum 475/27 -> 381/0 |
| 8 | Index hash did not cover the chunker | chunker source is in `computeContentHash` | every package re-indexed on first touch in re-run 2 |
| 9 | `0 invented symbols` was a verify that could not fail | scored against `retrievedText`, not the answer's own text | 54/54 pre-fix; first real number was 13/20 |
| 10 | The fidelity scorer failed the correct answer | skip a denying sentence; accept a Haskell prime whose stem the corpus knows | 17 flags -> 4, all benign. Zero real fabrications in 20 |
| 13 | No `.gitignore` in the seeded projects | `docs-live-seed.ts` writes one | 1397 tracked build files -> 0, 0, 0 |

