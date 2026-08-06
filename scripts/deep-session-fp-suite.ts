/**
 * deep-session-fp-suite — zero-FP sweep for the request-log rules (nexttask 12).
 *
 *   bun run scripts/deep-session-fp-suite.ts   exit 0 clean · 1 the lever spoke
 *
 * The two rules live inside judgeDeepSession, which is reachable only through the
 * authenticated deep-render probe, which the gate calls only behind
 * detectsServedApp() and only after the shallow render check PASSES. So the FP
 * question for a box full of CLI tools, engines, containers and C++ trees is
 * exactly the I1 question: does the gate ever REACH the probe on a project that
 * serves nothing? Every project here is run through the REAL
 * runFinalIntegrationGate with the same --trace-deep recorder scripts/
 * deep-render-replay.ts uses — a probe that drives nothing and counts its calls.
 *
 * Each project is COPIED first (cp -a --reflink=auto, as the boot-skip harness
 * does). The gate runs `lint --fix`, builds and migrations; it must never do that
 * to the user's checkouts.
 *
 * WHAT GATES THE EXIT, and why it is not "0 gate failures". A gate FAIL on someone
 * else's repo is that repo's state — a lint error, a red test, a missing container
 * — and it is identical with or without this lever, because the recorder means
 * judgeDeepSession is never called at all. Those are printed as context. What
 * gates the exit is what this lever can actually cause:
 *
 *   probe invocations                          must be 0
 *   failure text carrying a rule's signature   must be 0
 *
 * A non-zero probe count is not automatically a bug — a served web app SHOULD
 * reach the probe — but it means this sweep no longer proves the lever silent, and
 * that tree has to be judged by hand. Hence exit 1 either way.
 */
import {spawnSync} from 'node:child_process'
import {existsSync, mkdirSync, mkdtempSync, rmSync} from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {runFinalIntegrationGate} from '../src/task/final-gate'

const HUB = path.join(os.homedir(), 'hub')
const REPO = path.resolve(import.meta.dir, '..')
const PROJECTS = [
    ...[
        'gofer',
        'gofer-pixel',
        'IAR1',
        'aiz-client',
        'aiz-docker',
        'mario',
        'memtest_vulkan',
        'openclaw',
        'open-design',
        'qwen',
        'runner',
        'dace-pro'
    ].map(n => path.join(HUB, n)),
    REPO
]
/** Phrases only the two new rules emit. */
const RULE_SIGNATURES = [
    'a path the server does not route',
    'got the SPA shell',
    'No type or mock can produce a route that is not mounted',
    'No status check can see this'
]
/** Per-command ceiling. Identical for every tree; it can change a tree's verdict
 *  but never whether the probe was reached, which is what this sweep measures. */
const COMMAND_TIMEOUT_MS = 180_000

const workRoot = mkdtempSync(path.join(os.homedir(), '.cache', 'pi-task-deep-fp-'))
mkdirSync(workRoot, {recursive: true})

interface Row {
    label: string
    ok: boolean
    probeCalls: number
    signature: string | null
    reason: string
}

const rows: Row[] = []
for (const source of PROJECTS) {
    const label = path.basename(source)
    if (!existsSync(source)) {
        console.log(`  ${label.padEnd(18)} — absent, skipped`)
        continue
    }
    const dest = path.join(workRoot, label)
    const cp = spawnSync('cp', ['-a', '--reflink=auto', source, dest], {encoding: 'utf8'})
    if (cp.status !== 0) {
        console.log(`  ${label.padEnd(18)} — could not copy, skipped (${cp.stderr.trim()})`)
        continue
    }
    let probeCalls = 0
    const started = Date.now()
    const out = await runFinalIntegrationGate(dest, COMMAND_TIMEOUT_MS, 15_000, {
        deepRenderProbe: () => {
            probeCalls += 1
            return Promise.resolve({
                outcome: 'skip' as const,
                note: 'deep probe replaced by the FP-sweep recorder'
            })
        }
    })
    const signature = RULE_SIGNATURES.find(s => out.reason.includes(s)) ?? null
    rows.push({label, ok: out.ok, probeCalls, signature, reason: out.reason})
    console.log(
        `  ${label.padEnd(18)} gate ${out.ok ? 'PASS' : 'FAIL'} · probe reached ${String(probeCalls)}× · `
        + `rule signature ${signature === null ? 'none' : `"${signature}"`} · `
        + `${((Date.now() - started) / 1000).toFixed(0)}s`
    )
    rmSync(dest, {recursive: true, force: true})
}
rmSync(workRoot, {recursive: true, force: true})

const reached = rows.filter(r => r.probeCalls > 0)
const spoke = rows.filter(r => r.signature !== null)
const failed = rows.filter(r => !r.ok)

console.log(`\n=== ${String(rows.length)} projects swept`)
console.log(`  probe reached:          ${String(reached.length)} — must be 0`)
console.log(`  rule signature in text: ${String(spoke.length)} — must be 0`)
console.log(`  gate FAIL (context only, identical with and without the lever): ${String(failed.length)}`)
for (const r of failed) console.log(`    ${r.label}: ${r.reason.split('\n')[0].slice(0, 140)}`)
if (reached.length > 0 || spoke.length > 0) {
    console.log('\nFAIL — the lever is reachable on a project this sweep cannot clear.')
    for (const r of [...reached, ...spoke]) console.log(`  ${r.label}: ${r.reason.slice(0, 300)}`)
    process.exit(1)
}
console.log('\nPASS — the probe was never reached and no rule spoke.')
process.exit(0)
