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
