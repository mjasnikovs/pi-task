/**
 * STEP 0 for a candidate lever — can a one-shot re-prompt recover the missing
 * ALT line on a fork-shaped question?
 *
 * Measured in live-task-plan-step0: the model reliably emits SUGGESTED, but
 * routinely writes a question that names two options ("per-provider or
 * globally?") and then gives only one of them, so the picker shows one card and
 * the user has to type the option the model itself just proposed.
 *
 * The candidate fix reuses the existing one-shot format-retry budget with a
 * targeted hint that quotes the question back (the child is stateless — a fresh
 * process per call — so it cannot otherwise know what it just wrote).
 *
 * This measures whether the retry WORKS before anything is wired:
 *   • fires     — question is fork-shaped and carries no ALT
 *   • recovered — the retry came back WITH an ALT
 *   • same-Q    — the retry re-asked the SAME question rather than a new one
 *                 (a new question would mean the retry costs the user their
 *                 question, not just 30 seconds)
 *
 * Run: PI_BIN=$(command -v pi) bun run scripts/live-task-plan-fork-alt.ts [REPS]
 */
import {runPhaseChild, prependHint, type PhaseDeps} from '../src/task/child-runner.js'
import {PLAN_QUESTION_PROMPT} from '../src/task/plan-prompts.js'
import {parseClarifyList} from '../src/task/parsers.js'
import {pickQuestion} from '../src/task/plan-session.js'
import {stripInlineMarkdown} from '../src/task/inline-markdown.js'
import {isDuplicateQuestion} from '../src/task/question-dedup.js'

const TASKS = [
    'Add rate limiting to the web search workers so a run cannot hammer the search provider',
    'Let /task-list filter tasks by state',
    'Write the per-task debug log as JSON lines instead of plain text'
]

/** A question that names two alternatives before its "?". */
function looksLikeFork(q: string): boolean {
    return /\bor\b/i.test(q.split('?')[0] ?? '')
}

/** The candidate hint. Quotes the question back because the child is stateless. */
function forkHint(question: string): string {
    return (
        '[SYSTEM NOTE: Your previous reply asked this question:\n'
        + `"${question}"\n`
        + 'That question offers the user a choice between two alternatives, but you gave only '
        + 'one SUGGESTED line, so the user is shown a single option and has to type the other '
        + 'one out by hand. Ask the SAME question again — do not change the subject — and this '
        + 'time emit BOTH lines:\nSUGGESTED: <the option you recommend>\nALT: <the other option>\n'
        + 'Nothing else.]'
    )
}

async function main() {
    const reps = parseInt(process.argv[2] ?? '3', 10)
    const cwd = process.cwd()
    const deps: PhaseDeps = {cwd, taskId: '', signal: new AbortController().signal}

    let n = 0
    let forks = 0
    let fires = 0
    let recovered = 0
    let sameQ = 0

    for (let r = 0; r < reps; r++) {
        for (const task of TASKS) {
            n++
            const prompt = PLAN_QUESTION_PROMPT(task, '')
            const first = pickQuestion(
                parseClarifyList(await runPhaseChild(deps, 'plan-question', 'read', prompt))
            )
            if (!first) {
                console.log(`rep ${r + 1}: unparsed`)
                continue
            }
            const q = stripInlineMarkdown(first.question)
            const fork = looksLikeFork(q)
            if (fork) forks++
            if (!fork || first.alt !== undefined) {
                console.log(`rep ${r + 1}: ${fork ? 'fork WITH alt' : 'not a fork'} — no retry`)
                continue
            }
            fires++
            const retry = pickQuestion(
                parseClarifyList(
                    await runPhaseChild(
                        deps,
                        'plan-question',
                        'read',
                        prependHint(forkHint(q), prompt)
                    )
                )
            )
            const gotAlt = retry?.alt !== undefined
            const same =
                retry !== undefined && isDuplicateQuestion([q], stripInlineMarkdown(retry.question))
            if (gotAlt) recovered++
            if (same) sameQ++
            console.log(
                `rep ${r + 1}: RETRY → alt=${gotAlt ? 'YES' : 'no'} sameQuestion=${same ? 'YES' : 'no'}`
            )
            console.log(`   was: ${q.slice(0, 100)}`)
            console.log(
                `   now: ${retry ? stripInlineMarkdown(retry.question).slice(0, 100) : '(unparsed)'}`
            )
            if (retry?.alt) console.log(`   ALT: ${retry.alt.slice(0, 100)}`)
        }
    }

    console.log(`\n─── ${n} question(s) ───`)
    console.log(`fork-shaped         ${forks}/${n}`)
    console.log(`retry fired         ${fires}/${n}`)
    console.log(`recovered an ALT    ${recovered}/${fires || 1}`)
    console.log(`kept the same Q     ${sameQ}/${fires || 1}`)
}

void main()
