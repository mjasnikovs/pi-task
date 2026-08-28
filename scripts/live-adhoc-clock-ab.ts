/**
 * STEP 1 of the `adhoc` clock question: how often does a REAL `pi-worker` call
 * need more than the 240s its profile allows?
 *
 * THE QUESTION. `WORKER_PROFILES.adhoc` runs a FIXED 240s wall clock, because
 * `progressCeilingMs` is null and the deadline re-arm is inert without one. The
 * `research` profile — doing the same read-only exploration with, for
 * `worker:files`, the IDENTICAL tool set — runs 240s WITHOUT PROGRESS up to a
 * 20-minute backstop. Nobody chose that difference; it is the residue of the
 * knobs having lived at three call sites instead of in a table.
 *
 * WHY ONE ARM AND NOT TWO. Under a fixed cap no single attempt can exceed 240s.
 * So "would the shipped profile have killed this?" is answered by the treatment
 * arm alone: any trial whose honest work runs past 240s is one the shipped cap
 * kills and restarts. Running a baseline arm to observe that would be measuring
 * arithmetic. What the baseline arm IS needed for — does a worker allowed to run
 * four times longer answer WORSE — is STEP 2, and only for the trials this step
 * finds over the line. Screening first is what keeps a ~2h run from being ~5h.
 *
 * WHY THESE PROMPTS. They are not invented. All 45 are real `pi-worker` calls
 * recovered from pi's own session transcripts (`~/.pi/agent/sessions`), the only
 * place the tool is recorded at all — it is unreachable from every pipeline
 * child, so it appears in zero of ~119k logged child tool calls. Inventing
 * prompts of the "right shape" would be choosing the answer: breadth is exactly
 * what drives the duration, and `worker:files`, same tools but a fixed narrow
 * prompt, exceeds 240s in 1 of 68 runs.
 *
 * WHY A PINNED COPY. Both this step and STEP 2's pairing must read the same
 * bytes, and four of the five repos are trees the user actively works in. The
 * corpus is a `git archive` of a NAMED SHA per repo (`pins.txt`), not HEAD — see
 * memory/ab-baseline-ref-must-not-move. The 23 prompts that named an absolute
 * path were rewritten to the copy, and the fixture records which
 * (`promptRewritten`); a prompt still naming a live tree would have the worker
 * reading a moving target through `read`.
 *
 * THE INSTRUMENT. `RunWorkerResult.timedOut` — not the tool's text. Until
 * 0.38.26 every kill cause printed "Worker aborted.", which is why this base
 * rate could not be taken from production in the first place.
 *
 * ⚠ THE HARNESS MUST RUN THE TOOL'S OWN REASONING LEVEL. The first 18 trials of
 * this run were thrown away because it did not: `pi-worker.ts` passes
 * `groupThinkingArgs('research')`, currently `--thinking medium`, and omitting
 * `thinking` inherits the session default instead. That is a different
 * configuration of the very thing being measured. The level now rides in the
 * ledger fingerprint alongside the model identity and the corpus pins, so a
 * resume cannot silently reuse a row produced at another level — which is
 * exactly what would have happened here.
 *
 * ⚠ THE PROMPTS ARE RECORDED; THE DURATIONS ARE NOT. 44 of the 51 recorded calls
 * were made by `Qwen3.6-27B-UD-Q4_K_XL`, and this machine now serves
 * `Qwen3.8-27B-NVFP4-MTP-VERY-HIGH`. So the recorded elapsed times — from which
 * "4 of 37 single-call dispatches exceeded 240s" was derived — are a PRIOR, not a
 * baseline, and this run's rate may NOT be compared with them: that would be
 * comparing two models. What this run measures is the only thing a ship decision
 * needs: on the model actually being served, how often does a real `pi-worker`
 * prompt need more than the 240s its profile allows. `recordedElapsedS` rides in
 * the fixture for context and is deliberately not used in any verdict, and the
 * ledger fingerprint carries the model identity so a resume cannot mix two.
 *
 * Run:
 *   PI_BIN=<pi> bun run scripts/live-adhoc-clock-ab.ts [--limit N] [--repo gofer]
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {requirePreconditions} from './ab-preflight.js'
import {llamaModelIdentity} from './ab-preflight.js'
import {runWorker} from '../src/workers/pi-worker-core.js'
import {groupThinkingArgs} from '../src/config/reasoning-args.js'
import {workerPolicy} from '../src/workers/worker-profiles.js'

const CORPUS_ROOT = '/home/edgars/.cache/pi-task-adhoc-clock-ab'
const FIXTURE = path.join(import.meta.dir, 'fixtures', 'adhoc-clock-corpus.json')

/** The shipped `adhoc` cap. A trial past this is one the shipped profile kills. */
const ADHOC_CAP_MS = 240_000

interface Row {
    id: string
    repoKey: string
    cwd: string
    prompt: string
    recordedElapsedS: number
    recordedBatch: number
    recordedFailed: boolean
    promptRewritten: boolean
}

interface Trial {
    id: string
    repoKey: string
    elapsedMs: number
    /** Did the PROGRESS deadline fire? Distinct from exceeding the shipped cap. */
    timedOut: boolean
    restarts: number
    exitCode: number
    aborted: boolean
    answerChars: number
    /** THE MEASURE: would the shipped fixed 240s cap have killed this trial? */
    overShippedCap: boolean
}

function ledgerPath(): string {
    return process.env.AB_LEDGER ?? path.join(os.tmpdir(), 'pi-task-adhoc-clock-ledger.jsonl')
}

/**
 * Appended after EVERY trial. A harness that holds results in memory turns any
 * interruption into a total loss of the GPU hours already spent
 * (memory/ab-group-harness-needs-a-ledger).
 */
function appendTrial(t: Trial, fingerprint: string | null): void {
    fs.appendFileSync(
        ledgerPath(),
        JSON.stringify({...t, fingerprint, at: new Date().toISOString()}) + '\n'
    )
}

/**
 * Trials already recorded UNDER THE SAME MODEL AND THE SAME CORPUS PINS.
 *
 * Both must match. A ledger written against another model is another
 * experiment; one written against another pin read different bytes.
 */
function loadLedger(fingerprint: string | null): Map<string, Trial> {
    const file = ledgerPath()
    const out = new Map<string, Trial>()
    if (!fs.existsSync(file)) return out
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (line.trim() === '') continue
        try {
            const row = JSON.parse(line) as Trial & {fingerprint: string | null}
            if (row.fingerprint === fingerprint) out.set(row.id, row)
        } catch {
            // A torn last line is what a kill -9 mid-write leaves. Skip it.
        }
    }
    return out
}

function pins(): string {
    return fs.readFileSync(path.join(CORPUS_ROOT, 'pins.txt'), 'utf8').trim()
}

async function runOne(row: Row): Promise<Trial> {
    const started = Date.now()
    let restarts = 0
    // The TREATMENT: research's deadline shape on an otherwise untouched `adhoc`
    // profile. Written as a whole row so it cannot silently inherit half of one.
    const r = await runWorker({
        prompt: row.prompt,
        cwd: row.cwd,
        profile: 'adhoc',
        // WHAT THE REAL TOOL PASSES. `pi-worker.ts` resolves the `research`
        // group — it is the same read-only exploration loop, just dispatched by
        // a model rather than the pipeline — and it currently resolves to
        // `--thinking medium`. Omitting it here inherits the session default
        // instead, which is a DIFFERENT configuration: reasoning level moves both
        // wall clock and answer quality, the two things this run measures.
        thinking: groupThinkingArgs('research'),
        override: {
            'worker-timeout': {
                timeoutMs: ADHOC_CAP_MS,
                progressCeilingMs: 1_200_000,
                fanout: null
            }
        },
        onRestart: () => {
            restarts++
        }
    })
    const elapsedMs = Date.now() - started
    // The answer TEXT, not just its length. STEP 2 scores citation fidelity and
    // cannot do it from a character count; the ledger stays small and greppable.
    const dir = path.join(CORPUS_ROOT, 'answers')
    fs.mkdirSync(dir, {recursive: true})
    fs.writeFileSync(path.join(dir, `${row.id}.progress.txt`), r.text)
    return {
        id: row.id,
        repoKey: row.repoKey,
        elapsedMs,
        timedOut: r.timedOut === true,
        restarts,
        exitCode: r.exitCode,
        aborted: r.aborted,
        answerChars: r.text.trim().length,
        overShippedCap: elapsedMs > ADHOC_CAP_MS
    }
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2)
    const limit = argv.includes('--limit') ? Number(argv[argv.indexOf('--limit') + 1]) : Infinity
    const onlyRepo = argv.includes('--repo') ? argv[argv.indexOf('--repo') + 1] : null

    const {fingerprint} = await requirePreconditions('live-adhoc-clock-ab', {
        model: {url: 'http://127.0.0.1:8080/props', identity: llamaModelIdentity},
        piBin: true,
        cacheOff: true,
        corpora: [path.join(CORPUS_ROOT, 'corpus')]
    })
    // The corpus pins ride INSIDE the fingerprint: a resume must not mix a trial
    // that read gofer@9bc345b with one that read a later gofer.
    const stamp = fingerprint === null ? null : `${fingerprint}\n${pins()}\nthinking=${groupThinkingArgs('research').join(' ')}`

    let rows = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Row[]
    if (onlyRepo !== null) rows = rows.filter(r => r.repoKey === onlyRepo)
    rows = rows.slice(0, limit)

    const done = loadLedger(stamp)
    console.log(`ledger:  ${ledgerPath()}`)
    console.log(`corpus:  ${CORPUS_ROOT}\n${pins().replace(/^/gm, '         ')}`)
    console.log(`trials:  ${rows.length}   already in ledger: ${done.size}`)
    console.log(`arm:     progress deadline — ${ADHOC_CAP_MS / 1000}s without progress, 1200s ceiling`)
    console.log(
        `shipped: FIXED ${ADHOC_CAP_MS / 1000}s cap `
            + `(adhoc = ${JSON.stringify(workerPolicy('adhoc').guards['worker-timeout'])})\n`
    )

    const trials: Trial[] = []
    for (const row of rows) {
        const cached = done.get(row.id)
        if (cached) {
            trials.push(cached)
            console.log(`  ${row.id} ${row.repoKey.padEnd(11)} SKIP (ledger)`)
            continue
        }
        const t = await runOne(row)
        appendTrial(t, stamp)
        trials.push(t)
        console.log(
            `  ${t.id} ${t.repoKey.padEnd(11)} ${(t.elapsedMs / 1000).toFixed(1)}s`
                + ` chars=${t.answerChars}`
                + (t.overShippedCap ? '  <-- SHIPPED CAP WOULD HAVE KILLED THIS' : '')
                + (t.timedOut ? '  [progress deadline FIRED]' : '')
        )
    }

    const n = trials.length
    const over = trials.filter(t => t.overShippedCap)
    const ms = trials.map(t => t.elapsedMs).sort((a, b) => a - b)
    console.log('\n=== STEP 1 ===')
    console.log(`  trials                          ${n}`)
    console.log(
        `  median ${(ms[Math.floor(n / 2)]! / 1000).toFixed(0)}s`
            + `   p90 ${(ms[Math.floor(n * 0.9)]! / 1000).toFixed(0)}s`
            + `   max ${(ms[n - 1]! / 1000).toFixed(0)}s`
    )
    console.log(
        `  OVER the shipped 240s cap       ${over.length}/${n}`
            + ` = ${((100 * over.length) / n).toFixed(0)}%`
    )
    console.log(`  progress deadline fired anyway  ${trials.filter(t => t.timedOut).length}/${n}`)
    console.log(`  empty answers                   ${trials.filter(t => t.answerChars === 0).length}/${n}`)
    if (over.length > 0) {
        console.log('\n  STEP 2 candidates (these get the paired baseline run):')
        for (const t of over) console.log(`    ${t.id} ${t.repoKey} ${(t.elapsedMs / 1000).toFixed(0)}s`)
    }
}

await main()
