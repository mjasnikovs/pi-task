/**
 * enforce-attribution — the enforce-differential attribution filter.
 *
 * The question it answers: a re-verify FAILed after enforce edited the tree, so
 * did ENFORCE break it, or was it already broken? Getting that wrong in one
 * direction reverts good guideline edits; in the other it is a way to ignore a
 * real regression. The cases below pin both edges.
 */
import {expect, test, describe} from 'bun:test'
import {
    attributeEnforceFailure,
    extractFailingFiles,
    fileStem,
    resolveNamedFile
} from '../../src/task/enforce-attribution.js'

/** A FAIL reason at the length one really arrives at: a named spec file with a
 *  line number, a diagnosis, and a claim about what was NOT modified. */
const RUN18_FAIL =
    'work did not verify: 1 of 51 Playwright CT tests fails (MyListings.spec.tsx:186 — "toggle Mark as '
    + 'Sold / Undo Sold updates listing status in-place") due to a pre-existing flaky locator collision '
    + "where getByText('SOLD', {exact: true}) resolves to 2 elements; however, this test file was NOT modified b"

/** The files an enforce pass touched. */
const RUN18_ENFORCE = ['.pi-tasks/TASK_0024.md', 'src/client/pages/Admin.tsx']

const RUN18_REPO = [
    'src/client/pages/Admin.tsx',
    'src/client/pages/MyListings.tsx',
    'src/client/pages/MyListings.spec.tsx',
    'src/client/pages/MyListings.stories.tsx'
]

describe('extractFailingFiles', () => {
    test('finds a BARE file name with a line number — the run-18 shape', () => {
        // root-cause-repair.ts's PATH_TOKEN_RE is
        // `/(?:[\w.@-]+\/)+[\w.@-]+\.\w+/g` — it requires a `/`, so run against
        // "MyListings.spec.tsx:186" it matches NOTHING. A filter reusing it would
        // find no failing file and be unable to attribute at all, which is why
        // this extractor accepts the bare-name-plus-line form too.
        expect(extractFailingFiles(RUN18_FAIL)).toEqual(['MyListings.spec.tsx'])
    })

    test('finds separator-carrying paths and collapses the :line form', () => {
        expect(
            extractFailingFiles('`bun test test/photos.test.ts` fails at test/photos.test.ts:12:4')
        ).toEqual(['test/photos.test.ts'])
    })

    test('does not mistake property access, versions or call chains for files', () => {
        // `usersData.error` has exactly the name.ext shape, and it is the kind of
        // identifier an enforce diff edits — so an ungated regex would name it as
        // the failing FILE and attribute the break to enforce.
        const text =
            "setApiError(usersData.error ?? 'x') at v1.2.3 — expect(component.getByText('SOLD')).toBeVisible()"
        expect(extractFailingFiles(text)).toEqual([])
    })

    test('empty on text naming nothing at all', () => {
        expect(extractFailingFiles('exit code 1, no output captured')).toEqual([])
        expect(extractFailingFiles('   ')).toEqual([])
    })
})

describe('fileStem', () => {
    test('collapses companion suffixes so a file and its spec/story relate', () => {
        expect(fileStem('src/client/pages/Admin.tsx')).toBe('admin')
        expect(fileStem('Admin.spec.tsx')).toBe('admin')
        expect(fileStem('src/x/Admin.stories.tsx')).toBe('admin')
        expect(fileStem('types/Admin.d.ts')).toBe('admin')
    })
})

describe('resolveNamedFile', () => {
    test('resolves a bare name to its tracked repo path', () => {
        expect(resolveNamedFile('MyListings.spec.tsx', RUN18_REPO)).toBe(
            'src/client/pages/MyListings.spec.tsx'
        )
    })

    test('an ambiguous name resolves to null rather than guessing', () => {
        expect(resolveNamedFile('index.ts', ['a/index.ts', 'b/index.ts'])).toBeNull()
    })

    test('no repo file list → no resolution, and that is not an error', () => {
        expect(resolveNamedFile('MyListings.spec.tsx', null)).toBeNull()
    })
})

describe('attributeEnforceFailure — the run-18 incident', () => {
    test('KEEPS: the failing CT file is disjoint from the one-line enforce diff', () => {
        const a = attributeEnforceFailure({
            failReason: RUN18_FAIL,
            enforceTouched: RUN18_ENFORCE,
            repoFiles: RUN18_REPO
        })
        expect(a.verdict).toBe('keep')
        expect(a.why).toBe('disjoint-from-enforce-diff')
        expect(a.file).toBe('src/client/pages/MyListings.spec.tsx')
    })

    test('the verdict does not depend on repo-file resolution', () => {
        const a = attributeEnforceFailure({
            failReason: RUN18_FAIL,
            enforceTouched: RUN18_ENFORCE,
            repoFiles: null
        })
        expect(a.verdict).toBe('keep')
        expect(a.file).toBe('MyListings.spec.tsx')
    })
})

describe('attributeEnforceFailure — invariants', () => {
    test('inv-real-regression-still-reverts: the enforce diff touches the failing file', () => {
        const a = attributeEnforceFailure({
            failReason: 'work did not verify: tsc fails — src/client/pages/Admin.tsx:84 TS2554',
            enforceTouched: RUN18_ENFORCE,
            repoFiles: RUN18_REPO
        })
        expect(a.verdict).toBe('revert')
        expect(a.why).toBe('named-file-in-enforce-diff')
        expect(a.overlap).toEqual({
            named: 'src/client/pages/Admin.tsx',
            enforce: 'src/client/pages/Admin.tsx'
        })
    })

    test("inv-real-regression-still-reverts: it broke a touched file's OWN spec", () => {
        // The companion-stem rule: `Admin.spec.tsx` is not literally in the diff,
        // but a change to `Admin.tsx` reaches it, so this is a regression candidate.
        const a = attributeEnforceFailure({
            failReason:
                'work did not verify: 1 of 51 CT tests fails (Admin.spec.tsx:12 — renders banner)',
            enforceTouched: RUN18_ENFORCE,
            repoFiles: RUN18_REPO
        })
        expect(a.verdict).toBe('revert')
        expect(a.why).toBe('named-file-in-enforce-diff')
    })

    test('inv-real-regression-still-reverts: ANY overlap among several named files reverts', () => {
        const a = attributeEnforceFailure({
            failReason: 'fails in MyListings.spec.tsx:186 and src/client/pages/Admin.tsx:84',
            enforceTouched: RUN18_ENFORCE,
            repoFiles: RUN18_REPO
        })
        expect(a.verdict).toBe('revert')
    })

    test('inv-unparseable-reason-reverts: no file named ⇒ revert, never keep on ignorance', () => {
        const a = attributeEnforceFailure({
            failReason: 'work did not verify: the VERIFY command exited 1 with no output',
            enforceTouched: RUN18_ENFORCE,
            repoFiles: RUN18_REPO
        })
        expect(a.verdict).toBe('revert')
        expect(a.why).toBe('no-file-named')
    })

    test('inv-unparseable-reason-reverts: unknown enforce diff ⇒ revert', () => {
        for (const enforceTouched of [null, []]) {
            const a = attributeEnforceFailure({
                failReason: RUN18_FAIL,
                enforceTouched,
                repoFiles: RUN18_REPO
            })
            expect(a.verdict).toBe('revert')
            expect(a.why).toBe('enforce-diff-unknown')
        }
    })

    test('run 14 shape: keeps only when the enforce diff excludes every named file', () => {
        const run14 =
            'work did not verify: The shipped `bun test test/photos.test.ts` exits with code 1 due to a '
            + 'pre-existing teardown bug in `test/teardown.ts` (created by TASK_0007)'
        expect(
            attributeEnforceFailure({
                failReason: run14,
                enforceTouched: ['src/server/routes/invite.ts']
            }).verdict
        ).toBe('keep')
        // …but an enforce diff touching the ROUTE whose test is failing is not
        // disjoint: `src/server/routes/photos.ts` and `test/photos.test.ts` share a
        // stem, which is exactly the "it broke the thing under test" shape.
        expect(
            attributeEnforceFailure({
                failReason: run14,
                enforceTouched: ['src/server/routes/photos.ts']
            }).verdict
        ).toBe('revert')
        // …and reverts the moment enforce itself touched one of them.
        expect(
            attributeEnforceFailure({
                failReason: run14,
                enforceTouched: ['test/teardown.ts']
            }).verdict
        ).toBe('revert')
    })
})
