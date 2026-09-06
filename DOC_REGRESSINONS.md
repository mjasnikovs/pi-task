# Docs live test — findings

Working notes for the live docs test across TypeScript, Rust and Haskell.
Everything below was checked on this machine, not assumed.

**Status: defects 1-3, 5-10 and 13 are closed and collapsed to one line each.** Their
evidence is in git history. Everything under "Still open" is written out in full, because
that is what the next run has to move.

`live-docs-run-2026-09-05/AUDIT.md` is the pre-fix baseline a re-run diffs against.

---

# How to run this loop again

The whole point of this exercise is that it is repeatable. Run it after any docs-tool
change and diff the numbers against `live-docs-run-2026-09-05/AUDIT.md`.

Five scripts. They live in `scripts/` and nothing in them runs on import, so
`bun run test` globbing `scripts/` stays green.

```
docs-live-truth.ts   the pins, the ground-truth symbols, the stale-major markers (data only)
docs-live-seed.ts    creates the three greenfield projects with deps installed
docs-live-run.ts     drives one project through a real /task-auto in tmux
docs-live-build.ts   records each project's build verdict where the toolchains are
docs-live-audit.ts   scores the recorded answers and writes AUDIT.md
```

## 0. The runner

Use the `mx5-n` container. It is already `yoloMode: true`, `debugLogs: "full"`,
`autoCommit: true`, on the host network, and can reach the local model. Do not run this on
the host: the runs write to `~/.cache/pi-worker/docs.sqlite`, and inside the container that
is isolated from your real 300 MB cache for free.

```bash
docker start mx5-n
```

Check it has what it needs — the first time, it had none of this:

```bash
docker exec mx5-n bash -lc 'for c in pi bun node cargo ghc cabal tmux; do
  printf "%-6s %s\n" "$c" "$(command -v $c || echo MISSING)"; done'
```

Provision anything missing. `sudo` and the network both work inside:

```bash
# pi-task — MUST match the tree you are testing, or you measure the wrong build
docker exec mx5-n bash -lc 'cd ~/.pi/agent/npm && npm install @mjasnikovs/pi-task@<version>'

# bun, rust
docker exec mx5-n bash -lc 'curl -fsSL https://bun.sh/install | bash'
docker exec mx5-n bash -lc 'curl --proto "=https" -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --no-modify-path'

# ghc — three steps, and NOT from get-haskell.ghcup.haskell.org (does not resolve here)
docker exec mx5-n bash -lc 'sudo apt-get install -y build-essential libffi-dev libgmp-dev libncurses-dev pkg-config'
docker exec mx5-n bash -lc 'curl -sSf https://raw.githubusercontent.com/haskell/ghcup-hs/master/scripts/bootstrap/bootstrap-haskell -o /tmp/bh.sh && BOOTSTRAP_HASKELL_NONINTERACTIVE=1 sh /tmp/bh.sh'
docker exec mx5-n bash -lc '~/.ghcup/bin/ghcup install ghc --set recommended && ~/.ghcup/bin/ghcup install cabal --set recommended && . ~/.ghcup/env && cabal update'
```

GHC takes 15-25 minutes and downloads about 3 GB. Start it in the background and build the
scripts while it runs.

## 1. Refresh the pins, then seed

Open `scripts/docs-live-truth.ts` and check the pinned versions are still the current
majors. The point of a pin is that the model predates it; a stale pin measures nothing.
Check the registries directly rather than trusting the table:

```bash
curl -s https://registry.npmjs.org/zod | jq -r .\"dist-tags\".latest
curl -s -H 'User-Agent: pi-task-live' https://crates.io/api/v1/crates/axum | jq -r .crate.max_stable_version
curl -s -H 'Accept: application/json' https://hackage.haskell.org/package/scotty/preferred | jq -r '."normal-version"[0]'
```

Watch for solver conflicts when you bump. `scotty 0.30` caps `aeson < 2.3`, so the aeson
pin is the newest scotty allows, not the newest that exists — the report says so where it
matters and a run must not silently claim otherwise.

```bash
docker exec mx5-n bash -lc 'mkdir -p /home/agent/docs-live/scripts'
for f in truth seed run build audit; do
  docker cp scripts/docs-live-$f.ts mx5-n:/home/agent/docs-live/scripts/
done

docker exec mx5-n bash -lc 'export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"; . ~/.ghcup/env
  cd /home/agent/docs-live && bun scripts/docs-live-seed.ts /home/agent/docs-live/run'
```

Seeding installs each project's dependencies, so the runs measure docs and code rather
than package-manager latency. The Haskell one compiles a real dependency tree and takes
10-20 minutes on a cold cabal store.

## 2. Pre-flight: prove the tool resolves before spending three hours

```bash
docker exec mx5-n bash -lc 'cat > /tmp/probe.mjs <<"EOF"
const base = "/home/agent/.pi/agent/npm/node_modules/@mjasnikovs/pi-task/dist/workers"
const {docsRaw} = await import(base + "/docs-core.js")
for (const [cwd, pkg] of [
  ["/home/agent/docs-live/run/ts", "zod"], ["/home/agent/docs-live/run/ts", "hono"],
  ["/home/agent/docs-live/run/rs", "axum"], ["/home/agent/docs-live/run/rs", "serde_json"],
  ["/home/agent/docs-live/run/hs", "aeson"], ["/home/agent/docs-live/run/hs", "scotty"]]) {
  const r = await docsRaw({pkg, query: "core API", cwd, npmVersionLookup: () => Promise.resolve(null)})
  console.log(r.kind === "ok"
    ? `ok    ${pkg} ${r.pkg.ecosystem} ${r.pkg.name}@${r.pkg.version} chunks=${r.chunks.length}`
    : `FAIL  ${pkg} ${r.kind} ${r.resolveError ?? ""}`)
}
EOF
XDG_CACHE_HOME=/home/agent/docs-live/cache node /tmp/probe.mjs'
```

Every line must be `ok` and every version must equal its pin. A `FAIL` here is a fixture
problem, not a finding — fix it before running.

Also verify the scorer, in both directions, before you trust a single number it prints.
Hand-write one tree using each stale marker and confirm HARD FAIL, then a correct tree and
confirm PASS. A verify that cannot fail is not a verify; a scorer that fails correct code
is just as useless.

## 3. Run

`/task-auto` can only be driven through a real terminal. `pi -p` dispatches no commands at
all, and the remote bridge reaches the handler but dies on `newSession` *after* planning —
both cost a full run to discover. `docs-live-run.ts` uses tmux `send-keys`, which is the
path a user actually takes.

```bash
cat > /tmp/run.sh <<'SH'
#!/bin/bash
id="$1"; tmo="$2"
export PATH="$HOME/.bun/bin:$PATH"
export PI_TASK_TYPEONLY_LOG=/home/agent/docs-live/$id.jsonl
export PI_TASK_DEBUG_LOG=full
cd /home/agent/docs-live
exec bun scripts/docs-live-run.ts /home/agent/docs-live/run/$id \
     /home/agent/docs-live/run/$id/FEATURE.txt --timeout-min "$tmo" --quiet-min 8
SH
docker cp /tmp/run.sh mx5-n:/home/agent/docs-live/run.sh
docker exec mx5-n bash -lc 'chmod +x /home/agent/docs-live/run.sh'

# one at a time — one local model serves every child, so parallel runs contend
# and neither duration means anything
docker exec -d mx5-n bash -lc 'setsid bash -c "
  for id in ts rs hs; do
    /home/agent/docs-live/run.sh \$id 180 > /tmp/run-\$id.log 2>&1
  done; echo SEQUENCE COMPLETE" > /tmp/chain.log 2>&1 < /dev/null'
```

Budget about 3-4 hours for all three. Watch it without polling:

```bash
docker exec mx5-n bash -lc 'for id in ts rs hs; do R=/home/agent/docs-live/run/$id
  echo "$id tasks=$(ls $R/.pi-tasks/TASK_0*.md 2>/dev/null|wc -l) \
done=$(grep -l "^state: completed" $R/.pi-tasks/TASK_0*.md 2>/dev/null|wc -l) \
docs=$(wc -l < /home/agent/docs-live/$id.jsonl 2>/dev/null||echo 0)"; done'
```

**Verify the environment actually reached pi.** `tmux new-session` inherits the tmux
*server's* environment, not the client's, so a server left running from an earlier shell
silently drops your variables and the answer log stays empty:

```bash
docker exec mx5-n bash -lc 'for p in $(pgrep -x pi); do
  cat /proc/$p/environ 2>/dev/null | tr "\0" "\n" | grep PI_TASK && break; done'
```

Two details, both learned the hard way. Loop over every `pi` pid rather than taking the
first: killed runs leave defunct `pi` processes behind, and `pgrep -x pi | head -1` picks
one of those. And read the file with `cat`, not a redirect — `< /proc/$p/environ` fails in
*bash*, before `2>/dev/null` on the command can suppress anything, so the screen fills with
`Permission denied` that reads exactly like the variables being missing.

## 4. Score

The build runs where the toolchains are; the audit runs here. It reads what the run
recorded and never re-runs a lookup — the same question has already returned different
chunks on two machines, and a rescore that re-retrieves is a second measurement wearing
the first one's name.

```bash
docker exec mx5-n bash -lc 'export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"; . ~/.ghcup/env
  cd /home/agent/docs-live && bun scripts/docs-live-build.ts /home/agent/docs-live/run'

RR=/tmp/liverun && mkdir -p $RR
for id in ts rs hs; do
  docker cp mx5-n:/home/agent/docs-live/run/$id $RR/$id
  docker cp mx5-n:/home/agent/docs-live/$id.jsonl $RR/$id.jsonl
  docker cp mx5-n:/home/agent/docs-live/run/$id.build.json $RR/$id.build.json
done

bun scripts/docs-live-audit.ts $RR --build
```

Then read the answers themselves. Every finding in this document came from reading the
`toolText` of individual records, not from the summary table:

```bash
bun -e 'const fs=require("fs")
for (const r of fs.readFileSync("/tmp/liverun/hs.jsonl","utf8").trim().split("\n").map(JSON.parse))
  console.log(r.module, "|", r.unclear ? "ABSTAINED" : "answered", "|", r.query.slice(0,90))'
```

And read the cache's own `packages` table — defect 1 was visible *only* there, because the
enrichment path calls `docsRaw` directly and only the tool wrapper writes the answer log:

```bash
docker exec mx5-n bash -lc 'node -e "
const {DatabaseSync} = require(\"node:sqlite\")
const db = new DatabaseSync(process.env.HOME + \"/.cache/pi-worker/docs.sqlite\")
for (const r of db.prepare(\"select ecosystem,name,version,indexed_at from packages order by indexed_at\").all())
  console.log(new Date(Number(r.indexed_at)).toISOString().slice(11,19), r.ecosystem, r.name, r.version)"'
```

Anything in that list that is not a real dependency is a finding.

## Traps, all of which cost a run the first time

| | |
|---|---|
| `pi -p "/task-auto …"` | dispatches nothing; the text goes to the model as a message |
| the remote bridge | reaches the handler, then throws on `newSession` — *after* planning |
| tmux `send-keys` | needs `-l`, Enter as a separate call, and ~25 s for pi to boot first |
| tmux env | inherited from the *server*, not the client |
| a file left in the tree | `worker:files` reads it as project source — keep captures outside |
| `cabal test` | can be green while `cabal build all` fails; compile before you test |
| the 8-minute settle | can cut the final gate; tasks and tree are still fully scoreable |
| task count | has no cap. `granularityFloor` only pushes up, and renumbering a spec does not shrink it — ask for fewer deliverables |

## Instrumentation available

- `PI_TASK_TYPEONLY_LOG=<file>.jsonl` — one JSON line per docs **answer**: `module`,
  `query` verbatim, the child's prose, `unclear`, `excerptCheck`, and `toolText` (the
  entire tool return, version banner and cited excerpt included). Parser already exists:
  `readTypeOnlyLog` in `src/workers/typeonly-log.ts`.
- `.pi-tasks/*-debug.log` — one line per docs **call**, tagged with the phase:
  `worker:apis: pi-worker-docs: bun "sql tagged template literal…"`. The query is
  truncated at ~60 chars here; the JSONL has it whole.

**Refusals are in neither sink directly.** `logDocsAnswer` fires only on the answer path,
so a refused lookup writes no JSONL record. A trail call with no matching JSONL record is
a refusal or a crash — derivable, but only in the research phases where trail coverage of
worker calls is proven. Do not widen `logDocsAnswer` to cover refusals: it would corrupt
the denominator the type-only firing rate is computed against.

## Stale-major markers

The point of pinning these majors is that a wrong answer is greppable.

| pin | stale marker | means |
|---|---|---|
| axum 0.8 | `/x/:id` in a route | 0.7 path syntax; 0.8 uses `{id}` |
| zod 4 | `.errors` on a ZodError | v4 renamed it `.issues` |
| zod 4 | `z.string().email()` | v4 uses `z.email()` |
| aeson 2 | `Data.HashMap.Strict` for object access | v1 shape; v2 uses `KeyMap` |

A downgraded dependency counts as a failure too — reaching for the major the model
already knows is the exact behaviour this test exists to catch.

## What a result means

Compare against `live-docs-run-2026-09-05/AUDIT.md`. The number that carries the signal is
the **abstention rate per package**, not the pass/fail: npm 24%, cargo 29%, hackage 55%
was the baseline, with aeson at 8 of 11.

And read the verdict the right way round. TypeScript passed *with* three hono non-answers,
because the model knew hono already. A green run does not mean the docs tool worked — it
means the tool's failures were survivable that time. Haskell is the honest test, because
there the model had nothing to fall back on.

---

---
# Closed defects

One line of evidence each. The full write-ups are in git history, and the run artifacts
they were measured from are still in `live-docs-*/AUDIT.md`.

| # | defect | fix | measured |
|---|---|---|---|
| 1 | Backticked filenames installed from npm as packages | enrich only declared deps; research no longer fans packages out to a docs body | 45 bogus names pre-fix, 0 after; cache holds only real deps in three re-runs |
| 2 | Answered about undeclared transitive dependencies | per-ecosystem `manifestDeps`; `[DEPENDENCY]` banner | `tower` warned in re-run 2, the run that finally reached for it |
| 3 | Retrieval could not follow a type alias | `hopNames` / `definitionChunk` fetch the definition behind a ranked alias | hono `HandlerInterface` signature arrived with the `get:` alias; 3 abstentions → 0 |
| 5 | A dead major indexed as current | `dropDeadMajors` skips a mismatching top-level `vN/` | zod 414 `v3/` chunks → 0 |
| 6 | Every `.d.cts` a second copy of its `.d.ts` | `dropParallelDeclarations`, and the file-selection rule joined the content hash | zod 2565 chunks → 1078 |
| 7 | A chunk cut in half by a match inside a match | `splitAtMatches` refuses to cut inside the last accepted match | serde 448/98 dupes → 297/0; axum 475/27 → 381/0; confirmed re-indexing live |
| 8 | Index hash did not cover the chunker | chunker source is in `computeContentHash` | every package re-indexed on first touch in re-run 2 |
| 9 | `0 invented symbols` was a verify that could not fail | scored against `retrievedText`, not the answer's own text | 54/54 pre-fix; first real number was 13/20 |
| 10 | The fidelity scorer failed the correct answer | skip a denying sentence; accept a Haskell prime whose stem the corpus knows | 17 flags → 4, all benign. Zero real fabrications in 20 |
| 13 | No `.gitignore` in the seeded projects | `docs-live-seed.ts` writes one | 1397 tracked build files → 0, 0, 0 |

Defect 4 (ranking missed indexed content) is fixed for queries that name a type; its
residue is open below.

---

# Run history

Baseline and three re-runs. Artifacts in `live-docs-run-2026-09-05/`,
`live-docs-rerun-2026-09-05/`, `live-docs-rerun2-2026-09-06/`,
`live-docs-rerun3-2026-09-06/`.

| run | build | ts | rs | hs |
|---|---|---|---|---|
| baseline 09-05 | pre-fix | PASS, 24% abstained | **HARD FAIL**, 29% | **HARD FAIL**, 55% |
| re-run 1, 09-05 | 0.40.2 | PASS, 7% | PASS, 20% | PASS, 80% |
| re-run 2, 09-06 | 0.40.3 | PASS, 24% | PASS, 40% | PASS, 83% |
| re-run 3, 09-06 | 0.40.5 | **HARD FAIL**, 17% | PASS, 22% | PASS, 46% |

Read the verdict the right way round. TypeScript passed the baseline *with* three hono
non-answers, because the model knew hono already. Its re-run 3 HARD FAIL is defect 14: a
correct docs answer that the code ignored.

Two things held in every run. The abstention path is honest, and version resolution is
exact — 7/7 pins from three version sources, no run drifted off a pinned major.

Baseline abstention per package, which is what a re-run diffs against:

```
hs   aeson            11 calls,  8 abstained     73%
hs   scotty            7 calls,  3 abstained     43%
ts   hono              6 calls,  3 abstained     50%
rs   axum              6 calls,  2 abstained     33%
rs   tower             4 calls,  1 abstained     25%
ts   zod               5 calls,  0 abstained      0%
```

---

# Still open

## Defect 4's residue. A query that names no type has nothing to hop to

`the handler monad` and `handler type for a route` still miss. The name-directed hop has
no name to chase. All seven of the baseline's real queries named `ScottyM` or `ActionM`,
so the observed failure is covered. A query with no proper noun in it is unsolved.

## A query whose key symbol is absent from the corpus cannot be answered

FTS matches whole tokens, so `decodeFile` matches nothing when only `decodeFileStrict` is
indexed, and `Data.Aeson` tokenises to `Data` + `Aeson`, which every chunk carries.
Nothing in such a query discriminates. Stripping English stopwords was tested and
**refuted** — it moves the failure to a different wrong file. This cost hs seven lookups.

## Defect 11. An English question loses the declaration the bare symbol wins

`from_str` is the cargo ground-truth symbol, and two re-runs answered that its signature
was not retrieved. It is indexed, 91 bytes, one line in `src/de.rs`.

```
rank of the declaration: NOT RETRIEVED of 6   <- "What is the exact signature of from_str? What error type does it return?"
rank of the declaration: 1 of 17              <- "from_str"
```

The 1159-byte `from_slice` chunk ranks 3rd on the prose query, because its doc comments
match `signature`, `error`, `type` and `return`. BM25 gives the English half of the
question as much say as the symbol, and the English half matches the chunks that talk
*about* the API rather than the one that *is* it.

**Fixed in the index, UNPROVEN in the answers.** Base rate over every symbol the 33
queries named whose declaration was indexed: 17 of 35 never retrieved, 48.6%. `hopNames`
only accepted `/^[A-Z]/`, and `definitionChunk` only found TYPE declarations, so
`from_str`, `safeParse`, `into_make_service` and `parseJSON` were never candidates. Both
were widened, with a whole-word smallest-first fallback for values, and the hop cap was
swept rather than guessed — uncapped for query-named hops, since a query carries its own
bound. Cost over the same 22 queries: mean bytes 15,965 → 16,083, +0.7%.

Re-measured at the live retrieval limit with a whole-word test: **0 missed of 45**. The
earlier residue of 8 was a substring test counting `decodeFile` as declared because
`decodeFileStrict` is — the exact confusion the fix was written to avoid, reproduced in
the measurement of the fix.

Delivery is still for a live run to show. serde_json lost 51 duplicate chunks and its
`from_str` answer did not move.

## Defect 12. A facade package indexes to nothing

hs abstained three times on `hspec`, every time with the same 1915 characters retrieved,
because the entire `hspec` index is 14 chunks — an export list and a re-export module.
Every signature is in `hspec-core`, a transitive dependency the indexer never opens. The
tool returned everything it had and the child correctly abstained.

Distinct from the note above: here the symbol is present, with no signature attached.
Facade packages are the norm on hackage.

Measured against re-run 3's corpus, not yet live: 14 chunks → 133, and the three questions
the runs asked go from NONE/NONE/NONE to carrying `it`, `describe`, `shouldBe` and
`shouldReturn`. See `DEFECT-12-STOPPING-RULE.md`.

## Defect 14. A correct docs answer, and the code shipped the deprecated form anyway

Re-run 3's ts HARD FAIL is `adminEmail: z.string().email()` in `src/config.ts` — the zod 3
form, and a stale-major marker.

The docs tool answered correctly, twice, naming `z.email()` as the v4 API and `.email()`
as `@deprecated`. The timestamps close it: `worker:apis` asked at 01:38:11, and the commit
that shipped `z.string().email()` is 01:45, same task.

This is a delivery failure one level further out. Defect 11's lesson was that a better
index is not a better answer. This is that a correct answer is not correct code.
`.email()` still exists in 4.5.4, so the build is green and only the marker sweep catches
it — which is why the marker table exists.

## Defect 15. The child abstains with the answer in the corpus

Of re-run 3's 11 abstentions, 6 are correct and **5 had part of the answer in hand**:

- **`text`** — 4,459 bytes retrieved containing `data Text = Text …`. Answered `unclear`.
- **`zod`** — the `.email()` question. A sibling answer from the same corpus answered it.
  This abstention is upstream of the HARD FAIL.
- **`serde`** — corpus has `trait Deserialize` and `trait Serialize`; only the
  `#[serde(rename)]` half is missing.
- **`aeson`** — `decodeFile` is absent; the blanket-instance half is not.
- **`zod`** — `ZodError.issues` is answerable; the enumeration of `code` values is not.

All five are **compound questions where one part is unanswerable**, and the child discards
the answerable parts with it. Not every compound question does this — one aeson lookup
asks two things and neither is in the corpus, and abstaining is right. The trigger is a
*mixed* question.

**Rule 4 of the extraction prompt now names the case**: answer the parts the content
covers, name the parts it does not, and abstain only when it covers no part. Prompt in
`src/workers/abstention.ts`. **This is a prompt lever and is UNMEASURED** — it needs a
two-way A/B before its effect can be claimed either way.

## aeson keeps 55 duplicate bodies

Different component from defect 7: the hackage surface extractor truncates a multi-line
instance head to its first line, so `instance {-# OVERLAPPING #-}` becomes a content-free
chunk. 4% of the package, all internal generic machinery, no public API lost. Measured
fixed offline against re-run 3's corpus — 1326/55 → 1283/0 — and not yet proven live.

---

# Two standing cautions about the instrument

**The recall metric can score a symbol the run never asked about.** `scotty:ActionM` was
reported missed in re-run 3. It is indexed, and a query naming it retrieves it. No scotty
query in that run named it.

**The fidelity scorer had known false-positive families.** Four are now guarded: a
language literal (`false`), a member of a language global (`stringify` of
`JSON.stringify`), a `node:` stdlib path (`promises` of `node:fs/promises`), and a
case-fold of a known symbol, which covers both `adminEmail` for `admin_email` and `router`
for `Router`. Rescored over both recorded re-runs, flags fell **8 → 4**: ts 10/13 → 11/13
and 13/15 → 15/15, rs 5/7 → 5/7.

Four flags are left and all are still false: `fields are` and `assert` are English inside a
code span, `error_value` is a placeholder binding in an example, and `router` names axum's
type inside a *tower* answer, whose corpus does not carry it. No principled rule was found
for these, so they stay flagged rather than guessed away.
