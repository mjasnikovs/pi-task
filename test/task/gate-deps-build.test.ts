/**
 * buildGateDeps — the closures the gate sequence calls.
 *
 * The git-backed deps run against real throwaway worktrees, including their
 * degrade paths: outside a repo, `repoFiles` and `touchedFiles` answer null and
 * `frozenPaths` answers [], rather than guessing.
 *
 * The child-spawning deps (verify, enforce, recommend, lintFix, finalGateFix)
 * are not driven here — they need a live pi child. Verify's and enforce's
 * disabled-by-config short circuits are, because those must never reach one. So
 * is `buildVerifyProbes`, the one place the collectors are bound to the probe
 * table, against a real worktree and a fake child.
 */

import {afterEach, beforeEach, describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    buildGateDeps,
    buildVerifyProbes,
    readSpecForVerification
} from '../../src/task/gate-deps.js'
import {BOUND_PROBE_KEYS, runWorkVerification} from '../../src/task/verify-work.js'
import type {GateDeps} from '../../src/task/task-gates.js'
import {getConfig} from '../../src/config/config.js'
import {readSection, writeTaskFile} from '../../src/task/task-io.js'
import {makeFakeCtx} from '../test-utils/fake-ctx.js'

const git = (dir: string, ...args: string[]): void => {
    const r = Bun.spawnSync(['git', ...args], {cwd: dir})
    if (r.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.toString()}`)
}

function write(dir: string, files: Record<string, string>): void {
    for (const [rel, body] of Object.entries(files)) {
        const p = path.join(dir, rel)
        fs.mkdirSync(path.dirname(p), {recursive: true})
        fs.writeFileSync(p, body)
    }
}

function makeRepo(files: Record<string, string> = {'a.ts': 'export const a = 1\n'}): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-build-'))
    git(dir, 'init', '-q')
    git(dir, 'config', 'user.email', 't@t')
    git(dir, 'config', 'user.name', 't')
    // Repo-level, so every git restore below (revert, discardEdits,
    // revertFrozenPaths) hands back the LF bytes these fixtures assert.
    git(dir, 'config', 'core.autocrlf', 'false')
    write(dir, files)
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'task: initial deliverable (TASK_0020)')
    return dir
}

const noGit = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'gate-build-nogit-'))

/** Drops the optional markers so a test can call a dep without `!`. The markers
 *  on GateDeps exist for the partial ones the gate tests hand-build. */
type AllDeps = {[K in keyof GateDeps]-?: GateDeps[K]}

/** buildGateDeps with a runTask that must never be reached in these tests. */
function deps(signal = new AbortController().signal): AllDeps {
    return buildGateDeps({
        signal,
        parentContextWindow: 128_000,
        runTask: () => {
            throw new Error('runTask must not be called here')
        }
    }) as AllDeps
}

async function writeSpec(cwd: string, id: string, spec: string): Promise<void> {
    const now = new Date(0).toISOString()
    await writeTaskFile(
        cwd,
        {
            id,
            state: 'in_progress',
            phase: 'compose',
            created_at: now,
            updated_at: now,
            title: 'a task'
        },
        `## spec\n${spec}\n`
    )
}

let savedAutoCommit: boolean
let savedEnforce: boolean
let savedVerify: boolean

beforeEach(() => {
    savedAutoCommit = getConfig().autoCommit
    savedEnforce = getConfig().enforceGuidelines
    savedVerify = getConfig().verifyWork
})
afterEach(() => {
    getConfig().autoCommit = savedAutoCommit
    getConfig().enforceGuidelines = savedEnforce
    getConfig().verifyWork = savedVerify
})

describe('the config short circuits — a disabled gate never reaches a child', () => {
    test('enforce reports ok/disabled without spawning anything', async () => {
        getConfig().enforceGuidelines = false
        expect(await deps().enforce({} as never, makeRepo(), 'a task', 'edit')).toEqual({
            ok: true,
            reason: 'disabled'
        })
    })

    test('verify reports ok/disabled without spawning anything', async () => {
        getConfig().verifyWork = false
        expect(await deps().verify({} as never, makeRepo(), 'a task', 'TASK_0001')).toEqual({
            ok: true,
            reason: 'disabled'
        })
    })

    test('commit refuses when auto-commit is off, and leaves the tree dirty', async () => {
        getConfig().autoCommit = false
        const dir = makeRepo()
        write(dir, {'a.ts': 'export const a = 2\n'})

        expect(await deps().commit(dir, 'task: work')).toEqual({
            committed: false,
            reason: 'auto-commit disabled'
        })
        expect(await deps().dirty(dir)).toBe(true)
    })
})

describe('commit / revert / dirty / discardEdits', () => {
    test('commit stages everything and revert drops it again', async () => {
        getConfig().autoCommit = true
        const d = deps()
        const dir = makeRepo()
        write(dir, {'a.ts': 'export const a = 2\n', 'new.ts': 'export const n = 1\n'})

        expect((await d.commit(dir, 'task: work')).committed).toBe(true)
        expect(await d.dirty(dir)).toBe(false)

        await d.revert(dir)

        expect(fs.readFileSync(path.join(dir, 'a.ts'), 'utf8')).toBe('export const a = 1\n')
        expect(fs.existsSync(path.join(dir, 'new.ts'))).toBe(false)
    })

    test('dirty ignores the gate’s own .pi-tasks bookkeeping', async () => {
        const dir = makeRepo()
        write(dir, {'.pi-tasks/TASK_0001.md': '# spec\n'})
        expect(await deps().dirty(dir)).toBe(false)
    })

    test('discardEdits restores tracked files, drops new ones, keeps the task trail', async () => {
        const dir = makeRepo()
        write(dir, {
            'a.ts': 'export const a = 999\n',
            'stray.ts': 'export const s = 1\n',
            '.pi-tasks/verify-debug.log': 'the log of the pass being discarded\n'
        })

        await deps().discardEdits(dir)

        expect(fs.readFileSync(path.join(dir, 'a.ts'), 'utf8')).toBe('export const a = 1\n')
        expect(fs.existsSync(path.join(dir, 'stray.ts'))).toBe(false)
        expect(fs.existsSync(path.join(dir, '.pi-tasks/verify-debug.log'))).toBe(true)
    })
})

describe('the attribution deps', () => {
    test('repoFiles lists tracked files, and answers null outside a repo', async () => {
        const dir = makeRepo({'a.ts': 'x\n', 'src/b.ts': 'y\n'})
        expect((await deps().repoFiles(dir))?.sort()).toEqual(['a.ts', 'src/b.ts'])
        expect(await deps().repoFiles(noGit())).toBeNull()
    })

    test('touchedFiles(worktree) is the uncommitted change set', async () => {
        const dir = makeRepo()
        write(dir, {'a.ts': 'export const a = 2\n', 'new.ts': 'n\n'})
        fs.rmSync(path.join(dir, 'a.ts'))
        write(dir, {'other.ts': 'o\n'})

        const touched = await deps().touchedFiles(dir, 'worktree')

        expect(touched?.sort()).toEqual(['a.ts', 'new.ts', 'other.ts'])
    })

    test('touchedFiles(enforce-commit) is HEAD ALONE — the enforce commit’s own diff', async () => {
        const dir = makeRepo()
        write(dir, {'snapshot.ts': 's\n'})
        git(dir, 'add', '-A')
        git(dir, 'commit', '-qm', 'task snapshot')
        write(dir, {'enforced.ts': 'e\n'})
        git(dir, 'add', '-A')
        git(dir, 'commit', '-qm', 'enforce')

        expect(await deps().touchedFiles(dir, 'enforce-commit')).toEqual(['enforced.ts'])
        // 'committed' spans the snapshot AND the enforce commit.
        expect((await deps().touchedFiles(dir, 'committed'))?.sort()).toEqual([
            'enforced.ts',
            'snapshot.ts'
        ])
    })

    test('touchedFiles stands the channel down (null) outside a repo', async () => {
        expect(await deps().touchedFiles(noGit(), 'worktree')).toBeNull()
        expect(await deps().touchedFiles(noGit(), 'committed')).toBeNull()
    })

    test('introducedBy names the task whose commit added the file', async () => {
        const dir = makeRepo()
        expect(await deps().introducedBy(dir, 'a.ts')).toBe('TASK_0020')
        expect(await deps().introducedBy(dir, 'never-existed.ts')).toBeNull()
    })

    test('record appends the verdict to the task file’s gates section', async () => {
        const dir = makeRepo()
        await writeSpec(dir, 'TASK_0001', 'do the thing')

        await deps().record(dir, 'TASK_0001', 'verify: PASS')
        await deps().record(dir, 'TASK_0001', 'enforce: kept')

        const gates = await readSection(dir, 'TASK_0001', 'gates')
        expect(gates).toContain('verify: PASS')
        expect(gates).toContain('enforce: kept')
    })
})

/**
 * repoHealth is the one non-git, non-child dep. It wraps `runRepoHealthCheck` in
 * a `startAutoLoader` whose frame is the only place the running command's name is
 * exposed, and stops it in a `.finally` so the loader comes down on either verdict.
 */
describe('repoHealth', () => {
    /** Every widget line this run painted, flattened. */
    const painted = (fake: ReturnType<typeof makeFakeCtx>): string =>
        fake.captured.widgets.map(w => (Array.isArray(w.state) ? w.state.join(' ') : '')).join('\n')

    test("runs the project's own lint under a loader that names the command", async () => {
        // Longer than WIDGET_REFRESH_MS, so a tick lands DURING the lint. The dep's
        // `onCommand` only writes a local the loader frame reads, so that tick is
        // the sole observation point for the command name.
        const dir = makeRepo({'package.json': JSON.stringify({scripts: {lint: 'sleep 0.8'}})})
        const fake = makeFakeCtx(dir)

        const outcome = await deps().repoHealth(fake.ctx, dir, 'a task')

        expect(outcome.ok).toBe(true)
        expect(painted(fake)).toContain('bun run lint')
    })

    test('a project with no static checks answers without running anything', async () => {
        const dir = makeRepo()
        const fake = makeFakeCtx(dir)

        const outcome = await deps().repoHealth(fake.ctx, dir, 'a task')

        expect(outcome.ok).toBe(true)
        // The loader still went up: the first paint is synchronous, before any command.
        expect(painted(fake)).toContain('repo health')
    })

    test('a failing lint is reported, and the loader still comes down', async () => {
        const dir = makeRepo({'package.json': JSON.stringify({scripts: {lint: 'exit 1'}})})
        const fake = makeFakeCtx(dir)

        expect((await deps().repoHealth(fake.ctx, dir, 'a task')).ok).toBe(false)
        // A loader left running would keep ticking past the verdict.
        const after = fake.captured.widgets.length
        await Bun.sleep(150)
        expect(fake.captured.widgets.length).toBe(after)
    })
})

describe('the frozen-path deps', () => {
    const SPEC = 'Implement the feature. Do not modify `tsconfig.json` or `src/vendor/`.'

    test('frozenPaths reads the spec’s own prohibitions', async () => {
        const dir = makeRepo()
        await writeSpec(dir, 'TASK_0001', SPEC)
        expect((await deps().frozenPaths(dir, 'TASK_0001')).sort()).toEqual([
            'src/vendor',
            'tsconfig.json'
        ])
    })

    test('frozenPaths degrades to no fence when the task file is unreadable', async () => {
        expect(await deps().frozenPaths(makeRepo(), 'TASK_9999')).toEqual([])
    })

    test('a spec that froze nothing makes the guard a no-op', async () => {
        const dir = makeRepo()
        await writeSpec(dir, 'TASK_0001', 'Implement the feature.')
        expect(await deps().frozenPaths(dir, 'TASK_0001')).toEqual([])
    })

    test('revertFrozenPaths undoes edits to the frozen files and nothing else', async () => {
        const dir = makeRepo({
            'tsconfig.json': '{"strict": true}\n',
            'a.ts': 'export const a = 1\n'
        })
        write(dir, {
            'tsconfig.json': '{"strict": false}\n',
            'a.ts': 'export const a = 2\n' // a legitimate edit outside the fence
        })

        const reverted = await deps().revertFrozenPaths(dir, ['tsconfig.json'])

        expect(reverted).toEqual(['tsconfig.json'])
        expect(fs.readFileSync(path.join(dir, 'tsconfig.json'), 'utf8')).toBe('{"strict": true}\n')
        expect(fs.readFileSync(path.join(dir, 'a.ts'), 'utf8')).toBe('export const a = 2\n')
    })

    test('revertFrozenPaths reports nothing when the fence was respected', async () => {
        const dir = makeRepo({'tsconfig.json': '{"strict": true}\n'})
        expect(await deps().revertFrozenPaths(dir, ['tsconfig.json'])).toEqual([])
        expect(await deps().revertFrozenPaths(dir, [])).toEqual([])
    })
})

describe('readSpecForVerification — the one spec read every gate site shares', () => {
    test('returns the composed spec section, and null when there is none to hold the work to', async () => {
        const dir = makeRepo()
        await writeSpec(dir, 'TASK_0001', 'GOAL\nship it\n\nVERIFY:\n```sh\nbun test\n```')
        expect(await readSpecForVerification(dir, 'TASK_0001')).toBe(
            'GOAL\nship it\n\nVERIFY:\n```sh\nbun test\n```'
        )
        // No task file at all → null, never a throw.
        expect(await readSpecForVerification(dir, 'TASK_0099')).toBeNull()
        // A task that never reached compose has no spec section → null.
        const now = new Date(0).toISOString()
        await writeTaskFile(
            dir,
            {
                id: 'TASK_0002',
                state: 'in_progress',
                phase: 'refine',
                created_at: now,
                updated_at: now,
                title: 't'
            },
            '## refined\nsome prose\n'
        )
        expect(await readSpecForVerification(dir, 'TASK_0002')).toBeNull()
    })
})

describe('buildVerifyProbes — the one place the collectors meet the probe table', () => {
    const params = (cwd: string, spec: string | null = null) => ({
        cwd,
        taskId: 'TASK_0021',
        spec
    })

    test('binds exactly the channels the table reads, and building runs nothing', () => {
        // A bound table row with no binding here is invisible to tsc — VerifyProbes
        // marks every key optional — so this equality is the only thing that catches
        // it. Deleting one binding from buildVerifyProbes fails this test, not the build.
        const probes = buildVerifyProbes(params(noGit()))
        expect(Object.keys(probes).sort()).toEqual([...BOUND_PROBE_KEYS].sort())
        for (const key of BOUND_PROBE_KEYS) expect(typeof probes[key]).toBe('function')
    })

    test('every probe is lazy and degrades to empty on a non-git dir — no thunk rejects', async () => {
        const probes = buildVerifyProbes(params(noGit(), 'Do NOT modify `a.ts`.'))
        for (const key of BOUND_PROBE_KEYS) {
            // Each collector owns its own degrade path (git fault → []); the table
            // loop would swallow a rejection anyway, but the collectors never
            // hand it one.
            expect(await probes[key]!()).toEqual([])
        }
    })

    test('the bound probes reach the verify prompt through the table (substitution + prohibition)', async () => {
        // A task that authors its own test AND edits a spec-forbidden file: the
        // substitution probe (git shape) and the prohibition probe (spec + git
        // shape) must both surface as notices, proving the binding is wired end
        // to end without a live child.
        const dir = makeRepo({
            'src/app.ts': 'export const app = () => 1\n',
            'src/server.ts': 'export const s = 1\n'
        })
        write(dir, {
            'src/app.test.ts': [
                "import {test, expect} from 'bun:test'",
                'const app = () => 1 // re-implemented copy',
                "test('x', () => expect(app()).toBe(1))",
                ''
            ].join('\n'),
            'src/server.ts': 'export const s = 2\n'
        })
        const spec = 'GOAL\nadd a test\n\nCONSTRAINTS\n- Do NOT modify `src/server.ts`.\n'
        let prompt = ''
        const out = await runWorkVerification({
            cwd: dir,
            spec,
            probes: buildVerifyProbes(params(dir, spec)),
            runChild: async (_t, p) => {
                prompt = p
                return 'WORK-VERIFIED: PASS'
            }
        })
        expect(out.ok).toBe(true)
        expect(prompt).toContain('PROHIBITION NOTICE')
        expect(prompt).toContain('src/server.ts')
        expect(prompt).toContain('SELF-VERIFICATION NOTICE')
        expect(prompt).toContain('src/app.test.ts')
    })

    test('a spec that forbids nothing makes the prohibition probe skip git entirely', async () => {
        const probes = buildVerifyProbes(params(makeRepo(), 'GOAL\nno constraints'))
        expect(await probes.prohibition!()).toEqual([])
    })
})
