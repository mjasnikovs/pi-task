/**
 * LIVE smoke: does the stream watchdog stay OUT of the way of a real, slow local
 * model?
 *
 * The watchdog (src/shared/stream-watchdog.ts) aborts a model request whose
 * stream produces no events for `streamInactivityMs`. Its whole risk profile is
 * the FALSE POSITIVE: on a local llama-server a large-context prompt can spend
 * minutes in prompt processing emitting nothing, and a ceiling sized for a cloud
 * API would kill every one of those. A hang itself cannot be summoned on demand —
 * that half is pinned by src/task/stream-stall.test.ts, which drives a fake `pi`
 * that streams N events and then goes mute forever (the exact run-14 shape).
 * This script covers the half that needs REAL hardware: zero spurious kills.
 *
 * Two arms, one variable — the prompt's size:
 *   A  a trivial prompt (fast first token)
 *   B  a ~150KB prompt (the slow prompt-processing pass the ceiling must tolerate)
 * Both run with the PRODUCTION default ceiling (10 min). A kill in either arm is
 * a failure of this smoke.
 *
 * Measured 2026-07-20 against llama-server at 127.0.0.1:8080 (pi 0.80.10):
 *   A — 3.3s total, wait 0.6s, streamStalled null
 *   B — 27.4s total (~150KB prompt), wait 0.6s, streamStalled null
 * Honest limit: this backend answered fast enough that neither arm approached the
 * ceiling, so the smoke proves "no spurious kill on a real slow prompt", NOT the
 * behaviour at a multi-minute first-token latency. A slower/bigger model is the
 * way to push arm B further.
 *
 * Usage: PI_BIN=$(which pi) bun scripts/live-stream-watchdog-smoke.ts
 * PI_BIN must point at a real pi — unset, getPiInvocation re-invokes THIS script
 * as the child and fork-bombs the box (see pi child spawn fork-bomb).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import {fileURLToPath} from 'node:url'
import {runWorker} from '../src/workers/pi-worker-core.js'
import {DEFAULT_STREAM_INACTIVITY_MS} from '../src/shared/stream-watchdog.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

if (!process.env.PI_BIN) {
    console.error('PI_BIN must point at a real pi binary (e.g. PI_BIN=$(which pi)).')
    process.exit(1)
}

/** A prompt big enough to make the backend think before its first token. */
function bigPrompt(): string {
    const files = ['src/task/orchestrator.ts', 'src/task/auto-orchestrator.ts']
    const body = files.map(f => fs.readFileSync(path.join(repoRoot, f), 'utf8')).join('\n\n')
    return (
        'Below are two source files. Read them, then answer in ONE sentence: what does '
        + 'steerUntilDone do? Do not use any tools.\n\n'
        + body
    )
}

async function arm(label: string, prompt: string): Promise<boolean> {
    const t0 = Date.now()
    const r = await runWorker({
        prompt,
        cwd: repoRoot,
        tools: 'read,grep,find,ls',
        timeoutMs: 0,
        streamInactivityMs: DEFAULT_STREAM_INACTIVITY_MS
    })
    const killed = r.streamStalled !== undefined
    console.log(
        `${label}  promptBytes=${prompt.length}  elapsed=${Date.now() - t0}ms  `
            + `wait=${r.waitMs}ms  work=${r.workMs}ms  exit=${r.exitCode}  `
            + `streamStalled=${killed ? JSON.stringify(r.streamStalled) : 'null'}`
    )
    console.log(`   answer: ${r.text.slice(0, 160).replace(/\s+/g, ' ')}`)
    return !killed
}

const okA = await arm('A trivial ', 'In one sentence, what is 2 + 2? Do not use any tools.')
const okB = await arm('B 150KB  ', bigPrompt())

console.log(
    okA && okB ?
        'SMOKE PASS — no spurious stream-watchdog kill in either arm.'
    :   'SMOKE FAIL — the watchdog killed a healthy request.'
)
process.exit(okA && okB ? 0 : 1)
