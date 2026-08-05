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
    collectTaskTreeChanges,
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
