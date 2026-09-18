/**
 * health-baseline — the differential that decides whose defect a red static check
 * is, the capture that must leave the tree as it found it, and the lazy baseline
 * that reads HEAD without touching the real index.
 *
 * The git-backed halves run against real throwaway repos: "leaves the tree clean"
 * and "removes the worktree" are claims about git, and a fake git would assert
 * only that this file agrees with itself.
 */
import {describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {tmpDir} from '../test-utils/tmp-dir.js'
import {makeGit} from '../../src/shared/git-runner.js'
import {
    captureHealthBaseline,
    classifyHealthDelta,
    formatHealthBaseline,
    inheritedHealthFindings,
    lazyHealthBaseline,
    parseHealthBaseline,
    type HealthBaseline
} from '../../src/task/health-baseline.js'
import type {HealthCommandResult, HealthOutcome} from '../../src/task/repo-health-check.js'

const git = (dir: string, ...args: string[]): void => {
    const r = Bun.spawnSync(['git', ...args], {cwd: dir})
    if (r.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.toString()}`)
}

function makeRepo(files: Record<string, string> = {'a.ts': 'export const a = 1\n'}): string {
    const dir = tmpDir('health-baseline-')
    git(dir, 'init', '-q')
    git(dir, 'config', 'user.email', 't@t')
    git(dir, 'config', 'user.name', 't')
    git(dir, 'config', 'core.autocrlf', 'false')
    for (const [rel, body] of Object.entries(files)) {
        const p = path.join(dir, rel)
        fs.mkdirSync(path.dirname(p), {recursive: true})
        fs.writeFileSync(p, body)
    }
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'initial')
    return dir
}

const porcelain = (dir: string): string =>
    Bun.spawnSync(['git', 'status', '--porcelain'], {cwd: dir}).stdout.toString().trim()

const cmd = (
    name: string,
    result: HealthCommandResult['outcome'],
    exitCode: number | null
): HealthCommandResult => ({cmd: name, outcome: result, exitCode})

function outcome(ok: boolean, commands: HealthCommandResult[], reason = 'r'): HealthOutcome {
    return {ok, reason, ecosystem: 'package.json', commands, output: ''}
}

const LINT_RED = outcome(false, [cmd('bun run lint', 'fail', 1)], '`bun run lint` exited 1')
const LINT_GREEN = outcome(true, [cmd('bun run lint', 'pass', 0)])

describe('classifyHealthDelta', () => {
    test('a passing result is clean whatever the baseline said', () => {
        expect(classifyHealthDelta(LINT_RED, LINT_GREEN)).toBe('clean')
        expect(classifyHealthDelta(LINT_GREEN, LINT_GREEN)).toBe('clean')
        expect(classifyHealthDelta(null, LINT_GREEN)).toBe('clean')
    })

    test('clean before, red after → regressed (this task broke it)', () => {
        expect(classifyHealthDelta(LINT_GREEN, LINT_RED)).toBe('regressed')
    })

    test('the SAME command failing the SAME way → pre-existing', () => {
        expect(classifyHealthDelta(LINT_RED, LINT_RED)).toBe('pre-existing')
    })

    test('a DIFFERENT command failing → regressed, though both runs are red overall', () => {
        // The whole reason the comparison is per command: `ok` cannot tell a repo
        // whose lint was already broken from a task that broke typecheck on top.
        const after = outcome(false, [
            cmd('bun run lint', 'fail', 1),
            cmd('bun run typecheck', 'fail', 2)
        ])
        expect(classifyHealthDelta(LINT_RED, after)).toBe('regressed')
    })

    test('the same command failing with a DIFFERENT exit code → regressed', () => {
        // eslint exits 1 for findings and 2 when it could not run at all; a repo
        // that went from findings to unrunnable regressed.
        const after = outcome(false, [cmd('bun run lint', 'fail', 2)])
        expect(classifyHealthDelta(LINT_RED, after)).toBe('regressed')
    })

    test('a NULL baseline is regressed — absence of evidence is not evidence', () => {
        expect(classifyHealthDelta(null, LINT_RED)).toBe('regressed')
    })

    test('without per-command detail the overall verdict decides', () => {
        expect(classifyHealthDelta({ok: false}, {ok: false})).toBe('pre-existing')
        expect(classifyHealthDelta({ok: true}, {ok: false})).toBe('regressed')
    })

    test('a skipped command is not a failing one', () => {
        // A tool that is not installed is an environment gap, not a red check, so
        // a baseline that skipped it does not excuse a later real failure.
        const before = outcome(true, [cmd('bun run lint', 'skip', null)])
        expect(classifyHealthDelta(before, LINT_RED)).toBe('regressed')
    })
})

describe('classifyHealthDelta — the test suite', () => {
    const suite = (
        testOutcome: 'pass' | 'fail',
        exitCode: number | null
    ): HealthCommandResult[] => [
        {cmd: 'bun run lint', outcome: 'pass', exitCode: 0},
        {cmd: 'bun run test', outcome: testOutcome, exitCode}
    ]
    test('a suite the baseline saw green and the task turned red is REGRESSED, whatever the spec says', () => {
        expect(
            classifyHealthDelta(
                {ok: true, commands: suite('pass', 0)},
                {ok: false, commands: suite('fail', 1)}
            )
        ).toBe('regressed')
    })
    test('a suite that needs a database fails the same way before and after: pre-existing', () => {
        expect(
            classifyHealthDelta(
                {ok: false, commands: suite('fail', 1)},
                {ok: false, commands: suite('fail', 1)}
            )
        ).toBe('pre-existing')
    })
})

describe('inheritedHealthFindings', () => {
    test('names each failing command and its exit code', () => {
        expect(inheritedHealthFindings(LINT_RED)).toEqual([
            '`bun run lint` exits 1 (and did before this task)'
        ])
    })

    test('a clean result contributes nothing', () => {
        expect(inheritedHealthFindings(LINT_GREEN)).toEqual([])
    })
})

describe('the task-file section', () => {
    const baseline: HealthBaseline = {
        at: '2026-09-16T00:00:00.000Z',
        treeHash: 'abc123',
        outcome: {...LINT_RED, output: 'src/a.ts:1:1  error  Parsing error'}
    }

    test('round-trips through the section text', () => {
        const back = parseHealthBaseline(formatHealthBaseline(baseline))
        expect(back?.at).toBe(baseline.at)
        expect(back?.treeHash).toBe('abc123')
        expect(back?.outcome.ok).toBe(false)
        expect(back?.outcome.commands).toEqual(baseline.outcome.commands)
        expect(classifyHealthDelta(back?.outcome ?? null, LINT_RED)).toBe('pre-existing')
    })

    test('the captured command OUTPUT is not committed to the task file', () => {
        // Up to 40 lines of a linter's report, in a file committed with every task,
        // for a field the differential never reads.
        expect(formatHealthBaseline(baseline)).not.toContain('Parsing error')
    })

    test('an absent or unparseable section is no baseline, never a fabricated clean one', () => {
        expect(parseHealthBaseline(null)).toBeNull()
        expect(parseHealthBaseline('')).toBeNull()
        expect(parseHealthBaseline('not json at all')).toBeNull()
        expect(parseHealthBaseline('```json\n{"at":"x"}\n```')).toBeNull()
    })
})

describe('captureHealthBaseline', () => {
    test('a health command that EDITS the tree leaves `git status` clean', async () => {
        // `lint` scripts commonly run `--fix`. Without the discard the task starts
        // on a tree the baseline authored.
        const dir = makeRepo()
        const runner = makeGit(dir)
        const b = await captureHealthBaseline({
            runHealth: () => {
                fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 2 // fixed\n')
                fs.writeFileSync(path.join(dir, 'new.ts'), 'export const n = 1\n')
                return Promise.resolve(LINT_GREEN)
            },
            treeHash: async () => (await runner(['rev-parse', 'HEAD^{tree}'])).stdout.trim(),
            discardEdits: async () => {
                await runner(['checkout', '--', '.'])
                await runner(['clean', '-fd'])
            }
        })
        expect(porcelain(dir)).toBe('')
        expect(fs.existsSync(path.join(dir, 'new.ts'))).toBe(false)
        expect(b.outcome.ok).toBe(true)
        expect(b.treeHash).toMatch(/^[0-9a-f]{40}$/)
    })

    test('the edits are discarded even when the health run throws', async () => {
        let discarded = 0
        await expect(
            captureHealthBaseline({
                runHealth: () => Promise.reject(new Error('lint exploded')),
                treeHash: () => Promise.resolve(null),
                discardEdits: () => {
                    discarded++
                    return Promise.resolve()
                }
            })
        ).rejects.toThrow('lint exploded')
        expect(discarded).toBe(1)
    })

    test('the tree is hashed BEFORE the health run, not after its edits', async () => {
        const order: string[] = []
        await captureHealthBaseline({
            runHealth: () => {
                order.push('health')
                return Promise.resolve(LINT_GREEN)
            },
            treeHash: () => {
                order.push('hash')
                return Promise.resolve('t')
            },
            discardEdits: () => {
                order.push('discard')
                return Promise.resolve()
            }
        })
        expect(order).toEqual(['hash', 'health', 'discard'])
    })
})

describe('lazyHealthBaseline', () => {
    test('runs health in a detached worktree at HEAD and REMOVES it afterwards', async () => {
        const dir = makeRepo()
        // Uncommitted work, as at verify time: the baseline must describe HEAD, not this.
        fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 999\n')
        const runner = makeGit(dir)
        let seen = ''
        const b = await lazyHealthBaseline({
            git: runner,
            runHealthIn: d => {
                seen = fs.readFileSync(path.join(d, 'a.ts'), 'utf8')
                return Promise.resolve(LINT_RED)
            }
        })
        expect(seen).toBe('export const a = 1\n') // HEAD, not the dirty tree
        expect(b?.outcome.ok).toBe(false)
        expect(b?.treeHash).toMatch(/^[0-9a-f]{40}$/)
        // The worktree is gone from git's admin records AND from disk.
        const list = await runner(['worktree', 'list', '--porcelain'])
        expect(list.stdout).not.toContain('pi-task-health-')
        expect(list.stdout.split('worktree ').length - 1).toBe(1)
    })

    test('the real index and working tree are untouched', async () => {
        const dir = makeRepo()
        fs.writeFileSync(path.join(dir, 'staged.ts'), 'export const s = 1\n')
        git(dir, 'add', 'staged.ts')
        const before = porcelain(dir)
        await lazyHealthBaseline({
            git: makeGit(dir),
            runHealthIn: () => Promise.resolve(LINT_RED)
        })
        expect(porcelain(dir)).toBe(before)
        expect(before).toContain('staged.ts')
    })

    test('the worktree is removed even when the health run WROTE into it', async () => {
        // A `--fix` script, a build cache: plain `worktree remove` refuses these.
        const dir = makeRepo()
        const runner = makeGit(dir)
        await lazyHealthBaseline({
            git: runner,
            runHealthIn: d => {
                fs.writeFileSync(path.join(d, 'a.ts'), 'export const a = 7\n')
                fs.mkdirSync(path.join(d, 'node_modules'), {recursive: true})
                return Promise.resolve(LINT_RED)
            }
        })
        const list = await runner(['worktree', 'list', '--porcelain'])
        expect(list.stdout.split('worktree ').length - 1).toBe(1)
    })

    test('a repo git cannot add a worktree to yields null, not a throw', async () => {
        const notARepo = tmpDir('health-baseline-nogit-')
        expect(
            await lazyHealthBaseline({
                git: makeGit(notARepo),
                runHealthIn: () => Promise.resolve(LINT_GREEN)
            })
        ).toBeNull()
    })
})
