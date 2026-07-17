import {describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    parseIntroducingTask,
    taskThatIntroduced,
    taskThatIntroducedVia,
    findCrossTaskDeletions,
    crossTaskDeletionVerifyFindings,
    type ProvenanceGit
} from './task-provenance.js'

describe('parseIntroducingTask', () => {
    test('the OLDEST (last-listed) subject wins — a delete-and-re-add must not reattribute', () => {
        const log = [
            'task: re-add ct config (TASK_0025)',
            'task: playwright component testing (TASK_0020)'
        ].join('\n')
        expect(parseIntroducingTask(log)).toBe('TASK_0020')
    })
    test('a non-task introducing commit attributes to nobody', () => {
        expect(parseIntroducingTask('chore: scaffold repo')).toBeNull()
        expect(parseIntroducingTask('')).toBeNull()
    })
    test('the task suffix must terminate the subject (mid-subject mentions do not count)', () => {
        expect(parseIntroducingTask('mentions (TASK_0003) mid subject')).toBeNull()
        expect(parseIntroducingTask('task: thing (TASK_0003)  ')).toBe('TASK_0003')
    })
})

describe('taskThatIntroducedVia (injected git)', () => {
    test('resolves through the async git shape; errors and empty output are null', async () => {
        const ok: ProvenanceGit = () =>
            Promise.resolve({exitCode: 0, stdout: 'task: thing (TASK_0002)\n'})
        expect(await taskThatIntroducedVia(ok, 'a.ts')).toBe('TASK_0002')
        const err: ProvenanceGit = () => Promise.resolve({exitCode: 128, stdout: ''})
        expect(await taskThatIntroducedVia(err, 'a.ts')).toBeNull()
        const empty: ProvenanceGit = () => Promise.resolve({exitCode: 0, stdout: ''})
        expect(await taskThatIntroducedVia(empty, 'a.ts')).toBeNull()
    })
})

describe('taskThatIntroduced (real git)', () => {
    const git = (dir: string, ...args: string[]): void => {
        const r = Bun.spawnSync(['git', ...args], {cwd: dir})
        if (r.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.toString()}`)
    }
    test('sync lookup matches the injected-git variant', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-'))
        git(dir, 'init', '-q')
        git(dir, 'config', 'user.email', 't@t')
        git(dir, 'config', 'user.name', 't')
        fs.writeFileSync(path.join(dir, 'ct.config.ts'), 'export default {}\n')
        git(dir, 'add', '-A')
        git(dir, 'commit', '-qm', 'task: component testing (TASK_0020)')
        expect(taskThatIntroduced(dir, 'ct.config.ts')).toBe('TASK_0020')
        // Deleted from the worktree — attribution still holds (the log has it).
        fs.rmSync(path.join(dir, 'ct.config.ts'))
        expect(taskThatIntroduced(dir, 'ct.config.ts')).toBe('TASK_0020')
        const viaGit: ProvenanceGit = args => {
            const r = Bun.spawnSync(['git', ...args], {cwd: dir})
            return Promise.resolve({exitCode: r.exitCode, stdout: r.stdout.toString()})
        }
        expect(await taskThatIntroducedVia(viaGit, 'ct.config.ts')).toBe('TASK_0020')
    })
})

describe('findCrossTaskDeletions', () => {
    const owners: Record<string, string | null> = {
        'playwright-ct.config.ts': 'TASK_0020',
        'playwright/index.ts': 'TASK_0020',
        'src/mine.ts': 'TASK_0021',
        'legacy/pre-run.ts': null
    }
    const byMap = (rel: string): string | null => owners[rel] ?? null

    test("a sibling's committed deliverable deleted is a finding naming the owner", async () => {
        const found = await findCrossTaskDeletions(
            {modified: [], added: [], deleted: ['playwright-ct.config.ts', 'playwright/index.ts']},
            'TASK_0021',
            byMap
        )
        expect(found).toEqual([
            {path: 'playwright-ct.config.ts', owner: 'TASK_0020'},
            {path: 'playwright/index.ts', owner: 'TASK_0020'}
        ])
    })

    test('same-task deletions and unknown provenance are NOT findings', async () => {
        const found = await findCrossTaskDeletions(
            {modified: [], added: [], deleted: ['src/mine.ts', 'legacy/pre-run.ts']},
            'TASK_0021',
            byMap
        )
        expect(found).toEqual([])
    })

    test('a relocation (same basename among added files) is not a deletion', async () => {
        const found = await findCrossTaskDeletions(
            {
                modified: [],
                added: ['config/playwright-ct.config.ts'],
                deleted: ['playwright-ct.config.ts']
            },
            'TASK_0021',
            byMap
        )
        expect(found).toEqual([])
    })

    test('an unknown CURRENT task id disables the check ("differs" cannot be established)', async () => {
        const found = await findCrossTaskDeletions(
            {modified: [], added: [], deleted: ['playwright-ct.config.ts']},
            '  ',
            byMap
        )
        expect(found).toEqual([])
    })

    test('a throwing introducedBy reads as unknown provenance — steps aside', async () => {
        const found = await findCrossTaskDeletions(
            {modified: [], added: [], deleted: ['playwright-ct.config.ts']},
            'TASK_0021',
            () => {
                throw new Error('git broke')
            }
        )
        expect(found).toEqual([])
    })
})

describe('crossTaskDeletionVerifyFindings', () => {
    test('each finding names the file and its owning task', () => {
        const lines = crossTaskDeletionVerifyFindings([
            {path: 'playwright/index.ts', owner: 'TASK_0020'}
        ])
        expect(lines).toHaveLength(1)
        expect(lines[0]).toContain('`playwright/index.ts`')
        expect(lines[0]).toContain('TASK_0020')
        expect(lines[0]).toContain('DELETED')
    })
})
