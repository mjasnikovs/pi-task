/**
 * A/B: DEAD AIR in the validation gate — the window after the implementation turn
 * ends where the screen stops moving entirely.
 *
 * THE REPORT (user, 2026-08-06): "/task-auto finishes implementing, then nothing
 * happens — like the model stopped, the scrolling stops — and then the validation
 * gate pops up and it works."
 *
 * WHAT PRODUCTION DOES IN THAT WINDOW (measured by scripts/verify-deadair-step0.ts):
 *   agent_end            the impl widget is CLEARED (impl-widget.ts)
 *   ui.notify(verifying) queued behind pi-tui's process.nextTick render scheduler
 *   repoHealth()         runRepoHealthCheck — SYNCHRONOUS spawnSync: 15s on mx5,
 *                        69s on aiz-client, during which 0 of 686 expected 100ms
 *                        timer ticks fired. The event loop is dead, so the queued
 *                        notify cannot paint and no spinner can animate.
 *   ~10 probes           git-driven, emit nothing
 *   startAutoLoader()    ← the FIRST thing the user sees after the impl turn
 *
 * ARMS (same binary, selected by DEADAIR_AB_ARM — same seam shape as CANCEL_AB_ARM):
 *   baseline  — sync repo health, loader only once the verify child starts.
 *   treatment — async repo health (event loop stays alive) and ONE loader spanning
 *               the whole gate, naming the deterministic step it is on.
 *
 * GROUND TRUTH is mechanical: every ui.setWidget / ui.notify the gate makes is
 * timestamped, and an independent 100ms interval records when the event loop was
 * actually free. Per trial we report
 *
 *   maxUiGapMs    longest stretch with NOTHING drawn (window start counts as t0)
 *   maxTickGapMs  longest stretch where a 100ms timer could not fire — a frozen
 *                 TUI, independent of whether pi-task drew anything
 *   verdict       the gate's own outcome, which must be IDENTICAL across arms
 *
 * The verify child is a stub pi (PI_BIN) that answers instantly, so the only thing
 * varying between arms is the deterministic stage the user is staring at.
 *
 * Run:
 *   bun run scripts/verify-deadair-ab.ts [reps] [repo]
 * e.g.
 *   bun run scripts/verify-deadair-ab.ts 12 /home/edgars/hub/mx5
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {execFileSync} from 'node:child_process'
import {buildGateDeps} from '../src/task/gate-deps.js'
import {makeFakeCtx} from '../src/test-utils/fake-ctx.js'
import {reportAb} from './ab-verdict.js'
import type {ExtensionCommandContext} from '@earendil-works/pi-coding-agent'

const REPS = Number(process.argv[2] ?? 6)
const SOURCE_REPO = process.argv[3] ?? '/home/edgars/hub/mx5'

/** A gap longer than this is what the user experiences as "it's stuck". The loader
 *  refreshes every 500ms, so a live gate can never exceed ~1s. */
const SILENT_MS = 3000

const TICK_MS = 100

const SPEC = `## spec

GOAL
Keep the gate honest.

ACCEPTANCE
- the repo's own static checks pass

VERIFY:
\`\`\`bash
echo verified
\`\`\`
`

/** A pi stand-in that answers the verify child instantly with a PASS verdict, so the
 *  model turn (identical in both arms) does not dominate the measurement. */
const FAKE_PI = `#!/usr/bin/env node
const out = {
    type: 'agent_end',
    messages: [
        {
            role: 'assistant',
            content: [{type: 'text', text: 'Ran the spec VERIFY block.\\nWORK-VERIFIED: PASS'}]
        }
    ]
}
process.stdin.resume()
process.stdin.on('data', () => {})
process.stdout.write(JSON.stringify(out) + '\\n', () => process.exit(0))
`

interface Trial {
    arm: 'baseline' | 'treatment'
    windowMs: number
    maxUiGapMs: number
    maxTickGapMs: number
    uiEvents: number
    verdict: string
}

/** Clone the source repo into a scratch dir (fast --local clone, node_modules
 *  shared by symlink) so the real lint runs against a real tree without touching
 *  the user's checkout. */
function prepareWorkspace(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deadair-'))
    const repo = path.join(dir, 'repo')
    execFileSync('git', ['clone', '--quiet', '--local', '--no-hardlinks', SOURCE_REPO, repo], {
        stdio: 'ignore'
    })
    const nm = path.join(SOURCE_REPO, 'node_modules')
    if (fs.existsSync(nm)) fs.symlinkSync(nm, path.join(repo, 'node_modules'))
    fs.mkdirSync(path.join(repo, '.pi-tasks'), {recursive: true})
    fs.writeFileSync(
        path.join(repo, '.pi-tasks', 'TASK_0001.md'),
        `---\nid: TASK_0001\ntitle: dead-air probe\nstate: completed\nphase: done\ncreated_at: ${new Date().toISOString()}\nupdated_at: ${new Date().toISOString()}\n---\n\n${SPEC}\n`,
        'utf8'
    )
    const bin = path.join(dir, 'fake-pi.mjs')
    fs.writeFileSync(bin, FAKE_PI, {mode: 0o755})
    process.env.PI_BIN = bin
    return repo
}

/** One gate run under one arm, with every paint opportunity timestamped. */
async function trial(arm: 'baseline' | 'treatment', cwd: string): Promise<Trial> {
    process.env.DEADAIR_AB_ARM = arm === 'baseline' ? 'baseline' : ''
    const handle = makeFakeCtx(cwd)
    const ctx = handle.ctx as ExtensionCommandContext
    const paints: number[] = []
    const ticks: number[] = []
    const ui = ctx.ui as unknown as Record<string, unknown>
    const origWidget = ui.setWidget as (k: string, s: unknown) => void
    ui.setWidget = (k: string, s: unknown): void => {
        paints.push(Date.now())
        origWidget(k, s)
    }
    const origNotify = ui.notify as (m: string, l: string) => void
    ui.notify = (m: string, l: string): void => {
        paints.push(Date.now())
        origNotify(m, l)
    }
    const abort = new AbortController()
    const deps = buildGateDeps({
        signal: abort.signal,
        parentContextWindow: 100_000,
        runTask: () => Promise.resolve({taskId: 'TASK_0001', ok: true, sessionCancelled: false, ctx})
    })
    const timer = setInterval(() => ticks.push(Date.now()), TICK_MS)
    const t0 = Date.now()
    const outcome = await deps.verify!(ctx, cwd, 'dead-air probe', 'TASK_0001')
    const t1 = Date.now()
    clearInterval(timer)
    const gaps = (stamps: number[]): number => {
        let max = 0
        let prev = t0
        for (const s of stamps) {
            max = Math.max(max, s - prev)
            prev = s
        }
        return Math.max(max, t1 - prev)
    }
    return {
        arm,
        windowMs: t1 - t0,
        maxUiGapMs: gaps(paints),
        maxTickGapMs: gaps(ticks),
        uiEvents: paints.length,
        verdict: `${outcome.ok ? 'PASS' : 'FAIL'}${outcome.reason ? ` (${outcome.reason})` : ''}`
    }
}

async function main(): Promise<void> {
    // getConfig() reads the user's saved config; force the gate on in-process so the
    // harness measures the gate rather than a disabled no-op.
    const g = globalThis as unknown as {__piTaskConfig?: {config: Record<string, unknown>}}
    if (g.__piTaskConfig) g.__piTaskConfig.config.verifyWork = true
    const cwd = prepareWorkspace()
    const rows: Trial[] = []
    for (let i = 0; i < REPS; i++) {
        // Alternate which arm runs first: the health command's own wall time drifts
        // with machine load and warm caches, and a fixed order would fold that drift
        // into the arm comparison.
        const order =
            i % 2 === 0 ?
                (['baseline', 'treatment'] as const)
            :   (['treatment', 'baseline'] as const)
        for (const arm of order) {
            const t = await trial(arm, cwd)
            rows.push(t)
            console.log(
                `${String(i + 1).padStart(2)} ${arm.padEnd(9)} `
                    + `window ${String(t.windowMs).padStart(6)}ms  `
                    + `max UI gap ${String(t.maxUiGapMs).padStart(6)}ms  `
                    + `max tick gap ${String(t.maxTickGapMs).padStart(6)}ms  `
                    + `paints ${String(t.uiEvents).padStart(3)}  ${t.verdict}`
            )
        }
    }
    const of = (arm: string): Trial[] => rows.filter(r => r.arm === arm)
    const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
    const baseSilent = of('baseline').filter(r => r.maxUiGapMs >= SILENT_MS).length
    const treatSilent = of('treatment').filter(r => r.maxUiGapMs >= SILENT_MS).length
    const baseFrozen = of('baseline').filter(r => r.maxTickGapMs >= SILENT_MS).length
    const treatFrozen = of('treatment').filter(r => r.maxTickGapMs >= SILENT_MS).length
    const verdictsMatch = of('baseline').every((b, i) => b.verdict === of('treatment')[i]?.verdict)
    const baseWindow = mean(of('baseline').map(r => r.windowMs))
    const treatWindow = mean(of('treatment').map(r => r.windowMs))
    const slowdown = baseWindow > 0 ? (treatWindow - baseWindow) / baseWindow : 0
    console.log(
        `\nmean window: baseline ${Math.round(baseWindow)}ms · treatment ${Math.round(treatWindow)}ms `
            + `(${(slowdown * 100).toFixed(1)}%)`
    )
    console.log(
        `frozen event loop (≥${SILENT_MS}ms with no timer tick): baseline ${baseFrozen}/${REPS} · treatment ${treatFrozen}/${REPS}`
    )
    reportAb({
        name: 'verify dead air',
        reps: REPS,
        targetShape: `a gate run with >=${SILENT_MS}ms of NOTHING drawn after the implementation turn`,
        baselineHits: baseSilent,
        treatmentHits: treatSilent,
        invariants: [
            {
                label: 'the gate verdict is unchanged by the fix',
                ok: verdictsMatch,
                detail: `${of('baseline')[0]?.verdict ?? '—'} vs ${of('treatment')[0]?.verdict ?? '—'}`
            },
            {
                label: 'the gate is not slower (mean window within +15%)',
                ok: slowdown <= 0.15,
                detail: `${(slowdown * 100).toFixed(1)}%`
            },
            {
                label: 'the event loop is never frozen ≥3s under treatment',
                ok: treatFrozen === 0,
                detail: `baseline ${baseFrozen}/${REPS} frozen`
            }
        ]
    })
}

void main()
