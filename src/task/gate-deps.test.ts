/**
 * gate-deps tests — the tool-result log summary used by the gate debug log
 * (mx5 run 10 item 6). The summary is pure; the wiring that feeds it real tool
 * output is covered in json-event-sink.test.ts (the sink emits onToolResult).
 */
import {describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    truncateToolResult,
    collectAddedLines,
    collectChangedFiles,
    collectForeignPathFindings,
    collectRunnerGlobFindings,
    collectScriptEscapeFindings,
    collectTaskTreeChanges,
    collectTestAssemblyFindings,
    collectTreeChanges,
    collectIgnoredSnapshot,
    gatePassesWithoutIgnored,
    parseBuildOutdirs
} from './gate-deps.js'
import {diffIgnoredSnapshots} from './write-guard.js'

describe('truncateToolResult', () => {
    test('flattens whitespace to one line', () => {
        expect(truncateToolResult('line one\n  line two\ttabbed')).toBe('line one line two tabbed')
    })

    test('empty / whitespace-only output → (no output)', () => {
        expect(truncateToolResult('')).toBe('(no output)')
        expect(truncateToolResult('   \n\t ')).toBe('(no output)')
    })

    test('keeps the TAIL (where a bind failure / status lands) with a leading ellipsis', () => {
        const long = 'x'.repeat(500) + ' curl: (7) Failed to connect to localhost port 3000'
        const out = truncateToolResult(long, 40)
        expect(out.startsWith('…')).toBe(true)
        expect(out).toContain('port 3000')
        expect(out.length).toBe(41) // ellipsis + 40 tail chars
    })

    test('short output is kept verbatim (no ellipsis)', () => {
        expect(truncateToolResult('HELLO_WORLD_123')).toBe('HELLO_WORLD_123')
    })
})

describe('collectTaskTreeChanges (cross-task deletion probe input)', () => {
    const git = (dir: string, ...args: string[]): void => {
        const r = Bun.spawnSync(['git', ...args], {cwd: dir})
        if (r.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.toString()}`)
    }

    function makeRepo(): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-deps-'))
        git(dir, 'init', '-q')
        git(dir, 'config', 'user.email', 't@t')
        git(dir, 'config', 'user.name', 't')
        fs.writeFileSync(path.join(dir, 'sibling.ts'), 'export const s = 1\n')
        git(dir, 'add', '-A')
        git(dir, 'commit', '-qm', 'task: sibling deliverable (TASK_0020)')
        return dir
    }

    test('pre-commit: working-tree deletions are reported from status', async () => {
        const dir = makeRepo()
        fs.rmSync(path.join(dir, 'sibling.ts'))
        fs.writeFileSync(path.join(dir, 'work.ts'), 'export const w = 1\n')
        const changes = await collectTaskTreeChanges(dir)
        expect(changes.deleted).toEqual(['sibling.ts'])
        expect(changes.added).toEqual(['work.ts'])
    })

    test('clean tree (post-enforce re-verify): falls back to the LAST commit diff', async () => {
        const dir = makeRepo()
        git(dir, 'rm', '-q', 'sibling.ts')
        git(dir, 'commit', '-qm', 'task: current work (TASK_0021)')
        const changes = await collectTaskTreeChanges(dir)
        expect(changes.deleted).toEqual(['sibling.ts'])
    })

    test('clean tree with no deletion in the last commit → nothing reported', async () => {
        const dir = makeRepo()
        fs.writeFileSync(path.join(dir, 'work.ts'), 'export const w = 1\n')
        git(dir, 'add', '-A')
        git(dir, 'commit', '-qm', 'task: current work (TASK_0021)')
        const changes = await collectTaskTreeChanges(dir)
        expect(changes.deleted).toEqual([])
        expect(changes.added).toEqual(['work.ts'])
    })
})

/**
 * IGNORED-PATH CHANNEL (mx5 run 19) — the impure half, against real repos:
 * `--ignored=matching` collapsing, the exemption in situ, the degrade path, and
 * the dependency probe's move/restore discipline. Pins the A/B invariants
 * (scripts/ignored-writes-ab.ts) that need a worktree rather than a string.
 */
describe('collectIgnoredSnapshot / gatePassesWithoutIgnored', () => {
    const git = (dir: string, ...args: string[]): void => {
        const r = Bun.spawnSync(['git', ...args], {cwd: dir})
        if (r.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.toString()}`)
    }

    function makeRepo(files: Record<string, string>): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ignored-writes-'))
        git(dir, 'init', '-q')
        git(dir, 'config', 'user.email', 't@t')
        git(dir, 'config', 'user.name', 't')
        for (const [rel, body] of Object.entries(files)) {
            const p = path.join(dir, rel)
            fs.mkdirSync(path.dirname(p), {recursive: true})
            fs.writeFileSync(p, body)
        }
        git(dir, 'add', '-A')
        git(dir, 'commit', '-qm', 'init')
        return dir
    }

    test('THE LEAD: a gitignored .env is snapshotted; dist/ and node_modules/ are not', async () => {
        const dir = makeRepo({
            '.gitignore': '.env\ndist/\nnode_modules/\n',
            'package.json': JSON.stringify({scripts: {build: 'bun build src/x.ts --outdir=dist'}})
        })
        fs.writeFileSync(path.join(dir, '.env'), 'SECRET=hunter2\n')
        fs.mkdirSync(path.join(dir, 'dist'))
        fs.writeFileSync(path.join(dir, 'dist/x.js'), 'x\n')
        fs.mkdirSync(path.join(dir, 'node_modules/left-pad'), {recursive: true})
        fs.writeFileSync(path.join(dir, 'node_modules/left-pad/i.js'), 'x\n')

        const snap = await collectIgnoredSnapshot(dir)
        expect(Object.keys(snap)).toEqual(['.env'])
        // inv-no-secret-echo at the source: the snapshot fingerprints, never reads.
        expect(JSON.stringify(snap)).not.toContain('hunter2')
    })

    test('the fingerprint moves when the file is rewritten (the write is attributable)', async () => {
        const dir = makeRepo({'.gitignore': '.env\n'})
        fs.writeFileSync(path.join(dir, '.env'), 'A=1\n')
        const before = await collectIgnoredSnapshot(dir)
        fs.writeFileSync(path.join(dir, '.env'), 'A=1\nB=2\n')
        const after = await collectIgnoredSnapshot(dir)
        expect(diffIgnoredSnapshots(before, after)).toEqual(['.env'])
    })

    test('inv-tracked-unchanged: the tracked change set is identical either side', async () => {
        const dir = makeRepo({'.gitignore': '.env\n', 'a.ts': 'export const a = 1\n'})
        fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 2\n')
        fs.writeFileSync(path.join(dir, '.env'), 'A=1\n')
        const before = await collectTreeChanges(dir)
        await collectIgnoredSnapshot(dir)
        expect(await collectTreeChanges(dir)).toEqual(before)
        expect(before.modified).toEqual(['a.ts'])
        expect(before.added).toEqual([]) // the ignored file never enters this channel
    })

    test('a wholly-ignored DIRECTORY is one entry, fingerprinted without walking it', async () => {
        // `--ignored=matching` collapses the directory, and a dir's own mtime moves
        // when entries are added or removed — that is the whole fingerprint
        // available without a walk, and a walk is the cost this channel refuses.
        const dir = makeRepo({'.gitignore': 'logs/\n'})
        fs.mkdirSync(path.join(dir, 'logs'))
        fs.writeFileSync(path.join(dir, 'logs/a.log'), 'a\n')
        const before = await collectIgnoredSnapshot(dir)
        expect(Object.keys(before)).toEqual(['logs/'])
        expect(before['logs/']!.startsWith('dir:')).toBe(true)
        fs.writeFileSync(path.join(dir, 'logs/b.log'), 'b\n')
        expect(diffIgnoredSnapshots(before, await collectIgnoredSnapshot(dir))).toEqual(['logs/'])
    })

    test('the probe can move a DIRECTORY aside and restore it with its contents', async () => {
        const dir = makeRepo({'.gitignore': 'logs/\n'})
        fs.mkdirSync(path.join(dir, 'logs'))
        fs.writeFileSync(path.join(dir, 'logs/a.log'), 'a\n')
        const answer = await gatePassesWithoutIgnored(dir, ['logs/'], async cwd => ({
            ok: fs.existsSync(path.join(cwd, 'logs'))
        }))
        expect(answer).toBe(false)
        expect(fs.readFileSync(path.join(dir, 'logs/a.log'), 'utf8')).toBe('a\n')
    })

    test('inv-degrade: no git repo at all → empty snapshot, no throw', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ignored-nogit-'))
        fs.writeFileSync(path.join(dir, '.env'), 'A=1\n')
        expect(await collectIgnoredSnapshot(dir)).toEqual({})
    })

    test('the probe moves the paths aside, answers, and puts them back', async () => {
        const dir = makeRepo({'.gitignore': '.env\n'})
        const env = path.join(dir, '.env')
        fs.writeFileSync(env, 'A=1\n')
        const seen: boolean[] = []
        const passes = await gatePassesWithoutIgnored(dir, ['.env'], async cwd => {
            const present = fs.existsSync(path.join(cwd, '.env'))
            seen.push(present)
            return {ok: present}
        })
        expect(seen).toEqual([false]) // the gate really ran without the file
        expect(passes).toBe(false) // …and did not pass without it → dependent
        expect(fs.readFileSync(env, 'utf8')).toBe('A=1\n') // restored, byte-identical
    })

    test('an incidental ignored write leaves the PASS alone', async () => {
        const dir = makeRepo({'.gitignore': 'scratch.log\n'})
        fs.writeFileSync(path.join(dir, 'scratch.log'), 'noise\n')
        expect(await gatePassesWithoutIgnored(dir, ['scratch.log'], async () => ({ok: true}))).toBe(
            true
        )
        expect(fs.existsSync(path.join(dir, 'scratch.log'))).toBe(true)
    })

    test('a gate that throws still restores the tree, and answers nothing', async () => {
        const dir = makeRepo({'.gitignore': '.env\n'})
        fs.writeFileSync(path.join(dir, '.env'), 'A=1\n')
        const answer = await gatePassesWithoutIgnored(dir, ['.env'], async () => {
            throw new Error('gate blew up')
        })
        expect(answer).toBeNull()
        expect(fs.existsSync(path.join(dir, '.env'))).toBe(true)
    })

    test('unanswerable cases return null rather than guessing', async () => {
        const dir = makeRepo({'.gitignore': '.env\n'})
        expect(await gatePassesWithoutIgnored(dir, [], async () => ({ok: true}))).toBeNull()
        // a path that is not there cannot be moved aside
        expect(await gatePassesWithoutIgnored(dir, ['.env'], async () => ({ok: true}))).toBeNull()
        // and a set this large is not a fix child's handful of files
        const many = Array.from({length: 21}, (_, i) => `f${i}`)
        expect(await gatePassesWithoutIgnored(dir, many, async () => ({ok: true}))).toBeNull()
    })

    test("parseBuildOutdirs reads the project's own build command", () => {
        const dir = makeRepo({
            'package.json': JSON.stringify({
                scripts: {build: 'bun build src/x.ts --outdir=public/assets', other: 'true'}
            })
        })
        expect(parseBuildOutdirs(dir)).toEqual(['public/assets'])
        expect(parseBuildOutdirs(fs.mkdtempSync(path.join(os.tmpdir(), 'no-pkg-')))).toEqual([])
    })
})

/**
 * The DIFF COLLECTORS — the git-shaped input every deterministic probe runs on.
 * All four share one discipline that only a real worktree can prove: pre-commit
 * they read the working tree, post-enforce (clean tree) they fall back to the
 * last commit, and every failure degrades to "nothing found" rather than
 * throwing, because a sharpener that can block a gate is a liability.
 */
describe('gate-deps diff collectors', () => {
    const git = (dir: string, ...args: string[]): void => {
        const r = Bun.spawnSync(['git', ...args], {cwd: dir})
        if (r.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.toString()}`)
    }

    function makeRepo(files: Record<string, string> = {'a.ts': 'export const a = 1\n'}): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-collect-'))
        git(dir, 'init', '-q')
        git(dir, 'config', 'user.email', 't@t')
        git(dir, 'config', 'user.name', 't')
        write(dir, files)
        git(dir, 'add', '-A')
        git(dir, 'commit', '-qm', 'init')
        return dir
    }

    function write(dir: string, files: Record<string, string>): void {
        for (const [rel, body] of Object.entries(files)) {
            const p = path.join(dir, rel)
            fs.mkdirSync(path.dirname(p), {recursive: true})
            fs.writeFileSync(p, body)
        }
    }

    const noGit = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'gate-nogit-'))

    describe('collectChangedFiles', () => {
        test('pre-commit: tracked edits by numstat, untracked files counted from disk', async () => {
            const dir = makeRepo()
            write(dir, {'a.ts': 'export const a = 1\nexport const b = 2\n'})
            write(dir, {'new.ts': 'export const n = 1\n'})

            const files = await collectChangedFiles(dir)

            expect(files).toEqual([
                {path: 'a.ts', addedLines: 1},
                {path: 'new.ts', addedLines: 2} // whole file, trailing newline included
            ])
        })

        test('never reports the gate machinery’s own .pi-tasks bookkeeping', async () => {
            const dir = makeRepo()
            write(dir, {'.pi-tasks/TASK_0001.md': '# spec\n'})

            expect(await collectChangedFiles(dir)).toEqual([])
        })

        test('clean tree (post-enforce re-verify): falls back to the LAST commit', async () => {
            const dir = makeRepo()
            write(dir, {'a.ts': 'export const a = 1\nexport const b = 2\n'})
            git(dir, 'add', '-A')
            git(dir, 'commit', '-qm', 'task work')

            expect(await collectChangedFiles(dir)).toEqual([{path: 'a.ts', addedLines: 1}])
        })

        test('degrades to an empty list outside a git repo', async () => {
            const dir = noGit()
            write(dir, {'a.ts': 'export const a = 1\n'})
            expect(await collectChangedFiles(dir)).toEqual([])
        })
    })

    describe('collectAddedLines', () => {
        test('carries the added line TEXT, which the numstat shape drops', async () => {
            const dir = makeRepo()
            write(dir, {'a.ts': 'export const a = 1\n// TODO: skip the assertion\n'})

            const lines = await collectAddedLines(dir)

            expect(lines).toContainEqual({path: 'a.ts', text: '// TODO: skip the assertion'})
        })

        test('reads an untracked file whole — every line of it is added', async () => {
            const dir = makeRepo()
            write(dir, {'new.ts': 'const x = 1\nconst y = 2\n'})

            const texts = (await collectAddedLines(dir))
                .filter(l => l.path === 'new.ts')
                .map(l => l.text)

            expect(texts).toEqual(['const x = 1', 'const y = 2', ''])
        })

        test('clean tree: falls back to the LAST commit’s diff', async () => {
            const dir = makeRepo()
            write(dir, {'a.ts': 'export const a = 1\nconst added = 2\n'})
            git(dir, 'add', '-A')
            git(dir, 'commit', '-qm', 'task work')

            expect(await collectAddedLines(dir)).toContainEqual({
                path: 'a.ts',
                text: 'const added = 2'
            })
        })

        test('degrades to an empty list outside a git repo', async () => {
            expect(await collectAddedLines(noGit())).toEqual([])
        })

        // FOUND BY THIS TEST: the header prefix is user-configurable, and the
        // parser only knew `b/`. On a machine with either setting below, every
        // added line was attributed to a path like `w/a.ts` — which exists
        // nowhere — so the probes downstream read a diff of files not in the repo.
        for (const [setting, value] of [
            ['diff.mnemonicPrefix', 'true'], // emits i/ and w/
            ['diff.noprefix', 'true'] // emits no prefix at all
        ] as const) {
            test(`repo-relative paths survive ${setting}=${value} in the host git config`, async () => {
                const dir = makeRepo()
                git(dir, 'config', setting, value)
                write(dir, {'a.ts': 'export const a = 1\nconst added = 2\n'})

                expect(await collectAddedLines(dir)).toContainEqual({
                    path: 'a.ts',
                    text: 'const added = 2'
                })
            })
        }
    })

    describe('collectScriptEscapeFindings', () => {
        /** The verbatim mx5 run-13 lint script — the true positive it exists for. */
        const NEUTERED =
            "prettier --write 'src/**/*.ts' && eslint --fix . "
            + "&& (tsc --noEmit 2>&1 | grep -qv 'TS18003' || true)"

        test('flags a check script neutered by THIS task’s manifest change', async () => {
            const dir = makeRepo({'package.json': JSON.stringify({scripts: {lint: 'eslint .'}})})
            write(dir, {'package.json': JSON.stringify({scripts: {lint: NEUTERED}})})

            const findings = await collectScriptEscapeFindings(dir)

            expect(findings.length).toBeGreaterThan(0)
            expect(findings.join('\n')).toContain('lint')
        })

        test('stays silent about a manifest the task never touched', async () => {
            const dir = makeRepo({'package.json': JSON.stringify({scripts: {lint: NEUTERED}})})
            write(dir, {'a.ts': 'export const a = 1\n'})

            expect(await collectScriptEscapeFindings(dir)).toEqual([])
        })

        test('a manifest the task DELETED is not a crash', async () => {
            const dir = makeRepo({'package.json': JSON.stringify({scripts: {lint: NEUTERED}})})
            fs.rmSync(path.join(dir, 'package.json'))

            expect(await collectScriptEscapeFindings(dir)).toEqual([])
        })
    })

    describe('collectRunnerGlobFindings', () => {
        const COLLIDING = {
            test: 'AGENT=1 bun test',
            'test:ct': 'bunx playwright test --config=playwright-ct.config.ts'
        }
        const PW_CONFIG = "export default defineConfig({testDir: './src/client/pages'})\n"

        test('flags the bun-test / playwright-test collision as shipped', async () => {
            const dir = makeRepo({
                'package.json': JSON.stringify({scripts: COLLIDING}),
                'playwright-ct.config.ts': PW_CONFIG,
                'bunfig.toml': '[test]\nenvFile = ".env.test"\n'
            })

            const findings = await collectRunnerGlobFindings(dir)

            expect(findings.length).toBeGreaterThan(0)
            expect(findings.join('\n')).toContain('pathIgnorePatterns')
        })

        test('accepts the tree once bunfig excludes the playwright specs', async () => {
            const dir = makeRepo({
                'package.json': JSON.stringify({scripts: COLLIDING}),
                'playwright-ct.config.ts': PW_CONFIG,
                'bunfig.toml':
                    '[test]\npathIgnorePatterns = ["**/*.spec.*", "src/client/**/*.test.*"]\n'
            })

            expect(await collectRunnerGlobFindings(dir)).toEqual([])
        })

        test('whole-repo, not diff-scoped — a clean working tree still gets checked', async () => {
            const dir = makeRepo({
                'package.json': JSON.stringify({scripts: COLLIDING}),
                'playwright-ct.config.ts': PW_CONFIG
            })
            expect((await collectRunnerGlobFindings(dir)).length).toBeGreaterThan(0)
        })

        test('says nothing without a readable, script-bearing manifest', async () => {
            expect(await collectRunnerGlobFindings(noGit())).toEqual([]) // no package.json

            const bad = makeRepo({'package.json': '{not json'})
            expect(await collectRunnerGlobFindings(bad)).toEqual([])

            const noScripts = makeRepo({'package.json': JSON.stringify({name: 'x'})})
            expect(await collectRunnerGlobFindings(noScripts)).toEqual([])

            const wrongType = makeRepo({'package.json': JSON.stringify({scripts: 'nope'})})
            expect(await collectRunnerGlobFindings(wrongType)).toEqual([])
        })
    })

    describe('collectTestAssemblyFindings', () => {
        // Distilled run-8 F4: the production entry composes route leaves; the task's
        // test re-mounts two of them itself and never imports the entry.
        const PRODUCTION = {
            'src/server/index.ts': [
                "import {authRoutes} from './routes/auth'",
                "import {photosRoutes} from './routes/photos'",
                "import {adminRoutes} from './routes/admin'",
                "import {sessionMiddleware} from './auth'"
            ].join('\n'),
            'src/server/auth.ts': 'export const sessionMiddleware = 0\n',
            'src/server/routes/auth.ts': "import {sessionMiddleware} from '../auth'\n",
            'src/server/routes/photos.ts': "import {sessionMiddleware} from '../auth'\n",
            'src/server/routes/admin.ts': "import {sessionMiddleware} from '../auth'\n"
        }
        const REASSEMBLING_TEST = [
            "import {authRoutes} from '../src/server/routes/auth'",
            "import {photosRoutes} from '../src/server/routes/photos'",
            "const app = new Hono().route('/api/auth', authRoutes).route('/api', photosRoutes)"
        ].join('\n')

        test('flags a changed test that rebuilds an assembly it never imports', async () => {
            const dir = makeRepo({...PRODUCTION, 'test/photos.test.ts': REASSEMBLING_TEST})

            const findings = await collectTestAssemblyFindings(dir, [
                {path: 'test/photos.test.ts', addedLines: 3}
            ])

            expect(findings.length).toBeGreaterThan(0)
            expect(findings.join('\n')).toContain('src/server/index.ts')
        })

        test('costs nothing when the task changed no test file', async () => {
            const dir = makeRepo({...PRODUCTION, 'test/photos.test.ts': REASSEMBLING_TEST})
            expect(await collectTestAssemblyFindings(dir, [{path: 'a.ts', addedLines: 1}])).toEqual(
                []
            )
        })

        test('degrades to no findings when the files cannot be listed', async () => {
            const dir = noGit()
            write(dir, {'test/x.test.ts': REASSEMBLING_TEST})
            expect(
                await collectTestAssemblyFindings(dir, [{path: 'test/x.test.ts', addedLines: 1}])
            ).toEqual([])
        })
    })

    /**
     * The sandbox-path-leak pass is the only probe that WRITES: it repairs what it
     * can before the verify child runs, and reports only the rest. Both halves are
     * asserted on the real worktree, because "the repair was written" is the part
     * that cannot be inferred from the finding list.
     */
    describe('collectForeignPathFindings', () => {
        const LEAK = "export default {alias: {'@api': '/workspace/src/client/api.ts'}}\n"

        test('repairs a leaked path that provably resolves here, and reports nothing', async () => {
            const dir = makeRepo({'src/client/api.ts': 'export const api = 1\n'})
            write(dir, {'vite.config.ts': LEAK})
            const log: string[] = []

            const findings = await collectForeignPathFindings(dir, undefined, m => log.push(m))

            expect(findings).toEqual([])
            expect(fs.readFileSync(path.join(dir, 'vite.config.ts'), 'utf8')).toBe(
                "export default {alias: {'@api': './src/client/api.ts'}}\n"
            )
            expect(log.join('\n')).toContain('repaired')
        })

        test('reports the leak for the child when the repair cannot be written', async () => {
            const dir = makeRepo({'src/client/api.ts': 'export const api = 1\n'})
            write(dir, {'vite.config.ts': LEAK})
            fs.chmodSync(path.join(dir, 'vite.config.ts'), 0o444)
            const log: string[] = []

            const findings = await collectForeignPathFindings(dir, undefined, m => log.push(m))

            // Running as root defeats the read-only bit; then the repair succeeds and
            // the case above is what ran. Only assert the branch we actually reached.
            if (findings.length === 0) {
                expect(log.join('\n')).toContain('repaired')
                return
            }
            expect(findings[0]).toContain('/workspace/src/client/api.ts')
            expect(findings[0]).toContain('src/client/api.ts')
            expect(log.join('\n')).toContain('NOT repaired')
        })

        test('a tree with no added lines costs nothing', async () => {
            expect(await collectForeignPathFindings(makeRepo())).toEqual([])
        })
    })

    describe('collectTreeChanges', () => {
        test('summarises the working tree by kind', async () => {
            const dir = makeRepo({'a.ts': 'x\n', 'gone.ts': 'y\n'})
            write(dir, {'a.ts': 'changed\n', 'fresh.ts': 'z\n'})
            fs.rmSync(path.join(dir, 'gone.ts'))

            expect(await collectTreeChanges(dir)).toEqual({
                modified: ['a.ts'],
                deleted: ['gone.ts'],
                added: ['fresh.ts']
            })
        })

        test('degrades to an empty summary outside a repo — nothing for the guard to reject', async () => {
            expect(await collectTreeChanges(noGit())).toEqual({
                modified: [],
                deleted: [],
                added: []
            })
        })
    })

    test('parseBuildOutdirs degrades on a manifest that is not JSON', () => {
        expect(parseBuildOutdirs(makeRepo({'package.json': '{not json'}))).toEqual([])
    })
})
