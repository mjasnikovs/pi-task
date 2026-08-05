import {describe, expect, test} from 'bun:test'
import {
    buildIdleSpec,
    buildQuestionSpec,
    isNoneReply,
    MAX_PLAN_QUESTIONS,
    PLAN_ASK,
    PLAN_ASK_LABEL,
    PLAN_FORMAT_HINT,
    looksLikeFork,
    planForkHint,
    PLAN_PROCEED,
    PLAN_PROCEED_LABEL,
    pickQuestion,
    resolveAnswer,
    runPlanSession,
    type PlanAskSpec,
    type PlanSessionDeps
} from './plan-session.js'
import {MANUAL_CARD_LABEL} from './question-box.js'
import type {PlanEntry} from './plan-io.js'

// ─── Harness ─────────────────────────────────────────────────────────────────

interface Script {
    /** Replies the question child gives, in order. */
    questions: string[]
    /** What the user picks at each prompt, in order. undefined = dismiss. */
    picks: (string | undefined)[]
    /** Free text the user types when asked for their own question. */
    typed?: (string | undefined)[]
    /** Replies the answer child gives, in order. */
    answers?: string[]
    yolo?: boolean
}

interface Recorded {
    specs: PlanAskSpec[]
    priorQA: string[]
    hints: (string | null)[]
    shown: {question: string; answer: string}[]
    persisted: PlanEntry[][]
    askedPrompts: string[]
}

function harness(s: Script): {deps: PlanSessionDeps; rec: Recorded} {
    const rec: Recorded = {
        specs: [],
        priorQA: [],
        hints: [],
        shown: [],
        persisted: [],
        askedPrompts: []
    }
    let qi = 0
    let pi = 0
    let ti = 0
    let ai = 0
    const deps: PlanSessionDeps = {
        generateQuestion: (priorQA, hint) => {
            rec.priorQA.push(priorQA)
            rec.hints.push(hint)
            const out = s.questions[qi++]
            if (out === undefined) throw new Error('script ran out of questions')
            return Promise.resolve(out)
        },
        answerUserQuestion: (_priorQA, question) => {
            rec.askedPrompts.push(question)
            return Promise.resolve(s.answers?.[ai++] ?? 'because that is how it works')
        },
        ask: spec => {
            rec.specs.push(spec)
            if (pi >= s.picks.length) throw new Error('script ran out of picks')
            return Promise.resolve(s.picks[pi++])
        },
        promptText: () => Promise.resolve(s.typed?.[ti++]),
        showAnswer: (question, answer) => {
            rec.shown.push({question, answer})
        },
        onEntries: entries => {
            rec.persisted.push(entries.map(e => ({...e})))
        },
        ...(s.yolo !== undefined && {yolo: s.yolo})
    }
    return {deps, rec}
}

const Q1 =
    '1. **Global or per-provider?** This forks the whole shape.\nSUGGESTED: per-provider\nALT: one global bucket'
const Q2 = '1. **Cap the retries?** This bounds the worst case.\nSUGGESTED: cap at 3'
const NONE = 'NONE'
// The question the loop records is the WHOLE line — bold decision plus its
// one-line rationale — with the markdown stripped, exactly as grill/clarify do.
const Q1_TEXT = 'Global or per-provider? This forks the whole shape.'
const Q2_TEXT = 'Cap the retries? This bounds the worst case.'

// ─── Spec building ───────────────────────────────────────────────────────────

describe('the three moves are on every prompt', () => {
    test('a model question offers its answers, then ask + proceed, then free text', () => {
        const spec = buildQuestionSpec({
            plain: Q1_TEXT,
            shown: Q1_TEXT,
            suggested: 'per-provider',
            alt: 'one global bucket'
        })
        expect(spec.options.map(o => o.value)).toEqual([
            'per-provider',
            'one global bucket',
            PLAN_ASK,
            PLAN_PROCEED
        ])
        // The free-text card is askQuestionBox's own — it is not re-implemented
        // here, only re-labelled and slotted in above the trailing proceed card.
        expect(spec.manualLabel).not.toBe(MANUAL_CARD_LABEL)
        expect(spec.manualLabel).toContain('own words')
        expect(spec.manualPosition).toBe(spec.options.length - 1)
        expect(spec.options[spec.options.length - 1]?.value).toBe(PLAN_PROCEED)
        // The remote card gets the same two actions as buttons.
        expect(spec.actions.map(a => a.value)).toEqual([PLAN_ASK, PLAN_PROCEED])
        // …and the recommendation still rides the existing remote fields.
        expect(spec.recommended).toBe('per-provider')
        expect(spec.recommended2).toBe('one global bucket')
    })

    test('an open question has one recommendation and still both actions', () => {
        const spec = buildQuestionSpec({plain: 'q', shown: 'q', suggested: 'do X'})
        expect(spec.options.map(o => o.value)).toEqual(['do X', PLAN_ASK, PLAN_PROCEED])
        expect(spec.recommended2).toBeUndefined()
    })

    test('with no question at all, proceed stays last and the free-text card restates', () => {
        const spec = buildIdleSpec()
        expect(spec.options.map(o => o.label)).toEqual([PLAN_ASK_LABEL, PLAN_PROCEED_LABEL])
        expect(spec.manualLabel).toContain('decision of your own')
        // …with the free-text card between them, so proceed is the last card.
        expect(spec.manualPosition).toBe(1)
        // No `recommended`: on the remote that field is the accept button, and
        // "proceed" is an action, not an answer to a question.
        expect(spec.recommended).toBeUndefined()
    })
})

// ─── Answer mapping ──────────────────────────────────────────────────────────

describe('resolveAnswer mirrors the grill/clarify mapping', () => {
    const p = {plain: 'q', shown: 'q', suggested: 'A-text', alt: 'B-text'}
    test('empty submit accepts the recommendation', () => {
        expect(resolveAnswer(p, '')).toEqual({answer: 'A-text', source: 'accepted'})
    })
    test('a bare letter maps back to the full option text', () => {
        expect(resolveAnswer(p, 'b')).toEqual({answer: 'B-text', source: 'chosen'})
        expect(resolveAnswer(p, 'A.')).toEqual({answer: 'A-text', source: 'chosen'})
    })
    test('the picker returning an option value is recorded as chosen', () => {
        expect(resolveAnswer(p, 'B-text')).toEqual({answer: 'B-text', source: 'chosen'})
    })
    test('free text is taken verbatim', () => {
        expect(resolveAnswer(p, 'neither — use a semaphore')).toEqual({
            answer: 'neither — use a semaphore',
            source: 'typed'
        })
    })
    test('an empty submit with no recommendation is an explicit skip', () => {
        expect(resolveAnswer({plain: 'q', shown: 'q'}, '  ')).toEqual({
            answer: '(skipped)',
            source: 'skipped'
        })
    })
})

// ─── The loop ────────────────────────────────────────────────────────────────

describe('runPlanSession', () => {
    test('answers feed forward into the next question', async () => {
        const {deps, rec} = harness({
            questions: [Q1, Q2, NONE],
            picks: ['per-provider', '', PLAN_PROCEED]
        })
        const out = await runPlanSession(deps)
        expect(out.kind).toBe('proceed')
        expect(rec.priorQA[0]).toBe('')
        expect(rec.priorQA[1]).toContain('Q1: Global or per-provider?')
        expect(rec.priorQA[1]).toContain('A1: per-provider')
    })

    test('proceeding hands back exactly what was decided', async () => {
        const {deps} = harness({questions: [Q1, NONE], picks: ['per-provider', PLAN_PROCEED]})
        const out = await runPlanSession(deps)
        expect(out.kind).toBe('proceed')
        expect(out.entries).toEqual([
            {
                kind: 'decision',
                question: Q1_TEXT,
                answer: 'per-provider',
                source: 'chosen'
            }
        ])
    })

    test('proceed is available at the FIRST question, before anything is decided', async () => {
        const {deps} = harness({questions: [Q1], picks: [PLAN_PROCEED]})
        const out = await runPlanSession(deps)
        expect(out).toEqual({kind: 'proceed', entries: []})
    })

    test('dismissing the picker cancels and keeps what was decided so far', async () => {
        const {deps} = harness({questions: [Q1, Q2], picks: ['per-provider', undefined]})
        const out = await runPlanSession(deps)
        expect(out.kind).toBe('cancelled')
        expect(out.entries).toHaveLength(1)
    })

    test('asking the model records a note, shows it, and re-shows the SAME question', async () => {
        const {deps, rec} = harness({
            questions: [Q1],
            picks: [PLAN_ASK, PLAN_PROCEED],
            typed: ['which providers exist?'],
            answers: ['exa, ddg and brave']
        })
        const out = await runPlanSession(deps)
        expect(rec.askedPrompts).toEqual(['which providers exist?'])
        expect(rec.shown).toEqual([
            {question: 'which providers exist?', answer: 'exa, ddg and brave'}
        ])
        // Only ONE question was generated — asking must not burn a new one.
        expect(rec.priorQA).toHaveLength(1)
        // …and the same question came back up.
        expect(rec.specs[0].question).toBe(Q1_TEXT)
        expect(rec.specs[1].question).toBe(Q1_TEXT)
        expect(out.entries[0]).toEqual({
            kind: 'note',
            question: 'which providers exist?',
            answer: 'exa, ddg and brave'
        })
    })

    test('the note rides into the next question as context', async () => {
        const {deps, rec} = harness({
            questions: [Q1, Q2],
            picks: [PLAN_ASK, 'per-provider', PLAN_PROCEED],
            typed: ['which providers exist?'],
            answers: ['exa, ddg and brave']
        })
        await runPlanSession(deps)
        expect(rec.priorQA[1]).toContain('THE USER ASKED: which providers exist?')
        expect(rec.priorQA[1]).toContain('YOU ANSWERED: exa, ddg and brave')
    })

    test('backing out of the ask dialog leaves the question untouched', async () => {
        const {deps, rec} = harness({
            questions: [Q1],
            picks: [PLAN_ASK, PLAN_PROCEED],
            typed: [undefined]
        })
        const out = await runPlanSession(deps)
        expect(rec.askedPrompts).toHaveLength(0)
        expect(out.entries).toHaveLength(0)
    })

    test('a failing answer child is reported in place of the answer, not thrown', async () => {
        const {deps, rec} = harness({
            questions: [Q1],
            picks: [PLAN_ASK, PLAN_PROCEED],
            typed: ['why?']
        })
        deps.answerUserQuestion = () => Promise.reject(new Error('model error — socket hang up'))
        const out = await runPlanSession(deps)
        expect(out.kind).toBe('proceed')
        expect(rec.shown[0].answer).toContain('could not answer')
        expect(rec.shown[0].answer).toContain('socket hang up')
    })

    test('free text with no question on screen becomes a stated decision', async () => {
        const {deps} = harness({
            questions: [NONE, NONE],
            picks: ['never touch brave', PLAN_PROCEED]
        })
        const out = await runPlanSession(deps)
        expect(out.entries[0]).toEqual({kind: 'stated', text: 'never touch brave'})
    })

    test('an empty submit with no question on screen records nothing', async () => {
        const {deps} = harness({questions: [NONE], picks: ['   ', PLAN_PROCEED]})
        const out = await runPlanSession(deps)
        expect(out.entries).toHaveLength(0)
    })

    test('NONE shows the idle prompt instead of proceeding on its own', async () => {
        const {deps, rec} = harness({questions: [NONE], picks: [PLAN_PROCEED]})
        await runPlanSession(deps)
        expect(rec.specs).toHaveLength(1)
        expect(rec.specs[0].question).toContain('No further questions')
    })

    test('new user input re-opens a model that had run out of questions', async () => {
        const {deps, rec} = harness({
            questions: [NONE, Q2, NONE],
            picks: ['also keep the CLI flag', 'cap at 3', PLAN_PROCEED]
        })
        await runPlanSession(deps)
        // NONE → stated decision → the generator is consulted again.
        expect(rec.priorQA).toHaveLength(3)
        expect(rec.priorQA[1]).toContain('DECIDED BY USER: also keep the CLI flag')
    })

    test('a near-duplicate question is re-prompted, never shown', async () => {
        const dup = '1. **Should it be global or per-provider?** again\nSUGGESTED: per-provider'
        const {deps, rec} = harness({
            questions: [Q1, dup, Q2, NONE],
            picks: ['per-provider', 'cap at 3', PLAN_PROCEED]
        })
        await runPlanSession(deps)
        expect(rec.hints[2]).toContain('ALREADY answered')
        expect(rec.specs.map(s => s.question)).toEqual([
            Q1_TEXT,
            Q2_TEXT,
            'No further questions — the decisions so far settle how this task is built.'
        ])
    })

    test('unparseable output is re-prompted once, not read as "no questions left"', async () => {
        const {deps, rec} = harness({
            questions: ['Sure! Here are my thoughts on the matter.', Q2, NONE],
            picks: ['cap at 3', PLAN_PROCEED]
        })
        await runPlanSession(deps)
        expect(rec.hints[1]).toBe(PLAN_FORMAT_HINT)
        expect(rec.specs[0].question).toBe(Q2_TEXT)
    })

    test('a question with no SUGGESTED is re-prompted once, then shown anyway', async () => {
        const bare = '1. **Which providers?** no default here'
        const bareText = 'Which providers? no default here'
        const {deps, rec} = harness({questions: [bare, bare], picks: [PLAN_PROCEED]})
        await runPlanSession(deps)
        expect(rec.hints).toEqual([null, PLAN_FORMAT_HINT])
        expect(rec.specs[0].question).toBe(bareText)
        expect(rec.specs[0].recommended).toBeUndefined()
        // Even with nothing to recommend, both actions are still offered.
        expect(rec.specs[0].options.map(o => o.value)).toEqual([PLAN_ASK, PLAN_PROCEED])
    })

    test('the format re-prompt is one-shot: a second bad reply ends the questions', async () => {
        const {deps, rec} = harness({questions: ['prose', 'more prose'], picks: [PLAN_PROCEED]})
        await runPlanSession(deps)
        expect(rec.priorQA).toHaveLength(2)
        expect(rec.specs[0].question).toContain('No further questions')
    })

    test('the question cap bounds a model that never says NONE', async () => {
        // Deliberately share no vocabulary: a model that never says NONE must be
        // stopped by the CAP here, not by the near-duplicate backstop, which
        // suppresses questions that overlap too much.
        const many = [
            '1. **Retry budget?** alpha\nSUGGESTED: three',
            '1. **Log encoding?** bravo\nSUGGESTED: utf8',
            '1. **Timeout units?** charlie\nSUGGESTED: milliseconds',
            '1. **Config filename?** delta\nSUGGESTED: dotfile',
            '1. **Error surfacing?** echo\nSUGGESTED: toast',
            '1. **Concurrency limit?** foxtrot\nSUGGESTED: four',
            '1. **Cache eviction?** golf\nSUGGESTED: lru',
            '1. **Flag naming?** hotel\nSUGGESTED: kebab',
            '1. **Metrics sink?** india\nSUGGESTED: stdout',
            '1. **Shutdown ordering?** juliet\nSUGGESTED: reverse'
        ]
        const {deps, rec} = harness({
            questions: many,
            picks: [...Array.from({length: MAX_PLAN_QUESTIONS}, () => ''), PLAN_PROCEED]
        })
        const out = await runPlanSession(deps)
        expect(rec.priorQA).toHaveLength(MAX_PLAN_QUESTIONS)
        expect(out.entries).toHaveLength(MAX_PLAN_QUESTIONS)
        expect(rec.specs[MAX_PLAN_QUESTIONS].question).toContain('No further questions')
    })

    test('every transcript change is handed to the persister', async () => {
        const {deps, rec} = harness({
            questions: [Q1, Q2, NONE],
            picks: ['per-provider', 'cap at 3', PLAN_PROCEED]
        })
        await runPlanSession(deps)
        expect(rec.persisted.map(p => p.length)).toEqual([1, 2])
    })

    test('YOLO takes the recommendation and proceeds with no prompt at all', async () => {
        const {deps, rec} = harness({questions: [Q1, Q2, NONE], picks: [], yolo: true})
        const out = await runPlanSession(deps)
        expect(rec.specs).toHaveLength(0)
        expect(out.kind).toBe('proceed')
        expect(out.entries).toEqual([
            {
                kind: 'decision',
                question: Q1_TEXT,
                answer: 'per-provider',
                source: 'yolo'
            },
            {kind: 'decision', question: Q2_TEXT, answer: 'cap at 3', source: 'yolo'}
        ])
    })
})

describe('isNoneReply', () => {
    test('tells a deliberate NONE from output the parser simply could not read', () => {
        expect(isNoneReply('NONE')).toBe(true)
        expect(isNoneReply('some text\nNONE\n')).toBe(true)
        expect(isNoneReply('Here are my thoughts')).toBe(false)
        expect(isNoneReply('NONE of these apply, so:')).toBe(false)
    })
})

describe('the missing-ALT recovery', () => {
    const forkNoAlt =
        '1. **Should the limit be per-provider or global?** rationale\nSUGGESTED: per-provider'
    const forkWithAlt = forkNoAlt + '\nALT: one global bucket'

    test('a fork-shaped question with one option is re-prompted once, quoting itself', async () => {
        const {deps, rec} = harness({
            questions: [forkNoAlt, forkWithAlt, NONE],
            picks: ['per-provider', PLAN_PROCEED]
        })
        await runPlanSession(deps)
        expect(rec.hints[1]).toContain('offers the user a choice')
        expect(rec.hints[1]).toContain('Should the limit be per-provider or global?')
        // The user sees the recovered question, with both cards.
        expect(rec.specs[0].recommended).toBe('per-provider')
        expect(rec.specs[0].recommended2).toBe('one global bucket')
    })

    test('it is one-shot: a second reply without ALT is shown as-is', async () => {
        const {deps, rec} = harness({
            questions: [forkNoAlt, forkNoAlt, NONE],
            picks: ['per-provider', PLAN_PROCEED]
        })
        await runPlanSession(deps)
        expect(rec.priorQA).toHaveLength(3)
        expect(rec.specs[0].recommended2).toBeUndefined()
        expect(rec.specs[0].options.map(o => o.value)).toEqual([
            'per-provider',
            PLAN_ASK,
            PLAN_PROCEED
        ])
    })

    test('a question that already carries an ALT never pays for a retry', async () => {
        const {deps, rec} = harness({
            questions: [forkWithAlt, NONE],
            picks: ['per-provider', PLAN_PROCEED]
        })
        await runPlanSession(deps)
        expect(rec.hints).toEqual([null, null])
    })

    test('an open question with one option is left alone', async () => {
        const open = '1. **What should the default limit be?** rationale\nSUGGESTED: 20 per run'
        const {deps, rec} = harness({questions: [open, NONE], picks: ['20 per run', PLAN_PROCEED]})
        await runPlanSession(deps)
        expect(rec.hints).toEqual([null, null])
    })
})

describe('looksLikeFork', () => {
    test('fires on a two-option question and not on an open one', () => {
        expect(looksLikeFork('Should it be per-provider or global?')).toBe(true)
        expect(looksLikeFork('What should the default limit be?')).toBe(false)
        // "or" AFTER the question mark is rationale, not a choice.
        expect(looksLikeFork('What is the default? Pick 20 or 50 later.')).toBe(false)
    })
})

describe('planForkHint', () => {
    test('quotes the question back, because the child is stateless', () => {
        expect(planForkHint('A or B?')).toContain('"A or B?"')
    })
})

describe('pickQuestion', () => {
    // The live failure: the model wrote a numbered observation about a file
    // first, and the SUGGESTED line belonged to the question further down.
    test('prefers the entry that carries the SUGGESTED line', () => {
        const parsed = [
            {question: 'gateDebugWriter wraps a raw append function'},
            {question: 'Should the writer own the JSON shape?', suggested: 'yes'}
        ]
        expect(pickQuestion(parsed)).toBe(parsed[1])
    })

    test('falls back to the first entry when nothing carries one', () => {
        const parsed: {question: string; suggested?: string}[] = [{question: 'a'}, {question: 'b'}]
        expect(pickQuestion(parsed)).toBe(parsed[0])
    })

    test('is undefined for an empty list', () => {
        expect(pickQuestion<{suggested?: string}>([])).toBeUndefined()
    })
})

test('a duplicate is discarded before it can buy a polish re-prompt', async () => {
    // The re-asked question is fork-shaped with no ALT — the case that would
    // otherwise fire the fork retry and spend a child call on a question the
    // dedup backstop is about to throw away.
    const dupFork =
        '1. **Should it be global or per-provider again?** rationale\nSUGGESTED: per-provider'
    const Q1_LOCAL =
        '1. **Global or per-provider?** This forks the whole shape.\nSUGGESTED: per-provider\nALT: one global bucket'
    const Q2_LOCAL = '1. **Cap the retries?** This bounds the worst case.\nSUGGESTED: cap at 3'
    const {deps, rec} = harness({
        questions: [Q1_LOCAL, dupFork, Q2_LOCAL, 'NONE'],
        picks: ['per-provider', 'cap at 3', PLAN_PROCEED]
    })
    await runPlanSession(deps)
    expect(rec.hints[2]).toContain('ALREADY answered')
    expect(rec.hints[2]).not.toContain('offers the user a choice')
})
