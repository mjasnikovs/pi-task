/**
 * STEP 0 for the critique loop-exhaustion fallback — how often does the critique
 * rewrite really burn all three loop strikes on THIS model?
 *
 * WHY A FRESH RATE. The ~/hub corpus records 67 completed critique phases and ZERO
 * loop retries, so the historical answer is "never". One run of issue #13's bench
 * hit it once in ten critique children on Qwen3.8-27B, costing the whole task —
 * `critiqueWithFallback` catches only `no_verify_block` and `verify_grep_theater`,
 * so `LoopExhaustedError` propagates and the task fails with a valid compose draft
 * sitting unused. Two corpora disagree, so the fresh one is measured directly
 * rather than pooled.
 *
 * WHAT THIS DOES. Replays ONE recorded critique input (the level that failed) N
 * times through the REAL `phaseCritique`, unchanged, and counts outcomes. No lever
 * is applied and nothing in src is touched — this only establishes whether the
 * class reproduces.
 *
 * PRE-REGISTERED GATE, written before running:
 *
 *     PROCEED to the fallback lever iff loop-exhaustion >= 2 of N reps.
 *     0 or 1 of N: the single observation stays an anecdote. Record and STOP.
 *
 * Usage: PI_BIN=pi bun run scripts/critique-loop-baserate.ts <level> [reps=6]
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import {phaseCritique} from '../dist/task/phases.js'
import {parseVerifyBlock} from '../dist/task/spec-validation.js'

const OUT = '/home/edgars/tmp/issue13'
const level = Number(process.argv[2] ?? '3')
const reps = Number(process.argv[3] ?? '6')

interface Input {
    level: number
    label: string
    refined: string
    research: string
    qa: string
    draft: string
    ok: boolean
}

const inputs = fs
    .readFileSync(path.join(OUT, 'inputs.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(l => JSON.parse(l) as Input)
const inp = inputs.find(i => i.level === level && i.ok)
if (!inp) {
    console.error(`no recorded input for level ${level}`)
    process.exit(2)
}
const cwd = path.join(OUT, `repo-${level}`)

// The draft must itself be shippable, or "fall back to the draft" is not a lever
// worth testing and the rig cannot discriminate.
if (parseVerifyBlock(inp.draft) === null) {
    console.error('FIXTURE CANNOT DISCRIMINATE — the compose draft has no VERIFY block.')
    process.exit(2)
}

const counts = {ok: 0, loop: 0, other: 0}
for (let rep = 1; rep <= reps; rep++) {
    const ac = new AbortController()
    const trail: string[] = []
    const started = Date.now()
    let outcome = 'ok'
    let detail = ''
    try {
        await phaseCritique(
            {cwd, taskId: 'TASK_0001', signal: ac.signal, logDebug: (m: string) => trail.push(m)},
            inp.draft,
            inp.refined,
            inp.qa,
            undefined,
            inp.research
        )
        counts.ok++
    } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e))
        detail = `${err.name}: ${err.message}`
        if (err.name === 'LoopExhaustedError') {
            outcome = 'loop'
            counts.loop++
        } else {
            outcome = 'other'
            counts.other++
        }
    }
    const line = {
        rep,
        level,
        label: inp.label,
        outcome,
        detail,
        ms: Date.now() - started,
        trail
    }
    fs.appendFileSync(path.join(OUT, 'loop-baserate.jsonl'), JSON.stringify(line) + '\n')
    console.log(
        `[rep ${rep}/${reps}] ${outcome} ${Math.round(line.ms / 1000)}s ${detail} `
            + `| trail: ${trail.join(' ; ') || '(clean)'}`
    )
}

console.log(
    `\nL${level} ${inp.label}: ok=${counts.ok} loop=${counts.loop} other=${counts.other} of ${reps}`
)
console.log(
    counts.loop >= 2 ?
        'GATE MET — loop exhaustion reproduces. Proceed to the fallback lever.'
    :   'GATE NOT MET — record and STOP. The single observation stays an anecdote.'
)
