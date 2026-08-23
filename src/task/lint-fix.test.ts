import {describe, expect, test} from 'bun:test'
import {
    buildLintFixPrompt,
    revertGuardViolations,
    runBoundedLintFix,
    LINT_FIX_TOOLS,
    type LintFixDeps
} from './lint-fix.js'
import {USER_CANCELLED} from './child-runner.js'

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

describe('buildLintFixPrompt frozen paths', () => {
    test('frozen paths become an explicit do-not-touch constraint with a BLOCKED escape', () => {
        const p = buildLintFixPrompt('repo health: `bun run lint` exited 1', [
            'tsconfig.json',
            'src/server/index.ts'
        ])
        expect(p).toContain('SPEC-FROZEN PATHS')
        expect(p).toContain('- tsconfig.json')
        expect(p).toContain('- src/server/index.ts')
        // The exact live trap must be named: the checker's error text instructing the edit.
        expect(p).toContain('consider including it in the tsconfig.json')
        expect(p).toContain('LINT-FIX: BLOCKED')
    })
    test('no frozen paths → the prompt is unchanged (no frozen block)', () => {
        expect(buildLintFixPrompt('repo health: x')).not.toContain('SPEC-FROZEN')
        expect(buildLintFixPrompt('repo health: x', [])).not.toContain('SPEC-FROZEN')
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

test('runBoundedLintFix: git failing AFTER the fix → guard inconclusive, converged fix kept', async () => {
    // The mx5 run-4 misfire: the child verifiably edited only lint findings, but a
    // git failure after it made every comparison read as "work gone" → two GOOD
    // converged fixes rolled back. A git error must be inconclusive, never evidence.
    const calls: string[][] = []
    let postChild = false
    const git: LintFixDeps['git'] = args => {
        calls.push(args)
        if (args[0] === 'write-tree') return Promise.resolve({exitCode: 0, stdout: 'abc123'})
        if (args[0] === 'diff') {
            return postChild ?
                    Promise.resolve({exitCode: 128, stdout: ''}) // git broken after the fix
                :   Promise.resolve({exitCode: 0, stdout: 'src/a.ts'})
        }
        if (args[0] === 'ls-files') {
            return Promise.resolve({exitCode: 0, stdout: 'build.ts\nbun.lock\ncompose.yml'})
        }
        return Promise.resolve({exitCode: 0, stdout: ''})
    }
    const r = await runBoundedLintFix(
        makeDeps({
            git,
            runChild: () => {
                postChild = true
                return Promise.resolve('LINT-FIX: DONE')
            }
        })
    )
    expect(r.ok).toBe(true)
    expect(r.reason).toContain('inconclusive')
    // No rollback: the snapshot restore must NOT have run.
    expect(calls.some(c => c[0] === 'checkout')).toBe(false)
})

test('runBoundedLintFix: untracked probe git error → file not flagged as discarded', async () => {
    const calls: string[][] = []
    let lsCalls = 0
    const git: LintFixDeps['git'] = args => {
        calls.push(args)
        if (args[0] === 'write-tree') return Promise.resolve({exitCode: 0, stdout: 'abc123'})
        if (args[0] === 'ls-files') {
            lsCalls++
            // 1st: the pre-fix untracked listing; later: the per-file probe fails.
            return lsCalls === 1 ?
                    Promise.resolve({exitCode: 0, stdout: 'src/new-file.ts'})
                :   Promise.resolve({exitCode: 128, stdout: ''})
        }
        return Promise.resolve({exitCode: 0, stdout: ''})
    }
    const r = await runBoundedLintFix(makeDeps({git}))
    expect(r.ok).toBe(true)
    expect(r.reason).toContain('inconclusive')
    expect(calls.some(c => c[0] === 'checkout')).toBe(false)
})

test('runBoundedLintFix: child edit to a clean frozen path → reverted, not applied (mx5 run 12)', async () => {
    // The live incident shape: work file dirty throughout; tsconfig.json clean
    // pre-child, modified by the child (status: pre '', post ' M tsconfig.json';
    // third status call is revertFrozenPaths' own scoped check).
    const {git, calls} = fakeGit({
        diff: ['src/feature.ts', 'src/feature.ts'],
        'ls-files': ['', ''],
        'write-tree': ['abc123'],
        status: ['', ' M tsconfig.json', ' M tsconfig.json']
    })
    let prompt = ''
    const r = await runBoundedLintFix(
        makeDeps({
            git,
            frozenPaths: ['tsconfig.json'],
            runChild: (_t, p) => {
                prompt = p
                return Promise.resolve('LINT-FIX: DONE')
            }
        })
    )
    // Belt: the child was told; suspenders: the edit was mechanically undone.
    expect(prompt).toContain('SPEC-FROZEN PATHS')
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('frozen-path')
    expect(r.reason).toContain('tsconfig.json')
    expect(calls.some(c => c[0] === 'checkout' && c.includes('HEAD'))).toBe(true)
    expect(calls.some(c => c[0] === 'clean')).toBe(true)
})

test('runBoundedLintFix: frozen path ALREADY dirty pre-child → never reverted, fix applied', async () => {
    // A frozen path carrying pre-existing (possibly task) work is not the
    // child's doing — the guard must cost time, never work; rule 4b still sees it.
    const {git, calls} = fakeGit({
        diff: ['src/feature.ts\ntsconfig.json', 'src/feature.ts\ntsconfig.json'],
        'ls-files': ['', ''],
        'write-tree': ['abc123'],
        status: [' M tsconfig.json', ' M tsconfig.json']
    })
    const r = await runBoundedLintFix(makeDeps({git, frozenPaths: ['tsconfig.json']}))
    expect(r.ok).toBe(true)
    expect(calls.some(c => c[0] === 'checkout')).toBe(false)
})

test('runBoundedLintFix: git status failing pre-child → frozen guard inconclusive, no revert', async () => {
    const calls: string[][] = []
    const git: LintFixDeps['git'] = args => {
        calls.push(args)
        if (args[0] === 'write-tree') return Promise.resolve({exitCode: 0, stdout: 'abc123'})
        if (args[0] === 'status') return Promise.resolve({exitCode: 128, stdout: ''})
        if (args[0] === 'diff') return Promise.resolve({exitCode: 0, stdout: 'src/feature.ts'})
        return Promise.resolve({exitCode: 0, stdout: ''})
    }
    const r = await runBoundedLintFix(makeDeps({git, frozenPaths: ['tsconfig.json']}))
    // Inconclusive is not license to revert — the converge check decides alone.
    expect(r.ok).toBe(true)
    expect(calls.some(c => c[0] === 'checkout')).toBe(false)
})

test('runBoundedLintFix: no frozenPaths → no status probes, prior behavior intact', async () => {
    const {git, calls} = fakeGit({
        diff: ['src/a.ts', 'src/a.ts'],
        'ls-files': ['', ''],
        'write-tree': ['abc123']
    })
    const r = await runBoundedLintFix(makeDeps({git}))
    expect(r.ok).toBe(true)
    expect(calls.some(c => c[0] === 'status')).toBe(false)
})

test('runBoundedLintFix: child DELETING a sibling task deliverable → restored, not applied (mx5 run 12 PROMPT 2)', async () => {
    // The 17:53:44 live shape: the sibling's ct files are CLEAN tracked files —
    // neither pre-dirty nor pre-untracked, so the revert-guard is blind — and
    // deleting them greens the lint. The provenance guard must catch it.
    const {git, calls} = fakeGit({
        diff: ['src/feature.ts', 'src/feature.ts'],
        'ls-files': ['', ''],
        'write-tree': ['abc123'],
        // pre-child tree clean of deletions; post-child the ct files are gone.
        status: ['', ' D playwright-ct.config.ts\n D playwright/index.ts']
    })
    const r = await runBoundedLintFix(
        makeDeps({
            git,
            currentTaskId: 'TASK_0021',
            introducedBy: () => Promise.resolve('TASK_0020')
        })
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/^cross-task-deletion:/)
    expect(r.reason).toContain('TASK_0020')
    expect(r.reason).toContain('playwright-ct.config.ts')
    // The deleted paths were restored from HEAD (they were clean — no work lost).
    expect(
        calls.some(
            c => c[0] === 'checkout' && c.includes('HEAD') && c.includes('playwright/index.ts')
        )
    ).toBe(true)
})

test("runBoundedLintFix: child deleting the CURRENT task's own file → not flagged, fix applied", async () => {
    const {git, calls} = fakeGit({
        diff: ['src/feature.ts', 'src/feature.ts'],
        'ls-files': ['', ''],
        'write-tree': ['abc123'],
        status: ['', ' D src/mine.ts']
    })
    const r = await runBoundedLintFix(
        makeDeps({
            git,
            currentTaskId: 'TASK_0021',
            introducedBy: () => Promise.resolve('TASK_0021')
        })
    )
    expect(r.ok).toBe(true)
    expect(calls.some(c => c[0] === 'checkout')).toBe(false)
})

test("runBoundedLintFix: deletion already present PRE-child (task work) → not the child's, applied", async () => {
    const {git, calls} = fakeGit({
        diff: ['src/feature.ts', 'src/feature.ts'],
        'ls-files': ['', ''],
        'write-tree': ['abc123'],
        status: [' D playwright-ct.config.ts', ' D playwright-ct.config.ts']
    })
    const r = await runBoundedLintFix(
        makeDeps({
            git,
            currentTaskId: 'TASK_0021',
            introducedBy: () => Promise.resolve('TASK_0020')
        })
    )
    expect(r.ok).toBe(true)
    expect(calls.some(c => c[0] === 'checkout')).toBe(false)
})

test('runBoundedLintFix: unknown provenance steps aside (inconclusive ≠ evidence)', async () => {
    const {git, calls} = fakeGit({
        diff: ['src/feature.ts', 'src/feature.ts'],
        'ls-files': ['', ''],
        'write-tree': ['abc123'],
        status: ['', ' D legacy/pre-run.ts']
    })
    const r = await runBoundedLintFix(
        makeDeps({
            git,
            currentTaskId: 'TASK_0021',
            introducedBy: () => Promise.resolve(null)
        })
    )
    expect(r.ok).toBe(true)
    expect(calls.some(c => c[0] === 'checkout')).toBe(false)
})

test('runBoundedLintFix: git status failing pre-child disarms the deletion guard', async () => {
    const calls: string[][] = []
    const git: LintFixDeps['git'] = args => {
        calls.push(args)
        if (args[0] === 'write-tree') return Promise.resolve({exitCode: 0, stdout: 'abc123'})
        if (args[0] === 'status') return Promise.resolve({exitCode: 128, stdout: ''})
        if (args[0] === 'diff') return Promise.resolve({exitCode: 0, stdout: 'src/feature.ts'})
        return Promise.resolve({exitCode: 0, stdout: ''})
    }
    const r = await runBoundedLintFix(
        makeDeps({
            git,
            currentTaskId: 'TASK_0021',
            introducedBy: () => Promise.resolve('TASK_0020')
        })
    )
    expect(r.ok).toBe(true)
    expect(calls.some(c => c[0] === 'checkout')).toBe(false)
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

test('runBoundedLintFix: non-convergence whose output names a frozen path → frozen-path: reason (honest-BLOCKED trace)', async () => {
    // The child was honest — it never touched tsconfig.json, so the frozen guard
    // has nothing to revert — but the check stays red and typed-ESLint's own
    // output names the frozen path. The findings can only be fixed by an edit
    // this task's spec forbids: report it under the same `frozen-path:` prefix
    // so the gate loop routes to the picker instead of burning AUTOFIX rounds.
    const {git, calls} = fakeGit({
        diff: ['src/a.ts', 'src/a.ts'],
        'ls-files': ['', ''],
        'write-tree': ['abc123'],
        status: ['', '']
    })
    const r = await runBoundedLintFix(
        makeDeps({
            git,
            frozenPaths: ['tsconfig.json'],
            repoHealth: () =>
                Promise.resolve({
                    ok: false,
                    reason: '`bun run lint` exited 1',
                    output: 'playwright/index.ts was not found by the project service. Consider either including it in the tsconfig.json or…'
                })
        })
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/^frozen-path:/)
    expect(r.reason).toContain('tsconfig.json')
    expect(r.reason).toContain('did not converge')
    // No guard trip: nothing was reverted (the child made no frozen edit).
    expect(calls.some(c => c[0] === 'checkout')).toBe(false)
})

test('runBoundedLintFix: non-convergence NOT naming a frozen path → plain did-not-converge', async () => {
    const {git} = fakeGit({
        diff: ['src/a.ts', 'src/a.ts'],
        'ls-files': ['', ''],
        'write-tree': ['abc123'],
        status: ['', '']
    })
    const r = await runBoundedLintFix(
        makeDeps({
            git,
            frozenPaths: ['tsconfig.json'],
            repoHealth: () =>
                Promise.resolve({
                    ok: false,
                    reason: '`bun run lint` exited 1',
                    output: 'src/a.ts:3:1  error  no-unused-vars'
                })
        })
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/^did not converge/)
})

test('runBoundedLintFix: frozen-path trace matches whole path tokens only (tsconfig.json5 ≠ tsconfig.json)', async () => {
    const {git} = fakeGit({
        diff: ['src/a.ts', 'src/a.ts'],
        'ls-files': ['', ''],
        'write-tree': ['abc123'],
        status: ['', '']
    })
    const r = await runBoundedLintFix(
        makeDeps({
            git,
            frozenPaths: ['tsconfig.json'],
            repoHealth: () =>
                Promise.resolve({
                    ok: false,
                    reason: '`bun run lint` exited 1',
                    output: 'error in tsconfig.json5 and config/tsconfig.json only'
                })
        })
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/^did not converge/)
})

// ─── The BLOCKED rung, and the guard trail ──────────────────────────────────
//
// `buildLintFixPrompt` has always instructed the child to end with
// `LINT-FIX: DONE` / `LINT-FIX: BLOCKED <why>`, and the call site discarded the
// reply — nothing in src/ or scripts/ parsed it. These tests could not exist
// while that was true, and the suite's own habit of feeding `'LINT-FIX: DONE'`
// as fake output is exactly what kept it invisible.

test('a BLOCKED child that did NOT converge reports its OWN reason', async () => {
    const {git} = fakeGit({
        diff: ['src/a.ts', 'src/a.ts'],
        'ls-files': ['', ''],
        'write-tree': ['abc123']
    })
    const r = await runBoundedLintFix(
        makeDeps({
            git,
            runChild: () =>
                Promise.resolve('LINT-FIX: BLOCKED the only fix edits a frozen tsconfig'),
            repoHealth: () => Promise.resolve({ok: false, reason: '`bun run lint` exited 1'})
        })
    )
    expect(r.ok).toBe(false)
    // The child's own reason, not `did not converge: <health.reason>`.
    expect(r.reason).toBe('fix child blocked: the only fix edits a frozen tsconfig')
})

// The marker is scraped last-match-wins from arbitrary child output, and the fix
// child has bash — so its own command output is in that text. A child can also
// genuinely converge and THEN block (`eslint --fix` clears the last finding, the
// model still says BLOCKED). Deciding on the marker alone would send the gate to
// the picker with a failReason that no longer describes the tree, skipping the
// re-verify and burning an implementation re-run on findings already gone.
test('a BLOCKED child whose fix DID converge is still applied — the check decides', async () => {
    const {git} = fakeGit({
        diff: ['src/a.ts', 'src/a.ts'],
        'ls-files': ['', ''],
        'write-tree': ['abc123']
    })
    let healthCalls = 0
    const r = await runBoundedLintFix(
        makeDeps({
            git,
            runChild: () => Promise.resolve('LINT-FIX: BLOCKED the generated file is frozen'),
            repoHealth: () => {
                healthCalls++
                return Promise.resolve({ok: true, reason: 'clean'})
            }
        })
    )
    expect(r.ok).toBe(true)
    expect(healthCalls).toBe(1)
})

test('BLOCKED is consulted AFTER the guards — a blocked child that discarded work still trips', async () => {
    // A child can block AND discard. The revert-guard must win, or a blocked
    // early-out would become a way to leave destroyed work in the tree.
    const {git} = fakeGit({
        diff: ['src/a.ts', ''],
        'ls-files': ['', ''],
        'write-tree': ['abc123']
    })
    const r = await runBoundedLintFix(
        makeDeps({git, runChild: () => Promise.resolve('LINT-FIX: BLOCKED gave up')})
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/^revert-guard:/)
})

test('a missing marker is DONE — the re-run stays the arbiter', async () => {
    const {git} = fakeGit({
        diff: ['src/a.ts', 'src/a.ts'],
        'ls-files': ['', ''],
        'write-tree': ['abc123']
    })
    let healthCalls = 0
    const r = await runBoundedLintFix(
        makeDeps({
            git,
            runChild: () => Promise.resolve('I fixed the two unused imports.'),
            repoHealth: () => {
                healthCalls++
                return Promise.resolve({ok: true, reason: 'clean'})
            }
        })
    )
    expect(r.ok).toBe(true)
    expect(healthCalls).toBe(1)
})

test('every guard trip writes exactly one log line', async () => {
    const logs: string[] = []
    const {git} = fakeGit({
        diff: ['src/a.ts', ''],
        'ls-files': ['', ''],
        'write-tree': ['abc123']
    })
    await runBoundedLintFix(makeDeps({git, log: m => logs.push(m)}))
    expect(logs.filter(l => l.includes('REVERT-GUARD'))).toHaveLength(1)
})

test('a cancel still propagates rather than becoming a child error', async () => {
    const {git} = fakeGit({diff: ['', ''], 'ls-files': ['', ''], 'write-tree': ['abc123']})
    await expect(
        runBoundedLintFix(
            makeDeps({git, runChild: () => Promise.reject(new Error(USER_CANCELLED))})
        )
    ).rejects.toThrow(USER_CANCELLED)
})
