/**
 * gate-deps tests — the tool-result log summary used by the gate debug log
 * (mx5 run 10 item 6). The summary is pure; the wiring that feeds it real tool
 * output is covered in json-event-sink.test.ts (the sink emits onToolResult).
 */
import {describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {truncateToolResult, collectTaskTreeChanges} from './gate-deps.js'

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
