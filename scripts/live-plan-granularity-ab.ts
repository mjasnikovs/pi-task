/**
 * LIVE A/B — does the clarify GRANULARITY answer drive /task-auto's plan size?
 *
 * The observation (mx5, same spec `DESIGN/PROJECT.md`, same base commit 407e542):
 *   run 17 (Jul 25) → clarify Q1 auto-resolved "subdivide into ~30+ fine-grained
 *                     tasks"  → plan of 41 tasks
 *   run 18 (Jul 27) → clarify Q1 auto-resolved "follow the milestones in §12
 *                     as-is" → plan of 11 tasks
 * Both answers were emitted by the SAME clarify-triage child and both were
 * labelled "auto-resolved — already settled by the spec", so the user never saw
 * the fork. This harness tests whether that one line is actually what moves the
 * plan size, or whether the 41→11 collapse came from somewhere else.
 *
 * EXP-1 (isolation): run 18's clarification transcript verbatim in both arms,
 * with ONLY the A1 directive swapped (coarse ↔ fine). One variable.
 * EXP-2 (replication): run 18's full transcript vs run 17's full transcript.
 *
 * Everything else is held fixed across arms and reps: the same inlined spec, the
 * same requirement ledger (extracted ONCE from the live model), the same
 * post-parse pipeline the orchestrator uses (reconcileTitleSources +
 * rewriteBatchTestPlan + the ≤2-title suspect retry).
 *
 * Run: PI_BIN=$(command -v pi) bun run scripts/live-plan-granularity-ab.ts <specRepo> [REPS]
 */
import {runPhaseChild, prependHint, type PhaseDeps} from '../src/task/child-runner.js'
import {expandFeatureMentions} from '../src/task/auto-orchestrator.js'
import {AUTO_DECOMPOSE_PROMPT} from '../src/task/auto-prompts.js'
import {parseDecomposeList} from '../src/task/auto-io.js'
import {reconcileTitleSources} from '../src/task/decompose-fidelity.js'
import {
    REQUIREMENT_EXTRACT_PROMPT,
    parseRequirementLines,
    keepGroundedRequirements,
    enumerateObligationPassages,
    uncoveredPassages,
    extractionRetryHint,
    capRequirements,
    buildRequirementsLedger,
    isCrossCuttingRequirement,
    type RequirementEntry
} from '../src/task/requirements.js'
import {mandatesTestsInSameChange, rewriteBatchTestPlan} from '../src/task/batch-test-task.js'
import {findPhantomImports, rewritePhantomSpecifiers} from '../src/workers/phantom-imports.js'

const FEATURE = 'Implement @DESIGN/PROJECT.md'

// ─── the two clarify Q1 answers, verbatim from the two live runs ─────────────

const Q1_RUN18 =
    'Should the task breakdown follow the 12 milestones in §12 as-is (one task per milestone), or should tasks be split more granularly — e.g. separating "shared schema module" and "Playwright CT setup" into their own prerequisite tasks before any route or component work begins? The spec\'s §10 mandates test-first cadence and §5 mandates shared zod schemas + RPC-only client types, both of which are cross-cutting prerequisites that don\'t neatly sit inside a single milestone.'
const A1_COARSE =
    "follow the 12 milestones in §12 as-is, folding shared schema, Playwright CT setup, and other cross-cutting prerequisites into the first milestone they're needed by (e.g., shared zod schemas land in Milestone 2 with auth routes, Playwright CT config lands in Milestone 6 with the client shell), rather than extracting them into separate prerequisite tasks (auto-resolved — already settled by the spec)"
const A1_FINE =
    'subdivide into smaller per-route/per-component tasks (~30+ fine-grained tasks) (auto-resolved — already settled by the spec)'

/** Run 18's transcript (the 11-task run), verbatim. */
const RUN18_REST = [
    'Q2: Should the pg_trgm extension and its GIN index for text search be set up in the initial migration (Milestone 1), or deferred to Milestone 4 when listing search is implemented? This determines whether the database setup task includes extension provisioning and index creation, or if those land alongside the search query logic.\nA2: include pg_trgm extension and GIN index in the 0001_init.sql migration during Milestone 1, so the schema is fully ready before any route work begins (YOLO)',
    'Q3: Should the rate-limiting mechanism (mentioned in §11 for login, invite create, and invite redeem) be implemented as part of Milestone 2 (Auth) for login and Milestone 3 (Invites) for invite endpoints, or extracted into its own middleware task during Milestone 1 (Scaffold)? This determines whether rate-limiting is a cross-cutting concern available from the start or folded into each route\'s milestone as needed.\nA3: fold rate-limiting into each route\'s milestone as needed — implement it inline during Milestone 2 for login and Milestone 3 for invite endpoints, since the spec calls it a "simple in-memory counter" with no shared configuration or complex logic that warrants extraction (auto-resolved — already settled by the spec)',
    'Q4: Should the shadcn/ui component setup (base primitives like Button, Input, Card, Dialog, etc.) be handled as part of Milestone 6 (Client shell) or extracted into its own task before Milestone 6? This determines whether the client shell task also includes running shadcn CLI installs and configuring the component library\'s Tailwind v4 integration, or if those land separately so that Milestone 7 (Client pages) can import ready-made components without depending on the shell task finishing first.\nA4: handle shadcn/ui setup as part of Milestone 6 (Client shell), since the design doc already groups "shadcn base" under that milestone and the client pages (Milestone 7) depend on those components being available (auto-resolved — already settled by the spec)',
    'Q5: Should Milestone 9 (Polish — empty/error/loading states, responsive design, final brand pass) remain a separate task, or be folded into the preceding client tasks so that Milestone 6 (shell), Milestone 7 (pages), and Milestone 8 (admin page) each ship complete, polished pages? This determines whether there are 12 tasks or effectively 11, and whether every client milestone includes responsive layout, empty states, loading skeletons, and the final brand pass as part of its own completion criteria rather than deferring them to a later sweep.\nA5: fold Milestone 9 into Milestones 6–8 so each client milestone ships complete, polished pages with responsive layout, empty states, loading skeletons, and brand polish included in its own completion criteria (auto-resolved — already settled by the spec)',
    'Q6: Should the /join/:token signup page in Milestone 3 be implemented as a server-rendered HTML form (served directly by Hono before the React SPA exists), or deferred entirely to Milestone 7 when client pages land? Milestone 3 includes "create/validate/redeem, /join/:token page" per §12, but the React SPA infrastructure (router, Tailwind, build pipeline) doesn\'t arrive until Milestone 6. This determines whether M3 produces a temporary server-rendered page that gets replaced later, or if the invite flow remains API-only through M4–M6 with the /join/:token route handled by the SPA fallback serving a React page only after M7.\nA6: defer entirely to Milestone 7 — keep the invite flow API-only through M4–M6, with the `/join/:token` route handled by the SPA fallback (which will render a "not found" or blank React shell until M7 lands the actual page). The research notes confirm that Milestone 6 is when the client shell arrives and Milestone 7 is when all client pages including Join land. There\'s no benefit to building a temporary server-rendered HTML form that would be discarded immediately in M7, especially since the spec already defines the React router path `/join/:token` with its own guard logic and styling requirements (brand tokens, Tailwind v4). Building it twice wastes effort and creates a migration step. (auto-resolved — already settled by the spec)'
].join('\n')

/** Run 17's transcript (the 41-task run), verbatim. */
const RUN17_TRANSCRIPT = [
    'Q1: Should each of the 9 milestones from §12 become a single implementation task, or should they be subdivided into smaller per-route/per-component tasks? This determines whether the breakdown produces ~9 large tasks (one per milestone) or ~30+ fine-grained tasks (e.g., one task per route file, one per React page/component).\nA1: ' + A1_FINE,
    'Q2: Should Playwright component tests with visual screenshot baselines be set up as their own early task (alongside or immediately after the client shell), or folded into each individual component/page task where tests are written inline as part of that task? This determines whether there\'s a dedicated "Playwright CT + screenshot infrastructure" task before any component tests can land, or if each of the ~10+ page/component tasks independently handles its own *.spec.tsx setup and baseline capture.\nA2: fold Playwright CT + screenshot infrastructure into the client shell task (milestone 6), so it\'s available before any component/page tasks start, but don\'t make it a standalone early task — set up `playwright-ct.config.ts`, install `@playwright/experimental-ct-react` and Playwright as devDependencies, add the `test:ct` script, and create one smoke-test `.spec.tsx` to validate the pipeline works; then each subsequent component/page task writes its own `*.spec.tsx` alongside the code per the test-first cadence. (auto-resolved — already settled by the spec)',
    'Q3: Should the pg_trgm extension for full-text search on listing titles/descriptions be created in a dedicated migration task (with its own 0002_pgtrgm.sql), or included inline in the initial 0001_init.sql migration? This determines whether the search index setup is a separate early task that must land before any listing search API work, or bundled into the scaffold milestone\'s single migration.\nA3: include pg_trgm extension and GIN index inline in 0001_init.sql alongside all other tables, indexes, and schema_migrations setup (auto-resolved — already settled by the spec)'
].join('\n')

const RUN18_COARSE = `Q1: ${Q1_RUN18}\nA1: ${A1_COARSE}\n${RUN18_REST}`
const RUN18_FINE = `Q1: ${Q1_RUN18}\nA1: ${A1_FINE}\n${RUN18_REST}`

// ─── harness ─────────────────────────────────────────────────────────────────

const SUSPECT_PLAN_MAX_TITLES = 2
const SUSPECT_PLAN_MIN_SPEC_CHARS = 4000

async function main() {
    const repoArg = process.argv[2]
    if (repoArg === undefined) {
        console.error('usage: live-plan-granularity-ab.ts <specRepo> [REPS]')
        process.exit(2)
    }
    const reps = parseInt(process.argv[3] ?? '8', 10)
    const deps: PhaseDeps = {cwd: repoArg, taskId: '', signal: new AbortController().signal}

    // Exactly planAuto's inline + phantom strike.
    const raw = await expandFeatureMentions(repoArg, FEATURE)
    const phantoms = findPhantomImports(raw, repoArg)
    const featureForModel = phantoms.length === 0 ? raw : rewritePhantomSpecifiers(raw, phantoms)
    console.log(`spec inlined: ${featureForModel.length} chars, ${phantoms.length} phantom(s) struck`)

    // Requirement ledger — extracted ONCE from the live model and reused by every
    // rep of every arm, so the ledger is not a source of between-arm variance.
    const passages = enumerateObligationPassages(featureForModel)
    const extractOnce = async (hint: string | null): Promise<RequirementEntry[]> =>
        keepGroundedRequirements(
            parseRequirementLines(
                await runPhaseChild(
                    deps,
                    'requirement-extract',
                    '',
                    prependHint(hint, REQUIREMENT_EXTRACT_PROMPT(featureForModel, passages))
                )
            ),
            featureForModel
        )
    let reqEntries = await extractOnce(null)
    const uncovered = uncoveredPassages(passages, reqEntries)
    if (uncovered.length > 0) {
        const retry = await extractOnce(extractionRetryHint(uncovered))
        reqEntries = keepGroundedRequirements([...reqEntries, ...retry], featureForModel)
    }
    reqEntries = capRequirements(reqEntries, passages, featureForModel)
    const ledger = buildRequirementsLedger(reqEntries)
    console.log(`ledger: ${reqEntries.length} grounded requirement(s)\n`)

    const parsePlan = (rawOut: string, clarifications: string): string[] => {
        const plan = reconcileTitleSources(parseDecomposeList(rawOut), featureForModel)
        return rewriteBatchTestPlan(
            plan.titles,
            clarifications,
            featureForModel,
            reqEntries.map(e => e.quote),
            isCrossCuttingRequirement
        ).titles
    }

    /** One faithful decompose call (incl. the ≤2-title suspect retry the host does). */
    const decompose = async (clarifications: string): Promise<string[]> => {
        const noBatch = mandatesTestsInSameChange(clarifications, featureForModel)
        const prompt = AUTO_DECOMPOSE_PROMPT(featureForModel, clarifications, ledger, noBatch)
        const out = await runPhaseChild(deps, 'auto-decompose', 'read', prompt)
        let titles = parsePlan(out, clarifications)
        if (
            titles.length <= SUSPECT_PLAN_MAX_TITLES
            && featureForModel.length >= SUSPECT_PLAN_MIN_SPEC_CHARS
        ) {
            const retry = parsePlan(
                await runPhaseChild(deps, 'auto-decompose', 'read', prompt),
                clarifications
            )
            if (retry.length > titles.length) titles = retry
        }
        return titles
    }

    const arms: {name: string; transcript: string}[] = [
        {name: 'EXP1-coarse (run18 verbatim)', transcript: RUN18_COARSE},
        {name: 'EXP1-fine   (run18, A1 swapped)', transcript: RUN18_FINE},
        {name: 'EXP2-run17  (41-task transcript)', transcript: RUN17_TRANSCRIPT}
    ]
    const counts = new Map<string, number[]>(arms.map(a => [a.name, []]))
    const samples = new Map<string, string[]>(arms.map(a => [a.name, []]))

    for (let r = 1; r <= reps; r++) {
        for (const arm of arms) {
            const t0 = Date.now()
            let titles: string[]
            try {
                titles = await decompose(arm.transcript)
            } catch (e) {
                console.log(`  rep ${r} ${arm.name}: ERROR ${String(e).slice(0, 120)}`)
                continue
            }
            counts.get(arm.name)!.push(titles.length)
            if (samples.get(arm.name)!.length === 0) samples.set(arm.name, titles)
            console.log(
                `  rep ${r} ${arm.name}: ${titles.length} title(s)  [${Math.round((Date.now() - t0) / 1000)}s]`
            )
        }
    }

    console.log('\n=== plan size by arm ===')
    for (const arm of arms) {
        const c = counts.get(arm.name)!
        if (c.length === 0) {
            console.log(`${arm.name}: no successful reps`)
            continue
        }
        const sorted = [...c].sort((a, b) => a - b)
        const mean = c.reduce((a, b) => a + b, 0) / c.length
        console.log(
            `${arm.name}: n=${c.length} mean=${mean.toFixed(1)} median=${sorted[Math.floor(sorted.length / 2)]} `
                + `min=${sorted[0]} max=${sorted[sorted.length - 1]}  raw=[${c.join(', ')}]`
        )
    }
    console.log('\n=== first-rep titles per arm ===')
    for (const arm of arms) {
        console.log(`\n--- ${arm.name} ---`)
        for (const t of samples.get(arm.name)!) console.log(`  - ${t}`)
    }
}

main().catch(e => {
    console.error(e)
    process.exit(1)
})
