/**
 * batch-test-task tests — the mx5 run 14 fixture A/B (PROMPT item 6).
 *
 * The plan titles and the decision text below are VERBATIM from run 14
 * (`.pi-tasks/TASK_AUTO_0001.md` and the `[decisions: …]` clause carried onto
 * TASK_0037). What this file pins:
 *
 *   - the run-14 plan's ONE batch title (TASK_0037) is found, and none of the
 *     five per-area "Write <area> route tests" tasks, the two test-INFRA tasks,
 *     or the "+ tests" feature tasks are,
 *   - with the cadence decision present the batch task is dropped when another
 *     task already grounds its requirements, and replaced by a SCOPED sweep when
 *     it is the sole owner — never silently deleted in the second case,
 *   - total planned coverage (groundedCoverage) never falls,
 *   - with no cadence decision the plan is returned untouched.
 */
import {describe, expect, test} from 'bun:test'
import {
    buildSweepTitle,
    coverageSourceFromSpec,
    findBatchTestTitles,
    mandatesTestsInSameChange,
    rewriteBatchTestPlan
} from './batch-test-task.js'
import {groundedCoverage} from './coverage-loop.js'
import {isCrossCuttingRequirement} from './requirements.js'

// ─── Verbatim mx5 run 14 material ────────────────────────────────────────────

/** The decision carried onto TASK_0037's own title, verbatim. */
const CADENCE_DECISION =
    'a test lands *as fast as possible* — in the same change — as each new route or'
    + ' React component/page. No route or component is considered done until its test'
    + " exists and passes. Don't batch testing to the end of a milestone."

/** §10 of DESIGN/PROJECT.md, verbatim (the spec-internal side of the conflict). */
const SPEC_TESTING_SECTION =
    '## 10. Testing\n\n'
    + '**Test-first cadence (required):** '
    + CADENCE_DECISION
    + '\n\n'
    + '**Route/API tests** — `app.request(...)` per hono testing guide. Run under'
    + ' `AGENT=1 bun test` with `DATABASE_URL` pointing at a separate `mx5_test`'
    + ' database.\n\n'
    + '**Client/component tests** — Playwright React component tests; every'
    + ' component/page test captures a screenshot committed as a baseline.\n'

/** run 14's plan, verbatim (decisions/spec suffixes stripped as parsePlan sees it). */
const RUN14_PLAN = [
    'Set up project scaffold — package.json, tsconfig.json, ESLint flat config, Prettier .prettierrc.cjs with pinned versions and settings',
    'Set up docker-compose for local Postgres 18 development',
    'Implement Bun SQL database connection module — import from "bun" with sql tagged templates and query helpers',
    'Write initial migration 0001_init.sql with all tables, indexes, and pg_trgm extension',
    'Implement migrations runner — migrate.ts with schema_migrations tracking table',
    'Implement admin seed script — create root admin from ADMIN_PHONE/ADMIN_PASSWORD env vars if no admin exists',
    'Set up test infrastructure — bun test with separate mx5_test database, migrate + truncate between runs',
    'Implement shared Zod schemas — listing, auth, invite types with phone E.164 validation, field limits, and shared TypeScript types',
    'Implement password hashing and session management — argon2id via Bun.password, opaque cookie tokens hashed with sha256',
    'Implement auth route handlers — POST login, POST logout, GET me with session cookie management and guards',
    'Write auth route tests — login, logout, session guards, banned user rejection',
    'Implement invite route handlers — POST create, GET validate, POST redeem with atomic one-time consumption and expiry check',
    'Write invite route tests — creation, validation, one-time redeem, expiry, concurrent redeem safety',
    'Implement join page — /join/:token pre-validated signup form with phone + password + display name',
    'Implement listings route handlers — GET paginated search/filter/sort, GET detail, POST create, PATCH edit, POST sold toggle, DELETE, GET contact reveal',
    'Write listings route tests — CRUD, ownership checks, search/filter/sort/pagination, sold toggle, contact reveal auth gate',
    'Implement image compression pipeline — sharp resize to full (1600px) and thumb (600px), WebP output, EXIF rotation, metadata stripping',
    'Implement photo route handlers — POST upload with multipart and ≤5 limit, GET serve streaming bytea with cache headers, DELETE with position compaction',
    'Write photo route tests — upload compression, ≤5 limit enforcement, serve with cache headers, delete and position compaction',
    'Implement admin route handlers — GET all users, POST ban/unban user; reuse DELETE listing for admin deletion with owner-or-admin check',
    'Write admin route tests — user listing, ban/unban, admin listing deletion, role guards',
    'Implement Hono app entry — route assembly, SPA fallback serving built index.html for non-/api GETs, static dist/ serving',
    'Implement build script — Bun.build for client JS/TSX with output including index.html entry point, and @tailwindcss/cli for CSS',
    'Set up Tailwind CSS v4 — index.css with @import tailwindcss and OKLCH brand theme tokens from brand-spec',
    'Install and restyle shadcn/ui components — npx shadcn@latest setup then customize for Kodo/JDM aesthetic',
    'Implement client shell — React root with wouter router, navigation component, typed hono/client API module',
    'Create branded placeholder SVG component — inline SVG for listings without photos, inheriting brand tokens via CSS',
    'Set up Playwright component testing — playwright-ct.config.ts, browser binaries, __screenshots__/ directory, mock RPC at network boundary',
    'Implement login page — phone + password form with validation, no email or invite tab',
    'Implement join page — /join/:token with pre-validated signup form, phone + password + display name, invite consumption',
    'Implement marketplace page — grid with search, filter chips (generation/type/condition), sort, pagination, PartCard components with badges',
    'Implement listing detail page — photo gallery, full info, Contact seller button (phone reveal gated behind login), Sold badge, owner edit controls',
    'Implement new listing page — form with all fields and 5-photo uploader',
    'Implement edit listing page — same fields as new, pre-populated, with photo management',
    'Implement my listings page — own listings grid with edit/sold/delete actions and "Invite a member" button',
    'Implement admin page — user list with ban/unban toggle, listing deletion capability',
    // TASK_0037 — the batch title this module exists for (index 36).
    'Write component and page tests — Playwright CT tests with screenshot baselines for all components and pages',
    'Implement polish — empty states, error states, loading states, responsive layout, final brand pass against DESIGN/brand-spec.md'
]

const BATCH_INDEX = 36

/** The §10 obligation the batch task was nominally discharging. */
const SCREENSHOT_REQ = 'every component/page test captures a screenshot committed as a baseline'

describe('mandatesTestsInSameChange', () => {
    test("fires on run 14's carried decision", () => {
        expect(mandatesTestsInSameChange(CADENCE_DECISION)).toBe(true)
    })

    test('fires on the spec section alone (spec-internal conflict)', () => {
        expect(mandatesTestsInSameChange('', SPEC_TESTING_SECTION)).toBe(true)
    })

    test('a mere "tests are required" spec is NOT a cadence mandate', () => {
        expect(
            mandatesTestsInSameChange(
                '',
                'Every route must have tests. Aim for high coverage across the API surface.'
            )
        ).toBe(false)
    })

    test('an anti-batch rule about something OTHER than tests does not fire', () => {
        expect(
            mandatesTestsInSameChange(
                "Don't batch database migrations to the end of a milestone.",
                ''
            )
        ).toBe(false)
    })
})

describe('findBatchTestTitles', () => {
    test('run 14: exactly TASK_0037 — not the five per-area test tasks, not the infra ones', () => {
        expect(findBatchTestTitles(RUN14_PLAN)).toEqual([BATCH_INDEX])
    })

    test('other whole-project shapes', () => {
        const hits = findBatchTestTitles([
            'Write tests for all API routes',
            'Add comprehensive test coverage across the codebase',
            'Test every page and component',
            'Backfill unit tests for the entire domain layer'
        ])
        expect(hits).toEqual([0, 1, 2, 3])
    })

    // Both titles VERBATIM from a live decompose rep (Qwen3.6-27B, mx5 fixture).
    // reconcileTitleSources leaves a malformed `[source: "…" [§]]` citation in
    // place, so the cadence line it quotes ("…as each new route…") became part of
    // the title text — and the bare scope check called the scoped auth-test task a
    // batch. Only the second title here is a batch task.
    test('a leaked [source: …] citation is provenance, not scope', () => {
        const live = [
            'Write route/API tests for auth — login, logout, me, guards, banned-user rejection'
                + ' — [source: "**Test-first cadence (required):** a test lands *as fast as'
                + ' possible* — in the same change — as each new route or React'
                + ' component/page." [10. Testing]]',
            'Write Playwright component tests for all client components and pages — mock RPC'
                + ' calls at network boundary, capture screenshots — [source: "Mock RPC calls'
                + ' at the network boundary so component tests stay deterministic and'
                + ' DB-free." [10. Testing]]'
        ]
        expect(findBatchTestTitles(live)).toEqual([1])
    })

    // Rep 2, verbatim: the same leak plus an inline quoted spec fragment. With the
    // raw citation counted, SIX of this plan's titles read as batch tasks; only
    // the last one is.
    test('a leaked citation does not batch-flag five scoped API test tasks', () => {
        const cadence =
            ' [source: "**Test-first cadence (required):** a test lands *as fast as possible*'
            + ' — in the same change — as each new route or React component/page."'
            + ' [10. Testing]]'
        const live = [
            'Write API tests for auth routes — login, guards, banned user rejection —'
                + ' "Route/API tests — `app.request(...)` per hono testing guide: auth'
                + ' (login/guards)"'
                + cadence,
            'Write API tests for invite routes — one-time use, expiry, concurrent redeem'
                + ' safety —  "Route/API tests — `app.request(...)` per hono testing guide:'
                + ' ... invite redeem (one-time, expiry)"'
                + cadence,
            'Write API tests for listings routes — CRUD, ownership, search, sold toggle,'
                + ' contact gate'
                + cadence,
            'Write API tests for photo routes — upload limit, serve streaming, delete'
                + ' compaction'
                + cadence,
            'Write API tests for admin routes — ban, unban, cross-user listing deletion' + cadence,
            'Set up Playwright component testing with React CT and visual snapshots' + cadence,
            'Write component tests for all client pages and components — render, behavior'
                + ' assertions, screenshot baselines with mocked RPC'
                + cadence
        ]
        expect(findBatchTestTitles(live)).toEqual([6])
    })

    // Rep 5, verbatim: the citation arrives as a BARE quote (no `[source: …]`
    // wrapper) plus a [decisions: …] clause — both carrying the cadence line, whose
    // "each new route" is the only quantifier in the title.
    test('a bare quoted citation does not batch-flag a scoped test task', () => {
        const live =
            'Write auth route tests — login, logout, me, guards, banned user rejection via'
            + ' app.request() — "Test-first cadence (required): a test lands *as fast as'
            + ' possible* — in the same change — as each new route or React component/page."'
            + ' [decisions: "a test lands *as fast as possible* — in the same change — as each'
            + ' new route or React component/page. No route or component is considered done'
            + ' until its test exists and passes."]'
        expect(findBatchTestTitles([live])).toEqual([])
    })

    // Rep 3, verbatim: a ONE-component test task whose "all" governs a sub-aspect.
    // A bare-quantifier rule flagged it and the rewrite DROPPED it — deleting
    // exactly the per-change test the cadence decision asks for.
    test('a quantifier over a sub-aspect is not whole-project scope', () => {
        expect(
            findBatchTestTitles([
                'Test PartCard component — all badge combinations, placeholder rendering'
                    + ' with Playwright component test and screenshot baseline'
            ])
        ).toEqual([])
    })

    // Rep 4 of the 8-rep live A/B (2026-07-20, Qwen3.6-27B on the mx5 fixture),
    // verbatim. The citation arrives as BARE PROSE — no quotes, no `[source: …]`
    // wrapper — and is then repeated inside one, so neither earlier guard sees it.
    // Its borrowed "every component/page" was the title's only quantifier, and the
    // rewrite DROPPED this correctly per-change-scoped Login task.
    test('an unmarked spec echo in the detail is provenance, not scope', () => {
        const spec =
            '**Client/UI:** Playwright `1.61.1` React component tests'
            + ' (`@playwright/experimental-ct-react`) with\n  **visual confirmation** — every'
            + ' component/page test captures a screenshot committed as a baseline.'
        const live =
            'Implement Login page with phone/password form and tests — **Client/UI:**'
            + ' Playwright `1.61.1` React component tests'
            + ' (`@playwright/experimental-ct-react`) with **visual confirmation** — every'
            + ' component/page test captures a screenshot committed as a baseline.'
            + ' [source: "**Client/UI:** Playwright `1.61.1` React component tests'
            + ' (`@playwright/experimental-ct-react`) with **visual confirmation** — every'
            + ' component/page test captures a screenshot committed as a baseline."'
            + ' [2. Tech stack (pinned to latest, 2026-07)]]'
        expect(findBatchTestTitles([live], spec)).toEqual([])
        // Without the spec the detector has nothing to compare against — this is
        // why every caller must pass it.
        expect(findBatchTestTitles([live])).toEqual([0])
    })

    // The head is never stripped, so a batch title that quotes the spec verbatim in
    // its own deliverable is still caught.
    test('a spec echo in the HEAD does not excuse a batch title', () => {
        const spec = 'Write component tests for all components and pages before release.'
        expect(
            findBatchTestTitles(
                ['Write component tests for all components and pages — screenshot baselines'],
                spec
            )
        ).toEqual([0])
    })

    test('scoped and additive test work is untouched', () => {
        expect(
            findBatchTestTitles([
                'Write auth route tests — login, logout, session guards',
                'Implement listings CRUD + search/filter/sort + tests for all query params',
                'Set up test infrastructure for all packages — bun test, fixtures, CI',
                'Set up Playwright component testing — config, browser binaries, __screenshots__/',
                'Implement admin page — user list with ban/unban toggle for all users',
                // "full"/"complete" scope ONE area — not a batch marker.
                'Write auth route tests — full login/logout flow with complete session lifecycle'
            ])
        ).toEqual([])
    })
})

describe('coverageSourceFromSpec', () => {
    test('picks the backticked test command the spec itself names', () => {
        expect(coverageSourceFromSpec(SPEC_TESTING_SECTION)).toBe('AGENT=1 bun test')
    })

    test('prefers a coverage-flagged command', () => {
        expect(coverageSourceFromSpec('run `vitest run` or `vitest run --coverage`')).toBe(
            'vitest run --coverage'
        )
    })

    test('degrades to a well-formed phrase when the spec names no command', () => {
        expect(coverageSourceFromSpec('no commands here')).toBe("the project's own test suite")
    })
})

describe('rewriteBatchTestPlan (run 14 fixture)', () => {
    const rewrite = (titles: string[], quotes: string[], decisions = CADENCE_DECISION) =>
        rewriteBatchTestPlan(
            titles,
            decisions,
            SPEC_TESTING_SECTION,
            quotes,
            isCrossCuttingRequirement
        )

    test('BEFORE: the batch task ships when no cadence decision governs the plan', () => {
        const r = rewriteBatchTestPlan(
            RUN14_PLAN,
            '',
            'Client/component tests — Playwright React component tests with `bun test`.',
            [SCREENSHOT_REQ],
            isCrossCuttingRequirement
        )
        expect(r.actions).toEqual([])
        expect(r.titles).toEqual(RUN14_PLAN)
        expect(r.titles[BATCH_INDEX]).toContain('for all components and pages')
    })

    test('AFTER: dropped when another task already grounds its requirement', () => {
        // TASK_0028 ("… __screenshots__/ directory") grounds the screenshot
        // obligation, and the cadence puts each component's test in its own task —
        // so nothing is lost by removing the batch task.
        const r = rewrite(RUN14_PLAN, [SCREENSHOT_REQ])
        expect(r.actions).toHaveLength(1)
        expect(r.actions[0].kind).toBe('dropped')
        expect(r.actions[0].index).toBe(BATCH_INDEX)
        expect(r.titles).toHaveLength(RUN14_PLAN.length - 1)
        expect(findBatchTestTitles(r.titles)).toEqual([])
    })

    test('AFTER: scoped sweep when the batch task is the SOLE owner', () => {
        // Same plan without TASK_0028 — now no other title mentions screenshots or
        // baselines, so dropping outright would reduce planned coverage.
        const plan = RUN14_PLAN.filter(t => !t.startsWith('Set up Playwright component testing'))
        const r = rewrite(plan, [SCREENSHOT_REQ])
        expect(r.actions).toHaveLength(1)
        expect(r.actions[0].kind).toBe('scoped')
        expect(r.actions[0].orphaned).toEqual([SCREENSHOT_REQ])
        expect(r.titles).toHaveLength(plan.length)
        const sweep = r.titles[plan.indexOf(RUN14_PLAN[BATCH_INDEX])]
        expect(sweep).toContain('AGENT=1 bun test')
        expect(sweep).toContain(SCREENSHOT_REQ)
        expect(sweep).toContain('ONLY for what it reports uncovered')
        // The replacement is scoped, so it is no longer a batch task itself.
        expect(findBatchTestTitles(r.titles)).toEqual([])
    })

    test('planned coverage never falls, in either outcome', () => {
        const quotes = [
            SCREENSHOT_REQ,
            'Route/API tests via app.request per the hono testing guide',
            'sessions, login/logout/me, guards',
            'CRUD + search/filter/sort/pagination + sold + contact'
        ]
        const cover = (titles: string[]) =>
            groundedCoverage(quotes, titles, isCrossCuttingRequirement)
        for (const plan of [
            RUN14_PLAN,
            RUN14_PLAN.filter(t => !t.startsWith('Set up Playwright component testing'))
        ]) {
            const r = rewrite(plan, quotes)
            const before = cover(plan)
            const after = cover(r.titles)
            for (const i of before) expect(after.has(i)).toBe(true)
        }
    })

    test('two batch tasks collapse to exactly one sweep', () => {
        const plan = [
            'Implement login page — phone + password form',
            'Write component tests for all pages — Playwright CT with screenshot baselines',
            'Write API tests for all routes — app.request coverage of every endpoint'
        ]
        const r = rewrite(plan, [SCREENSHOT_REQ, 'app.request coverage of every endpoint'])
        expect(r.actions.map(a => a.kind)).toEqual(['scoped', 'dropped'])
        expect(r.titles).toHaveLength(2)
        expect(findBatchTestTitles(r.titles)).toEqual([])
    })

    test('a [decisions: …] clause on the batch title rides onto the sweep', () => {
        const clause =
            ' [decisions: "Mock RPC calls at the network boundary so component tests stay'
            + ' deterministic and DB-free."]'
        const plan = ['Implement login page — form', RUN14_PLAN[BATCH_INDEX] + clause]
        const r = rewrite(plan, [SCREENSHOT_REQ])
        expect(r.actions[0].kind).toBe('scoped')
        expect(r.titles[1]).toContain(clause.trim())
    })

    test('no batch title ⇒ identity', () => {
        const plan = RUN14_PLAN.filter((_, i) => i !== BATCH_INDEX)
        const r = rewrite(plan, [SCREENSHOT_REQ])
        expect(r.actions).toEqual([])
        expect(r.titles).toEqual(plan)
    })
})

describe('buildSweepTitle', () => {
    test('caps how many requirements it names', () => {
        const many = Array.from({length: 9}, (_, i) => `requirement number ${i}`)
        const title = buildSweepTitle(many, 'bun test')
        expect(title).toContain('(+3 more)')
        expect(title).toContain('requirement number 5')
        expect(title).not.toContain('requirement number 6')
    })
})
