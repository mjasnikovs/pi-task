# Docs live run — runbook

The full `/task-auto` loop across TypeScript, Rust and Haskell.
Findings and open items live in `DOC_REGRESSINONS.md`; read that first — most
open items are settled by `scripts/docs-replay.ts` and never need this.


Only defect 14 and the abstention-rate metric require this. Budget 3-4 hours.
Everything else the docs worker does is a subagent, and `scripts/docs-replay.ts`
exercises it in minutes. Reach for this file only when that one cannot answer.

Five scripts in `scripts/`, nothing runs on import:

```
docs-live-truth.ts   pins, ground-truth symbols, stale-major markers (data only)
docs-live-seed.ts    creates the three greenfield projects with deps installed
docs-live-run.ts     drives one project through a real /task-auto in tmux
docs-live-build.ts   records each project's build verdict where the toolchains are
docs-live-audit.ts   scores the recorded answers and writes AUDIT.md
```

## Runner

`docker start mx5-n`. Already `yoloMode`, `debugLogs: "full"`, `autoCommit`, host
network, reaches the local model. Never on the host — runs write
`~/.cache/pi-worker/docs.sqlite` and the container isolates your real cache free.

```bash
docker exec mx5-n bash -lc 'for c in pi bun node cargo ghc cabal tmux; do
  printf "%-6s %s\n" "$c" "$(command -v $c || echo MISSING)"; done'
```

Provisioning notes that cost time the first go: pi-task **must** match the tree
under test (`npm install @mjasnikovs/pi-task@<version>` in `~/.pi/agent/npm`);
ghcup must come from `raw.githubusercontent.com/haskell/ghcup-hs/...`, because
`get-haskell.ghcup.haskell.org` does not resolve here; GHC is 15-25 min and ~3 GB.

## Pins, then seed

A stale pin measures nothing — the point is that the model predates the major.
Check the registries, not the table.

```bash
curl -s https://registry.npmjs.org/zod | jq -r .\"dist-tags\".latest
curl -s -H 'User-Agent: pi-task-live' https://crates.io/api/v1/crates/axum | jq -r .crate.max_stable_version
curl -s -H 'Accept: application/json' https://hackage.haskell.org/package/scotty/preferred | jq -r '."normal-version"[0]'
```

Watch for solver conflicts. `scotty 0.30` caps `aeson < 2.3`, so the aeson pin is
the newest scotty allows, not the newest that exists.

```bash
docker exec mx5-n bash -lc 'mkdir -p /home/agent/docs-live/scripts'
for f in truth seed run build audit; do
  docker cp scripts/docs-live-$f.ts mx5-n:/home/agent/docs-live/scripts/
done
docker exec mx5-n bash -lc 'export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"; . ~/.ghcup/env
  cd /home/agent/docs-live && bun scripts/docs-live-seed.ts /home/agent/docs-live/run'
```

## Pre-flight, before spending three hours

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

Every line `ok`, every version equal to its pin. A `FAIL` here is a fixture
problem, not a finding.

Then verify the scorer **in both directions**. Hand-write one tree using each stale
marker and confirm HARD FAIL, then a correct tree and confirm PASS. A verify that
cannot fail is not a verify; a scorer that fails correct code is just as useless.

## Run

`/task-auto` only works through a real terminal. `docs-live-run.ts` uses tmux
`send-keys`.

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
docker exec -d mx5-n bash -lc 'setsid bash -c "
  for id in ts rs hs; do
    /home/agent/docs-live/run.sh \$id 180 > /tmp/run-\$id.log 2>&1
  done; echo SEQUENCE COMPLETE" > /tmp/chain.log 2>&1 < /dev/null'
```

**Verify the environment actually reached pi.** `tmux new-session` inherits the
tmux *server's* environment, so a server left running from an earlier shell drops
your variables and the answer log stays empty.

```bash
docker exec mx5-n bash -lc 'for p in $(pgrep -x pi); do
  cat /proc/$p/environ 2>/dev/null | tr "\0" "\n" | grep PI_TASK && break; done'
```

Loop over every `pi` pid — killed runs leave defunct processes and
`pgrep -x pi | head -1` picks one. And read with `cat`, not a redirect:
`< /proc/$p/environ` fails in *bash*, before `2>/dev/null` can suppress anything,
so the screen fills with `Permission denied` that reads exactly like the variables
being missing.

## Score

The build runs where the toolchains are; the audit runs here. The audit never
re-runs a lookup.

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

Then read the answers themselves. Every finding here came from reading individual
records, not the summary table.

And read the cache's own `packages` table — defect 1 was visible only there,
because the enrichment path calls `docsRaw` directly and only the tool wrapper
writes the answer log. Anything in that list that is not a real dependency is a
finding.

```bash
docker exec mx5-n bash -lc 'node -e "
const {DatabaseSync} = require(\"node:sqlite\")
const db = new DatabaseSync(process.env.HOME + \"/.cache/pi-worker/docs.sqlite\")
for (const r of db.prepare(\"select ecosystem,name,version,indexed_at from packages order by indexed_at\").all())
  console.log(new Date(Number(r.indexed_at)).toISOString().slice(11,19), r.ecosystem, r.name, r.version)"'
```

## Traps, all of which cost a run the first time

| | |
|---|---|
| `pi -p "/task-auto …"` | dispatches nothing; the text goes to the model as a message |
| the remote bridge | reaches the handler, then throws on `newSession` — *after* planning |
| tmux `send-keys` | needs `-l`, Enter as a separate call, and ~25 s for pi to boot first |
| tmux env | inherited from the *server*, not the client |
| a file left in the tree | `worker:files` reads it as project source — keep captures outside |
| a harness file in `/tmp` | the RUN writes there too. `/tmp/probe.mjs` came back as the ts run's own test script. Keep harness files under `/home/agent/harness/` |
| `pgrep -x pi` after a run | the finished runs leave ZOMBIES (`ps -o stat` shows `Zs`). They cannot be killed and do not matter; check `stat` before chasing one |
| `cabal test` | can be green while `cabal build all` fails; compile before you test |
| the 8-minute settle | can cut the final gate; tasks and tree are still fully scoreable |
| task count | has no cap. `granularityFloor` only pushes up, and renumbering a spec does not shrink it — ask for fewer deliverables |

## Score the RETRIEVAL, without a model

`scripts/docs-defines.ts` asks the one question about retrieval that is not
saturated: does a returned chunk DEFINE the symbol the query names? "Mentioned"
reads 101/101 on every arm of every comparison; "defines" reads cargo 26/26, npm
38/42, hackage 26/33, and it moved on defect 21 at p=1.2e-4.

It re-retrieves, so it runs HERE, against pinned deps, with the cache's package
set held fixed across arms.

```bash
bun scripts/docs-defines.ts /home/agent/allrec/*.jsonl   --project ts=<ts project> --project rs=<rs project> --project hs=<hs project>   --out /tmp/a.jsonl
bun scripts/docs-defines.ts --compare /tmp/a.jsonl /tmp/b.jsonl   # paired, exact McNemar
```

Two arms means two trees and two `XDG_CACHE_HOME`s, never one cache re-indexed —
defect 17 is why.

## Instrumentation

- `PI_TASK_TYPEONLY_LOG=<file>.jsonl` — one JSON line per docs **answer**: `module`,
  `query` verbatim, the child's prose, `unclear`, `excerptCheck`, `retrievedText`
  and `toolText`. Parser: `readTypeOnlyLog` in `src/workers/typeonly-log.ts`.
- `.pi-tasks/*-debug.log` — one line per docs **call**, tagged with the phase. The
  query is truncated at ~60 chars here; the JSONL has it whole.

**Refusals are in neither sink.** `logDocsAnswer` fires only on the answer path, so
a refused lookup writes no JSONL record. A trail call with no matching JSONL record
is a refusal or a crash. Do not widen `logDocsAnswer` to cover refusals: it would
corrupt the denominator the type-only firing rate is computed against.

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
