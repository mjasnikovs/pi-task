Re-run the live docs test across TypeScript, Rust and Haskell and score it. This is the
second re-run: the first one is `live-docs-rerun-2026-09-05/`, and it is what you diff
against, not the original `live-docs-run-2026-09-05/`.

Run it end to end without stopping to ask. It is 3-4 hours of container time; launch it,
watch it, report at the end. I am around — ask if a preflight check fails or something is
genuinely ambiguous, but do not pause for permission on the steps below.

Read `DOC_REGRESSINONS.md` first. Sections 0-4 are the loop; the last section is the
re-run and the three defects it found. Do not re-derive any of it.

## What changed since the last run

Published as `@mjasnikovs/pi-task@0.40.3` (branch `docs-live-test`, commit `b15fdf2`,
tag `v0.40.3`) — three defects found by the last live run, all
fixed, `bun run test` green at 4303:

- `splitAtMatches` cut at a match starting inside the previous one, tearing a declaration
  off the attributes that open it. serde 448 → 297 chunks, 98 duplicate bodies → 0.
- `computeContentHash` did not cover the chunker, so the fix above would have moved no
  fingerprint and every cached package would have kept its stale rows.
- `retrievedText` added to the docs answer log, because the audit's fidelity row was
  scoring each answer against text containing that answer.

**None of this has been through a live run.** That is what this session is for. The same
sentence was true of the last session, and it stayed true because a fix verified on
recorded data is not a fix verified in a run.

## Rule: the container must run the fixed build

```bash
docker start mx5-n
docker exec mx5-n bash -lc 'cd ~/.pi/agent/npm && npm i @mjasnikovs/pi-task@0.40.3 --no-audit --no-fund --loglevel=error
  node -p "require(process.env.HOME+\"/.pi/agent/npm/node_modules/@mjasnikovs/pi-task/package.json\").version"'
```

The install is not optional even if the version already reads `0.40.3`: the last session
copied `dist/` in by hand, so the tree on disk may be a build nobody can name. Confirm the
three fixes are in what npm just put there:

```bash
docker exec mx5-n bash -lc 'D=$HOME/.pi/agent/npm/node_modules/@mjasnikovs/pi-task/dist/workers
  for m in acceptedEnd chunkerFingerprint retrievedText; do
    printf "%-20s %s\n" $m "$(grep -rl $m $D/ | head -1 || echo MISSING)"; done'
```

Three hits, or stop.

## Do NOT move the cache aside

Last time the cache had to go, because the freshness hash could not see the file-selection
rule. It can now, and `chunkerFingerprint` puts the chunker in it too. So leaving the cache
in place is itself a check: **every cargo and hackage package must re-index on first
touch**, because the chunker changed. If `serde` still reports 448 chunks, defect 8 did not
take and points 1-4 mean nothing.

Read the counts before the run and again after:

```bash
docker exec mx5-n bash -lc 'node -e "
import(\"node:sqlite\").then(({DatabaseSync})=>{
const db=new DatabaseSync(process.env.HOME+\"/.cache/pi-worker/docs.sqlite\")
for(const r of db.prepare(\"select ecosystem,name,count(*) c,count(distinct content) d from chunks group by 1,2\").all())
  console.log(r.ecosystem,r.name,\"chunks=\"+r.c,\"dupes=\"+(r.c-r.d))})"'
```

## Verify the log carries `retrievedText` — after three answers, not at the end

The whole point of this run is a metric that could not be computed before. If the field is
missing you have burned four hours to learn nothing, and you will only find out at the
audit. Check as soon as the ts run has written three lines:

```bash
docker exec mx5-n bash -lc 'node -e "
const r=JSON.parse(require(\"fs\").readFileSync(\"/home/agent/docs-live/ts.jsonl\",\"utf8\").trim().split(\"\n\")[0])
console.log(\"retrievedText:\", (r.retrievedText||\"\").length, \"toolText:\", (r.toolText||\"\").length)"'
```

A `retrievedText` of 0 means the run is worthless. Kill it and find out why.

## Run it

`DOC_REGRESSINONS.md` sections 1 through 4, exactly. One at a time — a single local model
serves every child. Haskell is still the run that matters.

## What to check when it is done

Against `live-docs-rerun-2026-09-05/`:

| | ts | rs | hs |
|---|---|---|---|
| verdict | PASS | PASS | PASS |
| abstained | 1/14 (7%) | 1/5 (20%) | 8/10 (80%) |
| build/test | green | green | green |

Four things, and only the first two are what this run is FOR:

1. **The fidelity row must print a number, not `not scoreable`.** That number is the
   headline. It has never been measured: the old scorer read 54/54 clean across two runs
   while one answer shipped `decodeFile`, which aeson 2 does not have. Whatever it says,
   read the flagged symbols themselves and decide whether the scorer is right — a loose
   scorer and a strict one are equally fatal, and this one is one session old.
2. **Did the chunker fix reach the ANSWERS?** The index change is proven offline. That a
   lookup got better is not. Compare recall and abstention on `rs`, where 149 duplicate
   chunks stopped competing for an eight-slot budget, and read the `toolText` of the axum
   and serde_json lookups against last run's.
3. **`rs` undeclared deps.** Still unexercised — last run never reached for `tower`. If it
   does not this time either, say so plainly rather than reporting the fix as verified.
4. **hackage abstention.** It ROSE to 80% last time and the docs tool was not why: the run
   never asked about scotty, and seven of ten lookups chased `decodeFile`. If that repeats,
   it is the model, not the tool. Read the queries before you read the rate.

## Read the answers, not the table

Every finding in both reports came from reading `toolText` on individual records. A green
run does not mean the docs tool worked — it means its failures were survivable that time.

## Known open — do not report as new

- aeson keeps 55 duplicate bodies. The hackage surface extractor truncates a multi-line
  instance head, so `instance {-# OVERLAPPING #-}` becomes a content-free chunk. 4% of the
  package, internal generic machinery only.
- A query whose key symbol is absent from the corpus cannot be answered. FTS matches whole
  tokens, and `Data.Aeson` tokenises to two terms every chunk in the package carries.
  Stripping English stopwords was tested and REFUTED — it moves the failure elsewhere.
- A query naming no proper noun still misses. The definition hop is name-directed.
- The 8-minute settle rule can cut the final gate. Tasks and tree are still scoreable.

## If you find something

Regression test first, and prove it fails on the current tree before writing the fix. Show
the failing output. If a test cannot fail before the fix — because the fix adds the seam it
tests — say so and prove the defect on the recorded data instead.

`bun run test` must stay green (4303 pass). `bun test` alone fails; the `--isolate` in
`bun run test` is load-bearing. `npm run lint:check` is green as of `b15fdf2` and must stay
green — `scripts/` is in the tsconfig project now.
