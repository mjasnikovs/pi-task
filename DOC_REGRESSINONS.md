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
| **defines** — `scripts/docs-defines.ts` | `docsRaw` only, scored on whether a chunk DEFINES the queried symbol | seconds, no model | container, pinned deps |
| **replay** — `scripts/docs-replay.ts` | extraction only, on recorded `retrievedText` | minutes | any, same model |
| **full run** — `DOCS-LIVE-RUNBOOK.md` | `/task-auto` end to end | 3-4 h | container |

The defines harness is the one to reach for first. It needs no model, it runs in
seconds, and it is the only quality metric here that is not saturated — see "The
metric that finally moves" below.

## The replay corpus already exists

186 recorded answers over five runs. `retrievedText` was added with the defect 9
fix, so **101 of them replay with no retrieval at all** — re-runs 2, 3 and 5.

```
101 records   32 abstentions   24 excerptVerified=false   23 modules, 3 ecosystems
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

# Still open — and nothing is

Every row below is shipped, refuted, or filed with its mechanism named. The
loop's rule for that state is at the top of this file: the full run in
`DOCS-LIVE-RUNBOOK.md` is the only remaining DISCOVERY instrument, and the last
one paid — re-run 4's three HARD FAILs produced defects 19, 20, 21, 22 and 23.

| # | item | half | instrument | state |
| 4r | a query naming no type has nothing to hop to | retrieval | recorded corpus | **REFUTED**, 1 of 158 and it is junk input |
| 11 | English question loses the declaration | both | retrieval + replay | **closed**: `from_str` fixed, `IntoResponse` is defect 16 |
| 12 | a facade package indexes to nothing | both | retrieval + replay | **closed on hackage**, 3 of 4 answered |
| 14 | correct answer, deprecated code shipped | neither | **full run** | lever SHIPPED, 3/3 on 12,568 files; the condition did NOT recur in re-run 4 |
| 15 | child abstains with the answer in hand | extraction | **replay** | **SHIPPED**, p=0.0386 paired over 73 |
| 16 | a facade package indexes to nothing, in **cargo** | index | retrieval | **SHIPPED** on retrieval; answer half replayed FLAT at n=4, no recorded stimulus |
| 17 | retrieval depends on the cache's other packages | retrieval | retrieval | **real, and measured harmless** |
| 18 | one answer in five carries a false hallucination warning | extraction | recorded corpus | **SHIPPED**, 21/21 now report stitched |
| 19 | a symbol declared only in a NON-prefixed dependency | both | recorded corpus | caused the rs HARD FAIL; **BOTH bounds REFUTED** — `[dependencies]` 2 right of 20, lock 3 right of 18 |
| 20 | a Rust item inside a `name! { … }` block is not indexed | index | offline + replay | **SHIPPED**, +393 public names; one causal answer, no aggregate at n=14 |
| 21 | `export declare function` never started a chunk | index | offline + retrieval | **SHIPPED**, defining chunks 16/62 -> 34/62 paired, p=1.2e-4 |
| 22 | on hackage a package's own name has ~0 IDF | retrieval | retrieval | found and MECHANISED; no lever without an FTS schema change |
| 24 | the value hop lands on the chunk whose PATH says the name | retrieval | retrieval | **FIXED**; dropping the shape gate REFUTED, 90/101 -> 88/101 |
| 23 | a class chunk is 50x the median and BM25 buries it | retrieval | retrieval | found and MECHANISED; the tempting lever orphans signatures |
| — | a key symbol absent from the corpus | retrieval | — | **limit, not a defect** |
| — | aeson keeps 55 duplicate bodies | index | offline | **measured fixed** |

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

That happened three times in one session, always the same way — a one-line filter
believed without opening what it selected:

```
symbol classifier    called Bun.file and decodeFile "nameless"     -> a fake 68% gap
excerptCheck.ok      the field is `verified`; `ok` is undefined    -> "0 failures" for 20%
grep -c docs         matched `read: docs-live-hs.cabal`            -> "5 refusals" that were file reads
#\s*[A-Za-z_(]       matched `# use` in a doctest                  -> real cfg_rt! items called templates
\bGToJSON'\b         `\b` after `'` needs a word char next          -> 10 aeson classes "lost" that are present
a top-level head RE  `issues` and `json` are MEMBERS                -> npm read 45% when it is 90%
a case-SENSITIVE RE  fts5 folds case; the index does not care       -> scotty's df read 3.9%, not 99.4%
```

None survived looking at the rows, or at the index. Every one would have been a
believable number.


## The metric that finally moves: `scripts/docs-defines.ts`

Every quality metric this file had was saturated. Recall reads 43/44 across four
runs; "the ground-truth symbol is MENTIONED" reads **101/101** on every arm of
every comparison, because a package's own doc comments name it constantly.
Neither can decide anything.

A chunk **DEFINES** a symbol when its own first declaration head names it — or,
for a member, when a chunk declares it as a field or method. That one moves, and
it needs no model: it is the index and the recorded queries.

It chose defect 21 (16/62 -> 34/62 paired, p=1.2e-4), chose the retrieve limit
against a sweep, and mechanised defect 22 below. It is a real harness now, with
its own tests, and it re-retrieves — so it runs in the container against pinned
deps with the cache's package set held fixed.

```bash
bun scripts/docs-defines.ts recorded/*.jsonl --project ts=… --project rs=… --out a.jsonl
bun scripts/docs-defines.ts --compare a.jsonl b.jsonl      # paired, exact McNemar
```

The whole recorded corpus, on 0.40.12:

```
cargo   26/26 (100%)     npm 38/42 (90%)     hackage 26/33 (79%)
                                   mentioned: 101/101 in all three

  aeson:FromJSON      16/16     axum:Router     12/12     zod:issues     11/11
  axum:Json             7/7     serde_json:from_str 6/6   zod:safeParse    7/7
  scotty:ActionM        4/4     tokio:TcpListener   1/1
  hono:Hono           12/14     hono:json           8/10
  aeson:eitherDecode    4/6     scotty:scotty       2/7   <--
```

### "A multi-topic query dilutes retrieval" — REFUTED

`eitherDecode` is declared in exactly one 97-byte chunk of aeson's 1,283, and its
two misses are both queries that ask about five things at once. The obvious
reading — that a batched query splits the eight-chunk budget and finds none of it
— does not survive the corpus:

```
symbols named in the query   pairs   defined   rate
  1-4                          68       62      91%
  5-8                          27       22      81%
  9-12                          4        4     100%
 13+                            2        2     100%
```

Not monotone, and the wide buckets are 4 and 2 pairs. Query breadth does not
predict whether the declaration is retrieved. The two `eitherDecode` misses are
misses, not a class — filed so the plausible story is not retold as a finding.

## What the whole 2026-09-06 session did to retrieval — one paired number

0.40.8 (session start) against HEAD, the defines harness, every recorded query
that names a ground-truth symbol, one cold cache per arm:

```
              0.40.8    HEAD
cargo          26/26    26/26
hackage        26/33    26/33
npm            28/42    38/42

paired over all 101:  both 78   only-0.40.8 2   only-HEAD 12   neither 9
                      80/101 -> 90/101
                      McNemar exact, two-sided:  p = 1.294e-2
```

Twelve gained against two lost. All of the movement is npm and all of it is
defect 21 — cargo was already saturated at 26/26 and hackage's residue is defects
22 and 23, neither of which has a lever. Defect 20's gain does not show here
because the corpus holds exactly one `tokio` pair; its evidence is the causal
answer instead.

## The cargo facade fix created a scorer false positive — found and closed

re-run 5 flagged an rs answer for inventing `axum_core`. It had not. Defect 16
files a supplement's chunks under the crate's **published** name —
`axum-core-0.5.6/src/…` — while Rust code writes `axum_core`, and `eco-cargo.ts`
already treats the two spellings as one crate. The fidelity scorer did not.

`caseFold` stripped `_` and lowercased; it now strips `-` as well, and both the
corpus and the answer are scanned for hyphenated runs, which `IDENTIFIER_RE`
otherwise splits into two words the corpus knows as neither.

```
101 scored records across runs 2, 3 and 5
flags  8 -> 7      only `axum_core` cleared
remaining: fields, are, assert, rename, error_value, router, config — all false,
           all the query-echo and English-in-a-code-span families already on file
```

Worth stating plainly: this was a false number **my own fix produced**, and it
would have been read as the docs tool fabricating a crate name.

### Widening the harness's denominator — REFUTED as a cheap lever

The limit question landed at p=0.0703 because n is 101 pairs, so the obvious move
is a bigger denominator: derive the truth set from the index — every symbol a
recorded query names that the package actually declares — instead of the twelve
hand-listed `TRUTH` entries.

```
declared-name sets:  zod 1,302   hono 811   aeson 558   tokio 348   axum 171
                     scotty 170  serde_json 94

derived pairs, heads only        116
derived pairs, heads + members   124        hand-listed TRUTH gives  101
```

**+23% for real complexity and a circularity risk** — the declared set would have
to be pinned to one reference index, or the two arms of a comparison would score
against different denominators. `hono` contributes 2 pairs either way, because its
queries ask about members of members.

n is bounded by the recorded corpus, not by the truth set. The way to grow it is
more recorded runs, which is the discovery loop.

## Defect 24. The value hop lands on the chunk whose PATH says the name

re-run 5's one rs abstention asked for `axum::serve`'s signature. `pub fn serve`
is indexed — one 399-byte chunk of 437 — and `serve` is in only 33 of them, so
the term discriminates. It was not retrieved.

`valueChunk` takes the SHORTEST chunk carrying the name, on the reasoning that a
declaration is short and the chunks that merely mention a name are long. Its
smallest-first candidates for `serve`:

```
   50B  header=Y body=n   src/serve/listener.rs   pub struct TapIo<L, F> {}
   67B  header=Y body=n   src/serve/listener.rs   /// Types that can listen…
   91B  header=Y body=n   src/serve/mod.rs        #[derive(Debug)]
  102B  header=n body=Y   src/lib.rs              pub mod serve;
  ...
  399B  header=Y body=Y   src/serve/mod.rs        pub fn serve<L, M, S>(…)
```

Eight of the twelve shortest match on the **`// path` line the indexer prepends** —
defect 22's mechanism one level down, inside the hop rather than inside BM25. And
the first that matches on its body is `pub mod serve;`, which is neither the value
nor the type this hop exists to find.

**FIXED, both halves.** The whole-word test runs on the body, and a chunk that
only declares a module is skipped. The regression test fails on the old code.

### The other half is REFUSED on purpose, and the file already said why

Even fixed, the hop never fires for `serve`, because `hopNames` gates on
`IDENTIFIER_SHAPED` — a capital, an underscore, or an internal capital — and
`serve` has none. That rule's own comment states the trade: "Widening to every
token instead would hop on `signature` and `return`, spending a slot on whichever
prose chunk is shortest."

It looked expensive. Of the eleven misses the defines harness leaves:

```
bare lowercase, refused by IDENTIFIER_SHAPED   scotty:scotty (5)  hono:json (2)   = 7
identifier-shaped, refused by nothing          aeson:eitherDecode (2)  hono:Hono (2) = 4
```

Seven of eleven — an upper bound on what dropping the gate could recover.

**MEASURED, and it goes the other way.** Two arms of the same tree, the gate the
only difference, the defines harness over all 101 pairs:

```
                       cargo    hackage    npm     total
shape gate (shipped)   26/26     26/33    38/42    90/101
no gate                23/26     26/33    39/42    88/101

paired:  both 87   only-gate 3   only-no-gate 1   neither 10
         McNemar exact, two-sided:  p = 0.6250
wall clock:  18.1s vs 19.0s
```

Dropping it **loses three and gains one**, and cargo falls from 26/26 to 23/26.
The hops sit at the FRONT of the content budget, so an extra hop does not add a
chunk — it displaces a better one. And cost was never the objection: the two arms
run in the same time.

`hopNames`' own comment was right, for a reason it did not state: the harm is not
that a hop on `signature` is slow, it is that it spends a slot. Refuted, and the
gate stays.

## Defect 23. A class chunk is 50x the median and BM25 buries it

The four npm misses the defines-metric leaves are all hono, and one is clean:

```
query   "Context class `c.json()` helper: method signature, accepted data type,
         optional status code parameter, and returned Response content-type"
        11 chunks retrieved, 5,804 B, and no chunk declares `json`
```

The declaration is indexed. `dist/types/context.d.ts` holds
`export declare class Context { … json(…) … }`, and six hono chunks declare
`json` as a member. It is a RANKING miss, and the mechanism is size:

```
hono chunk bytes:   min 51    median 153    p90 567    max 8,192
the Context chunk:  7,520 B   —  49x the median
its rank for that query:  10        PACKAGE_RETRIEVE_LIMIT: 8
```

BM25 normalises for document length, and a 7.5 KB chunk in a corpus whose median
is 153 bytes is penalised hard. The chunk that holds the member declarations is
pushed to rank 10 and the cut is at 8.

**This is one of the three the limit sweep found.** 8 -> 16 recovers it, which is
why the plateau sits at 16 — and at 3 of 62, p=0.25, that is still not enough to
double the payload. The mechanism is recorded so a future session with more data
can decide it on more than a p-value.

**The tempting lever is worse than the problem.** Splitting a class body into
member-sized chunks would even out the distribution and orphan every signature
from its receiver type — which is precisely the bug `CARGO_DECL_SPLIT_RE`'s own
comment records paying for once ("an orphan signature with no receiver type,
carrying the next method's doc comment"). Filed with the mechanism, no cheap
lever.

## Defect 22. On hackage, the package's own name has no ranking power at all

**Why `scotty` cannot find `scotty`.** The declaration exists, once:

```
1 chunk of 311 declares it:  "-- Web/Scotty.hs\nscotty :: Port -> ScottyM () -> IO ()"
```

And the token that should find it is worthless — measured against the FTS index
itself, which is the only thing that decides ranking:

```
    MATCH "scotty"  within scotty      309 / 311     99.4%
    MATCH "aeson"   within aeson      1282 / 1283    99.9%
    MATCH "hono"    within hono        169 / 1124    15.0%
    MATCH "zod"     within zod         214 / 1956    10.9%
    MATCH "axum"    within axum        109 / 437     24.9%
```

Where it comes from, counted over the chunk text by hand:

```
scotty chunks carrying the name:   288 in the chunk HEADER only, 6 body only, 15 both
aeson                             1244 header only
```

**Measure this through the FTS, never with a regex.** A case-sensitive regex reads
scotty at 3.9%, because it will not match `Scotty` in `-- Web/Scotty.hs` — and
fts5's default `unicode61` tokenizer folds case, so the query token certainly
does. Off by a factor of twenty-five.

The indexer prepends `-- Web/Scotty.hs` to every chunk. Haskell paths carry the
package name, so after indexing, the package's own name has a document frequency
of ~100% *within that package* — and BM25 gives a term in every document
essentially no IDF. The single most important token in the query ranks nothing.
npm does not have this (zod: 1% of chunks) and cargo barely does (axum: 21%),
because their paths are `dist/index.d.ts` and `src/response/mod.rs`.

**No cheap lever, and the reason is on record.** Stripping the package name from
the indexed header would restore its IDF — and would break the path matching that
was measured as a WIN (the tokenizer fix took path matching 82% to 99%), including
one of these six queries, which literally asks "From
`Web/Scotty/Internal/Types.hs`". Separating header and body into weighted FTS
columns would do it properly and is an FTS schema change, not a patch.

Filed with the mechanism named, which is the improvement over where this sat
before — "a query whose key symbol is absent from the corpus" was the nearest
previous description and it is not the same thing. Here the symbol is present.

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

**Cost.** axum goes 381 chunks to 401 — twenty, because rule 3 keeps only the
hole. The `packages` table still holds exactly `axum`: a supplement is folded into
the asking crate's rows and never registered as a package of its own.

Five tests mirror the hackage ones on a `tiny-axum`/`tiny-axum-core` fixture, and
three of the five were confirmed to FAIL with the hook commented out. The two that
survive are the negative guards ("the trait is absent alone", "the unrelated
helper is never indexed"), which is what a negative guard is supposed to do.

**Two bugs found by self-review after the measurement, both machine-shaped.**

- `useTargets` stripped all whitespace, so `Inner as Outer` became `InnerasOuter`
  and the rename split had to guess — which turned `Hasher` into `H`. Whitespace
  is normalised now, and a rename's SOURCE name is the hole.
- The supplements hook read `lockedDeps(pkg.root)`. `findLock` walks UPWARD, and a
  crate unpacked under `~/.cargo/registry` sits below whatever lock happens to be
  above it: on this machine that resolved `axum-macros 0.5.1`, a version the
  project never pinned. It reads the PROJECT's lock now, `axum-macros` correctly
  drops out, and axum indexes to 401 rather than 403. **This is the machine-
  dependent index `DEFECT-12-STOPPING-RULE.md` refuses, and the twenty-two-crate
  sweep could not see it** — the sweep read manifests directly and never called
  the hook.

**One thing fixed in passing, in both ecosystems.** `supplementCandidates` sorted
with `localeCompare`, which orders `-` and `_` differently under a different
`LANG` — and that sort decides the order supplement chunks enter the index. Both
call sites now compare code units. A machine-dependent index is the exact failure
`DEFECT-12-STOPPING-RULE.md` refuses elsewhere.

### The ANSWER half — replayed, and it does NOT move

Two arms of the same tree, differing only in whether the cargo `exportGap` hook is
wired. Same chunker, same prompt, same model, one cold cache each holding only
`axum`, so defect 17 is controlled. Every recorded `axum` record carrying
`retrievedText` — 4 of 10 — through `docs-replay.ts --retrieve`.

```
                       chunks        bytes            names IntoResponse   names oneshot
query 1  Router::new    13 -> 13   20,694 -> 20,694        1/2 -> 0/2         2/2 -> 2/2
query 2  tower::Service 19 -> 19   22,421 -> 22,987        2/2 -> 1/2         2/2 -> 1/2
query 3  body::to_bytes  9 ->  9   10,081 -> 15,178        0/2 -> 0/2         0/2 -> 0/2
query 4  http::Request  14 -> 14   15,892 -> 16,381        1/2 -> 1/2         1/2 -> 1/2
                                                    abstentions 3/8 -> 4/8
```

**The chunk count never changes and the byte count does**, on 3 of 4 — the
supplement's declarations compete for the same slots, and one query's corpus grows
50%. So the retrieval change does reach these records. The answers do not follow:
flat or slightly worse on every axis, at n=4.

**And the reason is the stimulus, not the fix.** None of the four recorded queries
asks what the fix answers. They ask how to build a Router, how to read a body, what
`http::Request` is. The queries that go from no-declaration to `trait IntoResponse`
are the ones written by hand for the probe. **There is no recorded stimulus for
this fix**, so the honest state is retrieval-proven, answer-unproven, and not
provable from this corpus.

**What this does not claim** — the same caveat the hackage half carries. This is a
retrieval-side result. Defect 11 is the standing proof that a better index is not
a better answer.

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

**Residue — measured, and it splits the two cases cleanly.** After the drop, is
the token still anywhere in the prompt?

```
                       GOAL  KNOWN-UNKNOWNS  EXTERNAL-DEPS  RAW PROMPT
ts/TASK_0001  z.string().email()   no    no    no    no
ts/TASK_0002  z.string().email()   no    no    no    no
hs/TASK_0001  `wai-test`          YES   YES   YES   YES
```

**The zod case — the one that caused the ts HARD FAIL — is removed completely.**
It appears nowhere else, because refine invented it: it is not in the raw prompt
at all.

**The Haskell case cannot be closed this way, and should not be.** `wai-test` is
in the RAW PROMPT — the user pinned it by name, in a decision line that says
"add wai-test to the test-build-depends". Refine invented nothing. A CONSTRAINTS
drop leaves GOAL, KNOWN-UNKNOWNS and EXTERNAL-DEPENDENCIES still naming it, so the
pass is inert there by construction, and rewriting a user's own words is not a
deletion this pass may make. That run's grill auto-answer resolved it correctly on
its own.

So the lever's real reach is the refine-invented half, which is the half the
`refuted-constraint.ts` sibling was also built for. Stated here rather than
discovered again.

`bun run test` 4388 pass / 0 fail; `npm run lint:check` green.

**Live precision, ts, 2026-09-06 run.** Six tasks, **two** carrying a real
deprecation claim in research, **zero** fires — and both non-fires are right:

```
TASK_0003  research: ".strict() exists but is deprecated in favor of z.strictObject({...})"
           `.strict()` appears in KNOWN-UNKNOWNS, not CONSTRAINTS
TASK_0005  research: "flatten() — deprecated in zod v4 (use z.flattenError)"
           the constraint says "Do NOT use z.flattenError" — it requires nothing deprecated
```

Checked against a deliberately loosened token class (leading-dot expressions
admitted, which turns `.strict()` into a candidate) and it still does not fire,
because the section gate holds independently of the token class. Two guards, not
one.

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

## The dead-major fix held — checked on the ANSWERS, not the code

The stale-major table has only ever been run over the shipped tree. Run over the
answer text of all 158 records instead:

```
7 answers contain a stale marker
  2 are project-corpus answers correctly REPORTING what the project's own code says
  3 mention `z.string().email()` only to say `z.email()` is the v4 form
  2 assert the v3 shape — "z.string().email() is confirmed — ZodString.email(message?)"
    both in the BASELINE run, before dropDeadMajors shipped
```

Zero genuine stale assertions in any run after 0.40.2. That is the dead-major fix
confirmed on the output rather than on the index it changed — which is the
distinction defect 11 exists to enforce.

## Three of the audit's six metrics have never once discriminated

Written down so the next session does not quote a number that cannot move. Across
all twelve project-runs:

| metric | history | verdict |
|---|---|---|
| build + stale markers | 6 HARD FAIL, 9 PASS | **the instrument** |
| abstention rate | 0% to 100% | moves, but not on the tool — and re-run 4's ts was 0% and HARD FAILed |
| answers with 0 invented symbols | 4 runs flagged, every flag false | fires, never truly |
| retrieval recall | 43/44, and the 1 was a scorer bug | **saturated** |
| pins resolved | 7/7 in every run, three version sources | **saturated** |
| refusals in research | 0 in 11 of 12; one run had 1 | **saturated** |

Two of the three are saturated because the thing they watch really does work —
that is worth knowing once, and it is known. Reporting them each run is noise, and
worse, a false miss in a saturated metric (as recall had) sends a session hunting a
defect that is not there.

## Abstention does not track how much was retrieved — measured

The obvious reading of a rising abstention rate is that retrieval starved the
child. Over the 73 replayable records it is not so:

```
abstained  n=24   median 16,386 B retrieved
answered   n=49   median 16,714 B
Mann-Whitney U=480, z=-1.27, p=0.20
```

The two distributions sit on top of each other. Retrieval size is not what decides
whether the child answers, which is the numeric form of the caution this file has
carried since re-run 1 — hs abstention went 55/80/83/46 across four runs and the
tool was not why. Do not spend a round tuning the retrieval budget on it.

For the same reason the byte budget is not the binding constraint either: median
16 KB against a 24 KB cap, p75 at 20.8 KB, and exactly one record in 73 under
200 B. That one is the manifest case below.

## The project corpus cannot see a manifest — measured, and below the bar

`projectGlobs` is source only: `*.ts`/`*.tsx`, `*.rs`, `*.hs`. A `.cabal`,
`Cargo.toml` or `package.json` is never indexed, so a worker asking the project
corpus what the manifest declares is asking about a file the tool does not hold.

Found by reading the smallest retrieved corpus in the whole set — 89 bytes, two
stub `main = pure ()` bodies, against a query asking what the cabal file declares.

```
25 project-corpus records
 2 ask about a manifest   <- 1 abstains, 1 correctly denies ("not in the provided content")
                             2 of 2 unanswerable, 1.3% of all 158 records
```

**Not fixed, deliberately.** Two records in 158 is the same order as item 4r,
which closed as refuted, and the fix is not the one-line glob it looks like: a
manifest has no declaration syntax for `declSplitRe` or `surface` to cut, so
adding it to the globs without a chunking story trades an honest abstention for
garbage chunks. Reopen it if a run ever shows the question being asked often.

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

**A fifth candidate — MEASURED, NOT SHIPPED.** The 2026-09-06 full run flagged a
zod answer for `port`, `adminEmail` and `checkEmail`. Two of those are the
project's own config field names, echoed straight out of the query, and the answer
asserts nothing about zod by naming them. That suggests the guard "a token the
QUERY already contains was not invented by the answer".

Scored over all 73 replayable records:

```
6 flags, all false.   query-echo clears 2 (`fields`, `rename`).   4 remain.
```

It is not shipped, and the reason is the corpus rather than the rule. **There is
not one confirmed fabrication in the recorded corpus** — the `decodeFile` case
this file cites turns out to be seven records that all DENY it ("the provided
content does not contain a function named `decodeFile`"), never one that asserts
it. So the guard can be shown to clear false flags and cannot be shown to preserve
a true one, and a loose scorer is as fatal as a strict one. Left flagged.

The live number it distorts is worth knowing about: quoting a fidelity rate from
a run whose project uses `port` and `adminEmail` as field names will read three
flags low on quality it did not lose.

## Defect 21. `export declare function` never started a chunk

Defect 20 asked what the CARGO extractor treats as opaque. The same question of
npm's chunker: `DECL_SPLIT_RE` alternated the modifiers —
`(?:export\s+|declare\s+)?` — so `export` and `declare` were mutually exclusive.

`export declare function` is what `tsc --declaration` emits for every exported
function in a module.

```
4,000 .d.ts files sampled from installed packages
6,935 `export declare` lines        of which  3,479 function
                                              2,075 const
                                                478 interface
                                                448 class
                                                263 type
    0 of them start a chunk
```

`export declare abstract class` missed on a second count, and so did the bare
`declare abstract class`.

**What that costs, seen in a real file.** `undici-types/fetch.d.ts`:

```
chunk 2 begins   "export type RequestInfo = string | URL | Request"
and contains     "export declare function fetch(" 
```

Nothing can retrieve the chunk that DEFINES `fetch`, because there is no such
chunk — the declaration is a tail of the one above it. With no split point a
file falls back to the 8 KB size cap, so declarations are severed mid-signature
at arbitrary offsets.

**Fixed by making the modifiers sequential** rather than alternatives, and adding
`abstract`. Over the 1,569 sampled files that contain an `export declare`:

```
chunks  5,237 -> 10,436   (+99.3%)
bytes   2,916,982 -> 2,937,677   (+0.7%)
```

Bytes barely move, which is the point: nothing is duplicated, the same text is
cut where a declaration begins. Through the real `docsRaw` in the container:

```
zod    1,078 -> 1,956 indexed chunks
hono     708 -> 1,124
"Hono class constructor"   retrieved chunks that BEGIN at a declaration: 2/8 -> 7/8
```

All four ground-truth probes still hit.

### The cost, measured before publishing — and it is NOT yet paid for

Smaller chunks in a chunk-COUNT budget means less text reaches the child. Eight
queries over zod and hono, same cache discipline:

```
                                   before      after
retrieved chunks                     65          66
retrieved BYTES                  82,151      50,768   -38%
"Hono class constructor"         11,324       1,749   -85%
"z.object schema definition"      7,253       1,209   -83%
```

**`PACKAGE_RETRIEVE_LIMIT = 8` is the binding constraint, and it is an unmeasured
constant.** `docs-retrieve.ts` says so in its own header: "Nothing in this repo
records WHY they differ" (8 for a package, 50 for project source). The byte budget
is 24,000 and retrieval now uses 7% of it.

### And it IS paid for — measured on a metric that needs no model

The question the byte drop raises is not "how many bytes" but "does retrieval
still return the chunk that DEFINES what was asked about". That is answerable
from the index alone.

Every recorded `zod` and `hono` record — 37 of them, four runs — re-retrieved in
both arms, in the container, with the cache holding only those two packages so
defect 17 is controlled. A chunk **defines** a symbol when its own first
declaration head names it.

```
                                  before      after
retrieved chunks                     365         373
retrieved bytes                  614,143     451,716    -26%
ground-truth symbol MENTIONED      62/62       62/62    saturated, as always
a retrieved chunk DEFINES it       16/62       34/62
```

Paired over the same 62 (record, symbol) pairs:

```
both 14    only BEFORE 2    only AFTER 20    neither 26
McNemar exact, two-sided:  p = 1.2e-4
```

**The 26% of bytes buys more than double the definitions.** The two losses are
real and stated: a smaller chunk can be outranked where a large slab happened to
contain the declaration by accident. Twenty gained against two lost.

`bun run test` 4430 pass / 0 fail; `npm run lint:check` green.

### `PACKAGE_RETRIEVE_LIMIT` — swept TWICE; the first sweep was too narrow

The sweep below covers npm only (zod and hono), and on that corpus the metric
plateaus at 16. **Re-swept over all 101 pairs across three ecosystems it does
not**, and the earlier "plateau at 16" is wrong as a general statement:

```
limit   defines/101    retrieved bytes    calls at the 24,000 budget
    8      91           992,119            6/74
   16      91         1,244,766           10/74
   24      93         1,381,753           16/74
   32      93         1,473,829           24/74
   50      97         1,562,283           29/74
  100      97         1,645,710           38/74

paired against 8:   16  only-8 1  only-16 1   p = 1.0000
                    24  only-8 1  only-24 3   p = 0.6250
                    50  only-8 1  only-50 7   p = 0.0703
```

**Monotone to 50 and flat after**, seven gains against one loss, and the mechanism
is defect 23: a big class chunk ranks 9-16 and hackage's declarations sit deeper
still. `PROJECT_RETRIEVE_LIMIT` is already 50, and this file records that nobody
knows why the two differ.

The retrieval side does not reach the bar on its own, and the cost is +57% of text
into the extraction child — the one thing it cannot see. So the ANSWER side was
run: `docs-replay --retrieve`, two arms at 8 and 50, every replayable record
across all three projects, 188 child calls.

### CHANGED to 50 — the answer side is decisive

```
arm      rows   chunks    retrieved bytes    ANSWERED
lim8       94      976        1,164,980      67/94
lim50      94    2,478        1,976,856      79/94

paired 94:  both 64   only-8 3   only-50 15   neither 12
McNemar exact, two-sided:  p = 0.0075
```

**Abstention falls 29% to 16%** — twelve records the child would not answer at 8,
it answers at 50, against three the other way. Both halves now agree and the one
that matters is significant.

The cost is +70% of retrieved text, and `RETRIEVE_CONTENT_BUDGET` still bounds
it. At 8 only 6 of 74 calls reached that 24,000-character budget, so two thirds of
what the tool was allowed to spend was never spent.

It also closes the divergence this file has carried unexplained since the start:
`PROJECT_RETRIEVE_LIMIT` was already 50, and nothing recorded why a package got 8.
Now both are 50, and the reason is a number.

### The npm-only sweep, kept because its conclusion is still true of npm

`docs-retrieve.ts` says in its own header that nothing records why a package gets
8 chunks and project source gets 50. Defect 21 made it the binding budget, so it
was swept on the same metric, over the same 37 records:

```
limit   chunks    bytes     defines/62   records at the 24,000 budget
    4      236   318,433      33            0/37
    8      373   451,716      34            0/37
   12      493   562,015      35            5/37
   16      594   647,921      37            7/37
   24      755   752,822      37           10/37
   32      854   809,322      37           18/37
   50      891   824,736      37           20/37
  100      891   824,736      37           20/37
```

The metric plateaus at **16** and never moves again. But 8 against 16, paired:

```
both 34    only-8 0    only-16 3    neither 25
McNemar exact, two-sided:  p = 0.2500
```

Three of sixty-two, none lost, and not significant. **Doubling the retrieved
payload for that is not justified**, so the constant does not move — it is simply
no longer a guess.

One fact worth keeping: **at 8, the byte budget never binds** — 0 of 37 records
reach 24,000 characters. The tool has always spent about a third of what it is
allowed. Raising the limit is therefore free of any truncation risk and costs only
the child's reading; if a future measurement on the ANSWER (not the index) shows
more text helps, 16 is where this metric says to stop.

### The other two split regexes were audited and are clean

The same question of cargo and hackage: which surface lines look like a
declaration head and do not start a chunk?

```
CARGO      252 misses, and ALL 252 are `pub use` — re-export statements, not
           declarations. Splitting on them would fragment the surface into noise;
           `use` is in ITEM_HEAD_RE and deliberately absent from the split regex.
HACKAGE    600 `--` comments and 126 `module` headers (both correct), 13
           `foreign import`, 4 `instance`, and ~10 signatures whose `::` wraps
           to the next line.
```

`foreign import` and the wrapped signatures are real misses, at roughly 23 in
three packages of several thousand declarations. Below the bar, and recorded so
the audit is not repeated.

## `dropDeadMajors` being top-level ONLY is load-bearing — measured

Defect 20's mirror: is npm's DROP too eager, or too shallow? Scanned 1,095
installed packages.

```
top-level `vN/` whose N mismatches the package major (DROPPED):  2
    zod@4.4.3 -> v3          zod-validation-error@4.0.2 -> v3
the same one directory deeper (NOT dropped):                     5
    zod@4.4.3 -> src/v3                    .d.ts = 0
    ip-address@10.0.1 -> dist/v4           .d.ts = 1
    ip-address@10.0.1 -> dist/v6           .d.ts = 3
```

**Making it recursive would be a serious regression, not a fix.** `ip-address`
is at version 10, so a recursive rule reads `dist/v4` and `dist/v6` as dead
majors and deletes them — and they are **IPv4 and IPv6**, 4 of the package's 9
declaration files. The `kept.length > 0` fallback does not save it, because
`dist/*.d.ts` survives and the list is non-empty.

The rule fires on 2 packages in 1,095, which is the right size for a rule whose
false positive removes a package's API. Nothing to change; written down so the
"obvious" widening is not attempted.

## Defect 20. A Rust item inside a `name! { … }` block is invisible to the indexer

Found by chasing one row of defect 19's table: `TcpListener` was reported as
declared nowhere in **tokio**, which obviously declares it.

```
tokio 1.53.1 index:  1157 chunks, 1.3 MB
                     "TcpListener" MENTIONED       (doc comments, use statements)
                     "struct TcpListener" ABSENT
```

`tokio/src/net/tcp/listener.rs` wraps the declaration in `cfg_net! { … }`.
`splitRustItems` treats a `name! { … }` invocation as one opaque item and never
descends, so everything inside is dropped from the surface.

**Causal, one file, one variable** — unwrap exactly that block and change nothing
else:

```
as shipped        struct TcpListener in surface = false   surface 7,026 B
cfg_net unwrapped struct TcpListener in surface = TRUE    surface 8,290 B
```

**Scale, counted by brace balance over 22 crates** — public item heads sitting
inside such a block:

| crate | pub items | inside a macro block | the macros |
|---|---|---|---|
| tokio | 2,919 | **441 (15.1%)** | `cfg_rt!` 68, `cfg_unstable_metrics!` 39, `cfg_io_util!` 34, `cfg_net!` |
| tokio-stream | 146 | 28 (19.2%) | `pin_project!` 26 |
| futures-util | 593 | 93 (15.7%) | `pin_project!` 93 |
| axum-core | 70 | 9 (12.9%) | `composite_rejection!`, `define_rejection!` |
| axum | 370 | 42 (11.4%) | `define_rejection!` 20, `composite_rejection!` 10 |
| tower / tokio-util | ~390 | 31 (7.9%) | `pin_project!` |
| hyper | 543 | 25 (4.6%) | `pin_project!`, `cfg_feature!` |
| uuid, tracing-core, regex, http, itertools, … | — | 0 (0.0%) | — |

It is an async-ecosystem pattern, not a universal one. `TcpListener` is in the
15%, and it is one of this test's own **ground-truth symbols** — which the recall
metric scored a HIT anyway, because the answer carried the name from a doc
comment. One more reading of why that metric is saturated.

### The fix, and the guard that is NOT a macro-name allowlist

`quote!` (60 blocks in serde_derive), `test_parse!` and `ffi_fn!` bodies are token
templates and test code, not items. The guard is what the body IS, never which
macro it is: a body is descended into when it does not INTERPOLATE — `#ident`,
`#(`. Comments come out first, because a doctest hides lines with `# use …` and
the first cut of this measurement flagged `cfg_rt! { pub fn spawn … }` as a
template because of one.

```
818 public items sit inside an item-shaped macro block
  0 public items sit inside an interpolating one
```

The two populations do not overlap at all, across all twenty-two crates.

### Shipped, and measured before and after on the same 52 crate trees

```
                    pub names            surface bytes
tokio          672 ->  822  (+150)   1,274,804 -> 1,582,982    TcpListener false -> TRUE
futures-util   232 ->  314  (+82)
axum           195 ->  233  (+38)
tokio-stream    51 ->   77  (+26)
tokio-util     181 ->  203  (+22)
tower          182 ->  201  (+19)
tower-http     265 ->  277  (+12)
hyper          132 ->  140  (+8)
                                     TOTAL  +393 public names, +388 KB
```

Thirty-two of the fifty-two trees are byte-identical — the ones with no macro
block. Nothing is taken from any of them.

### Verified through the real `docsRaw`, defect 20 isolated

HEAD~1 against HEAD, so defect 16 is in both arms and only the macro descent
differs. Container, cold cache per arm, same project.

```
                                      HEAD~1        HEAD
tokio  "TcpListener bind signature"   8 chunks      9 chunks
                                      16,325 B      20,516 B
                                      struct TcpListener  false -> TRUE
tokio  "tokio::net::TcpListener accept"           false -> TRUE

indexed chunks   tokio 1,157 -> 1,410   axum 401 -> 437   tower 553 -> 587
```

Two axum/tower queries retrieve slightly FEWER bytes (1,080 -> 1,061 and
678 -> 480). Nothing was removed from either crate; the ranking moved because both
gained chunks. That is defect 17's mechanism inside a single package, and it is
the reason a retrieval A/B must hold the cache fixed.

### The ANSWER half — no aggregate signal, and one record that says everything

Two arms of the same tree, differing only in the macro descent, over every
replayable `rs` record. **The aggregate says nothing and cannot**: 14 records
across five modules, 1 to 7 per module, and the abstention counts bounce both
ways (`recorded-answer -> abstain` 0/9 to 1/9). That is not a measurement.

**The one record with a real stimulus is a different matter.** `tokio` was asked
for `TcpListener::bind`'s signature — and `tokio:TcpListener` is one of this
test's own ground-truth symbols:

```
HEAD~1  "…no explicit generic bound `A: ToSocketAddrs` … from the provided text"
HEAD    "The package shows `pub async fn bind<A: ToSocketAddrs>(addr: A)
         -> io::Result<TcpListener>`"
```

That signature is the declaration inside `cfg_net! { … }`. Not a statistical
result at n=1 — a mechanistic one: the answer quotes the exact text the fix
unlocked, and the pre-fix arm states it is unavailable.

One more reading of the abstention metric while we are here: the HEAD arm that
produced the correct signature **also set `unclear`**. The child answered
correctly and flagged itself. Defect 15's class, still alive.

### Haskell does NOT have this shape — checked, not assumed

The obvious next question is whether `haskellSurface` has its own opaque-block
class. It does not.

```
                 top-level signatures   data/newtype/class   CPP directives
text 2.1.3            757 / 757              57 / 57              291
aeson 2.2.5.1         538 / 539             112 / 112              76
scotty 0.30           262 / 268              36 / 36                7
hspec 2.11.17           6 / 6                 1 / 1                 0
```

CPP is not opaque to it: text carries 291 `#if`/`#endif` directives and loses
nothing inside them. Template Haskell is a real limit — aeson has 5 `$(…)`
splices, and no source reader can see what they generate — but at that size it is
a limit, not a defect.

### And it exposed the same hash hole a THIRD time

`computeContentHash` hashed `String(profile.surface)`. Cargo's `surface` is
declared as the wrapper `content => rustSurface(content)`, which shows **none** of
`rustSurface` — so this fix would have changed nothing for a cached crate.

That is now three bugs one level below a `String(fn)`: the chunker (closed by
`chunkerFingerprint`), the gap rule's helpers, and `surface` itself. The three
ad-hoc fingerprints are replaced by one **required** `EcosystemProfile.contentFingerprint()`,
owned by each ecosystem row, naming every function and regex that shapes a chunk's
content. `String(profile.surface)` is still hashed beside it, so overriding either
one alone still re-indexes.

## Defect 19. The prefix bound's stated cost, caught causing a live HARD FAIL

`DEFECT-12-STOPPING-RULE.md` bounds the supplement candidates to dependencies
sharing the asking package's name prefix, and states the cost plainly: a
re-export from a crate with a different name stays open. Re-run 4 shows what that
costs, end to end.

**The chain.** rs's single abstention is the question whose answer was missing:

```
query (worker:apis)  "How to drive a Router in-process without binding a port:
                      Router::oneshot signature, what type the request argument
                      must be (http::…"                          -> ABSTAINED
code shipped         a hand-rolled RawWaker, service.poll_ready(), service.call()
cargo test           error[E0599]: trait `Service` … is implemented but not in
                     scope; perhaps you want to import it: use tower_service::Service
```

**Why the tool could not answer.** Probed against the new index:

```
docsRaw(axum, "Router oneshot drive a router in-process")
    9 chunks   oneshot=MENTIONED   ServiceExt=MENTIONED   trait Service=ABSENT
docsRaw(tower, "ServiceExt oneshot signature")
    9 chunks   oneshot=MENTIONED   ServiceExt=MENTIONED   trait Service=ABSENT
```

`oneshot` is an inherent method of `tower::ServiceExt`; `call` and `poll_ready`
belong to `trait Service` in **`tower-service`**. axum's corpus carries the NAMES
in doc comments and declares neither. That is defect 12's exact shape — a bare
name with the signature in a dependency — and the prefix bound cannot cross from
`axum` to `tower` or `tower-service`, which share no prefix with it.

Worse for the trigger: axum does not `pub use ServiceExt` at all, so there is no
hole for rule 1 to see either. **Both halves of the stopping rule miss it.**

### STEP 0 — the obvious lever, MEASURED and REFUTED as designed

The candidate was: extend "resolve, do not traverse" from re-exports to QUERIES —
when a query names a symbol the asked package declares nowhere, and a declared
dependency does declare it, answer from there.

**Upper bound first.** Every symbol-shaped token in all 158 recorded queries,
checked against the asked package's WHOLE chunk table (not ranked retrieval, so
defect 17 cannot reach this):

```
261 symbols named in a query
121 declared NOWHERE in the package asked          46.4%
```

That 46% is a contaminated ceiling, and reading the rows says why. It is three
populations, not one:

```
names that exist in no crate at all   decodeFile, DecodeError, GenericFromJSON,
                                      zZodError, safeParseResult, axumRouter
                                      — the model's inventions, a KNOWN limit
names in a DIFFERENT crate            DeserializeOwned, StatusCode, TcpListener,
                                      oneshot, ByteString, HashMap
classifier noise                      camelCase, snake_case, rename_all,
                                      TypeScript, main, assert, handle
```

**The decisive number, cargo, bounded by `[dependencies]`** — the sound bound, and
`manifestCrates`'s own docstring says why the lock is not (it answers "can this
resolve", not "may this crate `use` it"):

```
20 distinct (asked crate, undeclared symbol) pairs
 4 reachable in a declared dependency   DeserializeOwned->serde x2, handle->tokio,
                                        to_bytes->axum
16 reachable in nothing indexed
```

**And none of the four is one that mattered.** `oneshot` is in `tower`, which the
project declares only transitively; `StatusCode` is in `http`, likewise; and
`TcpListener` is not declared in `tokio`'s own index either. The lever reaches 4
of 20 and **zero of the symbols behind the rs HARD FAIL**. Refuted as designed.

**The wider bound was measured too, and it is worse.** Same probe, candidates
taken from `Cargo.lock` (84 crates) instead of `[dependencies]` (4):

```
                       reachable   and of those, RIGHT
[dependencies]            4 / 20          2
Cargo.lock                9 / 18          3
```

Recall goes up and precision falls, because a bare name collides across 84 crates
and the first match wins:

```
axum  oneshot     -> futures-channel   WRONG — that is a channel, not
                                       tower::ServiceExt::oneshot
axum  TcpListener -> mio               WRONG — tokio's is the one meant, and
                                       tokio IS a declared dependency
axum  handle      -> futures-util      WRONG — `handle` is a generic word
serde_json serde_json -> tracing       ABSURD — a `mod serde_json` inside tracing
axum  StatusCode  -> http              right symbol
axum  DeserializeOwned -> serde        right
http  BodyExt     -> http-body-util    right
```

And it still does not fix the case it was reached for: `oneshot` resolves to the
wrong crate and `tower_service` to nothing. That is on top of the cost already on
record — the 2026-09-05 run answered about `tower`, in the lock via axum and
absent from `[dependencies]`, and the crate did not compile.

**Both bounds refuted.** A lever for defect 19 has to resolve a symbol to a crate
by something other than "search the dependency set for the name", and nothing in
the recorded corpus supplies that. Filed, not open.

Widening the doc-comment mention into a trigger is NOT the lever either — half of
crates.io is mentioned in axum's doc comments.

## Defect 18. One docs answer in five carries a false hallucination warning

Nothing in this file had ever looked at `excerptVerified`. It is checked on every
answer, and a `false` verdict makes `formatResultText` prepend this to the text
the CALLING worker reads:

```
WARNING: cited excerpt not found verbatim in source content
         — the child pi may have paraphrased or hallucinated.
```

**Base rate, four recorded runs plus the 2026-09-06 one:**

```
run 1   hs 6/22  rs 4/17  ts 3/17
run 2   hs 1/10  rs 2/5   ts 3/14
run 3   hs 1/6   rs 0/10  ts 4/17
run 4   hs 1/13  rs 4/9   ts 3/18
run 5   —        rs 2/7   ts 6/19
                                     32 of 158 recorded = 20%, per-project 0–44%
```

**And it is wrong every time it can be checked.** Every unverified excerpt with a
replayable corpus, greedily covered by the longest runs the corpus does contain:

```
21 of 21 excerpts:  0 words absent from the corpus.   0 fabrications.
                    2 to 11 verbatim spans each.
the only "absent" tokens in the whole set are the child's own `...` elisions
```

So the excerpt is **stitched**, never invented — which is the documented
behaviour of the extraction prompt (`medium` stitches quotes; see the extraction
cell in the reasoning ladder). `excerptVerified` measures "is this ONE contiguous
quote". The warning reports it as "may have hallucinated".

That matters because it is not a scorer, it is **live text in the tool return**.
One answer in five tells the calling worker its own correct answer may be made up,
and research's measured discard base rate is 54%.

**FIXED — the verdict is untouched and the claim about it is not.**
`child-output.ts` says plainly that `ExcerptVerification` exists to add EVIDENCE
and that "the verdict itself is not loosened", so `verified` still delegates to
the one predicate. Two fields are added beside it — `verbatimSpans` and `absent`,
from a greedy cover of the excerpt by the longest runs the source contains — and
the message is chosen from `absent`, not from `verified`:

```
absent.length > 0  -> WARNING: … may have paraphrased or hallucinated.   (unchanged)
otherwise          -> NOTE: cited excerpt is stitched from N separate spans
                            of the source; every span is verbatim.
```

Re-run over the same 21 records through the shipped code:

```
21 of 21 now report stitched.   0 keep the hallucination warning.
```

The other direction is pinned too: an excerpt carrying one invented word still
warns, and the two worker tests that assert the warning appear still pass — they
now require a genuinely absent word to do so, so they got stricter, not looser.

The cover is greedy and runs on every answer; measured over the 73 records it
costs 0.25 ms mean, 0.7 ms worst, and 1.5 ms on a synthetic 400-word excerpt
against a full 24 KB corpus.

**Verified LIVE in re-run 5, on the shipped 0.40.11.** Eleven unverified excerpts
across the three projects: **10 reported "stitched from N spans"**, and one kept
the warning. Before the fix all eleven carried "may have paraphrased or
hallucinated".

**And the one that kept it was not a fabrication either.** Its single absent word
was `<package>aeson@2.2.5.1</package>` — the provenance tag
`buildExtractionPrompt` puts in the prompt, quoted back inside an otherwise
verbatim excerpt. A complete lowercase element is now excused alongside the
elision marks; `Vec<String>` does not start with `<` and `<T>` has no closing tag,
so neither is.

```
unverified excerpts across runs 2, 3 and 5:  24
                            report stitched:  24
                       hallucination-warned:   0
                         real fabrications:    0
```

Twenty-four cases and the warning has never once been right. It stays, because
the thing it watches for is real and would matter; but nothing in five live runs
has tripped it honestly.

And the verdict really is untouched, replayed rather than asserted:

```
73 records carrying a recorded excerptCheck
73 verdicts identical      0 changed      0 content hashes moved
```

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
| re-run 4, 09-06 | 0.40.9 | **HARD FAIL**, 0% | **HARD FAIL**, 14% | **HARD FAIL**, 100% (1 call) |
| re-run 5, 09-06 | 0.40.11 | **HARD FAIL**, 43% | PASS, 17% | PASS, 33% |

**Re-run 5 is the best result any run has had on the hard half**: rs and hs both
PASS, and hs has passed twice in five runs. ts HARD FAILs on `bun test`'s
"No tests found!" — its plan had four tasks and it executed two, having spent the
run fighting `Cannot find name 'Bun'` and `Property 'dir' does not exist on type
'ImportMeta'` after adding a `tsconfig.json` of its own.

The docs tool is not implicated. It was asked five questions and abstained on
three: two about the TypeScript COMPILER (`what changed in TypeScript 7.0.2`,
`does tsc 5.x support bodyless function declarations`) and one about Bun's runtime
globals. It answered every zod and hono question, recall 2/2, 4/4 clean.

Bun's globals are the one recurring soft spot, and it is smaller than it looks:

```
Bun-global records across five runs   12, abstained 5   42%
all records                          186, abstained 63  34%
```

`bun:test` answers 5 of 5 — it is a real module with declarations. Module `bun`
abstains 4 of 5, because the runtime's globals are not a package the indexer can
resolve. n=12 and an 8-point gap is not a finding; recorded so it is not
rediscovered as one.

Re-run 4 is three HARD FAILs for three unrelated reasons, and **the docs tool
caused at most one of them**:

```
ts   bun test HANGS after one passing test    0 abstentions in 19, 18/19 clean
     — a test-authoring bug, no docs failure anywhere near it
rs   `use tower_service::Service` missing     1 abstention in 7, and it IS the question
     — see defect 19
hs   two .cabal files in the tree             1 docs call in the whole run
     — a task-execution bug; the tool was barely used
```

ts at **0% abstention over 19 records** is the best of any run (24, 7, 24, 17)
and it still HARD FAILed, which is the same lesson as the baseline read the other
way round: the abstention rate says nothing about whether the run ships.

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

