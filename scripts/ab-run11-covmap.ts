/**
 * NOT A VERDICT HARNESS — a RECORDER (see scripts/ab-planning.ts's header). It
 * writes per-rep JSONL for a human to read and exits 0 regardless.
 *
 * Regression measurement (goal A): map extracted requirements against the
 * FROZEN run-11 plan — the 9 real titles, which carry no test tasks. The §10
 * testing requirements must come out CROSS-CUTTING or NONE (i.e. the host-side
 * accounting SEES the hole run-11 shipped with); a false TASK-mapping would
 * reproduce the rubber-stamp. Also reports what the old holistic judge said on
 * the same inputs, for the per-arm comparison.
 *
 * Usage: PI_BIN=pi bun scripts/ab-run11-covmap.ts [reps=5]
 */
import {
    COVERAGE_MAP_PROMPT,
    parseCoverageMap,
    accountCoverage
} from '../src/task/requirements.js'
import {DECOMPOSE_COVERAGE_PROMPT} from '../src/task/auto-prompts.js'
import {parseCoverageVerdict} from '../src/task/auto-io.js'
import {
    loadPlanningFixture,
    runPlanningChild,
    recordRep,
    extractRequirementsNew
} from './ab-planning.js'

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

const TESTING_PROBE = /test|screenshot|playwright|mx5_test/i

async function main(): Promise<void> {
    const reps = process.argv[2] ? parseInt(process.argv[2], 10) : 5
    const fx = await loadPlanningFixture('mx5')
    const tag = `run11-covmap-${Date.now()}`
    for (let rep = 1; rep <= reps; rep++) {
        const t0 = Date.now()
        const reqs = await extractRequirementsNew(fx)
        const mapRaw = await runPlanningChild(
            fx.cwd,
            '',
            COVERAGE_MAP_PROMPT(reqs, RUN11_TITLES)
        )
        const acc = accountCoverage(reqs, parseCoverageMap(mapRaw, reqs.length, RUN11_TITLES.length))
        // The old holistic judge on the same inputs (run-11 said COMPLETE).
        const verdict = parseCoverageVerdict(
            await runPlanningChild(
                fx.cwd,
                '',
                DECOMPOSE_COVERAGE_PROMPT(fx.featureForModel, '', RUN11_TITLES)
            )
        )
        const testingReqs = reqs.filter(r => TESTING_PROBE.test(r.quote))
        const testingCaught = testingReqs.filter(
            r =>
                acc.crossCutting.includes(r)
                || acc.unmapped.includes(r)
        )
        const ms = Date.now() - t0
        const parsed = {
            reqs: reqs.length,
            testingReqs: testingReqs.map(r => r.quote.slice(0, 60)),
            testingCaught: testingCaught.map(r => r.quote.slice(0, 60)),
            cross: acc.crossCutting.length,
            unmapped: acc.unmapped.length,
            judgeVerdict: verdict === null ? 'none' : verdict.kind
        }
        await recordRep(tag, {rep, ms, raw: mapRaw, parsed})
        console.log(`rep ${rep}/${reps} (${ms}ms):`, JSON.stringify(parsed))
    }
    console.log(`results tag: ${tag}`)
}

main().catch(err => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
})
