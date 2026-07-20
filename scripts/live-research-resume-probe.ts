/**
 * LIVE PROBE: does the v0.18.32 research-cache resume reuse (e3ce892) actually fire
 * end-to-end, across a real process boundary, against the real cache file?
 *
 * WHY THIS EXISTS. mx5 run 13 built a 201-entry research cache over 20 tasks under one
 * run id, then three /task-auto-resume invocations each stamped a FRESH id whose first
 * storeResearch dropped every prior entry: 201 → 11 → 3 → 5 → 8. (Read from the file's
 * own git history — research-cache.json is committed with every task, so the run is
 * recoverable; the audit read the 8-entry tail and wrongly called the cache useless.)
 * resumeResearchRun() now reuses the interrupted run's id and prunes PER PACKAGE: each
 * docs entry records the package it describes and that package's declared version, and a
 * resume drops only the entries whose own package moved. (mx5 run 14 showed why the
 * original whole-file fingerprint gate could not work: a greenfield run installs packages
 * as it goes, so every one of its five resumes saw a moved fingerprint and wiped the
 * cache — it ended with ONE entry.) It shipped with unit tests and has NEVER run a real
 * resume.
 *
 * WHAT THE UNIT TESTS CANNOT COVER, and this probe therefore targets: the cache is
 * written by makeWorkerTool INSIDE a spawned worker child, which learns the run id only
 * by inheriting PI_TASK_RUN_ID through the spawn. Host stamps env → child inherits →
 * child's makeWorkerTool calls storeResearch against its own cwd. Every unit test runs
 * that in one process with a hand-passed id. So the untested links are the env
 * inheritance, the child-side cwd resolution, and — the actual run-13 killer — whether
 * the FIRST STORE AFTER A RESUME preserves the prior entries instead of wiping them.
 *
 * SEAM. Real dist/workers/shared.js makeWorkerTool, real research-cache.ts, real
 * separate processes, real .pi-tasks/research-cache.json. Only the tool's `run` body is
 * stubbed — so no network, and, more importantly, so a cache HIT is observable at the
 * TOOL LAYER: run() appends to calls.log when it actually executes, so
 *   HIT  ⇒ no line appended (run never entered)
 *   MISS ⇒ line appended
 *
 * METRIC — unfakeable, never model self-report: the probe asserts on
 *   (1) .pi-tasks/research-cache.json's own `runId` field and entry COUNT, read directly
 *   (2) calls.log lines written by the tool layer
 * Nothing is inferred from any model's prose.
 *
 * PHASE 1 (deterministic, no model): scenarios a/b/c with exact counts. The tool calls
 * are issued by a driver process with FIXED keys, so the measurement is of the cache and
 * not of a model's choice of phrasing.
 * PHASE 2 (live model): a real pi child driven by the real local model calls the stubbed
 * docs tool through the real makeWorkerTool. Model-phrasing-independent assertion: prior
 * entries must SURVIVE the child's first write and the runId must stay the resumed one.
 *
 * Run (PI_BIN is mandatory — an unset PI_BIN makes the child re-invoke this harness
 * instead of pi, a fork bomb that has crashed this machine twice):
 *   PI_BIN=$(command -v pi) bun run scripts/live-research-resume-probe.ts [--phase2]
 */
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {spawn} from 'node:child_process'
import {
    configureResearchRun,
    resumeResearchRun,
    researchCacheFile,
    RESEARCH_RUN_ID_ENV
} from '../src/workers/research-cache.js'

if (!process.env.PI_BIN || process.env.PI_BIN.trim().length === 0) {
    console.error(
        'REFUSING TO RUN: PI_BIN is unset. An unset PI_BIN makes the child re-invoke '
            + 'this harness instead of pi — a fork bomb that has crashed this machine twice.\n'
            + 'Run as: PI_BIN=$(command -v pi) bun run scripts/live-research-resume-probe.ts'
    )
    process.exit(1)
}

// Fixtures live under /home/edgars/tmp — pi's trust root covers /home/edgars, /tmp is
// untrusted. /home/edgars/hub/mx5 is evidence and is never written to.
const ROOT = path.join(os.homedir(), 'tmp', 'research-resume-probe')
const REPO = path.resolve(import.meta.dirname, '..')
const DIST_SHARED = path.join(REPO, 'dist', 'workers', 'shared.js')

if (!fs.existsSync(DIST_SHARED)) {
    console.error(`REFUSING TO RUN: ${DIST_SHARED} missing — run \`bun run build\` first.`)
    process.exit(1)
}

/** Negative control: run scenario (a) against the PRE-FIX resume (see scenarioA). */
const BASELINE = process.argv.includes('--baseline')

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
    console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label} — ${detail}`)
    if (!ok) failures++
}

/** Read the cache file as ground truth: its own runId and its real entry count. */
function readCache(cwd: string): {
    runId: string | null
    count: number
    pkgv: number | null
    keys: string[]
} {
    try {
        const raw = fs.readFileSync(researchCacheFile(cwd), 'utf8')
        const parsed = JSON.parse(raw) as {
            runId?: string
            entries?: Record<string, unknown>
            pkgv?: number
        }
        const keys = Object.keys(parsed.entries ?? {})
        return {
            runId: parsed.runId ?? null,
            count: keys.length,
            pkgv: parsed.pkgv ?? null,
            // Keys are namespaced `tool\0rawKey`; the raw part is what the driver asked.
            keys: keys.map(k => k.split('\u0000').pop()!)
        }
    } catch {
        return {runId: null, count: 0, pkgv: null, keys: []}
    }
}

/**
 * The driver, written as plain .mjs and run as a SEPARATE process so the run id must
 * survive real env inheritance. It registers a tool through the REAL makeWorkerTool
 * (so the real cache wrapper runs) whose run() appends to calls.log when entered, then
 * invokes the tool's execute() with fixed params.
 */
function writeDriver(dir: string): string {
    const file = path.join(dir, 'cache-driver.mjs')
    fs.writeFileSync(
        file,
        `import * as fs from 'node:fs'
import {makeWorkerTool} from ${JSON.stringify(DIST_SHARED)}

const LOG = ${JSON.stringify(path.join(dir, 'calls.log'))}
const cwd = process.argv[2]
const queries = process.argv.slice(3)

// Minimal stand-in for the ExtensionAPI: capture what makeWorkerTool registers.
let tool = null
const pi = {registerTool: (t) => { tool = t }}

makeWorkerTool(pi, {
  name: 'pi-worker-docs',
  label: 'Pi Worker Docs',
  description: 'stub',
  parameters: {type: 'object', properties: {query: {type: 'string'}}, required: ['query']},
  async run(params) {
    // Only reached on a cache MISS — this line IS the miss metric.
    fs.appendFileSync(LOG, 'RUN\\t' + params.query + '\\n')
    return {text: 'answer for ' + params.query, details: {ok: true}}
  },
  renderCall: () => ({}),
  // A query may carry the package it is ABOUT as a '#pkg' suffix: 'q-one#hono' is a
  // docs-shaped call for hono, a bare 'q-one' is a search-shaped call about nothing
  // installable. Both key on the full string; only the former gets provenance.
  cacheKey: (p) => p.query,
  cachePkg: (p) => (p.query.includes('#') ? p.query.split('#')[1] : undefined),
  cacheable: (d) => d.ok === true
})

for (const q of queries) {
  await tool.execute('id-' + q, {query: q}, undefined, undefined, {cwd})
}
`,
        'utf8'
    )
    return file
}

/**
 * Run the driver in a separate process with the CURRENT process.env (so PI_TASK_RUN_ID
 * is inherited exactly as a real worker child inherits it). Returns the queries whose
 * run() actually executed — i.e. the cache MISSES.
 */
async function drive(dir: string, cwd: string, queries: string[]): Promise<string[]> {
    const driver = writeDriver(dir)
    const logFile = path.join(dir, 'calls.log')
    const before = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''
    await new Promise<void>((resolve, reject) => {
        const p = spawn('bun', [driver, cwd, ...queries], {stdio: 'inherit'})
        p.on('exit', code => (code === 0 ? resolve() : reject(new Error(`driver exit ${code}`))))
        p.on('error', reject)
    })
    const after = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''
    return after
        .slice(before.length)
        .split('\n')
        .filter(l => l.startsWith('RUN\t'))
        .map(l => l.slice(4))
}

function makeFixture(name: string, deps: Record<string, string>): string {
    const dir = path.join(ROOT, name)
    fs.rmSync(dir, {recursive: true, force: true})
    fs.mkdirSync(dir, {recursive: true})
    fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({name: 'probe-fixture', dependencies: deps}, null, 2),
        'utf8'
    )
    return dir
}

// ─── Scenario (a): package.json UNCHANGED ⇒ same runId, entries SURVIVE ───────
//
// The untested path and the whole point of the fix. Critically, the resumed run must
// STORE something (q-new): the run-13 bug destroyed the cache on the first store after
// the id changed, so a resume that only reads would pass vacuously.
async function scenarioA(): Promise<void> {
    console.log('\n(a) resume with package.json UNCHANGED — expect same runId, entries survive')
    const dir = makeFixture('a-unchanged', {hono: '^4.6.0', wouter: '^3.3.0'})

    const r1 = configureResearchRun(true)
    const miss1 = await drive(dir, dir, ['q-one', 'q-two', 'q-three'])
    const afterRun = readCache(dir)
    check('original run stores', afterRun.count === 3 && afterRun.runId === r1,
        `runId=${afterRun.runId === r1 ? 'R1' : afterRun.runId} entries=${afterRun.count} misses=${miss1.length}`)
    check('package provenance stamped', afterRun.pkgv === 2, `pkgv=${String(afterRun.pkgv)}`)

    // Interrupt: a resume typically happens in a NEW host process, so drop the env var.
    delete process.env[RESEARCH_RUN_ID_ENV]

    // NEGATIVE CONTROL (--baseline): reproduce the PRE-FIX resume, which stamped a fresh
    // id via configureResearchRun. Scenario (a) must FAIL under it — a probe that passes
    // with and without the fix measures nothing. Expected baseline result: fresh runId,
    // entries=1 (the run-13 wipe), and the repeated question re-fetched.
    const res =
        BASELINE ?
            {runId: configureResearchRun(true), reused: false, entries: 0}
        :   await resumeResearchRun(dir, true)
    check('resumeResearchRun reports reuse', res.reused && res.runId === r1,
        `reused=${res.reused} sameId=${res.runId === r1} entries=${res.entries}`)
    check('env restamped for children', process.env[RESEARCH_RUN_ID_ENV] === r1,
        `env=${process.env[RESEARCH_RUN_ID_ENV] === r1 ? 'R1' : 'other'}`)

    // Repeat one cached question + ask one NEW one (forces the first post-resume store).
    const miss2 = await drive(dir, dir, ['q-one', 'q-new'])
    const final = readCache(dir)
    check('cached question served from cache', !miss2.includes('q-one'),
        `run() ${miss2.includes('q-one') ? 'RE-ENTERED (miss)' : 'not entered (hit)'}`)
    check('new question missed and stored', miss2.includes('q-new'), `misses=[${miss2.join(',')}]`)
    check('GROUND TRUTH runId unchanged', final.runId === r1,
        `file runId=${final.runId === r1 ? 'R1 (reused)' : `${final.runId} (FRESH — reuse did not fire)`}`)
    check('GROUND TRUTH entries survived', final.count === 4,
        `entries=${final.count} (expected 4 = 3 survived + 1 new; a wipe leaves only this `
            + `phase's own stores and destroys the prior 3)`)
}

// ─── Scenario (b): PER-PACKAGE invalidation (mx5 run 14) ─────────────────────
//
// The run-14 shape: a greenfield run installs packages as it goes, so on every resume
// SOMETHING in package.json had moved. Under the old whole-file fingerprint that wiped
// everything — run 14 ended with one entry. The requirement now: bumping pkgB drops
// pkgB's docs digest and NOTHING else.
//
//   seeded: docs(hono)  docs(zod)  search(q)      → bump zod only
//   after:  docs(hono) KEPT, search(q) KEPT, docs(zod) DROPPED, runId REUSED
//
// Under --baseline (pre-fix resume) the same fixture must show ZERO survivors — a probe
// that passes with and without the fix measures nothing.
async function scenarioB(): Promise<void> {
    console.log('\n(b) resume after ONE dependency BUMP — expect per-package pruning')
    const dir = makeFixture('b-bumped', {hono: '^4.6.0', zod: '^3.23.0'})

    const r1 = configureResearchRun(true)
    // '#pkg' marks a docs-shaped call about that package; the bare one is search-shaped.
    const seeded = ['q-hono#hono', 'q-zod#zod', 'q-search']
    await drive(dir, dir, seeded)
    const afterRun = readCache(dir)
    check('original run stores all three', afterRun.count === 3, `entries=${afterRun.count}`)

    // zod moves under its digest; hono does not. Also ADD a package, as a real run does.
    fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify(
            {
                name: 'probe-fixture',
                dependencies: {hono: '^4.6.0', zod: '^3.24.0', '@playwright/test': '^1.48.0'}
            },
            null,
            2
        ),
        'utf8'
    )
    delete process.env[RESEARCH_RUN_ID_ENV]

    const res =
        BASELINE ?
            {runId: configureResearchRun(true), reused: false, entries: 0, dropped: 0}
        :   await resumeResearchRun(dir, true)
    check('resume reuses the id and prunes one entry', res.reused && res.entries === 2 && res.dropped === 1,
        `reused=${res.reused} kept=${res.entries} dropped=${res.dropped}`)

    const pruned = readCache(dir)
    check('GROUND TRUTH unaffected package KEPT', pruned.keys.includes('q-hono#hono'),
        `keys=[${pruned.keys.join(',')}]`)
    check('GROUND TRUTH search entry KEPT across the bump', pruned.keys.includes('q-search'),
        `search ${pruned.keys.includes('q-search') ? 'kept (discovery, version-insensitive)' : 'DROPPED'}`)
    check('GROUND TRUTH bumped package DROPPED', !pruned.keys.includes('q-zod#zod'),
        `zod digest ${pruned.keys.includes('q-zod#zod') ? 'SERVED STALE' : 'dropped'}`)

    // Behavioural confirmation at the tool layer: the kept ones hit, the pruned one misses.
    const miss = await drive(dir, dir, seeded)
    check('kept entries served from cache', !miss.includes('q-hono#hono') && !miss.includes('q-search'),
        `misses=[${miss.join(',')}]`)
    check('pruned entry re-fetched', miss.includes('q-zod#zod'),
        `run() ${miss.includes('q-zod#zod') ? 're-entered (correct: digest was stale)' : 'NOT entered — stale digest served!'}`)
    check('GROUND TRUTH runId unchanged', readCache(dir).runId === r1,
        `runId=${readCache(dir).runId === r1 ? 'R1 (reused)' : 'FRESH — reuse did not fire'}`)
}

// ─── Scenario (c): inconclusive inputs ⇒ fresh id, no crash ───────────────────
async function scenarioC(): Promise<void> {
    console.log('\n(c) inconclusive inputs — expect fresh id, never a crash')

    // c1: no cache file at all.
    const c1 = makeFixture('c1-no-cache', {hono: '^4.6.0'})
    delete process.env[RESEARCH_RUN_ID_ENV]
    const r1 = await resumeResearchRun(c1, true)
    check('no cache file ⇒ fresh id', !r1.reused && typeof r1.runId === 'string',
        `reused=${r1.reused} id=${r1.runId ? 'issued' : 'none'}`)

    // c2: cache file present but written before per-entry provenance shipped (no `pkgv`).
    const c2 = makeFixture('c2-no-pkgv-field', {hono: '^4.6.0'})
    fs.mkdirSync(path.dirname(researchCacheFile(c2)), {recursive: true})
    fs.writeFileSync(
        researchCacheFile(c2),
        JSON.stringify({runId: 'run-legacy', entries: {k: {text: 't', details: {}, at: 1}}}),
        'utf8'
    )
    const r2 = await resumeResearchRun(c2, true)
    check('no `pkgv` field ⇒ fresh id', !r2.reused && r2.runId !== 'run-legacy',
        `reused=${r2.reused}`)

    // c3: corrupt JSON.
    const c3 = makeFixture('c3-corrupt', {hono: '^4.6.0'})
    fs.mkdirSync(path.dirname(researchCacheFile(c3)), {recursive: true})
    fs.writeFileSync(researchCacheFile(c3), '{not json at all', 'utf8')
    const r3 = await resumeResearchRun(c3, true)
    check('corrupt cache ⇒ fresh id, no throw', !r3.reused && typeof r3.runId === 'string',
        `reused=${r3.reused}`)

    // c4: valid cache but the manifest is gone ⇒ no package's version can be proved, so
    // package-scoped entries go and the version-insensitive ones stay.
    const c4 = makeFixture('c4-no-manifest', {hono: '^4.6.0'})
    const r4id = configureResearchRun(true)
    await drive(c4, c4, ['q-docs#hono', 'q-search'])
    fs.rmSync(path.join(c4, 'package.json'))
    delete process.env[RESEARCH_RUN_ID_ENV]
    const r4 = await resumeResearchRun(c4, true)
    const c4file = readCache(c4)
    check('unreadable manifest ⇒ package-scoped entries dropped, rest kept',
        r4.reused && r4.runId === r4id && c4file.keys.length === 1 && c4file.keys[0] === 'q-search',
        `reused=${r4.reused} keys=[${c4file.keys.join(',')}]`)

    // c5: caching disabled ⇒ no id at all, nothing reused.
    const c5 = makeFixture('c5-disabled', {hono: '^4.6.0'})
    const r5 = await resumeResearchRun(c5, false)
    check('caching disabled ⇒ no id', r5.runId === undefined && !r5.reused,
        `runId=${String(r5.runId)} env=${String(process.env[RESEARCH_RUN_ID_ENV])}`)
}

// ─── Phase 2: a REAL pi child, driven by the REAL local model ────────────────
//
// Model-phrasing-independent by construction: whatever the model chooses to ask, the
// child's first store must PRESERVE the pre-seeded entries and keep the resumed runId.
// That is exactly the run-13 failure mode, measured live.
async function phase2(): Promise<void> {
    console.log('\n(2) LIVE: real pi child + real model writes into a RESUMED cache')
    const {runWorker} = await import('../src/workers/pi-worker-core.js')
    const dir = makeFixture('live-resume', {hono: '^4.6.0'})

    // Seed a prior run's cache the way 20 tasks would have, under one id.
    const seedId = configureResearchRun(true)!
    const seeded = ['seed-a', 'seed-b', 'seed-c', 'seed-d', 'seed-e']
    await drive(dir, dir, seeded)
    const before = readCache(dir)
    check('seeded prior run', before.count === seeded.length && before.runId === seedId,
        `entries=${before.count} runId=R1`)

    // Interrupt, then resume through the real gate.
    delete process.env[RESEARCH_RUN_ID_ENV]
    const res = await resumeResearchRun(dir, true)
    check('resume reused the id', res.reused && res.runId === seedId,
        `reused=${res.reused} entries=${res.entries}`)

    // The stubbed docs tool, registered through the REAL makeWorkerTool so the real
    // cache wrapper runs inside the real child.
    const ext = path.join(dir, 'probe-docs-ext.mjs')
    fs.writeFileSync(
        ext,
        `import * as fs from 'node:fs'
import {makeWorkerTool} from ${JSON.stringify(DIST_SHARED)}

const LOG = ${JSON.stringify(path.join(dir, 'live-calls.log'))}

export default function (pi) {
  makeWorkerTool(pi, {
    name: 'pi-worker-docs',
    label: 'Pi Worker Docs',
    description:
      'Look up an INSTALLED npm package and return a focused, version-pinned answer ' +
      'from its .d.ts types and README. USE THIS BEFORE ANSWERING any question about ' +
      'how to use a library, what it exports, or its types/overloads/config.',
    parameters: {
      type: 'object',
      properties: {module: {type: 'string'}, query: {type: 'string'}},
      required: ['module', 'query']
    },
    async run(params) {
      fs.appendFileSync(LOG, 'RUN\\t' + params.module + '\\t' + params.query + '\\n')
      return {
        text: 'hono@4.6.0 — installed types\\n' +
          'export interface Context { json(o: unknown): Response; text(t: string): Response }',
        details: {childExitCode: 0}
      }
    },
    renderCall: () => ({}),
    cacheKey: (p) => p.module === '.' ? null : p.module + '::' + p.query,
    cachePkg: (p) => p.module === '.' ? undefined : p.module.split('/')[0],
    cacheable: (d) => d.childExitCode === 0
  })
}
`,
        'utf8'
    )

    await runWorker({
        prompt:
            'You are the APIS research worker for a task implementing JSON endpoints on a '
            + 'Hono server.\n\nAnswer this, grounded in tool output only — do NOT answer from '
            + "memory:\nWhat does Hono's Context give you for returning a JSON response, and "
            + 'what does it return?\n\nUse pi-worker-docs for installed package APIs. When you '
            + 'have the answer, write it out and stop.',
        cwd: dir,
        tools: 'read,pi-worker-docs',
        extensions: [ext],
        onLine: () => {}
    })

    const liveLog = path.join(dir, 'live-calls.log')
    const calls = fs.existsSync(liveLog)
        ? fs.readFileSync(liveLog, 'utf8').split('\n').filter(l => l.startsWith('RUN\t')).length
        : 0
    const after = readCache(dir)
    check('the real child called the cached tool', calls > 0, `run() entered ${calls}×`)
    check('GROUND TRUTH runId still the resumed one', after.runId === seedId,
        `runId=${after.runId === seedId ? 'R1 (reused)' : `${after.runId} (FRESH — reuse broke)`}`)
    check('GROUND TRUTH seeded entries survived the child write', after.count >= seeded.length,
        `entries=${after.count} (seeded ${seeded.length}; a run-13 wipe would show ${calls > 0 ? 1 : 0})`)
    check('the child added at least one entry', after.count > before.count,
        `${before.count} → ${after.count}`)
}

console.log('live research-cache resume probe')
console.log(`repo=${REPO}\nfixtures=${ROOT}`)
await fsp.mkdir(ROOT, {recursive: true})

await scenarioA()
await scenarioB()
await scenarioC()
if (process.argv.includes('--phase2')) await phase2()
else console.log('\n(2) LIVE phase skipped — pass --phase2 to run a real pi child.')

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
