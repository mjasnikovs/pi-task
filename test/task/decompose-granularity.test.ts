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
        // Live (2026-07-28 size smoke): "Add a `--version` flag to the CLI that
        // prints the package version and exits 0" — 78 chars — extracted THREE
        // ownable requirements (flag, print, exit code), giving a floor of 2 for
        // what is unambiguously ONE task. Both arms shipped 1 title, so the floor
        // bought nothing and cost a split-retry child.
        expect(granularityFloor(3)).toBe(0)
        expect(isTooCoarse(1, granularityFloor(3))).toBe(false)
    })

    test("mx5's real numbers: 31 ownable requirements demand at least 16 tasks", () => {
        // The collapsed run shipped 11 for these 31; the healthy run shipped 41.
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
        // Both live runs, verbatim.
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
        // Live STEP 0 draws of the same fork, other wordings.
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
    // Naming a target count made the model chase it: 66, then 81 and 85 titles on
    // live draws, plus a 120k-context blowup. The floor stays host-side.
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
