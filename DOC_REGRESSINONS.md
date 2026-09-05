# Docs live test — findings

Working notes for the live docs test across TypeScript, Rust and Haskell.
Everything below was checked on this machine, not assumed.

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
