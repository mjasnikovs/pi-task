/**
 * Run a group's screen and print what survives, with no model and no GPU.
 *
 * The screen is the expensive GPU-FREE step of a gate run: two real VERIFY
 * scripts per task, and on the mx5 corpus only 20 of 51 tasks survive. Running
 * it here publishes the surviving ids so a later run can pass them as
 * `AB_GATE_TASKS` and re-screen just those instead of all 51.
 *
 * It is also the honest way to find out whether the gate cell is measurable at
 * all BEFORE booking GPU hours for it. Zero surviving tasks means there is no
 * ground truth on this corpus, and the answer is to say so, not to fall back to
 * the shape check that already returned 10/10 in both arms.
 *
 *   AB_CORPUS=/mx5copy bun run scripts/reasoning-ab-gate-screen.ts [gate|research] [limit]
 *
 * `research`'s screen is a different shape and far cheaper: it scores each
 * task's OWN recorded FILES section against its own after-tree with `git
 * ls-tree` and one `git diff`, so it needs no extracted trees and finishes in
 * under a second.
 *
 * IT MUST STAY THE SAME SCREEN THE HARNESS RUNS. This script publishes the ids
 * a later run measures, so a screen that drifts from the live one hands the run
 * a stimulus set the axis cannot express. That is not hypothetical: the
 * precision-only screen published TASK_0002..0012, seven of which edit no
 * pre-existing file, and the run tied 10/10 on an axis those tasks could not
 * move.
 */
import os from 'node:os'
import path from 'node:path'
import {gateStimuli} from './reasoning-ab-gate-truth.js'
import {filesRecallStimuli} from './reasoning-ab-files-truth.js'
import {openRecordedRun} from './ab-corpus.js'
import {MX5} from './impl-ab-corpus.js'
import {EXIT_CODE} from './ab-verdict.js'

const group = (process.argv[2] ?? 'gate').trim()
if (group !== 'gate' && group !== 'research') {
    console.error(`usage: reasoning-ab-gate-screen.ts [gate|research] [limit] — got "${group}"`)
    process.exit(EXIT_CODE.ABSTAIN)
}
const limit = Number(process.argv[3] ?? process.env.AB_GATE_TASK_LIMIT ?? 10)
const only = (process.env.AB_GATE_TASKS ?? '')
    .split(',')
    .map(x => x.trim())
    .filter(x => x.length > 0)

console.log(`group:   ${group}`)
console.log(`corpus:  ${MX5}`)
console.log(`limit:   ${limit} usable task(s)`)
if (only.length > 0) console.log(`only:    ${only.join(', ')}`)
console.log('')

if (group === 'research') {
    const run = openRecordedRun(MX5)
    if (!run) {
        console.error(`ABSTAIN — no recorded run at ${MX5}.`)
        process.exit(EXIT_CODE.ABSTAIN)
    }
    const byId = new Map(run.tasks().map(t => [t.id, t]))
    const filesSection = (id: string): string | undefined => {
        const research = byId.get(id)?.section('research')?.trim()
        if (!research) return undefined
        const m = /^FILES[ \t]*$([\s\S]*?)(?=^[A-Z][A-Z -]*[ \t]*$|(?![\s\S]))/m.exec(research)
        return m?.[1]
    }
    const r = filesRecallStimuli({
        recordedFiles: t => filesSection(t.id),
        refinedPrompt: t => byId.get(t.id)?.section('refined prompt')?.trim(),
        minEdited: Number(process.env.AB_RESEARCH_MIN_EDITED ?? 2),
        limitTasks: limit
    })
    for (const o of r.screened) console.log(`  ${o.id} ${o.usable ? 'usable' : 'DROPPED'} — ${o.detail}`)
    console.log('')
    console.log(`screened ${r.screened.length}, usable ${r.stimuli.length}`)
    if (r.stimuli.length === 0) {
        console.error('')
        console.error('*** NO GROUND TRUTH ON THIS CORPUS ***')
        console.error(
            'Not one task has a recorded FILES section that is both fully grounded in its'
        )
        console.error(
            'own after-tree AND names every pre-existing file the task edited, so there is'
        )
        console.error('nothing to score a child against. Do NOT fall back to the shape check')
        console.error('or to precision alone — both are ceilings this group was moved off.')
        process.exit(EXIT_CODE.ABSTAIN)
    }
    console.log('')
    console.log(`AB_RESEARCH_TASK_LIMIT=${r.stimuli.length}`)
    console.log(`# stimuli: ${r.stimuli.map(x => `${x.id}(${x.edited?.length ?? 0})`).join(' ')}`)
    process.exit(EXIT_CODE.PASS)
}

const {stimuli, screened} = gateStimuli({
    treeRoot: path.join(os.tmpdir(), 'pi-task-gate-screen'),
    verifyTimeoutMs: Number(process.env.AB_VERIFY_TIMEOUT_MS ?? 180_000),
    ...(only.length > 0 ? {only} : {}),
    limitTasks: limit
})

const usable = screened.filter(o => o.usable)
console.log('')
console.log(`screened ${screened.length}, usable ${usable.length}, stimuli ${stimuli.length}`)

if (stimuli.length === 0) {
    console.error('')
    console.error('*** NO GROUND TRUTH ON THIS CORPUS ***')
    console.error(
        'Not one task has a VERIFY that fails on its before-tree and passes on its'
    )
    console.error(
        'after-tree, so no tree has a known correct verdict and the gate cell cannot'
    )
    console.error('be measured here. Do NOT fall back to the shape check: it returned 10/10')
    console.error('in both arms and cannot separate anything.')
    process.exit(EXIT_CODE.ABSTAIN)
}

console.log('')
console.log(`AB_GATE_TASKS=${usable.map(o => o.id).join(',')}`)
