Fix the six docs-tool defects found by the live run on branch `docs-live-test`.

Read `DOC_REGRESSINONS.md` first — it has the evidence for every claim below. The runs'
recorded answers are in `live-docs-run-2026-09-05/`; use them, do not re-run a lookup.

## Rule: regression test first, and it must fail

For each defect, write the test BEFORE the fix and prove it fails on the current tree.
Show me the failing output. A test that passes before the fix is testing nothing — three
of twelve mx5 tasks once scored PASS before the model wrote anything, and in this very
run `cabal test` was green while `cabal build all` failed with four errors.

Unit tests fake every spawn and registry, which is what makes them safe on Windows and
offline — and also what let all six of these ship. So each test must pin the SPECIFIC
observation from the report, not the general shape.

Work through them in this order. Stop after each and tell me the before/after.

## 1. Backticked filenames are installed from npm as packages

`src/task/enrichment.ts` — `ENRICH_PKG_RE` treats any backticked lowercase identifier as
a package name; `ENRICH_DENYLIST` holds only shell commands. Ten real installs happened:
`config.ts`, `app.ts`, `tsconfig.json`, `config.json`, `name`, `port`, `lib`, `fetch`.

Test: `extractEnrichTargets` over a spec of the shape these runs produce must return none
of those eight. Reproduce the exact string from the report.

Fix direction: enrich only names present in `declaredDeps(cwd)` (already on
`EcosystemProfile`). That is a behaviour change — a package legitimately named in prose
but not yet installed stops being enriched. Say so plainly and let me weigh it.

## 2. Answers about undeclared transitive dependencies

Caused the Rust HARD FAIL: the tool answered correctly about `tower::util::ServiceExt`,
the model imported it, and the crate does not compile because `tower` is in `Cargo.lock`
but not `[dependencies]`. Same hazard on npm — `resolvePackage` walks `node_modules`,
which is the full transitive closure. Measured: 23 declared deps, 106 answerable packages.

Test: both ecosystems. A package resolvable but not declared must be marked in the result.

Fix direction: not a refusal — the answer is often still useful. Carry the fact into the
version banner (`buildVersionBanner`, `src/workers/docs-core.ts`): present transitively,
not a declared dependency, add it before importing. Same `declaredDeps` source as #1.

## 3. Retrieval cannot follow a type alias

hono declares every HTTP verb as a property typed by an interface alias; the call
signatures live in `HandlerInterface`, in one chunk of 708, in a different file. Three of
six hono lookups abstained — correctly, given what they were handed.

Test: retrieve for a hono-shaped query and assert both the alias chunk and its definition
come back.

This is the hardest of the six and may not be worth its cost. Investigate first and tell
me what a fix would take before writing one — one alias hop on the top-ranked chunks, or a
wider budget, or neither.

## 4. Ranking misses content that is indexed

Seven scotty attempts never produced `json`'s signature while `ActionM` sat in 67 of 312
indexed chunks. Reproduced offline: `the handler monad` and `handler type for a route`
miss; longer queries hit.

Test: the short-query cases from the report must retrieve the declaration.

Related to #6 — fix that first and re-measure this before changing any ranking.

## 5. A dead major is indexed as current

414 of zod's 2565 chunks are `v3/`. An answer reproduced zod 3's
`email(message?): ZodString` under a `Per zod@4.5.4:` header, omitting the
`@deprecated Use z.email() instead` line directly above the real declaration.

Test: index a package with a back-compat major directory; assert no chunk comes from it.

## 6. Every `.d.cts` is a second copy of its `.d.ts`

zod: 2565 chunks, 1215 distinct bodies. `isDtsFile` accepts `.d.ts|.d.mts|.d.cts`. hono
ships no `.d.cts` and has 704/708 distinct, which is what makes the cause unambiguous.

Test: a fixture shipping both must index each declaration once.

Careful: a package that ships ONLY `.d.cts` must still work. Compare chunk BODIES, not
rows — the chunker prepends a path-comment line, so `select distinct content` reports zero
duplication.

## When the fixes are in

Re-run the live check end to end and compare against `live-docs-run-2026-09-05/AUDIT.md`:

```
bun scripts/docs-live-seed.ts  <root>
bun scripts/docs-live-run.ts   <root>/hs <root>/hs/FEATURE.txt   # in the container
bun scripts/docs-live-build.ts <root>
bun scripts/docs-live-audit.ts <root> --build
```

Haskell is the one that matters — it failed hardest and had no model knowledge to fall
back on. `bun run test` must stay green (4280 pass); `bun test` alone fails 345, the
`--isolate` in `bun run test` is load-bearing.

Harness facts you will need: `/task-auto` can only be driven by tmux `send-keys` — `pi -p`
dispatches no commands, and the remote bridge dies on `newSession` after planning. pi needs
about 25 seconds to boot before the prompt accepts a line.
