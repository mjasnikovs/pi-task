/**
 * STEP 0 + A/B — does /task-plan's question generator recommend a DEFERRAL, and
 * do the two halves of the fix move it?
 *
 * The live failure (aiz-client TASK_PLAN_0001, 2026-08-05): asked "what specific
 * report should this new tab display?", the model recommended "clarify with the
 * user what the report is meant to show before proceeding". Accepted with one
 * keypress, it rode into /task as an AUTHORITATIVE decision not to proceed, and
 * /task built a task whose ACCEPTANCE was a document and whose VERIFY asserted
 * that no source file had changed.
 *
 * Three arms per (task, rep), so the base rate and both halves are measured on
 * the same draws:
 *   BASE     — the prompt WITHOUT the "the SUGGESTED must DECIDE" paragraph
 *   RETRY    — only when BASE deferred: one planDecisiveHint re-prompt (the host
 *              lever; this is the half that has to work, since the prompt rule
 *              alone is unenforced)
 *   FIX      — the shipped prompt, with the paragraph (the belt)
 *
 * Deferral is scored by isDeferralSuggestion — the same predicate the loop uses,
 * so a miss here is a miss in production.
 *
 * Run: PI_BIN=$(command -v pi) bun run scripts/live-plan-deferral-step0.ts [REPS] [repo]
 */
import {runChild} from '../src/task/child-runner.js'
import {prependHint} from '../src/task/child-runner.js'
import {PLAN_QUESTION_PROMPT} from '../src/task/plan-prompts.js'
import {parseClarifyList} from '../src/task/parsers.js'
import {isDeferralSuggestion, pickQuestion, planDecisiveHint} from '../src/task/plan-session.js'
import {stripInlineMarkdown} from '../src/task/inline-markdown.js'

/**
 * The paragraph the fix adds. Removing it from the shipped prompt reconstructs
 * the BASE arm, so the two arms differ by exactly this text and nothing else —
 * there is no second copy of the prompt to drift.
 */
const DECISIVE_RULE_HEAD = 'The SUGGESTED must DECIDE.'

function basePrompt(task: string, priorQA: string): string {
    const full = PLAN_QUESTION_PROMPT(task, priorQA)
    const at = full.indexOf(DECISIVE_RULE_HEAD)
    if (at < 0)
        throw new Error('BASE arm: the decisive-default paragraph is no longer in the prompt')
    const end = full.indexOf('\n\n', at)
    return (full.slice(0, at) + full.slice(end + 2)).replace(/\n{3,}/g, '\n\n')
}

/**
 * Requests whose answer lives only in the USER's head — the shape that provokes
 * a deferral, because there is nothing in the repo to read it off. A task the
 * repo already answers cannot exercise this at all.
 */
const TASKS = [
    'Lets plan new tab and report',
    'Add a dashboard page that shows how the extension is doing',
    'Add an export button somewhere sensible'
]

interface Draw {
    question: string
    suggested: string | undefined
    alt: string | undefined
    raw: string
}

/** NONE at Q2 is the model saying planning is finished — a legitimate outcome,
 *  and it must not be scored as a malformed reply. */
function isNone(raw: string): boolean {
    return /^\s*NONE\s*$/m.test(raw)
}

async function ask(cwd: string, prompt: string, signal: AbortSignal): Promise<Draw | null> {
    const res = await runChild({cwd, tools: 'read', prompt, signal, onToolCall: () => null})
    const q = pickQuestion(parseClarifyList(res.text))
    if (q === undefined)
        return isNone(res.text) ?
                {question: 'NONE', suggested: undefined, alt: undefined, raw: res.text}
            :   null
    return {
        question: stripInlineMarkdown(q.question),
        suggested: q.suggested === undefined ? undefined : stripInlineMarkdown(q.suggested),
        alt: q.alt === undefined ? undefined : stripInlineMarkdown(q.alt),
        raw: res.text
    }
}

/**
 * The transcript a SECOND question is generated against — the condition the live
 * failure actually occurred in, and the one a first-question-only harness cannot
 * reach (measured: 0/12 deferrals at Q1).
 *
 * The seed is drawn from the model itself and its own SUGGESTED accepted, which
 * is exactly what the loop records when the user presses enter — so the Q2 draw
 * sees the state /task-plan would really be in. Both arms share one seed, so the
 * comparison is paired.
 */
function seedTranscript(question: string, suggested: string): string {
    return `Q1: ${question}\nA1: ${suggested} (accepted recommendation)`
}

async function main() {
    const reps = parseInt(process.argv[2] ?? '4', 10)
    const cwd = process.argv[3] ?? process.cwd()
    const signal = new AbortController().signal

    let n = 0
    let baseDeferred = 0
    let baseUnparsed = 0
    let retryRecovered = 0
    let retryChangedSubject = 0
    let fixDeferred = 0
    let fixUnparsed = 0
    let baseNone = 0
    let fixNone = 0
    let noSeed = 0
    const log: string[] = []

    for (let r = 0; r < reps; r++) {
        for (const task of TASKS) {
            n++
            const seed = await ask(cwd, basePrompt(task, ''), signal)
            if (seed === null || seed.suggested === undefined) {
                noSeed++
                console.log(`rep ${r + 1} · ${task.slice(0, 34)} · no seed question — skipped`)
                continue
            }
            const prior = seedTranscript(seed.question, seed.suggested)
            console.log(
                `rep ${r + 1} · ${task.slice(0, 34)} · seed Q1: ${seed.question.slice(0, 70)}`
            )
            const base = await ask(cwd, basePrompt(task, prior), signal)
            if (base === null || base.suggested === undefined) {
                if (base?.question === 'NONE') baseNone++
                else baseUnparsed++
                console.log(
                    `            BASE ${base?.question === 'NONE' ? 'NONE (planning done)' : 'unparsed/no-SUGGESTED'}`
                )
            } else {
                const deferred = isDeferralSuggestion(base.suggested)
                if (deferred) baseDeferred++
                console.log(
                    `rep ${r + 1} · ${task.slice(0, 34)} · BASE ${deferred ? 'DEFER' : 'ok   '} · `
                        + base.suggested.slice(0, 90)
                )
                if (deferred) {
                    log.push(
                        `BASE-DEFER  ${base.question.slice(0, 80)} => ${base.suggested.slice(0, 110)}`
                    )
                    // The host lever: one re-prompt quoting the question back.
                    const retry = await ask(
                        cwd,
                        prependHint(
                            planDecisiveHint(base.question, base.suggested),
                            basePrompt(task, prior)
                        ),
                        signal
                    )
                    const stillDefers =
                        retry === null
                        || retry.suggested === undefined
                        || isDeferralSuggestion(retry.suggested)
                    if (!stillDefers) retryRecovered++
                    // The hint says "ask the SAME question" — a child that changes
                    // the subject has silently dropped the question the user was
                    // about to answer.
                    if (
                        retry !== null
                        && retry.question.slice(0, 24) !== base.question.slice(0, 24)
                    ) {
                        retryChangedSubject++
                    }
                    console.log(
                        `            RETRY ${stillDefers ? 'still-defers' : 'recovered'} · `
                            + (retry?.suggested ?? '(none)').slice(0, 90)
                    )
                }
            }

            const fix = await ask(cwd, PLAN_QUESTION_PROMPT(task, prior), signal)
            if (fix === null || fix.suggested === undefined) {
                if (fix?.question === 'NONE') fixNone++
                else fixUnparsed++
                console.log(
                    `            FIX  ${fix?.question === 'NONE' ? 'NONE (planning done)' : 'unparsed/no-SUGGESTED'}`
                )
                continue
            }
            const fixDefer = isDeferralSuggestion(fix.suggested)
            if (fixDefer) {
                fixDeferred++
                log.push(
                    `FIX-DEFER   ${fix.question.slice(0, 80)} => ${fix.suggested.slice(0, 110)}`
                )
            }
            console.log(
                `            FIX  ${fixDefer ? 'DEFER' : 'ok   '} · ${fix.suggested.slice(0, 90)}`
            )
        }
    }

    const pct = (x: number) => `${x}/${n} (${Math.round((100 * x) / n)}%)`
    console.log(`\n─── ${n} draws over ${TASKS.length} tasks, ${reps} rep(s) — SECOND question ───`)
    console.log(`BASE deferred   ${pct(baseDeferred)}   <- the base rate`)
    console.log(`BASE NONE       ${pct(baseNone)}   (planning declared finished)`)
    console.log(`BASE unparsed   ${pct(baseUnparsed)}`)
    console.log(`FIX  deferred   ${pct(fixDeferred)}   <- prompt half (belt)`)
    console.log(`FIX  NONE       ${pct(fixNone)}`)
    console.log(`FIX  unparsed   ${pct(fixUnparsed)}`)
    console.log(`no seed Q1      ${pct(noSeed)}`)
    console.log(
        `RETRY recovered ${retryRecovered}/${baseDeferred}   <- host half (lever), `
            + `${retryChangedSubject} changed the subject`
    )
    if (log.length > 0) {
        console.log(`\n─── deferrals seen ───`)
        for (const l of log) console.log(l)
    }
}

void main()
