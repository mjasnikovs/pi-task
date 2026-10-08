/**
 * A/B for arming the read guard on the FILES research worker.
 *
 * The defect, from mx5-n 0.42.47: the FILES worker re-ran one identical read or
 * grep until the loop detector killed it, 25 times, and every kill threw the
 * attempt away (94.9 min). The guard that answers a repeat with "you already have
 * this" instead of a kill was armed on TOOLING only.
 *
 * Each trial runs the real `phaseResearch` on a clone of mx5-n at the checkpoint
 * the recorded task started from, with that task's recorded refined and raw
 * prompts. Only the FILES worker reaches the model; the other three answer at
 * once through the `runWorker` seam. Arm A loads phases.ts and the worker core
 * from BASE_REF, as shipped; arm B from this tree, where the guard is armed on
 * FILES and the loop detector no longer counts a new search pattern as a revisit.
 * Order is ABBA by trial index within each task.
 *
 * The pilot (ledger files-guard-2026-10-08.jsonl, guard injected, old detector)
 * killed A 3/4 and B 1/4; B's one kill was the detector counting the new grep
 * patterns the block text asks for.
 *
 * Scored per trial: killed = any restart or a degraded section; wall time; and an
 * answer produced (non-empty, not degraded).
 *
 * Verdict: ABSTAIN (exit 2) when arm A was never killed. PASS (exit 0) when B's
 * killed trials drop with one-sided Fisher p < 0.05 and B produces an answer at
 * least as often as A. FAIL (exit 1) otherwise.
 *
 * The ledger is appended after every trial and read back on start, so a stopped
 * run resumes where it ended.
 *
 * RESULT 2026-10-08, 12 trials per arm: A killed 4, B killed 1 (p = 0.16); both
 * answered 11; B took 38.2 min to A's 24.8, one TASK_0002 trial alone 23.5 min.
 * FAIL, and the change was not kept, so arm B no longer exists in this tree. On
 * TASK_0002 the worker searched Playwright's internals for 20 minutes: blocking
 * repeats there only moved the end from a kill to the time ceiling.
 *
 * Usage:
 *   PI_BIN=$(command -v pi) bun run scripts/ab-files-guard.ts <scratch-dir> <mx5-n-repo> [trials-per-task=2]
 */
import {spawnSync} from 'node:child_process'
import {appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync} from 'node:fs'
import * as path from 'node:path'
import type {phaseResearch as PhaseResearch} from '../src/task/phases.js'
import {readSection, writeTaskFile} from '../src/task/task-io.js'
import type {runWorker as RunWorker, RunWorkerInput, RunWorkerResult} from '../src/workers/pi-worker-core.js'

interface ArmCode {
    phaseResearch: typeof PhaseResearch
    runWorker: typeof RunWorker
}

async function armCode(root: string): Promise<ArmCode> {
    const phases = (await import(path.join(root, 'src/task/phases.ts'))) as {phaseResearch: typeof PhaseResearch}
    const core = (await import(path.join(root, 'src/workers/pi-worker-core.ts'))) as {runWorker: typeof RunWorker}
    return {phaseResearch: phases.phaseResearch, runWorker: core.runWorker}
}

const LEDGER =
    process.env.AB_LEDGER ?? path.resolve(import.meta.dir, 'ledgers', 'files-guard-2026-10-08b.jsonl')
/** Arm A's code: the commit before this change. Pinned, so a moving HEAD cannot shift it. */
const BASE_REF = '19db9251b0ed72ea0f5a1c3b4f14a51ce02dbd43'
const REPO = path.resolve(import.meta.dir, '..')
/** pi loads an extension file, and from src/ the shipped path names a .js that only
 *  the build emits. Run `npm run build` first so this is the code under test. */
const GUARD = path.resolve(import.meta.dir, '..', 'dist', 'workers', 'single-read-extension.js')
/** The four tasks whose FILES worker was loop-killed most in the recorded run. */
const TASKS = ['TASK_0002', 'TASK_0019', 'TASK_0029', 'TASK_0050'] as const
type Arm = 'A' | 'B'

interface Trial {
    task: string
    i: number
    arm: Arm
    killed: boolean
    restarts: string[]
    wallMs: number
    answered: boolean
}

function git(cwd: string, ...args: string[]): string {
    const r = spawnSync('git', args, {cwd, encoding: 'utf8'})
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
    return r.stdout.trim()
}

/** The checkpoint commit a task started from: the one whose subject names its raw prompt. */
function checkpointOf(repo: string, rawPrompt: string): string {
    const head = rawPrompt.trim().slice(0, 50)
    const lines = git(repo, 'log', '--format=%H %s').split('\n')
    const hit = lines.find(l => l.includes('chore: checkpoint before "') && l.includes(head))
    if (!hit) throw new Error(`no checkpoint commit for "${head}"`)
    return hit.split(' ')[0]
}

const CANNED: RunWorkerResult = {
    text: '- (not run in this A/B)',
    exitCode: 0,
    stderr: '',
    aborted: false,
    sawOutput: true,
    waitMs: 0,
    workMs: 0,
    attempts: 1,
    totalWallMs: 0,
    restarts: [],
    salvagedFromDiscardedAttempt: false,
    groundingRetrievalCount: 1
} as RunWorkerResult

async function trial(
    scratch: string,
    repo: string,
    task: string,
    i: number,
    arm: Arm,
    code: ArmCode
): Promise<Trial> {
    const taskFile = path.join(repo, '.pi-tasks')
    const refined = (await readSection(repo, task, 'refined prompt')) ?? ''
    const raw = (await readSection(repo, task, 'raw prompt')) ?? ''
    if (!existsSync(taskFile) || refined.length === 0) throw new Error(`${task}: no refined prompt`)
    const dir = path.join(scratch, `${task}-${i}-${arm}`)
    rmSync(dir, {recursive: true, force: true})
    git(scratch, 'clone', '-q', repo, dir)
    git(dir, 'checkout', '-q', checkpointOf(repo, raw))
    symlinkSync(path.join(repo, 'node_modules'), path.join(dir, 'node_modules'))
    const id = 'TASK_9001'
    await writeTaskFile(
        dir,
        {
            id,
            state: 'in_progress',
            phase: 'research',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            title: task
        },
        '\n'
    )
    let files: RunWorkerResult | null = null
    const out = await code.phaseResearch(
        {
            cwd: dir,
            taskId: id,
            signal: new AbortController().signal,
            runWorker: async (label: string, input: RunWorkerInput) => {
                if (label !== 'worker:files') return CANNED
                // From src/ the guard's path names a .js only the build emits.
                const armed: RunWorkerInput = {
                    ...input,
                    extensions: input.extensions?.map(e =>
                        e.endsWith('single-read-extension.js') && !existsSync(e) ? GUARD : e
                    )
                }
                const log = path.join(scratch, `${task}-${i}-${arm}.log`)
                const note = (line: string): void => appendFileSync(log, `${new Date().toISOString()} ${line}\n`)
                files = await code.runWorker({
                    ...armed,
                    onLine: line => {
                        note(line)
                        armed.onLine?.(line)
                    },
                    onToolResult: r => {
                        note(`  -> ${r.name}${r.isError ? ' ERROR' : ''}: ${r.text.slice(0, 300).replace(/\n/g, ' ')}`)
                        armed.onToolResult?.(r)
                    }
                })
                return files
            }
        },
        refined,
        raw
    )
    rmSync(dir, {recursive: true, force: true})
    const r = files as RunWorkerResult | null
    if (!r) throw new Error(`${task}: the FILES worker never ran`)
    const section = /^FILES\n([\s\S]*?)(?=\n\nAPIS\n)/m.exec(out)?.[1] ?? ''
    const degraded = section.startsWith('(degraded')
    return {
        task,
        i,
        arm,
        killed: r.restarts.length > 0 || degraded,
        restarts: r.restarts.map(x => `${x.reason}: ${x.detail ?? ''}`.slice(0, 160)),
        wallMs: r.totalWallMs,
        answered: section.trim().length > 0 && !degraded
    }
}

function fisherOneSided(aHit: number, aN: number, bHit: number, bN: number): number {
    const logF = (n: number): number => {
        let s = 0
        for (let i = 2; i <= n; i++) s += Math.log(i)
        return s
    }
    const total = aHit + bHit
    const N = aN + bN
    const p = (x: number): number =>
        Math.exp(
            logF(aN)
                + logF(bN)
                + logF(total)
                + logF(N - total)
                - logF(N)
                - logF(x)
                - logF(aN - x)
                - logF(total - x)
                - logF(bN - total + x)
        )
    let sum = 0
    for (let x = aHit; x <= Math.min(aN, total); x++) if (total - x <= bN) sum += p(x)
    return sum
}

async function main(): Promise<void> {
    const [scratch, repo, perTask = '2'] = process.argv.slice(2)
    if (!scratch || !repo) throw new Error('usage: ab-files-guard.ts <scratch-dir> <mx5-n-repo> [trials-per-task]')
    mkdirSync(scratch, {recursive: true})
    if (!existsSync(GUARD)) throw new Error(`${GUARD} missing: run npm run build`)
    // Outside pi, the worker would re-invoke this script as pi (pi-invocation.ts).
    if (!process.env.PI_BIN) throw new Error('set PI_BIN to the pi binary')
    const done: Trial[] = existsSync(LEDGER) ?
            readFileSync(LEDGER, 'utf8')
                .split('\n')
                .filter(Boolean)
                .map(l => JSON.parse(l) as Trial)
        :   []
    const base = path.join(scratch, 'base')
    if (!existsSync(base)) {
        git(scratch, 'clone', '-q', REPO, base)
        git(base, 'checkout', '-q', BASE_REF)
        symlinkSync(path.join(REPO, 'node_modules'), path.join(base, 'node_modules'))
    }
    if (git(base, 'rev-parse', 'HEAD') !== BASE_REF) throw new Error(`${base} is not at ${BASE_REF}`)
    const code: Record<Arm, ArmCode> = {A: await armCode(base), B: await armCode(REPO)}
    const n = Number(perTask)
    for (let i = 0; i < n; i++) {
        for (const task of TASKS) {
            // ABBA: even trial indices run A first, odd ones B first.
            const order: Arm[] = i % 2 === 0 ? ['A', 'B'] : ['B', 'A']
            for (const arm of order) {
                // A diagnosis run narrows to one cell: AB_ONLY=TASK_0002:B.
                if (process.env.AB_ONLY && process.env.AB_ONLY !== `${task}:${arm}`) continue
                if (done.some(t => t.task === task && t.i === i && t.arm === arm)) continue
                const t = await trial(scratch, repo, task, i, arm, code[arm])
                appendFileSync(LEDGER, `${JSON.stringify(t)}\n`)
                done.push(t)
                console.log(
                    `${task} #${i} ${arm}: killed=${t.killed} answered=${t.answered} `
                        + `${(t.wallMs / 60000).toFixed(1)} min ${t.restarts.join(' | ')}`
                )
            }
        }
    }
    const arm = (a: Arm): Trial[] => done.filter(t => t.arm === a)
    const [A, B] = [arm('A'), arm('B')]
    const killed = (ts: Trial[]): number => ts.filter(t => t.killed).length
    const answered = (ts: Trial[]): number => ts.filter(t => t.answered).length
    const minutes = (ts: Trial[]): string =>
        (ts.reduce((s, t) => s + t.wallMs, 0) / 60000).toFixed(1)
    const p = fisherOneSided(killed(A), A.length, killed(B), B.length)
    console.log(
        `A killed ${killed(A)}/${A.length}, answered ${answered(A)}, ${minutes(A)} min | `
            + `B killed ${killed(B)}/${B.length}, answered ${answered(B)}, ${minutes(B)} min | p=${p.toFixed(4)}`
    )
    if (killed(A) === 0) {
        console.log('ABSTAIN: arm A was never killed, so this run cannot show a difference')
        process.exit(2)
    }
    const pass = p < 0.05 && answered(B) / B.length >= answered(A) / A.length
    console.log(pass ? 'PASS' : 'FAIL')
    process.exit(pass ? 0 : 1)
}

await main()
