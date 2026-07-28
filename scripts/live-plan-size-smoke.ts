/**
 * SMOKE TEST — plan size across a spread of feature sizes, after the granularity
 * fix (decompose-granularity.ts).
 *
 * The fix pushes plans FINER. The risk it creates is the opposite of the bug it
 * closes: a one-line chore ballooning into a dozen tasks. So this drives the real
 * planning head — auto-clarify → (plan-shape interception | clarify-triage) →
 * requirement extraction → decompose → the silent floor's split reprompt — over
 * specs from "fix a typo" to a 20KB design doc, one rep each, and prints what
 * each one planned into against a pre-registered expected range.
 *
 * The clarify loop is simulated at ONE question (where the plan-shape fork lands
 * in 8/8 live reps) and answered the way YOLO/unattended does: the host's fixed
 * answer for a plan-shape fork, the triage's answer when it resolves, otherwise
 * the model's own SUGGESTED default.
 *
 * Run: PI_BIN=$(command -v pi) bun run scripts/live-plan-size-smoke.ts <emptyRepo> <mx5Repo>
 */
import {runPhaseChild, prependHint, type PhaseDeps} from '../src/task/child-runner.js'
import {expandFeatureMentions} from '../src/task/auto-orchestrator.js'
import {AUTO_CLARIFY_PROMPT, AUTO_DECOMPOSE_PROMPT} from '../src/task/auto-prompts.js'
import {GRILL_AUTO_ANSWER_PROMPT, GRILL_AUTO_FORMAT_HINT} from '../src/task/prompts.js'
import {parseClarifyList, parseAutoAnswer, autoAnswerHasTag} from '../src/task/parsers.js'
import {stripInlineMarkdown} from '../src/task/inline-markdown.js'
import {parseDecomposeList} from '../src/task/auto-io.js'
import {reconcileTitleSources} from '../src/task/decompose-fidelity.js'
import {
    granularityFloor,
    granularitySplitHint,
    isPlanShapeQuestion,
    isTooCoarse,
    planShapeIsHostsToAnswer,
    PLAN_SHAPE_ANSWER
} from '../src/task/decompose-granularity.js'
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

interface Case {
    /** Short label for the results table. */
    name: string
    /** The /task-auto prompt, verbatim. */
    prompt: string
    /** Pre-registered expectation, set BEFORE running. */
    lo: number
    hi: number
    /** Run in the mx5 repo (the only case with an @-mentioned design doc). */
    mx5?: boolean
}

const CASES: Case[] = [
    // ── one-liners: the ballooning risk ──────────────────────────────────────
    {name: 'typo in README', prompt: 'Fix the typo in the README title.', lo: 1, hi: 2},
    {
        name: 'rename a helper',
        prompt: 'Rename the `foo()` helper to `normalizePath()` across the repo.',
        lo: 1,
        hi: 2
    },
    {
        name: 'add .editorconfig',
        prompt: 'Add a .editorconfig with 4-space indent, LF endings and a final newline.',
        lo: 1,
        hi: 2
    },
    {
        name: 'CLI --version flag',
        prompt: 'Add a `--version` flag to the CLI that prints the package version and exits 0.',
        lo: 1,
        hi: 3
    },
    {
        name: 'bump eslint',
        prompt: 'Bump eslint to the latest major and fix any new lint errors it reports.',
        lo: 1,
        hi: 3
    },
    {
        name: 'CI diagnosis (no code)',
        prompt: 'Investigate why the GitHub Actions pipeline is failing and report the root cause. Do not change any code.',
        lo: 1,
        hi: 3
    },
    {
        name: 'vague perf ask',
        prompt: 'Make the app faster.',
        lo: 1,
        hi: 4
    },
    // ── small, a handful of stated requirements ──────────────────────────────
    {
        name: 'CLI --json mode',
        prompt: [
            'Add a `--json` output mode to the existing `dedupe` CLI.',
            '- `--json` emits machine-readable JSON instead of the human table',
            '- the shape is `{ groups: [{ hash, files: [path], bytes }], reclaimable }`',
            '- the human table stays the default when the flag is absent',
            '- `--json` with `--quiet` is an error: report it and exit 2'
        ].join('\n'),
        lo: 1,
        hi: 5
    },
    {
        name: 'login rate limit',
        prompt: 'Add rate limiting to the login endpoint: 5 attempts per minute per IP, respond 429 with a Retry-After header, and log every block.',
        lo: 1,
        hi: 5
    },
    {
        name: '/healthz endpoint',
        prompt: 'Add a `/healthz` endpoint returning process uptime, package version and database connectivity, with a test.',
        lo: 1,
        hi: 5
    },
    {
        name: 'registry disk cache',
        prompt: 'Cache npm registry lookups on disk with a 24h TTL, a `--no-cache` flag to bypass it, and per-package invalidation on install.',
        lo: 2,
        hi: 6
    },
    {
        name: 'paginate GET /items',
        prompt: 'Add limit/offset pagination to the existing `GET /api/items` endpoint, returning `{ items, total, limit, offset }`, with tests.',
        lo: 1,
        hi: 5
    },
    {
        name: 'dark mode toggle',
        prompt: 'Add a dark mode toggle to the settings page: persist the choice in localStorage, respect prefers-color-scheme on first load, and apply it without a flash of the wrong theme.',
        lo: 2,
        hi: 6
    },
    // ── medium ───────────────────────────────────────────────────────────────
    {
        name: 'CSV import',
        prompt: 'Add CSV import: upload a file, validate every row against a schema, report per-row errors back to the user, and insert the valid rows in a single transaction. Include tests.',
        lo: 3,
        hi: 9
    },
    {
        name: 'plugin system',
        prompt: 'Add a plugin system: discover plugins from node_modules, validate each manifest, load them in dependency order, and expose a documented hook API with tests.',
        lo: 3,
        hi: 10
    },
    {
        name: 'markdown site generator',
        prompt: 'Build a CLI that converts a directory of markdown files into a static HTML site: a configurable template, asset copying, an index page, and a dev server with live reload.',
        lo: 4,
        hi: 12
    },
    {
        name: 'OAuth2 login',
        prompt: 'Add OAuth2 login with Google and GitHub: the authorization code flow, session cookies, account linking for an existing email, and logout. Include tests.',
        lo: 4,
        hi: 12
    },
    {
        name: 'job queue',
        prompt: 'Add a background job queue: enqueue, worker loop, exponential-backoff retries, a dead-letter table, and a CLI to inspect and requeue failed jobs.',
        lo: 4,
        hi: 12
    },
    {
        name: 'file upload + thumbnails',
        prompt: 'Add image upload: accept up to 5 files per post, strip EXIF, generate a 1600px full and 300px thumbnail in webp, store them, and serve with cache headers. Include tests.',
        lo: 3,
        hi: 10
    },
    // ── large ────────────────────────────────────────────────────────────────
    {
        name: 'library REST API',
        prompt: 'Build a REST API for a library: books, authors, members and loans, with search, overdue reports, authentication, role-based permissions and tests for every route.',
        lo: 7,
        hi: 20
    },
    {
        name: 'real-time chat',
        prompt: 'Build a real-time chat app: rooms, presence, message history with pagination, typing indicators, file attachments and websocket transport, with a React client and tests.',
        lo: 8,
        hi: 22
    },
    {
        name: 'expense tracker',
        prompt: 'Build an expense tracker web app: email/password auth, accounts, transactions, categories, monthly budgets, a reports dashboard and CSV export. Tests throughout.',
        lo: 8,
        hi: 22
    },
    {
        name: 'multi-tenant SaaS admin',
        prompt: 'Build a multi-tenant SaaS admin: organisations, users, roles, invitations, Stripe billing, an audit log, usage metering and an admin UI. Tests throughout.',
        lo: 10,
        hi: 26
    },
    // ── the real design doc that started this ────────────────────────────────
    {name: 'mx5 DESIGN/PROJECT.md', prompt: 'Implement @DESIGN/PROJECT.md', lo: 14, hi: 32, mx5: true}
]

async function main() {
    const emptyRepo = process.argv[2]
    const mx5Repo = process.argv[3]
    if (emptyRepo === undefined || mx5Repo === undefined) {
        console.error('usage: live-plan-size-smoke.ts <emptyRepo> <mx5Repo>')
        process.exit(2)
    }

    // Optional 3rd arg: substring filter over case names (re-run one case).
    const only = process.argv[4]
    const cases = only === undefined ? CASES : CASES.filter(c => c.name.includes(only))
    const reps = parseInt(process.argv[5] ?? '1', 10)
    const rows: string[] = []
    let inRange = 0

    for (const c of Array.from({length: reps}, () => cases).flat()) {
        const cwd = c.mx5 === true ? mx5Repo : emptyRepo
        const deps: PhaseDeps = {cwd, taskId: '', signal: new AbortController().signal}
        const t0 = Date.now()
        try {
            const feature =
                c.mx5 === true ? await expandFeatureMentions(cwd, c.prompt) : c.prompt

            // ── requirement channel ──────────────────────────────────────────
            const passages = enumerateObligationPassages(feature)
            const once = async (hint: string | null): Promise<RequirementEntry[]> =>
                keepGroundedRequirements(
                    parseRequirementLines(
                        await runPhaseChild(
                            deps,
                            'requirement-extract',
                            '',
                            prependHint(hint, REQUIREMENT_EXTRACT_PROMPT(feature, passages))
                        )
                    ),
                    feature
                )
            let entries = await once(null)
            const uncovered = uncoveredPassages(passages, entries)
            if (uncovered.length > 0) {
                entries = keepGroundedRequirements(
                    [...entries, ...(await once(extractionRetryHint(uncovered)))],
                    feature
                )
            }
            entries = capRequirements(entries, passages, feature)
            const ownable = entries.filter(e => !isCrossCuttingRequirement(e.quote)).length
            const floor = granularityFloor(ownable)

            // ── clarify head, one question, answered the way YOLO does ───────
            let clarifications = ''
            let planShapeFired = false
            const qRaw = await runPhaseChild(
                deps,
                'auto-clarify',
                'read',
                AUTO_CLARIFY_PROMPT(feature, '')
            )
            const parsed = parseClarifyList(qRaw)
            if (parsed.length > 0) {
                const plainQ = stripInlineMarkdown(parsed[0].question)
                let answer: string
                if (planShapeIsHostsToAnswer(ownable) && isPlanShapeQuestion(plainQ)) {
                    planShapeFired = true
                    answer = `${PLAN_SHAPE_ANSWER} (host-set — plan granularity is not left to chance)`
                } else {
                    const base = GRILL_AUTO_ANSWER_PROMPT(
                        feature,
                        '(none — clarify runs before decomposition; each task researches itself later)',
                        plainQ
                    )
                    let t = await runPhaseChild(deps, 'clarify-triage', 'read', base)
                    if (!autoAnswerHasTag(t)) {
                        t = await runPhaseChild(
                            deps,
                            'clarify-triage',
                            'read',
                            prependHint(GRILL_AUTO_FORMAT_HINT, base)
                        )
                    }
                    const a = parseAutoAnswer(t)
                    answer =
                        a.kind === 'answered' ?
                            `${a.text} (auto-resolved — already settled by the spec)`
                            // YOLO takes the recommendation when the fork reaches the user.
                        :   `${stripInlineMarkdown(parsed[0].suggested ?? a.suggested ?? '')} (accepted recommendation)`
                }
                clarifications = `Q1: ${plainQ}\nA1: ${answer}`
            }

            // ── decompose + the silent floor's split reprompt ────────────────
            const prompt = AUTO_DECOMPOSE_PROMPT(
                feature,
                clarifications,
                buildRequirementsLedger(entries),
                mandatesTestsInSameChange(clarifications, feature)
            )
            const parse = (out: string): string[] =>
                rewriteBatchTestPlan(
                    reconcileTitleSources(parseDecomposeList(out), feature).titles,
                    clarifications,
                    feature,
                    entries.map(e => e.quote),
                    isCrossCuttingRequirement
                ).titles
            let titles = parse(await runPhaseChild(deps, 'auto-decompose', 'read', prompt))
            let retried = false
            if (isTooCoarse(titles.length, floor)) {
                retried = true
                const split = parse(
                    await runPhaseChild(
                        deps,
                        'auto-decompose',
                        'read',
                        prependHint(granularitySplitHint(titles.length, ownable), prompt)
                    )
                )
                if (split.length > titles.length) titles = split
            }

            const ok = titles.length >= c.lo && titles.length <= c.hi
            if (ok) inRange++
            const line =
                `${c.name.padEnd(26)} | ${String(c.lo).padStart(2)}-${String(c.hi).padEnd(2)}`
                + ` | ${String(titles.length).padStart(3)} | ${ok ? 'ok  ' : 'OUT '}`
                + ` | reqs ${String(ownable).padStart(2)} floor ${String(floor).padStart(2)}`
                + ` | plan-shape ${planShapeFired ? 'HOST' : 'no  '}${retried ? ' split' : ''}`
                + ` | ${Math.round((Date.now() - t0) / 1000)}s`
            rows.push(line)
            console.log(line)
        } catch (e) {
            const line = `${c.name.padEnd(26)} | ${c.lo}-${c.hi} | ERR | ${String(e).slice(0, 90)}`
            rows.push(line)
            console.log(line)
        }
    }

    console.log('\n=== plan size smoke ===')
    console.log('case                       | exp   | act | ?    | requirements  | clarify        | time')
    for (const r of rows) console.log(r)
    console.log(`\nin expected range: ${inRange}/${rows.length}`)
}

main().catch(e => {
    console.error(e)
    process.exit(1)
})
