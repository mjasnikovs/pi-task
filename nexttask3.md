# nexttask 3 — the dangling-artifact extractor is blind to references inside generated HTML

**Priority P0.** The checker fired correctly, the autofix "fixed" it by creating
two *new* dangling references one indirection deeper, and the full gate re-run
did not see them.

---

## EVIDENCE (mx5 run 18, `~/hub/mx5`, READ-ONLY)

The first final gate produced (`.pi-tasks/TASK_AUTO_0001.md`):

    final-gate FAIL 1/4: dangling artifact: `src/server/index.ts` references
    `dist/index.html` (Bun.file) but nothing in the tree, build outputs, or scripts
    produces it — it sits in a build output directory whose parsed outputs do not
    include it

Correct, and exactly the run-13 shape the extractor was built for. The autofix
(`git show a9c6145 -- build.ts`) satisfied it by appending to `build.ts`:

    const html = `<!doctype html>
    …
        <link rel="stylesheet" href="/app.css" />
    …
        <script type="module" src="/main.js"></script>
    …`
    Bun.write('dist/index.html', html)

Now measure what that HTML points at:

    $ ls ~/hub/mx5/dist
    index.html  main.css  main.js

- `/app.css` **is never produced by `bun run build`.** The only producer is
  `dev:css` (`bunx @tailwindcss/cli -i src/client/index.css -o dist/app.css --watch`),
  a watch-mode dev script. `bun run build` runs `build.ts`, whose `Bun.build`
  emits `main.css`. Production ships a page with zero CSS.
- `/main.js` exists on disk but is **unreachable**: `src/server/index.ts` has a
  single catch-all `app.get('*')` returning `dist/index.html` as `text/html`,
  and no static-asset route. Both URLs resolve to the HTML document.

TASK_0019's verify had already stated the first half in plain text
(`.pi-tasks/TASK_0019.md` gates): *"the VERIFY block fails because `bun run build`
does not produce `dist/app.css` (pre-existing build pipeline gap)"*. It was
auto-ACCEPTED under YOLO and never routed anywhere.

The gate **did** re-run in full after the autofix
(`src/task/final-gate-fix.ts:15` — "the gate itself is re-run as the only
arbiter") and reported converged. So this is not a missing re-run. It is a
missing pattern.

## SEAM

`src/task/artifact-closure.ts` (the dangling runtime-reference extractor;
see `memory/artifact-production-closure.md`). It scans **source** for runtime
file references — `Bun.file(…)`, `readFileSync(…)`, `sendFile(…)` and friends —
and closes them against parsed build outputs and scripts. It does not scan
**HTML that the source generates**, so `href="/app.css"` inside a template
literal in `build.ts` is invisible.

## LEVER

Extend the extractor's reference set with HTML asset attributes found in string
and template literals:

    <link … href="X">        <script … src="X">      <img … src="X">
    <source … src="X">       <video/audio … src="X">

Resolution rules, deterministic:

- A root-relative URL (`/app.css`) resolves against the **output directory of the
  emitting write** — here `Bun.write('dist/index.html', …)` ⇒ `dist/`. Where the
  output dir cannot be determined, resolve against every parsed build outdir; a
  reference that matches none is dangling.
- Ignore absolute URLs with a scheme (`http:`, `https:`, `data:`) and anchors.
- A reference produced only by a **watch/dev** script must count as dangling for
  a production build. `dev:css` writing `dist/app.css` does **not** close
  `/app.css`, because `bun run build` never invokes it. This is the load-bearing
  rule — without it, run 18 still passes.

## STEP 0 — base rate, BEFORE the change

`scripts/html-asset-closure-baserate.ts`. Over the corpus, count HTML asset
references found in source string literals, and how many resolve to a real
build output vs a dev-only producer vs nothing:

    ~/hub/mx5 @ a9c6145    expect 2 refs: /main.js (unreachable but produced),
                                          /app.css (dev-only producer)  ← 1 dangling
    ~/hub/mx5 @ 407e542    'base' commit, before any build.ts            expect 0
    aiz-client                                                          record
    aiz-server, gofer, pi-task                                          expect 0

Report the raw counts per tree. **If the pattern fires on aiz-client or any tree
with a legitimate hand-written `index.html`, the resolution rule is wrong — fix
it, do not allowlist.**

## A/B — required, deterministic

`scripts/html-asset-closure-ab.ts`, both arms in one process over one corpus:

    baseline   findDanglingArtifacts as shipped today
    treatment  + HTML asset-attribute references

Pre-registered metric: the **set of dangling findings per tree**, compared as
sets (not counts), so a lost true positive is visible.

    PASS     baseline misses the /app.css finding on mx5@a9c6145;
             treatment reports it; AND every invariant below holds.  exit 0
    FAIL     treatment misses it, or any invariant breaks.           exit 1
    ABSTAIN  the mx5 evidence tree is unavailable.                   exit 2

**Invariants:**

- `inv-no-new-fp` — every non-mx5 tree keeps **exactly** its baseline finding
  set. Zero new findings anywhere.
- `inv-run13-kept` — the original run-13 true positive
  (`src/server/index.ts → dist/index.html`) is still reported on
  `~/hub/mx5 @ 4880e79`. Run `scripts/dangling-artifact-fp-suite.ts` unchanged
  and green before and after; that suite is the regression net for this file.
- `inv-scheme-urls-ignored` — a fixture containing
  `<script src="https://cdn.example/x.js">` produces no finding.
- `inv-non-build-html-ignored` — HTML in a string literal that is **not written
  to a build output** must not be scanned. Real fixture, verified present:
  `~/hub/aiz-server/src/connections/mailTemplate.ts:1` is
  `export default \`<!doctype html>…\`` — an *email* body. It currently contains
  0 asset attributes (`grep -rhoE '<(img|link|script|source)[^>]*(src|href)="[^"]*"'
  --include=*.ts src` → 0 across the whole repo), so it is a clean negative
  today, but the shape is exactly the false positive this rule invites. Gate the
  scan on "this literal reaches a write into a parsed build outdir", and add a
  synthetic email-template fixture WITH an `<img src="cid:logo">` that must not
  fire.
- `inv-dev-only-is-dangling` — a fixture where the only producer of `X` is a
  script whose name matches `dev*`/`watch*` or whose body carries `--watch`
  yields a finding. This is the rule that decides the whole task; it needs its
  own unit test in `src/task/artifact-closure.test.ts`.

## SECOND, SEPARATE FINDING — do not fold it into this task

`/main.js` is *produced* but *unreachable* because there is no static route.
That is a routing defect, not an artifact-closure defect, and closure cannot
see it. It belongs with nexttask 2's serve-entry checker (2B), extended to
assert that a tree with an SPA catch-all also mounts a static handler. Record it
there; do not stretch the closure extractor to reason about route tables.

## WIRE ONLY ON PASS

On PASS: land, extend `src/task/artifact-closure.test.ts` with the four
invariants as unit fixtures, and re-run `scripts/dangling-artifact-fp-suite.ts`
green. On FAIL/ABSTAIN: record in `VALIDATION-DEBT.md` under OPEN with counts.

## GRAY AREAS — closed here

- *"Should the autofix have been allowed to author HTML at all?"* — Different
  question, not this task. The autofix's edit was reasonable; the checker's blind
  spot is the defect.
- *"Is `/app.css` maybe fine because `dev` produces it?"* — **No**, and this is
  the whole point. The gate's own commands are `bun run build`, `bun run test`,
  `bun run lint` — none run `dev:css`. A production artifact closed only by a
  watch script is dangling by construction. Encode that, do not debate it
  per-tree.
- *"Count references in `dist/index.html` on disk instead of in source."* —
  Rejected: `dist/` is gitignored in run 18 (`.gitignore` line `dist/`), so a
  fresh clone has no such file and the check would silently do nothing. Scan the
  **source that generates** it.

## ENVIRONMENT

Deterministic. No llama-server, no `PI_BIN`.

    bun run scripts/html-asset-closure-baserate.ts
    bun run scripts/html-asset-closure-ab.ts
    bun run scripts/dangling-artifact-fp-suite.ts     # must stay green
