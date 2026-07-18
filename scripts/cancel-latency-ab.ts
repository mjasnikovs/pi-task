/**
 * A/B: /task-auto-cancel latency — how much work still runs AFTER the user asks
 * to stop.
 *
 * Drives the REAL runAutoLoop over a REAL TaskRunner (scripted spawn, so every
 * phase boundary is the production code path). The cancel is delivered the way a
 * user actually delivers it — the literal line typed into the editor and
 * submitted, routed through the raw terminal-input listener — from inside a
 * chosen seam.
 *
 * Delivery is armed in BOTH arms: it is a separate defect with its own coverage
 * (cancel-input.test.ts, plus the negative control in cancel-points.test.ts),
 * and holding it fixed here isolates the variable actually under test — WHERE
 * the request is observed.
 *
 *   baseline  — the flag is polled ONLY at the loop top (auto-orchestrator's
 *               pre-cancel-points behaviour, reproduced here by suppressing the
 *               new checkpoints via CANCEL_AB_ARM=baseline).
 *   treatment — the flag is polled at every safe checkpoint: pre-task, each
 *               spec-phase boundary, pre-final-gate, loop-top.
 *
 * GROUND TRUTH is mechanical, never a self-report. Per seam we record:
 *   phasesAfter  — spec phases that executed after the request (spawn calls are
 *                  counted by the fake spawn, which cannot be faked away)
 *   tasksAfter   — further task entries the loop started
 *   gateAfter    — whether the whole-repo final gate ran after the request
 *   stopPoint    — the checkpoint that actually stopped the run
 *   resumable    — the parent run is still findable by /task-auto-resume AND the
 *                  cancelled entry is NOT checked off (a cancel that loses work
 *                  or falsely completes is a failure, however fast it is)
 *
 * Run: bun run scripts/cancel-latency-ab.ts <baseline|treatment>
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {runAutoLoop, type AutoDeps} from '../src/task/auto-orchestrator.js'
import {TaskRunner} from '../src/task/orchestrator.js'
import {
    requestCancel,
    resetCancel,
    resetCheckpointTrail,
    checkpointsCrossed
} from '../src/task/cancel-points.js'
import {armCancelListener, disarmCancelListener} from '../src/task/cancel-input.js'
import {writeTaskFile, readTaskFile} from '../src/task/task-io.js'
import {findResumableAuto, parseTaskList} from '../src/task/auto-io.js'
import {makeFakeCtx} from '../src/test-utils/fake-ctx.js'
import {fakeSpawnByPrompt, agentEndResponse, type SpawnResponse} from '../src/test-utils/fake-spawn.js'
import type {SpawnFn} from '../src/shared/child-process.js'
import type {TaskFrontMatter} from '../src/task/task-types.js'

const ARM = (process.argv[2] ?? 'treatment') as 'baseline' | 'treatment'
if (ARM !== 'baseline' && ARM !== 'treatment') {
    console.error('usage: bun run scripts/cancel-latency-ab.ts <baseline|treatment>')
    process.exit(2)
}
process.env.CANCEL_AB_ARM = ARM

/** Phase order the runner executes, used to name the seams. */
type SpecPhase = 'refine' | 'research' | 'grill' | 'compose' | 'critique'
type Seam = SpecPhase | 'impl' | 'gates' | 'between-tasks'

const SEAMS: Seam[] = ['refine', 'research', 'grill', 'compose', 'critique', 'impl', 'gates', 'between-tasks']

const REFINED = `GOAL\nShip the slice.\n\nCONSTRAINTS\n- Use bun.\n\nKNOWN-UNKNOWNS\n- (none)\n`
const SPEC = `GOAL\nShip the slice.\n\nCONSTRAINTS\n- none\n\nACCEPTANCE\n- exit 0\n\nVERIFY:\n\`\`\`bash\nbun run lint\n\`\`\`\n`
const VERIFIED_TOOLING = `VERIFIED\n  bun run lint  found in package.json scripts\n\nREJECTED\n`

/**
 * Measured wall-clock cost per child, from the REAL mx5 run under
 * /home/edgars/hub/mx5/.pi-tasks (means over the 19–20 tasks that recorded a
 * `## phase timings` block; impl+gates from the gaps between consecutive
 * TASK_*-debug.log windows). The harness's stub children run in microseconds, so
 * without this the A/B would report a real defect in fake units.
 *
 *   refine 42.6s · research 239.0s · grill 28.2s · compose 18.6s · critique 19.6s
 *   spec pipeline mean 470s · impl+gates mean 570s · full task cycle mean ~1040s
 *
 * research fans out 4 workers + verify-tooling, so its per-CHILD cost is the
 * phase mean spread across the 5 children it spawns.
 */
const CHILD_COST_S: Record<string, number> = {
    refine: 42.6,
    researchFiles: 47.8,
    researchApis: 47.8,
    researchContext: 47.8,
    researchTooling: 47.8,
    verifyTooling: 47.8,
    grillGen: 14.1,
    grillAuto: 14.1,
    compose: 18.6,
    critique: 19.6,
    unknown: 0
}

/** Mean impl-turn + gates cost for one task, from the same run. Charged when the
 *  run pushes past the pre-task checkpoint into a task it did not need to run. */
const IMPL_GATES_COST_S = 570

interface Trial {
    seam: Seam
    wastedS: number
    phasesAfter: number
    tasksAfter: number
    gateAfter: boolean
    stopPoint: string
    resumable: boolean
    checkedOff: boolean
}

function autoFm(id: string): TaskFrontMatter {
    const now = new Date().toISOString()
    return {id, state: 'in_progress', phase: 'done', created_at: now, updated_at: now, title: 'ab'}
}

function autoBody(titles: string[]): string {
    return `\n## feature\n\nab\n\n## tasks\n\n${titles.map(t => `- [ ] ${t}`).join('\n')}\n`
}

/** Prompt fingerprints that identify which phase a spawned child belongs to.
 *  Verbatim from orchestrator.test.ts, so the harness classifies children the
 *  same way the existing unit tests do. */
const CHILD_TAGS: Array<[string, string, SpecPhase]> = [
    ['refine', 'Rewrite it to be unambiguous and actionable', 'refine'],
    ['researchFiles', 'FILES owns paths', 'research'],
    ['researchApis', 'APIS owns symbols and commands BY NAME ONLY', 'research'],
    ['researchContext', 'gather background knowledge', 'research'],
    ['researchTooling', 'identify the verification tools', 'research'],
    ['verifyTooling', 'YOU MAY ONLY READ. Do NOT execute', 'research'],
    ['grillGen', 'preparing clarifying questions', 'grill'],
    ['grillAuto', 'pre-answering a clarifying question', 'grill'],
    ['compose', 'composing the final implementation spec', 'compose'],
    ['critique', 'reviewing the implementation spec', 'critique']
]

/** [child kind, owning phase] for a spawned prompt. */
function tagOf(prompt: string): {kind: string; phase: string} {
    for (const [kind, needle, phase] of CHILD_TAGS) {
        if (prompt.includes(needle)) return {kind, phase}
    }
    return {kind: 'unknown', phase: 'unknown'}
}

async function runTrial(seam: Seam): Promise<Trial> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cancel-ab-'))
    fs.mkdirSync(path.join(dir, '.pi-tasks'), {recursive: true})
    resetCancel()
    resetCheckpointTrail()

    let requested = false
    const phaseRuns: string[] = []
    const tasksStarted: string[] = []
    let gateRan = false

    // Type the command and press Enter, exactly as a user does mid-run. Returns
    // nothing useful on purpose: the measurement is what the loop does next.
    let typeLine: (text: string) => boolean = () => false
    const fire = () => {
        if (requested) return
        requested = true
        if (!typeLine('/task-auto-cancel')) {
            // Delivery failed — that is the OTHER defect, not this A/B's subject.
            console.error('  !! keystroke was not delivered; falling back to a direct request')
            requestCancel()
        }
    }

    // Fake spawn: every phase child is one call. Counting them AFTER the request
    // is the unfakeable measure of "work that still ran".
    const spawn: SpawnFn = fakeSpawnByPrompt(args => {
        const prompt = args[args.length - 1] ?? ''
        const {kind, phase} = tagOf(prompt)
        if (requested) phaseRuns.push(kind)
        // Fire the cancel from inside the seam's own child, i.e. while that phase
        // is mid-flight — the realistic moment a user hits the command.
        if (!requested && phase === seam) fire()
        const text =
            kind === 'refine' ? REFINED
            : kind === 'verifyTooling' ? VERIFIED_TOOLING
            : kind === 'grillGen' ? '(no clarifying questions for this task)'
            : kind === 'compose' || kind === 'critique' ? SPEC
            : 'ok'
        return agentEndResponse(text) as SpawnResponse
    })

    const handle = makeFakeCtx(dir)
    const {ctx} = handle
    typeLine = handle.typeLine
    armCancelListener(ctx, () => requestCancel())
    await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), autoBody(['A', 'B', 'C']))

    const deps: AutoDeps = {
        runChild: () => Promise.resolve(''),
        // The gate's verify child: the 'gates' seam fires from here, standing in
        // for a user cancelling while `verify work` is running.
        verify: () => {
            if (seam === 'gates') fire()
            return Promise.resolve({ok: true, reason: 'ab'})
        },
        commit: () => Promise.resolve({committed: false}),
        runTask: async (c, cwd, title, opts) => {
            tasksStarted.push(title)
            const runner = new TaskRunner(
                c,
                cwd,
                title,
                opts?.resumeId,
                async () => {
                    if (seam === 'impl') fire()
                },
                spawn,
                opts?.onStart
            )
            await runner.run()
            // Control seam: the cancel lands in the quiet moment between tasks,
            // the one case the pre-existing loop-top check already handled.
            if (seam === 'between-tasks') fire()
            const id = runner.taskId
            // Mirror runSingleTask: the file's own state is the source of truth,
            // and a phase-boundary cancel leaves it 'cancelled', i.e. not ok.
            let ok: boolean
            try {
                ok = (await readTaskFile(cwd, id)).frontMatter.state === 'completed'
            } catch {
                ok = false
            }
            return {taskId: id, ok, sessionCancelled: false, ctx: c}
        },
        finalGate: () => {
            gateRan = true
            return Promise.resolve({ok: true, reason: 'ab'})
        }
    } as unknown as AutoDeps

    // The gates are stubbed to a pass so the loop advances; the 'gates' seam
    // fires from inside them, standing in for a verify/enforce child.
    ;(deps as unknown as Record<string, unknown>).verifyWork = () => {
        if (seam === 'gates') fire()
        return Promise.resolve({ok: true, reason: 'ab'})
    }

    try {
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', deps)
    } finally {
        disarmCancelListener()
    }

    const {body} = await readTaskFile(dir, 'TASK_AUTO_0001')
    const entries = parseTaskList(body)
    const resumable = (await findResumableAuto(dir)) === 'TASK_AUTO_0001'
    const crossed = checkpointsCrossed()
    const startedAfter = tasksStarted.length - (tasksStarted.length > 0 ? 1 : 0)

    // Wall-clock the user waits after asking to stop: every child that still ran,
    // priced at its measured mean, plus the impl+gates cost of each task the run
    // reached after the request AND of the one it was already inside (the cancel
    // is only observed on the far side of them).
    const stopPoint = crossed.length > 0 ? crossed[crossed.length - 1] : '(never polled)'
    // The impl turn + gates are charged only when the run actually went through
    // them after the request. A stop at a spec-phase boundary never reaches them;
    // a stop at loop-top always did (loop-top is on their far side). The 'impl'
    // and 'gates' seams pay it in BOTH arms — mid-turn is not a safe checkpoint,
    // so that cost is the floor, not a regression.
    const wentThroughImpl =
        stopPoint === 'loop-top' && seam !== 'between-tasks' ? 1 : 0
    const wastedS =
        phaseRuns.reduce((a, k) => a + (CHILD_COST_S[k] ?? 0), 0)
        + (wentThroughImpl + Math.max(0, startedAfter)) * IMPL_GATES_COST_S

    fs.rmSync(dir, {recursive: true, force: true})
    return {
        seam,
        wastedS: Math.round(wastedS),
        phasesAfter: phaseRuns.length,
        tasksAfter: Math.max(0, startedAfter),
        gateAfter: gateRan,
        stopPoint,
        resumable,
        checkedOff: entries.filter(e => e.done).length > 0
    }
}

const rows: Trial[] = []
for (const seam of SEAMS) {
    rows.push(await runTrial(seam))
}

console.log(`\n=== /task-auto-cancel latency — arm: ${ARM} ===\n`)
console.log('seam            waitAfterCancel  phasesAfter  stopPoint            resumable')
for (const r of rows) {
    const wait = `${Math.floor(r.wastedS / 60)}m${String(r.wastedS % 60).padStart(2, '0')}s`
    console.log(
        `${r.seam.padEnd(15)} ${wait.padEnd(16)} ${String(r.phasesAfter).padEnd(12)} `
            + `${r.stopPoint.padEnd(20)} ${r.resumable}`
    )
}
const totalPhases = rows.reduce((a, r) => a + r.phasesAfter, 0)
const totalS = rows.reduce((a, r) => a + r.wastedS, 0)
console.log(
    `\nTOTAL across ${rows.length} seams: ${totalPhases} phase children still ran, `
        + `${Math.round(totalS / 60)} min of wall-clock waited after the cancel was requested; `
        + `worst seam ${Math.round(Math.max(...rows.map(r => r.wastedS)) / 60)} min; `
        + `all-resumable=${rows.every(r => r.resumable)}`
)
