/**
 * WHY THE RUNAWAY DETECTORS DID NOT KILL THE THREE LONG, EMPTY `adhoc` TRIALS.
 *
 * STEP 1 of the adhoc clock question recorded three trials that ran 282-435s and
 * returned 0, 136 and 176 characters (T029, T024, T026 in
 * `~/.cache/pi-task-adhoc-clock-ab/ledger.jsonl`). A worker that produces nothing
 * for minutes is the exact shape `StallDetector` exists to end, so either it
 * fired and the restart ladder spent the time anyway, or it could not fire.
 * The ledger cannot tell the two apart: it records a restart COUNT and no reason.
 *
 * This replays those prompts with every event the two detectors read written down
 * — each tool call, each result's size / isError / duplicate status, the
 * no-new-ground streak after it, cumulative tool-result bytes — plus the restart
 * reasons `runWorker` reports. It passes the SERVED context window, so the churn
 * rule is armed — without one it cannot fire at all, which is the state every
 * `runWorker` caller but `gate-child.ts` was in.
 *
 * Run:
 *   PI_BIN=$(command -v pi) bun run scripts/adhoc-stall-trace.ts T029 [T024 ...]
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import {requirePreconditions, llamaModelIdentity} from './ab-preflight.js'
import {runWorker} from '../src/workers/pi-worker-core.js'
import {groupThinkingArgs} from '../src/config/reasoning-args.js'
import {CONTEXT_CHURN_FACTOR, NO_PROGRESS_LIMIT} from '../src/task/stall-detector.js'
import {DEFAULT_STREAM_INACTIVITY_MS} from '../src/shared/stream-watchdog.js'

const CORPUS_ROOT = '/home/edgars/.cache/pi-task-adhoc-clock-ab'
const PROPS_URL = 'http://127.0.0.1:8080/props'
const FIXTURE = path.join(import.meta.dir, 'fixtures', 'adhoc-clock-corpus.json')
const OUT = path.join(CORPUS_ROOT, 'stall-trace')

/**
 * The window the served model actually runs, READ FROM THE SERVER.
 *
 * Not a constant. The churn rule is a factor of the window, so a hand-typed
 * window makes the shadow measure a number this harness invented rather than the
 * one the child is running under — the same mistake `magicknumbers.md` exists to
 * stop. `/props` publishes it at `default_generation_settings.n_ctx`, which is
 * also where `llamaModelIdentity` reads it for the run fingerprint.
 */
async function servedContextWindow(url: string): Promise<number> {
    const body = await (await fetch(url)).text()
    const n = JSON.parse(llamaModelIdentity(body)) as {n_ctx: number | null}
    if (typeof n.n_ctx !== 'number' || n.n_ctx <= 0) {
        throw new Error(`/props published no usable n_ctx: ${n.n_ctx}`)
    }
    return n.n_ctx
}

/**
 * Safety only, and bounded by SILENCE rather than by elapsed time — the same
 * shape production uses. A wall clock here would kill a healthy run on a slower
 * model, which is the hardware test this harness exists to measure, not to
 * repeat. Set to the user's own `stuck reply retry` default.
 */
const SAFETY_SILENCE_MS = DEFAULT_STREAM_INACTIVITY_MS

interface Row {
    id: string
    repoKey: string
    cwd: string
    prompt: string
}

async function traceOne(row: Row, servedWindow: number): Promise<void> {
    const log: string[] = []
    const t0 = Date.now()
    const at = (): string => `${((Date.now() - t0) / 1000).toFixed(1)}s`
    const say = (s: string): void => {
        log.push(s)
        console.log(s)
    }

    // The two rules the trace is about are EARNED in `StallDetector.noteResult`
    // and only READ on the next tool call, so the counters below mirror
    // `noteResult` exactly: an error or a byte-identical result is dead ground,
    // anything else resets the streak. `RunWorkerInput` has no tool-CALL hook, so
    // this is the whole of what an observer can see — and it is the half that
    // decides both verdicts.
    let resultBytes = 0
    let peakStreak = 0
    let peakBytes = 0
    let attempt = 1
    const seen = new Set<string>()
    let streak = 0

    const ac = new AbortController()

    say(`### ${row.id} (${row.repoKey}) — prompt ${row.prompt.length} chars`)
    const r = await runWorker({
        prompt: row.prompt,
        cwd: row.cwd,
        signal: ac.signal,
        profile: 'adhoc',
        // The SERVED window, so the real StallDetector's churn rule is armed.
        // Before the `contextWindow` fix no `runWorker` caller passed one and the
        // rule could not fire at all.
        contextWindow: servedWindow,
        policyInputs: {streamInactivityMs: SAFETY_SILENCE_MS},
        thinking: groupThinkingArgs('research'),
        onRestart: rs => {
            say(
                `[${at()}] RESTART attempt ${rs.attempt} discarded reason=${rs.reason}`
                    + ` wall=${rs.wallMs}ms wait=${rs.waitMs}ms work=${rs.workMs}ms`
                    + ` DISCARDED=${rs.partialChars}ch`
                    + (rs.detail ? ` — ${rs.detail}` : '')
            )
            attempt = rs.attempt + 1
            resultBytes = 0
            streak = 0
            seen.clear()
        },
        onToolResult: res => {
            resultBytes += res.text.length
            const dup = seen.has(res.text)
            if (res.isError || dup) streak++
            else {
                seen.add(res.text)
                streak = 0
            }
            peakStreak = Math.max(peakStreak, streak)
            peakBytes = Math.max(peakBytes, resultBytes)
            say(
                `[${at()}] a${attempt}    RESULT ${res.name} ${res.isError ? 'ERR' : 'ok'}`
                    + ` bytes=${res.text.length} dup=${dup} deadStreak=${streak}`
                    + ` cumBytes=${resultBytes} (~${Math.round(resultBytes / 4)} tok`
                    + ` = ${(resultBytes / 4 / servedWindow).toFixed(2)}x window)`
                    + ` head=${JSON.stringify(res.text.slice(0, 160))}`
            )
        },
        onLine: line => say(`[${at()}] a${attempt}    LINE ${line.slice(0, 300)}`)
    })
    say(
        `### ${row.id} DONE ${((Date.now() - t0) / 1000).toFixed(1)}s exit=${r.exitCode}`
            + ` aborted=${r.aborted} timedOut=${r.timedOut} chars=${r.text.trim().length}`
            + ` resultBytes(final attempt)=${resultBytes}`
            + ` peakDeadStreak=${peakStreak}/${NO_PROGRESS_LIMIT}`
            + ` peakChurn=${(peakBytes / 4 / servedWindow).toFixed(2)}x/${CONTEXT_CHURN_FACTOR}x`
    )
    fs.mkdirSync(OUT, {recursive: true})
    fs.writeFileSync(path.join(OUT, `${row.id}.trace.txt`), log.join('\n') + '\n')
    fs.writeFileSync(path.join(OUT, `${row.id}.answer.txt`), r.text)
}

async function main(): Promise<void> {
    await requirePreconditions('adhoc-stall-trace', {
        model: {url: PROPS_URL, identity: llamaModelIdentity},
        piBin: true,
        cacheOff: true,
        corpora: [path.join(CORPUS_ROOT, 'corpus')]
    })
    const servedWindow = await servedContextWindow(PROPS_URL)
    console.log(`served context window: ${servedWindow} tokens (from ${PROPS_URL})`)
    const ids = process.argv.slice(2).filter(a => !a.startsWith('-'))
    const rows = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Row[] | {rows: Row[]}
    const all = Array.isArray(rows) ? rows : rows.rows
    for (const id of ids) {
        const row = all.find(x => x.id === id)
        if (!row) throw new Error(`no such trial: ${id}`)
        await traceOne(row, servedWindow)
    }
}

void main()
