/**
 * LIVE A/B — is a connection-class model error in a research worker worth
 * retrying, and how much does pi already absorb on its own?
 *
 * THE GAP IT MEASURES. `runWorker` (src/workers/pi-worker-core.ts) restarts on a
 * loop kill, a hung command, a stalled stream and a wall-clock timeout, but had no
 * branch for a connection-class `modelError` — while `runPhaseChild`
 * (src/task/child-runner.ts) has retried exactly that since the connection-retry
 * work. So one dropped fetch inside any of the four research workers failed the
 * whole task at research, while the identical blip in refine/compose was absorbed.
 *
 * THE INSTRUMENT. A flaky proxy sits between pi and the real llama-server and
 * destroys the socket on every request inside a fixed outage window (or for the
 * first K requests). Nothing about the real ~/.pi config or the running server is
 * touched: the child runs under an isolated PI_CODING_AGENT_DIR whose models.json
 * points at the proxy.
 *
 * WHAT STEP 0 FOUND (`--probe`, first K requests fail, one child each, our own
 * retry off). The modelError column is what the PRE-FIX sink reported:
 *
 *     K=0  1 request   answered            no modelError
 *     K=1  2 requests  answered  ~3s       modelError "Connection error." (stale)
 *     K=2  3 requests  answered  ~7s       modelError "Connection error." (stale)
 *     K=3  4 requests  answered  ~15s      modelError "Connection error." (stale)
 *     K=5  4 requests  NO answer ~15s      modelError "Connection error."
 *     K=8  4 requests  NO answer ~15s      modelError "Connection error."
 *
 * Re-run today and the three "(stale)" cells read null instead — that is the sink
 * fix, and K=1..3 is the regression test for it.
 *
 * Two facts, both load-bearing:
 *   1. pi retries a failed turn ITSELF — 4 attempts over ~15s, then it gives up.
 *      An outer retry can therefore only buy survival of an outage that outlasts
 *      pi's own ~15s window; below that there is nothing to win.
 *   2. On a RECOVERED blip pi still emits the dead attempt's agent_end, so the
 *      sink used to latch a "Connection error." onto a run that answered fine.
 *      That was a false failure signal, and it is fixed in JsonEventSink (a later
 *      agent_end carrying text clears the latch). This harness scores by TEXT, so
 *      it measures the same thing before and after that fix.
 *
 * THE A/B (default). Outage window T, arms interleaved rep by rep, BOTH from one
 * build — the baseline passes `connectionRetries: 0` to switch the shipped retry
 * off, the treatment takes the default:
 *   baseline  — one spawn, whatever it returns
 *   treatment — re-spawn on a connection-class modelError, at most
 *               MAX_LOOP_RESTARTS times, with connectionRetryBackoffMs — i.e. the
 *               phase-child policy, mirrored
 * Success = the worker came back with text.
 *
 * RESULT (2026-07-29, 8 reps/arm, Qwen3.6-27B on the local llama-server):
 *
 *     outage   5000ms:  baseline 8/8   treatment 8/8   p=1        (pi absorbs it)
 *     outage  20000ms:  baseline 0/8   treatment 8/8   p=0.00016
 *     outage  35000ms:  baseline 0/8   treatment 8/8   p=0.00016
 *
 * So the retry is worth exactly one band — outages longer than pi's own ~15s and
 * shorter than the three spawns' combined ~46s. It is inert below that band and
 * cannot help above it. The cost, paid only when the backend is really gone, is
 * time-to-report: ~15s → ~46s (verified live against a closed port).
 *
 * Run:
 *   bun run build   # the harness imports the shipped worker from dist/
 *   PI_BIN=$(command -v pi) bun run scripts/connection-retry-ab.ts [REPS] [T,T,...]
 *   PI_BIN=$(command -v pi) bun run scripts/connection-retry-ab.ts --probe
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import {spawn, type ChildProcess} from 'node:child_process'
import {runWorker} from '../dist/workers/pi-worker-core.js'
import {MAX_LOOP_RESTARTS} from '../dist/task/child-runner.js'
import {fisherTwoSided} from './ab-stats.js'

// A pi child with PI_BIN unset re-invokes THIS script instead of pi — a fork bomb
// that has taken the machine down twice. Refuse rather than find out again.
if (!process.env.PI_BIN) {
    console.error('REFUSING TO RUN: PI_BIN unset (fork-bomb guard).')
    process.exit(1)
}

const BASE = process.env.CONN_RETRY_DIR ?? path.join(process.env.HOME ?? '/home/edgars', 'tmp/connretry')
const PORT = Number(process.env.CONN_RETRY_PORT ?? 8099)
const UPSTREAM = Number(process.env.CONN_RETRY_UPSTREAM ?? 8080)
const PROMPT = 'Reply with exactly the word OK and nothing else. /no_think'

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

// ── the flaky endpoint ───────────────────────────────────────────────────────
// Proxies to the real llama-server, except inside the induced outage, where the
// socket is destroyed the moment the request arrives — the client-side shape of a
// dropped connection. Written out and run as its own process so each rep starts
// with fresh counters and a fresh outage clock.
const PROXY_SRC = `
const http = require('http'), fs = require('fs')
const PORT = +process.env.FLAKY_PORT, UP = +process.env.FLAKY_UPSTREAM
const FAIL_FIRST = +(process.env.FLAKY_FAIL_FIRST || 0)
const FAIL_MS = +(process.env.FLAKY_FAIL_MS || 0)
const LOG = process.env.FLAKY_LOG
let n = 0, t0 = null
http.createServer((req, res) => {
    n++; if (t0 === null) t0 = Date.now()
    const t = Date.now() - t0
    const fail = (FAIL_FIRST > 0 && n <= FAIL_FIRST) || (FAIL_MS > 0 && t < FAIL_MS)
    fs.appendFileSync(LOG, JSON.stringify({n, t, path: req.url, fail}) + '\\n')
    if (fail) return void req.socket.destroy()
    const up = http.request(
        {host: '127.0.0.1', port: UP, method: req.method, path: req.url,
         headers: {...req.headers, host: '127.0.0.1:' + UP}},
        r2 => { res.writeHead(r2.statusCode || 502, r2.headers); r2.pipe(res) }
    )
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
    req.pipe(up)
}).listen(PORT, '127.0.0.1', () => process.stdout.write('ready\\n'))
`

async function startProxy(env: Record<string, string>, log: string): Promise<ChildProcess> {
    fs.rmSync(log, {force: true})
    fs.writeFileSync(log, '')
    const p = spawn('node', ['-e', PROXY_SRC], {
        env: {
            ...process.env,
            FLAKY_PORT: String(PORT),
            FLAKY_UPSTREAM: String(UPSTREAM),
            FLAKY_LOG: log,
            ...env
        },
        stdio: ['ignore', 'pipe', 'pipe']
    })
    await new Promise<void>(r => p.stdout?.once('data', () => r()))
    return p
}

/** Isolated agent dir so the real ~/.pi config and the live server are untouched. */
function makeAgentDir(): string {
    const dir = path.join(BASE, 'agent')
    fs.mkdirSync(dir, {recursive: true})
    fs.mkdirSync(path.join(BASE, 'work'), {recursive: true})
    fs.writeFileSync(
        path.join(dir, 'models.json'),
        JSON.stringify({
            providers: {
                local: {
                    baseUrl: `http://127.0.0.1:${PORT}/v1`,
                    api: 'openai-completions',
                    apiKey: 'local',
                    compat: {supportsDeveloperRole: false, supportsReasoningEffort: false},
                    models: [
                        {
                            id: 'Qwen3.6-27B-UD-Q4_K_XL.gguf',
                            name: 'Qwen3.6 27B',
                            contextWindow: 120064,
                            maxTokens: 120064
                        }
                    ]
                }
            }
        })
    )
    return dir
}

const AGENT_DIR = makeAgentDir()
process.env.PI_CODING_AGENT_DIR = AGENT_DIR
const CWD = path.join(BASE, 'work')

interface Outcome {
    ok: boolean
    note: string
}

/**
 * Pre-fix behaviour: one spawn, whatever it returns. `connectionRetries: 0` is
 * what makes this arm honest on a build that already ships the retry — without
 * it both arms would be the treatment and the A/B would read 8/8 vs 8/8.
 */
async function baseline(): Promise<Outcome> {
    const r = await runWorker({
        prompt: PROMPT,
        profile: 'adhoc', contextWindow: 'unknown',
        override: {
            'worker-timeout': {timeoutMs: 240_000, progressCeilingMs: null, fanout: null},
            'connection-error': 0
        },
        cwd: CWD,
    })
    const text = r.text.trim()
    return {
        ok: text.length > 0,
        note: `text=${text.length} modelError=${JSON.stringify(r.modelError ?? null)}`
    }
}

/** The shipped policy — connection class only, shared restart budget, same
 *  backoff as a phase child. runWorker reports only its final attempt, so how
 *  many spawns it took is read off the proxy's request log instead. */
async function treatment(): Promise<Outcome> {
    const r = await runWorker({prompt: PROMPT, cwd: CWD, profile: 'adhoc', contextWindow: 'unknown', override: {'worker-timeout': {timeoutMs: 240_000, progressCeilingMs: null, fanout: null}}})
    const text = r.text.trim()
    return {
        ok: text.length > 0,
        note: `text=${text.length} modelError=${JSON.stringify(r.modelError ?? null)}`
    }
}

/** STEP 0: how many attempts does pi make on its own before giving up? Our own
 *  retry is switched off here — the question is what pi does unaided. */
async function probe(): Promise<void> {
    for (const K of [0, 1, 2, 3, 5, 8]) {
        const log = path.join(BASE, `probe-K${K}.jsonl`)
        const proxy = await startProxy({FLAKY_FAIL_FIRST: String(K), FLAKY_FAIL_MS: '0'}, log)
        const t0 = Date.now()
        let r
        try {
            r = await runWorker({
                prompt: PROMPT,
                profile: 'adhoc', contextWindow: 'unknown',
                override: {
                    'worker-timeout': {timeoutMs: 240_000, progressCeilingMs: null, fanout: null},
                    'connection-error': 0
                },
                cwd: CWD,
            })
        } finally {
            proxy.kill('SIGKILL')
            await sleep(200)
        }
        const reqs = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length
        console.log(
            `K=${K}  requests=${reqs}  text=${r.text.trim().length}  `
                + `modelError=${JSON.stringify(r.modelError ?? null)}  ms=${Date.now() - t0}`
        )
    }
}

/** Two-sided Fisher exact on the 2×2 success/failure table. */


const args = process.argv.slice(2)
if (args[0] === '--probe') {
    await probe()
    process.exit(0)
}

const REPS = Number(args[0] ?? 8)
const OUTAGES = (args[1] ?? '5000,20000,35000').split(',').map(Number)
console.log(`MAX_LOOP_RESTARTS=${MAX_LOOP_RESTARTS} reps=${REPS} outages=${OUTAGES.join(',')}ms`)

const table: Array<{T: number; b: number; t: number}> = []
for (const T of OUTAGES) {
    let b = 0
    let t = 0
    for (let i = 0; i < REPS; i++) {
        for (const arm of ['baseline', 'treatment'] as const) {
            const log = path.join(BASE, `ab-T${T}-${arm}${i}.jsonl`)
            const proxy = await startProxy({FLAKY_FAIL_FIRST: '0', FLAKY_FAIL_MS: String(T)}, log)
            const t0 = Date.now()
            let out: Outcome
            try {
                out = arm === 'baseline' ? await baseline() : await treatment()
            } finally {
                proxy.kill('SIGKILL')
                await sleep(200)
            }
            if (out.ok) {
                if (arm === 'baseline') b++
                else t++
            }
            const reqs = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length
            console.log(
                `T=${T} rep=${i} ${arm.padEnd(9)} ok=${out.ok} requests=${reqs} `
                    + `ms=${Date.now() - t0} ${out.note}`
            )
        }
    }
    table.push({T, b, t})
}

console.log('\n--- successes / reps ---')
for (const {T, b, t} of table) {
    const p = fisherTwoSided(t, REPS - t, b, REPS - b)
    console.log(
        `outage ${String(T).padStart(6)}ms:  baseline ${b}/${REPS}   treatment ${t}/${REPS}   `
            + `Fisher p=${p.toFixed(5)}`
    )
}
