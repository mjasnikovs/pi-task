/**
 * write-guard tests — porcelain parsing, the deletion guard's relocation
 * allowance, and the diff-capture log line. Pure text analysis; the reject
 * semantics are exercised end-to-end in final-gate-fix.test.ts.
 */
import {describe, expect, test} from 'bun:test'
import {
    findForbiddenDeletions,
    formatTreeChanges,
    parseTreeChanges,
    parseNameStatusChanges,
    classifyIgnoredPath,
    findActionableIgnoredWrites,
    diffIgnoredSnapshots,
    ignoredWriteTrailLine,
    ignoredWriteDebtReason,
    ignoredWriteUnobservedNote
} from '../../src/task/write-guard.js'

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

    // mx5 run 20. Three Playwright FAILURE screenshots that TASK_0027's own
    // `git add -A` had swept in read as deliverables, and two consecutive fix
    // attempts were discarded whole over them — each losing a real
    // `src/client/api.test.tsx` repair. The exempt list is a strict subset of the
    // verdict-level artifact list; build output stays out of it.
    test('run-20 shape: deleting tracked test-runner output is NOT forbidden', () => {
        const s = parseTreeChanges(
            ' M package.json\n M src/client/api.test.tsx\n'
                + ' D test-results/client-pages-JoinPage-JoinPage-screenshot-baseline/JoinPage-screenshot-baseline-1-actual.png\n'
                + ' D test-results/.last-run.json'
        )
        expect(findForbiddenDeletions(s)).toEqual([])
    })

    test('the other regenerable outputs are exempt too', () => {
        const s = parseTreeChanges(
            ' D playwright-report/index.html\n D coverage/lcov.info\n'
                + ' D .nyc_output/out.json\n D tsconfig.tsbuildinfo'
        )
        expect(findForbiddenDeletions(s)).toEqual([])
    })

    test('BUILD OUTPUT is NOT exempt — a committed dist/ can be the shipped artifact', () => {
        const s = parseTreeChanges(' D dist/app.css\n D build/main.js\n D .next/server.js')
        expect(findForbiddenDeletions(s)).toEqual([
            'dist/app.css',
            'build/main.js',
            '.next/server.js'
        ])
    })

    test('an exemption does not excuse a real deliverable deleted alongside it', () => {
        const s = parseTreeChanges(' D test-results/x-actual.png\n D src/client/pages/admin.tsx')
        expect(findForbiddenDeletions(s)).toEqual(['src/client/pages/admin.tsx'])
    })

    test('a path merely NAMED like one is not exempt — the prefix must be the root', () => {
        const s = parseTreeChanges(' D src/test-results/helper.ts\n D src/coverage-report.ts')
        expect(findForbiddenDeletions(s)).toEqual([
            'src/test-results/helper.ts',
            'src/coverage-report.ts'
        ])
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

describe('parseNameStatusChanges', () => {
    test('classifies name-status codes; renames split into deleted source + added target', () => {
        const out = parseNameStatusChanges(
            [
                'M\tsrc/a.ts',
                'A\tsrc/new.ts',
                'D\tplaywright/index.ts',
                'R100\told.ts\tnew-place/old.ts'
            ].join('\n')
        )
        expect(out.modified).toEqual(['src/a.ts'])
        expect(out.added.sort()).toEqual(['new-place/old.ts', 'src/new.ts'])
        expect(out.deleted.sort()).toEqual(['old.ts', 'playwright/index.ts'])
    })
    test("a copy's source still exists — only the target counts", () => {
        const out = parseNameStatusChanges('C75\tsrc/a.ts\tsrc/a-copy.ts')
        expect(out.deleted).toEqual([])
        expect(out.added).toEqual(['src/a-copy.ts'])
    })
    test('blank and malformed lines are skipped', () => {
        expect(parseNameStatusChanges('\n\nD\n')).toEqual({modified: [], deleted: [], added: []})
    })
    test('feeds findForbiddenDeletions identically to the porcelain shape', () => {
        const changes = parseNameStatusChanges('D\tsrc/dead.ts\nR100\tsrc/moved.ts\tlib/moved.ts')
        expect(findForbiddenDeletions(changes)).toEqual(['src/dead.ts'])
    })
})

/**
 * IGNORED-PATH CHANNEL (mx5 run 19). The pure half of the lever: which ignored
 * paths a gate may rule on, how a write is attributed to the child that made it,
 * and the record it produces. Every fixture here pins one A/B invariant
 * (scripts/ignored-writes-ab.ts).
 */
describe('classifyIgnoredPath (inv-build-output-exempt)', () => {
    test('node_modules and its interior are a dependency tree, never a finding', () => {
        expect(classifyIgnoredPath('node_modules', [])).toBe('dep-dir')
        expect(classifyIgnoredPath('node_modules/left-pad/index.js', [])).toBe('dep-dir')
        expect(classifyIgnoredPath('packages/app/node_modules/x', [])).toBe('dep-dir')
    })

    test("a build outdir parsed from the project's OWN build command is exempt", () => {
        expect(classifyIgnoredPath('public/assets/app.js', ['public/assets'])).toBe('build-output')
        // …and a path that merely shares a prefix segment is not.
        expect(classifyIgnoredPath('public/index.html', ['public/assets'])).toBe('actionable')
    })

    test('conventional build dirs are exempt where no manifest declares one', () => {
        for (const p of ['dist/x.js', 'build/a', 'target/debug/app', 'coverage/lcov.info']) {
            expect(classifyIgnoredPath(p, [])).toBe('build-output')
        }
    })

    test("the run's own task dir and .git are never findings", () => {
        expect(classifyIgnoredPath('.pi-tasks/final-gate-debug.log', [])).toBe('task-dir')
        expect(classifyIgnoredPath('.git/config', [])).toBe('vcs-meta')
    })

    test('THE LEAD: a gitignored .env is actionable', () => {
        expect(classifyIgnoredPath('.env', [])).toBe('actionable')
        expect(findActionableIgnoredWrites(['.env', 'dist/', 'node_modules/'], [])).toEqual([
            '.env'
        ])
    })
})

describe('diffIgnoredSnapshots (attribution)', () => {
    test('only paths whose fingerprint appeared or changed are attributed', () => {
        const before = {'.env': '100:20', 'scratch.log': '100:5'}
        const after = {'.env': '200:44', 'scratch.log': '100:5', 'other.tmp': '300:1'}
        expect(diffIgnoredSnapshots(before, after)).toEqual(['.env', 'other.tmp'])
    })

    test("an ignored file that was ALREADY there is not this pass's write", () => {
        expect(diffIgnoredSnapshots({'.env': '1:1'}, {'.env': '1:1'})).toEqual([])
    })

    test('an empty before-snapshot (channel unavailable) attributes nothing new falsely', () => {
        expect(diffIgnoredSnapshots({}, {})).toEqual([])
    })
})

describe('the ignored-write record (inv-no-secret-echo)', () => {
    // The channel exists because of a file full of credentials: every one of these
    // takes PATHS and can therefore never carry contents. The fixture asserts the
    // shape that makes that true.
    const paths = ['.env']
    test('trail line names the path and says the write does not ship', () => {
        const line = ignoredWriteTrailLine(paths)
        expect(line).toContain('.env')
        expect(line).toContain('NOT committed')
    })

    test('debt wording tracks what was PROVEN, not what is suspected', () => {
        expect(ignoredWriteDebtReason(paths, true)).toContain('PASS depended on')
        expect(ignoredWriteDebtReason(paths, undefined)).toContain('was not established')
    })

    test('the UNOBSERVED note says the checks are unreproducible, not that they failed', () => {
        const note = ignoredWriteUnobservedNote(paths)
        expect(note.startsWith('UNOBSERVED')).toBe(true)
        expect(note).toContain('not in the commit')
    })

    test('a secret-shaped VALUE can never reach any record — they take paths only', () => {
        const all = [
            ignoredWriteTrailLine(paths),
            ignoredWriteDebtReason(paths, true),
            ignoredWriteUnobservedNote(paths)
        ].join('\n')
        expect(all).not.toContain('hunter2')
        expect(all).not.toContain('=')
    })
})
