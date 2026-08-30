import {describe, test, expect} from 'bun:test'
import {
    MAX_REQUIREMENTS_PER_TASK,
    MIN_REQUIREMENTS_FOR_PLAN_SHAPE,
    PLAN_SHAPE_ANSWER,
    granularityFloor,
    granularitySplitHint,
    isPlanShapeQuestion,
    isTooCoarse
} from '../../src/task/decompose-granularity.js'

describe('granularityFloor', () => {
    test('no requirement signal disables the whole channel', () => {
        expect(granularityFloor(0)).toBe(0)
        expect(granularityFloor(-3)).toBe(0)
        expect(isTooCoarse(1, granularityFloor(0))).toBe(false)
    })

    test('rounds UP — a leftover requirement still needs a task to own it', () => {
        expect(granularityFloor(5)).toBe(3)
        expect(granularityFloor(7)).toBe(4)
        expect(granularityFloor(9)).toBe(5)
    })

    test('no floor below MIN_REQUIREMENTS_FOR_PLAN_SHAPE — the count is extraction noise there', () => {
        // Same cut, same reason, as the plan-shape fork: under a handful of
        // requirements the plan is one or two tasks either way, so the count
        // reflects how finely the extractor sliced the prose, not real breadth.
        for (let ownable = 1; ownable < MIN_REQUIREMENTS_FOR_PLAN_SHAPE; ownable++) {
            expect(granularityFloor(ownable)).toBe(0)
        }
        expect(granularityFloor(MIN_REQUIREMENTS_FOR_PLAN_SHAPE)).toBeGreaterThan(0)
    })

    test('the XS regression: a one-line feature is never called too coarse', () => {
        // Why the cut exists. "Add a `--version` flag to the CLI that prints the
        // package version and exits 0" extracts THREE ownable requirements — the
        // flag, the print, the exit code — for what is unambiguously ONE task.
        // An ungated ceil(n/2) would demand two, so a chore this size would pay
        // for a split-retry child and still ship one title.
        expect(granularityFloor(3)).toBe(0)
        expect(isTooCoarse(1, granularityFloor(3))).toBe(false)
    })

    test("mx5's real numbers: 31 ownable requirements demand at least 16 tasks", () => {
        // At real breadth the floor discriminates: a plan of 11 for 31 ownable
        // requirements is too coarse, one of 41 is not.
        expect(granularityFloor(31)).toBe(16)
        expect(isTooCoarse(11, granularityFloor(31))).toBe(true)
        expect(isTooCoarse(41, granularityFloor(31))).toBe(false)
    })

    test('a plan exactly at the floor passes', () => {
        expect(isTooCoarse(16, granularityFloor(31))).toBe(false)
    })

    test('the ceiling that derives the floor is unchanged', () => {
        expect(MAX_REQUIREMENTS_PER_TASK).toBe(2)
    })
})

describe('isPlanShapeQuestion', () => {
    test('fires on the fork the triage kept answering for itself', () => {
        // Two wordings of the same fork, at the length a model actually asks it.
        expect(
            isPlanShapeQuestion(
                'Should the task breakdown follow the 12 milestones in §12 as-is (one task per'
                    + ' milestone), or should tasks be split more granularly?'
            )
        ).toBe(true)
        expect(
            isPlanShapeQuestion(
                'Should each of the 9 milestones from §12 become a single implementation task,'
                    + ' or should they be subdivided into smaller per-route/per-component tasks?'
            )
        ).toBe(true)
        // Further wordings of the same fork, so the match is not keyed to one phrasing.
        expect(
            isPlanShapeQuestion(
                'Should each milestone step produce its own self-contained task, or should'
                    + ' testing infrastructure setup be extracted upfront?'
            )
        ).toBe(true)
    })

    test('stays off ordinary scope questions the user should still decide', () => {
        expect(isPlanShapeQuestion('Where should uploaded files be stored?')).toBe(false)
        expect(
            isPlanShapeQuestion(
                'Should the Zod schemas live in a shared module imported by both server and'
                    + ' client, or stay server-only with manual client types?'
            )
        ).toBe(false)
        expect(
            isPlanShapeQuestion('Should we pin Tailwind to v3 or take the latest v4 release?')
        ).toBe(false)
        expect(
            isPlanShapeQuestion(
                'Should rate limiting be a shared middleware or inline in each handler?'
            )
        ).toBe(false)
    })
})

describe('the host answer and the split hint state no target count', () => {
    // Naming a target count makes the model CHASE it, into plans far larger than
    // the spec needs and, at the top end, a context blowup. So the floor stays
    // host-side and the answer names no number at all — which is what the last
    // assertion here pins.
    test('the host answer cuts by deliverable and names no number', () => {
        expect(PLAN_SHAPE_ANSWER).toContain('per-deliverable')
        expect(PLAN_SHAPE_ANSWER).toContain('rather than one task per milestone')
        expect(PLAN_SHAPE_ANSWER).not.toMatch(/\d/)
    })

    test('the split hint asks for a SPLIT, never a regeneration or a count', () => {
        const h = granularitySplitHint(11, 31)
        expect(h).toContain('SPLIT')
        expect(h).toContain('Do not drop anything')
        expect(h).not.toMatch(/at least \d+ tasks/)
        expect(h).not.toContain(String(granularityFloor(31)))
    })
})
