# RUN 21 RESULTS — mx5 reference build

Run 21: 2026-08-13 09:19:43Z → 19:01:57Z. 30 tasks, all `[x]`. Final gate
"converged". `TASK_AUTO_0001` state `completed`.

**The shipped app is dead.** White page, `Uncaught ReferenceError: process is
not defined` at `main.js:322`. The gate detected this exact failure, twice,
then released it as UNOBSERVED debt.

Every claim below is reproduced against the shipped tree. Where a claim did not
reproduce, that is stated.

---

## 1. What shipped

Three independent client-fatal defects. Any one of them alone kills the page.

### D1 — `process` is not defined in the browser

`src/client/api.ts:4`

```ts
const baseUrl = process.env.APP_URL ?? '/api'
```

`Bun.build` (`build.ts`) targets the browser and declares no `define`. The
identifier survives into the bundle verbatim:

```
$ awk 'NR==322' dist/main.js | cut -c4850-4990
...var XP=process.env.APP_URL??"/api",uv=wz(XP,{init:{credentials:"include"}});
```

`dist/main.js` line 322, column ~4900 — byte-matches the reported error
location. The module is evaluated at import time, so React never mounts.

### D2 — every API call is double-prefixed and 404s

The server mounts all route groups at `/api` (`src/server/index.ts:16-20`).
`hc<AppType>` paths therefore already begin with `.api`. Passing `/api` as the
base URL prefixes it a second time. Proven against the repo's own `hono`:

```
$ node hc-probe.mjs
CLIENT REQUESTS: /api/api/auth/login
CLIENT REQUESTS: /api/api/listings?
```

Server serves `/api/auth/login`. `/api/api/...` starts with `/api`, so the SPA
fallback returns `c.notFound()`. Every call 404s.

### D3 — both were written into the spec, and the tests were built to match

`TASK_0017.md`, ACCEPTANCE:

> The base URL is derived from `process.env.APP_URL`; when `APP_URL` is unset or
> empty, the client falls back to `/api` as its base path

The implementer complied exactly. The spec was wrong. Then four `.story.tsx`
files polyfilled the missing global rather than fixing the source —
`src/client/pages/Join.story.tsx:7` still carries the comment:

```
// Polyfill process.env for api.ts at module load time
```

95 component tests pass against `page.route('/api/api/...')` mocks. The suite
validates the bug. Same class as run 17 (login DEAD behind hand-written casts).

---

## 2. Gate regressions

### G1 — the demote rule fired on a true positive **(most severe)**

The gate found it. `accept-debt.md` and the `TASK_AUTO_0001` gate trail:

> final-gate FAIL 1/3: boot check: `bun run dev` listens on :3000 but the
> rendered body is EMPTY after client JS executed — no visible text, no visual
> or interactive elements (the blank-page class: HTTP serves, nothing mounts)

Twice — attempt 1 (18:55:50Z) and attempt 2 (19:03:35Z). Then:

> final-gate: check DEMOTED to UNOBSERVED after 2 tree-changing attempts
> returned an identical failure … carried as debt
> final-gate: converged on all remaining checks

`isNonProgress` (`src/task/final-gate-progress.ts:118`) is a bare equality test:

```ts
if (!input.edited) return false
if (input.previousSignature === null || input.currentDetail === null) return false
return normalizeFailureDetail(input.currentDetail) === input.previousSignature
```

The rule was built for mx5 run 14, where a boot probe could not observe a
listener in that sandbox. It cannot tell "the probe cannot see" from "the bug is
still there". A deterministic un-fixed bug produces an identical failure by
definition, so **reproducibility is read as instrument error.**

The verdict was a true positive and is still reproducible today. The gate's own
judge, run against the DOM the shipped bundle renders right now:

```
$ bun run judge.ts dom.txt
{ "ok": false,
  "detail": "the rendered body is EMPTY after client JS executed — …" }
```

Nothing about this environment was unfalsifiable. The app was broken.

### G2 — the render probe cannot say *why*

`runRenderCheck` (`src/task/render-check.ts:170`) spawns Chrome with
`--dump-dom` and judges stdout as text. `stderr` is read only on the
crash/empty-DOM path. On the blank-page path it is discarded.

The fix child was told "the body is EMPTY" and nothing else. It spent 45 minutes
on tests, bundler config and static serving. It read
`const baseUrl = process.env.APP_URL ?? '/api'` twice (18:26:46Z, 18:26:47Z) and
moved on.

I first assumed the console error was already in the discarded `stderr`. **That
was wrong** — `--dump-dom` alone emits nothing. Adding two flags to the same
invocation surfaces it:

```
$ chrome --headless … --enable-logging=stderr --v=0 --dump-dom http://localhost:8791/
[INFO:CONSOLE:322] "Uncaught ReferenceError: process is not defined",
    source: http://localhost:8791/main.js (322)
```

DOM output is byte-identical at 318 bytes, so the existing judgment is
unaffected. Two flags turn an unactionable verdict into a one-line fix.

### G3 — 29.9 minutes of gate context discarded by the command watchdog

```
=== final-fix RESTART (attempt 1 discarded) reason=command-timeout
    wall=1795089ms — bash > 300000ms:
    cd /workspace && for i in $(seq 1 5); do … bun run test … done
```

The child ran the full suite 5× to chase a flake. One `bun run test` is ~75s, so
the loop was always going to exceed the 300s bash cap. `gate-child.ts:186`
discards the conversation; the tree edits survive. It lost 30 minutes of
reasoning, not work.

### G4 — attempt 2 ended `ok` carrying a hallucinated API

The fix child wrote `Bun.file(watchDir).links()` and `Bun.stat(entry.path)` into
`build.ts`. Neither exists. Both sit inside `catch { /* ignore errors during
watch polling */ }`, so the runtime probe could never see them. Attempt 2 closed
`=== final-fix end: ok ===` at 18:54:10Z with that code committed.

Only a third pass caught it — via an eslint *warning*
(`no-unsafe-member-access`), after ~2 minutes of grepping `bun-types` to confirm
the methods were invented.

### G5 — the gate found and fixed a real serving bug (credit)

At 19:00:43Z it curled `/main.js`, got HTML back, and correctly diagnosed the
SPA fallback swallowing static assets. It patched `src/server/index.ts` and
re-verified. That is a genuine catch that no test covered.

### G6 — the gate predicted G5 at the top of the run and nobody acted

```
owned requirement UNCLAIMED — "**Server:** `bun run --watch src/server/index.ts`
— serves `/api` + static `dist/`." [frozen in "Client build pipeline…";
no task claimed src/server/index.ts]
```

The freeze/claim conflict named the exact file and the exact missing behaviour
before the gate started. It was logged and dropped. Same shape as nexttask 16C.

---

## 3. Worker regressions

### W1 — `worker:apis` prescribed a Node-only global for browser code

`TASK_0017.md`, APIS section:

> `process.env`  Node.js/Bun environment variable access — used to read
> `APP_URL` for client base URL configuration

It labels the global "Node.js/Bun" and prescribes it for a browser file in the
same sentence. That entry is the origin of D1.

### W2 — `worker:context` contradicted itself inside one section

Two bullets, same CONTEXT block, `TASK_0017.md`:

> The server mounts all route groups under `/api` prefix … so RPC client paths
> are relative to that mount — e.g. `client.api.auth.login.$post(...)`

> The client should read the same env var for its base URL, falling back to
> empty string (same-origin) or `/api`.

The first is correct and rules out the second. Compose took the wrong branch and
promoted it to ACCEPTANCE. Nothing downstream reconciled them.

### W3 — the bug was diagnosed, then propagated as ground truth

`TASK_0022.md:96` states it outright:

> The typed hc client with base URL `/api` produces double-prefixed paths:
> `api.api.invites.$get({param: {token}})` hits `/api/api/invites/:token`

Research has no channel for "what I observed is wrong". So it became a contract.
Five later tasks — 0024, 0025, 0026, 0027, 0029 — recorded the double prefix as
established fact and wrote their route mocks to match.

`TASK_0024.md:123` also invented a false cause:

> (double `/api` because Vite dev server + base URL)

Vite has nothing to do with it. A fabricated benign explanation is what stops a
defect from reading as a defect.

### W4 — no execution regression

57/57 worker runs exited 0 across both runs. Two `worker:context` loop restarts
in run 21 (`TASK_0002`, `TASK_0024`), both recovered on attempt 2. `TASK_0024`
cost 373s total for 82s of work.

### W5 — nexttask-17 version banner HELD, no regression

20 `"X" is not declared in this project's package.json` banners were emitted.
Each was graded against `package.json` at its own timestamp, via the last mx5
commit at or before that moment (per `ab-baseline-ref-must-not-move`):

```
total banners: 20
Counter({'TRUE': 20})
```

**0 false banners.** Run 20 emitted 35 false ones. The `@types/bun` chain-aware
fix is working — the cache also shows the corrected wording live:

> [VERSION] "bun" is declared in this project's package.json only through
> @types/bun, as `latest` — a moving tag, not a pinned range

194 cached research entries, 40 carrying a version banner, 0 abstentions.

---

## 4. Verify

### V1 — verify is working

9 real FAILs in run 21: 5 repo-health lint, 4 substantive. One example:

> verify: FAIL — work did not verify: createSession throws at runtime because
> maxAge is passed as milliseconds…

That is a genuine runtime defect caught before commit. 29 PASS, 9 enforce fix
rounds committed and re-verified.

### V2 — TASK_0017's VERIFY was a false instrument by construction

```sh
tsc --noEmit
eslint src/client/api.ts
bun -e "import api from './src/client/api.ts'; console.assert(typeof api === 'object', …)"
```

The deliverable is browser code. The check executes it under **Bun**, where
`process` exists — so D1 is unobservable by design. And it asserts only
`typeof api === 'object'`; it never asserts the URL the client produces, so D2
is unobservable too. Both defects sailed through on one PASS with no re-verify.

### V3 — enforce was off

`enforce(edit): clean (disabled)` × 29. Observed, not judged — this looks like
run configuration, but it means the differential re-verify covered nothing.

---

## 5. Speed

Run 20 (27 tasks) vs run 21 (30 tasks). Instrumented phases only — these are
logged identically in both runs.

| phase    | run 20 /task | run 21 /task | delta |
|----------|-------------:|-------------:|------:|
| research |      308.6 s |      228.1 s | −26 % |
| refine   |       59.0 s |       38.6 s | −35 % |
| grill    |       51.5 s |       32.1 s | −38 % |
| critique |       27.4 s |       18.5 s | −32 % |
| compose  |       24.2 s |       17.8 s | −26 % |
| **spec total** | **470.7 s** | **335.1 s** | **−28.8 %** |

Worker mean work time: apis 277.8→206.9 s, context 198.3→146.4 s,
files 110.9→74.0 s, tooling 50.6→21.3 s.

End to end: 591 min / 27 tasks → 582 min / 30 tasks = **−11.4 % per task.**

Spec authoring got ~30 % faster; the rest of the pipeline absorbed most of it.

**Caveat, do not skip:** log volume went 770 → 8052 events between runs (the
deep request log landed in between). Any "active vs idle" figure derived from
gaps between log lines is therefore not comparable across these two runs, and I
am not reporting one.

Final gate cost 45 min: 30 of those were the discarded attempt (G3).

---

## 6. Ranked fixes

1. **Do not demote a check that a fresh probe still reproduces.** Before
   `isNonProgress` demotes, re-run the check against a clean tree. Identical
   failure + reproducible ⇒ FAIL, not UNOBSERVED. This one released a dead app.
2. **Add `--enable-logging=stderr --v=0` to `runRenderCheck` and put the console
   errors in the failure detail.** Two flags, DOM output unchanged, verified
   above. Turns "body is EMPTY" into "ReferenceError: process is not defined at
   main.js:322".
3. **A browser deliverable may not be verified by a server-runtime command.**
   If the task owns `src/client/**`, `bun -e` / `node -e` proves nothing about
   it. Require a bundle-and-render check.
4. **Give research a contradiction channel.** W2 had the right fact one bullet
   above the wrong one, and W3 turned an observed defect into a contract for
   five downstream tasks. An observation that contradicts the spec must surface
   as a defect, not as context.
5. **Gate the fix child's command budget.** It chose a 5× suite loop that could
   not fit the 300s cap, and paid 30 minutes for it.
6. **Do not let a fix pass close `ok` on unrun code.** G4 shipped an invented
   Bun API through a `catch {}` that made it invisible to every runtime probe.

## Appendix — reproducing D1

```sh
cd ~/hub/mx5/dist && python3 -m http.server 8791 &
~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome \
  --headless --disable-gpu --no-sandbox --disable-dev-shm-usage \
  --virtual-time-budget=8000 --enable-logging=stderr --v=0 \
  --dump-dom http://localhost:8791/
```

stdout: 318 bytes, `<div id="root"></div>` empty.
stderr: `"Uncaught ReferenceError: process is not defined", source: …/main.js (322)`
