import {describe, expect, test} from 'bun:test'
import {findSubstitutionSuspects, isTestFile} from './substitution-probe.js'

describe('isTestFile', () => {
    test('matches JS/TS test suffixes and test directories', () => {
        expect(isTestFile('src/test/auth.test.ts')).toBe(true)
        expect(isTestFile('src/app.spec.tsx')).toBe(true)
        expect(isTestFile('src/test/request.ts')).toBe(true) // helper INSIDE a test dir
        expect(isTestFile('tests/e2e.ts')).toBe(true)
        expect(isTestFile('src/__tests__/x.ts')).toBe(true)
    })
    test('matches other ecosystems by convention, not by parsing', () => {
        expect(isTestFile('tests/test_routes.py')).toBe(true)
        expect(isTestFile('app/test_models.py')).toBe(true) // pytest prefix, no test dir
        expect(isTestFile('server_test.go')).toBe(true)
        expect(isTestFile('spec/user_spec.rb')).toBe(true)
    })
    test('rejects ordinary source files', () => {
        expect(isTestFile('src/server/index.ts')).toBe(false)
        expect(isTestFile('src/testimonials.ts')).toBe(false)
        expect(isTestFile('src/latest/thing.ts')).toBe(false)
        expect(isTestFile('contest.py')).toBe(false)
    })
})

describe('findSubstitutionSuspects', () => {
    // The class invariant, not a framework shape: the task's own diff includes the
    // tests whose green result would bless it — self-graded work, any language.
    test('flags test files the task itself authored/changed, with their size', () => {
        const findings = findSubstitutionSuspects([
            {path: 'src/server/routes/auth.ts', addedLines: 40},
            {path: 'src/test/auth.test.ts', addedLines: 712},
            {path: 'src/test/request.ts', addedLines: 941}
        ])
        expect(findings).toHaveLength(2)
        expect(findings[0]).toContain('src/test/auth.test.ts (+712 lines)')
        expect(findings[1]).toContain('src/test/request.ts (+941 lines)')
        expect(findings[0]).toContain('blesses the very work that wrote it')
    })

    test('language-agnostic: a pytest file produces the same finding', () => {
        const findings = findSubstitutionSuspects([{path: 'tests/test_api.py', addedLines: 300}])
        expect(findings).toHaveLength(1)
        expect(findings[0]).toContain('tests/test_api.py (+300 lines)')
    })

    test('no changed test files → no findings (source-only or docs-only tasks)', () => {
        expect(
            findSubstitutionSuspects([
                {path: 'src/server/index.ts', addedLines: 120},
                {path: 'README.md', addedLines: 30}
            ])
        ).toEqual([])
    })

    test('pure deletions in test files are not suspects', () => {
        expect(findSubstitutionSuspects([{path: 'src/test/old.test.ts', addedLines: 0}])).toEqual(
            []
        )
    })
})
