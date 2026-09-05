# Docs live test — findings

Working notes for the live docs test across TypeScript, Rust and Haskell.
Everything below was checked on this machine, not assumed.

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

And read the cache's own `packages` table — defect 5 is visible *only* there, because the
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

## What a result means

Compare against `live-docs-run-2026-09-05/AUDIT.md`. The number that carries the signal is
the **abstention rate per package**, not the pass/fail: npm 24%, cargo 29%, hackage 55%
was the baseline, with aeson at 8 of 11.

And read the verdict the right way round. TypeScript passed *with* three hono non-answers,
because the model knew hono already. A green run does not mean the docs tool worked — it
means the tool's failures were survivable that time. Haskell is the honest test, because
there the model had nothing to fall back on.

---

## Blockers found in the `mx5-n` container

The container is the right runner — `yoloMode: true`, `debugLogs: "full"`,
`autoCommit: true`, host network, and the local model is reachable from inside it.
Three things stop it as it stands.

### 1. It runs pi-task 0.39.4; the ecosystems work is in 0.40.0

```
~/.pi/agent/npm/package.json   "@mjasnikovs/pi-task": "^0.39.4"
installed                       0.39.4
main                            0.40.0  (26a86c0)
```

`6384ce6` merged `issue-18-docs-ecosystems` and `26a86c0` released it as 0.40.0. So the
container would test the build from *before* cargo and hackage support landed. It has to
be upgraded, or the local `dist/` linked in, before any run means anything.

### 2. No Rust and no Haskell toolchain

```
pi    /usr/bin/pi        cargo  -
node  /usr/bin/node      rustc  -
npm   /usr/bin/npm       ghc    -
bun   -                  cabal  -
```

Only node and npm. The Rust and Haskell tasks cannot build there, and `bun` is missing
too, so the TypeScript task cannot use `bun:test` — it needs `node --test`, or bun has to
be installed.

### 3. `~/.cabal` and `~/.cargo` do not exist in the container

The docs tool reads crates from `$CARGO_HOME/registry/src` and Hackage tarballs from
`$CABAL_DIR/packages`. Neither is present, so every cargo and hackage lookup would fall
through to a registry download. That is a valid path and worth testing, but it is not the
same path a user with a warm cache takes.

## Host state

- `pi` 0.85.0, model `Qwen3.8-27B-UD-Q4_K_XL` at `127.0.0.1:8080`, 140k ctx.
- `cargo` present, 531 crates under `~/.cargo/registry/src`.
- `cabal` and `ghc` 9.10.3 present; `~/.cabal/packages` holds ~30 packages —
  `aeson` yes, `scotty`/`warp`/`hspec` no.
- **No Haskell project exists anywhere on disk.** `scripts/docs-ecosystem-live.ts`
  points its two hackage targets at `~/hs-scratch`, which does not exist. Those two
  targets fail unless `PI_TASK_LIVE_HS_PROJECT` is set.
- Docs cache `~/.cache/pi-worker/docs.sqlite` is 301 MB / 11,191 chunks for 7 packages:
  cargo `serde_json` `tokio`, hackage `aeson` `text`, npm `hono` `tokio` `zod`.
  `npm tokio 0.1.2` is a real but unrelated npm package — the wrong-ecosystem hazard the
  README names, sitting in the cache.

## Task-count control

There is **no cap** on how many tasks `/task-auto` produces. `MAX_TASKS = 30` was removed.
What exists is a *floor* that pushes the other way:

```
granularityFloor(ownable) = ownable < 5 ? 0 : ceil(ownable / 2)
```

`ownable` is the count of extracted requirements that are not cross-cutting
(`auto-orchestrator.ts:709`). So:

| ownable requirements | floor | 
|---|---|
| 0-4 | 0 — no split pressure at all |
| 5 | 3 |
| 10 | 5 |
| 21 | 11 |

**The lever is the spec.** A `TASK.md` that extracts at most 4 ownable requirements sets
the floor to 0, and `planShapeIsHostsToAnswer` also returns false, so the host does not
seize the plan-shape fork either. Both checks use the same cut and both go quiet below 5.

That is how the runs are held to roughly 4 tasks: write four requirements, not more.
There is nothing to configure.

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

## Versions live today

Checked against the registries, not remembered.

| | | |
|---|---|---|
| npm | `zod` | 4.5.4 |
| npm | `hono` | 4.13.7 |
| cargo | `axum` | 0.8.9 |
| cargo | `tokio` | 1.53.1 |
| cargo | `serde_json` | 1.0.151 |
| hackage | `aeson` | 2.3.1.0 |
| hackage | `scotty` | 0.30 |
| hackage | `hspec` | 2.11.17 |

The docs cache holds `zod` 4.4.3 and `hono` 4.13.5 — both a patch behind. The freshness
check has teeth.

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

## Driving `/task-auto` headlessly

`pi -p "/task-auto …"` **does not work**. Print mode hands the text to the model as an
ordinary message; slash commands are never dispatched. Verified:

```
$ pi -p "/task-nonexistent hello"
Hey! 👋 I notice a `/task-nonexistent` reference, but I'm not sure what
that's pointing to — there's no such task file or instruction I can find.
```

The working path is **the remote bridge**. `registerBridgeCommand` records every
command in the bridge as well as with pi, and `dispatchRemoteLine` runs any line
starting with `/` through it. So:

1. Run pi under a pty — `script -qec pi /dev/null` — in the fixture directory.
2. The remote server binds **port 8800** (`listenWithRetry(httpServer, 8800, 100)`),
   WebSocket path **`/ws`**, not `/`.
3. Send `{"type":"message","text":"/task-auto <feature>"}`.

Confirmed end to end — an unregistered name comes back on the socket as:

```
{"type":"notify","message":"Unknown command: /task-nonexistent","level":"warning"}
```

`remote: true` is already set in the container's config, so the server is up without
any change. The container has `bun` (after provisioning) whose native `WebSocket` is
the client; python3 there has no `websockets` module and pip is PEP-668 locked.

## Container provisioning, as done

| | |
|---|---|
| pi-task | 0.39.4 → **0.40.1** via npm; matches `origin/main` exactly |
| bun | 1.4.2 |
| rust | rustc/cargo 1.98.1, rustup minimal profile |
| ghc | via ghcup — see the DNS note below |

`get-haskell.ghcup.haskell.org` **does not resolve** from the container. The bootstrap
script has to be fetched from
`raw.githubusercontent.com/haskell/ghcup-hs/master/scripts/bootstrap/bootstrap-haskell`
instead. The bootstrap also installs only `ghcup` itself — `ghcup install ghc --set
recommended` and `ghcup install cabal --set recommended` are separate steps, and it
prints "All done!" without them.

## Requirement count: four obligations extracted as six

The spec was written as four numbered obligations precisely to keep
`granularityFloor` at 0. The run disagreed:

```
requirement extraction: 6 grounded requirement(s) kept
granularity floor: 6 ownable requirement(s) ⇒ at least 3 task(s)
```

So the extractor does not map one numbered clause to one requirement — a clause
carrying two obligations ("read config.json **and** validate it with zod") splits.
Four written obligations became six ownable ones and put a floor of 3 under the plan.

The practical rule: to hold a run at N tasks, write roughly `2N/3` obligations, not N.
The floor still bounds the run to 3-4 tasks here, which is what was wanted, but the
mapping is not one-to-one and a spec written to the literal count will overshoot.

## Audit scorer, verified both directions

Before any real run was scored, the audit was run against two synthetic trees.

**Bad tree** — every marker fires, nothing is missed:

```
ts  HARD FAIL  zod 4 exposes .issues, not .errors
               zod 4 uses z.email() / z.url() / z.uuid()
rs  HARD FAIL  axum 0.8 writes path params as {id}, not :id
               pin moved: axum 0.8.9 -> 0.7.9
hs  HARD FAIL  aeson 2 objects are Data.Aeson.KeyMap
```

**Clean tree** — no false positives:

```
ts  PASS
rs  PASS
```

A verify that cannot fail is not a verify, and a scorer that fails a correct tree is
just as useless. Both directions were checked before the instrument was trusted.

## Pre-flight: all three ecosystems resolve to the exact pin

Run against the seeded fixtures with the container's own pi-task 0.40.1, before any
`/task-auto` run, with `XDG_CACHE_HOME` redirected so the real cache is untouched:

```
ok    zod          npm zod@4.5.4              chunks=8
ok    hono         npm hono@4.13.7            chunks=8
ok    axum         cargo axum@0.8.9           chunks=8
ok    serde_json   cargo serde_json@1.0.151   chunks=8
ok    aeson        hackage aeson@2.2.5.1      chunks=8
ok    scotty       hackage scotty@0.30        chunks=8
```

Every one resolved to the manifest's pin, from three different version sources —
`package.json`, `Cargo.lock`, and `dist-newstyle/cache/plan.json`.

The container's cabal (3.16) files tarballs under `~/.cache/cabal/packages`, not
`~/.cabal/packages`. `defaultCabalPackageDirs` already covers that XDG path, so
hackage resolution worked with no configuration.

## Retrieval recall 11/12 — and the one miss is BM25, not extraction

Scoring the twelve truth symbols against the chunks each lookup returned:

```
HIT  zod safeParse · zod issues · hono Hono · hono json
HIT  axum Router · axum Json · serde_json from_str · tokio TcpListener
HIT  aeson eitherDecode · aeson FromJSON · scotty scotty
MISS scotty ActionM
```

`ActionM` is **not** missing from the index. The scotty package has 312 chunks and
**67 of them contain `ActionM`**, including the declaration itself:

```
Web/Scotty.hs | type ActionM = ActionT IO
```

So the Haskell surface extractor is fine. This is a **ranking** miss. Query sensitivity,
same package, same index:

| query | |
|---|---|
| `the handler monad` | MISS |
| `handler type for a route` | MISS |
| `ActionM handler type` | HIT |
| `what monad do route handlers run in` | HIT |
| `get route handler json response` | HIT |

The pattern is length. Both misses are short queries built from common English words;
the longer ones retrieve it even though none of them names the type either. With a
top-8 limit and 312 chunks, a three-token query of high-frequency words cannot separate
the 67 relevant chunks from the rest.

**How much this matters is not yet settled.** Real worker queries in existing trails are
long and symbol-heavy — `bun "sql tagged template literal, SQL class, import { sql } from…"` —
which is the regime that retrieves correctly here. Whether a worker ever writes a query
short enough to trip this is a question for the run's own logs, not for these synthetic
ones. The audit scores the queries the run actually made, so it will answer it.

## The remote-bridge path cannot start `/task-auto` — corrects the finding above

The WebSocket dispatch **does** reach the handler, but the run dies immediately:

```
Error: TASK_AUTO_0001 stopped:
  Run /remote in the terminal once to enable /task, /task-auto, and /new from remote.
```

`/task-auto` needs `ctx.newSession` to open a session per task. A line arriving over the
bridge before any terminal command has run is handed the **shimmed** ctx built from an
event ctx, and its `newSession` is a function that throws exactly that message
(`remote/bridge.ts:411-415`). `b.currentCtx` is only populated by a command invoked from
the terminal — `if (!isRemoteOrigin(ctx)) b.currentCtx = ctx`.

So remote dispatch works for commands that need no new session, and cannot start a task
run cold. The planning phase completed anyway and wrote a full plan before the failure,
which is why this took a whole run to surface: the trail looks healthy right up to the end.

**The fix is to drive the real terminal.** `tmux` is present in the container, so the
driver starts pi in a tmux session and uses `send-keys`. That is also the path a user
actually takes, which the bridge never was. Confirmed working — the run now reaches
`state: in_progress` and proceeds past the point the bridge run died.

Two details the tmux path needs. The line must be sent with `send-keys -l` and Enter as
a separate call, or the feature text's own characters are read as tmux key names. And pi
needs about 25 seconds to boot before the prompt accepts anything — a line sent into a
starting TUI is silently dropped, with no error in the pane or the trail.

## Six tasks from four obligations — the count control did not hold

The plan came out at **six** tasks, one per extracted requirement:

```
6 grounded requirement(s): 6 task-mapped, 0 cross-cutting, 0 unowned
```

The floor was 3 and the model chose 6. So `granularityFloor` bounds the plan from below
and nothing bounds it from above — confirming there is no cap.

**Shrinking the clause count does not shrink the requirement count.** The spec was
rewritten from four numbered clauses to three, and extraction went *up*:

| spec | numbered clauses | extracted | floor |
|---|---|---|---|
| v1 | 4 | 6 | 3 |
| v2 | 3 | **7** | **4** |

Because v2 compressed rather than removed — clause 2 became "returns the config as JSON
on success **and** HTTP 400 with the issues when invalid", which is two obligations in
one clause. The extractor counts obligations in the prose; the numbering is decoration.

So the lever for task count is **how many things the feature asks for**, not how they are
punctuated. A spec cannot be held to N tasks by renumbering it. That is worth knowing
before anyone tries to bound a run by editing its formatting.

## The plan is six tasks whichever spec is used

| spec | clauses | extracted | floor | tasks planned |
|---|---|---|---|---|
| v1 | 4 | 6 | 3 | 6 |
| v2 | 3 | 7 | 4 | 6 |

Six both times. The floor moved, the extraction count moved, the plan did not. What the
model appears to settle on is one task per *deliverable it can name* — scaffold, schema,
loader, app, error path, tests — and for a feature of this shape that is six, whatever
the floor underneath it says.

The consequence for anyone trying to bound a run: neither the clause count nor the
granularity floor is a task-count control. The only reliable lever is asking for fewer
deliverables.

## Cache isolation, as it actually ended up

The plan called for a redirected `XDG_CACHE_HOME`. The runs do not set it, and that is
the right outcome: they run inside the container, so `~/.cache/pi-worker/docs.sqlite`
there is already isolated from the host's 301 MB cache. All three runs share the
container's own cache, which keeps them comparable to each other.

The pre-flight probes used a separate `docs-live/cache`, so each run starts **cold** on
the packages it looks up — real first-call ingestion cost included, which is what a user
sees on a fresh project.

Verified on the live process rather than assumed:

```
/proc/<pi>/environ:
  PI_TASK_TYPEONLY_LOG=/home/agent/docs-live/ts.jsonl
  PI_TASK_DEBUG_LOG=full
```

Worth checking every time: `tmux new-session` inherits the environment of the tmux
**server**, not the client that asks for the session. If a server is already running from
an earlier shell, the variables exported next to the `new-session` call never reach the
process. Here the server was created by the driver itself, so they did.

## TASK_0001: the apis worker read `package.json` instead of asking docs

First task of the TypeScript run — "scaffold the project with hono and zod". The research
fan-out ran all four workers, `worker:apis` among them, and made **zero** docs calls:

```
worker:apis: start
worker:apis: read: node_modules/zod/package.json
worker:apis: read: node_modules/hono/package.json
worker:apis: writing answer…
worker:apis: done exit=0 work=113977ms
```

Nothing in the whole task trail matches `pi-worker-docs`. The worker whose job is the API
surface reached for the plain `read` tool on two package manifests — files that contain no
API — and wrote its answer from those.

**Not yet a defect.** This task is scaffolding: tsconfig, directory layout, dependency
entries. There may be no API to look up, and 114 seconds of a read-only worker is cheap.
The tasks that need zod's and hono's actual surface are 2 through 5, and whether *those*
call docs is the real question. Recorded now so the comparison is on the record either way.

## Harness leak: the tty capture was inside the tree

`worker:files` read `/home/agent/docs-live/run/ts/.pi-tty.log` as project source, next to
`config.json` and `FEATURE.txt` — a 168 KB terminal capture left by the previous, failed
run. The harness had put itself into the context it was measuring.

Fixed: the capture is written outside the project root as `<root>/../<id>.tty.log`, and
the stale files were deleted from all three trees. Anything a driver writes into the
project under test is research input, not a side file.

---

# The two real defects

Both found by TASK_0002 of the TypeScript run, both measured, both general.

## 1. A dead major is indexed as if it were the current API

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

## 2. Every `.d.cts` is indexed as a second copy of its `.d.ts`

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

## The wrong answer did not produce wrong code

The code that came out of TASK_0002:

```ts
export const configSchema = z.object({
  name: z.string(),
  port: z.number().int().min(1).max(65535),
  adminEmail: z.email(),
});
```

`z.email()` — the **correct** zod 4 form. Not the `z.string().email()` the docs answer had
just "confirmed".

This has to be stated plainly, because it cuts against the finding above. The docs answer
was wrong and the delivered code was right. Whatever the model used to choose `z.email()`,
it was not the sentence that confirmed the deprecated idiom.

Two things are visible in the same records that plausibly did the work: an earlier answer
said `int()` is "marked legacy (prefer `z.int()`)", and a later one surfaced
`/** Consider z.strictObject(A.shape) instead */`. The deprecation *convention* reached the
model even where the specific `@deprecated Use z.email()` line did not.

Note the other half, though: the schema uses `z.number().int()`, which is precisely the
form the docs answer called legacy. So the model took the modern form where the docs were
wrong and the legacy form where the docs were right.

**What this means for the verdict.** The stale-major sweep is a check on the delivered
tree, and on this evidence it will pass. The defect is real, measured, and reproducible —
and it did not, this time, reach the artifact. Both facts belong in the report. A finding
that has to be inflated to matter is not worth having.

## 3. Retrieval cannot follow a type alias — and hono aliases everything

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

## Harness limitation: the settle rule cuts the final gate

The driver calls a run settled after 8 minutes of no trail growth. The TypeScript run hit
that while the final gate was still on screen:

```
settled (quiet 8m) tasks=6 done=6
TASK_AUTO_0001  state: in_progress
no final-gate-debug.log
```

All six tasks completed and committed, so every docs call the run would ever make had
already happened — those all occur in per-task research. What is missing is the final gate's
own verdict, which is pipeline quality, not docs sufficiency.

Left at 8 minutes for all three runs rather than raised mid-sequence, because a bound that
differs between them would make the three incomparable for the sake of a number the audit
does not read. The limitation is stated instead of papered over: **these runs are scored on
their tasks and their tree, not on a final-gate verdict.**

The underlying cause is known — the gate can sit for minutes without writing the trail. A
progress signal, not a clock, is what this needs; the clock is the expedient here and is
recorded as such.

---

# Result: TypeScript — PASS

```
docs calls (trail)                 16
docs answers (jsonl)               17
refusals, research phases           0
abstentions ("unclear")             4
retrieval recall                  4/4
answers with 0 invented symbols  13/13
web lookup after a docs call        0
pins intact                       2/2
stale-major API                  none
bun test              2 pass, 0 fail
```

Six tasks, 86 minutes, all committed. The delivered code is correct:

```ts
// config.ts
adminEmail: z.email(),                       // zod 4 form, not z.string().email()

// app.ts
export const app = new Hono();
app.get("/config", async (c) => {
  const result = await loadConfig();
  if (result.ok) return c.json(result.config);
  return c.json(result.issues, 400);         // .issues, not .errors
});
```

Both stale-major traps avoided. `z.email()` where the docs answer confirmed the deprecated
`z.string().email()`, and `.issues` where zod 3 would have said `.errors`.

**And that is the finding, stated the way it actually happened.** Three of seventeen docs
calls returned nothing usable, and one returned a wrong signature for a deprecated API
presented as confirmed — yet the model wrote correct, idiomatic hono and zod 4 without
them. It never fell back to a web search either.

So the answer to "were the docs answers sufficient" is split, and both halves matter:

- **As an instrument, the docs tool underperformed.** Three hard non-answers on hono, one
  wrong answer on zod, on a task that is about as mainstream as TypeScript gets.
- **As a pipeline, pi-task was not blocked by it.** The model had enough from elsewhere —
  its own knowledge of hono 4, and the deprecation *convention* it did see — to produce a
  passing artifact.

The second half is not a defence of the first. A tool that can be ignored without
consequence on an easy task is a tool whose failures will surface on a hard one, where the
model has nothing to fall back on. The Rust and Haskell runs are exactly that harder case:
axum 0.8 and scotty 0.30 are far outside a 27B local model's confident knowledge.

## Minor: the plan's `## tasks` section carries the model's raw deliberation

In the Rust run's `TASK_AUTO_0001.md`, the `## tasks` section holds two real entries and
twenty-eight lines of the model's own reasoning, all rendered as markdown checkboxes:

```
- [x] TASK_0001  The crate has `axum`, `tokio`, `serde_json`, and `serde` as dep…
- [ ] TASK_0002  There's a `config.json` at the crate root with `adminEmail`…
- [ ] No `lib.rs` exists yet — needed for integration tests to import from
- [ ] First task: Create `src/lib.rs` with the `Config` struct…
- [ ] Task 1: Create `src/lib.rs` with `Config` struct + `load_config_from(path)`…
- [ ] Requirement (1) — tasks 1 and 2
- [ ] "Build a config module in Rust." [prose] — covered implicitly by all tas…
```

Only the two `TASK_NNNN`-prefixed lines are tasks. Anything counting checkboxes in that
section reads 30 where the answer is 2 — which is exactly the mistake made while auditing
this run, before checking against the `TASK_*.md` files on disk.

Cosmetic for the pipeline, since nothing downstream parses it that way, but the plan file
is the artifact a human opens to see what was decided, and this one is mostly noise.

Also worth recording for the task-count question: the Rust spec extracted **4** ownable
requirements against TypeScript's 7, from a feature of the same shape and length. No
granularity floor line was emitted at all, which means it was 0. Requirement extraction is
not stable across ecosystems for the same task.

---

# 4. The docs tool answers about crates the project cannot use

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

# 5. Backticked filenames are installed from npm as if they were packages

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
defect and defect 4 together.

---

# 6. Seven attempts at one signature, and the code was invented anyway

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

## The six defects, ranked by what they cost

1. **Backticked filenames installed as npm packages.** Ten registry installs across the
   runs — `config.ts`, `app.ts`, `tsconfig.json`, `name`, `port`, `lib`, `fetch` — each a
   real unrelated package, indexed as this project's documentation. Invisible to both
   sinks. Fetch targets chosen by model-written strings.
2. **Answering about undeclared transitive dependencies.** Caused the Rust HARD FAIL.
   Measured on npm too: a project with 23 declared dependencies exposes 106 packages the
   tool will confidently describe and that must not be imported.
3. **Retrieval cannot follow a type alias.** hono declares every verb as an interface
   alias; the signatures are one hop away and the top-8 never brings both. Three
   non-answers on the task that needed hono most.
4. **Ranking misses content that is indexed.** Seven scotty attempts, 67 candidate chunks,
   zero deliveries. Reproduced offline: short generic queries miss where longer ones hit.
5. **A dead major is indexed as current.** 414 of zod's chunks are zod 3, and an answer
   reproduced zod 3's `email(message?): ZodString` under a `Per zod@4.5.4:` header,
   omitting the `@deprecated` line sitting directly above the real declaration.
6. **Every `.d.cts` is a second copy of its `.d.ts`.** 2565 zod chunks, 1215 distinct
   bodies — 53% duplication, halving the effective breadth of a top-8 retrieval.

Defects 1 and 2 share a fix: enrich and answer only for names in the project's **declared**
dependencies, which `declaredDeps(cwd)` already provides. Defects 3, 4 and 6 are all
pressure on the same eight-chunk budget.
