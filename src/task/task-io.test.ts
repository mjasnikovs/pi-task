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

    test('stores content with $-sequences verbatim when replacing', async () => {
        // Regression: `content` is untrusted model output. A replacement *string*
        // expands `$`-patterns; a spec line like `^\+[1-9]\d{1,14}$` ends in the
        // literal `` $` `` which silently mangled/truncated the stored section
        // (dropping ACCEPTANCE/VERIFY → no_verify_block on every resume).
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(cwd, makeFm('TASK_0001'), '\n## a\n\nA\n\n## spec\n\nold\n')
            const content = [
                'GOAL',
                'do it',
                'CONSTRAINTS',
                '- phone must match `^\\+[1-9]\\d{1,14}$` exactly',
                'ACCEPTANCE',
                '- works',
                'VERIFY:',
                '```bash',
                'bun run build',
                '```'
            ].join('\n')
            await setTaskSection(cwd, 'TASK_0001', 'spec', content)
            const stored = await readSection(cwd, 'TASK_0001', 'spec')
            expect(stored).toBe(content)
            // The preceding section is untouched (no $`-injection of the prefix).
            expect(await readSection(cwd, 'TASK_0001', 'a')).toBe('A')
        })
    })

    test('readSection returns null when section is missing', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(cwd, makeFm('TASK_0001'), '\n## other\n\nx\n')
            expect(await readSection(cwd, 'TASK_0001', 'missing')).toBeNull()
        })
    })

    test('repeated rewrites do not grow a blank gap under the heading', async () => {
        // Regression: sectionRegex group 1 used `\s*\n`, which greedily swallowed
        // every blank line after the heading into the capture; setTaskSection then
        // re-emitted that capture plus one more `\n`, so each rewrite added a blank
        // line. A long /task-auto run (~2 rewrites/task) ballooned the `## tasks`
        // section into a ~48-line empty gap. The body must stay stable.
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(cwd, makeFm('TASK_0001'), '\n## tasks\n\n- [ ] a\n- [ ] b\n')
            for (let i = 0; i < 20; i++) {
                const sec = (await readSection(cwd, 'TASK_0001', 'tasks')) ?? ''
                await setTaskSection(cwd, 'TASK_0001', 'tasks', sec)
            }
            const {body} = await readTaskFile(cwd, 'TASK_0001')
            expect(body).not.toMatch(/## tasks\n\n\n/)
            expect(body).toContain('## tasks\n\n- [ ] a\n- [ ] b')
        })
    })

    test('self-heals an existing blank-line gap on the next rewrite', async () => {
        await withTmpTaskDir(async cwd => {
            const gap = '\n'.repeat(48)
            await writeTaskFile(cwd, makeFm('TASK_0001'), `\n## tasks\n${gap}- [ ] a\n`)
            const sec = (await readSection(cwd, 'TASK_0001', 'tasks')) ?? ''
            await setTaskSection(cwd, 'TASK_0001', 'tasks', sec)
            const {body} = await readTaskFile(cwd, 'TASK_0001')
            expect(body).toContain('## tasks\n\n- [ ] a')
            expect(body).not.toMatch(/## tasks\n\n\n/)
        })
    })
})
