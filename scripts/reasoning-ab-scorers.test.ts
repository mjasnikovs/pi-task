/**
 * The quality axis, tested without a GPU.
 *
 * Every case here is a REGRESSION of a scorer that was live and wrong. Three of
 * the five groups shipped a scorer that marked a perfectly compliant answer
 * UNUSABLE or marked prose USABLE, and 28 measured trials were thrown away
 * because of it. Inspection is what passed those scorers; this file is what
 * inspection was not.
 *
 * It imports the SCORERS module, never the harness: live-reasoning-group-ab.ts
 * ends in a top-level `await main()`, so importing it here would launch a real
 * multi-hour run from `bun test`.
 */
import {describe, expect, test} from 'bun:test'
import {
    GROUP_SCORERS,
    emittedVerdict,
    verdictWord,
    gateVerdictCorrect,
    verdictParserContractProblem
} from './reasoning-ab-scorers.js'

/** A refine answer that obeys REFINE_PROMPT exactly. */
const COMPLIANT_REFINE =
    'GOAL\nAdd a health endpoint.\n\n'
    + 'CONSTRAINTS\n- do not touch the router\n\n'
    + 'KNOWN-UNKNOWNS\n- which port\n\n'
    + 'EXTERNAL-DEPENDENCIES\n'

/** A FILES answer that obeys RESEARCH_FILES_PROMPT exactly: no bullets. */
const COMPLIANT_FILES =
    'src/server.ts:41  where the routes are mounted\n'
    + 'src/config/config.ts  the port default\n'
    + 'package.json  the start script'

describe('phase scorer — refine', () => {
    test('THE BUG: a compliant answer has no VERIFY, and still scores usable', () => {
        // The old scorer required GOAL && CONSTRAINTS && VERIFY as substrings.
        // REFINE_PROMPT forbids VERIFY. This exact answer scored UNUSABLE and
        // voided 28 trials.
        expect(COMPLIANT_REFINE).not.toContain('VERIFY')
        expect(GROUP_SCORERS.phase!(COMPLIANT_REFINE)).toBe(true)
    })

    test('a dropped section is unusable', () => {
        expect(GROUP_SCORERS.phase!(COMPLIANT_REFINE.replace('KNOWN-UNKNOWNS\n- which port', '')))
            .toBe(false)
    })

    test('the heading words in prose do not count — the consumers need them bare', () => {
        expect(GROUP_SCORERS.phase!('I considered the GOAL, CONSTRAINTS, KNOWN-UNKNOWNS and'
            + ' EXTERNAL-DEPENDENCIES of this task at length.')).toBe(false)
    })

    test('an empty answer is unusable', () => {
        expect(GROUP_SCORERS.phase!('')).toBe(false)
    })
})

describe('research scorer — worker:files', () => {
    test('THE BUG: FILES entries carry no bullet, and still score usable', () => {
        // The old scorer required a line matching /^\s*[-*]\s/.
        expect(COMPLIANT_FILES.split('\n').filter(l => /^\s*[-*]\s/.test(l))).toHaveLength(0)
        expect(GROUP_SCORERS.research!(COMPLIANT_FILES)).toBe(true)
    })

    test('a preamble sentence alone is not an answer', () => {
        expect(
            GROUP_SCORERS.research!(
                'Now let me get more details on the specific APIs and components I need:'
            )
        ).toBe(false)
    })

    test('an empty answer is unusable', () => {
        expect(GROUP_SCORERS.research!('')).toBe(false)
    })
})

describe('gate scorer — verify', () => {
    test('THE BUG: the bare word FAIL in prose is not a verdict', () => {
        // The old scorer was /\b(PASS|FAIL)\b/, which this sentence satisfies.
        const prose = 'I could not determine whether these tests FAIL on the current tree.'
        expect(/\b(PASS|FAIL)\b/.test(prose)).toBe(true)
        expect(GROUP_SCORERS.gate!(prose)).toBe(false)
    })

    test('all three production markers count as a verdict', () => {
        expect(GROUP_SCORERS.gate!('WORK-VERIFIED: PASS')).toBe(true)
        expect(GROUP_SCORERS.gate!('WORK-VERIFIED: FAIL the endpoint 404s')).toBe(true)
        expect(GROUP_SCORERS.gate!('WORK-VERIFIED: UNOBSERVED no browser here')).toBe(true)
    })

    test('the LAST marker wins, as production reads it', () => {
        expect(verdictWord('WORK-VERIFIED: PASS\n…\nWORK-VERIFIED: FAIL nope')).toBe('FAIL')
    })

    test('silence is not a verdict', () => {
        expect(emittedVerdict('the tree looks fine to me')).toBe(false)
        expect(verdictWord('the tree looks fine to me')).toBe('NONE')
    })

    test('the parser contract the scorer depends on still holds', () => {
        expect(verdictParserContractProblem()).toBeNull()
    })
})

describe('planning scorer — auto-decompose', () => {
    test('a real plan is usable', () => {
        expect(GROUP_SCORERS.planning!('1. Scaffold the server\n2. Add the health route')).toBe(
            true
        )
    })

    test('a one-title list is what a thrashing child emits, and is not a plan', () => {
        expect(GROUP_SCORERS.planning!('1. Do the whole thing')).toBe(false)
    })
})

describe('extraction scorer', () => {
    test('a failed extraction stores no answer and is unusable', () => {
        expect(GROUP_SCORERS.extraction!('')).toBe(false)
        expect(GROUP_SCORERS.extraction!('   \n ')).toBe(false)
    })

    test('an answer is usable — production gates on non-empty, not on the excerpt', () => {
        expect(GROUP_SCORERS.extraction!('src/server.ts and src/config/config.ts')).toBe(true)
    })
})

describe('coverage', () => {
    test('every group this harness measures has a scorer', () => {
        // `implementation` is scored by EXECUTING a VERIFY block, and `plan`
        // never ran in the corpus — both are absent on purpose.
        expect(Object.keys(GROUP_SCORERS).sort()).toEqual([
            'extraction',
            'gate',
            'phase',
            'planning',
            'research'
        ])
    })
})

describe('gateVerdictCorrect — the gate quality axis', () => {
    const PASS = 'WORK-VERIFIED: PASS'
    const FAIL = 'WORK-VERIFIED: FAIL the migration never runs'

    test('the right verdict on each tree scores, the wrong one does not', () => {
        expect(gateVerdictCorrect(PASS, 'PASS')).toBe(true)
        expect(gateVerdictCorrect(FAIL, 'FAIL')).toBe(true)
        expect(gateVerdictCorrect(PASS, 'FAIL')).toBe(false)
        expect(gateVerdictCorrect(FAIL, 'PASS')).toBe(false)
    })

    test('UNOBSERVED is wrong on a screened tree, not a free pass', () => {
        // The harness EXECUTED this task's VERIFY in this exact tree moments
        // before handing it over, so the evidence is present and runnable.
        // Declining to reach a verdict is a failure to do the job.
        expect(gateVerdictCorrect('WORK-VERIFIED: UNOBSERVED no browser', 'PASS')).toBe(false)
        expect(gateVerdictCorrect('WORK-VERIFIED: UNOBSERVED no browser', 'FAIL')).toBe(false)
    })

    test('silence is wrong on both trees', () => {
        expect(gateVerdictCorrect('I looked around a bit.', 'PASS')).toBe(false)
        expect(gateVerdictCorrect('I looked around a bit.', 'FAIL')).toBe(false)
    })

    test('the word PASS in prose does not score — the marker is required', () => {
        // The scorer this replaced matched /\b(PASS|FAIL)\b/ anywhere, which is
        // how it reached 37/40 and became unable to separate anything.
        expect(gateVerdictCorrect('Every check I ran seems to PASS.', 'PASS')).toBe(false)
    })

    test('BOTH degenerate strategies score exactly 50% on balanced stimuli', () => {
        // This is the property the axis exists for. always-PASS and always-FAIL
        // are each worth a coin flip, so neither the ceiling nor the floor is
        // reachable without actually reading the tree.
        const truths = ['PASS', 'FAIL', 'PASS', 'FAIL', 'PASS', 'FAIL']
        const scoreAll = (answer: string): number =>
            truths.filter(t => gateVerdictCorrect(answer, t)).length
        expect(scoreAll(PASS)).toBe(3)
        expect(scoreAll(FAIL)).toBe(3)
        expect(scoreAll('nothing at all')).toBe(0)
    })

    test('the OLD axis scores all five of those the same — which is the bug', () => {
        // emittedVerdict is correct and saturated: it cannot tell a right answer
        // from a wrong one, which is why gate came back 10/10 in both arms.
        expect(emittedVerdict(PASS)).toBe(true)
        expect(emittedVerdict(FAIL)).toBe(true)
        expect(emittedVerdict('WORK-VERIFIED: UNOBSERVED no browser')).toBe(true)
    })
})
