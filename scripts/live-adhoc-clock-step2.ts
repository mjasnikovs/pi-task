/**
 * STEP 2 of the `adhoc` clock question: does a worker allowed to run four times
 * longer answer WORSE?
 *
 * STEP 1 screened all 45 recorded `pi-worker` prompts under the progress
 * deadline and reported which ones run past 240s. Those, and only those, are
 * where the two policies DIFFER — everywhere else both arms run the same worker
 * to the same end, and pairing them would spend GPU to measure zero. This step
 * runs that subset in BOTH arms against the same pinned tree.
 *
 *   BASELINE   the shipped `adhoc` row: a FIXED 240s cap. An attempt that runs
 *              past it is killed and re-spawned with WORKER_TIMEOUT_HINT, three
 *              attempts, then the worker returns whatever it has.
 *   TREATMENT  research's deadline shape: 240s WITHOUT PROGRESS, 1200s ceiling.
 *
 * MATCHED DESIGN, MATCHED STATISTIC. Every prompt appears in both arms against
 * byte-identical trees, so the pairing is real and the test must be paired —
 * McNemar on delivered/not, Wilcoxon signed-rank on fidelity. An unpaired test
 * on a matched design has produced p = 0.3408 where the paired one gave 0.0019
 * on the same numbers (memory/ab-statistic-must-match-design).
 *
 * TWO OUTCOMES, AND THE SECOND IS THE ONE THAT MATTERS.
 *
 *   DELIVERY   did the worker return an answer at all. The baseline arm's
 *              failure mode is returning nothing after 720s.
 *   FIDELITY   of the repo paths the answer names, how many exist in the tree it
 *              was pointed at (adhoc-clock-score.ts). This is the invariant, not
 *              the win: a treatment that delivers more text by naming files it
 *              never read is a regression wearing a win's clothes, and length
 *              alone cannot see it because the treatment writes more BY
 *              CONSTRUCTION.
 *
 * PRE-REGISTERED VERDICT, so the result cannot be read after the fact:
 *   SHIP     delivery up (McNemar p < 0.05) AND fidelity not worse
 *            (Wilcoxon p >= 0.05, or the treatment's median is >= baseline's)
 *   REJECT   fidelity WORSE at p < 0.05, whatever delivery does
 *   ABSTAIN  anything else, including too few discordant pairs to test
 *
 * Run:
 *   PI_BIN=<pi> bun run scripts/live-adhoc-clock-step2.ts
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {requirePreconditions, llamaModelIdentity} from './ab-preflight.js'
import {runWorker} from '../src/workers/pi-worker-core.js'
import {workerPolicy, type WorkerGuardOverride} from '../src/workers/worker-profiles.js'
import {delivered, mcnemarExact, scorePaths, treeEntries} from './adhoc-clock-score.js'

const CORPUS_ROOT = '/home/edgars/.cache/pi-task-adhoc-clock-ab'
const FIXTURE = path.join(import.meta.dir, 'fixtures', 'adhoc-clock-corpus.json')
const ADHOC_CAP_MS = 240_000

type Arm = 'baseline' | 'treatment'

/**
 * The two policies, as whole guard rows.
 *
 * `baseline` is asserted to equal the SHIPPED profile rather than being retyped:
 * an arm that drifts from the thing it claims to represent measures nothing, and
 * this is the file where that drift would be invisible.
 */
const ARMS: Record<Arm, WorkerGuardOverride | undefined> = {
    baseline: undefined,
    treatment: {
        'worker-timeout': {timeoutMs: ADHOC_CAP_MS, progressCeilingMs: 1_200_000, fanout: null}
    }
}

interface Row {
    id: string
    repoKey: string
    cwd: string
    prompt: string
}

interface Trial {
    id: string
    arm: Arm
    repoKey: string
    elapsedMs: number
    timedOut: boolean
    restarts: number
    answerChars: number
    delivered: boolean
    cited: number
    real: number
    unfound: string[]
}

function ledgerPath(): string {
    return process.env.AB_LEDGER2 ?? path.join(os.tmpdir(), 'pi-task-adhoc-clock-step2.jsonl')
}
function pins(): string {
    return fs.readFileSync(path.join(CORPUS_ROOT, 'pins.txt'), 'utf8').trim()
}
function appendTrial(t: Trial, fp: string | null): void {
    fs.appendFileSync(ledgerPath(), JSON.stringify({...t, fingerprint: fp}) + '\n')
}
function loadLedger(fp: string | null): Map<string, Trial> {
    const out = new Map<string, Trial>()
    if (!fs.existsSync(ledgerPath())) return out
    for (const line of fs.readFileSync(ledgerPath(), 'utf8').split('\n')) {
        if (line.trim() === '') continue
        try {
            const r = JSON.parse(line) as Trial & {fingerprint: string | null}
            if (r.fingerprint === fp) out.set(`${r.id}:${r.arm}`, r)
        } catch {
            /* torn last line from a kill -9 */
        }
    }
    return out
}

/** Trials STEP 1 found over the shipped cap — the only prompts where the arms differ. */
function step1Candidates(): Set<string> {
    const f = process.env.AB_LEDGER ?? path.join(CORPUS_ROOT, 'ledger.jsonl')
    const out = new Set<string>()
    if (!fs.existsSync(f)) return out
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        if (line.trim() === '') continue
        try {
            const r = JSON.parse(line) as {id: string; overShippedCap: boolean}
            if (r.overShippedCap) out.add(r.id)
        } catch {
            /* torn line */
        }
    }
    return out
}

async function runOne(row: Row, arm: Arm, tree: ReadonlySet<string>): Promise<Trial> {
    const started = Date.now()
    let restarts = 0
    const r = await runWorker({
        prompt: row.prompt,
        cwd: row.cwd,
        profile: 'adhoc',
        ...(ARMS[arm] ? {override: ARMS[arm]} : {}),
        onRestart: () => {
            restarts++
        }
    })
    const dir = path.join(CORPUS_ROOT, 'answers')
    fs.mkdirSync(dir, {recursive: true})
    fs.writeFileSync(path.join(dir, `${row.id}.${arm}.txt`), r.text)
    const f = scorePaths(r.text, tree)
    return {
        id: row.id,
        arm,
        repoKey: row.repoKey,
        elapsedMs: Date.now() - started,
        timedOut: r.timedOut === true,
        restarts,
        answerChars: r.text.trim().length,
        delivered: delivered(r.text),
        cited: f.cited,
        real: f.suffixReal,
        unfound: f.unfound
    }
}

async function main(): Promise<void> {
    const {fingerprint} = await requirePreconditions('live-adhoc-clock-step2', {
        model: {url: 'http://127.0.0.1:8080/props', identity: llamaModelIdentity},
        piBin: true,
        cacheOff: true,
        corpora: [path.join(CORPUS_ROOT, 'corpus')]
    })
    const stamp = fingerprint === null ? null : `${fingerprint}\n${pins()}`

    // The baseline arm must BE the shipped profile, not a copy of it.
    const shipped = JSON.stringify(workerPolicy('adhoc').guards['worker-timeout'])
    if (ARMS.baseline !== undefined) throw new Error('baseline arm must be the bare profile')
    console.log(`baseline: the shipped adhoc row, unmodified — ${shipped}`)
    console.log(`treatment: ${JSON.stringify(ARMS.treatment!['worker-timeout'])}`)

    const cand = step1Candidates()
    const all = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Row[]
    const rows = all.filter(r => cand.has(r.id))
    if (rows.length === 0) {
        console.error('\nABSTAIN — STEP 1 found no prompt over the shipped cap. Run it first.')
        process.exit(2)
    }
    console.log(`pairs:    ${rows.length} prompts x 2 arms  (STEP 1 found these over 240s)`)
    // POWER, BEFORE THE GPU. Exact two-sided McNemar with every discordant pair
    // falling one way gives p = 2 * 0.5^n, so n = 5 lands at 0.0625 and NO
    // delivery result can reach 0.05 below six. Running anyway would buy a
    // guaranteed ABSTAIN at full price; say so here instead of after.
    const MIN_DISCORDANT = 6
    if (rows.length < MIN_DISCORDANT) {
        console.log(
            `\n  ⚠ UNDERPOWERED for the delivery axis: ${rows.length} candidate pair(s), and even`
                + ` if EVERY one fell the same way the best reachable p is`
                + ` ${mcnemarExact(0, rows.length).toFixed(4)}.`
        )
        console.log(
            '  The fidelity invariant is still worth measuring — a REJECT does not need the'
                + '\n  delivery axis — so this continues, but a SHIP verdict is out of reach.'
        )
    }
    console.log(`ledger:   ${ledgerPath()}\n`)

    const trees = new Map<string, ReadonlySet<string>>()
    const done = loadLedger(stamp)
    const got: Trial[] = []
    for (const row of rows) {
        if (!trees.has(row.repoKey)) {
            trees.set(row.repoKey, treeEntries(path.join(CORPUS_ROOT, 'corpus', row.repoKey)))
        }
        for (const arm of ['baseline', 'treatment'] as Arm[]) {
            const hit = done.get(`${row.id}:${arm}`)
            if (hit) {
                got.push(hit)
                console.log(`  ${row.id} ${arm.padEnd(9)} SKIP (ledger)`)
                continue
            }
            const t = await runOne(row, arm, trees.get(row.repoKey)!)
            appendTrial(t, stamp)
            got.push(t)
            console.log(
                `  ${t.id} ${arm.padEnd(9)} ${(t.elapsedMs / 1000).toFixed(0)}s`
                    + ` restarts=${t.restarts} delivered=${t.delivered}`
                    + ` paths=${t.real}/${t.cited}`
            )
        }
    }

    const by = (a: Arm): Map<string, Trial> => new Map(got.filter(t => t.arm === a).map(t => [t.id, t]))
    const B = by('baseline')
    const T = by('treatment')
    const ids = [...B.keys()].filter(k => T.has(k))

    let bOnly = 0
    let tOnly = 0
    const fid: Array<{id: string; b: number; t: number}> = []
    for (const id of ids) {
        const b = B.get(id)!
        const t = T.get(id)!
        if (b.delivered && !t.delivered) bOnly++
        if (!b.delivered && t.delivered) tOnly++
        if (b.cited > 0 && t.cited > 0) {
            fid.push({id, b: b.real / b.cited, t: t.real / t.cited})
        }
    }
    const p = mcnemarExact(bOnly, tOnly)
    console.log('\n=== STEP 2 ===')
    console.log(`  pairs                              ${ids.length}`)
    console.log(`  delivered  baseline ${[...B.values()].filter(t => t.delivered).length}`
        + `  treatment ${[...T.values()].filter(t => t.delivered).length}`)
    console.log(`  discordant  baseline-only ${bOnly}   treatment-only ${tOnly}`)
    console.log(`  McNemar exact two-sided p = ${p.toFixed(4)}`)
    if (fid.length > 0) {
        const dm = fid.map(f => f.t - f.b).sort((a, b) => a - b)
        const med = dm[Math.floor(dm.length / 2)]!
        console.log(`  fidelity pairs ${fid.length}   median (treatment - baseline) = ${med.toFixed(3)}`)
        console.log(`    worse in treatment: ${dm.filter(d => d < -0.001).length}`)
        console.log(`    better in treatment: ${dm.filter(d => d > 0.001).length}`)
    }
    console.log('\n  Verdict is PRE-REGISTERED in this file\'s header. Do not read it after the fact.')
}

await main()
