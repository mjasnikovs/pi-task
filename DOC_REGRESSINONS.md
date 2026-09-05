# Docs live test — findings

Working notes for the live docs test across TypeScript, Rust and Haskell.
Everything below was checked on this machine, not assumed.

**Status: all six defects fixed.** Each section keeps its original evidence and adds what
changed and what was measured after. One narrow case is still open, named under defect 4.
The numbers in "Final result" are the pre-fix baseline, and
`live-docs-run-2026-09-05/AUDIT.md` is what a re-run diffs against.

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

# The six defects

Ranked by what they cost, and numbered as in the fix session. Every one is fixed. Each
section carries its original evidence under **The evidence**; the original report numbered
them in a different order, so a heading's number is the defect's ID here and nowhere else.

## 1. Backticked filenames installed from npm as packages — FIXED

**Fixed, and the docs half of enrichment is gone with it.**

Two things happened per backticked name. Both are addressed.

*The download.* `extractEnrichTargets` now takes the project's declared dependency names and
enriches only those; `buildExternalContext` reads them via `declaredDepNames`, the same
manifest source as defect 2. A backticked filename never reaches a registry.

*The docs body.* The research binding no longer fans packages out to a docs body at all
(`packageDocs: false`). The evidence for removing it, all from this run:

- the docs query was the refined spec's first non-blank line — the literal word `GOAL` for every refined
  spec these runs produce;
- hs TASK_0002 spent all three `ENRICH_CAP` slots on `config.json`, `name` and `port`,
  fetching no library at all; ts TASK_0001 spent one of three on `tsconfig.json`;
- no research output cites an enrichment docs body, while the model's own docs tool was
  called 49 times across the three runs with no bad name:

```
hs   aeson 11, scotty 7, text 2, project 2
ts   hono 6, zod 5, project 4, bun:test 1, node:fs/promises 1
rs   axum 6, tower 4, serde 2, serde_json 1, http 1, http-body-util 1, project 1
```

The cheap live version lookup stays — it is what stops a dependency being pinned to a stale
major — and is gated on the manifest too. URLs and services are untouched, as is the grill
auto-answer path, which asks a focused child a real question rather than pasting raw chunks.

Regression tests: `test/task/enrichment.test.ts` and `test/task/external-context.test.ts`.
The first extracted all eight bogus names on the pre-fix tree; the second called `docsRaw`
once where it must now call it never.

### The evidence

The docs cache after the three runs contains packages nobody asked for. Every one was
indexed **during** these runs — the timestamps place them inside the TypeScript and
Haskell runs:

```
07:55:39  npm  tsconfig.json  1.0.11
08:01:44  npm  lib            5.1.0
08:10:15  npm  name           0.0.2
08:10:15  npm  port           0.8.1
08:10:16  npm  config.json    0.0.4
08:18:56  npm  config.ts      1.0.0
08:29:48  npm  fetch          1.1.0
08:47:44  npm  app.ts         0.1.0
08:52:34  npm  app            0.1.0
10:20:15  hackage  cabal      0.0.0.0
```

`config.ts`, `app.ts`, `tsconfig.json` and `config.json` are **files in the project**.
`name`, `port`, `lib` and `fetch` are **field and identifier names from the spec**. Each one
is also a real, unrelated package on the public registry, and each was downloaded and
indexed as documentation.

**The mechanism** is one regex in `src/task/enrichment.ts`:

```ts
const ENRICH_PKG_RE = /`((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)`/g
```

Anything in backticks matching a lowercase identifier — dots included — is a package name.
Reproduced directly against a spec of the shape these runs produce:

```
extracted as npm package names:
  config.ts, config.json, app.ts, tsconfig.json, name, port, fetch, lib
```

`ENRICH_DENYLIST` exists but holds shell commands — `bun`, `node`, `npm`, `git`, `ls`,
`cat`, `grep`. Nothing filters filenames, and nothing filters ordinary English nouns.

**Why it left no trace in either sink.** The enrichment path calls `docsRaw` directly from
`task/external-context.ts`; `logDocsAnswer` is only called by the tool wrapper in
`pi-worker-docs.ts`. So none of these ten appear in the answer log, and none appear in the
trail. They are visible only in the cache's own `packages` table. Ten registry installs, no
record anywhere a run's audit would look.

**Three separate costs.**

1. *Wasted work.* Ten network installs and ten indexing passes per run, for nothing.
2. *Wrong content.* A real `config.ts@1.0.0` by an unrelated author is now indexed as this
   project's `config.ts`. Anything that later retrieves under that name gets a stranger's
   code as documentation.
3. *An install surface driven by model output.* `npm install --ignore-scripts` blocks
   lifecycle execution, which is the right mitigation and is already in place. What remains
   is that the *choice of package to fetch* comes from a string the model wrote, and
   filenames like `config.ts` and `app.ts` are highly predictable across projects. Names a
   spec is likely to backtick are worth treating as untrusted input, not as registry
   coordinates.

**The fix is small.** A name containing a dot followed by a known source extension is a
file, not a package. A name matching a path in the project tree is a file. Both checks are
cheap and local, and either alone removes eight of the ten above. The remaining two —
`name`, `port` — are bare English nouns, which argues for the inverse rule this codebase
already uses elsewhere: enrich only names that appear in the project's **declared**
dependencies, which `declaredDeps(cwd)` already provides. That single change fixes this
defect and defect 2 together.

---

---

## 2. Answering about undeclared transitive dependencies — FIXED

**Fixed.** Each ecosystem gained a real manifest reader, distinct from the resolvable
closure it had been using: cargo reads `[dependencies]` from `Cargo.toml`
(`manifestCrates`), Haskell reads `build-depends` from the `.cabal` file
(`manifestPackages`), npm already read `package.json`. They hang off
`EcosystemProfile.manifestDeps`.

`buildVersionBanner` now leads an undeclared package's answer with:

```
[DEPENDENCY] "tower" is present in this project but is not a declared dependency in
Cargo.toml — it resolves only because something else pulled it in. Add it to Cargo.toml
before importing it, or the build will not find it.
```

The old `declaredDeps` was the wrong source for this: for cargo it reads `Cargo.lock` and
for hackage the cabal install plan, both of which are the whole transitive closure.

Verified against this run's own project files:

```
rs   tower WARNS   http-body-util WARNS   axum, serde_json silent
hs   warp  WARNS   bytestring     WARNS   aeson, scotty, text silent
```

Regression tests: `test/workers/docs-core.test.ts`, both ecosystems. Both produced an empty
banner on the pre-fix tree. No manifest at all still says nothing — "cannot tell" is not
"not declared".

### The evidence

**This one reached the artifact.** The Rust run is a HARD FAIL, and the docs tool is in the
causal chain.

The sequence, entirely from the run's own records:

1. The model asked for the import path of `ServiceExt`, needed to call `.oneshot()` on a
   `Router` in a test:

   ```
   [5] tower  unclear=true   "ServiceExt oneshot method for testing axum Router:
                              full import path (tower::util::ServiceExt or to…"
   ```

   Abstained.

2. It asked again, more narrowly, and got a correct and precise answer:

   ```
   [7] tower  unclear=false  "the trait `ServiceExt<Request>` is defined in
                              `src/util/mod.rs`, so its path is `tower::util::ServiceExt`.
                              The `oneshot` method signature is `fn oneshot(…`"
   ```

3. It wrote exactly that:

   ```rust
   tests/config.rs:6    use tower::util::ServiceExt;
   ```

4. The crate does not compile:

   ```
   error[E0433]: cannot find module or crate `tower` in this scope
    --> tests/config.rs:6:5
   error[E0599]: no method named `oneshot` found for struct `Router<S>`
       help: trait `ServiceExt` which provides `oneshot` is implemented but not in scope;
             perhaps you want to import it
             1 + use tower::util::ServiceExt;
   ```

**Why.** `tower 0.5.3` is in `Cargo.lock` — pulled in transitively by axum — but it is not
in `[dependencies]`:

```toml
[dependencies]
axum = "0.8.9"
tokio = { version = "1.53.1", features = ["full"] }
serde_json = "1.0.151"
serde = { version = "1", features = ["derive"] }
```

`resolveCrate` finds a version through `lockedVersion`, which reads the lock file — and a
lock file is the whole transitive closure, not the crate's own dependency list. So the tool
resolved `tower`, indexed it, and answered about it in full confidence. Nothing in the
answer says the crate cannot `use` it.

The compiler's own diagnostic is the tell: it knows the trait *is implemented* for `Router`
and suggests the exact import the model already wrote. The code is right about the API and
wrong about the manifest, and the docs answer is what made that combination look safe.

**This is not cargo-specific — measured, not inferred.** `resolvePackage` walks
`node_modules`, which likewise holds the entire transitive closure. On a real project in
the same container (23 declared dependencies, 141 packages on disk):

```
plain undeclared packages on disk: 106
  ANSWERED about undeclared ms@2.1.0          (chunks=4)
  ANSWERED about undeclared debug@4.1.13      (chunks=1)
  ANSWERED about undeclared picocolors@1.1.1  (chunks=2)
```

Three for three, full answers, no warning. A project with 23 declared dependencies exposes
**106** packages the docs tool will confidently describe and that the project must not
import.

**The fix has a natural shape.** Each ecosystem profile already has `declaredDeps(cwd)`,
distinct from what `resolve` finds. A package resolvable but not declared is exactly the
case that needs a sentence in the answer: *present transitively, not a declared dependency
— add it before importing.* The information is already in hand; it is simply not consulted
on this path. The existing version banner is the obvious place to put it.

---

---

## 3. Retrieval cannot follow a type alias — FIXED

**Fixed.** `hopNames` and `definitionChunk` in `src/workers/docs-retrieve.ts`. After
ranking, retrieval takes members declared as a bare capitalised type
(`get: HandlerInterface<...>`), keeps the ones the query names by member or by type, and
fetches up to three definitions. They sit behind the top-ranked chunk, so re-budgeting drops
the weakest original rather than the definition. The budget itself does not move.

Ranking hops by frequency does not work, and was measured not working: `Response` and the
English word `The` both outrank `HandlerInterface` in the same retrieved text. What the
query names is the signal.

Measured on the real hono index, the three queries below:

```
was       is now
NONE   -> HandlerInterface, JSONRespond
NONE   -> JSONRespond
NONE   -> HandlerInterface
```

Regression test: `test/workers/docs-retrieve.test.ts`, fixture `alias-pkg` — the alias in
one file, the definition in another, with enough decoys that the top-8 excludes the
definition. It reproduces the shape exactly: the alias arrives, its definition does not.

### The evidence

Three hono lookups in TASK_0004. **All three abstained.**

```
[7] hono  unclear=true   "Hono constructor, .get(path, handler), Context c.json(data, status?)"
[8] hono  unclear=true   "JSONRespond definition — parameters and return type; HonoBase.get() signature"
[9] hono  unclear=true   "hono-base.d.ts: the get() overload showing path and ...handlers"
```

Every one came back `unclear from this package`. And every one cited an excerpt that is
the thing being asked about:

```
[7]  json: JSONRespond;
[9]  get: HandlerInterface<E, 'get', S, BasePath, CurrentPath>;
```

That contradiction is not the bug — it is rule 4 of the extraction prompt working as
written: *"write exactly `unclear from this package` and put the closest related text in
`<excerpt>`."* Two of the three excerpts verified as genuine package content.

**The child was right.** Neither excerpt contains a signature. hono declares every HTTP
verb as a property whose type is an interface alias, and the call signatures live in the
interface — a different declaration, in a different file:

```
dist/types/hono-base.d.ts   get: HandlerInterface<E, 'get', S, BasePath, CurrentPath>;
dist/types/types.d.ts       export interface HandlerInterface<…> { <P extends string …>(…) }
```

`HandlerInterface`'s definition is in **exactly one chunk** of 708. Answering "what are the
parameters of `app.get()`" needs that chunk *and* the `hono-base.d.ts` chunk. BM25 ranks
the eight chunks independently; there is no step that says "this chunk names a type, fetch
its definition too". So the lookup lands on the alias, the child sees a name where a
signature should be, and abstains — correctly, given what it was handed.

Retrieval was never the problem here, which is worth being precise about. Re-running the
same queries directly returns the right files every time:

```
HIT  "JSONRespond"                                   -> context.d.ts ×3
HIT  "Hono class constructor and get route"          -> index.d.ts, hono-base.d.ts, hono.d.ts …
HIT  "HonoBase get method overload signature"        -> types.d.ts, router.d.ts, request.d.ts …
HIT  "hono-base.d.ts get() declaration on HonoBase"  -> hono.d.ts, hono-base.d.ts ×2, types.d.ts …
```

The chunks arrive. They just do not arrive **together with the definitions they point at**,
and a top-8 budget cannot afford to guess.

**This is the one that answers the question the test was built to ask.** For hono, the docs
answers were not sufficient: three lookups, three non-answers, on the task that needed
hono most. Unlike the zod defect, this is not a subtle wrong detail — it is the tool
returning nothing usable, repeatedly, for a mainstream library.

It also generalises past hono. Any package that types its public surface through interface
aliases or generic indirection — which is most modern TypeScript — puts its real
signatures one hop away from the name a query matches.

---

## 4. Ranking misses content that is indexed — FIXED

**Fixed.** The same hop as defect 3, generalised. A capitalised identifier the QUERY names,
whose definition is not already in hand, gets its defining chunk fetched. The keywords that
introduce a named type are per-ecosystem (`EcosystemProfile.typeKeywords`):
`interface|type|class|enum` for npm, `struct|trait|enum|type|union` for cargo,
`type|data|newtype|class` for hackage.

The mechanism, read off the ranked output rather than guessed: a chunk that USES both names
(`get :: RoutePattern -> ActionM () -> ScottyM ()`) carries more query terms than the chunk
that DEFINES one, so all eight slots went to uses.

Re-measured on this run's own cache, after the defect 5 and 6 fixes — which are npm-shaped
and could not reach hackage:

```
                                                     was      is now
definitions of ScottyM and ActionM                   NONE  ->  ActionM-def, ScottyM-def
ScottyM ActionM type definitions and json signature  NONE  ->  ActionM-def, ScottyM-def
json :: ToJSON a => a -> ActionM ()                  NONE  ->  ActionM-def, json-sig
```

**Still open.** `the handler monad` and `handler type for a route` still miss. They name no
type, so a name-directed hop has nothing to chase. All seven of the run's real queries named
`ScottyM` or `ActionM`, so the observed failure is covered; a query with no proper noun in
it is a separate, unsolved problem.

Regression test: `test/workers/docs-retrieve.test.ts` against a scotty-shaped Haskell
fixture — two type aliases and sixteen route functions that use them.

### The evidence

The Haskell run asked scotty for the same thing seven times: the type of `json`, and the
definitions of `ScottyM` / `ActionM`.

```
[2]  ok       "scotty :: Port -> ScottyM () -> IO () from Web.Scotty
              (which is `type ScottyM = ScottyT IO`)"
[10] unclear
[12] partial  "Only a few of the requested signatures are present: scottyApp and options"
[14] partial  "does not include the definitions of ScottyM/ActionM … nor the signature
              of the json handler"
[16] partial  "does not contain a type signature for a json function or a type
              declaration for ScottyM a / ActionM"
[18] unclear
[20] unclear
```

Four outright non-answers, three partials, and across all seven the signature
`json :: ToJSON a => a -> ActionM ()` never appeared.

**The content was there the whole time.** Measured directly against the index:

```
scotty chunks indexed:        312
chunks containing ActionM:     67
  Web/Scotty.hs | type ActionM = ActionT IO
```

Sixty-seven chunks hold the term, one of them holds the definition, and seven ranked
retrievals at top-8 never surfaced it. This is the ranking miss found in pre-flight —
`ActionM` missed on short queries — reproduced at scale in a real run, and it did not
improve when the model rewrote the query six times.

**And it reached the artifact.** `src/Server.hs`:

```haskell
import Network.Scotty (Scotty, ScottyT, get, json, liftIO, status, statusCode)

configApp :: Scotty
configRoute :: ScottyT () ()
errRoute msg = do
  status statusCode400
```

Every one of those is wrong. The module is `Web.Scotty`, not `Network.Scotty`. There is no
type `Scotty`. `ScottyT` takes one parameter, not two. `statusCode400` does not exist —
it is `status400`. `genericToJSON`, `defaultOptions`, `Value`, `.=` and `Key` are all used
without imports.

Note the second failure layered on the first: answer [2] gave the module correctly as
**`Web.Scotty`**, and the model still wrote `Network.Scotty`. So the docs were right once,
and ignored; then wrong or silent six times, and improvised over.

**This is the clearest answer the exercise produced.** For Haskell the docs were not
sufficient — not marginally, not in one call, but across seven consecutive attempts at a
single signature that was sitting in the index the entire time. Where TypeScript had
enough model knowledge to paper over the gaps, Haskell did not, and the gap went straight
into the source file.

---

---

## 5. A dead major is indexed as current — FIXED

**Fixed.** `dropDeadMajors` in `src/workers/docs-index.ts` skips a top-level `vN/`
directory whose number does not match the package's own major. `v4/` under 4.5.4 stays. A
package whose whole surface lives under a mismatching `vN/` keeps it, so a package that
simply organises itself that way still indexes.

Measured on the real zod 4.5.4, together with defect 6:

```
was      2565 chunks   1280 from .d.cts   414 from v3/
is now   1078 chunks      0 from .d.cts     0 from v3/
```

Regression test: `test/workers/docs-index.test.ts`, fixture `oldmajor-pkg`. On the pre-fix
tree it returned 18 `v3/` chunks where none were expected.

### The evidence

`zod@4.5.4` ships a `v3/` directory for back-compat. The docs index takes it:

```
zod chunk files, by count
  v4/core/schemas.d.ts     283      v3/types.d.ts    146
  v4/core/schemas.d.cts    283      v3/types.d.cts   146
  ...
  v3 chunks: 414     v4 chunks: 2138
```

414 chunks of zod 3's API sit in the index for a package the banner announces as
`zod@4.5.4`. BM25 cannot tell them apart — they are the same identifiers, in the same
package, at a path no ranking signal reads.

**And it showed up in an answer.** The worker asked whether `z.string().email()` is valid
in zod 4. It got back, under a `Per zod@4.5.4:` header:

> (1) z.string().email() is confirmed — `ZodString.email(message?): ZodString` is a check
> method returning `ZodString`.

That signature is **zod 3's**, verbatim in shape:

```
v3/types.d.ts:214      email(message?: errorUtil.ErrMessage): ZodString;

v4/classic/schemas.d.ts:111   /** @deprecated Use `z.email()` instead. */
v4/classic/schemas.d.ts:112   email(params?: string | core.$ZodCheckEmailParams): this;
```

Three things wrong in one sentence: the parameter is `params?`, not `message?`; the return
is `this`, not `ZodString`; and the declaration carries **`@deprecated Use z.email()
instead`** on the line directly above it, which the answer does not mention at all. It
says "confirmed".

This is the exact mechanism the stale-API pins were chosen to expose. A model handed that
answer writes `z.string().email()` — the deprecated v3 idiom — and believes it checked.

**One honest caveat.** The excerpt guard did fire on this answer:

```
WARNING: cited excerpt not found verbatim in source content — the child pi may have
paraphrased or hallucinated.
```

So the citation was not grounded, and whether the v3 signature came from the indexed v3
chunk or from the model's own memory of zod 3 cannot be separated from this record alone.
It does not matter much: the v3 chunks are indexed and retrievable, so the failure is
available either way. What the record does prove is that **the warning did not stop the
answer** — the prose still asserts "confirmed", and the caller gets a confident wrong API
with a warning above it.

Worth noting the tool also behaved well twice in the same task. An earlier query said
plainly "the content contains no declaration for z.string().email() … so those parts are
unclear" rather than guessing, and a later one surfaced
`/** Consider z.strictObject(A.shape) instead */`. The abstention path works. It is the
answer that *does* commit that carries the wrong major.

---

## 6. Every `.d.cts` is a second copy of its `.d.ts` — FIXED

**Fixed.** `dropParallelDeclarations` in `src/workers/docs-index.ts` skips a `.d.cts` or
`.d.mts` sitting beside a `.d.ts` of the same name. Not a ban on the extensions: a package
shipping only `.d.cts` still indexes, and all 123 of zod's `.d.cts` files have a `.d.ts`
twin. zod fell 2565 to 1285 chunks, exactly the 1280 counted below.

The cache hash covered the chunker but not WHICH FILES are read, so an existing index would
have kept its duplicate rows forever. The selection rule is now part of
`computeContentHash`, so old caches rebuild.

Regression test: `test/workers/docs-index.test.ts`, fixtures `dual-decl-pkg` and
`cts-only-pkg`. Two declarations indexed to four bodies on the pre-fix tree.

### The evidence

Same package, counting distinct chunk bodies rather than rows:

| package | chunks | distinct bodies | `.d.cts` chunks |
|---|---|---|---|
| zod | 2565 | **1215** | 1280 |
| hono | 708 | 704 | 0 |

**53% of zod's index is duplicate content.** Modern packages ship parallel `.d.ts` and
`.d.cts` declarations for ESM and CJS; they are the same API written twice, and
`isDtsFile` accepts both (`.d.ts|.d.mts|.d.cts`).

hono ships no `.d.cts` and has no duplication, which is what makes the cause unambiguous.

The cost is not disk. Retrieval returns the top **8** chunks
(`PACKAGE_RETRIEVE_LIMIT = 8`), so a package indexed twice can spend two of those eight
slots on the same text. The effective breadth of every zod lookup is halved, which is the
same pressure behind the ranking misses recorded earlier in this file.

These two compound: half the index is redundant, and a sixth of it describes a major the
project is not using.

---

# Final result

Three greenfield projects, one per ecosystem, each pinned to a library major the local
Qwen3.8-27B predates. Real `/task-auto` runs in the mx5-n container — yolo mode, full
trail, auto-commit — driven through a real terminal. 13 tasks, 56 docs calls, 3h36m.

| | TypeScript | Rust | Haskell |
|---|---|---|---|
| verdict | **PASS** | **HARD FAIL** | **HARD FAIL** |
| tasks | 6/6 | 4/4 | 3/3 |
| wall clock | 1h26m | 56m | 1h14m |
| docs calls | 17 | 17 | 22 |
| abstained | 4 (24%) | 5 (29%) | **12 (55%)** |
| invented symbols | 0/13 | 0/12 | 0/10 |
| pins intact | 2/2 | 3/3 | 2/2 |
| stale-major API | none | none | none |
| build/test | green | **RED** | **RED** |

Per package, the abstention rate is where the story is:

```
hs   aeson            11 calls,  8 abstained     73%
hs   scotty            7 calls,  3 abstained     43%
ts   hono              6 calls,  3 abstained     50%
rs   axum              6 calls,  2 abstained     33%
rs   tower             4 calls,  1 abstained     25%
ts   zod               5 calls,  0 abstained      0%
```

## Were the docs answers sufficient?

**No — and the shortfall tracks the model's own knowledge exactly inversely to where it
was needed.**

- **TypeScript passed**, with three of six hono lookups returning nothing and one zod
  answer confirming a deprecated API with a zod-3 signature. The model knew hono and zod
  well enough to write correct code anyway. The docs tool was not load-bearing here.
- **Rust failed** on a missing `tower` dependency. The docs tool answered correctly about
  `tower::util::ServiceExt` — and it should not have answered at all, because `tower` is a
  transitive lock entry, not a declared dependency. The answer made an uncompilable import
  look verified.
- **Haskell failed** hardest, and here the docs tool is squarely responsible. Twelve of
  twenty-two calls returned nothing. Seven consecutive attempts at `json`'s signature
  produced it not once, while `ActionM` sat in 67 of scotty's 312 indexed chunks. The model
  had no fallback knowledge for scotty 0.30, so it invented `Network.Scotty`, a `Scotty`
  type, and `statusCode400`, and the library does not compile.

That is the shape of the whole result. **Where the model already knew the library, the docs
tool's failures were invisible. Where it did not, they went straight into the source file.**
A tool that only works when it is not needed is the failure mode this exercise was built to
detect, and it detected it.

Two things worth crediting, both real. The **abstention path is honest** — 21 non-answers
across three runs and not one invented API in the answers themselves (0 invented symbols in
35 scored answers). And **version resolution is exact**: every package resolved to its pin
from three different version sources, and no run drifted off a pinned major.

## What a re-run has to show

The table above is the pre-fix baseline. Nothing here is a prediction — it is what to check:

- **hackage abstention, 55%.** The largest number in the report, and what the Haskell HARD
  FAIL rests on. Defect 4's fix targets it directly.
- **`rs` build, RED.** The `tower` import is now warned about before it is written.
- **zod's index, 2565 chunks.** Measured at 1078 on the fixed tree, so every zod lookup
  ranks against current, deduplicated content for the first time.
- **The cache `packages` table.** It must hold no filenames. Ten appeared last time.

---

---

# Re-run, 2026-09-05, on the fixed build

`live-docs-rerun-2026-09-05/` holds the recorded answers, builds and audit.
Container `mx5-n`, `@mjasnikovs/pi-task@0.40.2`, model Qwen3.8-27B on llama.cpp
`b10734-d5d993a09`. Both caches — `docs.sqlite` and the `docs-modules/` scratch
install — were moved aside first, so nothing was served from a cache the defects
built.

| | ts (npm) | rs (cargo) | hs (hackage) |
|---|---|---|---|
| verdict | PASS (was PASS) | PASS (was HARD FAIL) | PASS (was HARD FAIL) |
| abstained | 1/14, 7% (was 24%) | 1/5, 20% (was 29%) | 8/10, 80% (was 55%) |
| build/test | green | green (was RED) | green (was RED) |
| pins intact | 2/2 | 3/3 | 2/2 |

## The five checks

1. **No filenames in the cache.** Five packages indexed, every one a real
   dependency. The pre-fix scratch manifest, recovered before it was archived,
   held **45** — not the ten the report recorded. `config.ts`, `tsconfig.json`,
   `package.json`, `name`, `port`, `lib`, `fetch`, `sql`, `photo`, `phone` and the
   rest are in `live-docs-rerun-2026-09-05/prefix-enrich-manifest.json`.
2. **`rs` undeclared deps — NOT EXERCISED.** The run never reached for `tower`
   this time; it declared `serde` before importing it and built green. The
   `[DEPENDENCY]` warning therefore had nothing to fire on. The failure did not
   recur, and the fix was not tested. Those are different results.
3. **hackage abstention rose, 55% → 80%, and the cause is not the docs tool.** The
   run never asked about scotty at all. Seven of ten lookups chased `decodeFile`,
   which aeson 2 does not export — the model invented the name and re-asked it six
   times. Abstaining is the correct answer to a question about a symbol that does
   not exist. The rate is worse and the tool is not why.
4. **hono — MET.** `HandlerInterface`'s call signature came back alongside the
   `get:` alias, in one lookup: `(path: P, handler: H<E2, MergedPath, I, R>) =>
   HonoBase<E, …>`. That is the exact miss that cost three abstentions pre-fix.
   All three hono lookups answered.
5. **zod at 1078 chunks**, from 2565. The rebuild happened.

## What the re-run found — three new defects

### 7. A chunk was cut in half by a match INSIDE a match — FIXED

`splitAtMatches` advances the scan by one character so a line-anchored declaration
inside a consumed match is not skipped. It then also **cut** at those inner
matches, severing a declaration from the modifiers that open it.

`CARGO_DECL_SPLIT_RE` absorbs leading `#[…]` attributes precisely so an attribute
stays with its item. The inner re-match at the bare `impl` line undid it, and the
attribute was emitted as a chunk of its own — a file header and a dangling
attribute, no declaration:

```
// src/core/de/value.rs
#[cfg(any(feature = "std", feature = "alloc"))]
```

serde 1.0.229 held **19 byte-identical copies** of that one, and 98 duplicate
bodies over 448 chunks. Each is a candidate for the eight-chunk retrieval budget.
Two identical `KeyMap` chunks took two of the eight slots on a real aeson lookup
in this run.

Measured on the fixed build, same packages, fresh cache:

| | chunks | duplicate bodies |
|---|---|---|
| serde | 448 → **297** | 98 → **0** |
| axum | 475 → **381** | 27 → **0** |
| serde_json | 339 → **288** | 24 → **0** |
| zod, hono | unchanged | 0 → 0 |

Byte totals hold (serde 214,508 → 211,018): what went was 151 duplicated `//
path` headers, not content. `export\nfunction a(){}` is now one chunk too, which
is what it always was.

The fix refuses to cut at a match that begins inside the last accepted one.

### 8. The index hash did not cover the chunker — FIXED

`computeContentHash`'s own docstring says "The CHUNKER counts too". It did not.
The hash carried `profile.declSplitRe.source`, and defect 7 lived in
`splitAtMatches`, so the fingerprint would not have moved for the fix above and
every already-indexed package would have kept its dangling attribute chunks
forever. The chunker's source is now in the hash.

This is the same class as the earlier "index hash missed the chunker", recurring
one level down: a docstring asserting a property the code does not have.

### 9. `answers with 0 invented symbols` is a verify that cannot fail — INSTRUMENTED

The audit scored each answer's backticked symbols against `toolText`. `toolText`
is the **entire** tool return, and the answer prose is part of it — so the check
asked whether each answer contained itself. It always did:

| | ts | rs | hs |
|---|---|---|---|
| pre-fix run | 13/13 | 12/12 | 10/10 |
| this run | 13/13 | 4/4 | 2/2 |

54 answers across two independent runs, not one miss, while one of them shipped
```` `decodeFile` ```` — a function aeson 2 does not have — in backticks, and said
in the same breath that it "lives in `Data.Aeson` in reality".

Removing the answer from the corpus is **not** the fix, and this was measured
before it was written: what remains is the child's own *cited* excerpt, a line or
two, and it flags `from_str`, `Context` and `safeParse` as invented. Both corpora
are wrong. The one the question needs is the retrieved chunk text handed to the
extraction child, which no log written before this session recorded.

`retrievedText` is now on the log record and written at both call sites. Until a
run is recorded with it the audit prints `not scoreable`, which is the only
honest thing it can print. The row in `live-docs-run-2026-09-05/AUDIT.md` should
be read as unmeasured, not as clean.

## Still open

- **aeson keeps 55 duplicate bodies** after defect 7. Different component: the
  hackage surface extractor truncates a multi-line instance head to its first
  line, so `instance {-# OVERLAPPING #-}` — whose type sits on the indented
  continuation at `FromJSON.hs:1337` — becomes a content-free chunk. 4% of the
  package, all internal generic machinery, no public API lost. Not fixed.
- **A query whose key symbol does not exist in the corpus cannot be answered.**
  FTS matches whole tokens, so `decodeFile` matches nothing when only
  `decodeFileStrict` is indexed, and `Data.Aeson` tokenises to `Data` + `Aeson`,
  which every chunk in the package carries. Nothing in such a query discriminates.
  Stripping English stopwords was tested and **refuted** — it moves the failure to
  a different wrong file rather than fixing it. This is what cost hs seven
  lookups.


---

---

# Second re-run, 2026-09-06, on 0.40.3

`live-docs-rerun2-2026-09-06/` holds the recorded answers, builds and audit.
Container `mx5-n`, `@mjasnikovs/pi-task@0.40.3` **installed from npm and checked by
grepping the dist for `acceptedEnd`, `chunkerFingerprint` and `retrievedText`** —
the previous session hand-copied a build, so the version string alone proves
nothing. Same model as the last run, Qwen3.8-27B on llama.cpp `b10734-d5d993a09`.

The cache was **left in place**. That is the check: the chunker changed, so the
freshness hash must re-index every package on first touch.

| | ts (npm) | rs (cargo) | hs (hackage) |
|---|---|---|---|
| verdict | PASS | PASS | PASS |
| abstained | 4/17, 24% (was 7%) | 4/10, 40% (was 20%) | 5/6, 83% (was 80%) |
| build/test | green | green | green |
| pins intact | 2/2 | 3/3 | 2/2 |
| 0 invented symbols | 10/13 | 5/6 | 1/1 |

## Defects 7 and 8 confirmed in a live run

Every package re-indexed on first touch, to the byte the offline measurement
predicted, and `serde` did it mid-run when a real lookup reached it:

| | before | after |
|---|---|---|
| axum | 475 chunks, 27 dupes | 381, **0** |
| serde_json | 339, 24 | 288, **0** |
| serde | 448, 98 | 297, **0** |
| zod, hono | unchanged | 0 dupes |

`aeson` re-indexed and stayed at 1326/55 — its duplicates are the hackage surface
extractor, already named as open, not the chunker.

## The `tower` case is finally exercised

Last run this fix went untested because nothing reached for `tower`. This run did,
and the warning fired, ahead of the answer:

```
[DEPENDENCY] "tower" is present in this project but is not a declared dependency in
Cargo.toml — it resolves only because something else pulled it in.
```

`tower` is in `Cargo.lock` and not in `Cargo.toml`. Correct.

## Defect 10. The fidelity scorer failed the correct answer — FIXED

`retrievedText` was populated on all 33 records, so the row printed a number for the
first time. It printed **13/20**, and every one of the 17 flags was false.

Sixteen were a symbol the child named **in order to deny it**. These runs ask about
symbols that do not exist, so the best available answer is a refutation, and the
scorer read each refutation as three fabrications:

> The content contradicts several claimed signatures: `eitherDecode` is actually
> `LBS.ByteString -> Either String a` (not `DecodeError`) ... neither
> `eitherDecodeFile` nor a `prettyShow`/`DecodeError`/`failureMsg` type appears.

scored `DecodeError eitherDecodeFile prettyShow failureMsg`. The seventeenth was
`POST'`: `IDENTIFIER_RE` admits a trailing `'` so Haskell primes survive whole, and
it swallowed the closing quote of `{ method: 'POST' }`.

The fix skips a sentence that denies, and accepts a prime whose stem the corpus knows.

**Excusing every symbol the QUESTION supplied was written first, measured, and
rejected.** It clears all 17 — and it also clears `Use ``decodeFile`` to read a
file`, because these questions name the fabrication. That answer is the entire
defect, so a rule that hides it is worse than the noise it removes. Both rules are in
`test/scripts/docs-live-audit.test.ts`; the guard test asserts a confirmed
`decodeFile` still flags.

After the fix, 16/20 clean and four flags left, all benign and all pre-existing:
`false` from `{ success: false, error }`, `fields`/`are` and `assert` from prose
inside a code span, and `adminEmail`, which the child derived correctly from
`#[serde(rename_all = "camelCase")]` on `admin_email`.

**Zero real fabrications in 20 scored answers.** That is the first time the number
has meant anything.

## Defect 11. An English question loses the declaration the bare symbol wins — OPEN

`from_str` is the cargo ground-truth symbol, and both re-runs answered that its
signature was not in the retrieved content. It is indexed. The declaration chunk is
91 bytes, one line, in `src/de.rs`:

```
pub fn from_str<'a, T>(s: &'a str) -> Result<T> where T: de::Deserialize<'a>,;
```

Same corpus, same package, two queries:

```
rank of the declaration: NOT RETRIEVED of 6   <- "What is the exact signature of from_str? What error type does it return?"
rank of the declaration: 1 of 17              <- "from_str"
```

The 1159-byte `from_slice` chunk from the same file ranks 3rd on the prose query,
because its doc comments match `signature`, `error`, `type` and `return`. BM25 gives
the English half of the question as much say as the symbol, and the English half
matches the chunks that talk *about* the API rather than the one that *is* it.

This is the same class as the open `Data.Aeson` note, but sharper and measurable, and
it costs a ground-truth symbol on the ecosystem where the model has fallback
knowledge to hide it. Stopword stripping is already refuted; weighting symbol-shaped
tokens above English ones is untested. **Not fixed — measured only.**

## Defect 12. A facade package indexes to nothing — OPEN

hs abstained three times on `hspec`, every time with the same 1915 characters
retrieved, because the entire `hspec` index is 14 chunks:

```
906  src/Test/Hspec.hs         module Test.Hspec ( Spec , SpecWith , Example , Arg ...
 90  src/Test/Hspec/Runner.hs  module Test.Hspec.Runner (module Test.Hspec.Core.Runner)
```

`it`, `describe` and `shouldBe` are in the corpus as bare names in an export list.
Every signature is in `hspec-core`, a transitive dependency the indexer never opens.
The tool returned everything it had and the child correctly abstained.

Distinct from the open "key symbol absent from the corpus": here the symbol is
present, with no signature attached. Facade packages are the norm on hackage.

## Defect 13. No `.gitignore` in the seeded projects — OPEN, fixture

`autoCommit` committed the build directories, because `docs-live-seed.ts` writes each
manifest by hand and never writes a `.gitignore`. Tracked at HEAD mid-run: **1397**
files under `node_modules/` in ts, `target/` in rs, 8 under `dist-newstyle/` in hs.

Every build a child runs then dirties graded state. rs TASK_0003 spent a whole turn
recovering — from its own transcript:

> The verify was discarded by the git-state guard because my previous session (and
> the verify child's own cargo build) mutated tracked target/ files ... The repo
> unusually tracks target/ in git, so any build touched "graded state."

Costs run time and pollutes the diff. Not a docs-tool defect.

## The three checks that came back clean

- **No filenames in the cache.** Fourteen packages indexed, every one real.
  `tower` is there because a lookup legitimately asked about it.
- **Pins.** 7/7 across three ecosystems, from three version sources.
- **No stale majors.** Zero marker hits in any tree; all three build and test green.

## What did NOT improve

The chunker fix is proven in the index and **not** visible in the answers. serde_json
lost 51 duplicate chunks and its `from_str` answer is the same non-answer as last run
— the miss was never a duplicate crowding the budget, it was defect 11. Freeing slots
does not help when the ranking never wanted the right chunk.

`scotty` was indexed and never asked about, for the second run running. The hackage
abstention rate is again a fact about the questions, not the tool: 3 of 6 hs lookups
were `hspec` (defect 12) and 2 of the remaining 3 asked for `decodeFile`,
`DecodeError` and `prettyShow`, none of which aeson 2 has. The one question that
named a real symbol, `eitherDecode`, was answered.
