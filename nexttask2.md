# nexttask 2 — `dev` is not a launch command, and a served app with no listener must FAIL statically

**Priority P0.** Depends on nothing. Complements nexttask 1: that one makes a
skipped boot loud; this one removes the reason it skipped and adds a check that
works with no runtime at all.

---

## EVIDENCE (mx5 run 18, `~/hub/mx5`, READ-ONLY)

Two independent facts, both measured:

**(a) The boot command resolved to a docker-orchestration script.**
`discoverBootCommand` (`src/task/final-gate.ts:266-278`) tries `start`, then
`dev`. Run 18's `package.json` has no `start`. Its `dev` is:

    docker compose -f docker-compose.dev.yml up -d
      && until docker compose -f docker-compose.dev.yml exec -T postgres pg_isready …
      && concurrently "bun run dev:css" "bun run dev:js" "bun run --watch src/server/index.ts"

Docker is absent in the gate sandbox ⇒ env-gap ⇒ `skip`. A watcher-orchestrator
whose first act is `docker compose up` cannot distinguish "the app is broken"
from "this box has no docker". It is not a launch command.

**(b) There was never a listener to find.** Proven directly:

    $ DATABASE_URL=postgres://x:x@127.0.0.1:5432/x timeout 15 bun run src/server/index.ts
    EXIT=0

`src/server/index.ts` (28 lines, verbatim tail):

    const _routes = app.route('/api/admin', admin)…
    app.get('*', async c => { …Bun.file('dist/index.html')… })
    export {app}
    export type AppType = typeof _routes

No `Bun.serve`, no `export default app`, no `serve()`. Also no static-asset
route: `app.get('*')` returns `text/html` for `/main.js` and `/app.css`, so even
with a listener the page would be blank.

The design required both. `DESIGN/PROJECT.md:285`:
`**Server:** \`bun run --watch src/server/index.ts\` — serves \`/api\` + static \`dist/\`.`
That clause was extracted and owned (`.pi-tasks/requirements-owned.md:21`). See
nexttask 7 for why owning it was not enough.

**This is a repeat.** `scripts/live-owned-requirement-compose-ab.ts` header
documents the identical loss in mx5 run 16 ("the server never served the client
bundle and the app was permanently blank behind a green run"). Two runs, same
clause, same outcome. A dynamic-only gate has now failed to catch it twice.

## LEVER — two parts, land and measure them SEPARATELY

### 2A — reject non-launch scripts as the boot command

In `discoverBootCommand`, a `dev` script is only accepted when it plausibly
starts the app itself. Reject (fall through to `null`, i.e. "nothing to boot",
which nexttask 1 then reports as UNOBSERVED rather than silence) when the script
body opens with container/infra orchestration — `docker compose … up`,
`docker-compose … up`, `podman-compose … up` — or when its only long-running
member is a multiplexer (`concurrently`, `npm-run-all`, `turbo run dev`) whose
children are watchers.

Keep this **conservative and lexical**. Do not try to decide whether a watcher
serves; that is what part 2B is for.

### 2B — static serve-entry check (the real win: needs no runtime, no docker)

New deterministic checker `src/task/serve-entry.ts`, wired as a final-gate
static section:

> If the tree contains a module that constructs a server app **and** the project
> is expected to serve (an SPA-fallback route, a `Bun.file('dist/…')` read, a
> catch-all `app.get('*')`, or a design/contract clause naming a served path),
> then **some** module must actually bind: `Bun.serve(`, `export default app`
> / `export default {fetch`, `serve(` from `@hono/node-server`, `app.listen(`,
> `http.createServer(…).listen(`. If none exists anywhere in the tree → FAIL at
> rank 0 ("the project builds a server app but nothing starts it").

Ground truth is the file tree only. No model, no network, no docker, runs in
milliseconds, and it is exactly the shape run 18 shipped.

## STEP 0 — base rate, BEFORE any code change

`scripts/serve-entry-baserate.ts`. Over each corpus tree record:
`(builds-an-app? , has-a-bind? , boot command discovered, boot outcome)`.

Corpus, all local, all READ-ONLY:

    ~/hub/mx5 @ a9c6145      run 18 HEAD          expect builds-app=Y bind=N   ← the true positive
    ~/hub/mx5 @ 4880e79      run 18 pre-autofix   expect builds-app=Y bind=N
    aiz-server                                     expect builds-app=Y bind=Y  ← must NOT fire
    aiz-client                                     expect builds-app=N
    gofer                                          record
    pi-task (this repo)                            expect builds-app=N

Report the count of trees where `builds-an-app && !has-a-bind`. **If any tree
other than mx5 fires, the detector is too broad — fix the detector, do not
excuse the hit.** That is methodology, per `scripts/dangling-artifact-fp-suite.ts`.

## A/B — required. Two harnesses, because the two parts have different arms.

### `scripts/boot-command-resolution-ab.ts` (for 2A)

    baseline   discoverBootCommand as shipped
    treatment  discoverBootCommand with the non-launch rejection

Metric: for each tree, `(command chosen, boot outcome)`. Target shape: *a tree
where the chosen command is infra-orchestration and the outcome is `skip`*.

    PASS     baseline chose an orchestration script somewhere; treatment chose none,
             and no tree that previously BOOTED lost its command.       exit 0
    FAIL     treatment still chooses one, or a booting tree lost its command. exit 1
    ABSTAIN  no tree in the corpus has an orchestration-shaped dev script. exit 2

Invariant `inv-real-dev-kept`: a `dev` script that is a plain server watch
(e.g. `bun run --watch src/server/index.ts`, `next dev`, `vite`) must still be
accepted. Include at least two such fixtures.

### `scripts/serve-entry-fp-suite.ts` (for 2B)

Model on `scripts/dangling-artifact-fp-suite.ts` exactly:

    arm 1  pi-task + aiz-server + aiz-client + gofer  → expected ZERO findings
    arm 2  ~/hub/mx5 @ a9c6145 and @ 4880e79          → expected EXACTLY ONE finding,
                                                        naming src/server/index.ts

    PASS     arm 1 = 0 findings AND arm 2 = the expected finding on both revisions. exit 0
    FAIL     any arm-1 finding, or arm 2 misses it.                                 exit 1
    ABSTAIN  arm 2 trees unavailable — cannot run.                                  exit 2

`aiz-server` is the load-bearing negative: it is a real server that *does* bind.
If the checker cannot tell it apart from mx5, the checker is wrong.

## RELATION TO nexttask 1 — run them in this order

Land nexttask 1 first. With 2A alone, run 18's boot command becomes `null`, and
without nexttask 1 that is *still* silent ("nothing to boot" degrades to
nothing). 2B is what actually converts run 18 into a rank-0 FAIL. Sequence:
**1 → 2A → 2B**, each with its own green harness before the next starts.

## GRAY AREAS — closed here

- *"Just require a `start` script."* — **No.** That is a launch-contract
  assertion, and run 18 already failed one (`final-gate FAIL 2/4: the design
  declares script(s) the shipped package.json does not expose: migrate`). The
  autofix then added `migrate` and the contract went green while the app still
  could not start. Script presence is not evidence of a listener; 2B checks the
  code, which is the thing that was actually missing.
- *"Boot it by running the server entry directly instead."* — Attractive, and
  it would have caught this (`EXIT=0` in 15s). But it needs `DATABASE_URL` and a
  reachable Postgres, i.e. it re-introduces the env-gap skip that started this.
  Do 2B first; direct-entry boot may be proposed later as its own task with its
  own base rate.
- *"Does 2B need to detect the missing static route too?"* — Out of scope. That
  is nexttask 3 (the dangling-artifact extractor already owns runtime-reference
  closure and is the right home for `/main.js` and `/app.css`).

## ENVIRONMENT

Deterministic. No llama-server, no `PI_BIN`.

    bun run scripts/serve-entry-baserate.ts
    bun run scripts/boot-command-resolution-ab.ts
    bun run scripts/serve-entry-fp-suite.ts

`~/hub/mx5` is the evidence tree for runs 17 and 18 — open it READ-ONLY and
never let a harness write into it.
