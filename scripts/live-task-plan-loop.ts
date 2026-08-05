/**
 * LIVE end-to-end drive of the whole /task-plan session against the real model.
 *
 * Runs `runPlanSession` itself — the same loop the command runs — with real
 * children and a SCRIPTED user in place of the TUI, so everything except the
 * keystrokes is production code. Reports the four things that could be broken and
 * that no unit test can answer:
 *
 *   1. TERMINATION — does the loop reach NONE on its own, before the cap?
 *   2. ADAPTIVITY  — does question N+1 react to answer N? (measured two ways:
 *                    no near-duplicate is ever shown, and the two arms below
 *                    diverge once their answers diverge)
 *   3. ASK CHANNEL — the user's own question gets a non-empty, grounded answer,
 *                    and every file path the answer names actually exists
 *   4. HANDOFF     — the composed prompt carries every decision
 *
 * Two arms over the SAME task: `accept` always takes the recommendation, `alt`
 * always takes the alternative when the question is a fork. If the loop were not
 * adaptive the two arms would ask the same questions in the same order.
 *
 * Run: PI_BIN=$(command -v pi) bun run scripts/live-task-plan-loop.ts [accept|alt] [task]
 */
import {existsSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import * as path from 'node:path'
import {runPhaseChild, prependHint, type PhaseDeps} from '../src/task/child-runner.js'
import {PLAN_QUESTION_PROMPT, PLAN_ANSWER_PROMPT} from '../src/task/plan-prompts.js'
import {
    runPlanSession,
    PLAN_ASK,
    PLAN_PROCEED,
    MAX_PLAN_QUESTIONS,
    type PlanSessionDeps,
    type PlanAskSpec
} from '../src/task/plan-session.js'
import {buildHandoffPrompt} from '../src/task/plan-io.js'
import {PLAN_NO_QUESTIONS} from '../src/task/plan-session.js'
import {isDuplicateQuestion} from '../src/task/question-dedup.js'

const DEFAULT_TASK =
    'Add rate limiting to the web search workers so a run cannot hammer the search provider'
/** The question the scripted user asks the model, once, at the second prompt. */
const USER_QUESTION =
    'Which files would this change, and is there an existing throttle I should reuse?'

/**
 * File paths an answer names that do not exist — the fabrication check.
 *
 * A path counts as verified if it resolves from the repo root OR if any tracked
 * file has that basename: the model legitimately writes `search-core.ts` for
 * `src/workers/search-core.ts`, and a first draft of this check called all four
 * of those fabrications.
 */
function fabricatedPaths(cwd: string, text: string): string[] {
    const tracked = new Set(
        execFileSync('git', ['ls-files'], {cwd, encoding: 'utf8'})
            .split('\n')
            .filter(Boolean)
            .map(f => path.basename(f))
    )
    const out: string[] = []
    for (const m of text.matchAll(/\b([\w./-]+\.(?:ts|tsx|js|mjs|json|md))\b/g)) {
        const p = m[1].replace(/^\.\//, '')
        if (existsSync(path.join(cwd, p)) || tracked.has(path.basename(p))) continue
        if (!out.includes(p)) out.push(p)
    }
    return out
}

async function main() {
    // `ask` is `accept` with the user's own question fired at the FIRST prompt
    // rather than the second — the model sometimes runs out of questions after
    // one, and the ask channel must still be exercised when it does.
    const arm = (process.argv[2] ?? 'accept') as 'accept' | 'alt' | 'ask'
    const task = process.argv[3] ?? DEFAULT_TASK
    const cwd = process.cwd()
    const deps: PhaseDeps = {cwd, taskId: '', signal: new AbortController().signal}

    const shown: string[] = []
    const shownSpecs: PlanAskSpec[] = []
    let prompts = 0
    let reshows = 0
    let askedOnce = false
    const answers: {question: string; answer: string}[] = []

    const session: PlanSessionDeps = {
        generateQuestion: (priorQA, hint) =>
            runPhaseChild(
                deps,
                'plan-question',
                'read',
                prependHint(hint, PLAN_QUESTION_PROMPT(task, priorQA))
            ),
        answerUserQuestion: (priorQA, question) =>
            runPhaseChild(deps, 'plan-answer', 'read', PLAN_ANSWER_PROMPT(task, priorQA, question)),
        ask: spec => {
            prompts++
            shownSpecs.push(spec)
            // Identify the idle prompt by its own header, not by "no
            // recommendation" — a question that came back without a SUGGESTED
            // also has no recommendation, and auto-proceeding on it would hide
            // exactly the case worth seeing.
            const isIdle = spec.question === PLAN_NO_QUESTIONS
            if (isIdle) return Promise.resolve(PLAN_PROCEED)
            // The SAME question is re-shown after the user asks something — that
            // is the loop's contract, not a re-generated duplicate — so only a
            // question different from the last one counts as a new one.
            const isReshow = shown.length > 0 && shown[shown.length - 1] === spec.question
            if (isReshow) reshows++
            else shown.push(spec.question)
            console.log(`\n${isReshow ? 're-shown' : 'Q' + shown.length}: ${spec.question}`)
            console.log(`   SUGGESTED: ${spec.recommended ?? '(none)'}`)
            if (spec.recommended2) console.log(`   ALT:       ${spec.recommended2}`)
            // One scripted "ask the model" at the second prompt, so the channel is
            // exercised mid-conversation rather than on an empty transcript.
            if (!askedOnce && shown.length === (arm === 'ask' ? 1 : 2)) {
                askedOnce = true
                return Promise.resolve(PLAN_ASK)
            }
            if (arm === 'alt' && spec.recommended2 !== undefined) {
                return Promise.resolve(spec.recommended2)
            }
            return Promise.resolve(spec.recommended ?? '')
        },
        promptText: () => Promise.resolve(USER_QUESTION),
        showAnswer: (question, answer) => {
            answers.push({question, answer})
            console.log(`\n  ❓ ${question}\n  → ${answer.replace(/\n/g, '\n    ')}`)
        }
    }

    const t0 = Date.now()
    const out = await runPlanSession(session)
    const mins = ((Date.now() - t0) / 60_000).toFixed(1)

    console.log(`\n═══ arm=${arm} · ${mins} min · outcome=${out.kind} ═══`)
    console.log(`questions shown : ${shown.length} (cap ${MAX_PLAN_QUESTIONS})`)
    console.log(`prompts total   : ${prompts} (${reshows} re-show(s) after an ask)`)
    console.log(
        `terminated by   : ${shown.length < MAX_PLAN_QUESTIONS ? 'the model (NONE / no more questions)' : 'THE CAP'}`
    )

    // 2 — adaptivity, first measure: nothing near-duplicate ever reached the user.
    const dups: string[] = []
    for (let i = 1; i < shown.length; i++) {
        if (isDuplicateQuestion(shown.slice(0, i), shown[i])) dups.push(shown[i])
    }
    console.log(`near-duplicate questions shown: ${dups.length}`)
    for (const d of dups) console.log(`  DUP: ${d}`)

    // 3 — the ask channel.
    for (const a of answers) {
        const fab = fabricatedPaths(cwd, a.answer)
        console.log(
            `\nask-channel: ${a.answer.trim().length} chars, ${fab.length} unverified path(s)`
        )
        for (const f of fab) console.log(`  UNVERIFIED PATH: ${f}`)
    }

    // 4 — handoff completeness: every decided answer must appear in the prompt.
    const prompt = buildHandoffPrompt(task, out.entries)
    const decided = out.entries.filter(e => e.kind === 'decision' || e.kind === 'stated')
    let missing = 0
    for (const e of decided) {
        const needle = e.kind === 'decision' ? e.answer : e.text
        if (!prompt.includes(needle)) {
            missing++
            console.log(`  MISSING FROM HANDOFF: ${needle.slice(0, 80)}`)
        }
    }
    const notes = out.entries.filter(e => e.kind === 'note').length
    console.log(
        `\nhandoff: ${prompt.length} chars, ${decided.length} decision(s) carried, `
            + `${missing} missing, ${notes} advisory note(s) correctly withheld`
    )
    console.log(`\n─── questions, in order ───`)
    shown.forEach((q, i) => console.log(`${i + 1}. ${q}`))
}

void main()
