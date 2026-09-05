Re-run the live docs test across TypeScript, Rust and Haskell, and score it against the
pre-fix baseline.

Run it end to end without stopping to ask. It is 3-4 hours of container time; launch it,
watch it, and report at the end. I am around the whole time — ask if something is genuinely
ambiguous or if a preflight check fails, but do not pause for permission on the steps below.

Read `DOC_REGRESSINONS.md` first. It has the whole loop — how to run it, the traps, the
instrumentation, and every defect's evidence. Do not re-derive any of it.

## What changed since the baseline

All six defects are fixed and published as `@mjasnikovs/pi-task@0.40.2` (branch
`docs-live-test`, commit `5109222`, tag `v0.40.2`). The fixes were verified by replaying
recorded data and the runs' own caches. **They have never been through a live run.** That
is what this session is for.

## Rule: the container must run the fixed build

The single most expensive mistake available here is measuring the wrong tree. Check it
first, before anything else:

```bash
docker start mx5-n
docker exec mx5-n bash -lc 'node -p "require(process.env.HOME+\"/.pi/agent/npm/node_modules/@mjasnikovs/pi-task/package.json\").version"'
```

It must print `0.40.2` or later. **As of writing it prints `0.40.1`, which is the tree the
defects were found in** — so upgrade it first and check again:

```bash
docker exec mx5-n bash -lc 'cd ~/.pi/agent/npm && npm i @mjasnikovs/pi-task@0.40.2 --no-audit --no-fund --loglevel=error'
```

Then confirm the fixes are actually in that build, not just the version string:

```bash
docker exec mx5-n bash -lc 'D=$HOME/.pi/agent/npm/node_modules/@mjasnikovs/pi-task/dist/workers
  grep -l dropDeadMajors $D/docs-index.js
  grep -l dropParallelDeclarations $D/docs-index.js
  grep -l hopNames $D/docs-retrieve.js
  grep -l manifestDeps $D/docs-ecosystems.js'
```

Four paths, or stop.

## Start cold

The container's `~/.cache/pi-worker/docs.sqlite` still holds the baseline run's index —
including zod at 2565 chunks, scotty at 312, and the ten packages that should never have
been installed. Reusing it would hide defects 1, 5 and 6 entirely, because the freshness
hash decides per package and the new file-selection rule is what forces a rebuild.

Move it aside rather than deleting it; it is evidence:

```bash
docker exec mx5-n bash -lc 'mv ~/.cache/pi-worker/docs.sqlite ~/docs.sqlite.prefix-baseline'
```

## Run it

Follow `DOC_REGRESSINONS.md` sections 1 through 4 exactly. One run at a time — a single
local model serves every child, so parallel runs contend and neither duration means
anything. Budget 3-4 hours.

Haskell is the run that matters. It failed hardest and the model had no knowledge to fall
back on.

## What to check when it is done

Compare against `live-docs-run-2026-09-05/AUDIT.md`. The pre-fix baseline is:

| | TypeScript | Rust | Haskell |
|---|---|---|---|
| verdict | PASS | HARD FAIL | HARD FAIL |
| abstained | 4 (24%) | 5 (29%) | 12 (55%) |
| build/test | green | RED | RED |

Five specific things, each tied to a defect. None of these is a prediction — they are what
to look at:

1. **The cache `packages` table must hold no filenames.** Ten appeared last time —
   `config.ts`, `app.ts`, `tsconfig.json`, `config.json`, `name`, `port`, `lib`, `fetch`.
   The query is in `DOC_REGRESSINONS.md` section 4. Anything there that is not a real
   dependency is a finding.
2. **`rs` build.** The baseline failed on `use tower::util::ServiceExt` where `tower` is
   a lock entry, not a declared dependency. The answer should now carry a `[DEPENDENCY]`
   warning. Check whether the model heeded it — the warning existing and the model
   ignoring it are two different results, and only the trail can tell them apart.
3. **hackage abstention, was 55%.** The largest number in the report. Read the scotty
   answers themselves, not the rate: did any lookup deliver
   `json :: ToJSON a => a -> ActionM ()`? Seven consecutive attempts missed it last time.
4. **hono abstention, was 3 of 6.** Did a lookup return `HandlerInterface`'s call
   signatures alongside the `get:` alias?
5. **zod's chunk count.** Measured at 1078 offline, from 2565. If the container reports
   2565 the cache was not rebuilt and points 1-4 mean nothing.

## Read the answers, not the table

Every finding in the baseline report came from reading the `toolText` of individual
records, not from the summary. Do the same. A green run does not mean the docs tool worked
— it means its failures were survivable that time.

## Two known-open cases

Do not report these as new:

- A query naming no proper noun (`the handler monad`, `handler type for a route`) still
  misses. The definition hop is name-directed and has nothing to chase.
- The 8-minute settle rule can cut the final gate. Tasks and tree are still scoreable.

## If you find something

Regression test first, and prove it fails on the current tree before writing the fix. Show
the failing output. Unit tests fake every spawn and registry, which is what makes them safe
offline and also what let all six original defects ship — so pin the specific observation,
not the general shape.

`bun run test` must stay green (4297 pass). `bun test` alone fails 345; the `--isolate` in
`bun run test` is load-bearing.
