/**
 * LIVE smoke: does the stream watchdog stay OUT of the way of a real, slow local
 * model — and does it still fire when the stream is genuinely silent?
 *
 * The watchdog (src/shared/stream-watchdog.ts) aborts a model request whose
 * stream produces no events for `streamInactivityMs`. Its whole risk profile is
 * the FALSE POSITIVE: on a local llama-server a large-context prompt can spend
 * minutes in prompt processing emitting nothing, and a ceiling sized for a cloud
 * API would kill every one of those. A hang itself cannot be summoned on demand —
 * that half is pinned by src/task/stream-stall.test.ts, which drives a fake `pi`
 * that streams N events and then goes mute forever (the exact run-14 shape).
 * This script covers the half that needs REAL hardware.
 *
 * ─── THE MEASUREMENT (2026-07-20) ────────────────────────────────────────────
 * The question this script used to leave open: does llama-server emit ANYTHING
 * during prompt processing, or is it silent until the first token? Measured by
 * timing inter-chunk gaps on its own SSE stream, cold cache (nonce-prefixed so no
 * prompt-cache reuse), 127.0.0.1:8080:
 *
 *     40 KB prompt →  5.5s silent, then tokens ~65ms apart
 *     80 KB prompt → 11.9s silent
 *    160 KB prompt → 26.3s silent
 *
 * It is TRULY SILENT. HTTP response headers come back in ~150ms, then nothing at
 * all — not a keepalive, not an empty delta — until the first content token. So
 * the entire prompt-processing pass is a single inactivity gap as far as the
 * watchdog is concerned, and the generous DEFAULT_STREAM_INACTIVITY_MS is
 * protecting against a real cliff, not a hypothetical one.
 *
 * Prompt-processing throughput on this backend is ~6.0–7.1 KB/s, degrading with
 * size (6.0 KB/s at 160 KB vs 7.1 KB/s at 40 KB — attention is superlinear). At
 * the production 10-minute ceiling that extrapolates to a MAXIMUM TOLERABLE
 * PROMPT of roughly 3.5 MB; halve it for the observed degradation and it is still
 * ~1.7 MB, two orders of magnitude above anything pi-task assembles. The default
 * has ample headroom on this hardware. On a backend an order of magnitude slower
 * — or one that swaps — the margin is what shrinks first, so this number is worth
 * re-measuring (arm M below prints it) before trusting the default elsewhere.
 *
 * ─── THE ARMS ────────────────────────────────────────────────────────────────
 * M  measures the backend's silent gap G for the ~150KB prompt (above).
 * A  trivial prompt, PRODUCTION ceiling — must not be killed.
 * B  ~150KB prompt, PRODUCTION ceiling — must not be killed.
 * C  the A/B proper, same ~150KB prompt, the CEILING as the only variable:
 *      baseline   ceiling 0.4·G (below the silent gap) — must BE killed
 *      treatment  ceiling 1.5·G (above it)             — must NOT be killed
 *
 * Arm C is what arms A and B could not do. They ran at 10 minutes against a gap
 * of ~26s — two orders of magnitude of slack — so they proved "no spurious kill on
 * a real prompt" and nothing about behaviour NEAR the ceiling. Rather than hunt
 * for a model slow enough to approach 10 minutes (not reproducible, and there may
 * not be one), arm C inverts the variable: hold the prompt fixed and shrink the
 * ceiling until it is within 1.5× of the real silent gap. That is a far TIGHTER
 * margin than production's ~23×, so surviving it is strictly stronger evidence.
 *
 * The baseline half is not ceremony: it is what makes the treatment half mean
 * something. Without a ceiling that demonstrably DOES kill this exact request,
 * "treatment was not killed" is indistinguishable from a watchdog that never arms.
 *
 * Every rep prefixes a fresh nonce so llama-server's prompt cache cannot serve a
 * warm prefix and shrink G out from under the derived ceilings.
 *
 * Measured 2026-07-20, reps=2, pi 0.80.10: G = 25781ms; A 2.2s and B 29.6s both
 * unkilled at the 10-minute ceiling; baseline ceiling 10312ms killed 2/2 (exit
 * 143, reported idleMs ~12.1s — the ~1.8s overshoot is the watchdog's own poll
 * period, pollIntervalMs = ceiling/4), treatment ceiling 38672ms killed 0/2.
 * VERDICT PASS.
 *
 * Usage: PI_BIN=$(which pi) bun scripts/live-stream-watchdog-smoke.ts [reps]
 * PI_BIN must point at a real pi — unset, getPiInvocation re-invokes THIS script
 * as the child and fork-bombs the box (see pi child spawn fork-bomb).
 * MODEL_URL overrides the endpoint arm M probes (default http://127.0.0.1:8080).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import {fileURLToPath} from 'node:url'
import {runWorker} from '../src/workers/pi-worker-core.js'
import {DEFAULT_STREAM_INACTIVITY_MS} from '../src/shared/stream-watchdog.js'
import {reportAb} from './ab-verdict.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const modelUrl = process.env.MODEL_URL ?? 'http://127.0.0.1:8080'
const reps = Math.max(1, Number(process.argv[2] ?? 2) || 2)

if (!process.env.PI_BIN) {
    console.error('PI_BIN must point at a real pi binary (e.g. PI_BIN=$(which pi)).')
    process.exit(1)
}

/** Unique per rep, at the FRONT of the prompt, so no cached prefix survives. */
function nonce(): string {
    return `[run ${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}] `
}

const bigBody = ['src/task/orchestrator.ts', 'src/task/auto-orchestrator.ts']
    .map(f => fs.readFileSync(path.join(repoRoot, f), 'utf8'))
    .join('\n\n')

/** A prompt big enough to make the backend think for tens of seconds first. */
function bigPrompt(): string {
    return (
        nonce()
        + 'Below are two source files. Read them, then answer in ONE sentence: what does '
        + 'steerUntilDone do? Do not use any tools.\n\n'
        + bigBody
    )
}

/**
 * ARM M — the direct measurement. Streams from the backend itself (not through pi)
 * and times the gaps between raw SSE chunks, because the watchdog's clock is reset
 * by ANY stream event: whatever the largest gap is here is the largest inactivity
 * window a healthy request of this size can present. Returns null when the backend
 * is unreachable, which makes the whole run ABSTAIN rather than silently pass.
 */
async function measureSilentGap(prompt: string): Promise<number | null> {
    const t0 = Date.now()
    let res: Response
    try {
        res = await fetch(`${modelUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({
                model: 'local',
                stream: true,
                max_tokens: 8,
                messages: [{role: 'user', content: prompt}]
            })
        })
    } catch (e) {
        console.log(`M measure  UNREACHABLE ${modelUrl} — ${String(e)}`)
        return null
    }
    if (!res.ok || !res.body) {
        console.log(`M measure  bad response ${res.status} from ${modelUrl}`)
        return null
    }
    const headersMs = Date.now() - t0
    let last = Date.now()
    let max = 0
    let chunks = 0
    for await (const _chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        const now = Date.now()
        max = Math.max(max, now - last)
        last = now
        chunks++
    }
    console.log(
        `M measure  promptBytes=${prompt.length}  headers=${headersMs}ms  chunks=${chunks}  `
            + `maxSilentGap=${max}ms  rate=${(prompt.length / max / 1.024).toFixed(1)}KB/s  `
            + `total=${Date.now() - t0}ms`
    )
    return max
}

/** Runs one request through the production path and says whether the watchdog killed it. */
async function arm(label: string, prompt: string, ceilingMs: number): Promise<boolean> {
    const t0 = Date.now()
    const r = await runWorker({
        prompt,
        profile: 'adhoc',
        override: {
            'worker-timeout': {timeoutMs: 0, progressCeilingMs: null, fanout: null},
            'stream-stall': ceilingMs
        },
        cwd: repoRoot,
        tools: 'read,grep,find,ls',
    })
    const killed = r.streamStalled !== undefined
    console.log(
        `${label}  promptBytes=${prompt.length}  ceiling=${ceilingMs}ms  `
            + `elapsed=${Date.now() - t0}ms  wait=${r.waitMs}ms  exit=${r.exitCode}  `
            + `streamStalled=${killed ? JSON.stringify(r.streamStalled) : 'null'}`
    )
    if (!killed) console.log(`   answer: ${r.text.slice(0, 140).replace(/\s+/g, ' ')}`)
    return killed
}

const gap = await measureSilentGap(bigPrompt())

// A/B ceilings derived from the MEASURED gap, so the experiment tracks the
// hardware instead of a number that was true once. Floored so a suspiciously fast
// backend cannot derive a baseline ceiling below the watchdog's own poll period.
const baselineCeiling = Math.max(3_000, Math.round((gap ?? 0) * 0.4))
const treatmentCeiling = Math.max(10_000, Math.round((gap ?? 0) * 1.5))

const killedAtProductionCeiling: string[] = []
if (gap !== null) {
    if (await arm('A trivial ', nonce() + 'In one sentence, what is 2 + 2? Do not use any tools.', DEFAULT_STREAM_INACTIVITY_MS)) {
        killedAtProductionCeiling.push('A trivial')
    }
    if (await arm('B 150KB  ', bigPrompt(), DEFAULT_STREAM_INACTIVITY_MS)) {
        killedAtProductionCeiling.push('B 150KB')
    }
}

let baselineKills = 0
let treatmentKills = 0
for (let i = 0; gap !== null && i < reps; i++) {
    if (await arm(`C base ${i + 1}  `, bigPrompt(), baselineCeiling)) baselineKills++
    if (await arm(`C treat ${i + 1} `, bigPrompt(), treatmentCeiling)) treatmentKills++
}

reportAb({
    name: 'stream watchdog near the ceiling (live llama-server)',
    reps,
    targetShape:
        `a ~150KB-prompt request aborted by the stream watchdog, where the backend's `
        + `measured silent prompt-processing gap (${gap ?? 'UNMEASURED'}ms) exceeds the ceiling`,
    baselineHits: baselineKills,
    treatmentHits: treatmentKills,
    invariants: [
        {
            label: 'backend reachable and its silent gap measured',
            ok: gap !== null,
            detail: gap === null ? `no stream from ${modelUrl}` : `${gap}ms`
        },
        {
            label: 'no kill at the PRODUCTION ceiling (arms A and B)',
            ok: killedAtProductionCeiling.length === 0,
            detail:
                killedAtProductionCeiling.length === 0 ?
                    `${DEFAULT_STREAM_INACTIVITY_MS}ms`
                :   `killed: ${killedAtProductionCeiling.join(', ')}`
        },
        {
            label: 'treatment ceiling is within 1.5x of the real silent gap',
            ok: gap !== null && treatmentCeiling <= gap * 2,
            detail: `gap=${gap ?? 'n/a'}ms treatment=${treatmentCeiling}ms baseline=${baselineCeiling}ms`
        }
    ]
})
