/**
 * STEP 0 — does /task-plan's question generator produce a PARSEABLE, single-task
 * question on the real local model?
 *
 * PLAN_QUESTION_PROMPT is deliberately shaped like /task-auto's AUTO_CLARIFY_PROMPT
 * so `parseClarifyList` parses it unchanged. That reuse is only worth anything if
 * the model actually obeys the format here, and the JOB is different enough
 * (one task, not a plan split) that the obedience does not transfer for free.
 *
 * Measures, per rep, against the REAL model with the read tool:
 *   • parsed        — parseClarifyList found a question (or NONE)
 *   • suggested     — the required SUGGESTED line was present
 *   • alt           — an ALT line was present (binary fork)
 *   • split-leak    — the question is about SPLITTING the work into tasks/phases,
 *                     which is /task-auto's job and explicitly banned here
 *   • none          — the model emitted the NONE sentinel on the first question
 *
 * It measures a base rate; it decides nothing.
 *
 * Run: PI_BIN=$(command -v pi) bun run scripts/live-task-plan-step0.ts [REPS] [repo]
 */
import {runChild} from '../src/task/child-runner.js'
import {PLAN_QUESTION_PROMPT} from '../src/task/plan-prompts.js'
import {parseClarifyList} from '../src/task/parsers.js'
import {pickQuestion} from '../src/task/plan-session.js'
import {stripInlineMarkdown} from '../src/task/inline-markdown.js'

/**
 * A question that names two alternatives ("X or Y?") but ships no ALT line
 * leaves the user one green card and a keyboard for the option the model itself
 * just proposed. Detected on the question text alone, so it is independent of
 * whatever the model chose to tag.
 */
function looksLikeFork(q: string): boolean {
    return /\bor\b/i.test(q.split('?')[0] ?? '')
}

/** Tasks a user would plausibly type at /task-plan in THIS repo. Each is
 *  genuinely under-specified, so a question is the right response to all three. */
const TASKS = [
    'Add rate limiting to the web search workers so a run cannot hammer the search provider',
    'Let /task-list filter tasks by state',
    'Write the per-task debug log as JSON lines instead of plain text'
]

/**
 * Is this question about how the WORK IS SPLIT rather than how this one task is
 * built? Same shape-detector family as live-plan-granularity-step0.ts, which is
 * where the vocabulary comes from.
 */
function isSplitQuestion(q: string): boolean {
    const s = q.toLowerCase()
    // Deliberately narrow. A first draft matched the bare word "phases" and
    // flagged two questions that merely mentioned pi-task's own phases — the
    // detector has to catch "how do we cut this up", not any sentence with a
    // planning noun in it.
    return (
        /\b(split|break|divide|carve)\b[^?]{0,40}\b(into|up|down|apart)\b/.test(s)
        || /\b(separate|its own|another|follow-?up|second|later)\s+(task|pr|commit|step|change)s?\b/.test(
            s
        )
        || /\bone (task|pr|commit) per\b/.test(s)
        || /\bsub-?tasks?\b/.test(s)
        || /\bmilestones?\b/.test(s)
        || /\bin (stages|phases)\b/.test(s)
    )
}

async function main() {
    const reps = parseInt(process.argv[2] ?? '4', 10)
    const cwd = process.argv[3] ?? process.cwd()
    const signal = new AbortController().signal

    let n = 0
    let parsed = 0
    let suggested = 0
    let alt = 0
    let splitLeak = 0
    let none = 0
    let naiveMiss = 0
    let grounded = 0
    let forkNoAlt = 0
    let totalCalls = 0
    const failures: string[] = []

    for (let r = 0; r < reps; r++) {
        for (const task of TASKS) {
            n++
            const t0 = Date.now()
            let raw: string
            let toolCalls = 0
            try {
                const res = await runChild(
                    cwd,
                    'read',
                    PLAN_QUESTION_PROMPT(task, ''),
                    signal,
                    undefined,
                    undefined,
                    () => {
                        toolCalls++
                        return null
                    }
                )
                raw = res.text
            } catch (err) {
                failures.push(`THREW  ${task.slice(0, 40)}: ${(err as Error).message}`)
                console.log(`rep ${r + 1} · THREW · ${(err as Error).message}`)
                continue
            }
            const ms = Date.now() - t0
            totalCalls += toolCalls
            // GROUNDING: a question written without opening a single file is the
            // generic one the prompt exists to avoid. Measured as tool calls, not
            // as elapsed time.
            if (toolCalls > 0) grounded++
            const isNone = /^\s*NONE\s*$/m.test(raw)
            const qs = parseClarifyList(raw)
            if (isNone) none++
            if (qs.length > 0 || isNone) parsed++
            else
                failures.push(
                    `UNPARSED  ${task.slice(0, 40)}: ${raw.replace(/\s+/g, ' ').slice(0, 200)}`
                )
            // What /task-plan actually shows: the entry carrying the SUGGESTED
            // line, not blindly entry 0 (see pickQuestion). `naiveMiss` counts the
            // reps where those two differ — the parser fix's own contribution.
            const q = pickQuestion(qs)
            if (qs.length > 0 && q !== qs[0]) naiveMiss++
            if (q) {
                if (q.suggested !== undefined && q.suggested.length > 0) suggested++
                else failures.push(`NO-SUGGESTED  ${stripInlineMarkdown(q.question).slice(0, 120)}`)
                if (q.alt !== undefined) alt++
                else if (looksLikeFork(stripInlineMarkdown(q.question))) {
                    forkNoAlt++
                    failures.push(`FORK-NO-ALT  ${stripInlineMarkdown(q.question).slice(0, 140)}`)
                }
                const plain = stripInlineMarkdown(q.question)
                if (isSplitQuestion(plain)) {
                    splitLeak++
                    failures.push(`SPLIT-LEAK  ${plain.slice(0, 160)}`)
                }
                console.log(
                    `rep ${r + 1} · ${Math.round(ms / 1000)}s · ${toolCalls} tool call(s) · `
                        + `${q.alt ? 'A/B' : 'open'} · ${plain.slice(0, 100)}`
                )
                console.log(`         SUGGESTED: ${(q.suggested ?? '(MISSING)').slice(0, 110)}`)
                if (q.alt) console.log(`         ALT:       ${q.alt.slice(0, 110)}`)
            } else {
                console.log(
                    `rep ${r + 1} · ${Math.round(ms / 1000)}s · ${isNone ? 'NONE' : 'UNPARSED'}`
                )
            }
        }
    }

    const pct = (x: number) => `${x}/${n} (${Math.round((100 * x) / n)}%)`
    console.log(`\n─── ${n} reps over ${TASKS.length} tasks ───`)
    console.log(`parsed      ${pct(parsed)}`)
    console.log(`SUGGESTED   ${pct(suggested)}`)
    console.log(`ALT (fork)  ${pct(alt)}`)
    console.log(`NONE first  ${pct(none)}`)
    console.log(`split-leak  ${pct(splitLeak)}   <- must be 0`)
    console.log(`grounded    ${pct(grounded)}   (>=1 tool call; ${totalCalls} calls total)`)
    console.log(`fork w/o ALT ${pct(forkNoAlt)}   <- should be 0`)
    console.log(`rescued by pickQuestion (entry 0 was a note): ${naiveMiss}`)
    if (failures.length > 0) {
        console.log(`\n─── ${failures.length} problem(s) ───`)
        for (const f of failures) console.log(f)
    }
}

void main()
