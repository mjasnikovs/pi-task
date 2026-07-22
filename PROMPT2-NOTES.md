# PROMPT 2 — wiring notes (DETERMINISTIC core shipped; wiring mapped, NOT implemented)

Author: the DO-item-1 detector worker. This file maps where the reviewer wires DO items
1–4. It implements ONLY the pure detector (`src/task/type-only-answer.ts` +
`type-only-answer.test.ts`). Nothing below is wired yet — line numbers are current as of
this working tree (post PROMPT 1 edits to `phases.ts`/`prompts.ts` by the other worker).

Do not run any live model work to validate this — that is the reviewer's live A/B
(`scripts/live-typeonly-escalation-ab.ts`), STEP 0 item 2 / PROMPT 2 A/B.

---

## The single seam that assembles a docs answer

`src/workers/pi-worker-docs.ts` → `registerPiWorkerDocs` → the `run`/`execute` body, npm-
package branch (`kind === 'ok'`):

- **pi-worker-docs.ts:320–331** is where the child's answer becomes the tool result:
  ```
  320  const parsed = parseChildOutput(child.stdout)          // {answer, excerpt}
  321  const verified = parsed.excerpt ? isExcerptInContent(parsed.excerpt, concatenated) : undefined
  323  const text = versionBanner + npmHeader + formatResultText(pkg, parsed, verified)
  324  return { text, details: { ...baseDetails, childExitCode: 0, excerptVerified: verified } }
  ```
  `parsed.answer` is the exact string `isTypeOnlyAnswer` expects; `params.query` is the
  question. `concatenated` (pi-worker-docs.ts:303) is the retrieved `.d.ts`/README text and
  is where the `@see {@link …}` pointer lives.
- The project-source (`module === '.'`) branch is a SEPARATE assembly earlier in the same
  function (around pi-worker-docs.ts:160–211). DO item 1 need only touch the npm-package
  branch — `.` lookups are project source, not the F-2 shape, and are already uncached
  (cacheKey returns null, pi-worker-docs.ts:349–352).
- `DocsDetails` (the details type) is declared at **pi-worker-docs.ts:42–59**. Add a
  `typeOnly?: boolean` field here so DO item 4 can gate caching on it.

---

## DO item 1 — TYPE-ONLY DETECTION → mark UNANSWERED  [detector DONE, wiring here]

Detector: `isTypeOnlyAnswer(answer, question): {typeOnly, reason}` in
`src/task/type-only-answer.ts` (pure, unit-tested; flags exactly the 1 recorded `hc` case
out of the 149 valid run-15 docs answers).

Wire at **pi-worker-docs.ts:320–331**, immediately after `parseChildOutput`:

1. `const typeOnly = isTypeOnlyAnswer(parsed.answer, params.query)` (import from
   `../task/type-only-answer.js`).
2. If `typeOnly.typeOnly`, treat the answer as UNANSWERED. Two options for the reviewer —
   recommend (b):
   - (a) rewrite `text` so the answer reads as a non-answer the model will escalate on
     (mirror the existing "unclear from this package" contract the worker:apis model
     already escalates on — see F-2's TASK_0024 evidence), OR
   - (b) keep the signature in `text` but PREPEND an explicit UNANSWERED banner naming the
     gap (e.g. "TYPE-ONLY: this is the declaration, not the usage semantics — escalate")
     plus any `@see` URL extracted from `concatenated` (see DO item 2). (b) preserves the
     retrieved type for the model while still driving escalation.
3. Set `details.typeOnly = true` so DO item 4 can exclude it from the cache.

Note the `question` gate: `isTypeOnlyAnswer` clears any query that asks only for a
"type"/"signature"/"definition"/"fields" (a signature answer is responsive to those), and
only fires on usage/semantic queries. This is the precision guard — do not strip it.

---

## DO item 2 — FOLLOW THE `@see {@link …}` POINTER  [map only]

When a docs answer is UNANSWERED (type-only from DO item 1, OR the explicit "unclear from
this package"), extract the `@see` URL and hand it to pi-worker-fetch with the SAME question.

- **Source of the pointer**: `concatenated` at **pi-worker-docs.ts:303** (the retrieved
  chunk text) — F-2(d): `hono.dev` appears in cache values ONLY inside these `.d.ts`
  excerpts, never as a fetch. Extract with e.g.
  `/@see\s*\{@link\s+(https?:\/\/[^}\s]+)\s*\}/gi`. `parsed.excerpt` is a narrower
  fallback source.
- **Two places this can live**:
  - Tool-internal (simplest, deterministic): in the same `execute` body, on UNANSWERED,
    surface the extracted URL in `text` so the worker:apis model calls pi-worker-fetch on
    it. The tool cannot itself spawn fetch cleanly (parallel-mode execute), so it PROMPTS
    the escalation rather than performing it.
  - Orchestrated (does the fetch itself): `phaseResearch` / the worker:apis loop. The
    worker:apis tool set already includes `pi-worker-fetch` when search is configured —
    **phases.ts:635–637**. A deterministic post-step could detect an UNANSWERED docs result
    and issue the fetch directly. Heavier; the tool-internal prompt is enough for the A/B.
- **fetch entrypoint** the reviewer re-asks against: `fetchFocused` (used in phaseAutoAnswer
  at phases.ts:816) / the `pi-worker-fetch` tool (`src/workers/pi-worker-fetch.ts:49`).

---

## DO item 3 — SPEC-CITED URLS AS FETCH TARGETS  [map only]

Goal: extract http(s) URLs from the design/spec text (DESIGN/PROJECT.md §13 is a literal
reference list) and rank them above model-chosen URLs for worker:apis when the question
names the same package. Validate: `hono.dev/docs/guides/rpc` and `bun.com/docs/runtime/sql`
must both get fetched.

- **The extractor already exists**: `extractEnrichTargets(text)` at
  **src/task/enrichment.ts:66–94** already pulls http(s) URLs via `ENRICH_URL_RE`
  (enrichment.ts:7) — see its use in phaseAutoAnswer at **phases.ts:818–825**. It is NOT
  currently applied to the worker:apis research prompt.
- **Where to inject**: the worker:apis spec at **phases.ts:616–642**, specifically the
  `prompt: prior => appendNoThink(… RESEARCH_APIS_PROMPT(refined, …) …)` at
  **phases.ts:625–634**. Pass `extractEnrichTargets(refined).urls` into
  `RESEARCH_APIS_PROMPT` (prompt lives in `src/task/prompts.ts` — the OTHER worker's file;
  coordinate) as a ranked "prefer these spec-cited URLs" list, above model-chosen URLs when
  the query names the same package/host.
- **Ranking against the question's package**: match a spec URL's host/path against the
  package base name (`packageRootOf`, pi-worker-docs.ts:67) — the same host↔package match
  `context-attribution.ts:hasSourceCapableBlock` already uses (hono.dev ↔ hono).

---

## DO item 4 — DO NOT CACHE NON-ANSWERS AS HITS  [map only]

Today "unclear", type-only, and `excerptVerified === false` results are stored and re-served
as cache hits (F-2e: `details.hitCache === true` on unclear entries).

- **Root cause**: **pi-worker-docs.ts:362** — `cacheable: d => d.childExitCode === 0`.
  Cacheability is keyed on PROCESS HEALTH, not answer content. An "unclear"/type-only child
  exits 0, so the non-answer is cached.
- **The cache gate that consults it**: `makeWorkerTool` in **src/workers/shared.ts:109–122**
  (`spec.cacheable(details, text)` at shared.ts:112 gates `storeResearch`). `cacheable`
  also receives `text`, so a content check is available without new plumbing.
- **Fix (reviewer)**: tighten the predicate to exclude non-answers, e.g.
  ```
  cacheable: (d, text) =>
      d.childExitCode === 0
      && d.typeOnly !== true                 // DO item 1 sets this
      && d.excerptVerified !== false          // fabricated excerpt
      && !/unclear from this package/i.test(text)
  ```
  `details.typeOnly` requires the DO-item-1 field added to `DocsDetails`
  (pi-worker-docs.ts:42–59). This makes a dead end paid for once, not many times, and is
  what lets escalation re-fire on a later sibling task instead of re-serving the type.

---

## Invariants the reviewer's live A/B must hold (from nexxtasks.txt PROMPT 2)

- **Invariant 1**: total child spawns per task must not blow up — the precision-first
  detector (1/149 flag rate on the real corpus) is what keeps escalation from firing on
  every answer. Record added wall-clock (research is already 63.7% of spec-phase time).
- **Invariant 2**: `excerptVerified === false` must NOT rise — turning silence into
  confident wrong answers is the failure this whole file is about.
- ABSTAIN if the baseline already escalates on the type-only answer — then F-2's mechanism
  is disproved. (STEP 0 item 2 measured baseline 0/8 escalation, so this is not expected.)
