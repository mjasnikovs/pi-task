# Live docs run — 2026-09-05

The recorded output of three real `/task-auto` runs used to test the docs tool across
npm, cargo and hackage. Findings are in `DOC_REGRESSINONS.md` at the repo root; every
one of them is derived from the files here.

| file | what it is |
|---|---|
| `AUDIT.md` | the scored verdict, from `scripts/docs-live-audit.ts` |
| `<id>.jsonl` | every docs answer the run received — query verbatim, the child's prose, the excerpt check, and the entire tool return |
| `<id>.build.json` | the build/test verdict, recorded in the container where the toolchains live |

Kept so the findings can be **rescored without re-running a lookup**. The same question has
already returned different chunks on two machines; a rescore that re-retrieves is a second
measurement wearing the first one's name.

Reproduce with:

```
bun scripts/docs-live-seed.ts  <root>          # seed the three projects
bun scripts/docs-live-run.ts   <root>/ts <root>/ts/FEATURE.txt
bun scripts/docs-live-build.ts <root>          # in the container
bun scripts/docs-live-audit.ts <root> --build
```
