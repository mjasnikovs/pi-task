import {describe, expect, test} from 'bun:test'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import {
    allocateTaskId,
    writeTaskFile,
    readTaskFile,
    updateTaskFrontMatter,
    setTaskSection,
    readSection,
    ensureTasksDir,
    tasksDir
} from './task-io.js'
import {withTmpTaskDir} from '../test-utils/tmp-task-dir.js'
import type {TaskFrontMatter} from './task-types.js'

function makeFm(id: string): TaskFrontMatter {
    return {
        id,
        state: 'in_progress',
        phase: 'refine',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        title: 'test'
    }
}

describe('ensureTasksDir', () => {
    test('writes a .ignore whose only effective rule is *', async () => {
        await withTmpTaskDir(async cwd => {
            await ensureTasksDir(cwd)
            const ignore = await fsp.readFile(path.join(tasksDir(cwd), '.ignore'), 'utf8')
            // fd/ripgrep skip the whole dir; comments are allowed around the rule.
            const rules = ignore.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'))
            expect(rules).toEqual(['*'])
        })
    })

    test('does not clobber a hand-edited .ignore on re-run', async () => {
        await withTmpTaskDir(async cwd => {
            await ensureTasksDir(cwd)
            const ignorePath = path.join(tasksDir(cwd), '.ignore')
            await fsp.writeFile(ignorePath, '# custom\n*.tmp\n')
            await ensureTasksDir(cwd)
            expect(await fsp.readFile(ignorePath, 'utf8')).toBe('# custom\n*.tmp\n')
        })
    })
})

describe('allocateTaskId', () => {
    test('returns TASK_0001 in an empty project', async () => {
        await withTmpTaskDir(async cwd => {
            expect(await allocateTaskId(cwd)).toBe('TASK_0001')
        })
    })

    test('returns max+1 when files exist with gaps', async () => {
        await withTmpTaskDir(async cwd => {
            const dir = tasksDir(cwd)
            await fsp.mkdir(dir, {recursive: true})
            await fsp.writeFile(path.join(dir, 'TASK_0003.md'), '')
            await fsp.writeFile(path.join(dir, 'TASK_0007.md'), '')
            expect(await allocateTaskId(cwd)).toBe('TASK_0008')
        })
    })

    test('ignores non-task files', async () => {
        await withTmpTaskDir(async cwd => {
            const dir = tasksDir(cwd)
            await fsp.mkdir(dir, {recursive: true})
            await fsp.writeFile(path.join(dir, 'README.md'), '')
            expect(await allocateTaskId(cwd)).toBe('TASK_0001')
        })
    })
})

describe('writeTaskFile / readTaskFile', () => {
    test('round-trips front matter and body', async () => {
        await withTmpTaskDir(async cwd => {
            const fm = makeFm('TASK_0001')
            await writeTaskFile(cwd, fm, '\nbody content\n')
            const {frontMatter, body} = await readTaskFile(cwd, 'TASK_0001')
            expect(frontMatter.id).toBe('TASK_0001')
            expect(body).toContain('body content')
        })
    })

    test('throws on malformed front matter', async () => {
        await withTmpTaskDir(async cwd => {
            const dir = tasksDir(cwd)
            await fsp.mkdir(dir, {recursive: true})
            await fsp.writeFile(path.join(dir, 'TASK_0001.md'), 'no delimiters')
            await expect(readTaskFile(cwd, 'TASK_0001')).rejects.toThrow(/malformed/)
        })
    })
})

describe('updateTaskFrontMatter', () => {
    test('patches fields and refreshes updated_at', async () => {
        await withTmpTaskDir(async cwd => {
            const fm = makeFm('TASK_0001')
            await writeTaskFile(cwd, fm, '\nbody\n')
            await updateTaskFrontMatter(cwd, 'TASK_0001', {state: 'completed'})
            const {frontMatter} = await readTaskFile(cwd, 'TASK_0001')
            expect(frontMatter.state).toBe('completed')
            expect(frontMatter.updated_at).not.toBe(fm.updated_at)
        })
    })

    test('preserves body', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(cwd, makeFm('TASK_0001'), '\n## section\n\ncontent\n')
            await updateTaskFrontMatter(cwd, 'TASK_0001', {title: 'new'})
            const {body} = await readTaskFile(cwd, 'TASK_0001')
            expect(body).toContain('## section')
            expect(body).toContain('content')
        })
    })
})

describe('setTaskSection / readSection', () => {
    test('appends a new section when absent', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(cwd, makeFm('TASK_0001'), '\n## first\n\nfoo\n')
            await setTaskSection(cwd, 'TASK_0001', 'second', 'bar')
            const {body} = await readTaskFile(cwd, 'TASK_0001')
            expect(body).toContain('## first')
            expect(body).toContain('## second')
            expect(body).toContain('bar')
        })
    })

    test('replaces an existing section in place', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(cwd, makeFm('TASK_0001'), '\n## s\n\nold\n')
            await setTaskSection(cwd, 'TASK_0001', 's', 'new')
            expect(await readSection(cwd, 'TASK_0001', 's')).toBe('new')
        })
    })

    test('preserves other sections when replacing one', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                makeFm('TASK_0001'),
                '\n## first\n\nf\n\n## target\n\nold\n\n## last\n\nl\n'
            )
            await setTaskSection(cwd, 'TASK_0001', 'target', 'new')
            expect(await readSection(cwd, 'TASK_0001', 'first')).toBe('f')
            expect(await readSection(cwd, 'TASK_0001', 'target')).toBe('new')
            expect(await readSection(cwd, 'TASK_0001', 'last')).toBe('l')
        })
    })

    test('readSection returns null when section is missing', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(cwd, makeFm('TASK_0001'), '\n## other\n\nx\n')
            expect(await readSection(cwd, 'TASK_0001', 'missing')).toBeNull()
        })
    })
})
