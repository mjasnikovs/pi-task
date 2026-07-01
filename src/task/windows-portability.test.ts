/**
 * Regression tests for GitHub issue #1 ("Error starting any task").
 *
 * A Windows user hit `spawn ENAMETOOLONG` on every `/task-auto` task, then —
 * after patching around it — `malformed front matter in TASK_AUTO_0001.md`.
 * Both are Windows-specific portability defects that never trip on the
 * maintainer's Linux box:
 *
 *   1. The phase prompt (which inlines the ~29K+ design doc) is passed as the
 *      last argv element to the child `pi` process. Windows CreateProcessW caps
 *      the ENTIRE command line at 32767 chars; on overflow Node throws
 *      `spawn ENAMETOOLONG` synchronously. Linux allows 128KB per arg, so it
 *      never trips there.
 *   2. parseFrontMatter's regex/`split` assume `\n` line endings; a task file
 *      with CRLF endings (Windows editor / git autocrlf) parses as null →
 *      "malformed front matter".
 *
 * These tests are written RED-first: they assert the CORRECT cross-platform
 * behaviour and therefore fail against the current code, confirming the bugs.
 */

import {describe, expect, test} from 'bun:test'
import * as fsp from 'node:fs/promises'
import {runPhaseChild} from './child-runner.js'
import {readTaskFile, readSection, writeTaskFile, taskFilePath} from './task-io.js'
import {parseFrontMatter, extractSection} from './task-parsers.js'
import {parseTaskList} from './auto-io.js'
import {findResumableAuto} from './auto-io.js'
import type {TaskFrontMatter} from './task-types.js'
import {withTmpTaskDir} from '../test-utils/tmp-task-dir.js'
import {fakeSpawnQueue, agentEndResponse} from '../test-utils/fake-spawn.js'
import type {ProcLike, SpawnFn} from '../shared/child-process.js'

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
 * Wrap a spawn fake so it models the Windows CreateProcessW limit: the whole
 * command line (command + every argv element) must fit in 32767 chars, else
 * Node throws `spawn ENAMETOOLONG` synchronously — the exact failure the issue
 * reporter saw. Empirically confirmed both Node and Bun throw this class of
 * error synchronously (Linux surfaces it as E2BIG), so the message propagates
 * up to the task-failure formatter as reported.
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
        // A real /task-auto phase prompt inlines the design doc; ~40K chars is
        // representative (memory notes a 29K design + composed spec + context).
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
 * The CRLF defect is systemic across the task-file I/O layer — every parser
 * hangs off the same disk read and assumes `\n`. These tests write a CRLF file
 * to disk (as a Windows editor or `git` autocrlf checkout would) and exercise
 * the read boundary + each downstream parser. The fix normalizes newlines once
 * on read, so all of these must pass without touching the individual parsers.
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
 * Safety net: the parsers themselves must tolerate CRLF, not only content that
 * happened to pass through readTextFile. A read site that forgets to normalize
 * (as the no-arg /task-resume scan did in 0.17.8) then still works. These pin
 * the pure functions directly on raw CRLF input.
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
