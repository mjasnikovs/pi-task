# MX-5 Private — Project Design

Invite-only used-parts marketplace for a local Mazda MX-5 club. Premium, minimal,
Kodo/JDM/synthwave aesthetic (see `DESIGN/brand-spec.md`). Extremely simple, but fancy.

---

## 1. Decisions (locked)

| Topic | Decision |
|---|---|
| **Admin role** | Moderator only. Everyone (incl. admin) invites equally. Admin extras: ban users, delete any listing. Admin is the seeded root account. |
| **Buyer → seller contact** | "Contact seller" button on the listing detail page reveals the seller's phone (+ optional per-listing contact note, e.g. "call after 18:00"). Gated behind login. No messaging/threads. |
| **Region / currency** | EUR (`€`). Phone numbers international, stored E.164. UI in English. (Mockup `$` → `€`.) |
| **Listing fields** | Title, description, price, generation (NA/NB/NC/ND), type (OEM/Aftermarket), condition (New/Used), **location**, **OEM part number**, optional contact note, up to 5 photos. Photos optional — a branded placeholder shows if none. Badges (OEM/New) derived from type/condition. |
| **Listing lifecycle** | Seller can **Edit / mark Sold (undoable) / Delete**. Sold stays in the grid and detail by default, greyed with a `SOLD` badge. No auto-expiry. Listings of banned users are hidden while banned (restored on unban). |
| **Join flow** | Member generates a **unique invite link** (URL token), shares via SMS/WhatsApp. Link opens a pre-validated signup form (phone + password). No email, no recovery, no "request invitation". |
| **Auth** | Phone (E.164) + password. Cookie sessions in Postgres. No email/recovery. |
| **Photo storage** | Compressed on server with `sharp`, stored as `bytea` in Postgres, served via a streaming route with cache headers. |
| **Repo / deploy** | Single package, no workspaces — server/client/shared side by side under `src/`. Runs locally with `bun`; dev Postgres via docker-compose. Production host decided later. |

---

## 2. Tech stack (pinned to latest, 2026-07)

**Runtime:** Bun `1.3.14`

**Server**
- `hono` `4.12.27` — HTTP framework, RPC (`hono/client`)
- `@hono/zod-validator` `0.8.0` — request validation
- `zod` `4.4.3` — schemas (shared client/server)
- `sharp` `0.35.3` — image compression
- Postgres 18 (latest stable, 18.4 as of 2026-07) via **Bun's built-in SQL client** (`import { sql, SQL } from "bun"` — no `bun:sql` module exists) — no ORM
- `Bun.password` (argon2id) for password hashing — built in, no dependency

**Client**
- `react` / `react-dom` `19.2.7`
- `wouter` `3.10.0` — tiny SPA router
- Tailwind CSS `4.3.2` + shadcn/ui components
- Bundled with **`Bun.build`** (JS/TSX); CSS via **`@tailwindcss/cli`** `4.3.2`

**Testing:**
- **Route/API:** `bun test` + `hono` `app.request()` (see hono.dev testing guide).
- **Client/UI:** Playwright `1.61.1` React component tests (`@playwright/experimental-ct-react`) with
  **visual confirmation** — every component/page test captures a screenshot committed as a baseline.

**Code style / tooling** (copied from `~/hub/aiz-*`, unified on **spaces**, tabWidth 4)
- Prettier `3.9.4` — `printWidth 120`, no semicolons, single quotes, no bracket spacing,
  `arrowParens: avoid`, LF. Config: `.prettierrc.cjs` (aiz-server variant).
- ESLint `10.6.0` flat config (`eslint.config.js`) — `typescript-eslint` `8.62.1`
  `recommendedTypeChecked`; `no-explicit-any: error`, `no-shadow: error`,
  unused-vars ignore `^_`; client packages add `react-hooks` + `react-refresh`.
- TypeScript `6.0.3` — one strict `tsconfig.json`: `strict`,
  `noUncheckedIndexedAccess`, `noUnusedLocals/Parameters`, `noFallthroughCasesInSwitch`,
  `verbatimModuleSyntax`, `forceConsistentCasingInFileNames`.
- Scripts (keep the existing `package.json` `lint` and `test`, extend — don't replace):
  `lint` = `prettier --write 'src/**/*.{ts,tsx}' && eslint --fix . && tsc --noEmit`;
  `test` = `AGENT=1 bun test` (route/API) — plus a Playwright component run
  (`test:ct` = `playwright test -c playwright-ct.config.ts`) that `test` also drives, so one
  command covers both API and UI/visual tests. Prettier, ESLint, and TypeScript configs stay as pinned above.

---

## 3. Repo layout

Single project, one root `package.json` / `tsconfig.json` / `eslint.config.js` /
`.prettierrc.cjs`. All code under `src/` (server, client, shared side by side).

```
mx5/
├─ package.json                 # single project (no workspaces)
├─ tsconfig.json                # single strict config (server + client)
├─ eslint.config.js             # flat config; per-dir globs for server/client
├─ .prettierrc.cjs
├─ build.ts                     # Bun.build config for the client bundle
├─ docker-compose.dev.yml       # Postgres 18 for local dev
├─ .env                         # DATABASE_URL, APP_URL (for invite links), PORT, ADMIN_PHONE, ADMIN_PASSWORD
├─ DESIGN/                      # existing brand-spec + html mockups (reference)
├─ src/
│  ├─ shared/
│  │  └─ schema.ts              # zod schemas + shared types (listing, auth, invite…)
│  ├─ server/
│  │  ├─ index.ts               # Hono app entry, serves API + built SPA
│  │  ├─ db.ts                  # Bun SQL client (from "bun") + query helpers
│  │  ├─ migrate.ts             # SQL migrations runner
│  │  ├─ seed.ts                # admin seeding
│  │  ├─ migrations/            # 0001_init.sql, …
│  │  ├─ auth.ts                # session middleware, password, requireAuth/requireAdmin
│  │  ├─ images.ts              # sharp compression + thumbnail pipeline
│  │  └─ routes/
│  │     ├─ auth.ts             # login / logout / me
│  │     ├─ invites.ts          # create / validate / redeem(join)
│  │     ├─ listings.ts         # CRUD + search + sold + contact
│  │     ├─ photos.ts           # upload / serve / delete
│  │     └─ admin.ts            # ban user / delete listing
│  └─ client/
│     ├─ main.tsx               # React root + wouter
│     ├─ api.ts                 # typed hono/client (hc<AppType>)
│     ├─ index.css              # @import "tailwindcss" + brand tokens
│     ├─ components/ui/         # shadcn components
│     ├─ components/            # PartCard, PhotoUploader, Nav, …
│     └─ pages/                 # Login, Join, Marketplace, Listing, NewListing, EditListing, MyListings, Admin
└─ test/                        # *.test.ts (app.request based)
```

---

## 4. Data model (Postgres)

```sql
-- users
id            uuid pk default gen_random_uuid()
phone         text unique not null          -- E.164, e.g. +37120000000
password_hash text not null                 -- Bun.password (argon2id)
display_name  text not null
role          text not null default 'member'  -- 'member' | 'admin'
is_banned     boolean not null default false
invited_by    uuid null references users(id)
created_at    timestamptz not null default now()

-- invites (one-time links)
id          uuid pk
token       text unique not null            -- random url-safe, in /join/:token
created_by  uuid not null references users(id)
used_by     uuid null references users(id)
expires_at  timestamptz not null            -- now() + 14 days
used_at     timestamptz null
created_at  timestamptz not null default now()

-- sessions (cookie auth)
id          uuid pk
token_hash  text unique not null            -- sha256 of cookie value
user_id     uuid not null references users(id) on delete cascade
expires_at  timestamptz not null
created_at  timestamptz not null default now()

-- listings
id           uuid pk
seller_id    uuid not null references users(id) on delete cascade
title        text not null
description  text not null
price_cents  integer not null               -- EUR, minor units
generation   text not null                  -- 'na' | 'nb' | 'nc' | 'nd'
part_type    text not null                  -- 'oem' | 'aftermarket'
condition    text not null                  -- 'new' | 'used'
location     text null
part_number  text null
contact_note text null                       -- optional, shown only on contact reveal
status       text not null default 'active' -- 'active' | 'sold'
created_at   timestamptz not null default now()
updated_at   timestamptz not null default now()

-- listing_photos  (max 5 per listing, enforced in app + check)
id           uuid pk
listing_id   uuid not null references listings(id) on delete cascade
position     smallint not null check (position between 0 and 4)  -- first = cover
content_type text not null default 'image/webp'
full_data    bytea not null                 -- compressed, max 1600px edge
thumb_data   bytea not null                 -- ~600px, for grid cards
byte_size    integer not null
created_at   timestamptz not null default now()
unique (listing_id, position)
```

Indexes: `listings(status, created_at desc)`, `listings(generation)`, `listings(part_type)`,
a `pg_trgm` GIN index on `(title || ' ' || description)` for `ILIKE` search,
`sessions(token_hash)`, `invites(token)`.

All `uuid pk` columns default to `gen_random_uuid()`. `updated_at` is set by the app on
every UPDATE (no trigger). Migrations are tracked in a `schema_migrations` table by `migrate.ts`.

**Admin seeding:** on first boot `migrate.ts` (or a `seed` script) creates the single admin
from `ADMIN_PHONE` / `ADMIN_PASSWORD` env vars if no admin exists.

---

## 5. API (Hono RPC, `/api`)

All routes are chained on a single `app` and export `AppType` for the typed client
(`grouping-routes-rpc` pattern). Bodies validated with `@hono/zod-validator` + shared zod schemas.
Field limits (title/description length, price bounds, phone format) live in `src/shared/schema.ts`.

**Required — RPC only (no hand-rolled types):** server↔client communication MUST go through Hono
RPC (`hono/client` `hc<AppType>`), per https://hono.dev/docs/guides/rpc. The client never
hand-writes request/response interfaces or duplicates route shapes — all client types are inferred
from `AppType` (and shared zod schemas). If a call isn't fully typed end-to-end via `hc`, fix the
route chaining/export, don't paper over it with a manual type or `any`.

**Auth** (`routes/auth.ts`)
- `POST /api/auth/login` `{ phone, password }` → sets session cookie, returns user
- `POST /api/auth/logout` → clears session
- `GET  /api/auth/me` → current user or 401

**Invites** (`routes/invites.ts`)
- `POST /api/invites` *(auth)* → creates a one-time link, returns `{ url }`
- `GET  /api/invites/:token` → validate (unused + not expired) for the signup page
- `POST /api/invites/:token/redeem` `{ phone, password, display_name }` → creates user, consumes invite, logs in.
  Consume is atomic (`UPDATE … SET used_at = now() WHERE used_at IS NULL RETURNING …`) so concurrent redeems can't both win.
  Invites are fire-and-forget: no list/revoke UI — lose the link, create a new one.

**Listings** (`routes/listings.ts`)
- `GET  /api/listings?q=&gen=&type=&cond=&sort=&page=&mine=` → paginated cards (12/page), thumbnails via photo route.
  `q` = case-insensitive substring match (ILIKE over title+description, pg_trgm index);
  `sort` = `new` (default) | `price_asc` | `price_desc`; `mine=1` = own listings only (for `/me`).
  Sold listings included by default (greyed in UI); listings of banned sellers excluded everywhere (grid, detail, contact)
- `GET  /api/listings/:id` → full listing + seller `display_name` + photo ids (no phone)
- `POST /api/listings` *(auth)* → create (returns id; photos uploaded next)
- `PATCH /api/listings/:id` *(owner)* → edit fields
- `POST /api/listings/:id/sold` `{ sold: bool }` *(owner)* → mark sold / undo
- `DELETE /api/listings/:id` *(owner or admin)*
- `GET  /api/listings/:id/contact` *(auth)* → `{ phone, display_name, contact_note }` (the reveal action)

**Photos** (`routes/photos.ts`)
- `POST /api/listings/:id/photos` *(owner, multipart)* → compress via sharp, enforce ≤5 total
- `GET  /api/photos/:id?size=thumb|full` → streams bytea with `Content-Type` + `Cache-Control: public, max-age=31536000, immutable`.
  Deliberately unauthenticated: photo ids are unguessable UUIDs, and the cache headers require it. Accepted tradeoff.
- `DELETE /api/photos/:id` *(owner)* → delete + compact remaining positions (so `position 0` is always the cover)

**Admin** (`routes/admin.ts`, `requireAdmin`)
- `GET  /api/admin/users` → all users (id, phone, display_name, role, is_banned, listing count) for the `/admin` page
- `POST /api/admin/users/:id/ban` `{ banned: bool }`
- Listing deletion reuses `DELETE /api/listings/:id` (owner-or-admin check) — no separate admin route.

**SPA fallback:** non-`/api` GETs serve the built `index.html`.

---

## 6. Auth design

- Password hashing: `Bun.password.hash(pw, "argon2id")` / `Bun.password.verify`.
- Login issues a random 32-byte cookie value; store `sha256(value)` in `sessions`.
  Cookie: `HttpOnly; SameSite=Lax; Path=/`, ~30-day expiry; `Secure` only when
  `NODE_ENV=production` (local dev runs plain HTTP). Token is opaque + hashed — nothing is
  signed, so no cookie secret is needed.
- Phone normalization: client input enforces `+`-prefixed E.164; server strips
  spaces/dashes and validates `/^\+[1-9]\d{6,14}$/` (shared zod schema) before lookup/insert,
  so login can't fail on formatting.
- `sessionMiddleware` loads the user onto `c.var.user` (null if none).
- `requireAuth` / `requireAdmin` guards. Banned users are rejected at the middleware.
- No email, no password reset by design — admin can (later) re-issue via DB if needed.

---

## 7. Image pipeline (`images.ts`)

On upload, for each file (accept jpeg/png/webp — **no HEIC**: prebuilt sharp binaries lack
HEIF decode, and iOS Safari auto-converts HEIC→JPEG on web upload anyway; reject >~15 MB
pre-compression):
1. `sharp(buffer).rotate()` (respect EXIF orientation), strip metadata.
2. **Full:** resize longest edge → 1600px (no upscale), `.webp({ quality: 80 })`.
3. **Thumb:** resize longest edge → 600px, `.webp({ quality: 72 })`.
4. Insert one `listing_photos` row (`full_data`, `thumb_data`, `position`).

Enforce max 5 per listing in the handler (count + reject). Cover photo = `position 0`.

---

## 8. Frontend

**Router (wouter):**
| Path | Page | Guard |
|---|---|---|
| `/login` | Sign in (phone + password) | public |
| `/join/:token` | Signup via invite | public (valid token) |
| `/` | Marketplace grid + search/filter/sort/pagination | member |
| `/listing/:id` | Detail, photo gallery, Contact button, Sold/Edit if owner | member |
| `/new` | Post a part (fields + 5-photo uploader) | member |
| `/listing/:id/edit` | Edit listing | owner |
| `/me` | My listings — manage (edit/sold/delete), "Invite a member" button | member |
| `/admin` | Moderation: users (ban), listings (delete) | admin |

- **Styling:** port the mockup CSS into Tailwind v4 theme tokens (OKLCH brand vars in
  `index.css` `@theme`). shadcn components restyled to match (sharp 0–4px radii, Soul Red accent,
  mono labels, katakana accents). Reuse `PartCard`, filter chips, nav from `marketplace.html`.
  Listings without photos render a branded placeholder graphic on card + detail.
- **Data:** typed `hono/client` (`hc<AppType>`) in `api.ts`; small hooks for fetch/mutations.
- Login page = phone + password only (drop the invite tab & "request invitation" from mockup).

---

## 9. Build & run

- **Client CSS:** `bunx @tailwindcss/cli -i src/client/index.css -o dist/app.css`
- **Client JS:** `Bun.build({ entrypoints: ["src/client/main.tsx"], outdir: "dist", minify, splitting })` (in `build.ts`)
- **Server:** `bun run --watch src/server/index.ts` — serves `/api` + static `dist/`.
- **Dev:** docker-compose Postgres + concurrent watch (tailwind, bun build, server).
- **Scripts:** `dev`, `build`, `migrate`, `seed`, `test`.

## 10. Testing

**Test-first cadence (required):** a test lands *as fast as possible* — in the same change — as
each new route or React component/page. No route or component is considered done until its test
exists and passes. Don't batch testing to the end of a milestone.

**Route/API tests** — `app.request(...)` per hono testing guide: auth (login/guards),
invite redeem (one-time, expiry), listing CRUD + ownership, photo upload limit (≤5),
admin ban/delete. Run under `bun test` with `DATABASE_URL` pointing at a separate
`mx5_test` database (same docker-compose Postgres); tests migrate + truncate between runs.

**Client/component tests** — Playwright React component tests
(`@playwright/experimental-ct-react`, config `playwright-ct.config.ts`) for every component and
page: render, assert behavior, and **capture a screenshot** for visual confirmation
(`toHaveScreenshot` baseline committed under `__screenshots__/`). Each new component/page gets its
`*.spec.tsx` alongside it immediately (see cadence above). Mock RPC calls at the network boundary so
component tests stay deterministic and DB-free.

## 11. Security notes

- Argon2id passwords; hashed session tokens; `HttpOnly`/`Secure`/`SameSite` cookies.
- Zod-validate every input; parameterized queries via Bun SQL tagged templates (no string interpolation).
- Ownership/role checks server-side on every mutation; banned-user gate
  (session rejected + their listings filtered from all listing queries).
- Phone reveal only to authenticated members; never ship phone in list/detail payloads.
- Basic rate-limit on login, invite create, and invite redeem (simple in-memory
  counter is fine — single Bun process).

---

## 12. Build order (milestones)

1. **Scaffold** — single-package setup (package.json, tsconfig), docker-compose Postgres, Bun SQL connection, migrations runner, admin seed.
2. **Auth** — sessions, login/logout/me, guards + tests.
3. **Invites** — create/validate/redeem, `/join/:token` page.
4. **Listings API** — CRUD + search/filter/sort/pagination + sold + contact + tests.
5. **Photos** — sharp pipeline, upload (≤5), serve, delete.
6. **Client shell** — Bun build + Tailwind v4 tokens, nav, router, shadcn base, brand port.
7. **Client pages** — Login, Join, Marketplace, Listing, New/Edit, MyListings.
8. **Admin** — ban users, delete listings, `/admin` page.
9. **Polish** — empty/error/loading states, responsive, final brand pass.

---

## 13. Reference docs (for implementers)

Read these before/while building the matching layer. Pinned to the versions in §2.

**Required — search when unsure:** these libraries move fast and are pinned to recent (2026-07)
versions. Whenever an API, signature, config, or best practice is unknown or unclear, use web search
(and the official docs below) to confirm against the pinned version *before* writing code — don't
guess from memory. Verify Bun/Hono/Tailwind/Playwright API names against current docs (e.g. the
`import { sql } from "bun"` gotcha — there is no `bun:sql` module).

**Hono (server)**
- Overview: https://hono.dev/docs/
- Best practices (app structure, `AppType` export): https://hono.dev/docs/guides/best-practices
- RPC guide (typed client, `hc`): https://hono.dev/docs/guides/rpc
- Grouping routes for RPC (the pattern we use): https://hono.dev/examples/grouping-routes-rpc
- Testing (`app.request()`): https://hono.dev/docs/guides/testing
- zod-validator middleware: https://github.com/honojs/middleware/tree/main/packages/zod-validator

**Bun (runtime / DB / build)**
- Postgres via Bun SQL (`import { sql } from "bun"`): https://bun.com/docs/runtime/sql
- Bundler (`Bun.build`): https://bun.com/docs/bundler
- Password hashing (`Bun.password`, argon2id): https://bun.com/docs/api/hashing
- Test runner (`bun test`): https://bun.com/docs/cli/test
- Serving static / files: https://bun.com/docs/api/file-io

**Validation & images**
- Zod v4: https://zod.dev/
- sharp (resize/webp/rotate/metadata): https://sharp.pixelplumbing.com/api-operation/

**Client**
- React 19: https://react.dev/reference/react
- wouter router: https://github.com/molefrog/wouter#readme
- Tailwind CSS v4 (install + `@theme`): https://tailwindcss.com/docs/installation
- Tailwind v4 CLI: https://tailwindcss.com/docs/installation/tailwind-cli
- shadcn/ui: https://ui.shadcn.com/docs
- shadcn + Tailwind v4: https://ui.shadcn.com/docs/tailwind-v4
- Playwright component testing (React): https://playwright.dev/docs/test-components
- Playwright visual comparisons (`toHaveScreenshot`): https://playwright.dev/docs/test-snapshots

**Brand / mockups (in-repo)**
- `DESIGN/brand-spec.md` — color tokens (OKLCH), typography, layout posture
- `DESIGN/login.html` — login styling (port; drop invite tab + email request)
- `DESIGN/marketplace.html` — grid, filter chips, part card, pagination markup/CSS
