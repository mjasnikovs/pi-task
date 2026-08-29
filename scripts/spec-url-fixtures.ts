/**
 * Shared fixtures and the OFFLINE web for PROMPT 4 — used by both the STEP 2 baseline and
 * the STEP 3 A/B, so the two measurements describe the same world.
 *
 * ── THE TWO FIXTURES ──────────────────────────────────────────────────────────────────────
 *
 * PROMPT 4 requires a second fixture "with a different library and different cited URLs, so
 * a PASS is not a single-case fit". Both are REAL run-15 tasks replayed against their own
 * `chore: checkpoint before "<title>"` commit — the tree exactly as that task's research saw
 * it — not synthetic prompts:
 *
 *   TASK_0027  hono/client, the fatal task. Design cites hono.dev/docs/guides/rpc (§5 line
 *              184 and §13) — the page that documents what `hc`'s base URL MEANS, never
 *              fetched in run 15, and whose absence produced /api/api/… on every request.
 *   TASK_0028  wouter + react, the SPA shell. Design cites github.com/molefrog/wouter#readme
 *              and react.dev/reference/react. Different packages, different pages, different
 *              hosts — and one of them (the wouter README) is associated with its package by
 *              the URL PATH, not the host, which the host-only rule would miss.
 *
 * ── THE OFFLINE WEB, AND THE ONE JUDGEMENT CALL IN IT ─────────────────────────────────────
 *
 * pi-worker-fetch and pi-worker-search are the REAL shipped tools with only their network
 * primitive replaced through the injection hooks they already expose (`fetchAndClean`,
 * `exaSearch`). Everything else about them — tool name, description, parameters, the child
 * summariser, the excerpt verifier — is the shipped code, because the model's behaviour is
 * being measured and it reads those descriptions.
 *
 * The judgement call is what SEARCH returns, and it can rig the experiment in either
 * direction:
 *   - a search corpus made only of the design's own cited pages hands the baseline every
 *     spec URL for free and would understate the lever;
 *   - a corpus with the cited pages removed makes them unreachable except through the lever
 *     and would overstate it.
 * So the corpus is the union of BOTH snapshot sets: the 21 pages the design cites and the 14
 * pages run 15's fetches actually landed on (several of which the design does NOT cite). A
 * cited page is findable by search, exactly as on the real web — the lever has to beat
 * search, not replace it. Identical in both arms.
 *
 * The ranker is deterministic keyword overlap over title+URL. A page whose snapshot is
 * missing (bun.com/docs/bundler exceeds the fetch tool's 2 MB cap — a real shipped failure,
 * reproduced rather than papered over) makes the stub throw, which is what the live tool
 * does too. The metric is recorded BEFORE the fetch is attempted, so a failing fetch still
 * counts as a request — which is correct: the lever's effect is which URL was ASKED for.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {REFINED_27, buildCheckpointTree} from './run15-fixture-tree.js'
import {extractUrls} from './spec-url-reach.js'
import type {WorkerProfileId} from '../src/workers/worker-profiles.js'
import type {RunWorkerInput} from '../src/workers/pi-worker-core.js'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const REPO = path.resolve(HERE, '..')
const MX5 = path.join(os.homedir(), 'hub', 'mx5')

export interface SpecUrlFixture {
    name: string
    taskId: string
    /** mx5 `chore: checkpoint before "<title>"` commit. */
    commit: string
    title: string
    /** Carries `spec: @DESIGN/PROJECT.md`, the only pointer to the design doc in the task. */
    rawPrompt: string
    refined: string
    /** Packages this task's worker:apis asked pi-worker-docs about in run 15, for context. */
    run15Packages: string[]
}

interface TaskJson {
    name: string
    taskId: string
    commit: string
    rawPrompt: string
    refined: string
}

const tasksJson = JSON.parse(
    fs.readFileSync(path.join(HERE, 'fixtures', 'spec-url-tasks.json'), 'utf8')
) as TaskJson[]

const byId = (id: string): TaskJson => {
    const t = tasksJson.find(x => x.taskId === id)
    if (!t) throw new Error(`spec-url-tasks.json has no ${id}`)
    return t
}

export const FIXTURES: SpecUrlFixture[] = [
    {
        name: 'task27-hono',
        taskId: 'TASK_0027',
        commit: byId('TASK_0027').commit,
        title: 'Client API module — typed hono/client hc<AppType> with fetch hooks',
        rawPrompt: byId('TASK_0027').rawPrompt,
        // REFINED_27, not the JSON copy, on purpose: every other TASK_0027 harness in this
        // repo (the context-attribution probe/AB, the termination diagnostic) measured
        // against that exact string, and the two differ only by a typo in the recorded
        // artifact ("KNOWN-UNKNOWNOWNS"). One canonical TASK_0027 fixture beats byte-fidelity
        // to a typo; the JSON keeps the verbatim original either way.
        refined: REFINED_27,
        run15Packages: ['hono', 'hono/client', 'react']
    },
    {
        name: 'task28-wouter',
        taskId: 'TASK_0028',
        commit: byId('TASK_0028').commit,
        title: 'SPA shell — React root, wouter router, navigation component',
        rawPrompt: byId('TASK_0028').rawPrompt,
        refined: byId('TASK_0028').refined,
        run15Packages: ['wouter', 'react', 'react-dom']
    }
]

/** Build one trial tree for a fixture, task file seeded WITH its raw prompt. */
export function buildFixtureTree(root: string, fixture: SpecUrlFixture, trial: number): string {
    return buildCheckpointTree(path.join(root, fixture.name), trial, {
        commit: fixture.commit,
        taskId: fixture.taskId,
        title: fixture.title,
        rawPrompt: fixture.rawPrompt
    })
}

/**
 * The URL set a rep is scored against: every http(s) URL in the design document as it exists
 * in THAT trial's tree. Read from the tree, not from a checked-in list, so the scoring set
 * and the text the lever reads are provably the same bytes.
 */
export function designUrlsOf(treeDir: string): string[] {
    const design = path.join(treeDir, 'DESIGN', 'PROJECT.md')
    if (!fs.existsSync(design)) return []
    return extractUrls(fs.readFileSync(design, 'utf8'))
}

// ─── the offline web ─────────────────────────────────────────────────────────

export interface CorpusPage {
    url: string
    finalUrl: string
    title: string
    markdown: string
}

const SNAPSHOT_DIRS = [
    path.join(HERE, 'fixtures', 'spec-url-pages'),
    path.join(HERE, 'fixtures', 'run15-fetch-pages')
]

/** Every snapshotted page, cited and uncited alike. See the header note on rigging. */
export function loadCorpus(): CorpusPage[] {
    const out = new Map<string, CorpusPage>()
    for (const dir of SNAPSHOT_DIRS) {
        if (!fs.existsSync(dir)) continue
        for (const f of fs.readdirSync(dir).sort()) {
            if (!f.endsWith('.json')) continue
            const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as CorpusPage
            if (p.url && typeof p.markdown === 'string' && !out.has(p.url)) out.set(p.url, p)
        }
    }
    return [...out.values()]
}

/**
 * Env var naming the per-rep call log. The stub extension reads it at INVOCATION time, so a
 * single extension file — whose absolute path is baked into the patched dist once — serves
 * every rep of every arm. Baking a per-rep path in instead would mean re-patching dist
 * between reps, and a dist that changes mid-run is not one experiment.
 */
export const CALLS_LOG_ENV = 'PI_TASK_SPEC_URL_CALLS_LOG'

/**
 * Write the stub research extension and its corpus into `root`, returning the extension path.
 * The .mjs is plain JS because pi loads extension FILES at runtime — there is no TS pipeline
 * inside the child — and it imports the REAL tools from this repo's dist by absolute path.
 */
export function writeStubExtension(root: string): string {
    fs.mkdirSync(root, {recursive: true})
    const corpusPath = path.join(root, 'stub-corpus.json')
    fs.writeFileSync(corpusPath, JSON.stringify(loadCorpus()), 'utf8')
    const file = path.join(root, 'spec-url-stub-ext.mjs')
    const fetchMod = path.join(REPO, 'dist', 'workers', 'pi-worker-fetch.js')
    const searchMod = path.join(REPO, 'dist', 'workers', 'pi-worker-search.js')
    fs.writeFileSync(
        file,
        `import * as fs from 'node:fs'
import {registerPiWorkerFetch} from ${JSON.stringify(fetchMod)}
import {registerPiWorkerSearch} from ${JSON.stringify(searchMod)}

const CORPUS = JSON.parse(fs.readFileSync(${JSON.stringify(corpusPath)}, 'utf8'))
const record = line => {
  const log = process.env[${JSON.stringify(CALLS_LOG_ENV)}]
  if (!log) return
  try { fs.appendFileSync(log, line + '\\n') } catch {}
}

const norm = u => String(u).replace(/\\/+$/, '')
const byUrl = new Map(CORPUS.map(p => [norm(p.url), p]))

// Recorded BEFORE the lookup, so a URL the offline web cannot serve still counts as
// REQUESTED — the lever's effect is which page the worker asked for, not which one loaded.
const stubFetchAndClean = async url => {
  record('fetch\\t' + url)
  const page = byUrl.get(norm(url))
  if (!page) {
    throw new Error(
      'no snapshot for ' + url + ' (offline fixture web; see scripts/snapshot-spec-url-pages.ts)'
    )
  }
  return {title: page.title, markdown: page.markdown, finalUrl: page.finalUrl}
}

const tokens = s => new Set(String(s).toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2))

// Deterministic keyword overlap over title + URL. Both arms see the identical ranking for
// the identical query, so search can help either arm and favours neither.
const stubExaSearch = async (query, opts = {}) => {
  record('search\\t' + query)
  const q = tokens(query)
  const scored = CORPUS.map(p => {
    const t = tokens(p.title + ' ' + p.url)
    let score = 0
    for (const w of q) if (t.has(w)) score++
    return {p, score}
  })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || a.p.url.localeCompare(b.p.url))
    .slice(0, Math.max(1, Math.min(10, opts.count ?? 5)))
  return scored.map(x => ({
    title: x.p.title,
    url: x.p.url,
    description: x.p.markdown.replace(/\\s+/g, ' ').slice(0, 240)
  }))
}

// PROMPT 4 invariant 2 says excerptVerified === false must not rise. For pi-worker-docs that
// counter is already recorded by the shipped PI_TASK_TYPEONLY_LOG sink; for pi-worker-FETCH
// nothing records it, and it is computed deep inside the tool. So the extension API is
// wrapped rather than the tool modified: registerTool is intercepted, execute is wrapped, and
// the verdict the tool RETURNS is written to the same call log. Observation only — the
// wrapper returns the tool's result untouched, so the worker sees the shipped behaviour.
const instrument = pi => ({
  ...pi,
  registerTool(spec) {
    const inner = spec.execute.bind(spec)
    return pi.registerTool({
      ...spec,
      async execute(...args) {
        const r = await inner(...args)
        const d = (r && r.details) || {}
        record('result\\t' + spec.name + '\\t' + JSON.stringify({
          excerptVerified: d.excerptVerified,
          fetchError: d.fetchError ?? d.error
        }))
        return r
      }
    })
  }
})

export default function (pi) {
  const wrapped = instrument(pi)
  registerPiWorkerFetch(wrapped, {fetchAndClean: stubFetchAndClean})
  registerPiWorkerSearch(wrapped, {provider: 'exa', exaSearch: stubExaSearch})
}
`,
        'utf8'
    )
    return file
}

/** URLs this rep handed to pi-worker-fetch, in order, from the stub's own call log. */
export function fetchedUrls(callsLog: string): string[] {
    if (!fs.existsSync(callsLog)) return []
    return fs
        .readFileSync(callsLog, 'utf8')
        .split('\n')
        .filter(l => l.startsWith('fetch\t'))
        .map(l => l.slice('fetch\t'.length).trim())
        .filter(Boolean)
}

/** Search queries this rep issued, from the same log. */
export function searchQueries(callsLog: string): string[] {
    if (!fs.existsSync(callsLog)) return []
    return fs
        .readFileSync(callsLog, 'utf8')
        .split('\n')
        .filter(l => l.startsWith('search\t'))
        .map(l => l.slice('search\t'.length).trim())
        .filter(Boolean)
}

/**
 * Per-tool result records the stub wrapper wrote: one per completed tool call, carrying the
 * `excerptVerified` verdict the shipped tool returned. PROMPT 4 invariant 2 is scored off
 * this — turning silence into confident wrong answers is the failure the whole file is about.
 */
export interface ToolResultRecord {
    tool: string
    excerptVerified?: boolean
    fetchError?: unknown
}

export function toolResults(callsLog: string): ToolResultRecord[] {
    if (!fs.existsSync(callsLog)) return []
    const out: ToolResultRecord[] = []
    for (const l of fs.readFileSync(callsLog, 'utf8').split('\n')) {
        if (!l.startsWith('result\t')) continue
        const [, tool, json] = l.split('\t')
        try {
            out.push({tool, ...(JSON.parse(json) as Omit<ToolResultRecord, 'tool'>)})
        } catch {
            // A torn final line when a child is killed mid-append; skip, do not throw.
        }
    }
    return out
}

const normUrl = (u: string): string => u.replace(/\/+$/, '')

/** Did this rep fetch a URL the design text cites? Returns the matching URLs. */
export function citedFetches(fetched: string[], designUrls: string[]): string[] {
    const cited = new Set(designUrls.map(normUrl))
    return [...new Set(fetched.filter(f => cited.has(normUrl(f))))]
}

export {MX5, REPO}

/**
 * POSITIVE CONTROL — prove the stub actually gives a real child a working pi-worker-fetch,
 * before spending hours interpreting how often it gets used.
 *
 * WHY THIS IS NOT PARANOIA. STEP 2 measured 0 of 20 reps fetching anything at all. That
 * number has two completely different readings — "the worker chooses not to fetch" and "the
 * fetch tool was never registered in the child, so it could not" — and NOTHING in the run
 * output distinguishes them. An extension file that fails to load leaves no error in the
 * trial log; it just silently removes a tool. Both arms of the A/B would then read zero and
 * the run would look like a clean null result. So the toolset is proven reachable by using
 * it: a throwaway worker is told, in terms, to fetch one URL, and the same call log the A/B
 * scores must gain that URL.
 *
 * Costs about a minute of model time per run. Cheap against the alternative.
 */
export async function assertFetchToolReachable(
    root: string,
    cwd: string,
    runWorker: (opts: {
        prompt: string
        cwd: string
        profile: WorkerProfileId
        contextWindow: RunWorkerInput['contextWindow']
        tools: string
        extensions: string[]
        onLine: (l: string) => void
    }) => Promise<unknown>
): Promise<void> {
    const stub = path.join(root, 'spec-url-stub-ext.mjs')
    const log = path.join(root, 'toolcheck.log')
    const probeUrl = 'https://hono.dev/docs/guides/rpc'
    fs.rmSync(log, {force: true})
    const saved = process.env[CALLS_LOG_ENV]
    process.env[CALLS_LOG_ENV] = log
    try {
        await runWorker({
            prompt:
                `Call pi-worker-fetch with url ${probeUrl} and query "what does the hc base `
                + 'URL argument mean". Then reply with one sentence. /no_think',
            cwd,
            profile: 'adhoc', contextWindow: 'unknown',
            tools: 'read,pi-worker-docs,pi-worker-search,pi-worker-fetch',
            extensions: [path.join(REPO, 'dist', 'workers', 'docs-extension.js'), stub],
            onLine: () => {}
        })
    } finally {
        if (saved === undefined) delete process.env[CALLS_LOG_ENV]
        else process.env[CALLS_LOG_ENV] = saved
    }
    const got = fetchedUrls(log)
    if (!got.includes(probeUrl)) {
        throw new Error(
            'POSITIVE CONTROL FAILED: a worker told outright to fetch '
                + `${probeUrl} did not reach the stub (recorded: ${JSON.stringify(got)}). `
                + 'The fetch tool is not registered in the child, so every zero this run '
                + 'produces would be an artifact of the harness, not a fact about the worker. '
                + 'Fix the extension wiring before reading any result.'
        )
    }
    console.log(`  positive control OK — a real child reached pi-worker-fetch(${probeUrl})`)
}
