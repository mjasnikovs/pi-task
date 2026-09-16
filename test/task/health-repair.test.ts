import {describe, expect, test} from 'bun:test'
import {
    buildHealthRepairFence,
    buildHealthRepairTitle,
    healthRedSubject,
    parseHealthRepairTitle,
    planCoversHealthRed
} from '../../src/task/health-repair.js'
import type {HealthOutcome} from '../../src/task/repo-health-check.js'

const CWD = '/home/u/proj'
const TRACKED = ['src/client/api.ts', 'src/server/index.ts', 'test/api.test.ts', 'go/pkg/x.go']

function red(cmd: string, output: string, exitCode = 1): HealthOutcome {
    return {
        ok: false,
        reason: `\`${cmd}\` exited ${exitCode}`,
        ecosystem: 'node',
        commands: [{cmd, outcome: 'fail', exitCode}],
        output
    }
}

describe('healthRedSubject', () => {
    test('eslint-style absolute paths resolve to tracked repo paths, once each', () => {
        const out = [
            `${CWD}/src/client/api.ts`,
            '  12:3  error  Unsafe assignment  @typescript-eslint/no-unsafe-assignment',
            '  40:1  error  Unsafe call        @typescript-eslint/no-unsafe-call',
            `${CWD}/src/client/api.ts`,
            `${CWD}/node_modules/hono/dist/client.js`
        ].join('\n')
        expect(healthRedSubject(red('bun run lint', out), CWD, TRACKED)).toEqual({
            command: 'bun run lint',
            exitCode: 1,
            files: ['src/client/api.ts']
        })
    })

    test('tsc, cargo and go shapes all resolve; an untracked path is noise', () => {
        const out = [
            'src/server/index.ts(7,5): error TS2322: nope',
            '  --> go/pkg/x.go:12:5',
            './test/api.test.ts:3:1: undefined: foo',
            'dist/bundle.js:1:1 something'
        ].join('\n')
        expect(healthRedSubject(red('go vet ./...', out), CWD, TRACKED)?.files).toEqual([
            'src/server/index.ts',
            'go/pkg/x.go',
            'test/api.test.ts'
        ])
    })

    test('no file named → command subject; no tracked list → command subject', () => {
        const out = 'error: something is wrong\n1 problem'
        expect(healthRedSubject(red('bun run lint', out), CWD, TRACKED)).toEqual({
            command: 'bun run lint',
            exitCode: 1,
            files: []
        })
        expect(
            healthRedSubject(red('bun run lint', `${CWD}/src/client/api.ts`), CWD, null)?.files
        ).toEqual([])
    })

    test('an ambiguous suffix resolves to nothing rather than a guess', () => {
        const tracked = ['a/src/x.ts', 'b/src/x.ts']
        expect(healthRedSubject(red('tsc', 'src/x.ts(1,1): error'), CWD, tracked)?.files).toEqual(
            []
        )
    })

    test('a result with no failing command is no subject', () => {
        expect(healthRedSubject({ok: false, commands: []}, CWD, TRACKED)).toBeNull()
        expect(healthRedSubject({ok: false}, CWD, TRACKED)).toBeNull()
    })
})

describe('title grammar', () => {
    test('file form round-trips', () => {
        const title = buildHealthRepairTitle({
            command: 'bun run lint',
            exitCode: 1,
            files: ['src/client/api.ts', 'src/server/index.ts'],
            owners: ['TASK_0033']
        })
        expect(title).toBe(
            'repair src/client/api.ts, src/server/index.ts: `bun run lint` exits 1 (introduced by TASK_0033)'
        )
        expect(parseHealthRepairTitle(title)).toEqual({
            command: 'bun run lint',
            files: ['src/client/api.ts', 'src/server/index.ts']
        })
    })

    test('command form round-trips', () => {
        const title = buildHealthRepairTitle({
            command: 'cargo clippy --all-targets',
            exitCode: 101,
            files: [],
            owners: []
        })
        expect(title).toBe(
            'repair `cargo clippy --all-targets`: exits 101 (no task in this run owns it)'
        )
        expect(parseHealthRepairTitle(title)).toEqual({
            command: 'cargo clippy --all-targets',
            files: []
        })
    })

    test('a root-cause repair title and a feature title are not health repairs', () => {
        expect(parseHealthRepairTitle('repair test/teardown.ts: TRUNCATE bug')).toBeNull()
        expect(parseHealthRepairTitle('Implement `src/client/api.ts` — typed client')).toBeNull()
    })
})

describe('planCoversHealthRed', () => {
    const lintRed = {command: 'bun run lint', exitCode: 1, files: ['src/client/api.ts']}

    test('covered by the same command, by a shared file, or by a root-cause repair', () => {
        expect(planCoversHealthRed(['repair `bun run lint`: exits 1 (x)'], lintRed)).toBe(true)
        expect(
            planCoversHealthRed(
                ['repair src/other.ts, src/client/api.ts: `tsc --noEmit` exits 2 (x)'],
                lintRed
            )
        ).toBe(true)
        expect(planCoversHealthRed(['repair src/client/api.ts: some defect'], lintRed)).toBe(true)
    })

    test('not covered by a different command over different files, nor by prose', () => {
        expect(
            planCoversHealthRed(['repair src/other.ts: `tsc --noEmit` exits 2 (x)'], lintRed)
        ).toBe(false)
        expect(planCoversHealthRed(['Fix src/client/api.ts lint'], lintRed)).toBe(false)
    })
})

describe('buildHealthRepairFence', () => {
    test('pins the files, forbids suppression, pins VERIFY to the command', () => {
        const fence = buildHealthRepairFence({
            command: 'bun run lint',
            files: ['src/client/api.ts']
        })
        expect(fence).toContain('`src/client/api.ts` is the ONLY')
        expect(fence).toContain('Do NOT suppress')
        expect(fence).toContain('The VERIFY block MUST be exactly: `bun run lint`')
    })

    test('command form pins only what the command reports', () => {
        const fence = buildHealthRepairFence({command: 'go vet ./...', files: []})
        expect(fence).toContain('Modify only the files the command reports')
    })
})
