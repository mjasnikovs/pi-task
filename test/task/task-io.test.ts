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
    tasksDir,
    appendGateRecord
} from '../../src/task/task-io.js'
import {withTmpTaskDir} from '../test-utils/tmp-task-dir.js'
import type {TaskFrontMatter} from '../../src/task/task-types.js'

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
        // `content` is untrusted model output. A replacement *string* expands
        // `$`-patterns, so a spec line ending `...$` followed by a backtick puts a
        // literal `` $` `` in the replacement and splices the preceding text in.
        // setTaskSection passes a replacer FUNCTION, which never expands.
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
        // A capture that swallowed the blank line after the heading would be
        // re-emitted plus one more `\n` on every rewrite, growing the gap one line
        // per pass (see the note on sectionRegex in task-parsers.ts). One rewrite
        // hides that; a run of them does not.
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

describe('appendGateRecord', () => {
    test('creates the gates section on first append, then appends in order', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(cwd, makeFm('TASK_0001'), '\n## spec\n\nGOAL x\n')
            await appendGateRecord(cwd, 'TASK_0001', 'verify: PASS')
            await appendGateRecord(cwd, 'TASK_0001', 'commit: task snapshot committed')
            await appendGateRecord(cwd, 'TASK_0001', 'enforce(edit): clean')
            const sec = await readSection(cwd, 'TASK_0001', 'gates')
            expect(sec).not.toBeNull()
            const lines = (sec ?? '').split('\n')
            expect(lines).toHaveLength(3)
            expect(lines[0]).toMatch(/^- \d{4}-\d{2}-\d{2}T[\d:.]+Z verify: PASS$/)
            expect(lines[1]).toContain('commit: task snapshot committed')
            expect(lines[2]).toContain('enforce(edit): clean')
            // The spec section is untouched.
            expect(await readSection(cwd, 'TASK_0001', 'spec')).toBe('GOAL x')
        })
    })

    test('keeps $-sequences literal and flattens multi-line reasons to one line', async () => {
        // Gate reasons are model output: they can carry `$`-patterns a replacement
        // string would expand, and newlines that would break the one-record-per-
        // line trail.
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(cwd, makeFm('TASK_0001'), '\n## spec\n\nGOAL x\n')
            await appendGateRecord(
                cwd,
                'TASK_0001',
                'verify: FAIL — regex `^\\+\\d$` broke\nline two $& $1'
            )
            const sec = (await readSection(cwd, 'TASK_0001', 'gates')) ?? ''
            expect(sec.split('\n')).toHaveLength(1)
            expect(sec).toContain('regex `^\\+\\d$` broke line two $& $1')
        })
    })

    test('never throws when the task file is missing (best-effort trail)', async () => {
        await withTmpTaskDir(async cwd => {
            await appendGateRecord(cwd, 'TASK_9999', 'verify: PASS')
        })
    })
})
