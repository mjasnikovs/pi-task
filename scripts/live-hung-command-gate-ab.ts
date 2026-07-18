/**
 * LIVE probe: does a never-finishing bash command inside a GATE child get
 * killed, the way the command watchdog kills one in the MAIN session?
 *
 * The watchdog (src/task/command-watchdog.ts) registers on the host
 * ExtensionAPI. Every child pi is spawned with `--no-extensions`
 * (shared/child-process.ts CHILD_BASE_ARGS), so no watchdog exists inside a
 * gate child; and pi's own bash tool takes an OPTIONAL timeout with NO default
 * (node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js:17).
 *
 * This runs runWorker with the SAME options makeGateChild uses for the verify /
 * recommend / lint-fix / final-fix children (gate-deps.ts:338-364) — notably
 * `timeoutMs: 0` — against a fixture repo whose `verify.sh` never returns
 * (a realistic "wait for the dev server" check, the exact shape the watchdog
 * was built for). It reports whether the worker ever returned and whether the
 * hung command survived.
 *
 * Arms, one variable — the per-command ceiling:
 *   A (baseline)  commandTimeoutMs off  → hangs; ends only at the probe's own cap
 *   B (treatment) commandTimeoutMs on   → command killed, child restarted with
 *                                         commandTimeoutHint, verdict reached
 *
 * Both keep `timeoutMs: 0`, because that is not the variable under test: gate
 * children are unbounded BY DESIGN (they must run to completion) and stay so
 * after the fix.
 *
 * Measured 2026-07-18 against llama-server (Qwen3.6-27B), cap 180s:
 *   A — hung on `./verify.sh`, still running at 180s with timedOut=false
 *       stalled=false, ended ONLY by this script's outer cap (in production
 *       there is no such cap).
 *   B — command killed at 30s, child restarted with the hint, and the fresh
 *       child did NOT repeat it unbounded: it read the script and probed with
 *       curl, reaching a real verdict at 40s.
 *
 * Usage: PI_BIN=$(which pi) bun scripts/live-hung-command-gate-ab.ts [capSeconds]
 * Give the cap at least ~120s: below that it expires during arm B's restart and
 * truncates the treatment before it can reach a verdict (a cap artifact that
 * reads like a failure).
 * PI_BIN must point at a real pi — unset, getPiInvocation re-invokes THIS
 * script as the child and fork-bombs the box.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {runWorker} from '../src/workers/pi-worker-core.js'

const CAP_MS = Number(process.argv[2] ?? 240) * 1000
/**
 * A fixture repo whose VERIFY command never returns — a realistic "wait for the
 * dev server" check, the exact shape the watchdog exists for. Built here rather
 * than committed so the script runs anywhere with no setup.
 */
const FIXTURE = path.join(os.tmpdir(), 'pi-task-hung-command-ab')

function buildFixture(): void {
    fs.mkdirSync(FIXTURE, {recursive: true})
    fs.writeFileSync(
        path.join(FIXTURE, 'verify.sh'),
        '#!/usr/bin/env bash\n'
            + '# Integration check: waits for the dev server to become ready.\n'
            + 'echo "waiting for dev server on :5173 …"\n'
            + 'while true; do sleep 5; done\n',
        {mode: 0o755}
    )
    fs.writeFileSync(
        path.join(FIXTURE, 'package.json'),
        JSON.stringify({name: 'fixture', scripts: {check: './verify.sh'}}, null, 2) + '\n'
    )
}

const PROMPT =
    `You are verifying a task. The VERIFY block for this task is:\n\n`
    + `    ./verify.sh\n\n`
    + `Run that command with the bash tool from the repo root and report whether it `
    + `passed. Report WORK-VERIFIED:PASS or WORK-VERIFIED:FAIL based on what you observe.`

/**
 * Live PIDs of the fixture's hung script. Matches on the process's EXECUTABLE
 * (`pgrep -x bash` + argv check via ps) rather than a full-commandline pgrep:
 * an argv-wide match also hits any unrelated shell whose command line merely
 * MENTIONS verify.sh (an editor, a grep, a watcher), which produced false
 * "still alive: YES" readings on the first run of this probe.
 */
function hungProcs(): string {
    const r = Bun.spawnSync([
        'bash',
        '-lc',
        `ps -eo pid,args --no-headers | awk '$2 ~ /verify\\.sh$/ && $1 != ${process.pid}' || true`
    ])
    return r.stdout.toString().trim()
}

function elapsed(from: number): string {
    return `${Math.round((Date.now() - from) / 1000)}s`
}

async function arm(
    label: string,
    timeoutMs: number,
    capMs: number,
    commandTimeoutMs = 0
): Promise<void> {
    console.log(
        `\n=== ARM ${label} — timeoutMs: ${timeoutMs}, `
            + `commandTimeoutMs: ${commandTimeoutMs}, cap ${capMs / 1000}s ===`
    )
    const started = Date.now()
    const outer = new AbortController()
    let capped = false
    const cap = setTimeout(() => {
        capped = true
        outer.abort()
    }, capMs)
    let toolCalls = 0

    try {
        const r = await runWorker({
            prompt: PROMPT,
            cwd: FIXTURE,
            signal: outer.signal,
            tools: 'read,bash',
            timeoutMs,
            ...(commandTimeoutMs > 0 ? {commandTimeoutMs} : {}),
            // exactly as makeGateChild does
            loop: {pathThreshold: Number.POSITIVE_INFINITY},
            onLine: line => console.log(`  [${elapsed(started)}] ${line.slice(0, 160)}`),
            onToolResult: ({name, isError, text}) => {
                toolCalls++
                console.log(
                    `  [${elapsed(started)}] ↳ ${name} [${isError ? 'ERR' : 'ok'}]: `
                        + text.slice(0, 160).replace(/\n/g, ' ')
                )
            }
        })
        console.log(
            `  RETURNED after ${elapsed(started)} — exit=${r.exitCode} `
                + `timedOut=${r.timedOut ?? false} stalled=${r.stalled ?? false} `
                + `commandTimedOut=${r.commandTimedOut ? JSON.stringify(r.commandTimedOut) : 'false'}`
        )
        console.log(`  text: ${JSON.stringify(r.text.slice(0, 160))}`)
    } catch (e) {
        console.log(`  THREW after ${elapsed(started)}: ${String(e).slice(0, 200)}`)
    } finally {
        clearTimeout(cap)
    }

    const alive = hungProcs()
    console.log(`  tool results seen: ${toolCalls}`)
    console.log(`  killed only by the probe's outer cap: ${capped}`)
    console.log(`  hung verify.sh still alive: ${alive ? 'YES\n    ' + alive.replace(/\n/g, '\n    ') : 'no'}`)
    Bun.spawnSync(['bash', '-lc', `pkill -f 'verify\\.sh' || true`])
    await Bun.sleep(500)
}

buildFixture()
console.log(`PI_BIN=${process.env.PI_BIN ?? '(unset)'}  fixture=${FIXTURE}`)
// A — the pre-fix gate child: unbounded worker, no per-command ceiling.
await arm('A: baseline (pre-fix gate child)', 0, CAP_MS)
// B — the fix: worker still unbounded (gates must run to completion), but each
// single command is now bounded by the command watchdog.
await arm('B: treatment (command watchdog on)', 0, CAP_MS, 30_000)
