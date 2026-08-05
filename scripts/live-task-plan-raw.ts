/**
 * Dump the RAW question-child reply for one task, so a malformed reply can be
 * read rather than guessed at. Diagnostic only.
 *
 * Run: PI_BIN=$(command -v pi) bun run scripts/live-task-plan-raw.ts "<task>" [reps]
 */
import {runPhaseChild, type PhaseDeps} from '../src/task/child-runner.js'
import {PLAN_QUESTION_PROMPT} from '../src/task/plan-prompts.js'
import {parseClarifyList} from '../src/task/parsers.js'

async function main() {
    const task = process.argv[2] ?? 'Add rate limiting to the web search workers'
    const reps = parseInt(process.argv[3] ?? '1', 10)
    const deps: PhaseDeps = {cwd: process.cwd(), taskId: '', signal: new AbortController().signal}
    for (let i = 0; i < reps; i++) {
        const raw = await runPhaseChild(
            deps,
            'plan-question',
            'read',
            PLAN_QUESTION_PROMPT(task, '')
        )
        console.log(`════════ rep ${i + 1} raw ════════\n${raw}\n════════ parsed ════════`)
        console.log(JSON.stringify(parseClarifyList(raw), null, 2))
    }
}

void main()
