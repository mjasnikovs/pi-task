Re-run the live docs test across TypeScript, Rust and Haskell, score it, then keep
improving until the time is gone. Budget is long — about 12 hours — so a run is the
start of the session, not the whole of it.

Run it end to end without stopping to ask. Ask only if a preflight check fails or
something is genuinely ambiguous.

Read `DOC_REGRESSINONS.md` first. Sections 0-4 are the loop. The last two sections are
the two 2026-09 re-runs and the thirteen defects. Do not re-derive any of it.

## What changed since the last run

Published as `@mjasnikovs/pi-task@0.40.5` (branch `docs-live-test`, tag `v0.40.5`),
`bun run test` green at 4312, `npm run lint:check` green.

- **Defect 11 — the definition hop could not reach a function.** `hopNames` accepted
  only `/^[A-Z]/` names and `definitionChunk` found only TYPE declarations, so
  `from_str`, `safeParse`, `into_make_service` and `parseJSON` were never candidates.
  Widened, plus a whole-word value fallback, and the alias cap no longer binds
  query-named hops. **48.6% → 22.9%** of named declarations missed, +0.7% bytes.
- **Defect 10 — the fidelity scorer failed the correct answer.** A symbol named in
  order to DENY it scored as a fabrication. Fixed in `scripts/docs-live-audit.ts`.
- **Defect 13 — the seed now writes a `.gitignore`**, so autoCommit stops committing
  `node_modules/`, `target/` and `dist-newstyle/`.

**Defect 11 is index-side only.** It proves the declaration now reaches the extraction
child. It does NOT prove an answer got better, and that distinction is the whole point
of this run — last time serde_json lost 51 duplicate chunks and its `from_str` answer
did not move at all.

## Rule: the container must run the published build

```bash
docker start mx5-n
docker exec mx5-n bash -lc 'cd ~/.pi/agent/npm && npm i @mjasnikovs/pi-task@0.40.5 --no-audit --no-fund --loglevel=error
  node -p "require(process.env.HOME+\"/.pi/agent/npm/node_modules/@mjasnikovs/pi-task/package.json\").version"'
```

The install is not optional even if the version already reads `0.40.5`: an earlier
session hand-copied `dist/`, and the session before this one copied a single file into
the container to measure with. The tree on disk may be a build nobody can name.

Confirm the fixes are in what npm just put there:

```bash
docker exec mx5-n bash -lc 'D=$HOME/.pi/agent/npm/node_modules/@mjasnikovs/pi-task/dist/workers
  for m in acceptedEnd chunkerFingerprint retrievedText IDENTIFIER_SHAPED valueChunk; do
    printf "%-20s %s\n" $m "$(grep -rl $m $D/ | head -1 || echo MISSING)"; done'
```

Five hits, or stop.

## Do NOT move the cache aside

The freshness hash covers the chunker now, so leaving the cache in place is itself a
check. Read the counts before and after; nothing should re-index this time, because
the chunker did not change:

```bash
docker exec mx5-n bash -lc 'node -e "
import(\"node:sqlite\").then(({DatabaseSync})=>{
const db=new DatabaseSync(process.env.HOME+\"/.cache/pi-worker/docs.sqlite\")
for(const r of db.prepare(\"select ecosystem,name,count(*) c,count(distinct content) d from chunks group by 1,2\").all())
  console.log(r.ecosystem,r.name,\"chunks=\"+r.c,\"dupes=\"+(r.c-r.d))})"'
```

Expect serde 297/0, axum 381/0, serde_json 288/0, zod 1078/0, aeson 1326/55.

## Check the hop FIRES, after three answers, not at the audit

This is the equivalent of last session's `retrievedText` check. If the hop is not
firing, the run measures the old build and you find out four hours late.

```bash
docker exec mx5-n bash -lc 'node -e "
const fs=require(\"fs\")
for (const l of fs.readFileSync(\"/home/agent/docs-live/ts.jsonl\",\"utf8\").trim().split(\"\n\")) {
  const r=JSON.parse(l)
  const syms=[...new Set(r.query.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g)||[])].filter(t=>/_/.test(t)||/[a-z][A-Z]/.test(t))
  const got=syms.filter(s=>new RegExp(\"(?<![A-Za-z0-9_])\"+s+\"(?![A-Za-z0-9_])\").test(r.retrievedText||\"\"))
  console.log(r.module, \"named\", syms.length, \"symbols, retrieved text carries\", got.length)
}"'
```

`retrievedText` of 0 length means the run is worthless — kill it and find out why.
Symbols named but never carried means the hop is not reaching them; say which.

## Run it

`DOC_REGRESSINONS.md` sections 1 through 4, exactly. One at a time — a single local
model serves every child. Haskell is still the run that matters.

## What to check when it is done

Against `live-docs-rerun2-2026-09-06/`:

| | ts | rs | hs |
|---|---|---|---|
| verdict | PASS | PASS | PASS |
| abstained | 4/17 (24%) | 4/10 (40%) | 5/6 (83%) |
| 0 invented symbols | 10/13 | 5/6 | 1/1 |
| build/test | green | green | green |

1. **Did defect 11 reach the ANSWERS?** The only question this run exists for. Re-run
   the base-rate measurement on the new log — declarations named and not retrieved was
   17/35 before the fix, 8/35 after, both measured on the OLD run's queries. Then read
   the `from_str`, `safeParse` and `IntoResponse` answers themselves and say whether
   they changed. A better index with the same answers is a negative result, and it is
   the result this loop has produced twice.
2. **The fidelity row.** 16/20 clean last time with four known-benign flags: `false`
   from `{ success: false, error }`, `fields`/`are` and `assert` from prose inside a
   code span, and `adminEmail`, correctly derived from `rename_all = "camelCase"`.
   Anything else is new — read it before believing it.
3. **`.gitignore`.** No project should track a build directory. Last run ts tracked
   1397 files under `node_modules/`.
4. **hackage.** 3 of 6 hs lookups were `hspec` (defect 12) and 2 of the rest asked for
   symbols aeson does not have. Read the queries before you read the rate.

## Read the answers, not the table

Every finding in this document came from reading `toolText` and `retrievedText` on
individual records. A green run does not mean the docs tool worked — it means its
failures were survivable that time.

## After the run — the open work, in order

You have hours left. Spend them on these, not on a second identical run.

1. **Defect 12, a facade package indexes to nothing.** `hspec` is 14 chunks of export
   lists; every signature is in `hspec-core`, a transitive dep the indexer never opens.
   No clear path was found: following a re-export means deciding how far to index into
   transitive deps and there is no principled stopping rule. **Find the stopping rule
   first, and write it down, before writing any code.** One candidate worth measuring:
   follow a re-export only when the importing module declares no signatures of its own.
2. **aeson's 55 duplicate bodies.** The hackage surface extractor truncates a
   multi-line instance head, so `instance {-# OVERLAPPING #-}` becomes a content-free
   chunk. 4% of the package, internal generic machinery. Small and self-contained.
3. **The remaining 8 of 35 missed declarations.** Defect 11 got 17 down to 8. Read
   which ones are left and whether they share a shape.

## Known open — do not report as new

- A query whose key symbol is absent from the corpus cannot be answered. Stripping
  English stopwords was tested and REFUTED — it moves the failure elsewhere.
- The 8-minute settle rule can cut the final gate. Tasks and tree are still scoreable.
- `scotty` has been indexed and never asked about for two runs running.

## If you find something

Regression test first, and prove it fails on the current tree before writing the fix.
Show the failing output. If a test cannot fail before the fix — because the fix adds
the seam it tests — say so and prove the defect on the recorded data instead.

Never guess a constant. Defect 11's hop cap was swept (3, 5, 8, uncapped) and the
measurement chose it. A number you picked because it sounded right is a defect waiting.

`bun run test` must stay green at 4312. `bun test` alone fails; the `--isolate` in
`bun run test` is load-bearing. `npm run lint:check` must stay green.

Publish a patch version when you ship a fix, and say plainly whether `dist` actually
changed — a `scripts/`-only change ships a byte-identical build.
