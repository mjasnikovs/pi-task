/**
 * write-guard tests — porcelain parsing, the deletion guard's relocation
 * allowance, and the diff-capture log line. Pure text analysis; the reject
 * semantics are exercised end-to-end in final-gate-fix.test.ts.
 */
import {describe, expect, test} from 'bun:test'
import {findForbiddenDeletions, formatTreeChanges, parseTreeChanges} from './write-guard.js'

describe('parseTreeChanges', () => {
    test('classifies modified / deleted / untracked entries', () => {
        const s = parseTreeChanges(
            [
                ' M src/client/main.tsx',
                'M  src/server/index.ts',
                ' D src/client/pages/admin.tsx',
                'D  src/old.ts',
                '?? src/new-helper.ts',
                'A  src/staged-add.ts'
            ].join('\n')
        )
        expect(s.modified.sort()).toEqual(['src/client/main.tsx', 'src/server/index.ts'])
        expect(s.deleted.sort()).toEqual(['src/client/pages/admin.tsx', 'src/old.ts'])
        expect(s.added.sort()).toEqual(['src/new-helper.ts', 'src/staged-add.ts'])
    })

    test('a rename contributes its source to deleted and its target to added', () => {
        const s = parseTreeChanges('R  src/app.test.ts -> e2e/app.test.ts')
        expect(s.deleted).toEqual(['src/app.test.ts'])
        expect(s.added).toEqual(['e2e/app.test.ts'])
        expect(s.modified).toEqual([])
    })

    test('quoted paths are unquoted; blank/short lines are ignored', () => {
        const s = parseTreeChanges('?? "src/with space.ts"\n\n D')
        expect(s.added).toEqual(['src/with space.ts'])
        expect(s.deleted).toEqual([])
    })

    test('empty status → empty summary', () => {
        expect(parseTreeChanges('')).toEqual({modified: [], deleted: [], added: []})
    })
})

describe('findForbiddenDeletions', () => {
    test('run-11 shape: rm of a committed deliverable with no relocation is forbidden', () => {
        const s = parseTreeChanges(' D src/client/pages/admin.tsx\n M src/client/main.tsx')
        expect(findForbiddenDeletions(s)).toEqual(['src/client/pages/admin.tsx'])
    })

    test('a relocation (same file name reappears as an add) is allowed — run-7 fix shape', () => {
        // Unstaged relocation shows as a delete + an untracked add, not a rename.
        const s = parseTreeChanges(' D src/app.spec.ts\n?? e2e/app.spec.ts')
        expect(findForbiddenDeletions(s)).toEqual([])
    })

    test('a staged rename is likewise allowed', () => {
        const s = parseTreeChanges('R  src/app.spec.ts -> e2e/app.spec.ts')
        expect(findForbiddenDeletions(s)).toEqual([])
    })

    test('an add with a DIFFERENT name does not excuse the deletion', () => {
        const s = parseTreeChanges(' D src/client/pages/admin.tsx\n?? src/client/api-types.ts')
        expect(findForbiddenDeletions(s)).toEqual(['src/client/pages/admin.tsx'])
    })

    test('no deletions → nothing forbidden', () => {
        expect(findForbiddenDeletions(parseTreeChanges(' M src/a.ts\n?? src/b.ts'))).toEqual([])
    })
})

describe('formatTreeChanges', () => {
    test('names each bucket, omitting empty ones', () => {
        const s = parseTreeChanges(' M src/a.ts\n?? src/b.ts\n D src/c.ts')
        expect(formatTreeChanges(s)).toBe('MODIFIED [src/a.ts] NEW [src/b.ts] DELETED [src/c.ts]')
        expect(formatTreeChanges(parseTreeChanges(' M src/a.ts'))).toBe('MODIFIED [src/a.ts]')
    })

    test('clean tree reads as no changes', () => {
        expect(formatTreeChanges(parseTreeChanges(''))).toBe('(no tree changes)')
    })
})
