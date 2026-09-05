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
