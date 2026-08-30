/**
 * Portability regressions for GitHub issue #1 ("Error starting any task").
 *
 * Two of them, both invisible on a box with a generous argv limit and LF files:
 *
 *   1. A phase prompt inlines the design doc and rides as the last argv element
 *      to the child `pi`. Past whatever the OS allows on a command line, the
 *      spawn throws SYNCHRONOUSLY — before any stream or exit handler exists —
 *      so it must be caught at the call, not awaited.
 *   2. A task file with CRLF endings must read and parse the same as one with
 *      LF, at the read boundary and in each pure parser.
 */

import {describe, expect, test} from 'bun:test'
import * as fsp from 'node:fs/promises'
import {runPhaseChild} from '../../src/task/child-runner.js'
import {readTaskFile, readSection, writeTaskFile, taskFilePath} from '../../src/task/task-io.js'
import {parseFrontMatter, extractSection} from '../../src/task/task-parsers.js'
import {parseTaskList} from '../../src/task/auto-io.js'
import {findResumableAuto} from '../../src/task/auto-io.js'
import type {TaskFrontMatter} from '../../src/task/task-types.js'
import {withTmpTaskDir} from '../test-utils/tmp-task-dir.js'
import {fakeSpawnQueue, agentEndResponse} from '../test-utils/fake-spawn.js'
import type {ProcLike, SpawnFn} from '../../src/shared/child-process.js'

function depsWith(spawn: SpawnFn) {
    return {
        cwd: '/tmp',
        taskId: 'TASK_TEST',
        signal: new AbortController().signal,
        spawn,
        sleepFor: async () => {}
    }
}

/**
 * Wrap a spawn fake so it enforces a command-line budget: command plus every
 * argv element must fit, or the wrapper THROWS instead of returning a process.
 * That is the shape a real over-long spawn takes — on this box, spawning
 * /bin/echo with a multi-megabyte argument throws synchronously with code
 * E2BIG — so the caller has to survive a throw, not a failed child.
 */
const WINDOWS_CMDLINE_LIMIT = 32767
function windowsLimitedSpawn(inner: SpawnFn): SpawnFn {
    return ((
        command: string,
        args: ReadonlyArray<string>,
        options: {cwd: string; shell: boolean; stdio: ['ignore', 'pipe', 'pipe']}
    ): ProcLike => {
        const commandLineLength = [command, ...args].join(' ').length
        if (commandLineLength > WINDOWS_CMDLINE_LIMIT) {
            const err = new Error('spawn ENAMETOOLONG') as Error & {
                code: string
                errno: number
                syscall: string
            }
            err.code = 'ENAMETOOLONG'
            err.errno = -4064
            err.syscall = 'spawn'
            throw err
        }
        return inner(command, args, options)
    }) as unknown as SpawnFn
}

describe('issue #1: spawn ENAMETOOLONG — large prompt overflows the OS command line', () => {
    test('a phase prompt carrying the inlined design doc must not overflow argv on Windows', async () => {
        // A phase prompt inlines the design doc, so it is far past the budget above.
        const bigPrompt = 'DESIGN DOC\n' + 'x'.repeat(40000)
        const spawn = windowsLimitedSpawn(fakeSpawnQueue([agentEndResponse('ok')]))

        const text = await runPhaseChild(depsWith(spawn), 'refine', 'read', bigPrompt)
        expect(text).toBe('ok')
    })

    test('a small prompt still works under the same Windows-limited spawn (control)', async () => {
        const spawn = windowsLimitedSpawn(fakeSpawnQueue([agentEndResponse('ok')]))
        const text = await runPhaseChild(depsWith(spawn), 'refine', 'read', 'tiny prompt')
        expect(text).toBe('ok')
    })
})

/**
 * Every task-file parser hangs off one disk read and assumes `\n`, so the
 * normalisation lives at that boundary: readTaskFile pulls the file through
 * `readTextFile` (shared/fs-text.ts), which folds CRLF/CR to LF. These tests
 * write a CRLF file and exercise the read boundary plus each parser downstream
 * of it.
 */
const FM: TaskFrontMatter = {
    id: 'TASK_0001',
    state: 'in_progress',
    phase: 'refine',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:01Z',
    title: 'A title'
}

/** Write a normal (LF) task file, then rewrite it byte-for-byte with CRLF
 *  endings — simulating a Windows-checked-out / editor-saved task file. */
async function writeCrlfTaskFile(cwd: string, fm: TaskFrontMatter, body: string): Promise<void> {
    await writeTaskFile(cwd, fm, body)
    const p = taskFilePath(cwd, fm.id)
    const lf = await fsp.readFile(p, 'utf8')
    await fsp.writeFile(p, lf.replace(/\n/g, '\r\n'), 'utf8')
}

describe('issue #1 follow-up: CRLF task files must read/parse the same as LF', () => {
    test('readTaskFile parses front matter and strips it from the body (no "malformed front matter")', async () => {
        await withTmpTaskDir(async cwd => {
            await writeCrlfTaskFile(cwd, FM, '## notes\n\nhello\n')
            const {frontMatter, body} = await readTaskFile(cwd, FM.id)
            expect(frontMatter.id).toBe('TASK_0001')
            expect(frontMatter.phase).toBe('refine')
            expect(frontMatter.title).toBe('A title')
            // The front-matter delimiter/keys must not bleed into the body.
            expect(body).not.toContain('---')
            expect(body).not.toContain('id: TASK_0001')
        })
    })

    test('readSection extracts a section from a CRLF file', async () => {
        await withTmpTaskDir(async cwd => {
            await writeCrlfTaskFile(cwd, FM, '## notes\n\nhello world\n')
            const section = await readSection(cwd, FM.id, 'notes')
            expect(section).toBe('hello world')
        })
    })

    test('parseTaskList reads the checkbox list from a CRLF AUTO file body', async () => {
        await withTmpTaskDir(async cwd => {
            const body = '## tasks\n\n- [x] First thing\n- [ ] Second thing\n'
            await writeCrlfTaskFile(cwd, {...FM, id: 'TASK_AUTO_0001'}, body)
            const {body: readBody} = await readTaskFile(cwd, 'TASK_AUTO_0001')
            const entries = parseTaskList(readBody)
            expect(entries.map(e => e.title)).toEqual(['First thing', 'Second thing'])
            expect(entries[0].done).toBe(true)
            expect(entries[1].done).toBe(false)
        })
    })

    test('findResumableAuto discovers a CRLF AUTO file', async () => {
        await withTmpTaskDir(async cwd => {
            await writeCrlfTaskFile(cwd, {...FM, id: 'TASK_AUTO_0001'}, '## tasks\n\n- [ ] x\n')
            const found = await findResumableAuto(cwd)
            expect(found).toBe('TASK_AUTO_0001')
        })
    })
})

/**
 * The parsers themselves must tolerate CRLF, not only content that came through
 * readTextFile — a read site that forgets to normalise then still works. These
 * pin the pure functions on raw CRLF input.
 */
describe('issue #1 follow-up: parsers are intrinsically CRLF-tolerant', () => {
    const rawLF =
        '---\nid: TASK_0001\nstate: in_progress\nphase: refine\n'
        + 'created_at: 2026-01-01T00:00:00Z\nupdated_at: 2026-01-01T00:00:01Z\n'
        + 'title: A title\n---\n## notes\n\nhello\n'

    test('parseFrontMatter parses raw CRLF content (the missed no-arg /task-resume scan path)', () => {
        const fm = parseFrontMatter(rawLF.replace(/\n/g, '\r\n'))
        expect(fm).not.toBeNull()
        expect(fm!.id).toBe('TASK_0001')
        expect(fm!.phase).toBe('refine')
        // No stray CR contaminating a value (would break PHASE_INDEX / state checks).
        expect(fm!.title).toBe('A title')
        expect(fm!.state).toBe('in_progress')
    })

    test('extractSection matches a section heading with CRLF endings', () => {
        const body = '## tasks\n\nfoo\n\n## notes\n\nbar\n'.replace(/\n/g, '\r\n')
        expect(extractSection(body, 'tasks')).toBe('foo')
        expect(extractSection(body, 'notes')).toBe('bar')
    })
})
