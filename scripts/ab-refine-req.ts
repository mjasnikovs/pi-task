/**
 * A/B: does the carried cross-cutting requirements block (goal C) actually land
 * the spec's mandated test methodology in a task's REFINED spec?
 *
 * Replicates run-11 TASK_0002 (auth) exactly: same title (tests suffix dropped,
 * as shipped), same scope fence, same design doc on disk. Arm OLD: no carried
 * block (run-11 behavior). Arm NEW: buildRequirementsBlock over the verbatim
 * §10 quotes A extracts. Metric per rep: the refined output OBLIGATES tests for
 * this task's own routes (mentions test(s) in GOAL/CONSTRAINTS).
 *
 * Usage: PI_BIN=pi bun scripts/ab-refine-req.ts <old|new> [reps=5]
 */
import {REFINE_PROMPT, appendNoThink} from '../src/task/prompts.js'
import {buildScopeFence} from '../src/task/auto-orchestrator.js'
import {buildRequirementsBlock} from '../src/task/requirements.js'
import {loadPlanningFixture, runPlanningChild, recordRep} from './ab-planning.js'

const RUN11_TITLES = [
    'Scaffold project structure — package.json, tsconfig, ESLint, Prettier, docker-compose Postgres 18, Bun SQL connection, migrations runner, admin seed script',
    'Implement authentication layer — argon2id password hashing, cookie sessions in Postgres, login/logout/me routes, session middleware with requireAuth/requireAdmin guards',
    'Implement invite system — create one-time links, validate tokens, atomic redeem flow with phone/password signup, /join/:token page',
    'Implement listings API — CRUD endpoints, search/filter/sort/pagination with pg_trgm, sold toggle, ownership checks, contact reveal gate',
    'Implement photo pipeline — sharp compression (full + thumb), multipart upload with ≤5 limit, streaming serve route with cache headers, delete with position compaction',
    'Build client shell — Bun.build config, Tailwind v4 theme tokens from brand spec, wouter router setup, typed hc<AppType> API client, shadcn/ui initialization via CLI generator',
    'Build client pages — Login, Join, Marketplace grid with filters, Listing detail with photo gallery, New/Edit listing forms, MyListings management page',
    'Implement admin features — user listing with ban/unban toggle, cross-user listing deletion, /admin page with moderation UI',
    'Polish and finalize — empty/error/loading states, responsive layout, branded placeholder for listings without photos, final brand pass'
]

// Verbatim §10/§2 quotes (grounded in the doc) as A would carry them.
const CARRIED = [
    '"a test lands *as fast as possible* — in the same change — as each new route or React component/page" [anchor: 10. Testing]',
    '"No route or component is considered done until its test exists and passes" [anchor: 10. Testing]',
    '"every component/page test captures a screenshot committed as a baseline" [anchor: 2. Tech stack]',
    '"Run under `bun test` with `DATABASE_URL` pointing at a separate `mx5_test` database" [anchor: 10. Testing]'
].join('\n')

async function main(): Promise<void> {
    const [arm, repsRaw] = process.argv.slice(2)
    const reps = repsRaw ? parseInt(repsRaw, 10) : 5
    if (arm !== 'old' && arm !== 'new') {
        console.error('usage: PI_BIN=pi bun scripts/ab-refine-req.ts <old|new> [reps]')
        process.exit(2)
    }
    const fx = await loadPlanningFixture('mx5')
    const title =
        RUN11_TITLES[1]
        + ' | spec: @DESIGN/PROJECT.md — otherwise authoritative; read it and follow it over this title wherever they differ'
    const fence = buildScopeFence(RUN11_TITLES, 1)
    const carried = arm === 'new' ? buildRequirementsBlock(CARRIED) : ''
    const tag = `refine-req-${arm}-${Date.now()}`
    for (let rep = 1; rep <= reps; rep++) {
        const t0 = Date.now()
        const raw = await runPlanningChild(
            fx.cwd,
            'read',
            appendNoThink(REFINE_PROMPT(title, fence, '', carried, ''))
        )
        const ms = Date.now() - t0
        // Metric: does the refined spec obligate tests for this slice?
        const hit = /\btests?\b/i.test(raw) && /GOAL|CONSTRAINTS/.test(raw)
        await recordRep(tag, {rep, ms, raw, parsed: {testsObligated: hit}})
        console.log(`rep ${rep}/${reps} (${ms}ms): testsObligated=${hit}`)
    }
    console.log(`results tag: ${tag}`)
}

main().catch(err => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
})
