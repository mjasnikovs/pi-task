# Planning fixture suite

Eight scenario classes for A/B-validating /task-auto PLANNING mechanisms
(clarify → decompose → coverage → launch-contract → per-task refine) against the
live local model. Built for the run-11 planning improvements — see
`docs/run11-planning-improvements.md` for the findings-to-mechanism map.

Every mechanism is judged on a DUAL bar, per fixture: it must FIRE where the
fixture plants its defect, and stay SILENT (zero regressions) where it doesn't.
Both counts are reported per fixture, ≥5 runs/arm for model-dependent arms
(harness: `scripts/ab-planning.ts`). Deterministic scanners additionally get an
FP measurement on the real run-11 artifacts (`~/hub/mx5/.pi-tasks`).

| # | Fixture | Class | Should fire | Should stay silent |
|---|---|---|---|---|
| 1 | `mx5-project.md` | run-11 regression doc (verbatim copy of `~/hub/mx5/DESIGN/PROJECT.md`) | B: §12 milestones 2/4 end "+ tests" — titles must keep the suffix. A: §10 Testing (test-first cadence, Playwright CT, `test:ct`, `mx5_test` DB, `test/`) must map to tasks/directives/exclusions. launch: `test:ct` (backticked in §2, absent from §9's summary) must be captured. C: test-first cadence woven into route/page tasks. E: "follow §12" shape-lock must carry §10/§11. | D (no verify-vs-plan conflict is inherent to the doc) |
| 2 | `small-greenfield.md` | 3–5 requirements, no testing section | — | over-fire guard: plan stays small; NO hallucinated test tasks or invented requirements; no launch scripts (none declared); no attachments |
| 3 | `existing-codebase/` | extend-a-scaffold task (`spec.md` + working package.json/src/test) | A: constraint "every new subcommand/flag gets a `bun test` case" carried | preservation: no re-scaffold/re-plan of the existing repo (clarify-greenfield class); existing scripts not re-planned |
| 4 | `cross-cutting-wiki.md` | cross-cutting REQUIRED sections that are NOT testing (security: rate-limit + audit-log every mutating endpoint; a11y: every page) | A/E: security + a11y sections map to every applicable task, not zero tasks; C: `npm run a11y` methodology carried | B (feature lines carry no droppable suffix trap) |
| 5 | `cli-csv-tool.md` | non-web project (Go CLI, no server/browser) | C: verification = golden-file `go test` / `make check` — adapts kind | no server/screenshot/browser demands invented |
| 6 | `unstructured-prose.md` | requirements buried in flowing prose — no headings, no lists | A: extraction still yields grounded requirement units (auth-gate on every route incl. export; lossless import/export round-trip + its test; per-route HTTP tests) | B fragment scan (no list lines to anchor) must not misfire |
| 7 | `one-liner.txt` | bare prompt, no spec doc | — | extraction degrades gracefully (no doc ⇒ no registry, planning never blocks); no invented requirements/scripts |
| 8 | `contradiction-spec.md` | deliberate cross-section conflicts | D: Scope says "NO admin interface — do not create an admin page or any `/admin` route" while Components #5 pins an `/admin` page — a plan deriving a negative-existence verify assertion from Scope collides with the sibling deliverable; must surface as a CONFLICT at plan time (also: retention "never query raw `checks`" vs API reading raw `checks`; ISO-8601 storage vs epoch API — reconciliation material) | the conflict must not be silently "fixed" by dropping either section |

Fixture 3 is a directory: `spec.md` is the referenced doc; the rest is the
existing scaffold the planner must treat as authoritative disk state. The
`existing-codebase` code/test files are toolchain-excluded (tsconfig/eslint/
prettier/bun-test all skip `__fixtures__`) — they are planning INPUTS, not suite
code.

The mx5 copy is byte-identical to the run-11 doc on purpose: mechanisms are
validated against the exact text that produced the failures. Do not "improve" it.
