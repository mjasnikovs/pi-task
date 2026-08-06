/**
 * STEP 0 — the DEAD-AIR window between "implementation finished" and the verify
 * gate's first visible output.
 *
 * The report: after /task-auto's implementation turn ends the screen stops moving
 * entirely — no spinner, no elapsed clock, no line — and then the verification gate
 * "pops up" and the run continues normally. This script measures the window WITHOUT
 * assuming a cause, over REAL repositories.
 *
 * What the production path does between the impl turn's `agent_end` and the verify
 * child's loader (task-gates.ts → verify-work.ts → gate-deps.ts):
 *
 *   agent_end            impl widget is CLEARED (impl-widget.ts) — screen goes static
 *   ui.notify(verifying) queued behind pi-tui's process.nextTick render scheduler
 *   repoHealth()         runRepoHealthCheck — spawnSync, i.e. the EVENT LOOP BLOCKS
 *   ~10 probes           git-driven, async, but emit nothing
 *   captureGitState()    git plumbing, emits nothing
 *   startAutoLoader()    ← FIRST pixel the user sees after the impl turn
 *
 * Measured per repo:
 *   health.ms      wall time of runRepoHealthCheck (the project's own lint/typecheck)
 *   health.ticks   100ms timer ticks that FIRED during it / expected — event-loop
 *                  starvation is what makes even an existing spinner freeze
 *   probes.ms      the deterministic probe chain that follows
 *   gitstate.ms    captureGitState
 *   window.ms      total silence: everything before the loader can render
 *
 * Run: bun run scripts/verify-deadair-step0.ts [repo...]
 */
import * as path from 'node:path'
import {runRepoHealthCheck, discoverHealthCommands} from '../src/task/repo-health-check.js'
import {captureGitState} from '../src/task/git-state-guard.js'
import {
    collectChangedFiles,
    collectAddedLines,
    collectTaskTreeChanges,
    collectTestAssemblyFindings,
    collectScriptEscapeFindings,
    collectRunnerGlobFindings
} from '../src/task/gate-deps.js'
import {findSubstitutionSuspects} from '../src/task/substitution-probe.js'
import {findProbeGaming} from '../src/task/probe-gaming.js'

const DEFAULT_REPOS = [
    '/home/edgars/hub/mx5',
    '/home/edgars/hub/aiz-client',
    '/home/edgars/.pi/agent/extensions/pi-task'
]

const TICK_MS = 100

/** Run `fn` while a 100ms interval counts how often the event loop got a turn. */
async function withLoopProbe<T>(fn: () => T | Promise<T>): Promise<{
    value: T
    ms: number
    ticks: number
    expected: number
}> {
    let ticks = 0
    const timer = setInterval(() => {
        ticks++
    }, TICK_MS)
    const t0 = Date.now()
    try {
        const value = await fn()
        const ms = Date.now() - t0
        return {value, ms, ticks, expected: Math.floor(ms / TICK_MS)}
    } finally {
        clearInterval(timer)
    }
}

interface RepoRow {
    repo: string
    ecosystem: string | null
    cmds: string[]
    healthMs: number
    healthTicks: number
    healthExpected: number
    probesMs: number
    gitStateMs: number
    windowMs: number
}

async function measure(cwd: string): Promise<RepoRow> {
    const disc = discoverHealthCommands(cwd)
    const health = await withLoopProbe(() => runRepoHealthCheck(cwd))
    const t1 = Date.now()
    // The probe chain, in production order. Read-only git/fs work; failures are
    // swallowed exactly as runWorkVerification swallows them.
    const swallow = async <T>(p: () => Promise<T>, empty: T): Promise<T> => {
        try {
            return await p()
        } catch {
            return empty
        }
    }
    await swallow(() => collectChangedFiles(cwd).then(findSubstitutionSuspects), [])
    await swallow(
        () => collectChangedFiles(cwd).then(c => collectTestAssemblyFindings(cwd, c)),
        []
    )
    await swallow(() => collectAddedLines(cwd).then(findProbeGaming), [])
    await swallow(() => collectTaskTreeChanges(cwd), {modified: [], deleted: [], added: []})
    await swallow(() => collectScriptEscapeFindings(cwd), [])
    await swallow(() => Promise.resolve(collectRunnerGlobFindings(cwd)), [])
    const probesMs = Date.now() - t1
    const t2 = Date.now()
    await captureGitState(cwd)
    const gitStateMs = Date.now() - t2
    return {
        repo: path.basename(cwd),
        ecosystem: disc.ecosystem,
        cmds: disc.cmds.map(([b, a]) => `${b} ${a.join(' ')}`),
        healthMs: health.ms,
        healthTicks: health.ticks,
        healthExpected: health.expected,
        probesMs,
        gitStateMs,
        windowMs: health.ms + probesMs + gitStateMs
    }
}

async function main(): Promise<void> {
    const repos = process.argv.slice(2)
    const targets = repos.length > 0 ? repos : DEFAULT_REPOS
    const rows: RepoRow[] = []
    for (const r of targets) {
        const row = await measure(r)
        rows.push(row)
        console.log(
            `${row.repo.padEnd(16)} health ${String(row.healthMs).padStart(7)}ms `
                + `[loop ticks ${row.healthTicks}/${row.healthExpected}]  `
                + `probes ${String(row.probesMs).padStart(5)}ms  `
                + `gitstate ${String(row.gitStateMs).padStart(5)}ms  `
                + `SILENT WINDOW ${String(row.windowMs).padStart(7)}ms  `
                + `(${row.cmds.join(' ; ') || 'no static command'})`
        )
    }
    console.log('\nJSON:', JSON.stringify(rows))
}

void main()
