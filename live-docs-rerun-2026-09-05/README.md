# Live docs re-run — 2026-09-05, on the fixed build

The same loop as `live-docs-run-2026-09-05/`, re-run against
`@mjasnikovs/pi-task@0.40.2` after all six defects were fixed. The pre-fix run in
that sibling directory is what these numbers diff against.

Cold start: the container's `~/.cache/pi-worker/docs.sqlite` AND its
`docs-modules/` scratch install were both moved aside first, so nothing here was
served from a cache the defects built.

| | ts (npm) | rs (cargo) | hs (hackage) |
|---|---|---|---|
| verdict | PASS | PASS | PASS |
| was | PASS | HARD FAIL | HARD FAIL |
| abstained | 1/14 (7%) | 1/5 (20%) | 8/10 (80%) |
| was | 4/17 (24%) | 5/17 (29%) | 12/22 (55%) |
| build/test | green | green | green |
| was | green | RED | RED |

`prefix-enrich-manifest.json` is the pre-fix run's enrichment scratch manifest,
recovered from the container before it was archived: 45 npm dependencies, of which
`config.ts`, `app.ts`, `tsconfig.json`, `config.json`, `package.json`, `name`,
`port`, `lib`, `fetch`, `sql`, `photo`, `phone` and two dozen more are backticked
filenames and prose words, not packages. The report had recorded ten. It was 45.
`rerun-enrich-manifest.json` is the same file after the run: five entries, all real.

The `answers with 0 invented symbols` row reads "not scoreable" here on purpose.
It was scored against `toolText`, which embeds the answer prose, so it asked
whether each answer contained itself — 13/13, 12/12, 10/10 pre-fix and 13/13, 4/4,
2/2 here, 54 answers and not one miss. The corpus it needs is the retrieved
chunks, which no log written before this session recorded. See DOC_REGRESSINONS.md
defect 9.
