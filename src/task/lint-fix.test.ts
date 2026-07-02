import {describe, expect, test} from 'bun:test'
import {
    buildLintFixPrompt,
    revertGuardViolations,
    runBoundedLintFix,
    LINT_FIX_TOOLS,
    type LintFixDeps
} from './lint-fix.js'

describe('buildLintFixPrompt', () => {
    test('names the failure, demands smallest edits, and bans discarding work', () => {
        const p = buildLintFixPrompt('repo health: `bun run lint` exited 1')
        expect(p).toContain('repo health: `bun run lint` exited 1')
        expect(p).toContain('smallest possible edits')
        // The exact cheat both validation runs used must be named as forbidden.
        expect(p).toContain('git checkout')
        expect(p).toContain('git stash')
        expect(p).toContain('LINT-FIX: DONE')
    })
})

describe('revertGuardViolations', () => {
    test('a pre-dirty file now clean is a violation; still-dirty files are not', () => {
        expect(
            revertGuardViolations(['src/test/request.ts', 'src/a.ts'], new Set(['src/a.ts']))
        ).toEqual(['src/test/request.ts'])
    })
    test('no pre-dirty files → nothing can be violated', () => {
        expect(revertGuardViolations([], new Set())).toEqual([])
    })
})

/** Scripted fake git: returns queued stdouts per (subcommand) call order. */
function fakeGit(script: Record<string, string[]>): {
    calls: string[][]
    git: LintFixDeps['git']
} {
    const counters: Record<string, number> = {}
    const calls: string[][] = []
    return {
        calls,
        git: args => {
            calls.push(args)
            const key = args[0]
            const queue = script[key] ?? ['']
            const i = Math.min(counters[key] ?? 0, queue.length - 1)
            counters[key] = (counters[key] ?? 0) + 1
            return Promise.resolve({exitCode: 0, stdout: queue[i]})
        }
    }
}

function makeDeps(over: Partial<LintFixDeps> & {git: LintFixDeps['git']}): LintFixDeps {
    return {
        cwd: '/tmp/x',
        failReason: 'repo health: `bun run lint` exited 1',
        runChild: () => Promise.resolve('LINT-FIX: DONE'),
        repoHealth: () => Promise.resolve({ok: true, reason: 'clean'}),
        ...over
    }
}

test('runBoundedLintFix: work preserved + health green → applied', async () => {
    // diff called twice (pre and post) — the work file stays dirty both times.
    const {git} = fakeGit({
        diff: ['src/test/request.ts', 'src/test/request.ts'],
        'ls-files': ['', ''],
        'write-tree': ['abc123']
    })
    let tools = ''
    const r = await runBoundedLintFix(
        makeDeps({
            git,
            runChild: t => {
                tools = t
                return Promise.resolve('LINT-FIX: DONE')
            }
        })
    )
    expect(r.ok).toBe(true)
    expect(tools).toBe(LINT_FIX_TOOLS)
})

test('runBoundedLintFix: fix child reverting the work trips the guard and restores', async () => {
    // Pre-diff shows the work file dirty; post-diff shows it clean (reverted).
    const {git, calls} = fakeGit({
        diff: ['src/test/request.ts', ''],
        'ls-files': ['', ''],
        'write-tree': ['abc123']
    })
    const r = await runBoundedLintFix(makeDeps({git}))
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('revert-guard')
    expect(r.reason).toContain('src/test/request.ts')
    // The snapshot restore ran: checkout <tree> … then reset.
    expect(calls.some(c => c[0] === 'checkout' && c[1] === 'abc123')).toBe(true)
})

test('runBoundedLintFix: deleted pre-existing untracked file trips the guard', async () => {
    const {git} = fakeGit({
        diff: ['', ''],
        // pre: new-file.ts untracked; post-probe for it: gone.
        'ls-files': ['src/test/new-file.ts', '', ''],
        'write-tree': ['abc123']
    })
    const r = await runBoundedLintFix(makeDeps({git}))
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('new-file.ts')
})

test('runBoundedLintFix: health still failing → not applied (no guard trip)', async () => {
    const {git} = fakeGit({
        diff: ['src/a.ts', 'src/a.ts'],
        'ls-files': ['', ''],
        'write-tree': ['abc123']
    })
    const r = await runBoundedLintFix(
        makeDeps({
            git,
            repoHealth: () => Promise.resolve({ok: false, reason: '`bun run lint` exited 1'})
        })
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('did not converge')
})

test('runBoundedLintFix: child error → not applied; user cancel propagates', async () => {
    const {git} = fakeGit({diff: ['', ''], 'ls-files': [''], 'write-tree': ['abc123']})
    const err = await runBoundedLintFix(
        makeDeps({git, runChild: () => Promise.reject(new Error('boom'))})
    )
    expect(err.ok).toBe(false)
    expect(err.reason).toContain('boom')

    const {git: git2} = fakeGit({diff: [''], 'ls-files': [''], 'write-tree': ['abc123']})
    await expect(
        runBoundedLintFix(
            makeDeps({git: git2, runChild: () => Promise.reject(new Error('__user_cancelled__'))})
        )
    ).rejects.toThrow('__user_cancelled__')
})
