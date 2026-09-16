/**
 * run-context tests — the per-run facts, and the two hashes that invalidate them.
 *
 * What is being held in place here:
 *   • verify-tooling is asked ONCE per run, not once per task. The real run this
 *     came from spawned it 21 times and got 21 answers to one question.
 *   • a manifest edit — a new script — is the one thing that makes it ask again.
 *   • `treeHash` measures the worktree through a THROWAWAY index. A probe that
 *     staged the user's work to measure it would have changed what it measured, so
 *     the real index's bytes and mtime are asserted across the call.
 */
import {describe, expect, test} from 'bun:test'
import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as nodePath from 'node:path'
import {withTmpTaskDir} from '../test-utils/tmp-task-dir.js'
import {writeTaskFile, readSection} from '../../src/task/task-io.js'
import {phaseVerifyTooling} from '../../src/task/phases.js'
import type {PhaseDeps} from '../../src/task/child-runner.js'
import {
    manifestHash,
    openRunContext,
    closeRunContext,
    currentRunContext,
    treeHash,
    RunContext,
    NOT_RUN
} from '../../src/task/run-context.js'

const RESEARCH = 'FILES\nsrc/a.ts\n\nTOOLING\nbun run lint\nbun run dev\n'

const VERIFY_OUTPUT = [
    'VERIFIED',
    '  bun run lint  check  package.json scripts.lint',
    '  bun run dev  serve  package.json scripts.dev',
    '',
    'REJECTED'
].join('\n')

async function seedTask(cwd: string, id: string): Promise<void> {
    await writeTaskFile(
        cwd,
        {
            id,
            state: 'in_progress',
            phase: 'research',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            title: 't'
        },
        '\n'
    )
}

function deps(cwd: string, taskId: string, runContext: RunContext, spawned: string[]): PhaseDeps {
    return {
        cwd,
        taskId,
        signal: new AbortController().signal,
        runContext,
        runChild: (name, _tools, prompt) => {
            spawned.push(`${name}:${prompt.length}`)
            return Promise.resolve(VERIFY_OUTPUT)
        }
    }
}

describe('verified tooling', () => {
    test('two tasks, one manifest, ONE verify-tooling child', async () => {
        await withTmpTaskDir(async cwd => {
            fs.writeFileSync(
                nodePath.join(cwd, 'package.json'),
                JSON.stringify({scripts: {lint: 'eslint .', dev: 'bun --watch x.ts'}})
            )
            const rc = new RunContext({cwd})
            const spawned: string[] = []

            await seedTask(cwd, 'TASK_0001')
            const first = await phaseVerifyTooling(deps(cwd, 'TASK_0001', rc, spawned), RESEARCH)
            await seedTask(cwd, 'TASK_0002')
            const second = await phaseVerifyTooling(deps(cwd, 'TASK_0002', rc, spawned), RESEARCH)

            expect(spawned).toHaveLength(1)
            expect(first).toContain('bun run lint')
            expect(second).toContain('bun run lint')
            // Provenance is still per task, filled from the run's verdicts.
            expect(await readSection(cwd, 'TASK_0002', 'verified tooling')).toContain(
                'bun run dev  serve'
            )
            expect(rc.verifiedTooling.map(v => v.class)).toEqual(['check', 'serve'])
            expect(rc.verifiedTooling[0].exitCode).toBe(NOT_RUN)
            expect(rc.verifiedTooling[0].cwd).toBe(cwd)
        })
    })

    test('a manifest edit drops the verdicts and asks again', async () => {
        await withTmpTaskDir(async cwd => {
            const manifest = nodePath.join(cwd, 'package.json')
            fs.writeFileSync(manifest, JSON.stringify({scripts: {lint: 'eslint .'}}))
            const rc = new RunContext({cwd})
            const spawned: string[] = []

            await seedTask(cwd, 'TASK_0001')
            await phaseVerifyTooling(deps(cwd, 'TASK_0001', rc, spawned), RESEARCH)
            fs.writeFileSync(
                manifest,
                JSON.stringify({scripts: {lint: 'eslint .', typecheck: 'tsc --noEmit'}})
            )
            await seedTask(cwd, 'TASK_0002')
            await phaseVerifyTooling(deps(cwd, 'TASK_0002', rc, spawned), RESEARCH)

            expect(spawned).toHaveLength(2)
            expect(rc.verifiedTooling).toHaveLength(2)
        })
    })

    test('a child that failed is not cached as a verdict', async () => {
        await withTmpTaskDir(async cwd => {
            fs.writeFileSync(nodePath.join(cwd, 'package.json'), '{}')
            const rc = new RunContext({cwd})
            const spawned: string[] = []
            await seedTask(cwd, 'TASK_0001')
            const out = await phaseVerifyTooling(
                {
                    ...deps(cwd, 'TASK_0001', rc, spawned),
                    runChild: () => Promise.reject(new Error('child died'))
                },
                RESEARCH
            )
            // The list ships unverified, and the next task asks again.
            expect(out).toContain('bun run dev')
            await seedTask(cwd, 'TASK_0002')
            await phaseVerifyTooling(deps(cwd, 'TASK_0002', rc, spawned), RESEARCH)
            expect(spawned).toHaveLength(1)
        })
    })
})

describe('manifestHash', () => {
    test('moves on a manifest edit, ignores source', async () => {
        await withTmpTaskDir(async cwd => {
            fs.writeFileSync(nodePath.join(cwd, 'package.json'), '{"scripts":{}}')
            const before = await manifestHash(cwd)
            fs.writeFileSync(nodePath.join(cwd, 'a.ts'), 'export const a = 1\n')
            expect(await manifestHash(cwd)).toBe(before)
            fs.writeFileSync(nodePath.join(cwd, 'package.json'), '{"scripts":{"lint":"x"}}')
            expect(await manifestHash(cwd)).not.toBe(before)
        })
    })

    test('a project with no manifest at all still hashes', async () => {
        await withTmpTaskDir(async cwd => {
            expect(await manifestHash(cwd)).toMatch(/^[0-9a-f]{64}$/)
        })
    })
})

describe('treeHash', () => {
    const git = (cwd: string, ...args: string[]): string =>
        spawnSync('git', args, {cwd, encoding: 'utf8'}).stdout

    test('measures the worktree and leaves the real index untouched', async () => {
        await withTmpTaskDir(async cwd => {
            git(cwd, 'init', '-q')
            git(cwd, 'config', 'user.email', 't@t')
            git(cwd, 'config', 'user.name', 't')
            fs.writeFileSync(nodePath.join(cwd, 'tracked.ts'), 'export const a = 1\n')
            git(cwd, 'add', 'tracked.ts')
            git(cwd, 'commit', '-qm', 'first')
            // One staged edit and one untracked file: the states a probe could disturb.
            fs.writeFileSync(nodePath.join(cwd, 'tracked.ts'), 'export const a = 2\n')
            git(cwd, 'add', 'tracked.ts')
            fs.writeFileSync(nodePath.join(cwd, 'untracked.ts'), 'export const b = 1\n')

            // `git status` refreshes the real index (it rewrites the stat cache), so
            // it runs BEFORE the baseline is taken or it would look like the probe's
            // own doing.
            const statusBefore = git(cwd, 'status', '--porcelain')
            const indexPath = nodePath.join(cwd, '.git', 'index')
            const indexBefore = fs.readFileSync(indexPath)
            const mtimeBefore = fs.statSync(indexPath).mtimeMs

            const hash = await treeHash(cwd)
            expect(hash).toMatch(/^[0-9a-f]{40}$/)

            expect(fs.readFileSync(indexPath).equals(indexBefore)).toBe(true)
            expect(fs.statSync(indexPath).mtimeMs).toBe(mtimeBefore)
            expect(git(cwd, 'diff', '--cached', '--name-only')).toBe('tracked.ts\n')
            expect(git(cwd, 'status', '--porcelain')).toBe(statusBefore)
            // The untracked file IS in the measured tree — that is the point of `add -A`.
            expect(hash).not.toBe(git(cwd, 'rev-parse', 'HEAD^{tree}').trim())
            expect(git(cwd, 'ls-tree', '--name-only', hash!).split('\n')).toContain('untracked.ts')
        })
    })

    test('a content change moves it; a `.pi-tasks/` write does not', async () => {
        await withTmpTaskDir(async cwd => {
            git(cwd, 'init', '-q')
            fs.writeFileSync(nodePath.join(cwd, 'a.ts'), 'export const a = 1\n')
            const first = await treeHash(cwd)
            fs.mkdirSync(nodePath.join(cwd, '.pi-tasks'), {recursive: true})
            fs.writeFileSync(nodePath.join(cwd, '.pi-tasks', 'debug.log'), 'noise\n')
            expect(await treeHash(cwd)).toBe(first)
            fs.writeFileSync(nodePath.join(cwd, 'a.ts'), 'export const a = 2\n')
            expect(await treeHash(cwd)).not.toBe(first)
        })
    })

    test('a non-repo answers null rather than throwing', async () => {
        await withTmpTaskDir(async cwd => {
            expect(await treeHash(cwd)).toBeNull()
        })
    })
})

describe('the open run', () => {
    test('one context for the run, a fresh one outside it', () => {
        const opened = openRunContext('/x')
        expect(currentRunContext('/x')).toBe(opened)
        // A nested bracket joins the run it is inside.
        expect(openRunContext('/x')).toBe(opened)
        // Another project is another run.
        expect(currentRunContext('/y')).not.toBe(opened)
        closeRunContext(opened)
        expect(currentRunContext('/x')).not.toBe(opened)
    })

    test('every run is identified', () => {
        const a = new RunContext({cwd: '/x'})
        expect(a.runId.length).toBeGreaterThan(0)
        expect(new RunContext({cwd: '/x'}).runId).not.toBe(a.runId)
        expect(new RunContext({cwd: '/x', runId: 'resumed'}).runId).toBe('resumed')
    })
})
