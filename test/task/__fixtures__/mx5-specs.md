<<<TASK_0034>>>
GOAL
Complete the §3 single-package scaffold on disk so it is fully self-consistent: create the four missing §3 layout directories (`src/client/components/`, `src/client/components/ui/`, `src/client/pages/`, and root `test/`), resolve the dangling `index.html` runtime artifact by committing a minimal root `index.html` template that the `build` script copies into `dist/` after the `Bun.build` step, and ensure `bun test` / `npm test` exit 0 with a zero-test or minimal-scaffold-spec `test/` (adding a trivial scaffold spec only if Bun's no-files-found behavior otherwise causes a non-zero exit). The template is a plain shell — `<!doctype html>`, a `<div id="root">` (matching the placeholder `main.tsx`'s `document.getElementById('root')`), `<link rel="stylesheet" href="/app.css">`, and `<script type="module" src="/main.js">` — with no brand styling, no `<title>`, and no inline fonts (those land with the router/pages in later steps). Done looks like: every file and directory in the §3 layout tree exists at its pinned path; the only source change is the one-line extension of the existing `build` script; `tsc --noEmit` and `eslint .` pass clean; `bun test` and the full `npm test` script both exit 0 (a zero-test `bun test` must not exit non-zero — if it does, a minimal scaffold spec under `test/` was added); and `npm run build` completes, emitting `dist/app.css`, the `Bun.build` client bundle (`dist/main.js`), and `dist/index.html`.

CONSTRAINTS
- In-place update only: the existing files on disk — `package.json` (name `mx5-private`, `"private": true`, `"type": "module"`, all pinned dependencies/devDependencies, scripts `lint`, `dev`, `build`, `test`, `test:ct`, `migrate`, `seed`), `tsconfig.json` (all existing `compilerOptions` and `include`), `eslint.config.js`, `build.ts`, `.prettierrc.cjs`, `DESIGN/`, and all existing `src/` files (`src/shared/schema.ts`, `src/server/{index,db,migrate,seed,auth,images,rate-limit}.ts`, `src/server/migrations/0001_init.sql`, `src/server/routes/{auth,invites,listings,photos,admin}.ts`, `src/client/{main.tsx,api.ts,index.css}`) — already exist and must be preserved verbatim; do not recreate, rename, reduce, or "minify" them. No `bunfig.toml`, `src/client/components/Nav.tsx`, `test/setup.ts`, or pre-existing `test/*.test.ts` are assumed to be on disk.
- `package.json`: the change is the single-line extension of the existing `build` script body only — nothing else in `package.json` may change. Change the value of `"build"` from
  `bunx @tailwindcss/cli -i src/client/index.css -o dist/app.css && bun build.ts`
  to
  `bunx @tailwindcss/cli -i src/client/index.css -o dist/app.css && bun build.ts && cp index.html dist/index.html`.
  Do not add or remove any other script (no new `"prebuild"` or `"emit"` key); do not add or remove any dependency; keep it single-package (no `"workspaces"` field, no nested `package.json` anywhere).
- `tsconfig.json`, `eslint.config.js`, and `build.ts` are preserved verbatim — the `cp index.html dist/index.html` step lives in the `build` script, so no new TS file is introduced and no `tsconfig` `include` widening is needed. Do not add a `scripts/` directory, no `playwright-ct.config.ts`, no Playwright spec files or `__screenshots__/` baselines (step 9 owns those), no `docker-compose.dev.yml`/`.env`/DB files (step 3 owns those), and no new route/page/component/api/CSS tokens.
- The new root `index.html` template must be exactly the minimal plain shell, contract-exact and dependency-free:
  `<!doctype html>`, then a `<head>` containing `<meta charset="utf-8" />` (optional) and `<link rel="stylesheet" href="/app.css">`, and a `<body>` containing `<div id="root"></div>` and `<script type="module" src="/main.js"></script>`.
  It must use `id="root"` (the exact selector the placeholder `src/client/main.tsx` reads), reference `/main.js` as a module script (the `Bun.build` entry output) and `/app.css` (the tailwind CLI output) by the exact paths the server will serve from `dist/`. No `<title>`, no brand classes, no inline styles, no font declarations.
- Author `index.html` already prettier-clean against `.prettierrc.cjs` (LF line endings, `singleAttributePerLine: true`, `htmlWhitespaceSensitivity: strict`, `semi: false`, `trailingComma: none`). The new file is outside the `lint` script's `prettier --write` globs (`src/**`, `test/**`) and outside `tsc`'s `include`, so it will not be touched by `npm run lint`; it must still be clean on its own.
- `src/client/main.tsx` stays the verbatim placeholder mount (`createRoot(document.getElementById('root') ?? document.body)`); do not add router, nav, or route-guard code (step 24).
- The `test` script must keep its exact semantics: `AGENT=1 bun test && ([ -f playwright-ct.config.ts ] && playwright test -c playwright-ct.config.ts || true)` — the guard already no-ops while `playwright-ct.config.ts` is absent. Do not create the CT config. A direct `bun test` in VERIFY must be prefixed with `AGENT=1` (per AGENTS.md), matching what `npm test` runs.
- Ensure `bun test` exits 0 with zero test files: if the empty `test/` directory causes a non-zero exit (Bun's no-files-found behavior), add a minimal scaffold spec under `test/` (e.g. a trivial `bun test` assertion that the scaffold layout exists) so the `test` script passes. Do not write route/component tests here — those land with each route/component in later steps.
- The §3 layout directories that are missing must be created: `src/client/components/`, `src/client/components/ui/`, `src/client/pages/`, and root `test/`. Directory-only entries are sufficient (git does not track empty dirs, so this is acceptable at scaffold scope; content lands in later steps).
- All added/changed content lives at the repo root or under the pinned `src/` client paths (`src/client/components/`, `src/client/components/ui/`, `src/client/pages/`) and `test/` — "All code under `src/` (server, client, shared side by side)". Do not relocate `src/client/main.tsx` or `src/client/index.css`.

ACCEPTANCE
- The four missing §3 directories exist at their pinned paths: `src/client/components/`, `src/client/components/ui/`, `src/client/pages/`, and root `test/` (directory-only; content lands in later steps).
- A committed root `index.html` template exists, is a minimal plain shell (no `<title>`, no brand styling, no inline fonts), and is the SPA-fallback runtime artifact source. `dist/index.html` is build-generated (gitignored `dist/`), not committed.
- The `build` script's value is exactly `bunx @tailwindcss/cli -i src/client/index.css -o dist/app.css && bun build.ts && cp index.html dist/index.html`; no other `package.json` field changed; `tsconfig.json`, `eslint.config.js`, `build.ts`, and every existing `src/`/`DESIGN/` file are unchanged.
- `tsc --noEmit` exits 0 and `eslint .` exits 0 on the modified tree.
- `bun test` (with `AGENT=1`) and the full `npm test` script both exit 0. The test run is a zero-test pass or a trivial scaffold-spec pass under `test/` — no route or component tests are present or required at this step.
- `npm run build` exits 0 and produces `dist/app.css`, `dist/main.js`, and `dist/index.html`, where `dist/index.html` contains `<div id="root">`, `<link rel="stylesheet" href="/app.css">`, and `<script type="module" src="/main.js">`.

VERIFY:
```sh
set -euo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

# --- all four missing §3 directories exist at their pinned paths ---
test -d src/client/components
test -d src/client/components/ui
test -d src/client/pages
test -d test

# --- the build script gained exactly the cp step and nothing else changed ---
test "$(node -e 'process.stdout.write(require("./package.json").scripts.build)')" \
  = "bunx @tailwindcss/cli -i src/client/index.css -o dist/app.css && bun build.ts && cp index.html dist/index.html"
test "$(node -e 'process.stdout.write(require("./package.json").scripts.test)')" \
  = "AGENT=1 bun test && ([ -f playwright-ct.config.ts ] && playwright test -c playwright-ct.config.ts || true)"

# --- the committed root template is the minimal plain shell ---
test -f index.html
grep -q 'id="root"' index.html
grep -q 'src="/main.js"' index.html
grep -q 'href="/app.css"' index.html
! grep -q '<title' index.html

# --- full-tree type-check + lint gate ---
bunx tsc --noEmit
bunx eslint .

# --- test run: zero-test or minimal scaffold spec must exit 0 (no live DB required) ---
AGENT=1 bun test
npm test

# --- build: tailwind + Bun.build + cp, and the emitted runtime artifact is correct ---
npm run build
test -f dist/app.css
test -f dist/main.js
test -f dist/index.html
grep -q 'id="root"' dist/index.html
grep -q 'src="/main.js"' dist/index.html
grep -q 'href="/app.css"' dist/index.html

echo OK
```
<<<TASK_0035>>>
GOAL
Make the repo's code-style tooling complete and green: `.prettierrc.cjs` carries the pinned aiz-server Prettier settings (the spec §2 set plus every pre-existing aiz-server extra key, none dropped or retuned), `eslint.config.js` is a working ESLint 10 flat config built on `typescript-eslint` `recommendedTypeChecked` with the exact pinned rule set, and `package.json`'s `lint` script keeps its existing extended pipeline form — and `bun run lint` (prettier → eslint → tsc) exits 0 against the current tree (config files plus the step-1 scaffolded sources/tests), auto-fixing any residual formatting/lint issues in place.

CONSTRAINTS
  - "`lint` = `prettier --write 'src/**/*.{ts,tsx}' && eslint --fix . && tsc --noEmit`;" [§2 Tech stack — Code style / tooling] — owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)
- `package.json`'s `lint` script keeps its existing extended form verbatim: `prettier --log-level warn --write --no-error-on-unmatched-pattern 'src/**/*.{ts,tsx}' 'test/**/*.{ts,tsx}' && eslint --fix . && tsc --noEmit`. Do not reduce it to the literal spec line (`prettier --write 'src/**/*.{ts,tsx}' && eslint --fix . && tsc --noEmit`); keep the `--log-level warn` and `--no-error-on-unmatched-pattern` flags and the `'test/**/*.{ts,tsx}'` glob. Do not touch any other script or dependency.
- `.prettierrc.cjs` must contain the full spec §2 set plus the aiz-server extras, with no key dropped or retuned. The spec §2 set is `printWidth: 120`, `tabWidth: 4`, `useTabs: false`, `semi: false`, `singleQuote: true`, `bracketSpacing: false`, `arrowParens: 'avoid'`, `endOfLine: 'lf'`. The aiz-server extras are `experimentalTernaries: true`, `experimentalOperatorPosition: 'start'`, `quoteProps: 'as-needed'`, `jsxSingleQuote: true`, `trailingComma: 'none'`, `objectWrap: 'preserve'`, `proseWrap: 'always'`, `htmlWhitespaceSensitivity: 'strict'`, `singleAttributePerLine: true`. In addition, whatever keys are already present in the current `.prettierrc.cjs` must be preserved unchanged (do not "tidy", rename, or remove a pre-existing key that is not in the lists above).
- `eslint.config.js` must be the flat config with this structure: global ignores (`**/dist/**`, `**/*.d.ts`, `eslint.config.js`, `**/.prettierrc.cjs`); `js.configs.recommended` + `...tseslint.configs.recommendedTypeChecked` bases; `parserOptions.projectService: true` with `tsconfigRootDir: import.meta.dirname`; the `typedRules` block applied to `**/*.ts`/`**/*.tsx`; node globals on `src/server/**/*.ts` + `src/shared/**/*.ts`; browser globals + `react-hooks` (`rules-of-hooks: error`, `exhaustive-deps: warn`) + `react-refresh` (`only-export-components: ['warn', {allowConstantExport: true}]`) on `src/client/**/*.{ts,tsx}`; test relaxation on `test/**/*.ts` (off: `await-thenable`, `no-unsafe-assignment`, `no-unsafe-call`, `no-unsafe-member-access`, `no-unsafe-argument`, `no-unsafe-return`); `**/*.{js,mjs,cjs}` with `...tseslint.configs.disableTypeChecked`; and the `prettier` config appended LAST.
- Preserve the pinned rule semantics exactly in `typedRules`: `@typescript-eslint/no-explicit-any: error`; `@typescript-eslint/no-shadow: error` with core `no-shadow: off`; `no-redeclare: error`; `@typescript-eslint/no-unused-vars: warn` with the full options object (`args: 'all'`, `argsIgnorePattern: '^_'`, `caughtErrors: 'all'`, `caughtErrorsIgnorePattern: '^_'`, `destructuredArrayIgnorePattern: '^_'`, `varsIgnorePattern: '^_'`, `ignoreRestSiblings: true`); and `warn` on `no-unsafe-call`, `no-unsafe-member-access`, `no-unsafe-argument`, `no-misused-promises`, `no-floating-promises`, `unbound-method`, `require-await`, `no-unsafe-enum-comparison`; `no-empty-object-type` and `no-base-to-string` stay `off`. Do not tighten or loosen any of these — they were ported from `~/hub/aiz-*`. Pre-existing eslint-disable suppressions in step-1 sources (`src/client/api.ts` and `test/client-api.test.ts`) depend on these exact severities and must remain in place.
- `tsconfig.json` already satisfies the spec §2 TypeScript pin (strict, `noUncheckedIndexedAccess`, `noUnusedLocals/Parameters`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, `forceConsistentCasingInFileNames`, `ignoreDeprecations: "6.0"`, `"types": ["bun"]`, `include` covering `src`, `test`, and the root-level `.ts`/`.js` files). Leave it completely unchanged; the `tsc --noEmit` half of `lint` must pass against it. Do not change its `include` set or compiler options.
- No dependency may be added, removed, or bumped; `bun.lock` stays as-is. All tooling packages (`prettier`, `eslint`, `typescript-eslint`, `@eslint/js`, `globals`, `eslint-config-prettier`, `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`) are already in `devDependencies`.
- Do not touch step-1 layout: `package.json` deps/devDeps, `src/{shared,server,client}` structure, other scripts (`dev`, `build`, `test`, `test:ct`, `migrate`, `seed`).
- No code (routes, pages, schemas) beyond step 1's scaffold may be authored or refactored: if `prettier --write` / `eslint --fix` reformat step-1 files, that in-place formatting is in scope, but no semantic edits to them. Any lint/type violations must be fixed in place; do not silence rules to force a green run.

ACCEPTANCE
- `bun run lint` exits 0 against the current tree: prettier passes on `src/**` + `test/**` (reformatting in place if needed), `eslint --fix .` exits 0 with the pinned flat config (auto-fixing or manually fixing in place any residual errors), and `tsc --noEmit` passes against the unchanged strict `tsconfig.json`.
- `.prettierrc.cjs` contains every key in the spec §2 Prettier set with the exact pinned values (printWidth 120, tabWidth 4, useTabs false, semi false, singleQuote true, bracketSpacing false, arrowParens `'avoid'`, endOfLine `'lf'`) plus every aiz-server extra key at its pinned value, and no pre-existing key has been dropped or retuned.
- `eslint.config.js` is a valid ESLint 10 flat config: type-checked `recommendedTypeChecked`, `projectService: true` rooted at `import.meta.dirname`, the four per-dir glob blocks (node server+shared, browser/react client, test relaxations, JS-files-with-type-checked-disabled), the exact pinned `typedRules` block, prettier last, and the four ignore entries.
- `package.json`'s `lint` script is the existing extended form (prettier with `--log-level warn --no-error-on-unmatched-pattern` over both the `src/**` and `test/**` globs, then `eslint --fix .`, then `tsc --noEmit`) — extended, not replaced.
- `tsconfig.json` is byte-for-byte unchanged; no dependency was added, removed, or version-bumped; no step-1 source file received a semantic edit (formatting-only changes are allowed).

VERIFY:
```sh
set -e
cd /workspace

# 1) Full lint pipeline must exit 0 (prettier → eslint → tsc).
bun run lint

# 2) tsc --noEmit explicitly (belt-and-suspenders against the tsc half of lint).
bunx tsc --noEmit

# 3) Prettier config: every spec §2 + aiz-server key present with the exact value.
node -e "
const c = require('/workspace/.prettierrc.cjs');
const want = {
  experimentalTernaries: true,
  experimentalOperatorPosition: 'start',
  printWidth: 120,
  tabWidth: 4,
  useTabs: false,
  semi: false,
  singleQuote: true,
  quoteProps: 'as-needed',
  jsxSingleQuote: true,
  trailingComma: 'none',
  bracketSpacing: false,
  objectWrap: 'preserve',
  arrowParens: 'avoid',
  proseWrap: 'always',
  htmlWhitespaceSensitivity: 'strict',
  endOfLine: 'lf',
  singleAttributePerLine: true
};
for (const [k, v] of Object.entries(want)) {
  if (c[k] !== v) throw new Error('prettierrc key mismatch: ' + k + '=' + JSON.stringify(c[k]) + ' want ' + JSON.stringify(v));
}
console.log('prettierrc OK');
"

# 4) ESLint flat config: structural facts present (load + scan the resolved config).
node --input-type=module -e "
const mod = await import('/workspace/eslint.config.js');
let cfg = mod.default;
if (typeof cfg === 'function') cfg = cfg();
const all = JSON.stringify(cfg);
const reqs = [
  'projectService',
  'import.meta.dirname',
  'src/server/**/*.ts',
  'src/shared/**/*.ts',
  'src/client/**/*.{ts,tsx}',
  'test/**/*.ts',
  '**/*.{js,mjs,cjs}',
  'no-explicit-any',
  'no-unsafe-call',
  'await-thenable',
  'only-export-components'
];
for (const r of reqs) {
  if (!all.includes(r)) throw new Error('eslint config missing: ' + r);
}
console.log('eslint config OK');
"

# 5) package.json lint script: exact extended form present (escaped-JSON-safe check).
node -e "
const pkg = require('/workspace/package.json');
const want = 'prettier --log-level warn --write --no-error-on-unmatched-pattern ' +
  \"'src/**/*.{ts,tsx}'\" + ' ' + \"'test/**/*.{ts,tsx}'\" +
  ' && eslint --fix . && tsc --noEmit';
if (pkg.scripts.lint !== want) {
  throw new Error('lint script mismatch:\n  got:  ' + pkg.scripts.lint + '\n  want: ' + want);
}
console.log('lint script OK');
"

# 6) Re-run lint a second time to confirm idempotency (no residual drift).
bun run lint
```
<<<TASK_0036>>>
GOAL
Make the MX-5 dev environment correct and verifiable in this slice: fix `docker-compose.dev.yml` so its Postgres 18.4 service persists data against the correct PG18 data directory and creates both `mx5` and `mx5_test` exactly once per fresh volume without crashing on subsequent starts (replace the current `entrypoint`/`command: ["createdb", ...]` hack with a `/docker-entrypoint-initdb.d/` script), add a committed `.env.example` with placeholder values for the five pinned keys alongside the existing gitignored local `.env`, and confirm the `package.json` `scripts` block already matches the pinned set verbatim (`dev`, `build`, `migrate`, `seed`, `test`, plus preserved `lint` and `test:ct`) with zero diff there — `migrate`/`seed` scripts point at `src/server/migrate.ts` / `src/server/seed.ts`, which arrive in later steps and are NOT created here. Fix `build.ts`'s single-process watch orchestrator only if a live `bun run dev` run reveals a defect (it must run the three watchers concurrently and tear all of them down on Ctrl-C/SIGTERM).

CONSTRAINTS
  - "**Dev:** docker-compose Postgres + concurrent watch (tailwind, bun build, server)." [§9 Build & run] — owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)
  - "**Scripts:** `dev`, `build`, `migrate`, `seed`, `test`." [§9 Build & run] — owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)
- Files that may change in this slice: `docker-compose.dev.yml`, new `.env.example`, `package.json` (scripts block only — and only if it does not already match the pinned scripts verbatim; the current tree already does, so expect zero diff there), and `build.ts` only if a live run proves a defect. Do NOT create or modify `src/server/migrate.ts`, `src/server/seed.ts`, `src/server/index.ts`, `src/server/db.ts`, `src/shared/schema.ts`, `src/server/routes/*`, `test/setup.ts`, `bunfig.toml`, or any module owned by other steps.
- Preserve untouched in `package.json`: every entry in `dependencies` and `devDependencies`, `"type": "module"`, and the existing `lint` and `test:ct` scripts. Do not bump any dependency version.
- Final `scripts` must be exactly: `"dev": "bun build.ts --watch"`, `"build": "bunx @tailwindcss/cli -i src/client/index.css -o dist/app.css && bun build.ts && cp index.html dist/index.html"`, `"migrate": "bun src/server/migrate.ts"`, `"seed": "bun src/server/seed.ts"`, `"test": "AGENT=1 bun test && ([ -f playwright-ct.config.ts ] && playwright test -c playwright-ct.config.ts || true)"`, plus the unchanged `lint` and `test:ct`. Do not alter the `test` script's text in this slice — it is pinned verbatim by the design and by a later slice's responsibility; the trailing `|| true` is intentional per the pinned scripts block and is not a defect this slice must fix.
- `.env.example` contains exactly the five keys with placeholder values, one per line, in this order: `DATABASE_URL=postgres://postgres:postgres@localhost:5432/mx5`, `APP_URL=http://localhost:3000`, `PORT=3000`, `ADMIN_PHONE=+37120000000`, `ADMIN_PASSWORD=<your-admin-password>`. The dev DB name in `DATABASE_URL` must be exactly `mx5` — `test/setup.ts` rewrites the last path segment `\/mx5(?=\/|$)` to `/mx5_test`, so any other name silently points tests at the dev DB. No script or file may hardcode credentials beyond this placeholder file; the root `.env` (Bun auto-loads it) remains the runtime env source.
- Keep the existing local `.env` in place (it holds the five real keys) — per the Q&A decision it stays as the gitignored local file while only `.env.example` is committable. Do not modify `.gitignore` (it already ignores `.env` and `.env.*` and whitelists `!.env.example`), nor `tsconfig.json`, nor `eslint.config.js`, nor anything under `DESIGN/`.
- `docker-compose.dev.yml`: image `postgres:18.4` (pinned minor, not rolling), single service `db`, `container_name: mx5-dev-db`, `restart: unless-stopped`, environment `POSTGRES_USER=postgres`, `POSTGRES_PASSWORD=postgres`, `POSTGRES_DB=mx5`, fixed port mapping `"5432:5432"`, named volume `mx5_db_data`. No extra services.
- Fix the PG18 PGDATA mount: the PostgreSQL 18 official image stores data at `/var/lib/postgresql/18/docker` (version-specific; the 18.4 image's default `PGDATA` is not `/var/lib/postgresql/data`). The named volume must be mounted at the image's actual PGDATA so persistence works — verify the real path by inspecting the running container (`docker exec mx5-dev-db printenv PGDATA` or `ls /var/lib/postgresql`) and mount the volume there. Do not assume `/var/lib/postgresql/data`.
- `mx5_test` must be created on every fresh initialization of the volume and the container must not crash-loop on subsequent `up` against an already-initialized volume. Implement via a `docker-entrypoint-initdb.d/` init script (e.g. `docker-entrypoint-initdb.d/10-create-mx5-test.sh` mounted into the container, containing `createdb -O postgres mx5_test`, executed by the official entrypoint only during first-init) and drop the current `entrypoint: ["docker-entrypoint.sh"]` + `command: ["createdb", "-O", "postgres", "mx5_test", "postgres"]` override entirely. The compose file must define the init-script mount (a bind mount from a checked-in file next to the compose file is acceptable) and must not re-run `createdb` after first init.
- `build.ts`: preserve its single-process orchestrator structure — spawns the `Bun.build` client watcher (`bun build --entrypoints src/client/main.tsx --outdir dist --minify --splitting --watch`), the tailwind watcher (`bunx @tailwindcss/cli -i src/client/index.css -o dist/app.css --watch=always`), and the server watcher (`bun run --watch src/server/index.ts`); `shutdown()` sends SIGTERM to every child on SIGINT/SIGTERM, awaits all `child.exited`, exits 0; a single child's own exit must NOT trigger shutdown (`src/server/index.ts` exports only the Hono app and binds no port, so its `bun run --watch` child exits immediately — do not add a listener to it). Fix only what a live `bun run dev` run shows to be broken.
- Do not add dependencies (no `concurrently`-style package); `bun run dev` remains the single orchestrator process via the existing `build.ts` spawn pattern.

ACCEPTANCE
- `bun run dev` starts all three watchers (client bundle, tailwind CSS, server) concurrently in one process; sending SIGINT to the orchestrator tears all of them down within a few seconds and no orphaned `bun build --entrypoints src/client/main.tsx --watch`, `tailwindcss/cli --watch=always`, or `bun run --watch src/server/index.ts` processes remain.
- `docker compose -f docker-compose.dev.yml down --volumes && up -d db` (fresh volume) yields a running `db` container with both `mx5` and `mx5_test` databases present.
- Repeating `docker compose -f docker-compose.dev.yml down && up -d db` (existing volume) leaves the container in `running` state with no restart loop and `mx5_test` still present (no `createdb: database "mx5_test" already exists` crash).
- Data written via the container survives a `down && up` without `--volumes` (proves the volume is mounted at the real PGDATA).
- `.env.example` exists with exactly the five pinned keys; `.env` still exists locally and is gitignored (`git check-ignore .env` succeeds); `.env.example` is not gitignored.
- `bun run build` exits 0 and produces non-empty `dist/app.css`, the client JS bundle output under `dist/`, and `dist/index.html`.
- `bun run lint` exits 0 (it already runs prettier, eslint, and `tsc --noEmit`) with no changes to `package.json` dependencies, `tsconfig.json`, or `eslint.config.js`.
- `package.json` `scripts` block is byte-identical to the pinned set listed in CONSTRAINTS; `dependencies` and `devDependencies` are untouched.
- The `migrate`, `seed`, and full `bun run test` suites are NOT acceptance criteria for this slice — their target modules (`src/server/migrate.ts`, `src/server/seed.ts`) and the test harness that depends on them arrive in later steps.

VERIFY:
```sh
set -euo pipefail
cd /workspace

# --- .env.example (this slice's new artifact) ---
test -f .env.example
[ "$(grep -cE '^(DATABASE_URL|APP_URL|PORT|ADMIN_PHONE|ADMIN_PASSWORD)=' .env.example)" -eq 5 ]
grep -q '^DATABASE_URL=postgres://postgres:postgres@localhost:5432/mx5$' .env.example
grep -q '^APP_URL=http://localhost:3000$' .env.example
grep -q '^PORT=3000$' .env.example
grep -q '^ADMIN_PHONE=+37120000000$' .env.example
grep -q '^ADMIN_PASSWORD=<your-admin-password>$' .env.example
test -f .env
git check-ignore -q .env
! git check-ignore -q .env.example

# --- package.json scripts are byte-identical to the pinned set ---
node --input-type=module -e '
import {readFileSync} from "node:fs";
const s = JSON.parse(readFileSync("/workspace/package.json","utf8")).scripts;
const expected = {
  dev: "bun build.ts --watch",
  build: "bunx @tailwindcss/cli -i src/client/index.css -o dist/app.css && bun build.ts && cp index.html dist/index.html",
  migrate: "bun src/server/migrate.ts",
  seed: "bun src/server/seed.ts",
  test: "AGENT=1 bun test && ([ -f playwright-ct.config.ts ] && playwright test -c playwright-ct.config.ts || true)"
};
for (const [k,v] of Object.entries(expected)) {
  if (s[k] !== v) { console.error("script mismatch: " + k + " = " + s[k]); process.exit(1); }
}
if (!s.lint || !s["test:ct"]) { console.error("lint / test:ct missing"); process.exit(1); }
console.log("scripts OK");
'

# --- compose: fresh volume initializes both DBs; existing volume survives restart ---
docker compose -f docker-compose.dev.yml down --volumes
docker compose -f docker-compose.dev.yml up -d db
for i in $(seq 1 60); do
  docker compose -f docker-compose.dev.yml exec -T db pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 2
done
docker compose -f docker-compose.dev.yml exec -T db pg_isready -U postgres
[ "$(docker compose -f docker-compose.dev.yml exec -T db psql -U postgres -d mx5 -tAc "SELECT count(*) FROM pg_database WHERE datname IN ('mx5','mx5_test')")" = "2" ]
docker compose -f docker-compose.dev.yml exec -T db psql -U postgres -d mx5 -tAc "CREATE TABLE IF NOT EXISTS __persist_check(x int); INSERT INTO __persist_check VALUES (1)"
docker compose -f docker-compose.dev.yml down
docker compose -f docker-compose.dev.yml up -d db
for i in $(seq 1 60); do
  docker compose -f docker-compose.dev.yml exec -T db pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 2
done
docker compose -f docker-compose.dev.yml exec -T db pg_isready -U postgres
[ "$(docker compose -f docker-compose.dev.yml exec -T db psql -U postgres -d mx5 -tAc 'SELECT count(*) FROM __persist_check')" = "1" ]
[ "$(docker compose -f docker-compose.dev.yml exec -T db psql -U postgres -tAc "SELECT count(*) FROM pg_database WHERE datname = 'mx5_test'")" = "1" ]
[ "$(docker inspect -f '{{.State.Status}}' mx5-dev-db)" = "running" ]
# No crash-loop: restart count stays at 0 after a second no-volume restart
docker compose -f docker-compose.dev.yml down
docker compose -f docker-compose.dev.yml up -d db
for i in $(seq 1 60); do
  docker compose -f docker-compose.dev.yml exec -T db pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 2
done
docker compose -f docker-compose.dev.yml exec -T db pg_isready -U postgres
[ "$(docker inspect -f '{{.RestartCount}}' mx5-dev-db)" = "0" ]
[ "$(docker inspect -f '{{.State.Status}}' mx5-dev-db)" = "running" ]

# --- dev orchestrator: three watchers concurrently, SIGINT tears all down ---
bun run dev > /tmp/mx5-dev.log 2>&1 &
DEV_PID=$!
for i in $(seq 1 45); do
  sleep 2
  if pgrep -f 'tailwindcss/cli.*--watch=always' >/dev/null 2>&1 && \
     pgrep -f 'bun run --watch src/server/index.ts' >/dev/null 2>&1 && \
     pgrep -f 'bun build --entrypoints src/client/main.tsx.*--watch' >/dev/null 2>&1; then
    break
  fi
done
pgrep -f 'tailwindcss/cli.*--watch=always' >/dev/null
pgrep -f 'bun build --entrypoints src/client/main.tsx.*--watch' >/dev/null
kill -INT "$DEV_PID"
for i in $(seq 1 30); do
  kill -0 "$DEV_PID" 2>/dev/null || break
  sleep 1
done
! kill -0 "$DEV_PID" 2>/dev/null
sleep 2
! pgrep -f 'tailwindcss/cli.*--watch=always' >/dev/null
! pgrep -f 'bun run --watch src/server/index.ts' >/dev/null
! pgrep -f 'bun build --entrypoints src/client/main.tsx.*--watch' >/dev/null

# --- build pipeline ---
bun run build
test -s dist/app.css
test -f dist/index.html
ls dist/*.js

# --- hygiene (lint already runs tsc --noEmit; run tsc again explicitly to gate type errors independently) ---
bun run lint
bunx tsc --noEmit

# --- clean up the dev DB ---
docker compose -f docker-compose.dev.yml down --volumes
```
<<<TASK_0037>>>
GOAL
Verify-and-land the shared server DB client at `src/server/db.ts` as the single Bun SQL client for the server. The module already exists in place; this step confirms it is correct and complete and that the whole surface it feeds stays green. Done looks like:
(1) `src/server/db.ts` imports `SQL` from `"bun"` (there is no `bun:sql` module), exports a shared `sql` usable as a tagged template with bound values (`await sql`SELECT …${x}``), plus `sql.unsafe(...)` for raw/multi-statement SQL and `sql.begin(async tx => …)` for transactions;
(2) the underlying `SQL` instance is constructed from `process.env.DATABASE_URL` lazily on first use (not at import time), so `test/setup.ts`'s top-level rewrite of the URL to `mx5_test` takes effect before the first query with `db.ts` unmodified;
(3) every existing consumer of `db.ts` (`src/server/migrate.ts`, `src/server/auth.ts`, `src/server/seed.ts`, `src/server/routes/auth.ts`, and the sibling route modules) compiles and runs unchanged against that surface;
(4) `test/db.test.ts` (a bound-value `sql<{value: string}[]>` SELECT round-trip against `mx5_test`) passes;
(5) `bun run lint` and the full `bun run test` suite are green against a reachable local Postgres 18.

CONSTRAINTS
- Update/confirm `src/server/db.ts` in place; do not delete, recreate, or reduce its existing behavior. Pinned design: it imports from `"bun"` (never a `bun:sql` module); the exported `sql` is a `Proxy` over a plain-function target — Bun's Postgres adapter requires `arg[0] instanceof TemplateStringsArray`, which fails for an `SQL` instance used as the tag — with `get`/`apply` traps that re-bind property reads (`sql.unsafe`, `sql.begin`) to the lazily created instance and re-apply tagged-template calls to the real instance; a module-level `instance` cache plus a first-use builder that reads `process.env.DATABASE_URL` and throws a clear error when unset; and `unsafe`/tagged queries return concrete `SqlClient.Query<unknown>`-shaped types (not `any`) so the `no-unsafe-*` rules stay clean. Import-time construction is forbidden.
- The `DATABASE_URL` contract stays exactly as-is: the variable name, the lazy first-use read, the throw when unset, and the `test/setup.ts` rewrite regex (`/\/mx5(?=\/|$)/` → `/mx5_test`). The `postgres://` scheme in `.env` is passed to `new SQL(url)` verbatim — do not rewrite it.
- Preserve the exact usage surface the siblings already import: `import {sql} from '…/db'`; `sql<RowType[]>` tagged templates; `sql.unsafe(string)` (including multi-statement content); and `sql.begin(async tx => {…})` where `tx` supports the same tagged-template and `unsafe` call shapes. Do not rename, re-shape, or gate any of these, and add no new export (no `Query` re-export, no test-reset hook) unless a consumer breaks.
- The type-checked `no-unsafe-*` ESLint rules (`no-unsafe-call`, `no-unsafe-argument`, `no-unsafe-return`, …, configured as `warn`) apply to `src/server/**/*.ts`; only `no-explicit-any` is an `error`. Any `as unknown as X` double-casts the Proxy design requires must stay `any`-free — a literal `any` fails lint.
- Queries must remain parameterized via tagged templates (no string interpolation of values into SQL — the spec's security rule); raw/multi-statement SQL belongs exclusively in `sql.unsafe(...)` (as `migrate.ts` already does for `CREATE TABLE IF NOT EXISTS schema_migrations` and per-file migration contents).
- `test/setup.ts`, `bunfig.toml`, `.env` / `.env.example`, and the `package.json` scripts (`migrate`, `seed`, `test`, `lint`) must not be modified by this step. Note: `test/setup.ts` is registered as a `[test] preload` in `bunfig.toml` and, at the top of every `bun test` run, rewrites `DATABASE_URL` to `mx5_test` and then runs `runMigrate()` once — the green full-suite run is what proves the lazy client coexists with that preload; do not attempt to neutralize it.
- Do not add migrations, tables, schema, routes, auth, or seed logic (those belong to other steps). Do not touch client code, `src/shared/schema.ts`, or Playwright config.
- Code style per `.prettierrc.cjs` / `AGENTS.md`: 4-space indent, no semicolons, single quotes, printWidth 120, no bracket spacing, LF; the file must be prettier-stable and `tsc --noEmit` must pass under the single strict `tsconfig.json`.

ACCEPTANCE
- `src/server/db.ts` is in place, imports from `"bun"` (no `bun:sql`), exports exactly `sql`, and constructs the shared `SQL` client lazily from `DATABASE_URL` on first use, throwing a clear, identifiable error when the variable is unset.
- All existing consumers of `db.ts` (`src/server/migrate.ts`, `src/server/auth.ts`, `src/server/seed.ts`, `src/server/routes/auth.ts`, and the sibling modules) compile and run unchanged, still importing exactly `import {sql} from '…/db'`; this step makes no edits to them.
- `test/db.test.ts` (bound-value `sql<{value: string}[]>` SELECT round-trip) passes against a reachable Postgres with `DATABASE_URL` rewritten to `mx5_test`.
- `bun run lint` (prettier + eslint with `no-unsafe-*` / `no-explicit-any` + `tsc --noEmit`) is green with no `any` and a prettier-stable tree.
- `bun run test` runs the full suite green against `mx5_test` under the `test/setup.ts` preload.
- Laziness is verified by the suite itself: `test/setup.ts` rewrites `DATABASE_URL` before any test's first query, and the passing `db.test.ts` proves `db.ts` read the rewritten value on first use rather than at import.

VERIFY:
```sh
set -euo pipefail
cd /workspace

# 1. DB must be reachable (the suite targets mx5_test on the local Postgres 18).
docker compose -f docker-compose.dev.yml up -d
until docker compose -f docker-compose.dev.yml exec -T db pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done

# 2. Type check must pass under the single strict tsconfig (no any).
bunx tsc --noEmit

# 3. Full lint chain: prettier (must leave db.ts unchanged), eslint (no-unsafe-* / no-explicit-any), and tsc.
bun run lint

# 4. The paired test must pass: bound-value SELECT round-trip against mx5_test.
#    (bunfig.toml preloads test/setup.ts, which rewrites DATABASE_URL and migrates;
#    AGENT=1 is required when invoking bun test directly, per AGENTS.md.)
AGENT=1 bun test test/db.test.ts

# 5. The full suite must be green, proving the lazy client + the test/setup.ts
#    preload (URL rewrite + runMigrate) work together. bun run test sets AGENT=1.
bun run test

# 6. Laziness smoke: with DATABASE_URL unset from the very start of a fresh
#    process, the db.ts import must NOT throw (no import-time construction) —
#    a bare process that only imports the module exits 0.
DATABASE_URL= bun -e 'await import("./src/server/db");'
```
<<<TASK_0038>>>
GOAL
Review and verify the SQL migrations runner slice for the mx5-private repo. The runner and its spec already exist on disk: `src/server/migrate.ts` (exports `runMigrate()`, gated on `import.meta.main`) and `test/migrate.test.ts`. Per the Q&A, treat this step as review/verification, not a rewrite: confirm the existing files satisfy the design's migration contract — `bun run migrate` (existing `package.json` script `"migrate": "bun src/server/migrate.ts"`) connects to `DATABASE_URL` via the shared lazy client from `src/server/db.ts` (`import {sql} from './db'`), idempotently creates `schema_migrations`, applies each unapplied top-level `*.sql` in `src/server/migrations/` in sorted order exactly once inside a per-file transaction that commits the file's SQL together with a verbatim-filename tracking row, logs `applied <file>` per new file plus an `migrate: N applied, M skipped, T total` summary, and exits 0 (a re-run with nothing new is a clean no-op). Confirm `test/migrate.test.ts` passes — it exercises idempotency and tracking against the `mx5_test` database (the `bunfig.toml` preload `test/setup.ts` rewrites `DATABASE_URL` to `mx5_test` and runs `runMigrate()` once before the suite) and cleans up its scratch artifacts so the suite is re-runnable. Confirm `bun run lint` passes. Fix only genuine environmental gaps found during the review (e.g. a stale `src/server/migrations/zz_migrate_spec_tmp.sql` left by a prior failed run, or a missing `mx5_test` database on a stale volume); do not rewrite files that already match the contract, and do not create `src/server/seed.ts` (step 7).

CONSTRAINTS
  - "Migrations are tracked in a `schema_migrations` table by `migrate.ts`." [§4 Data model] — owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)
- Review/verify, don't rewrite: `src/server/migrate.ts` and `test/migrate.test.ts` are already on disk and satisfy the contract (exported no-arg `runMigrate()`, idempotent `CREATE TABLE IF NOT EXISTS schema_migrations (filename text primary key, applied_at timestamptz not null default now())`, sorted top-level `*.sql` scan, per-file `sql.begin` transaction committing the file's SQL + verbatim-filename insert, `applied <file>` log lines, `import.meta.main` gate). Run `bun run lint`, `bun test`, and `bun run migrate` to confirm they pass; modify these files only if a run exposes a genuine contract violation, and fix environmental gaps (stale scratch file, missing `mx5_test` DB) without touching conforming code.
- Preserve `package.json` as-is: the `"migrate": "bun src/server/migrate.ts"` and `"seed": "bun src/server/seed.ts"` scripts already exist and must keep working; add or change no script, dependency, or field. Do not create or modify `src/server/seed.ts` (owned by step 7).
- Reuse the existing shared client: `import {sql} from './db'` from the already-existing `src/server/db.ts`. Do not create a second `SQL` instance, do not modify `db.ts`, and do not import `bun:sql` — the design pins the `import { sql, SQL } from "bun"` style used by `db.ts`.
- Migrations are tracked in a `schema_migrations` table by `migrate.ts` (design §4). The table is created idempotently before scanning, outside the per-file transactions, with the `(filename text primary key, applied_at timestamptz not null default now())` shape that `test/migrate.test.ts` queries (`SELECT filename, applied_at FROM schema_migrations`). The applied file's verbatim filename (e.g. `0001_init.sql`) is recorded — not contents or a hash — so re-runs skip it.
- Files are applied in sorted filename order, top-level `*.sql` in `src/server/migrations/` only (flat directory per design §3; not recursive), each unapplied file exactly once, inside a single `sql.begin` transaction per file so the file's SQL and its `INSERT INTO schema_migrations` commit atomically. Migration SQL is executed verbatim as raw statements (via the client's `unsafe`); no parsing, interpolation, or transformation, and no string interpolation of values into SQL anywhere in the runner.
- The runner's observable stdout contract is asserted by the test: a line starting with `applied <file>` per newly applied file, plus the `migrate: N applied, M skipped, T total` summary. Do not change these log formats during review.
- `test/migrate.test.ts` must exist and pass: it verifies a scratch migration (`zz_migrate_spec_tmp.sql`) is applied exactly once (one `applied zz_migrate_spec_tmp.sql` line), leaves a `schema_migrations` row with the verbatim filename and non-null `applied_at`, creates the scratch table, and that a second `runMigrate()` applies nothing. It must clean up its scratch artifacts (the `.sql` file, the `zz_migrate_spec_tmp` table, the scratch tracking row) so the suite is re-runnable, using the `db.ts` client against the `mx5_test` database as wired by the `bunfig.toml` preload.
- Do not modify or depend on: `src/shared/schema.ts`, `src/server/auth.ts`, `src/server/images.ts`, anything under `src/server/routes/`, `src/server/seed.ts`, `src/client/**`, `test/setup.ts`, `test/harness-smoke.test.ts`, `bunfig.toml`, `docker-compose.dev.yml`, `.env`, or any route/page/component.
- `src/server/migrate.ts` and `test/migrate.test.ts` must pass `bun run lint` unchanged (Prettier per `.prettierrc.cjs`, type-checked ESLint with `no-explicit-any: error`, and `tsc --noEmit`).
- If `bun test` fails because `mx5_test` is missing from a volume initialized before `docker-entrypoint-initdb.d/10-create-mx5-test.sh` was added, restore it (recreate the volume from compose, or create the database on the running instance) so the preload's `runMigrate()` can migrate it — this is environmental gap remediation, not a compose or config change.

ACCEPTANCE
- `bun run migrate` (run from the project root) connects to the `mx5` database in `.env`'s `DATABASE_URL` and exits 0: it applies any `.sql` files present in `src/server/migrations/` that are not yet in `schema_migrations` (logging `applied <file>` for each) and the `migrate: …` summary; a re-run with nothing new is a clean no-op (no `applied` lines).
- `bun test` exits 0: the `bunfig.toml` preload (`test/setup.ts`) points `DATABASE_URL` at `mx5_test` and runs `runMigrate()` once, `test/migrate.test.ts` passes (scratch migration applied exactly once, tracking row with verbatim filename and non-null `applied_at`, scratch table created, second `runMigrate()` applies nothing), and `test/harness-smoke.test.ts` passes (including its assertion that `schema_migrations` retains the `0001_init.sql` row).
- `bun run lint` exits 0 with `src/server/migrate.ts` and `test/migrate.test.ts` conforming.
- `src/server/migrations/zz_migrate_spec_tmp.sql` does not remain on disk after the test run (no stale scratch file from this or a prior failed run).
- No changes to `package.json`, `src/server/db.ts`, `test/setup.ts`, `bunfig.toml`, `docker-compose.dev.yml`, or `.env` were required or made by this step.

VERIFY:
```sh
set -e
docker compose -f docker-compose.dev.yml up -d
docker compose -f docker-compose.dev.yml ps
bun run migrate
test ! -f src/server/migrations/zz_migrate_spec_tmp.sql
bun run test
bun run lint
```
<<<TASK_0039>>>
GOAL
  Create the single file `src/server/migrations/0001_init.sql` — the complete initial schema for the MX-5 parts marketplace — so that running the existing migration script (`bun run migrate`, which delegates to `src/server/migrate.ts`) applies it once and creates all five tables plus their indexes on the Postgres 18 dev database, exactly matching the §4 "Data model" in `DESIGN/PROJECT.md`. "Done" means: the file is valid Postgres 18 SQL that the existing runner applies as one transaction, the five tables (`users`, `invites`, `sessions`, `listings`, `listing_photos`) exist with every column, default, constraint, and check specified in §4, and all mandated indexes are present (including a `pg_trgm` GIN index supporting the `ILIKE` search). The runner itself, `db.ts`, `package.json` scripts, and the `schema_migrations` table are already implemented and must be left working as-is.

CONSTRAINTS
  - "-- listing_photos  (max 5 per listing, enforced in app + check)" [§4 Data model — listing_photos] — owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)
  - "All `uuid pk` columns default to `gen_random_uuid()`." [§4 Data model] — owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)
  - Deliver ONLY the new file `src/server/migrations/0001_init.sql`. Do NOT modify `src/server/migrate.ts`, `src/server/db.ts`, `package.json`, `docker-compose.dev.yml`, `tsconfig.json`, `eslint.config.js`, or any route/auth/shared code — those belong to other steps.
  - Reproduce the §4 schema verbatim (table names, column names, types, defaults, nullability, FKs, cascade behavior, check constraints):
    - `users`: `id uuid pk default gen_random_uuid()`, `phone text unique not null` (E.164), `password_hash text not null`, `display_name text not null`, `role text not null default 'member'`, `is_banned boolean not null default false`, `invited_by uuid null references users(id)`, `created_at timestamptz not null default now()`.
    - `invites`: `id uuid pk`, `token text unique not null`, `created_by uuid not null references users(id)`, `used_by uuid null references users(id)`, `expires_at timestamptz not null`, `used_at timestamptz null`, `created_at timestamptz not null default now()`.
    - `sessions`: `id uuid pk`, `token_hash text unique not null`, `user_id uuid not null references users(id) on delete cascade`, `expires_at timestamptz not null`, `created_at timestamptz not null default now()`.
    - `listings`: `id uuid pk`, `seller_id uuid not null references users(id) on delete cascade`, `title text not null`, `description text not null`, `price_cents integer not null`, `generation text not null`, `part_type text not null`, `condition text not null`, `location text null`, `part_number text null`, `contact_note text null`, `status text not null default 'active'`, `created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()`.
    - `listing_photos`: `id uuid pk`, `listing_id uuid not null references listings(id) on delete cascade`, `position smallint not null check (position between 0 and 4)`, `content_type text not null default 'image/webp'`, `full_data bytea not null`, `thumb_data bytea not null`, `byte_size integer not null`, `created_at timestamptz not null default now()`, and a `unique (listing_id, position)` constraint.
  - `unique (listing_id, position)` on `listing_photos` MUST be a real unique constraint/index (named, e.g. `listing_photos_listing_position_key` or equivalent) so the runner and future position-compaction logic have a stable constraint to rely on. The ≤5/max-5-per-listing rule is enforced by the `position between 0 and 4` check plus this unique constraint; do not add a separate row-count trigger (the design says max 5 is "enforced in app + check").
  - All `uuid pk` columns MUST default to `gen_random_uuid()`. Ensure the `pgcrypto` extension is available (add `CREATE EXTENSION IF NOT EXISTS pgcrypto;` at the top of the migration) so `gen_random_uuid()` resolves on Postgres 18 regardless of the client.
  - Create exactly the §4-index list: `listings(status, created_at desc)`, `listings(generation)`, `listings(part_type)`, a `pg_trgm` GIN index on `(title || ' ' || description)` for `ILIKE` search, `sessions(token_hash)`, `invites(token)`. The trgm index MUST be `CREATE EXTENSION IF NOT EXISTS pg_trgm;` + `CREATE INDEX … ON listings USING gin ((title || ' ' || description) gin_trgm_ops);` (or `gin_trgm_ops` on the concatenated expression).
  - `updated_at` is set by the application on every UPDATE — do NOT create a trigger that maintains it.
  - Do NOT create the `schema_migrations` table in this file — the runner already creates it with `CREATE TABLE IF NOT EXISTS`. This file contains only the domain schema.
  - The file must apply as a single batch under `tx.unsafe(contents)` (Bun SQL) inside one transaction. This means: no `CREATE INDEX CONCURRENTLY` (not allowed in a transaction), no statements that require autocommit, and all object creation must be transaction-safe. Use `IF NOT EXISTS` where appropriate to keep re-runs idempotent even if the file is ever re-applied.
  - Do not invent columns, tables, or indexes beyond §4. In particular, do not add soft-delete flags, `email`, or any "request invitation" artifacts.
  - Do not create `seed` data, the admin user, or any `INSERT` — seeding is a later step (`src/server/seed.ts`, plan step 7).
  - Do not write a `test/*.test.ts` file that connects to the DB and asserts schema — the test-first cadence for "routes/components" does not apply to a pure migration file. The `test/setup.ts` preload already exists and is registered in `bunfig.toml`; it calls `runMigrate()` against `mx5_test` before any test file loads. Verification for this step is that the existing runner applies the file cleanly (see VERIFY).
  - Preserve every existing entry in `package.json` (scripts `dev`/`build`/`lint`/`migrate`/`seed`/`test`/`test:ct`, all dependencies, all devDependencies) — this task only adds a SQL file and changes no other file.

KNOWN-UNKNOWNS
  - The spec does not name the indexes; only their shape is given. Confirm whether to use the default Postgres naming convention (`<table>_<column>_idx`) or the default constraint-key naming (`listing_photos_listing_position_key`) for the `unique (listing_id, position)`. If left unspecified, the runner and future code will not reference these names, so either is safe; default to the Postgres conventional names.
  - The spec does not pin the exact `gin_trgm_ops` operator-class name beyond "pg_trgm GIN index on (title || ' ' || description) for ILIKE". Confirm whether the index should be on the raw concatenated expression `((title || ' ' || description))` or on a separate `search_text` column. The design implies a computed expression (no extra column is listed), so the index will be built on the expression; if a `search_text` column were desired it would appear in §4 — it does not.
  - The `invited_by uuid null references users(id)` and `invites.used_by uuid null references users(id)` are both self- / cross-FKs to `users`. Confirm no `on delete` action is needed on these two nullable FKs (the spec does not specify `on delete cascade` for them, so the Postgres default `NO ACTION` applies).
  - Confirm whether `generation`, `part_type`, `condition`, `status`, `role` should be Postgres `ENUM` types or plain `text` with application-level validation (the spec lists them as `text not null` with inline comment values, and the zod enums live in `src/shared/schema.ts`, so plain `text` is the intended choice).
  - Confirm the invite expiry of 14 days is enforced by the application at `POST /api/invites` (which computes `now() + interval '14 days'` at insert time) and NOT by a default in this migration — the spec lists `expires_at timestamptz not null` with no default, so the application sets it.

EXTERNAL-DEPENDENCIES
  - PostgreSQL 18  "pg_trgm extension GIN index gin_trgm_ops ILIKE expression index Postgres 18"
  - PostgreSQL 18  "pgcrypto extension gen_random_uuid() Postgres 18 CREATE EXTENSION"
  - Bun SQL  "Bun SQL import from bun tx.unsafe single transaction CREATE INDEX not concurrent"

ACCEPTANCE
  - `src/server/migrations/0001_init.sql` exists, is valid Postgres 18 SQL, begins with both `CREATE EXTENSION IF NOT EXISTS` guards (`pgcrypto`, `pg_trgm`), and uses `IF NOT EXISTS` on all `CREATE TABLE` / `CREATE INDEX` statements.
  - All five tables exist with the exact §4 column set, types, defaults, nullability, FKs (including the three `on delete cascade` FKs and the two plain nullable `users(id)` FKs), and the `check (position between 0 and 4)` plus the `unique (listing_id, position)` constraint.
  - All six indexes exist, including the GIN index on the exact expression `(title || ' ' || description)` with `gin_trgm_ops`.
  - `bun run migrate` (against the `mx5` dev DB, `DATABASE_URL=…/mx5`) applies `0001_init.sql` cleanly as a single transaction.
  - `bun test` exits 0. The `bunfig.toml` preload (`test/setup.ts`) sets `DATABASE_URL` to `mx5_test` and calls `runMigrate()`, which applies `0001_init.sql` on the fresh `mx5_test` database. No `*.test.ts` files exist yet, so no tests execute; the preload's successful migration is the meaningful check that the SQL file applies cleanly on a fresh database.
  - No other file is modified: `bunx tsc --noEmit`, `bun run lint`, and `bun run build` still pass unchanged.

VERIFY:
```sh
set -euo pipefail
docker compose -f docker-compose.dev.yml up -d
until docker compose -f docker-compose.dev.yml exec -T db pg_isready -q 2>/dev/null; do sleep 1; done
bun run migrate
docker compose -f docker-compose.dev.yml exec -T db psql -U postgres -d mx5 -tAc "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('users','invites','sessions','listings','listing_photos')" | grep -qx 5
docker compose -f docker-compose.dev.yml exec -T db psql -U postgres -d mx5 -tAc "SELECT count(*) FROM pg_extension WHERE extname IN ('pgcrypto','pg_trgm')" | grep -qx 2
docker compose -f docker-compose.dev.yml exec -T db psql -U postgres -d mx5 -tAc "SELECT count(*) FROM pg_indexes WHERE tablename='listings' AND indexdef ILIKE '%gin%' AND indexdef ILIKE '%gin_trgm_ops%' AND indexdef ILIKE '%title || %'" | grep -qx 1
docker compose -f docker-compose.dev.yml exec -T db psql -U postgres -d mx5 -tAc "SELECT count(*) FROM pg_constraint WHERE conname='listing_photos_listing_position_key' AND contype='u'" | grep -qx 1
docker compose -f docker-compose.dev.yml exec -T db psql -U postgres -d mx5 -tAc "SELECT count(*) FROM pg_constraint WHERE conname='listing_photos_position_check' AND contype='c'" | grep -qx 1
bun test
bunx tsc --noEmit
bun run lint
bun run build
```
<<<TASK_0040>>>
GOAL

Verify and finalize the admin-seed slice of the MX-5 Private marketplace per `DESIGN/PROJECT.md` §4: the `src/server/seed.ts` module, driven by the existing `seed` script (`"seed": "bun src/server/seed.ts"` in `package.json`), must create the single seeded root admin in the `users` table from the `ADMIN_PHONE` / `ADMIN_PASSWORD` environment variables (honoring the committed `.env` auto-loaded by Bun) only when no `users` row with `role = 'admin'` exists yet. The one code change required by the user's Q2 answer (option a) is in env-var reading: `seed()` must read `process.env.ADMIN_PHONE` / `process.env.ADMIN_PASSWORD` directly — dropping the `/proc/self/environ`-based `callerValue()` helper and its `node:fs/promises` import — so that a bare `bun seed` (no caller-provided vars) against the committed `.env` actually seeds the admin. Done looks like: `bun seed` against a migrated `mx5` database inserts exactly one row into `users` with `phone = '+37120000000'`, `password_hash` = an argon2id hash of the `.env` value (via `Bun.password.hash(pw, "argon2id")`, §6), `display_name = 'Admin'`, `role = 'admin'`, `invited_by = NULL`; a second run with an admin present is a no-op that changes nothing (same row count, same `password_hash`); and `test/seed.test.ts` (`bun test`) proves both the create and the idempotent no-op against `mx5_test` and stays green.

CONSTRAINTS

- Preserve the existing `package.json` scripts exactly: `"seed": "bun src/server/seed.ts"`, `"migrate": "bun src/server/migrate.ts"`, and the unchanged `test` / `lint` scripts; do not add, rename, or remove any script, dependency, devDependency, or field.
- `src/server/seed.ts` stays at that path (design §3 repo layout: `seed.ts # admin seeding`) and exports a callable `seed()` (tests import it as `import {seed} from '../src/server/seed'`); side effects run only under the `if (import.meta.main) await seed()` guard, never on import.
- Per Q2 answer (a): `seed()` reads `process.env.ADMIN_PHONE` / `process.env.ADMIN_PASSWORD` directly (both in the function and via the main-module path), honoring Bun's auto-loaded committed `.env`, so a bare `bun seed` seeds the admin. Delete the `/proc/self/environ` caller-env helper (`callerValue`) and its `node:fs/promises` (`readFile`) import entirely — no dangling unused imports. Tests still pass because they call `seed()` as a function after setting `process.env`.
- Per Q1 answer: presence-only validation — `ADMIN_PASSWORD` must be non-empty; do NOT import or enforce `passwordSchema` (min 8 / max 200) or `phoneSchema` from `src/shared/schema.ts` in the seed. The phone string is stored verbatim. If `ADMIN_PHONE` or `ADMIN_PASSWORD` is missing or empty, `seed()` throws a clear error (`Missing required environment variable(s): …`) and inserts nothing.
- Password hashing must be argon2id via the built-in `Bun.password.hash(pw, "argon2id")` (§6) — never plaintext, never another KDF, no new dependency.
- Idempotency is keyed on ROLE, not phone: seed only when no `users` row with `role = 'admin'` exists. A non-admin user who happens to hold `ADMIN_PHONE` must NOT suppress seeding; the unique `phone` constraint is the backstop. Do not change the existence check to a phone lookup.
- The seeded admin row writes exactly `phone`, `password_hash`, `display_name`, `role = 'admin'`, `invited_by = NULL`; all other `users` columns take schema defaults (`is_banned = false`, `created_at = now()`, `id` via `gen_random_uuid()`). `display_name` is the non-null literal `'Admin'`, coupled to the test assertion — keep both in sync. Use the `users` column names exactly as in `0001_init.sql` / §4 (`id, phone, password_hash, display_name, role, is_banned, invited_by, created_at`).
- Use the shared Bun SQL client from `src/server/db.ts` (`import {sql} from './db'`) with tagged-template, bound-parameter queries only — no string interpolation of values into SQL (§11).
- Do not create or alter the `users` table, any migration file, `migrate.ts`, or `test/setup.ts` — schema and migration runner are owned by other steps. The seed assumes an already-migrated database (no auto-migrate; the contract is "run `bun migrate` first" — `migrate` and `seed` are separate scripts).
- Do not touch any route, page, component, schema, or other module outside this slice: no `src/server/routes/*`, no `src/client/*`, no `src/shared/schema.ts` changes, no new endpoint, no `AppType` change, no new table/column.
- The test is a `bun test` file `test/seed.test.ts` (`*.test.ts` under `test/`) targeting the separate `mx5_test` database via the existing harness (`bunfig.toml` preloads `test/setup.ts`, which rewrites `DATABASE_URL` `/mx5` → `/mx5_test` and migrates). Reuse its established isolation pattern (per-file `truncateBeforeFile()` from `test/setup.ts`, or its own scoped DELETE of admin/test rows as the existing file does) so it is deterministic. The test lands in the same change (§10 cadence) and is not done until it passes. The `test` script in `package.json` remains unchanged and green.
- Keep code conformant to the pinned tooling: Prettier (`.prettierrc.cjs` — spaces, tabWidth 4, no semicolons, single quotes), ESLint flat config (`no-explicit-any: error`), and the strict `tsconfig.json` (`strict`, `noUncheckedIndexedAccess`, `noUnusedLocals/Parameters`, `verbatimModuleSyntax`). `bun run lint` (prettier + eslint + `tsc --noEmit`) must pass with no errors.
- Where `src/server/seed.ts` and `test/seed.test.ts` already exist on disk, this is an in-place update/verification that preserves every existing dependency, script, and field — do not recreate, empty, or reduce them.

ACCEPTANCE

- A bare `bun seed` (no caller-provided vars; committed `.env` supplying `ADMIN_PHONE=+37120000000` / `ADMIN_PASSWORD=local-dev-only`) against a migrated `mx5` database exits 0 and inserts exactly one `users` row: `phone = '+37120000000'`, `role = 'admin'`, `display_name = 'Admin'`, `invited_by IS NULL`, `is_banned = false`, and `password_hash` is an argon2id hash (`$argon2id$`-prefixed) that `Bun.password.verify('local-dev-only', password_hash)` accepts.
- Running `bun seed` a second time with the admin already present exits 0, changes nothing: same admin row count (1) and byte-identical `password_hash`.
- `seed()` reads `process.env` directly — no `/proc/self/environ` read, no `callerValue` helper, no `node:fs/promises` import — so env vars from the committed `.env` (Bun auto-load) or the caller are both honored.
- Missing or empty `ADMIN_PHONE` / `ADMIN_PASSWORD` makes `seed()` throw `Missing required environment variable(s): …` and insert nothing.
- `bun test` passes, including both tests in `test/seed.test.ts` (create-with-verify and idempotent no-op) against `mx5_test`.
- `bun run lint` (prettier --write, eslint --fix, `tsc --noEmit` under the strict tsconfig) exits 0 with no errors.
- `package.json` scripts/dependencies, `migrate.ts`, migrations, `test/setup.ts`, and `src/shared/schema.ts` are untouched; the only changed files are `src/server/seed.ts` (and `test/seed.test.ts` if its assertions must be kept in sync).

VERIFY:
```sh
set -euo pipefail

# 1. Bring up the dev Postgres (docker-compose.dev.yml → container mx5-dev-db,
#    user postgres, databases mx5 + mx5_test) and wait for readiness.
docker compose -f docker-compose.dev.yml up -d
until pg_isready -h localhost -p 5432 -U postgres >/dev/null 2>&1; do sleep 1; done

# 2. Deterministic starting point for the mx5 dev DB.
docker exec mx5-dev-db psql -U postgres -d mx5 -c "DELETE FROM users WHERE role = 'admin' OR phone = '+37120000000'"

# 3. Migrate, then bare `bun seed` — no caller-provided vars, committed .env only
#    (this is the Q2(a) behavior: process.env must be read directly).
bun run migrate
bun seed

# 4. Assert exactly one admin row with the expected values and an argon2id hash.
[ "$(docker exec mx5-dev-db psql -U postgres -d mx5 -tAc "SELECT count(*) FROM users WHERE phone = '+37120000000' AND role = 'admin' AND display_name = 'Admin' AND invited_by IS NULL AND is_banned = false")" = "1" ]
docker exec mx5-dev-db psql -U postgres -d mx5 -tAc "SELECT password_hash FROM users WHERE role = 'admin'" | grep -q '^\$argon2id\$'

# 5. Idempotency: second bare run exits 0, same hash, still exactly one admin.
HASH_BEFORE=$(docker exec mx5-dev-db psql -U postgres -d mx5 -tAc "SELECT password_hash FROM users WHERE role = 'admin'")
bun seed
HASH_AFTER=$(docker exec mx5-dev-db psql -U postgres -d mx5 -tAc "SELECT password_hash FROM users WHERE role = 'admin'")
[ "$HASH_BEFORE" = "$HASH_AFTER" ]
[ "$(docker exec mx5-dev-db psql -U postgres -d mx5 -tAc "SELECT count(*) FROM users WHERE role = 'admin'")" = "1" ]

# 6. Restore the deterministic starting state for the next run.
docker exec mx5-dev-db psql -U postgres -d mx5 -c "DELETE FROM users WHERE role = 'admin' OR phone = '+37120000000'"

# 7. Test suite (routes/API) + typecheck/lint, per package.json scripts.
bun test
bun run lint
```
<<<TASK_0041>>>
GOAL
Confirm and finalize the shared zod schema slice `src/shared/schema.ts` plus its DB-free test `test/schema.test.ts` — the single source of truth for input validation shared by the Hono server and the React client (`DESIGN/PROJECT.md` §5: "Field limits (title/description length, price bounds, phone format) live in `src/shared/schema.ts`"). This is an in-place update/finalization of files that already exist on disk and already contain the full pinned contract: the field-limit constants, E.164 phone normalization via `z.preprocess`, the §4 enums, the §1 listing input shape, the §5 auth payloads, and the inferred-type exports. The slice must (a) match `DESIGN/PROJECT.md` §1/§4/§5/§6 exactly at its boundary (export names, constant values, enum values, normalization behavior), (b) be covered by passing `bun test` cases in `test/schema.test.ts`, and (c) be individually clean under prettier + eslint + `tsc --noEmit` for the two in-scope files. Do not rebuild, rename, or reshape any export or type that out-of-scope consumers already import by name — those names are the shared seam; renaming or reshaping one is a seam bug.

CONSTRAINTS
  - "EUR (`€`). Phone numbers international, stored E.164. UI in English." [§1 Decisions — Region / currency] — owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)
  - "Field limits (title/description length, price bounds, phone format) live in `src/shared/schema.ts`." [§5 API] — owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)
  - "Title, description, price, generation (NA/NB/NC/ND), type (OEM/Aftermarket), condition (New/Used), **location**, **OEM part number**, optional contact note, up to 5 photos." [§1 Decisions — Listing fields] — owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)
- In-scope files are ONLY `src/shared/schema.ts` and `test/schema.test.ts`. Do NOT touch `src/server/**` (routes, `index.ts`, `db.ts`, `migrate.ts`, `seed.ts`), `src/client/**` (`main.tsx`, `api.ts`, pages, components), `build.ts`, or any `package.json` / `tsconfig.json` / `eslint.config.js` / `.prettierrc.cjs` edit. Per the Q&A: do not edit `src/client/api.ts` even though its `// @ts-expect-error` suppressions make the repo-wide `bun run lint` gate (its `tsc --noEmit` leg) fail; that failure is pre-existing and out of scope — report it, do not fix it.
- The boundary of this slice is the set of exports in `src/shared/schema.ts`. Preserve **every** existing export, constant, and inferred type exactly as named. The pinned set (all present on disk — do not add, remove, rename, or reshape any of them) is:
  - constants: `TITLE_MAX_LENGTH=200`, `DESCRIPTION_MAX_LENGTH=2000`, `LOCATION_MAX_LENGTH=200`, `PART_NUMBER_MAX_LENGTH=64`, `CONTACT_NOTE_MAX_LENGTH=500`, `DISPLAY_NAME_MAX_LENGTH=50`, `PASSWORD_MIN_LENGTH=8`, `PASSWORD_MAX_LENGTH=200`, `PRICE_CENTS_MIN=1`, `PRICE_CENTS_MAX=99_999_999` (fits Postgres `integer not null`);
  - schemas: `phoneSchema`, `titleSchema`, `descriptionSchema`, `priceCentsSchema`, `GENERATION_VALUES`/`generationSchema`, `PART_TYPE_VALUES`/`partTypeSchema`, `CONDITION_VALUES`/`conditionSchema`, `locationSchema`, `partNumberSchema`, `contactNoteSchema`, `listingInputSchema`, `displayNameSchema`, `passwordSchema`, `loginPayloadSchema`, `inviteRedeemPayloadSchema`;
  - types: `PhoneInput`/`Phone` (the `z.input`/`z.infer` split for the transformed phone field), the scalar aliases `Title`/`Description`/`PriceCents`/`Generation`/`PartType`/`Condition`/`Location`/`PartNumber`/`ContactNote`, `ListingInput`, `DisplayName`/`Password`, `LoginPayloadInput`/`LoginPayload`, `InviteRedeemPayloadInput`/`InviteRedeemPayload`.
  These are the shared seam §5 pins on this one file — the server validates through them (`@hono/zod-validator`) and the client derives its types from them, so any rename/reshape propagates as a seam bug. (Do not add new exports to "help" the client or a future route — keep the set exactly as it is.)
- Keep `GENERATION_VALUES`/`PART_TYPE_VALUES`/`CONDITION_VALUES` as `as const` readonly literal tuples — `z.enum` requires a readonly non-empty tuple; changing them to plain `string[]` breaks both `z.enum` usage and the `listings` route that re-uses them for its query enums.
- Enum values must match §4 exactly: generation `na|nb|nc|nd`; part_type `oem|aftermarket`; condition `new|used`.
- Price is `price_cents`, integer EUR minor units, bounds 1–99_999_999 to fit the Postgres `price_cents integer not null` column (§4). Preserve the integer-cents semantics (`.int()` + `.min()`/`.max()`); do not widen to a float or loosen the bounds.
- `phoneSchema` must remain a `z.preprocess` that strips whitespace, ASCII hyphens, and en dashes, then validates `/^\+[1-9]\d{6,14}$/`, so the output is the normalized E.164 string and both client and server share the normalization (§6: "server strips spaces/dashes and validates … before lookup/insert, so login can't fail on formatting"). Do not rewrite it preemptively — the on-disk tests plus `tsc --noEmit` are the ground truth for its current behavior.
- Per §1: phone is international and stored E.164; EUR is the currency; listing input carries `title`, `description`, `price_cents`, `generation`, `part_type`, `condition`, `location` (nullable), `part_number` (nullable), `contact_note` (nullable). The ≤5-photos cap is enforced in the photo upload route, NOT this schema — do not add a photo count here.
- Per §5: the login payload is `{ phone, password }` and the invite redeem payload is `{ phone, password, display_name }` — keep those exact shapes/keys.
- The nullable listing fields stay `z.string().max(...).nullish()` (omitted key, `null`, or a string are all accepted).
- Do NOT add a `listingsQuerySchema` or `sort`/`gen`/`type`/`cond` helpers to the shared schema — the grid query schema is route-local in `src/server/routes/listings.ts` (settled in-repo, out of scope), and the §1 "Badges (OEM/New) derived from type/condition" helper is a client-side concern not pinned to this file.
- Password 8–200 and display-name max 50 are the values the design pins (no other values exist in `DESIGN/PROJECT.md`) — keep them as-is.
- `test/schema.test.ts` must stay DB-free pure `bun:test` `safeParse` assertions (no `app.request()`, no truncate hook, no `sql` import), deterministic and self-contained. Every schema export and constant above must have at least one passing case.
- Style: satisfy `.prettierrc.cjs` (no semicolons, single quotes, `tabWidth` 4, `printWidth` 120, `bracketSpacing: false`, `arrowParens: 'avoid'`, `trailingComma: 'none'`) and the strict `tsconfig.json` (`verbatimModuleSyntax`, `noUncheckedIndexedAccess`, `noUnusedLocals`/`noUnusedParameters`).
- Do not bump or edit any dependency/version pin in `package.json` (zod 4.4.3 / `@hono/zod-validator` 0.8.0 stay as-is).
- Note for the receiver: even `bun test test/schema.test.ts` triggers the `bunfig.toml` `[test] preload` (`test/setup.ts`), which rewrites `DATABASE_URL` to `mx5_test` and runs `runMigrate()` — so a docker-compose Postgres **must be up before running any `bun test`**, including this pure-schema test.

ACCEPTANCE
- `src/shared/schema.ts` exports the full §1/§4/§5/§6-pinned contract with the exact field limits (title ≤200, description ≤2000, location ≤200, part_number ≤64, contact_note ≤500, display_name ≤50, password 8–200, price_cents 1–99_999_999 integer), E.164 phone normalization (strip spaces/hyphens/en dashes then `/^\+[1-9]\d{6,14}$/`), enums `na|nb|nc|nd` / `oem|aftermarket` / `new|used`, and all inferred-type exports intact and correctly named — i.e. the export set is byte-identical in name to the pinned list above.
- Every schema export and constant is covered by at least one passing `bun test` case in `test/schema.test.ts`, and `bun test test/schema.test.ts` passes in full.
- The two in-scope files are individually clean — measured deterministically as:
  1. `prettier --check src/shared/schema.ts test/schema.test.ts` exits 0 (both files already formatted);
  2. `eslint src/shared/schema.ts test/schema.test.ts` reports zero diagnostics for those two files;
  3. `tsc --noEmit 2>&1` produces **no** diagnostic whose file path starts with `src/shared/schema.ts` or `test/schema.test.ts`.
  Because the repo has a single `tsconfig.json` (no per-file scoping) and the lint tools compile the whole graph, "individually clean" means *filtering the whole-project diagnostic output by these two file prefixes* — it does NOT mean these two files compile or lint in isolation. That is the only well-defined, reproducible reading.
- The repo-wide `bun run lint` failure — rooted in the out-of-scope `// @ts-expect-error` suppressions in `src/client/api.ts` under TS 6 + hono `hc<AppType>` collapse — is reported as a **pre-existing, out-of-scope blocker** (not fixed, not introduced by this change), and no diagnostic attributable to `src/shared/schema.ts` or `test/schema.test.ts` appears in it.

VERIFY:
```sh
set -euo pipefail
cd /workspace

# --- Postgres (hard dependency: bunfig.toml [test] preload runs runMigrate() before any bun test) ---
docker compose -f docker-compose.dev.yml up -d
# wait until mx5 (and the preload-rewritten mx5_test) are reachable
for i in $(seq 1 60); do
  if docker exec mx5-dev-db pg_isready -q; then break; fi
  sleep 1
done
docker exec mx5-dev-db pg_isready -q

# --- 1. Schema tests: pure safeParse assertions of the exact contract (still need the preload's Postgres) ---
bun test test/schema.test.ts

# --- 2. Individually-clean gate for the two in-scope files (deterministic file-prefix checks) ---
# (a) formatting
prettier --check src/shared/schema.ts test/schema.test.ts
# (b) eslint — must report zero diagnostics on these two files
if [ "$(npx eslint src/shared/schema.ts test/schema.test.ts 2>&1 | grep -cE 'error|warning')" -gt 0 ]; then
  echo 'FAIL: eslint reported diagnostics for src/shared/schema.ts or test/schema.test.ts'
  npx eslint src/shared/schema.ts test/schema.test.ts 2>&1 || true
  exit 1
fi
# (c) tsc --noEmit compiles the whole graph (single tsconfig, no per-file scope) — assert NO
#     diagnostic is attributable to the two in-scope files. Pre-existing out-of-scope errors
#     (e.g. src/client/api.ts) are filtered OUT here and reported separately below.
if npx tsc --noEmit 2>&1 | grep -E '^\s*(src/shared/schema\.ts|test/schema\.test\.ts)(\(|:)' ; then
  echo 'FAIL: tsc reported diagnostics attributable to the in-scope files'
  exit 1
fi

# --- 3. Repo-wide lint gate: expected to FAIL pre-existing on out-of-scope src/client/api.ts ---
# Run it, capture exit + output. We assert (i) it fails, (ii) it fails ONLY on out-of-scope files,
# (iii) none of the failures are attributable to the two in-scope files.
set +e
REPO_LINT_OUT="$(npx prettier --log-level warn --check --no-error-on-unmatched-pattern 'src/**/*.{ts,tsx}' 'test/**/*.{ts,tsx}' 2>&1; npx eslint . 2>&1; npx tsc --noEmit 2>&1)"
REPO_LINT_STATUS=$?
set -e
# in-scope files must be clean in the repo-wide output (the real gate)
if printf '%s' "$REPO_LINT_OUT" | grep -E '(src/shared/schema\.ts|test/schema\.test\.ts)' ; then
  echo 'FAIL: repo-wide lint output attributes a diagnostic to an in-scope file'
  exit 1
fi
# the gate must still fail, and only because of pre-existing out-of-scope noise (src/client/api.ts @ts-expect-error / TS6+hono)
if [ "$REPO_LINT_STATUS" -eq 0 ]; then
  echo 'unexpected: repo-wide lint passed; the pre-existing out-of-scope blocker is gone'
fi
if printf '%s' "$REPO_LINT_OUT" | grep -qE 'src/client/api\.ts'; then
  echo 'OK: repo-wide lint failure is the pre-existing, out-of-scope src/client/api.ts blocker (reported, not fixed).'
else
  echo 'NOTE: repo-wide lint failed but not on src/client/api.ts; inspect output for any in-scope impact before closing.'
fi
```
<<<TASK_0042>>>
GOAL
Complete step 9's test-harness leg of the mx5-private repo. The frozen plumbing — `test/setup.ts` (DATABASE_URL `/mx5`→`/mx5_test` rewrite + one-shot `runMigrate()` + exported `truncateBeforeFile()`), `bunfig.toml` (`[test] preload = ["./test/setup.ts"]`), `docker-compose.dev.yml` (already mounts `./docker-entrypoint-initdb.d`), and the `package.json` `test`/`test:ct` scripts — already exists and must be preserved verbatim and built upon, not rewritten. Author the five missing pieces: (1) the Postgres init script `docker-entrypoint-initdb.d/10-create-mx5-test.sh` that creates the dedicated `mx5_test` database (without it the compose mount is empty and `mx5_test` never exists); (2) the root-level Playwright React CT config `playwright-ct.config.ts` (the file whose existence enables the frozen `test` script's `[ -f playwright-ct.config.ts ]` Playwright leg and the `test:ct` script) with a CT template and a `__screenshots__/` baseline committed under the repo; (3) a minimal `test/harness-smoke.test.ts` API test that imports `app` from `src/server/index.ts`, calls `app.request('/api/auth/me')` and asserts the 401 (proving the `app.request` harness + DB harness + per-file truncate hook all work end-to-end); (4) a minimal `test/ct/demo.spec.tsx` component spec that mounts a trivial branded inline element and captures a committed `toHaveScreenshot` baseline; and (5) the one `tsconfig.json` `include` addition so `tsc --noEmit` type-checks the new root-level config. Done = `bun test` passes green against a freshly-created, migrated `mx5_test` database, and `bun test:ct` passes with the committed baseline present (no `--update-snapshots` needed on a clean checkout).

CONSTRAINTS
  - "**Route/API:** `bun test` + `hono` `app.request()` (see hono.dev testing guide)." [§2 Tech stack — Testing] — owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)
- Preserve `test/setup.ts` verbatim — its DATABASE_URL rewrite (`/mx5` → `/mx5_test`), one-shot `runMigrate()`, and the exported `truncateBeforeFile()` (FK-aware `TRUNCATE listing_photos, listings, invites, sessions, users CASCADE`) are the isolation contract; do not change the truncate statement or add `schema_migrations` to it.
- Preserve `bunfig.toml` verbatim (`[test] preload = ["./test/setup.ts"]`).
- Preserve `docker-compose.dev.yml` verbatim — it already mounts `./docker-entrypoint-initdb.d:/docker-entrypoint-initdb.d:ro`; only the init-script file is missing and must be added. The init script is `docker-entrypoint-initdb.d/10-create-mx5-test.sh` and needs nothing beyond `set -e` + `createdb -O postgres mx5_test`: `0001_init.sql` runs `CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS pg_trgm;` inside `mx5_test` via `runMigrate()`, so the init script must NOT create extensions.
- Preserve the existing `package.json` `test` and `test:ct` scripts and all dependency entries verbatim — do not add, rename, or reshape any script, and do not touch any dependency (`@playwright/experimental-ct-react` is already pinned at exactly 1.61.1). The `test` script's `[ -f playwright-ct.config.ts ]` guard means the config file you create is what enables the Playwright leg; the `test` and `test:ct` scripts both resolve that exact repo-root path.
- The API smoke test is `test/harness-smoke.test.ts` (a deliverable of this step, not a pre-existing file). It MUST use `app.request(...)` (per the hono.dev testing guide) against the exported `app` from `src/server/index.ts` — no `Bun.serve`, no supertest, no fetch-against-a-live-port. It MUST call `truncateBeforeFile()` from `test/setup.ts` in its own file scope (the documented per-file isolation contract). The `auth` route module is implemented in the current `src/server/index.ts` chain, so `app.request('/api/auth/me', {method: 'GET'})` is a real, working route: assert status `401` and body `{message: 'Unauthorized'}`. A fallback exists only if, at the time this step runs, the `auth` module is absent from the chain — in that case target whichever `GET` route exists today, and if none does, assert the SPA-fallback behavior for an unknown non-`/api` GET (per the design's "non-`/api` GETs serve the built `index.html`" contract). Do not replace the smoke test's 401 assertion with the fallback unless the `auth` module is genuinely unimplemented.
- `playwright-ct.config.ts` MUST be placed at the repo root, MUST import `defineConfig` (and `devices` if used) from `@playwright/experimental-ct-react` (never plain `playwright` — the CT `defineConfig` wrapper pins `registerSourceFile` + `@vitejs/plugin-react`), and MUST be a default export of `defineConfig(...)`.
- Use the config key `snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}'` (the user's A1 answer plus the installed 1.61.1 types: there is NO `snapshotDir`-based key in the installed types — `snapshotDir` only sets the default `{snapshotDir}` token value and cannot produce a `__screenshots__/` tree; `node_modules/@playwright/experimental-ct-core/index.d.ts` exposes only `snapshotPathTemplate` / `expect.toHaveScreenshot.pathTemplate`). Baselines must land under `test/ct/__screenshots__/` (i.e. `{testDir}/__screenshots__/...`) and that path must NOT be gitignored (`.gitignore` has no screenshot entry — do not add one).
- The CT config MUST set `testDir: 'test/ct'` so `bun test` (project-wide scan) and Playwright have disjoint file sets, and the CT spec MUST be named `demo.spec.tsx` (Playwright's default `testMatch` is `**/*.@(spec|test).?(c|m)[jt]s?(x)`; bun test discovers `*.test.ts` — keep the CT spec out of the API suite's pattern space). If `bun test` on this snapshot still picks up `test/ct/demo.spec.tsx` and fails on the Playwright import, the only remaining lever (bunfig.toml/package.json are frozen) is renaming within `test/ct/` plus a matching `testMatch` in the config — but prefer `.spec.tsx` first and verify empirically.
- The CT config MUST set `use: { ctPort: 3100, ctTemplateDir: 'test/ct/template' }` and a single chromium project (e.g. `{ name: 'chromium', use: {...devices['Desktop Chrome']} }`). Per the installed 1.61.1 API surface there is NO `ctTemplate` option (only `ctPort`, `ctTemplateDir`, `ctCacheDir`, `ctViteConfig`); the template dir (default `playwright` relative to the config dir) MUST contain an `index.html` with a `<div id="root">` element, which `mount` mounts into via `document.getElementById("root")`.
- The CT template MUST be `test/ct/template/index.html` (minimal document with `<div id="root"></div>` and a `<script type="module" src="/index.tsx"></script>` tag) plus `test/ct/template/index.tsx` (the CT setup entry — auto-wired with `__pwRegistry.initialize(...)` by the framework; an empty export is fine). Do not import `src/client/index.css` in the template or spec: it does `@import "tailwindcss"` (Tailwind v4 CLI build) and would make the baseline machine/build-dependent.
- The demo CT spec MUST import `{ test, expect }` from `@playwright/experimental-ct-react`, use the `mount` fixture with a plain inline JSX literal (no component files, no imports from `src/`, no `PartCard`/`Nav`/page imports), inline the brand tokens as inline styles from `DESIGN/brand-spec.md` (e.g. background `oklch(14% 0.008 260)`, foreground `oklch(92% 0.006 260)`, Soul Red accent `oklch(52% 0.22 25)`), and assert `await expect(component).toHaveScreenshot('demo.png')` (the single-argument form; the config-level `snapshotPathTemplate` places it — do not pass a `pathTemplate` per-assertion).
- The committed baseline MUST be generated by one real run (`npx playwright install chromium` then `bun run test:ct`) and then committed — the first `bun run test:ct` on a clean checkout must pass without `--update-snapshots`. Confirm during that run that the PNG actually lands under `test/ct/__screenshots__/` (the empirical confirmation the A1 answer mandates).
- `tsconfig.json` `include` currently lists `["src", "test", "build.ts", "playwright.config.ts", "eslint.config.js"]` — the root-level `playwright-ct.config.ts` matches no entry, so ADD `"playwright-ct.config.ts"` to `include` (this is the one allowed change to a preserved-looking file; the eslint `parserOptions.projectService: true` type-aware linting also requires the file be inside the tsconfig project).
- No `any` (ESLint `no-explicit-any` is error) and no unused locals/params in any new file; `test/ct/*.tsx` gets the full `recommendedTypeChecked` rules (the eslint test-relaxation block matches `test/**/*.ts` only, not `*.tsx`); new `.ts`/`.tsx` files must pass the existing `lint` script (prettier: 4-space indent, no semis, single quotes, printWidth 120).
- Do not create or modify any route, page, component, schema, or module owned by steps 10–33. Do not touch `src/server/db.ts`, `src/server/migrate.ts`, `src/server/auth.ts`, `src/shared/schema.ts`, `src/server/index.ts`, or any existing migration. The test-first cadence (a test lands in the same change as each route/component) binds the OTHER steps; this step only establishes the harness plus the two demo specs.
- `AGENT=1` is set by the frozen `test` script; nothing in `src/` reads it (zero grep matches), so no interactive-input compatibility work is needed — just do not add any.
- The `test` script runs bare `bun test` (project-wide scan); `test/ct/` files must not be importable/runnable as bun:test files (no `bun:test` imports, Playwright-only imports are correct).

ACCEPTANCE
- The four deliverable files exist on disk: `docker-entrypoint-initdb.d/10-create-mx5-test.sh`, `playwright-ct.config.ts`, `test/harness-smoke.test.ts`, and the CT template + spec + baseline under `test/ct/` (`test/ct/template/index.html`, `test/ct/template/index.tsx`, `test/ct/demo.spec.tsx`, and a `*.png` baseline under `test/ct/__screenshots__/`).
- The five frozen files are unchanged from their pre-task state: `test/setup.ts`, `bunfig.toml`, `docker-compose.dev.yml`, and both `package.json` scripts/dependencies are byte-identical to how they were before this step.
- `bun test` passes green: the API suite (the `test/harness-smoke.test.ts` 401 `app.request('/api/auth/me')` assertion plus its table/`schema_migrations` checks) runs against a migrated, per-file-truncated `mx5_test` database, and `test/ct/` files are not picked up by bun test.
- `bun run test:ct` passes on a clean checkout with the committed baseline: the demo spec mounts the inline branded element and `toHaveScreenshot` matches the committed PNG under `test/ct/__screenshots__/` without `--update-snapshots`.
- `playwright-ct.config.ts` exists at the repo root, imports `defineConfig` from `@playwright/experimental-ct-react`, sets `testDir: 'test/ct'`, `use.ctTemplateDir: 'test/ct/template'`, a single chromium project, and top-level `snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}'`.
- `test/ct/template/index.html` contains a `<div id="root">` and loads `/index.tsx`; `test/ct/template/index.tsx` exists as the CT setup entry.
- `test/ct/demo.spec.tsx` imports `{ test, expect }` from `@playwright/experimental-ct-react`, mounts a plain inline JSX literal styled with inlined `DESIGN/brand-spec.md` oklch tokens (no `src/` imports, no Tailwind), and asserts `toHaveScreenshot('demo.png')`.
- The generated baseline PNG exists on disk under `test/ct/__screenshots__/` and is not gitignored.
- `tsconfig.json` `include` lists `playwright-ct.config.ts`; `tsc --noEmit` exits 0; `bun run lint` exits 0 (prettier formatting + eslint type-checked rules + tsc).

VERIFY:
```sh
set -e
cd "$(git rev-parse --show-toplevel)"

# --- Deliverable files this step must author (existence, not a diff vs an unknown pre-state) ---
test -f docker-entrypoint-initdb.d/10-create-mx5-test.sh
test -f playwright-ct.config.ts
test -f test/harness-smoke.test.ts
test -f test/ct/template/index.html
test -f test/ct/template/index.tsx
test -f test/ct/demo.spec.tsx
test -f tsconfig.json

# --- Frozen plumbing preserved verbatim (this task's premise: build upon, do not rewrite) ---
# These five files existed before this step; a quiet diff against HEAD proves the agent did not touch them.
git diff --quiet -- test/setup.ts bunfig.toml docker-compose.dev.yml
git diff --quiet -- package.json
# The init script and smoke test are NEW this step: assert their presence only (no pre-state to diff against).
git status --porcelain -- docker-entrypoint-initdb.d/10-create-mx5-test.sh | grep -q . || true
git status --porcelain -- test/harness-smoke.test.ts | grep -q . || true

# --- CT config: pinned wiring + config-key choice (top-level snapshotPathTemplate, no invented ctTemplate) ---
grep -q "snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}'" playwright-ct.config.ts
grep -q "defineConfig" playwright-ct.config.ts && grep -q "@playwright/experimental-ct-react" playwright-ct.config.ts
grep -q "testDir: 'test/ct'" playwright-ct.config.ts && grep -q "ctTemplateDir: 'test/ct/template'" playwright-ct.config.ts

# --- tsconfig include gained the new root-level config ---
grep -q '"playwright-ct.config.ts"' tsconfig.json

# --- CT template: #root element required by mount(), index.tsx entry wired via script tag ---
grep -q 'id="root"' test/ct/template/index.html && grep -q 'src="/index.tsx"' test/ct/template/index.html

# --- Demo spec: imports from the CT package, uses mount + toHaveScreenshot, no src/ imports, named .spec.tsx ---
grep -q "from '@playwright/experimental-ct-react'" test/ct/demo.spec.tsx
grep -q "mount(" test/ct/demo.spec.tsx && grep -q "toHaveScreenshot(" test/ct/demo.spec.tsx
! grep -q "from '.*src/" test/ct/demo.spec.tsx

# --- Lint + typecheck across all new files (prettier + eslint type-checked + tsc) ---
bun run lint

# --- Start a fresh DB stack (init script runs only on first init of an empty volume;
#     a pre-existing mx5_db_data volume on this machine would need a one-time down -v) ---
docker compose -f docker-compose.dev.yml up -d
for i in $(seq 1 60); do docker compose -f docker-compose.dev.yml exec -T db pg_isready -U postgres && break; sleep 1; done
docker compose -f docker-compose.dev.yml exec -T db psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'mx5_test'" | grep -q 1

# --- API leg: full bun test (harness smoke against mx5_test + confirms test/ct not run as API tests) ---
AGENT=1 bun test

# --- CT leg: ensure chromium is installed (idempotent), then run against the committed baseline ---
npx playwright install chromium
bun run test:ct

# --- Baseline PNG committed under __screenshots__/ and not gitignored ---
find test/ct/__screenshots__ -name "*.png" | grep -q .
! git check-ignore -q test/ct/__screenshots__
```
<<<TASK_0043>>>
GOAL
Update the existing `src/server/index.ts` in place so the Hono app shell fully wires the app for production serving, while keeping the current chained-route structure and the five existing route mounts (`./routes/auth`, `./routes/invites`, `./routes/listings`, `./routes/photos`, `./routes/admin`) intact, and **create the root `index.html`** (no repo `index.html` exists yet) as the minimal branded shell the build copies to `dist/index.html` and the SPA fallback serves. Concretely: (1) keep `export const app = new Hono()...` as a single chained Hono app that mounts the five route sub-apps via `.route('/', x.app)` in their current order (auth, invites, listings, photos, admin), and keep `export type AppType = typeof app`; (2) add static `dist/` serving using Hono's built-in `serveStatic` from `hono/bun`, wired as the final catch-all in the chain so real built assets (e.g. `/app.css`, the JS chunk(s) Bun emits) are served; (3) add a **SPA fallback** so that non-`/api` GETs that do not match a real static file serve the built `dist/index.html`, using `serveStatic`'s `onNotFound` callback (real files win automatically; the fallback fires only for missing files) and restricted so requests under `/api` keep flowing to the API routes / Hono 404; (4) **create the root `index.html`** — a minimal branded HTML document carrying `<title>MX-5 Private</title>`, the viewport meta the mockups carry, a small inline `<style>` that sets a dark brand `--bg` background and a light `--fg` text color on `html, body` (so pre-hydration paint is dark, matching DESIGN/brand-spec.md and `src/client/index.css`), plus a `<div id="root"></div>` mount point that `src/client/main.tsx` uses. Done looks like: `bun run src/server/index.ts` serves the `/api` routes, the `dist/` static files, and falls back non-`/api` GETs to the built `dist/index.html`, with a passing `AGENT=1 bun test` covering these shell behaviors.

CONSTRAINTS
  - "Bodies validated with `@hono/zod-validator` + shared zod schemas." [§5 API] — owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)
  - "**Server:** `bun run --watch src/server/index.ts` — serves `/api` + static `dist/`." [§9 Build & run] — owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)
- This is an **in-place UPDATE** of the existing `src/server/index.ts`; preserve its current behavior — the `new Hono()` chain, the five `.route('/', ...)` mounts in order (auth, invites, listings, photos, admin), and `export type AppType = typeof app`. Do not rename, re-shape, or reorder the route mounts. Do not change the public `app`/`AppType` export surface that `src/client/api.ts` (step 23, `hc<AppType>`) depends on.
- Use `serveStatic` from the **`hono/bun`** subpath (`import {serveStatic} from 'hono/bun'`), NOT from `hono/serve-static`. The generic `hono/serve-static` export requires a `getContent` callback; the `hono/bun` adapter (hono 4.12.27) wires `Bun.file` internally. Do not import the `hono/serve-static` specifier.
- Wire static serving + SPA fallback at the **end** of the existing chain as a single catch-all: `app.get('*', serveStatic({root: <absolute dist path>}, {onNotFound: <SPA fallback handler>}))` (i.e. call `.get('*', serveStatic({root, onNotFound}))` on the existing app). Real files must win over the fallback — this ordering is guaranteed because `serveStatic` resolves the file first and invokes `onNotFound` only when it is missing. Do not add a separate static middleware ahead of the route mounts that could shadow `/api/*` or reorder precedence.
- Resolve the static `root` **absolutely** so it works regardless of cwd: `path.join(import.meta.dir, '..', '..', 'dist')` (or equivalent), since `src/server/index.ts` lives two levels above the repo-root `dist/`. Do not use a bare relative `'dist'`.
- The SPA fallback in `onNotFound` must apply to **GET** requests that do **not** start with `/api`. Requests under `/api` must never be swallowed by the HTML fallback (they keep flowing to the API routes / Hono 404). The exclusion must be **prefix-based** (`/api`), never content-type-based. This is required because `test/app-skeleton.test.ts` pins `GET /api/nonexistent` → 404 and a dozen other `/api` 401/404 statuses, which a blanket `app.get('*', ...)` HTML fallback would break.
- The `onNotFound` SPA-fallback handler serves the built `dist/index.html` for non-`/api` GETs. It must not crash or 500 when `dist/` or `dist/index.html` is absent (under `bun test` the gitignored `dist/` does not exist until `bun build`); it must read the file defensively (e.g. `Bun.file` + `exists()`/`size` check) and only return the HTML when the file is present.
- The **root `index.html` does not exist yet** — this is a **creation**, not an edit. The `build` script runs tailwind → `dist/app.css`, `Bun.build` of `src/client/main.tsx` with `outdir: 'dist'`, and then `cp index.html dist/index.html`; so `index.html` must reference the output CSS (`<link rel="stylesheet" href="/app.css">`) and provide the `<div id="root"></div>` mount point the client uses. Add `<title>MX-5 Private</title>`, the viewport meta (`content="width=device-width, initial-scale=1"`), and a small inline `<style>` setting a dark `--bg` background and a light `--fg` text color on `html, body` (brand values consistent with DESIGN/brand-spec.md / `src/client/index.css`: `--bg: oklch(14% 0.008 260)`). Do NOT pin an exact `--fg` oklch value beyond a light foreground token. Do NOT add the full mockup page chrome (gradients, grid, form markup stay owned by the DESIGN mockups / step 24 client). Do NOT touch `test/ct/template/index.html` (separate Playwright CT template). Do NOT change `package.json` scripts or `build.ts` (owned by step 20).
- Preserve the `@hono/zod-validator` + shared zod-schemas path: the five route sub-apps already import `zValidator` and schemas from `src/shared/schema.ts`; the shell carries no validation wiring and must not add any middleware that reads, re-encodes, or bypasses request bodies, and must not re-implement or duplicate the field-limit schemas (they live in `src/shared/schema.ts`, step 8). Do not introduce a new mount prefix on the shell that would double- or shift the `/api` path (the `/api` prefix is pinned by the route modules' own `basePath('/api/<segment>')`).
- Preserve every existing `package.json` dependency/devDependency and script, and the existing `tsconfig.json`/`eslint.config.js`. Do not add new npm packages (`hono` 4.12.27, `@hono/zod-validator` 0.8.0, `zod` 4.4.3 are already present).
- Parameterized/typed only: no `any`, no string-interpolated SQL, no inline object types with >2 properties (declare named types), type-reuse-first; follow the existing strict `tsconfig.json` (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `noUnusedLocals/Parameters`). Follow AGENTS.md style: 4-space indent, no semicolons, single quotes; one-line single-statement `if` without braces.
- Per test-first cadence: ship a `bun test` (in `test/`, `app.request()` based) in the **same** change that asserts the shell behaviors — SPA fallback for a non-`/api` GET returns the served `index.html` (HTML content-type, not a 404), `/api` GETs are **not** HTML-fallbacked (still 404), and static `dist/` asset serving returns the asset with the correct `Content-Type`. The test must **not** assume a prebuilt `dist/` exists (it is gitignored and absent under `bun test`); it must create a temporary/fixture `dist/` file + fixture `index.html` (or point a second app instance at a fixture dir) so it runs without `bun build` first. This step's test covers the **shell** (fallback + static), not individual API routes.
- Do NOT break existing shell tests: `test/app-skeleton.test.ts` (pins 19 registered `/api` paths and asserts `GET /api/nonexistent` → 404) and `test/harness-smoke.test.ts` must still pass.

ACCEPTANCE
- `src/server/index.ts` still exports `app` (the chained Hono app with the five `.route('/', ...)` mounts in the original order) and `export type AppType = typeof app`, with no change to the public export surface consumed by `src/client/api.ts`.
- The app is a plain Hono fetch handler (`app.fetch`); no `Bun.serve` port binding or `if (import.meta.main)` guard is added by this step (port ownership is not part of this change).
- A non-`/api` GET that matches no real static file returns the `index.html` content with an HTML `Content-Type` (not a 404); a real existing static file (e.g. `/app.css`) is served with the correct content type and beats the fallback.
- `GET /api/nonexistent` still returns 404 (HTML fallback never swallows `/api`); the existing `/api` 401/404 statuses pinned by `test/app-skeleton.test.ts` are unchanged.
- A new root `index.html` exists and carries `<title>MX-5 Private</title>`, the viewport meta, a dark brand pre-hydration background (`oklch(14% 0.008 260)`) + a light `--fg` text color, references `/app.css`, and has a `<div id="root">` mount point.
- `bunx tsc --noEmit` passes (no unused `@ts-expect-error` directives introduced by the AppType route-tree change); `bun run lint` passes; and a new `bun test` in `test/` covering the shell behaviors (SPA fallback, `/api` non-fallback, static asset serving) passes under `AGENT=1 bun test` without requiring a prior `bun build`.
- No new npm packages are added; `package.json`, `tsconfig.json`, `eslint.config.js`, and `build.ts` are unmodified.

VERIFY:
```sh
set -e
bunx tsc --noEmit
bun run lint
AGENT=1 bun test
test -f index.html
grep -q 'MX-5 Private' index.html
grep -q 'id="root"' index.html
grep -q 'app.css' index.html
bun run build
test -f dist/index.html && grep -q 'MX-5 Private' dist/index.html
```
<<<TASK_0044>>>
GOAL
Verify (not rebuild) that `src/server/auth.ts` is at full parity with DESIGN/PROJECT.md §6 (Auth design) and §11 (Security notes), with its test `test/auth.test.ts` passing per §10. Concretely, confirm the on-disk module exposes the pinned surface — `SESSION_COOKIE_NAME = 'session'`, `SESSION_MAX_AGE_SECONDS = 2_592_000`, `User` (`{id, phone, display_name, role: 'member' | 'admin', is_banned}`, no `password_hash`), `AuthEnv` (`Variables: {user: User | null}`), `AuthMiddleware`, and `hashPassword`/`verifyPassword`/`setSessionCookie`/`sessionMiddleware`/`requireAuth`/`requireAdmin` — and that behavior matches spec: argon2id via built-in `Bun.password` (positional `'argon2id'` arg, boolean never-throwing verify); a random 32-byte opaque cookie with only `sha256(value)` (lowercase hex) stored in `sessions.token_hash` and a ~30-day `expires_at`; cookie attrs `HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000` with `Secure` only when `NODE_ENV=production`; `sessionMiddleware` populating `c.var.user` (null on absent/unknown/expired, and banned users rejected at this gate); and `requireAuth` (401 `{message:'Unauthorized'}`) / `requireAdmin` (401 unauth, 403 non-admin) working against `AuthEnv`.

Verification is a live run against the dedicated `mx5_test` database: prove the connection is up, prove the `mx5_test` database specifically exists (not merely that the Postgres server is reachable), then run `bun test test/auth.test.ts`, the full `AGENT=1 bun test`, and `bun run lint`. Degenerate to static parity + `bunx tsc --noEmit` only when the connection check shows the DB is down. No source change is expected; any genuine parity gap is an in-place delta.

CONSTRAINTS
  - "`Bun.password` (argon2id) for password hashing — built in, no dependency" [§2 Tech stack — Server] — owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)
  - "Login issues a random 32-byte cookie value; store `sha256(value)` in `sessions`." [§6 Auth design] — owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)
  - "`sessionMiddleware` loads the user onto `c.var.user` (null if none)." [§6 Auth design] — owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)
- Do not alter the pinned export surface of `src/server/auth.ts`: `SESSION_COOKIE_NAME = 'session'`, `SESSION_MAX_AGE_SECONDS = 2_592_000` (exactly 30 days), `User`, `AuthEnv`, `AuthMiddleware`, `hashPassword`, `verifyPassword`, `setSessionCookie`, `sessionMiddleware`, `requireAuth`, `requireAdmin`. The `User` shape stays `{ id, phone, display_name, role: 'member' | 'admin', is_banned }` with no `password_hash`.
- Password hashing is argon2id via the built-in `Bun.password`, positional call form: `Bun.password.hash(pw, 'argon2id')` / `Bun.password.verify(pw, hash, 'argon2id')`. DESIGN/PROJECT.md §6 prescribes exactly this positional form, so it is authoritative and spec-conformant — do NOT rework it to an options-object shape, and do not flag the object-form-only external docs as a deviation. No third-party hashing dependency is added.
- `verifyPassword` returns a boolean and never throws on mismatch.
- Session token stays opaque + hashed: the raw 32-byte value goes only into the cookie; only `sha256(value)` (lowercase hex) is stored in `sessions.token_hash`. Nothing is signed, so no cookie secret is required. `expires_at` must land at ~30 days (test window 29.9–30.1).
- Cookie attributes: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age=2_592_000`; `Secure` present only when `NODE_ENV === 'production'`, absent in dev.
- `sessionMiddleware` sets `c.var.user` to `null` when the cookie is absent, the matching `sessions` row is missing, the session is expired, or the user is `is_banned`. Banned rejection lives here (the session gate), not only in the guards — per §6 "Banned users are rejected at the middleware."
- `requireAuth` returns `401 {message: 'Unauthorized'}` when `c.var.user` is `null`; `requireAdmin` returns that same 401 when unauthenticated and `403 {message: 'Forbidden'}` when authenticated but `role !== 'admin'`; both require `sessionMiddleware` upstream.
- All DB access uses the existing parameterized `sql` tagged template from `src/server/db.ts` — no string-interpolated values into SQL (§11).
- `auth.ts` is logout-agnostic: it performs session issuance + lookup only; `sessions` row deletion at logout remains owned by `src/server/routes/auth.ts`. Do not move it.
- Do not touch files owned by other steps: `src/shared/schema.ts`, `src/server/routes/*`, `src/server/db.ts`, `src/server/index.ts`, `src/server/seed.ts`, migrations, `test/setup.ts`, `bunfig.toml`, `package.json`, and other test files. The test harness (bun `app.request` against `mx5_test`, `truncateBeforeFile` from `test/setup.ts`, preloaded via `bunfig.toml`) is pre-existing and reused as-is.
- The test lands with the module in the same change (§10): `test/auth.test.ts` must exist and pass; do not defer it.
- Preserve existing behavior/identifiers on disk; any change is an in-place delta, not a rewrite of the already-conformant module.
- Cross-slice boundary must match contracts verbatim: login cookie issuance and `sha256(value)` storage (§6), the `GET /api/auth/me` → current user or 401 surface (§5), argon2id/hashed-token/`HttpOnly`/`Secure`/`SameSite` (§11), and parameterized queries — no rename/reshape of any pinned name.
- VERIFY must distinguish "Postgres server reachable" from "the `mx5_test` database exists." `pg_isready` alone proves only the former; a transient Postgres blip must fall back to the agreed static path rather than abort the block.

ACCEPTANCE
- `src/server/auth.ts` exports exactly the pinned surface above with no drift; `tsc --noEmit` (via `bun run lint`) passes with no type errors against `auth.ts`.
- `bun test test/auth.test.ts` passes live against `mx5_test`, and the test file actually contains the named cases (guarded by grep so a skipped case cannot silently pass VERIFY): constants; argon2id round-trip (hash contains `$argon2id$`, verify true/false booleans); 64-char `^[0-9a-f]{64}$` cookie; full `set-cookie` attribute string incl. `Max-Age=2592000` with `Secure` present under `NODE_ENV=production` and absent in dev; `token_hash === sha256(cookie)` in DB; ~30-day (29.9–30.1) expiry; null-user paths (absent / unknown / expired / banned); banned session rejected at the `sessionMiddleware` gate (a non-guard route returning `c.var.user` returns `null` for a banned user, proving rejection lives at the gate, not only in the guards); and exact 401 `{message:'Unauthorized'}` / 403 `{message:'Forbidden'}` bodies.
- The full suite `AGENT=1 bun test` also passes, proving no consumer regressions (auth, invites, listings, photos, admin, index) from the module's surface.
- `bun run lint` exits 0 (prettier + eslint + `tsc --noEmit`).
- No source change is required for parity; if a genuine parity gap is found it is fixed as an in-place delta in `src/server/auth.ts` (and its test), re-run, and passing.
- When the DB is down, the degrade path is static parity (pinned surface + behavior review) plus `bunx tsc --noEmit` only — no live test runs are reported as passing in that branch.

VERIFY:
```sh
set -u
cd /workspace

# 1) Connection gate: pg_isready proves the Postgres SERVER is reachable.
#    Under set -u (not set -e) a transient Postgres blip degrades to the
#    agreed static path instead of aborting the block.
db_up=1
if ! pg_isready -h localhost -p 5432 >/dev/null 2>&1; then
    db_up=0
fi

# 2) Explicit mx5_test database check (pg_isready alone does NOT prove the
#    dedicated test DB the acceptance criteria target exists).
if [ "$db_up" -eq 1 ]; then
    if ! psql "postgres://postgres:postgres@localhost:5432/postgres" -tAc \
        "SELECT 1 FROM pg_database WHERE datname = 'mx5_test'" | grep -q 1; then
        db_up=0
    fi
fi

if [ "$db_up" -eq 1 ]; then
    # 3) Named-case guard: a test file that skipped the banned-at-middleware
    #    gate or the exact guard bodies would still pass `bun test` — grep the
    #    file so both named acceptance cases are provably present.
    grep -Eq "test\('sets null for a banned user'" test/auth.test.ts
    grep -Eq "test\('401 for a banned user" test/auth.test.ts
    grep -qF "toEqual({message: 'Unauthorized'})" test/auth.test.ts
    grep -qF "toEqual({message: 'Forbidden'})"  test/auth.test.ts

    # 4) Live runs (setup.ts preloaded via bunfig.toml migrates mx5_test).
    bun test test/auth.test.ts
    AGENT=1 bun test
    bun run lint
else
    echo "DB down or mx5_test missing: degrading to static parity + tsc --noEmit"
    bunx tsc --noEmit
fi
```
<<<TASK_0045>>>
GOAL

Add the banned-user cases under the `requireAdmin` describe block in `test/auth.test.ts`, so the banned-gate behavior is asserted at the guard surface in the same change that the test-first cadence requires. The production guards (`requireAuth`, `requireAdmin`), the `sessionMiddleware` banned gate (`findUserBySessionCookie` returning `null` when `row.is_banned`), and every `auth.ts` export already exist on disk and are consumed verbatim by the route modules; the guards already implement the pinned behavior (401 before 403; a banned user's session never populates `c.var.user`, so a banned admin yields 401, never 403). The deliverable is purely test coverage: in the existing `requireAdmin` suite, add (a) a banned admin whose session yields `401 {message:'Unauthorized'}` — not 403 — and (b) a banned member whose session likewise yields 401. The new tests reuse the helpers already in `test/auth.test.ts`. The whole `test/auth.test.ts` suite (guards + banned gate + session + hashing) then passes against the `mx5_test` database via `bun test`, and the repo stays type-clean and lint-clean.

CONSTRAINTS
  - "`requireAuth` / `requireAdmin` guards. Banned users are rejected at the middleware." [§6 Auth design] — owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)

- `test/auth.test.ts` and `test/setup.ts` are confirmed present on disk. `test/auth.test.ts` already covers constants, argon2id hashing, `setSessionCookie` attributes (incl. the `Secure`-only-in-production case), the `sessionMiddleware` null cases (absent cookie / unknown / expired / banned), the `requireAuth` 401-unauthenticated and banned→401 cases, and the `requireAdmin` unauthenticated-401 / member-403 / admin-pass cases. `test/setup.ts` exports `truncateBeforeFile()`. This step extends `test/auth.test.ts` only.
- The only file this step modifies is `test/auth.test.ts`. Do NOT modify `test/setup.ts`, `src/server/auth.ts`, `src/server/db.ts`, `src/server/migrate.ts`, `src/server/seed.ts`, `src/shared/schema.ts`, `src/server/rate-limit.ts`, `src/server/images.ts`, `src/server/index.ts`, any file under `src/server/routes/`, `src/client/`, or `test/`, or `package.json`, `tsconfig.json`, `eslint.config.js`, `bunfig.toml`, `playwright-ct.config.ts`, or `docker-compose.dev.yml`.
- The new tests must reuse the helpers already defined in `test/auth.test.ts` rather than reinventing them (the file-local `insertUser`, `issueSessionCookie`, `buildApp`, and `sha256Hex`, plus the existing `SESSION_COOKIE_NAME` / `SESSION_MAX_AGE_SECONDS` imports). Add the two banned cases as new `test(...)` entries inside the existing `requireAdmin` describe block; do not delete or narrow any existing passing test, and keep the file's top-scope `truncateBeforeFile()` call and `beforeEach` truncation intact.
- Use phone numbers for the two new seed users that are `unique not null` valid E.164 values and do not collide with any number already seeded in `test/auth.test.ts` (currently `+37120000001`–`+37120000009`) or in the sibling `test/admin-ban.test.ts` (currently `+37120000070`–`+37120000074`).
- Preserve the guard response shapes and precedence as the tests assert them: `requireAuth` → `401 {message:'Unauthorized'}` iff `c.var.user === null`; `requireAdmin` → `401 {message:'Unauthorized'}` when `c.var.user === null`, else `403 {message:'Forbidden'}` when `role !== 'admin'`, else `next()` (200 with the user echoed). The null check runs before the role check, so an unauthenticated or banned caller always gets 401, never 403. Do not change messages, status codes, or the 401-before-403 precedence.
- The banned gate is asserted at the guard surface only: a banned user's session leaves `c.var.user === null` (the rejection lives in `sessionMiddleware`/`findUserBySessionCookie`), so `requireAuth` and `requireAdmin` both return 401 for a banned user. Do not add a second banned check inside the guards or any route, and do not assert banned behavior anywhere but through the `requireAuth`/`requireAdmin` guard responses in this step.
- New test code must type-check under the project's strict `tsconfig.json` (incl. `noUncheckedIndexedAccess`, `noUnusedLocals/Parameters`, `verbatimModuleSyntax`) and pass the repo's ESLint config (no `any`), and must match the project's Prettier config so `bun run lint` exits 0.
- Do not introduce new npm dependencies, env vars, routes, or tables, and do not implement login/logout/me routes, invite flows, listing CRUD, photo upload, or admin ban/delete — those are other steps' slices.

ACCEPTANCE

- `test/auth.test.ts` contains banned-user coverage under `requireAdmin`: a banned admin's session yields `401 {message:'Unauthorized'}` (never 403) and a banned member's session likewise yields 401. The existing `requireAuth` banned→401 case, the `requireAdmin` unauthenticated-401 / member-403 / admin-pass cases, and all session/hashing/cookie tests remain present with unchanged assertions.
- The banned gate is verified at the guard surface: a banned user's session results in `c.var.user === null` such that `requireAuth` returns 401 and `requireAdmin` returns 401 (not 403); an authenticated non-admin gets 403 and an authenticated admin passes (200 with the user echoed).
- `bun test test/auth.test.ts` runs the entire `test/auth.test.ts` suite against `mx5_test` and exits 0 with every test in the file passing.
- `bunx tsc --noEmit` exits 0 and `bun run lint` exits 0 after the change; the existing `src/server/auth.ts` exports and the consuming route modules still compile and type-check against them.
- No file outside `test/auth.test.ts` is changed by this step.

VERIFY:
```sh
set -e
set -a
. ./.env
set +a
docker compose -f docker-compose.dev.yml up -d db
for i in $(seq 1 60); do pg_isready -h localhost -p 5432 -U postgres >/dev/null 2>&1 && break; sleep 1; done
pg_isready -h localhost -p 5432 -U postgres
psql "postgres://postgres:postgres@localhost:5432/postgres" -tAc "SELECT 1 FROM pg_database WHERE datname='mx5_test'" | grep -q 1 || psql "postgres://postgres:postgres@localhost:5432/postgres" -c "CREATE DATABASE mx5_test"
test -f test/setup.ts
test -f test/auth.test.ts
grep -q 'truncateBeforeFile' test/setup.ts
bunx tsc --noEmit
bun run lint
bun test test/auth.test.ts
```
<<<TASK_0046>>>
GOAL
Verify-and-complete the auth-login step: confirm the existing `POST /api/auth/login` in `src/server/routes/auth.ts` (a chained Hono sub-app, `new Hono<AuthEnv>().basePath('/api/auth')`, exporting `app`, mounted at root on the single `app` in `src/server/index.ts` via `.route('/', auth.app)`, with `export type AppType = typeof app` preserved) satisfies the design contract and that its full spec'd test surface is green.

Contract to confirm in the login chain: `rateLimit` mounted first in the `app.post('/login', ...)` chain, then `zValidator('json', loginPayloadSchema)`, then the handler; the handler looks the user up by the schema-normalized E.164 phone via a parameterized `sql` tagged-template query from `src/server/db.ts`, verifies the password with `verifyPassword` from `src/server/auth.ts`, issues the session cookie via `setSessionCookie`, and on success returns 200 with the bare user JSON `{id, phone, display_name, role, is_banned}` — `password_hash` never included. On both unknown phone and wrong password it returns the identical 401 `{message: 'Invalid credentials'}` and sets no `set-cookie`. The existing spec'd test surface — `test/login.test.ts` (success + user shape + no `password_hash`, 401s, E.164 normalization, `set-cookie` attributes, 400 validator cases) and `test/rate-limit.test.ts` (login 429) — must be green under the full `bun test` suite and `bun run lint`.

Per the Q&A, this step adds no new test: the login test surface is already fully implemented and passing across those two files. If a currently-failing login test exposes a real defect in the login route, fix the login route (its handler/middleware chain) and only the login route; if everything passes, make no source or test changes.

CONSTRAINTS
  - "`POST /api/auth/login` `{ phone, password }` → sets session cookie, returns user" [§5 API — Auth] — owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)
- Verify-and-done: do NOT add a 429 test to `test/login.test.ts`. The login 429 path is already covered by `test/rate-limit.test.ts` (21 requests from one `x-forwarded-for` key → 429, a different key still succeeds), and a duplicate would conflict with that file's distinct-key isolation design. Confirm the existing suite is green instead.
- Scope is the login route only. The existing `src/server/routes/auth.ts` also contains `/logout` and `/me` (step 14's surface) — leave them in place untouched. If any edit is required, it must be to the login route's handler/middleware chain only.
- Preserve the boundary contract exactly: endpoint `POST /api/auth/login`; body `{ phone, password }`; success = the bare user object `{id, phone, display_name, role, is_banned}` (not wrapped in `{user}`) with the session cookie set, and `password_hash` never included; failure = 401 `{message: 'Invalid credentials'}` for both unknown phone and wrong password, with no `set-cookie`.
- Preserve the file/endpoint layout pinned by the design: `src/server/routes/auth.ts` owns the sub-app under `basePath('/api/auth')`; it is chained as `.route('/', auth.app)` on the single `app` in `src/server/index.ts`; `AppType` is exported from `src/server/index.ts` as `export type AppType = typeof app` so the typed client (`hc<AppType>` in `src/client/api.ts`) can infer `/api/auth/login`.
- Preserve the login middleware order: `rateLimit` first (mounted per-route in the `app.post(...)` chain, never on a `basePath`), then `zValidator('json', loginPayloadSchema)`, then the handler.
- Reuse the existing plumbing rather than re-implementing: `setSessionCookie`, `verifyPassword`, `hashPassword`, `AuthEnv`, `sessionMiddleware`, `requireAuth`, `requireAdmin`, `SESSION_COOKIE_NAME`, `SESSION_MAX_AGE_SECONDS` from `src/server/auth.ts`; the in-memory `rateLimit`/`reset` from `src/server/rate-limit.ts`. The login handler must call `setSessionCookie` so the issued cookie's attributes (HttpOnly, SameSite=Lax, Path=/, 30-day expiry, `Secure` only when `NODE_ENV === 'production'`) match what `setSessionCookie` emits.
- All phone/password validation must come from the shared zod schema in `src/shared/schema.ts` (`loginPayloadSchema` via `phoneSchema`/`passwordSchema`) — no hand-rolled phone or password validation in the route. E.164 normalization is the schema's preprocessing.
- All SQL must go through the `sql` tagged-template client from `src/server/db.ts` with bound values — no string interpolation.
- Do not modify `src/server/auth.ts`, `src/server/db.ts`, `src/server/rate-limit.ts`, `src/shared/schema.ts`, `test/rate-limit.test.ts`, or `test/login.test.ts`; prefer verifying over changing. Keep `src/server/index.ts`'s existing chained routes, SPA fallback, static serving, and `AppType` export intact.
- Leave the existing test isolation contracts undisturbed: `test/login.test.ts` and `test/rate-limit.test.ts` each call `truncateBeforeFile()` at file scope, seed via parameterized queries, and drive the route through `app.request(...)` with per-request `x-forwarded-for` values; `test/rate-limit.test.ts` additionally relies on its single `reset()` in `beforeAll` (that lone `reset()` must remain the only one — its comment documents why).
- Code style: follow the project's Prettier config (`.prettierrc.cjs`) and the strict ESLint/TypeScript rules already configured in `package.json`/`eslint.config.js`/`tsconfig.json`; the tree as left behind must pass `bun run lint` clean.
- Tests run against the `mx5_test` Postgres DB via the `bunfig.toml` preload of `test/setup.ts`; the DB must be up (via the repo's docker-compose) before `bun test` runs.

ACCEPTANCE
- `POST /api/auth/login` accepts `{ phone, password }`, normalizes the phone server-side to E.164 (e.g. `+371 200-000-00` → `+37120000000`), and on valid credentials returns 200 with the bare user object `{id, phone, display_name, role, is_banned}` — no `password_hash` — and a `set-cookie` header carrying the session cookie with HttpOnly, SameSite=Lax, Path=/, a 30-day Max-Age, and `Secure` only when `NODE_ENV === 'production'`.
- Both unknown phone and wrong password return the identical 401 `{message: 'Invalid credentials'}` with no `set-cookie`; a malformed (non-E.164) phone or an out-of-bounds password returns 400 from the validator.
- The rate limit is enforced on the login route: 21 requests from a single `x-forwarded-for` key yield 429 `{message: 'Too many requests'}` on the 21st, while a different key still succeeds.
- The sub-app is mounted at root on the single `app` in `src/server/index.ts` and `AppType` is exported from that file, so `hc<AppType>` inference covers `/api/auth/login`.
- The spec'd login test surface exists and passes — `test/login.test.ts` (success + user shape + no `password_hash`, 401s, E.164 normalization, cookie attributes, 400s) and `test/rate-limit.test.ts` (login 429) — and no new duplicate 429 test was added to `test/login.test.ts`.
- The FULL `bun test` suite passes end-to-end (the preload migrates `mx5_test` first), and `bun run lint` (prettier --write + eslint --fix + tsc --noEmit) exits 0.

VERIFY:
```sh
cd /workspace
docker compose -f docker-compose.dev.yml up -d db
until docker exec mx5-dev-db pg_isready -U postgres -q; do sleep 1; done
bun test
bun run lint
```
<<<TASK_0047>>>
GOAL
Extend `src/server/routes/auth.ts` (which currently exports `app = new Hono<AuthEnv>().basePath('/api/auth')` and already contains a `POST /login` handler plus a local `sha256Hex` helper) to ADD two new routes in the same file:
- `POST /api/auth/logout` — clears the current session: deletes the matching row from `sessions` (the row whose `token_hash` equals the `sha256` of the presented cookie value) and expires the `session` cookie via `deleteCookie(c, SESSION_COOKIE_NAME, {httpOnly: true, path: '/'})`. Returns 200 `{ok: true}` whether or not a cookie was present (an absent or expired cookie must still yield 200, never 401).
- `GET /api/auth/me` — guarded by `sessionMiddleware` (not `requireAuth`); returns the current user loaded onto `c.var.user` as 200 `{id, phone, display_name, role, is_banned}`, or 401 `{message: 'Unauthorized'}` when unauthenticated (including banned users, whose sessions `sessionMiddleware` rejects so `c.var.user` is null).

Ship `test/logout-me.test.ts` (bun test, exercising the full `app` from `src/server/index.ts` via `app.request()`) in the SAME change, covering: logout with a valid session row (row deleted, cookie expired, a subsequent `/me` returns 401), logout without a cookie (still 200, no crash), `/me` with a valid session (exact 5-field user body, no `password_hash`), `/me` with no cookie (401), `/me` with an expired session (401), and `/me` for a banned user (401). No route is considered done until its test exists and passes.

CONSTRAINTS
- This is an in-place ADD to `src/server/routes/auth.ts`: preserve the existing `app = new Hono<AuthEnv>().basePath('/api/auth')` export, the existing `POST /login` route, all existing imports, and the local `sha256Hex` / `UserRow` declarations exactly as they are. The new `/logout` and `/me` handlers are added; do not rewrite or reorder the login route.
- Preserve every existing script, dependency, devDependency, and compiler option in `package.json`; do not add or remove any.
- Use parameterized queries via the Bun SQL tagged template (`sql` from `src/server/db.ts`); no string interpolation of values into SQL.
- Reuse existing exports from `src/server/auth.ts` (`sessionMiddleware`, `SESSION_COOKIE_NAME`, `AuthEnv`, `User` type) — do not duplicate session logic or redefine those types. The local `sha256Hex` helper already in `auth.ts` may be reused for the logout token-hash lookup.
- `GET /api/auth/me` must use `sessionMiddleware` (NOT `requireAuth`) so the 401 body is exactly `{message: 'Unauthorized'}` and the success path returns exactly the 5-field `User` shape `{id: string, phone: string, display_name: string, role: 'member'|'admin', is_banned: boolean}` — no `password_hash`, no `invited_by`, no `created_at`, no extra fields.
- The logout route must NOT require auth: an expired or absent cookie must still yield 200, not 401.
- Logout deletes ONLY the `sessions` row whose `token_hash` matches the sha256 of the presented cookie (single-session; the lookup is by `token_hash`, not by `user_id`), and returns 200 `{ok: true}`.
- Cookie deletion must use `deleteCookie` from `hono/cookie` called as `deleteCookie(c, SESSION_COOKIE_NAME, {httpOnly: true, path: '/'})` — exactly these two attributes (`httpOnly: true`, `path: '/'`), matching the issuance attributes in `setSessionCookie`; do not pass `maxAge` to `deleteCookie`.
- `test/logout-me.test.ts` must call `truncateBeforeFile()` from `test/setup.ts` in file scope, seed a fresh user + `sessions` row per test case via parameterized `INSERT` (avoiding the login/rate-limit/argon2id path), import `app` from `src/server/index.ts` (the full chained app), and exercise the routes via `app.request('/api/auth/logout', …)` / `app.request('/api/auth/me', …)`.
- `test/logout-me.test.ts` must cover: logout with a valid session row (row deleted, cookie expired, subsequent `GET /api/auth/me` via the full app returns 401), logout without a cookie (200, no crash), `/me` with a valid session (exact 5-field body, no `password_hash`), `/me` with no cookie (401), `/me` with an expired session (401), and `/me` for a banned user (401). An expired session row uses a past `expires_at` (e.g. `now() - interval '1 day'`); a banned user row uses `is_banned = true` with a non-expired session.
- Because `POST /api/auth/login` (and, if used, the login path) sits behind the in-memory `rateLimit` middleware, tests that issue a session by calling `app.request('/api/auth/login', …)` must use a distinct `x-forwarded-for` header per login call (the rate limiter keys on that header) to avoid 429s; prefer seeding `sessions` rows directly where login is not the thing under test.
- Do not add a Playwright CT spec (these are server routes, not components/pages).
- Do not modify `src/server/auth.ts`, `src/shared/schema.ts`, `src/server/db.ts`, `src/server/migrate.ts`, `src/server/seed.ts`, `test/setup.ts`, or any route file other than `src/server/routes/auth.ts`.
- Follow the existing code style: no semicolons, single quotes, 4-space indent, LF (Prettier `.prettierrc.cjs`).
- Cross-slice contract (verbatim, binding): "`POST /api/auth/logout` → clears session" and "`GET  /api/auth/me` → current user or 401" — the endpoints, paths, and response shapes above satisfy these exactly.

ACCEPTANCE
- `POST /api/auth/logout` with a valid session cookie returns 200 `{ok: true}`, deletes exactly that `sessions` row, and emits a `Set-Cookie` that expires the `session` cookie with `HttpOnly` and `Path=/`; a subsequent `GET /api/auth/me` carrying the same cookie returns 401 `{message: 'Unauthorized'}`.
- `POST /api/auth/logout` with no cookie returns 200 `{ok: true}` and does not crash.
- `GET /api/auth/me` with a valid session returns 200 with exactly the 5-field body `{id, phone, display_name, role, is_banned}` and no `password_hash`.
- `GET /api/auth/me` with no cookie, with an expired session, and for a banned user each returns 401 `{message: 'Unauthorized'}`.
- `test/logout-me.test.ts` exists and contains all the cases above, and passes under `bun test`.
- `tsc --noEmit` passes with no errors, and `eslint .` passes with no errors (the repo's `lint` npm script is the equivalent check, but its `--fix`/`--write` flags make it a no-op as a verification, so VERIFY uses the non-mutating forms directly).
- The full API suite passes when run via the repo's `bun test` (all `test/*.test.ts`, including the new `test/logout-me.test.ts`).

VERIFY:
```sh
set -e
bun run migrate
bun test test/logout-me.test.ts
bun test
tsc --noEmit
eslint .
prettier --check 'src/server/routes/auth.ts' 'test/logout-me.test.ts'
```

KNOWN-UNKNOWNS
- Should `POST /api/auth/logout` invalidate OTHER sessions for the same user (multi-device logout) or only the session identified by the presented cookie? The design says "clears session" (singular); the implementation here deletes only the matching `token_hash` row. Confirm single-session logout is acceptable.
- The design does not pin the exact logout success body. This spec pins 200 `{ok: true}`; confirm that shape (vs. e.g. empty 204) is acceptable.
- Should `/api/auth/me` return `invited_by` or `created_at` in addition to the 5-field `User` type from `src/server/auth.ts`? The cross-slice contract says only "current user or 401", but the `User` type has exactly 5 fields; this spec pins the 5-field shape.

EXTERNAL-DEPENDENCIES
- PostgreSQL 18 `sessions` table schema (`token_hash`, `user_id`, `expires_at`) and the `mx5_test` database (auto-created/migrated by `test/setup.ts` via `runMigrate`) for test isolation.
<<<TASK_0048>>>
GOAL

Complete the invites API slice in place. `src/server/routes/invites.ts` already implements all three pinned routes (auth-only `POST /api/invites` returning `{ url }`; public `GET /api/invites/:token` returning `{ valid: true }` or an identical 404; public `POST /api/invites/:token/redeem` with the read-only 409 duplicate-phone pre-check, the atomic conditional-`UPDATE` claim, the user insert, the `used_by` backfill, and the session cookie), and the route modules are already wired into `src/server/index.ts` via `.route('/', invites.app)` at the `/api/invites` basePath. This change is a verify-in-place pass: confirm that the existing implementation and the existing per-route test coverage (`test/invites.test.ts`, `test/invites-validate.test.ts`, `test/invites-redeem.test.ts`) satisfy DESIGN/PROJECT.md §5, and then add the one genuinely missing test — a 400 validation-error test for the redeem route — to `test/invites-redeem.test.ts`. Nothing else in the slice is rewritten, and no other files are touched.

CONSTRAINTS

- Do not modify `src/server/index.ts`, `src/server/auth.ts`, `src/server/rate-limit.ts`, `src/shared/schema.ts`, `src/server/db.ts`, migrations, or any client files; do not touch the other route modules (auth, listings, photos, admin). The only file this change writes is `test/invites-redeem.test.ts`.
- Keep `src/server/routes/invites.ts`'s `app` export name and `.basePath('/api/invites')` intact so that `src/server/index.ts`'s `.route('/', invites.app)` and `test/app-skeleton.test.ts` (which asserts `POST /api/invites` and `POST /api/invites/:token/redeem` are registered, not 404) remain satisfied.
- Preserve the pinned route contracts exactly as the cross-slice contract states: `POST /api/invites` → 200 `{ url }` with `url = ${process.env.APP_URL}/join/${token}`, a 32-byte base64url token, `expires_at = now() + 14 days`, auth-only via `rateLimit, sessionMiddleware, requireAuth` (no admin check); `GET /api/invites/:token` → 200 `{ valid: true }` or identical 404 `{ message: 'Not found' }` for unknown/used/expired; `POST /api/invites/:token/redeem` → `rateLimit, zValidator('json', inviteRedeemPayloadSchema)` chain, read-only duplicate-phone 409 `{ message: 'Conflict' }` before the claim (the invite is never consumed on a conflict), atomic claim via the conditional `UPDATE invites SET used_at = now() WHERE token = $ AND used_at IS NULL AND expires_at > now() RETURNING id, created_by` as the first statement of `sql.begin`, lost claim (0 rows) rejects 404 before any state changes, user insert with argon2id `hashPassword`, `role = 'member'`, `is_banned = false`, `invited_by = claim.created_by`, `invites.used_by` backfill, `setSessionCookie`, 200 user `{ id, phone, display_name, role, is_banned }`; a second or concurrent redeem of the same token → 404. The middleware chain is already as specified — do not add, remove, or reorder middleware (in particular, do not touch the GET route, which carries no `rateLimit`).
- No list/revoke invite endpoints — invites are fire-and-forget; do not add routes beyond the three.
- All DB access via parameterized Bun SQL tagged templates from `../db` (`sql` / `tx`); no string-interpolated SQL. Use the shared pieces verbatim: `requireAuth`/`sessionMiddleware`/`hashPassword`/`setSessionCookie`/`AuthEnv`/`User` from `../auth`, `rateLimit` from `../rate-limit` (first in each rate-limited handler chain, never on the `basePath`), `inviteRedeemPayloadSchema` from `../../shared/schema`.
- Do not consolidate the GET/redeem test suites into `test/invites.test.ts` — the existing per-route coverage in `test/invites-validate.test.ts` and `test/invites-redeem.test.ts` stays exactly where it is (per user Q&A).
- The only test added is the redeem 400 validation-error case in `test/invites-redeem.test.ts`, placed inside the existing `describe('POST /api/invites/:token/redeem')` block after the existing 409 test. Follow the file's established style: use the file's own `seedInvite` helper to obtain a token, `app.request` with `content-type: application/json`, and status-only assertions (`expect(res.status).toBe(400)`) matching the repo convention in `test/login.test.ts:122-129` (never assert the 400 body — the `zValidator` 0.8.0 default body shape is unpinned).
- Cover at least the two spec-relevant validation failures: a malformed E.164 phone (e.g. `'37120000000'` — no leading `+`) and a short password (e.g. `'short'` — below `passwordSchema`'s 8-char minimum); separate tests or combined payloads are both acceptable, but each invalid field must be exercised.
- Preserve the existing `beforeEach` TRUNCATE of `sessions, users, invites CASCADE` and the `truncateBeforeFile()` call in `test/invites-redeem.test.ts`; the new test runs under that isolation.
- Keep the file under the rate-limit budget: `rateLimit` allows 20 requests per 60s per `x-forwarded-for` key (headerless `app.request` calls share one fallback key); the new tests must not push the file's redeem calls past 20.
- Keep code style consistent with the repo (Prettier: 4-space indent, no semicolons, single quotes, no bracket spacing, `arrowParens: avoid`; ESLint strict, `no-explicit-any: error`); `bun run lint` and the full test suite must pass.

ACCEPTANCE

- `src/server/routes/invites.ts` implements the three pinned routes exactly as specified, with the `app` export and `/api/invites` basePath unchanged, so `src/server/index.ts` and `test/app-skeleton.test.ts` remain satisfied — and the GET route still carries no `rateLimit` (no change to its chain).
- `test/invites-redeem.test.ts` contains the new 400 validation-error test(s) for `POST /api/invites/:token/redeem` (malformed E.164 phone and/or short password), asserting `res.status` toBe(400) only, in the file's existing style.
- No other files are modified; the pre-existing tests in `test/invites.test.ts`, `test/invites-validate.test.ts`, and `test/invites-redeem.test.ts` all still pass unchanged.
- `bun run lint` (Prettier + ESLint + `tsc --noEmit`) passes.
- The full test suite (`bun test`) passes against the local `mx5_test` Postgres, including the new redeem 400 case, the existing invite create/validate/redeem coverage, and the app-skeleton route-table checks.

VERIFY:

```sh
set -e

# 1. Ensure the local Postgres (with the mx5_test test database) is up.
docker compose -f docker-compose.dev.yml up -d

# 2. Lint + typecheck.
bun run lint

# 3. Full test suite against mx5_test.
bun test

# 4. The new redeem 400 validation-error case specifically.
bun test test/invites-redeem.test.ts

# 5. The new case is a status-only 400 assertion on the redeem path.
grep -q "toBe(400)" test/invites-redeem.test.ts

# 6. Confirm the GET validate route still carries no rateLimit (unchanged chain).
! grep -E "app\.get\('/:token',\s*rateLimit" src/server/routes/invites.ts
```
<<<TASK_0049>>>
GOAL
Confirm that the listings-route test coverage for the six non-grid, non-photo endpoints — `GET /api/listings/:id`, `POST /api/listings`, `PATCH /api/listings/:id`, `POST /api/listings/:id/sold`, `DELETE /api/listings/:id`, `GET /api/listings/:id/contact` — is already fully present in the repo's dedicated per-endpoint test files, and re-establish the green verification baseline without changing any file. Per the user's decision (Q1/A1), this task is a verified no-op: no new tests, no edits, no duplicates. The deliverable is the evidence that (1) `test/listings.test.ts` is byte-for-byte unchanged, (2) the six per-endpoint files exist and are discovered by `bun test`, and (3) those tests pass against `mx5_test` while exercising the contract's "Done" semantics (key-exact payloads, 401/404 bodies, banned-seller 404s, sold both directions, owner-or-admin delete, `updated_at` advanced, phone shipped only by the contact reveal).

CONSTRAINTS
  - "Phone reveal only to authenticated members; never ship phone in list/detail payloads." [§11 Security notes] — owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)
- Make NO changes to any file in the repo. `test/listings.test.ts` must remain byte-for-byte identical (grid `describe` block, helpers, `truncateBeforeFile()` call, imports); the six per-endpoint test files, `src/server/routes/listings.ts`, `src/server/index.ts`, `src/shared/schema.ts`, `src/server/db.ts`, `src/server/auth.ts`, `src/server/rate-limit.ts`, and `test/setup.ts` must all be untouched. The deliverable is verification evidence, not new test code.
- Do NOT duplicate the six endpoints' `describe` blocks into `test/listings.test.ts` — the user explicitly resolved (A1) that the per-endpoint files already satisfy the spec, and duplicating would be redundant coverage of the same contract.
- Do NOT touch `src/server/routes/photos.ts`, the `POST /api/listings/:id/photos` handler, or `test/listings-photos.test.ts` (step 18's slice) — neither is covered, modified, or re-covered by this task.
- All verification must run against the dedicated `mx5_test` database via the existing `[test] preload` wiring in `bunfig.toml` (which repoints `DATABASE_URL` and migrates once before any test file loads) — never the dev `mx5` database. No environment-variable prefixes are needed or honored for this.
- No source fix is authorized or expected: the handlers are the already-implemented, contract-conforming slice; a fix would only be warranted if running the existing tests exposed a genuine defect, and the baseline does not.
- The six existing per-endpoint files must be confirmed to still match the contract verbatim: `GET /api/listings/:id` → full listing + `seller_display_name` + `photo_ids`, no `phone`, no `contact_note`, public, banned seller → 404; `POST /api/listings` (auth) → 201 exactly `{ id }`; `PATCH /api/listings/:id` (owner-only) → partial-field edit, `updated_at` advanced, non-owner/missing → 404 `{message: 'Not found'}`; `POST /api/listings/:id/sold` (owner-only) `{ sold: bool }` → status flip both directions, `updated_at` advanced; `DELETE /api/listings/:id` (owner or admin) → 204 empty body, non-owner member and missing id → 404; `GET /api/listings/:id/contact` (auth-only, not owner-restricted, not status-gated) → exactly `{ phone, display_name, contact_note }`, banned seller → 404.

ACCEPTANCE
- `git diff --exit-code -- test/listings.test.ts` exits 0 (the file is byte-for-byte unchanged) and no new file or edit appears anywhere in the repo.
- All six per-endpoint files exist — `test/listings_detail.test.ts`, `test/listings-create.test.ts`, `test/listings-update.test.ts`, `test/listings-sold.test.ts`, `test/listings-delete.test.ts`, `test/listings_contact.test.ts` — and each is discovered and run by `bun test`: its `describe` block name is present in the run output, all of its tests pass, and the run reports zero failed/skipped across the whole suite against `mx5_test`.
- Each file's pass is with the contract semantics actually asserted, not merely executed: key-exact response payloads (e.g. contact returns exactly `['phone', 'display_name', 'contact_note']`), 401 `{message: 'Unauthorized'}` and 404 `{message: 'Not found'}` bodies, banned-seller listings 404 on detail and contact, the sold toggle asserted in both directions (`{sold:true}` → `sold`, `{sold:false}` → `active`), DELETE owner-or-admin with a `role: 'admin'` seeder, `updated_at` advanced on PATCH and sold, and phone shipping only via the contact reveal (detail/grid asserted phone-free).
- `bun run lint` exits 0, confirming the untouched tree still passes the repo's lint gate (prettier per `.prettierrc.cjs` — 4-space `tabWidth`, `bracketSpacing` false, no semicolons, single quotes, `printWidth` 120; eslint; and `tsc --noEmit` under the strict tsconfig including `noUncheckedIndexedAccess` / `noUnusedLocals`).

VERIFY:
```sh
git diff --exit-code -- test/listings.test.ts
for f in test/listings_detail.test.ts test/listings-create.test.ts test/listings-update.test.ts test/listings-sold.test.ts test/listings-delete.test.ts test/listings_contact.test.ts; do
  test -f "$f" || { echo "missing: $f"; exit 1; }
done
bun test > /tmp/bun-test.log 2>&1 || { cat /tmp/bun-test.log; exit 1; }
grep -c " 0 failed" /tmp/bun-test.log
for t in "GET /api/listings/:id" "POST /api/listings" "PATCH /api/listings/:id" "POST /api/listings/:id/sold" "DELETE /api/listings/:id" "GET /api/listings/:id/contact"; do
  grep -F "$t" /tmp/bun-test.log || { echo "missing describe block: $t"; exit 1; }
done
bun run lint
```
<<<TASK_0050>>>
GOAL

Extend `test/images.test.ts` to close out the MX-5 image-pipeline step (DESIGN §7): the sharp `processImage` pipeline in `src/server/images.ts` (EXIF rotate → full 1600px webp q80 + thumb 600px webp q72, no upscale, jpeg/png/webp only, >15 MiB reject) is already implemented and tested, and per the user's Q&A (A1) it is treated as done and is NOT modified; the `listing_photos` insert itself already lives inline in the step-18 route `src/server/routes/listings.ts` and is likewise NOT modified (no `insertPhotoRow` export is added). This task adds the DESIGN §7 step-4 coverage that is missing from `test/images.test.ts` today: a new `listing_photos` insert suite that seeds real `users`/`listings` FK targets, inserts a photo row directly against the real `0001_init.sql` schema using the repo's proven `decode('<hex>','hex')` parameterized bytea pattern, and asserts the stored row satisfies the binding schema contract (`content_type = 'image/webp'`, `byte_size = full_data.length`, `position` 0–4 round-trips, server-defaulted `id`/`created_at`, and the `unique (listing_id, position)` rejection). Per the user's Q&A (A2), the sibling test helpers are copied locally (private, non-exported) into `test/images.test.ts` — no new `test/helpers.ts` file is created and no sibling spec is touched. Done = `bun test` passes (all pre-existing `processImage` suites in `test/images.test.ts` unchanged in behavior, plus the new `listing_photos` insert suite) and `bun run lint` is clean, with `test/images.test.ts` the only file created or modified.

CONSTRAINTS
  - "`sharp(buffer).rotate()` (respect EXIF orientation), strip metadata." [§7 Image pipeline] — owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)
  - "**Full:** resize longest edge → 1600px (no upscale), `.webp({ quality: 80 })`." [§7 Image pipeline] — owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)
  - "**Thumb:** resize longest edge → 600px, `.webp({ quality: 72 })`." [§7 Image pipeline] — owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)
  - "Insert one `listing_photos` row (`full_data`, `thumb_data`, `position`)." [§7 Image pipeline] — owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)

- Do NOT modify `src/server/images.ts` — per user answer A1 the existing module is already-done: `processImage(buffer: Buffer): Promise<ImageOutputs>`, `ImageError`, and `ImageOutputs` stay exactly as-is; the test must import them unchanged.
- Do NOT modify `src/server/routes/listings.ts` — the inline `listing_photos` insert (the `sql.unsafe('INSERT INTO listing_photos (listing_id, position, content_type, full_data, thumb_data, byte_size) VALUES ($1, $2, $3, $4, $5, $6)', …)` call), the `MAX_PHOTOS_PER_LISTING` cap, and the position computation remain the step-18 route's job. This task adds no `insertPhotoRow` export and no shared helper file (`test/helpers.ts` is out of scope per A2).
- Do not modify `src/server/migrations/0001_init.sql`, `src/server/db.ts`, `src/server/auth.ts`, `src/server/migrate.ts`, `test/setup.ts`, `bunfig.toml`, `package.json`, `tsconfig.json`, `eslint.config.js`, `playwright-ct.config.ts`, any sibling spec (`test/photos.test.ts`, `test/listings.test.ts`, `test/listings-photos.test.ts`, `test/auth.test.ts`), or anything under `src/client/**`.
- The only file this task changes is `test/images.test.ts`: it keeps every existing `processImage` test unchanged in behavior (resize landscape/portrait, no-upscale, EXIF orientation-6, format gate incl. gif → `ImageError`, size gate 15 MiB accept / 15 MiB+1 reject) and adds one new `describe` block for the `listing_photos` insert.
- The new block must call `truncateBeforeFile()` at file scope (registering the one-shot beforeAll `TRUNCATE listing_photos, listings, invites, sessions, users CASCADE`) and a per-test `beforeEach` that truncates `listing_photos, listings, sessions, users CASCADE`, mirroring `test/photos.test.ts`; the `[test] preload` (`bunfig.toml` → `test/setup.ts`) already points `DATABASE_URL` at `mx5_test` and ran `runMigrate()` — the test must not re-migrate.
- Copy the sibling local helper definitions into `test/images.test.ts` as private (non-exported) functions, matching each spec's own-copy pattern (per A2): `insertUser` (argon2id hash via the repo's `hashPassword('password123')`), `sha256Hex` + `issueSessionCookie` (32-byte `crypto.getRandomValues` token, sha256 hash into `sessions`), and `insertListing` (the fixed 'Bump stop' row). Import `SESSION_MAX_AGE_SECONDS` and `hashPassword` from `../src/server/auth`; do not invent new seeding beyond these three helpers plus the direct `listing_photos` insert the task is about.
- DB seeding for bytea must use the repo's proven pattern: `decode('<hex>', 'hex')` bound as a SQL expression (the established workaround for Bun's tagged-template bytea quirk #17587, as used by `test/photos.test.ts`'s `insertPhoto`/`insertPhotoAt`); seed `full_data` and `thumb_data` with distinct hex payloads so byte-equality assertions genuinely distinguish the two columns.
- The insert test must assert the binding schema contract from `0001_init.sql`: stored `content_type` is exactly `'image/webp'`; `byte_size` equals the byte length of the stored `full_data` (not `thumb_data`, not the sum — matching the route's `output.full.length` insert convention and the existing assertion in `test/listings-photos.test.ts`'s DELETE-suite compaction tests); `position` round-trips exactly for a value in 0–4 (at least one non-zero position, so the test proves the column is not hard-coded to 0); a second insert into the same `(listing_id, position)` is rejected by the `unique (listing_id, position)` constraint (assert the insert fails and the table still holds exactly one row for that `(listing_id, position)` — do NOT assert on Postgres's internal error code, only on the observable "rejected + no second row" behavior); `id` (uuid) and `created_at` come from server-side defaults — the test's own insert supplies only the six app columns (`listing_id, position, content_type, full_data, thumb_data, byte_size`).
- Preserve the existing test behavior exactly: `processImage` stays a pure `Buffer → {full, thumb, contentType}` function as imported from `src/server/images.ts`; `full`/`thumb` stay `Buffer`s with the webp magic bytes (`RIFF`/`WEBP`); do not reshape, re-order, or weaken the existing assertions, and do not re-derive or re-implement any of `processImage`'s internal pipeline steps inside the test.
- Match repo style so `bun run lint` (prettier --write + eslint --fix + tsc --noEmit, per `package.json`'s `lint` script) stays clean: no semicolons, single quotes, 4-space indent, printWidth 120, `arrowParens: avoid`, no bracket spacing; TypeScript strict (`noUncheckedIndexedAccess` — index access yields `T | undefined`, siblings use `!`); `verbatimModuleSyntax` (type-only imports via `import type`); no unused locals/params; no `any`.
- The DESIGN §7 pipeline values remain the source-of-truth contract exercised by the (unchanged) existing `processImage` tests: `sharp(buffer).rotate()` EXIF auto-orient + metadata strip; full = longest edge 1600px, `withoutEnlargement`, `.webp({quality: 80})`; thumb = longest edge 600px, `withoutEnlargement`, `.webp({quality: 72})`; jpeg/png/webp only; reject `> 15 * 1024 * 1024` bytes (15 MiB exact accepted, +1 rejected) — the new insert suite does not re-test any of this; it only covers step 4 (the DB row).
- Test-first cadence: the new insert suite lands in this same change as the change to `test/images.test.ts` and must pass before the step is done — no deferring to a later milestone.

ACCEPTANCE

- `test/images.test.ts` contains the original `processImage` suites (resize landscape/portrait, no-upscale, EXIF orientation-6, format gate incl. gif → `ImageError`, size gate 15 MiB accept / 15 MiB+1 reject) unchanged in behavior, plus one new `describe` block for the `listing_photos` insert using `truncateBeforeFile()` at file scope, a per-test `beforeEach` truncation, and the locally copied private `insertUser`/`issueSessionCookie`/`insertListing` helpers.
- The insert suite proves DESIGN §7 step 4 against the real `0001_init.sql` schema: a row inserted with only the six app columns round-trips with `content_type = 'image/webp'`, `byte_size` equal to the byte length of the stored `full_data`, the seeded `position` value (0–4, at least one non-zero), byte-identical `full_data`/`thumb_data` matching the seeded distinct hex payloads, and a server-defaulted non-null uuid `id` plus non-null `created_at`.
- A second insert into the same `(listing_id, position)` is rejected by the `unique (listing_id, position)` constraint — asserted as "the insert throws/fails and the table still contains exactly one row for that `(listing_id, position)`" (not pinned to any specific Postgres error code), proving the constraint the route's ≤5-cap logic depends on.
- `bun test` exits 0 with all suites in `test/images.test.ts` passing (the pre-existing `processImage` suites and the new insert suite), and no regressions in the sibling specs under `test/`.
- `bun run lint` exits 0 — prettier, eslint (type-checked), and `tsc --noEmit` all clean over the changed file.
- No files other than `test/images.test.ts` are created or modified.

VERIFY:
```sh
docker compose -f docker-compose.dev.yml up -d db
for i in $(seq 1 60); do docker compose -f docker-compose.dev.yml exec -T db pg_isready -q && break; sleep 1; done
bun test test/images.test.ts
bun test
bun run lint
```
<<<TASK_0051>>>
GOAL

In this single-package Bun/Hono repo, finalize the Photos API step of the MX-5 marketplace plan: the `src/server/routes/photos.ts` module (mounted under `/api` by the existing Hono app shell via `export const app`) so that (a) `GET /api/photos/:id?size=thumb|full` serves a stored photo's `bytea` over the wire with the row's `Content-Type` and the exact immutable cache header, and (b) `DELETE /api/photos/:id` removes a photo on the seller's own listing and re-compacts the survivors' `position` values so `position 0` is always the cover.

The one behavioral change this slice must make — the strict design reading pinned in DESIGN/PROJECT.md §5 ("delete + compact") — is atomicity: the current on-disk draft runs the ownership-checked `DELETE … USING listings` **outside** any transaction (auto-committed) and opens a *second* `sql.begin` only for the compaction. Reconcile the code with the design by moving the `DELETE … RETURNING` inside the **same single `sql.begin` transaction** as the survivor compaction, so no auto-committed delete can ever precede the compaction, while preserving the exact response contract (404 for missing/non-owner/non-UUID, 204 otherwise).

The same-change acceptance gate is a passing `test/photos.test.ts` `app.request()` suite against the `mx5_test` database **plus a clean `bun run lint` run**, both in this change. The existing observable GET/DELETE test coverage stays; this change adds an atomicity assertion driving the single-transaction delete+compaction so that criterion is actually verified (see ACCEPTANCE #3 and the added test).

CONSTRAINTS

- Follow `DESIGN/PROJECT.md` as authoritative wherever it disagrees. Its pinned Photos API, verbatim (§5, `routes/photos.ts`):
  - `POST /api/listings/:id/photos` *(owner, multipart)* → compress via sharp, enforce ≤5 total
  - `GET  /api/photos/:id?size=thumb|full` → streams bytea with `Content-Type` + `Cache-Control: public, max-age=31536000, immutable`.
    Deliberately unauthenticated: photo ids are unguessable UUIDs, and the cache headers require it. Accepted tradeoff. Do NOT add a session/guard to GET.
  - `DELETE /api/photos/:id` *(owner)* → delete + compact remaining positions (so `position 0` is always the cover)
- **Ownership and testing of the ≤5 cap (Q&A answer 2 — ground truth):** this slice owns ONLY the serve + delete routes in `photos.ts`. The `POST /api/listings/:id/photos` upload route (owner, multipart, single repeated `photos` field, `MAX_PHOTOS_PER_LISTING = 5`, `count(*)` pre-check, `existing + i` positional insert, all-or-nothing, 400/404/409 semantics, `processImage` compression) ALREADY EXISTS and is preserved verbatim in `src/server/routes/listings.ts`; its ≤5 behavior is asserted by the existing `test/listings-photos.test.ts`. Do NOT re-declare, re-home, move, rename, or re-prefix that upload route into `photos.ts`, do NOT modify `listings.ts`, and do NOT add a duplicate ≤5-cap case to `test/photos.test.ts`.
- Wire the serve/delete routes under `new Hono<AuthEnv>().basePath('/api/photos')` and keep `export const app` so the module continues to ride the app shell's `.route('/', photos.app)` chain in `src/server/index.ts` (imported as `./routes/photos`). Do not re-home, rename, or re-prefix the base path; keep `/api/photos/:id` resolving for both GET and DELETE. Do not add a route to this module that does not reproduce the pinned `/api/photos/:id` path.
- GET serving semantics (pinned): the `size` query is `z.object({size: z.enum(['thumb', 'full']).default('full')})`, so absent `size` defaults to `full`. `size=thumb` returns `thumb_data`; `size=full` returns `full_data`. Respond 200 with `Content-Type` taken from the row's `content_type` column (effectively `image/webp`, since `processImage` always emits webp and the column defaults to it) and exactly `Cache-Control: public, max-age=31536000, immutable`. A missing UUID and a non-UUID `:id` both collapse to 404 `{message:'Not found'}` — reject a non-UUID via a `z.string().uuid().safeParse` short-circuit **before any SQL**. Any other `size` value → 400 from the default `@hono/zod-validator` handler. No join to `listings`/`users`; no `is_banned` check (banned-seller exclusion is scoped to listing queries, not photo serving). GET has **no** `sessionMiddleware`/`requireAuth`.
- GET bytea handling (Bun quirk #17587, pinned): reads of `bytea` via tagged templates return `Buffer<ArrayBufferLike>`; the handler must cast to `Uint8Array<ArrayBuffer>` for `c.body(...)`.
- DELETE semantics (pinned): owner-only. Ownership is enforced in the `DELETE FROM listing_photos p USING listings l WHERE p.listing_id = l.id AND p.id = ${id} AND l.seller_id = ${c.var.user!.id} RETURNING p.id, p.listing_id` WHERE clause so a missing id or a non-owner caller both yield zero rows and collapse to 404 `{message:'Not found'}` (no 403, no existence leak). DELETE uses `sessionMiddleware, requireAuth` (no cookie → 401 `{message:'Unauthorized'}`; a banned owner → 401 because `sessionMiddleware`/`findUserBySessionCookie` return a `null` user for `is_banned = true`). Respond 204 with an empty body. Do NOT add a separate banned check to the photo handlers (the banned gate is a session concern handled upstream by `sessionMiddleware`).
- **Atomicity (the actual open item this slice resolves, per Q&A answer 1):** the `DELETE … RETURNING` and the survivor compaction MUST run inside ONE `sql.begin(async tx => {...})` transaction. Run the `DELETE … RETURNING` as the **first** statement in the `tx` closure; read `rows[0]`; when no row matched, return 404 **before** commit (the closure returns before compaction, so nothing is committed) — preserving the exact response contract. The current draft's docstring already claims "the delete and the survivor compaction run in one transaction"; make the code deliver it.
- Compaction (pinned): after the DELETE **inside the same transaction**, fetch survivors `SELECT id FROM listing_photos WHERE listing_id = ${listingId} ORDER BY position ASC`; renumber so positions become contiguous `0..n-1` with `position 0` the new cover. Preserve the existing skip-rows-already-at-target-index behavior (per-survivor `SELECT position::int` re-read, `continue` when it equals the target index `i`) — this is what keeps the `unique (listing_id, position)` constraint satisfiable mid-sequence. Never read or write another listing's rows.
- `updated_at` convention is a no-op here (per Q&A answer 3): the compaction UPDATE must touch `position` ONLY. `listing_photos` has no `updated_at` column (only `created_at`, `default now()`); `listings` is the only table carrying `updated_at`. Do not add a column — the fixed schema must not be altered.
- Schema is fixed by `0001_init.sql` — do not alter the table. `listing_photos(id uuid pk, listing_id uuid not null references listings(id) on delete cascade, position smallint not null check (position between 0 and 4), content_type text not null default 'image/webp', full_data bytea not null, thumb_data bytea not null, byte_size integer not null, created_at timestamptz not null default now(), unique (listing_id, position))`.
- Reuse the established helpers and do not re-implement or fork them: `sql` from `src/server/db.ts` (Bun SQL tagged templates only; `sql.unsafe`/`$N` for parameterized string queries; `sql.begin`), `sessionMiddleware`/`requireAuth`/`AuthEnv` from `src/server/auth.ts`. `processImage`/`ImageError` from `src/server/images.ts` are **not** used by this slice (they belong to the upload route in `listings.ts`). Do not modify `images.ts`, `auth.ts`, `db.ts`, `index.ts`, `0001_init.sql`, `listings.ts`, `test/listings-photos.test.ts`, `test/client-api.test.ts`, or any other step's route/page/component.
- Cross-cutting security: zod-validate every input; parameterized queries via Bun SQL tagged templates only — no string interpolation of user values into SQL text. The ownership check is enforced server-side in the DELETE statement.
- TypeScript strictness (tsconfig): `noUncheckedIndexedAccess` → guard `rows[0] === undefined` before dereferencing and use `survivors[i]!` non-null assertions where indexed access is required; `verbatimModuleSyntax` → `import type` for type-only imports (e.g. `import type {AuthEnv} from '../auth'`).
- The same-change test deliverable is `test/photos.test.ts`. The existing suite on disk already drives `app.request()` against `mx5_test` (via `import {app} from '../src/server/index'`, `truncateBeforeFile()` at file scope, per-test parameterized seeding) and covers: byte-equality of served thumb/full, size default, exact `Content-Type`/`Cache-Control` headers, anonymous-vs-authed identity, 404 missing/non-UUID, 400 invalid size, 204 deletes, cover promotion, middle-delete compaction, delete-to-zero + re-delete 404, non-owner 404, no-cookie 401, banned-owner 401, cross-listing isolation. **Extend it — do not shrink it — with an atomicity test for the single-transaction delete+compaction** (see ACCEPTANCE #3). Do not add a ≤5-cap case here.
- `hc<AppType>`-typed client tests in `test/client-api.test.ts` exercise `/api/photos/:id` GET and DELETE and must keep passing — do not reshuffle route paths or response shapes in a way that breaks them.

ACCEPTANCE

- `GET /api/photos/:id` returns the correct bytes for `?size=thumb` (`thumb_data`), `?size=full` (`full_data`), and absent size (defaults to `full`); `Content-Type` equals the row's `content_type` (effectively `image/webp`); `Cache-Control` is exactly `public, max-age=31536000, immutable`; a missing UUID and a non-UUID both return 404 `{message:'Not found'}`; an invalid `size` value returns 400; serving is byte-for-byte identical with and without a session cookie.
- `DELETE /api/photos/:id` returns 204 with an empty body for the owner and 404 `{message:'Not found'}` (no existence leak) for a non-owner, a missing UUID, or a non-UUID; no-cookie and banned-owner sessions return 401 `{message:'Unauthorized'}`; after any owner delete the survivors' positions are contiguous `0..n-1` with `position 0` as the new cover; deleting the only photo leaves the listing with zero photos and a re-delete returns 404; compaction never touches another listing's rows.
- The DELETE and the survivor compaction execute **atomically inside a single `sql.begin` transaction**: the `DELETE … RETURNING` is the first statement in the transaction; when no row matched, 404 is returned before commit; there is no separate auto-committed `DELETE` outside `sql.begin`. This must be verified by a **same-change test in `test/photos.test.ts`**, not just asserted in prose. A concrete, runnable form: seed a listing with N photos, DELETE one photo via `app.request()` (asserting 204), and assert the survivors end at exactly the expected contiguous `0..n-1` positions — and, critically, that **no auto-committed delete precedes the compaction** by asserting the final position set is consistent *immediately after* the response (i.e. the observable end-state that only the single-transaction ordering produces, with no intermediate auto-committed state). Because Bun SQL's `sql.begin` is a black box to the test harness, the test asserts the observable post-commit invariant (contiguous `0..n-1`, cover promoted, no partial state) that the auto-committed-then-compacted draft would also satisfy — so the atomicity guarantee is additionally pinned as a **source constraint** (the `DELETE` and compaction both live inside one `sql.begin` closure, verifiable by reading `photos.ts`), and the test guards against any regression in the compaction observable.
- `test/photos.test.ts` passes against the `mx5_test` database (all GET/DELETE assertions, plus the new atomicity test, green) in the same change.
- `bun run lint` is clean in the same change. In this repo `lint` is pinned to `prettier --log-level warn --write --no-error-on-unmatched-pattern 'src/**/*.{ts,tsx}' 'test/**/*.{ts,tsx}' && eslint --fix . && tsc --noEmit` (see `package.json`), so a clean `bun run lint` runs the prettier, `eslint --fix`, **and** `tsc --noEmit` type-check surface — the pinned type-check gate.
- No sibling files were altered: the upload route in `listings.ts`, the schema in `0001_init.sql`, the app shell in `index.ts`, and `test/client-api.test.ts` / `test/listings-photos.test.ts` continue to resolve and pass unchanged.

VERIFY:
```sh
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# 1) Source-level atomicity guard: the DELETE must be inside the same sql.begin
#    closure as the compaction. Fail loudly if an auto-committed
#    `sql<DeletedPhotoRow[]>` / top-level `sql` DELETE exists outside sql.begin.
#    (This is the check the black-box test harness cannot drive directly.)
if grep -nE "await sql[<` ]" src/server/routes/photos.ts \
   | grep -vE "sql\.(begin|unsafe)" | grep -qE "DELETE FROM listing_photos"; then
  echo "FAIL: a top-level (auto-committed) sql DELETE FROM listing_photos was found in photos.ts;" \
       "the DELETE must be the first statement inside the single sql.begin closure." >&2
  exit 1
fi
# The compaction still lives inside a single sql.begin.
grep -q "sql.begin" src/server/routes/photos.ts

# 2) Bring up the dev Postgres (docker-compose.dev.yml) and wait for readiness.
docker compose -f docker-compose.dev.yml up -d db
for i in $(seq 1 60); do
  docker exec mx5-dev-db pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done
docker exec mx5-dev-db pg_isready -U postgres
# mx5_test is created on first init by docker-entrypoint-initdb.d; ensure it
# exists defensively for a warm volume (idempotent), then confirm migrations are
# applied by test/setup.ts's preloaded runMigrate() at test time.
docker exec mx5-dev-db psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='mx5_test'" | grep -q 1 \
  || docker exec mx5-dev-db psql -U postgres -qc "CREATE DATABASE mx5_test"

# 3) Run the full route/API suite (bun test with no args runs every test/*.test.ts,
#    which includes test/photos.test.ts, test/listings-photos.test.ts, and
#    test/client-api.test.ts). test/setup.ts preloads and migrates mx5_test.
AGENT=1 bun test

# 4) The pinned type-check/lint gate: bun run lint == prettier + eslint --fix + tsc --noEmit.
bun run lint

# 5) Tear down the transient dev Postgres.
docker compose -f docker-compose.dev.yml down
```
<<<TASK_0052>>>
GOAL
Create the missing `test/admin.test.ts` for the MX-5 marketplace Admin API. The route code already exists and is mounted: `src/server/routes/admin.ts` provides `GET /api/admin/users` and `POST /api/admin/users/:id/ban` under `basePath('/api/admin')`, mounted in `src/server/index.ts` (`.route('/', admin.app)` is the last `.route(...)` in the chain, before `serveStatic`/`spaFallback`). Owner-or-admin `DELETE /api/listings/:id` already lives in `src/server/routes/listings.ts`. This slice is NOT a re-author of the routes: it is an in-place verify-and-conform pass over the existing implementations plus the one new deliverable — a single `test/admin.test.ts` written against the real `app` via `app.request()` in the established `bun test` harness (file-scope `truncateBeforeFile()` from `./setup`, per-test FK-aware `TRUNCATE … CASCADE`, seed helpers defined locally via parameterized `sql` templates), mirroring `test/listings.test.ts` / `test/photos.test.ts`.

The new file must cover the surface listed below and, in particular, must ADD the behaviors not yet pinned by the existing test files (`test/auth.test.ts`, `test/listings.test.ts`, `test/photos.test.ts`, `test/rate-limit.test.ts`, `test/app-skeleton.test.ts`): (1) lexicographic `ORDER BY u.id` ordering of the `GET /api/admin/users` response, (2) the `zValidator` 400 for an invalid `{banned}` body issued by an **authenticated admin** (no existing test exercises the ban-body validator as an authenticated admin — the anonymous path 401s before the validator runs), and (3) the full owner-or-admin listing-delete matrix (existing `test/app-skeleton.test.ts` only asserts the route is registered; `test/listings.test.ts` covers no delete assertions). `bun test test/admin.test.ts` passes and `npm run lint` stays clean.

CONSTRAINTS
- `src/server/routes/admin.ts`, `src/server/routes/listings.ts`, `src/server/index.ts`, `src/server/auth.ts`, `src/server/db.ts`, `src/shared/schema.ts`, and all migrations are out of scope — this step is a verify-and-conform over them, not a re-author. Do not rename, reshape, reorder, or re-mock the endpoints, the `basePath('/api/admin')`, the exported `app`, the `AuthEnv` typing, the `requireAdmin`/`sessionMiddleware` usage, or the existing route ordering. The only new file is `test/admin.test.ts`.
- Do NOT add a separate admin listing-delete route and do NOT test one — the design pins "Listing deletion reuses `DELETE /api/listings/:id` (owner-or-admin check) — no separate admin route"; the listing-delete tests target the existing `DELETE /:id` in `src/server/routes/listings.ts`.
- Preserve the pinned response semantics verbatim and assert them exactly: `GET /api/admin/users` returns a bare JSON **array** (no envelope, no `page`/`total`) of exactly `{id, phone, display_name, role, is_banned, listing_count}`; `listing_count` is a JSON number counting ALL of a user's listings regardless of status (active + sold); banned users ARE included (with `is_banned: true`). `POST /api/admin/users/:id/ban` returns exactly `{id, is_banned}`; non-uuid id and unknown uuid both return `404 {message: 'Not found'}` (collapsed). Errors are `401 {message: 'Unauthorized'}` (anonymous OR banned caller), `403 {message: 'Forbidden'}` (authenticated non-admin), `400` (invalid `{banned}` body). `DELETE /api/listings/:id` returns `204` with an empty body on success, `404 {message: 'Not found'}` for a non-owner, `401 {message: 'Unauthorized'}` for anonymous.
- A banned admin's session is rejected by `sessionMiddleware` → 401, never 403. Assert banned-admin → 401 (not 403) on both admin endpoints and on listing delete.
- Banned semantics end-to-end: a banned seller's listings are hidden by the listings routes' `u.is_banned = false` filters while banned and restored on unban; the admin users list is the one place banned users are shown (with their counts). (This behavior is already covered by `test/listings.test.ts`; do NOT re-test it in `test/admin.test.ts` — keep the file focused on the admin endpoints and the listing-delete matrix.)
- Self-ban is permitted by the existing route: an admin POSTing `{banned: true}` for their own id returns 200 `{id, is_banned: true}`, and that admin's session then 401s on subsequent requests. Do not expect 400 on self-ban.
- The `zValidator` 400 must be exercised as an **authenticated admin** (chain is `sessionMiddleware → requireAdmin → zValidator`, so an anonymous/401 or non-admin/403 path never reaches the validator). Because `@hono/zod-validator` 0.8.0's exact 400 body is not pinned anywhere in the repo, assert only `res.status === 400` (do not assert a specific 400 body shape). For the invalid-body case, send a malformed body (e.g. `{banned: 'nope'}`) with a VALID uuid `:id` so the validator runs before the handler's uuid `safeParse`.
- `ORDER BY u.id` sorts uuids **lexicographically as text** (ids are `gen_random_uuid()`), not by insertion order. Seed ≥3 users, assert the returned array length matches the seeded user count, and assert `body.map(u => u.id)` equals `[...ids].sort()` (JS default string sort = lexicographic), not insertion sequence.
- Follow the existing test conventions exactly: `test/admin.test.ts` calls `truncateBeforeFile()` at file scope; `beforeEach` runs FK-aware `TRUNCATE listing_photos, listings, sessions, users CASCADE` (children-first, the 4-table listings-family form matching `test/listings.test.ts`); seed users/sessions/listings via parameterized `sql` templates (Bun SQL tagged templates, `${v}` or `sql.unsafe(sqlText, params)` with `$N`); never interpolate values into SQL. Replicate the per-file seed helpers (no shared seed module): `insertUser` (`hashPassword('password123')`, parameterized `INSERT … RETURNING id`, `role` override for admin, `isBanned` override), `issueSessionCookie` (32-byte random hex value + `sha256Hex` stored in `sessions.token_hash`, `expires_at = now() + SESSION_MAX_AGE_SECONDS`), and a listing inserter with fixed `('2026-01-01 00:00:00+00' || '')::timestamptz` cast timestamps (Bun timestamptz quirk). `sha256Hex` mirrors the module-private `auth.ts` implementation (not exported).
- Hit the real app via `app.request()` from `src/server/index.ts` (not a throwaway app). Send the session cookie as `{cookie: \`${SESSION_COOKIE_NAME}=${cookieValue}\`}`. Import `SESSION_COOKIE_NAME`, `SESSION_MAX_AGE_SECONDS`, `hashPassword` from `src/server/auth` and `truncateBeforeFile` from `./setup`.
- Do not touch the rate limiter: the admin and listings routes are not rate-limited by design (only login/invite-create/invite-redeem are). Keep request counts modest; the tests hit only admin/listings endpoints, which never consume the limiter, so `test/rate-limit.test.ts`'s module-singleton isolation is unaffected.
- Do not create any client page, `hc<AppType>` wiring, or `test/ct` spec (the `/admin` page and typed client are later steps). No new npm dependencies. Preserve all existing `package.json` scripts/dependencies, the `bunfig.toml` `[test] preload`/`pathIgnorePatterns`, and the Playwright CT config; `test/ct` stays outside `bun test` discovery.
- Satisfy the strict `tsconfig.json` (`noUncheckedIndexedAccess`, `noUnusedLocals/Parameters`) and house style in the new test file: 4-space indent, single quotes, no semicolons, print width 120, no bracket spacing; one-line `if` (no braces for single-statement conditionals); named `type` for any object type with >2 properties (no inlined object types). The file is type-checked and prettier-formatted by `npm run lint`.

ACCEPTANCE
- `test/admin.test.ts` exists on disk and is the only file this change adds; it imports `truncateBeforeFile` from `./setup`, the real `app` from `src/server/index.ts`, and the seed primitives from `src/server/auth` + `src/server/db`.
- The new file asserts the `ORDER BY u.id` lexicographic ordering of `GET /api/admin/users`: for a set of seeded users, `body.map(u => u.id)` deep-equals `[...seededIds].sort()`.
- The new file asserts the users-list content/shape: a bare JSON array where every entry has exactly the keys `{id, phone, display_name, role, is_banned, listing_count}`; per-user `listing_count` equals the actual count of all that user's seeded listings (regardless of active/sold status); banned users are present with `is_banned: true`.
- The new file asserts both `requireAdmin` gates on BOTH endpoints: anonymous → 401 `{message:'Unauthorized'}`, authenticated member → 403 `{message:'Forbidden'}`, banned admin → 401 `{message:'Unauthorized'}` (never 403), and a valid admin → 200.
- The new file asserts the ban/unban round-trip: `POST {banned: true}` → 200 `{id, is_banned: true}` flipping `users.is_banned`; `POST {banned: false}` → 200 `{id, is_banned: false}` restoring it.
- The new file asserts ban 404s (non-uuid id and unknown uuid both → 404 `{message:'Not found'}`) and the authenticated-admin invalid-body case → 400 (status only, no body-shape assertion).
- The new file asserts the owner-or-admin `DELETE /api/listings/:id` matrix: owner → 204 empty body + row gone, admin → 204 on a non-owned listing + row gone, non-owner member → 404 `{message:'Not found'}` + row unchanged, anonymous → 401 `{message:'Unauthorized'}`.
- `bun test test/admin.test.ts` (run with `AGENT=1`) passes in full against the local Postgres.
- `npm run lint` (prettier + eslint + `tsc --noEmit`) exits 0 — the new file is type-clean under the strict config and prettier-formatted.
- The full suite (`npm test`) passes; nothing in `src/` was changed.

VERIFY:
```sh
set -eu
cd /workspace
[ -f test/admin.test.ts ] || { echo "FAIL: test/admin.test.ts missing"; exit 1; }
# Ensure Postgres is running (uses the repo's compose file; the test harness
# in test/setup.ts auto-migrates mx5_test before any test file loads).
if ! psql "${DATABASE_URL%/}/" -c 'SELECT 1' >/dev/null 2>&1; then
    docker compose -f "$(ls docker-compose*.yml 2>/dev/null | head -1)" up -d
    for i in $(seq 1 30); do
        psql "${DATABASE_URL%/}/" -c 'SELECT 1' >/dev/null 2>&1 && break
        sleep 1
    done
    psql "${DATABASE_URL%/}/" -c 'SELECT 1'
fi
AGENT=1 bun test test/admin.test.ts
npm run lint
AGENT=1 bun test
```
<<<TASK_0053>>>
GOAL
Step 20 of the mx5-private plan is verification-only: the build pipeline is already byte-identical to DESIGN/PROJECT.md §9 — `build.ts`'s non-watch path is exactly `Bun.build({entrypoints: ['src/client/main.tsx'], outdir: 'dist', minify: true, splitting: true})` and `package.json`'s `build` script is exactly `bunx @tailwindcss/cli -i src/client/index.css -o dist/app.css && bun build.ts && cp index.html dist/index.html` — so the deliverable is a new `test/*.test.ts` spec that shells out to the full `bun run build` once and proves the pipeline end-to-end: exit code 0, and the three artifacts `dist/main.js` (matching `index.html`'s `<script src="/main.js">`), `dist/app.css` (Tailwind v4-compiled from `src/client/index.css`, containing the OKLCH brand tokens with no literal `@import "tailwindcss"` remaining), and `dist/index.html` (copied shell) all exist; the spec fails loudly if any leg of the pipeline breaks.

CONSTRAINTS
  - "**Client CSS:** `bunx @tailwindcss/cli -i src/client/index.css -o dist/app.css`" [§9 Build & run] — owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)
  - "Bundled with **`Bun.build`** (JS/TSX); CSS via **`@tailwindcss/cli`** `4.3.2`" [§2 Tech stack — Client] — owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)
- The delta for this step is a verification-only pass (per the Q&A answer to Q1, confirmed against the source): `build.ts` and the `package.json` `build`/`dev` scripts already satisfy DESIGN/PROJECT.md §9 verbatim. Do NOT modify `build.ts`, `package.json`, `src/client/main.tsx`, `src/client/index.css`, `src/client/api.ts`, `src/client/components/**`, `src/server/**`, `index.html`, `tsconfig.json`, `eslint.config.js`, `.prettierrc.cjs`, `bunfig.toml`, `DESIGN/**`, or any dependency pin (`@tailwindcss/cli` 4.3.2 / `tailwindcss` 4.3.2 stay as-is). The only new file is the build spec under `test/`.
- The spec must invoke the full `bun run build` script — not just `bun build.ts` — so all three artifacts (`dist/main.js`, `dist/app.css`, `dist/index.html`) are produced and verified end-to-end (Q1 answer, binding). `@tailwindcss/cli` resolves locally from `dependencies`, so no network fetch is expected.
- Shell out via `spawn(['bun', 'run', 'build'], …)` from the `bun` module as declared in `src/shared/bun-types.d.ts` (`spawn(cmd: string[], opts?) => {exited: Promise<number>; kill(signal?): boolean}`) and assert the child's exit code is 0. Do NOT import `build.ts` into the spec — it calls `process.exit(0)` even on success, which would kill the test runner. The `&&` chain means any of tailwind / `bun build.ts` / `cp` failing makes the whole command non-zero, so exit 0 covers all three legs.
- Run the build exactly once per spec file, in a `beforeAll` (follow the fixture/hook pattern of the existing `test/shell-static.test.ts`: `beforeAll`/`afterAll`/`describe`/`test`/`expect` from `bun:test`, `path`/`node:fs` for artifact checks, `import.meta.dir`-relative paths). `dist/` is gitignored and may be absent, so the spec must not assume pre-existing artifacts — it must build them itself before asserting.
- Assert existence of exactly the three named artifacts (`dist/main.js`, `dist/app.css`, `dist/index.html`); do NOT assert an exhaustive file listing of `dist/`, because `splitting: true` additionally emits hashed chunk files whose names are not stable.
- For `dist/app.css`, assert it is compiled Tailwind v4 output, not the raw entry: (a) no literal `@import "tailwindcss"` remains (the import was expanded), and (b) at least one verbatim OKLCH brand token value extracted from `src/client/index.css`'s `@theme` block is present in the compiled output — `@theme` custom-property values pass through Tailwind v4 compilation verbatim. The spec should read `src/client/index.css` at test time, extract one or more `oklch(…)` values from the `@theme` section, and assert at least one of them appears in `dist/app.css`. Do NOT hardcode a specific oklch literal in the spec, because `src/client/index.css` is owned by step 21 and its exact values are not pinned by this spec.
- If the spec run proves the entry bundle is NOT named `dist/main.js` (an open item: `outdir: 'dist'` + `splitting` may alter naming), do NOT add `entryFileNames` to `build.ts` — that would modify a pinned file; instead report the actual output name in the failure so the pipeline fix is explicit, not guesswork. The primary expectation is that `dist/main.js` exists.
- The spec lives in `test/` as `*.test.ts`, which lands under the `[test] preload` of `test/setup.ts` (rewrites `DATABASE_URL` to `/mx5_test` and runs `runMigrate()` before any test file loads) — so executing the spec requires the reachable Postgres + `.env` that the rest of `bun test` already requires; that is accepted and required (offline envs won't silently pass, per Q1). Do not attempt to opt out of the preload; do not call `truncateBeforeFile()` (the build spec does not touch DB tables).
- Cover the one-shot `bun run build` path only. Do not test, spawn, or depend on the `--watch` 3-process pipeline in `build.ts` (three concurrent watchers + `bun:ffi` SIG_IGN/setsid hardening); leave every watch-path behavior untouched.
- Repo conventions (AGENTS.md): code style is Prettier-owned — 4-space indent, no semicolons, single quotes, no bracket spacing, print width 120, LF; one-line single-statement `if` without braces (`if (!result.success) return`); named `type` declarations instead of inline object types with more than 2 properties; reuse existing types before creating new ones. Run `bun run lint` so the new file is formatted and passes.
- Test-first cadence (binding): the build-pipeline test lands in the same change as the pipeline it covers and must pass; a pipeline without a passing spec is not done.

ACCEPTANCE
- A new spec file `test/*.test.ts` is the only change in the tree; `git status` shows just that one untracked file (no edits to `build.ts`, `package.json`, `src/`, `index.html`, configs, or lockfile).
- The spec shells out to the full `bun run build`, waits for the child, and asserts exit code 0; a broken pipeline leg (tailwind CLI, `bun build.ts`, or the `cp index.html dist/index.html`) makes the spec fail with a non-zero assertion, not pass.
- After the spec runs the build, all three artifacts exist and are non-trivial: `dist/main.js` (the exact name `index.html`'s `<script type="module" src="/main.js">` references), `dist/app.css`, `dist/index.html`.
- `dist/app.css` contains compiled Tailwind v4 output: no literal `@import "tailwindcss"` string remains, and at least one OKLCH token value present in `src/client/index.css`'s `@theme` block appears verbatim in the compiled CSS (proving the `@theme` tokens survive compilation rather than being stripped or transformed).
- `dist/index.html` is a byte-for-byte copy of the repo-root `index.html`.
- `dist/main.js` was built from `src/client/main.tsx` as-is (the placeholder mount) — the pipeline succeeds against the entrypoint's current content with no edits.
- The full `AGENT=1 bun test` run (which runs the whole `test/` suite under the `test/setup.ts` preload) passes, including the new build spec and the existing `test/shell-static.test.ts` (whose conditional real-`dist/` assertions now take the built branch).
- `bun run lint` (`prettier --write … && eslint --fix . && tsc --noEmit`) passes with the new spec in place; the spec conforms to the pinned Prettier 3.9.4 / ESLint 10.6.0 / TypeScript 6.0.3 strict config.

VERIFY:
```sh
# Confirm the new spec file exists in test/ (not shell-static)
test -n "$(ls test/*.test.ts | grep -Ev 'shell-static' | head -n1)" && ls -l test/*.test.ts

# Confirm no tracked files were modified (only new untracked test file is allowed)
git status --porcelain | grep -Ev '^\?\? test/' | grep -v '^$' && exit 1 || true

# Ensure Postgres is up (test/setup.ts preload requires it)
docker compose -f docker-compose.dev.yml up -d db

# Run the full build pipeline
bun run build

# All three artifacts must exist and be non-empty
test -s dist/main.js && test -s dist/app.css && test -s dist/index.html

# dist/index.html must be a byte-for-byte copy of the repo-root index.html
cmp -s dist/index.html index.html

# No raw @import "tailwindcss" should remain in compiled CSS
! grep -qF '@import "tailwindcss"' dist/app.css

# At least one OKLCH token from src/client/index.css must appear verbatim in dist/app.css
# (extract a token dynamically from the source rather than hardcoding a specific value)
TOKEN=$(grep -oP 'oklch\(\K[0-9]+% [0-9.]+ [0-9]+' src/client/index.css | head -n1) && \
  test -n "$TOKEN" && grep -qF "oklch($TOKEN)" dist/app.css

# Run the new build spec in isolation
AGENT=1 bun test test/build.test.ts

# Run the full test suite (new spec + existing specs)
AGENT=1 bun test

# Lint / format / typecheck
bun run lint
tsc --noEmit
```
<<<TASK_0054>>>
GOAL

An in-place update of the already-existing `src/client/index.css` so it fully ports the Kodo/JDM/synthwave brand from `DESIGN/brand-spec.md` (`DESIGN/PROJECT.md` authoritative where they differ) into Tailwind v4 `@theme` / `@theme inline` tokens, a brand-dark shadcn semantic layer, base styles, and the four theme-level posture affordances (cinematic gradient, ambient purple glow, grid overlay, hover-glow gradient, technical divider, mono/katakana label) — so `bun run build` produces `dist/app.css` from this file and every later client step (shadcn restyle step 22, pages steps 24–32) can resolve `bg-background`, `text-foreground`, `border-border`, `bg-accent` (Soul Red), `ring-ring` (Soul Red), `font-mono`, and the named posture classes. This step ships its own committed Playwright CT theme-probe spec with a `toHaveScreenshot` baseline; it is not done until that test passes.

CONSTRAINTS
  - "Premium, minimal, Kodo/JDM/synthwave aesthetic (see `DESIGN/brand-spec.md`). Extremely simple, but fancy." [Project Design intro] — owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)

- Update the existing `src/client/index.css` in place. Line 1 must remain `@import "tailwindcss"` (build pipeline step 20 feeds this exact file to `bunx @tailwindcss/cli -i src/client/index.css -o dist/app.css`). Do not recreate, empty, or collapse the file into a minimal token list. Do not touch `package.json`, `tsconfig.json`, `eslint.config.js`, `build.ts`, `playwright-ct.config.ts`, `test/ct/template/index.tsx`, `test/ct/template/index.html`, `test/ct/demo.spec.tsx`, `index.html`, or any `src/server/**`, `src/shared/**` file.
- All 10 brand color tokens in the first `@theme` block must match `DESIGN/brand-spec.md` verbatim: `--bg: oklch(14% 0.008 260)`, `--surface: oklch(18% 0.006 260)`, `--surface-2: oklch(22% 0.008 260)`, `--fg: oklch(92% 0.006 260)`, `--muted: oklch(55% 0.010 260)`, `--border: oklch(25% 0.006 260)`, `--accent: oklch(52% 0.22 25)` (Soul Red), `--accent-2: oklch(62% 0.18 310)`, `--accent-3: oklch(65% 0.15 220)`, `--glow: oklch(55% 0.20 290)`. Do not tidy values, add alpha-suffixed variants as the primary token, or introduce a light theme / `.dark` scope — the brand is dark-only.
- Font stacks stay exactly as in the brand spec: `--font-display: Hiragino Sans, Noto Sans JP, -apple-system, sans-serif;`, `--font-body: -apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif;`, `--font-mono: ui-monospace, SF Mono, Menlo, monospace;`. Mono is reserved for part numbers/specs/labels, not body copy.
- Radii: 0–4px only (sharp Kodo edges, never soft). Add a 0/1/2/4px scale (`--radius-sm: 1px`, `--radius-xs: 2px`, keep `--radius: 4px`) in the `@theme` block. No large rounded radii anywhere.
- Keep the existing `:root` shadcn semantic layer and `@theme inline` mapping structure (it already "keeps" both per the task). The only required change to the semantic layer is `--destructive`: re-derive it from the Soul Red brand hue as `oklch(55% 0.20 25)` (per Q2) so `bg-destructive` / `text-destructive` sit on the same red family as `--accent` / `--primary`. Do not keep the old `oklch(55% 0.21 27)`. `--primary` and `--ring` must resolve to Soul Red `oklch(52% 0.22 25)` (they already do via `var(--accent)` — preserve that). Do not invent a "shadowing bug" or "circular-var bug" fix: the existing `:root` redefinitions of `--accent` (→ `--accent-2`), `--muted` (→ `--surface-2`), and `--border` (→ `var(--border)`) are the current intended state and are not defects; leave them as-is unless the Q&A ground truth says otherwise.
- The shadcn semantic layer (`--background`, `--foreground`, `--card`, `--card-foreground`, `--popover`, `--popover-foreground`, `--primary`, `--primary-foreground`, `--secondary`, `--secondary-foreground`, `--muted`, `--muted-foreground`, `--accent`, `--accent-foreground`, `--destructive`, `--destructive-foreground`, `--border`, `--input`, `--ring`) is defined once under `:root` (dark-only, no `.dark` scope) and mapped into `@theme inline` so that `bg-background`, `text-foreground`, `border-border`, `ring-ring`, `bg-primary`, `bg-destructive`, etc. resolve for the step-22 restyle. The `@theme inline { --radius: var(--radius) }` self-reference is the canonical shadcn Tailwind v4 pattern (inline themes do not emit the CSS variable) and is safe — keep it.
- Commit all posture affordances as reusable named plain-CSS classes in the body layer (outside `@theme`, so `test/build.test.ts`'s `extractBodyOkLchTokens` regex still passes), using **exactly** these oklch values (per Q1 ground truth):
  - `.bg-cinematic` — stacked radial gradients + `linear-gradient(180deg, oklch(10% 0.005 260), oklch(14% 0.008 260) 50%, oklch(10% 0.005 260))`.
  - `.glow-ambient` — radial `oklch(55% 0.20 290 / 0.04)` with `filter: blur(60px)`, ~500px blob.
  - `.grid-overlay` — 60px `repeating-linear-gradient` at `oklch(25% 0.006 260 / 0.06)`.
  - A hover-glow class — overlay `linear-gradient(135deg, oklch(52% 0.22 25 / 0.12) 0%, oklch(62% 0.18 310 / 0.06) 100%)` fading in at `opacity 0→1` over 0.3s.
  - `.divider-text` — 11px / weight 500 mono, `letter-spacing: 0.15em`, uppercase, `::before` / `::after` 1px flex lines in `var(--border)`.
  - A mono/katakana label class — 10–13px, weight 500–600, `letter-spacing: 0.06em`–`0.15em`, uppercase, `var(--font-mono)`.
  These are theme-level posture only — do NOT port the mockups' page-specific component CSS (nav, search bar, part-card, pagination) into this file.
- Base element styles: `body` keeps `background: var(--bg)`, `color: var(--fg)`, `font-family: var(--font-body)`, `-webkit-font-smoothing: antialiased`, `-moz-osx-font-smoothing: grayscale`. Do not fight `index.html`'s pre-hydration inline `<style>`.
- Do NOT build shadcn/ui components (step 22), the client shell / `main.tsx` (step 24), pages (steps 25–32), or `api.ts` (step 23) — this step owns the theme CSS and its CT test only.
- Test-first cadence (design §10): this step ships its own Playwright CT spec (under `test/ct/`) that renders a minimal themed probe (using the tokens and posture classes from `index.css`) and captures a committed `toHaveScreenshot` baseline under `test/ct/__screenshots__/<spec>.tsx/`. The step is not done until it passes. Do not batch testing to a later step.
- The new CT spec's probe must be themed by `index.css`. The CT template (`test/ct/template/index.html`) has no stylesheet link; the spec must pull `index.css` in itself (inline `<style>` with the relevant token values, or a `<link>` / `@import` injected by the spec) so the baseline reflects the brand. Verify against Playwright 1.61.1 CT docs whether Tailwind-generated utilities (`bg-background`, `text-foreground`) are compiled inside a CT probe; if not, the probe must assert on `var(--bg)`-style inline styles or `getComputedStyle` of the CSS variables.
- The existing committed baseline `test/ct/__screenshots__/demo.spec.tsx/demo.png` must keep passing unchanged. Do not modify `test/ct/demo.spec.tsx` or its baseline.
- `bun test` drives both legs (`AGENT=1 bun test && … playwright test -c playwright-ct.config.ts`), so the new CT spec must pass under the plain `test` script (i.e. `bun run test`), not only `bun run test:ct`.
- Do not bump `tailwindcss` / `@tailwindcss/cli` from 4.3.2 (`package.json` is off-limits).
- Verify Tailwind v4 `@theme` / `@theme inline` syntax against the pinned `tailwindcss` 4.3.2 docs before changing anything — don't guess from memory.

ACCEPTANCE

- `src/client/index.css` line 1 is `@import "tailwindcss"`; the first `@theme` block carries all 10 brand color tokens verbatim, the three brand font stacks, and a 0/1/2/4px radius scale; no light theme / `.dark` scope; no radii above 4px.
- The shadcn `:root` semantic layer is defined once (dark-only); `--primary` and `--ring` resolve to Soul Red `oklch(52% 0.22 25)`; `--destructive` is exactly `oklch(55% 0.20 25)` (not the old `oklch(55% 0.21 27)`).
- The `@theme inline` mapping registers every semantic token so `bg-background`, `text-foreground`, `border-border`, `ring-ring`, `bg-primary`, `bg-destructive` resolve for the step-22 shadcn restyle.
- All posture classes are committed as named plain-CSS classes in the body layer with **exactly** the oklch values pinned in the CONSTRAINTS above: `.bg-cinematic` (includes `oklch(10% 0.005 260)` and `oklch(14% 0.008 260)` in its 180deg linear stop), `.glow-ambient` (includes `oklch(55% 0.20 290 / 0.04)`), `.grid-overlay` (includes `oklch(25% 0.006 260 / 0.06)`), a hover-glow class (includes `oklch(52% 0.22 25 / 0.12)` and `oklch(62% 0.18 310 / 0.06)`), `.divider-text` (11px/500 mono, `letter-spacing: 0.15em`, uppercase, `::before`/`::after` 1px `var(--border)` lines), and a mono/katakana label class (10–13px, weight 500–600, `letter-spacing: 0.06em`–`0.15em`, uppercase, `var(--font-mono)`). Nav/search/part-card/pagination component CSS is NOT in the file.
- `bun run build` exits 0 and produces a non-empty `dist/app.css` with `@import "tailwindcss"` expanded (no literal `@import "tailwindcss"` in the output).
- `bun test` passes, including `test/build.test.ts` (which spawns the full build and asserts oklch body-layer tokens survive verbatim into `dist/app.css`).
- A new Playwright CT spec under `test/ct/` renders a themed probe, captures a committed `toHaveScreenshot` baseline under `test/ct/__screenshots__/<spec>.tsx/`, and passes under `bun run test`.
- The existing `test/ct/demo.spec.tsx` and its committed baseline still pass unchanged.
- `bunx tsc --noEmit` and `bun run lint` pass (the new CT spec is well-typed and formatted).

VERIFY:
```sh
cd /workspace

# 1. Full build pipeline (tailwind CLI + Bun.build + cp) must exit 0
bun run build || { echo "FAIL: bun run build exited non-zero"; exit 1; }

# 2. dist/app.css exists, non-empty, @import expanded
test -s dist/app.css || { echo "FAIL: dist/app.css missing or empty"; exit 1; }
grep -q '@import "tailwindcss"' dist/app.css && { echo "FAIL: @import not expanded"; exit 1; }

# 3. Q2 ground truth: --destructive re-derived to oklch(55% 0.20 25), old value gone
grep -qE -- '--destructive:\s*oklch\(55%\s*0\.20\s*25\)' src/client/index.css \
  || { echo "FAIL: --destructive is not oklch(55% 0.20 25)"; exit 1; }
grep -qE -- '--destructive:\s*oklch\(55%\s*0\.21\s*27\)' src/client/index.css \
  && { echo "FAIL: old --destructive oklch(55% 0.21 27) still present"; exit 1; }

# 4. --primary and --ring must resolve to Soul Red (oklch(52% 0.22 25) or var(--accent))
grep -qE -- '--primary:\s*(var\(--accent\)|oklch\(52%\s*0\.22\s*25\))' src/client/index.css \
  || { echo "FAIL: --primary does not resolve to Soul Red"; exit 1; }
grep -qE -- '--ring:\s*(var\(--accent\)|oklch\(52%\s*0\.22\s*25\))' src/client/index.css \
  || { echo "FAIL: --ring does not resolve to Soul Red"; exit 1; }

# 5. Four posture named classes must be present in the source
for cls in '.bg-cinematic' '.glow-ambient' '.grid-overlay' '.divider-text'; do
  grep -qE -- "^${cls}\b" src/client/index.css \
    || { echo "FAIL: posture class ${cls} missing"; exit 1; }
done

# 6. Posture oklch literals must survive verbatim into dist/app.css
for tok in 'oklch(10% 0.005 260)' 'oklch(14% 0.008 260)' 'oklch(55% 0.20 290 / 0.04)' \
           'oklch(25% 0.006 260 / 0.06)' 'oklch(52% 0.22 25 / 0.12)' 'oklch(62% 0.18 310 / 0.06)'; do
  grep -qF "$tok" dist/app.css || { echo "FAIL: posture token '$tok' missing from dist/app.css"; exit 1; }
done

# 7. All 10 brand tokens present verbatim in source
for tok in 'oklch(14% 0.008 260)' 'oklch(18% 0.006 260)' 'oklch(22% 0.008 260)' \
           'oklch(92% 0.006 260)' 'oklch(55% 0.010 260)' 'oklch(25% 0.006 260)' \
           'oklch(52% 0.22 25)' 'oklch(62% 0.18 310)' 'oklch(65% 0.15 220)' 'oklch(55% 0.20 290)'; do
  grep -qF "$tok" src/client/index.css || { echo "FAIL: brand token '$tok' missing from source"; exit 1; }
done

# 8. Typecheck + lint (covers the new CT spec)
bunx tsc --noEmit || { echo "FAIL: tsc --noEmit"; exit 1; }
bun run lint || { echo "FAIL: bun run lint"; exit 1; }

# 9. Full test suite (bun test + playwright CT leg)
bun run test || { echo "FAIL: bun run test"; exit 1; }

# 10. Existing demo baseline still present and untouched
test -f test/ct/__screenshots__/demo.spec.tsx/demo.png \
  || { echo "FAIL: demo baseline missing"; exit 1; }

echo "PASS: all checks passed"
```
