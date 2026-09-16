import {expect, test} from 'bun:test'
import {withTmpTaskDir} from '../test-utils/tmp-task-dir.js'
import {
    allocateAutoId,
    findResumableAuto,
    parseTaskList,
    parseDecomposeList,
    parseCoverageVerdict,
    buildAutoBody,
    checkOffTask,
    stampTaskInProgress,
    beginTaskAttempt,
    recordTaskEnd,
    insertTaskAfter
} from '../../src/task/auto-io.js'
import {writeTaskFile, readTaskFile} from '../../src/task/task-io.js'
import type {TaskFrontMatter} from '../../src/task/task-types.js'

function fm(id: string, state: string) {
    return {
        id,
        state,
        phase: 'done',
        created_at: 'T',
        updated_at: 'T',
        title: 't'
    } as unknown as TaskFrontMatter
}

test('allocateAutoId: empty dir -> 0001', async () => {
    await withTmpTaskDir(async dir => {
        expect(await allocateAutoId(dir)).toBe('TASK_AUTO_0001')
    })
})

test('allocateAutoId: ignores TASK_NNNN, increments from max AUTO', async () => {
    await withTmpTaskDir(async dir => {
        await writeTaskFile(dir, fm('TASK_0009', 'completed'), '\n## x\n')
        await writeTaskFile(dir, fm('TASK_AUTO_0003', 'completed'), '\n## x\n')
        expect(await allocateAutoId(dir)).toBe('TASK_AUTO_0004')
    })
})

test('parseDecomposeList: parses checkbox / dash / numbered lines, ignores junk', () => {
    const raw = ['- [ ] First task', '- Second task', '3. Third task', 'not a task line', ''].join(
        '\n'
    )
    expect(parseDecomposeList(raw)).toEqual(['First task', 'Second task', 'Third task'])
})

test('parseDecomposeList: empty -> []', () => {
    expect(parseDecomposeList('nothing here\n')).toEqual([])
})

test('parseDecomposeList: no cap — keeps every title past the old 30 ceiling', () => {
    const raw = Array.from({length: 45}, (_, i) => `- [ ] Task ${i + 1}`).join('\n')
    const out = parseDecomposeList(raw)
    expect(out).toHaveLength(45)
    expect(out[44]).toBe('Task 45')
})

test('buildAutoBody + parseTaskList round-trip, every entry keyed at plan time', () => {
    const body = buildAutoBody('add rate limiting', 'Q1: ...\nA1: ...', ['Task A', 'Task B'])
    expect(body).toContain('- [ ] P01  Task A')
    expect(parseTaskList(body)).toEqual([
        {index: 0, key: 'P01', title: 'Task A', done: false},
        {index: 1, key: 'P02', title: 'Task B', done: false}
    ])
})

test('parseTaskList: the full grammar — key, inner id and attempts, all round-tripping', () => {
    const body = '## tasks\n\n- [ ] P01 TASK_0006 a2  Task A\n- [x] P02 TASK_0007 a1  Task B\n'
    expect(parseTaskList(body)).toEqual([
        {index: 0, key: 'P01', title: 'Task A', done: false, producedId: 'TASK_0006', attempts: 2},
        {index: 1, key: 'P02', title: 'Task B', done: true, producedId: 'TASK_0007', attempts: 1}
    ])
})

test('parseTaskList: checked line marks done and captures producedId', () => {
    const body = '## tasks\n\n- [x] TASK_0007  Task A\n- [ ] Task B\n'
    const entries = parseTaskList(body)
    expect(entries[0]).toEqual({index: 0, title: 'Task A', done: true, producedId: 'TASK_0007'})
    expect(entries[1]).toEqual({index: 1, title: 'Task B', done: false})
})

test('parseTaskList: unchecked line with a stamped id captures producedId, stays undone', () => {
    // An in-progress entry: the inner task was allocated (id stamped) but not
    // yet checked off. auto-orchestrator.ts reads this back as `resumeId`,
    // confirms the task file still exists, and continues that task — so losing
    // the id here would silently restart work already done.
    const body = '## tasks\n\n- [ ] TASK_0006  Task A\n- [ ] Task B\n'
    const entries = parseTaskList(body)
    expect(entries[0]).toEqual({index: 0, title: 'Task A', done: false, producedId: 'TASK_0006'})
    expect(entries[1]).toEqual({index: 1, title: 'Task B', done: false})
})

// The grammar's fields are token-shaped, so a TITLE that happens to open with one
// must still be read whole. The two-space delimiter is what decides it.
test('parseTaskList: a title that opens like a field is read whole', () => {
    const body = [
        '## tasks',
        '',
        '- [ ] TASK_0006 is broken — fix the loader',
        '- [ ] (auto) tighten the retry budget',
        '- [ ] P01  TASK_0042 is the culprit',
        '- [ ] a3 attempts were lost on resume',
        ''
    ].join('\n')
    expect(parseTaskList(body)).toEqual([
        {index: 0, title: 'TASK_0006 is broken — fix the loader', done: false},
        {index: 1, title: '(auto) tighten the retry budget', done: false},
        {index: 2, key: 'P01', title: 'TASK_0042 is the culprit', done: false},
        {index: 3, title: 'a3 attempts were lost on resume', done: false}
    ])
})

test('parseTaskList: the attempts field carries how the last attempt ended', () => {
    const body = [
        '## tasks',
        '',
        '- [ ] P01 TASK_0006 a2:failed  Task A',
        '- [ ] P02 TASK_0007 a1  Task B',
        // Not a registered ending → not a field, so the whole thing is the title.
        '- [ ] a2:sideways  Task C',
        ''
    ].join('\n')
    expect(parseTaskList(body)).toEqual([
        {
            index: 0,
            key: 'P01',
            producedId: 'TASK_0006',
            attempts: 2,
            lastEnd: 'failed',
            title: 'Task A',
            done: false
        },
        {index: 1, key: 'P02', producedId: 'TASK_0007', attempts: 1, title: 'Task B', done: false},
        {index: 2, title: 'a2:sideways  Task C', done: false}
    ])
})

test('recordTaskEnd: the ending round-trips and the next attempt clears it', async () => {
    await withTmpTaskDir(async dir => {
        const body = buildAutoBody('feat', '(none)', ['Task A'])
        await writeTaskFile(dir, fm('TASK_AUTO_0001', 'in_progress'), body)
        await beginTaskAttempt(dir, 'TASK_AUTO_0001', 0)
        await recordTaskEnd(dir, 'TASK_AUTO_0001', 0, 'no-session')
        const read = async (): Promise<ReturnType<typeof parseTaskList>[number]> =>
            parseTaskList((await readTaskFile(dir, 'TASK_AUTO_0001')).body)[0]
        expect(await read()).toEqual({
            index: 0,
            key: 'P01',
            title: 'Task A',
            done: false,
            attempts: 1,
            lastEnd: 'no-session'
        })
        // The ending describes the attempt that is over, not the one starting.
        expect(await beginTaskAttempt(dir, 'TASK_AUTO_0001', 0)).toBe(2)
        expect(await read()).toEqual({
            index: 0,
            key: 'P01',
            title: 'Task A',
            done: false,
            attempts: 2
        })
    })
})

test('beginTaskAttempt: a keyless legacy line counts nothing it cannot write down', async () => {
    await withTmpTaskDir(async dir => {
        const body = '## feature prompt\n\nfeat\n\n## tasks\n\n- [ ] Task A\n'
        await writeTaskFile(dir, fm('TASK_AUTO_0001', 'in_progress'), body)
        await beginTaskAttempt(dir, 'TASK_AUTO_0001', 0)
        // `a1  Task A` would re-parse as a TITLE, so the count is dropped rather
        // than written into a line that reads it back as prose.
        expect(parseTaskList((await readTaskFile(dir, 'TASK_AUTO_0001')).body)).toEqual([
            {index: 0, title: 'Task A', done: false}
        ])
    })
})

test('stampTaskInProgress: stamps the id and leaves the counter to the loop', async () => {
    await withTmpTaskDir(async dir => {
        const body = buildAutoBody('feat', '(none)', ['Task A', 'Task B'])
        await writeTaskFile(dir, fm('TASK_AUTO_0001', 'in_progress'), body)
        await beginTaskAttempt(dir, 'TASK_AUTO_0001', 1)
        await stampTaskInProgress(dir, 'TASK_AUTO_0001', 1, 'TASK_0042', 'Task B')
        const entries = parseTaskList((await readTaskFile(dir, 'TASK_AUTO_0001')).body)
        expect(entries[1]).toEqual({
            index: 1,
            key: 'P02',
            title: 'Task B',
            done: false,
            producedId: 'TASK_0042',
            attempts: 1
        })
        // The stamp is not an attempt: only the loop's own bump counts one.
        await stampTaskInProgress(dir, 'TASK_AUTO_0001', 1, 'TASK_0042', 'Task B')
        expect(parseTaskList((await readTaskFile(dir, 'TASK_AUTO_0001')).body)[1].attempts).toBe(1)
    })
})

test('parseTaskList: ignores non-checkbox lines inside the section', () => {
    const body = '## tasks\n\n- [ ] Real\nsome note\n- [x] TASK_0001  Done one\n'
    expect(parseTaskList(body).map(e => e.title)).toEqual(['Real', 'Done one'])
})

test('checkOffTask: rewrites the Nth checkbox line, stamps id, leaves others', async () => {
    await withTmpTaskDir(async dir => {
        const body = buildAutoBody('feat', '(none)', ['Task A', 'Task B'])
        await writeTaskFile(dir, fm('TASK_AUTO_0001', 'in_progress'), body)
        await checkOffTask(dir, 'TASK_AUTO_0001', 1, 'TASK_0042', 'Task B')
        const entries = parseTaskList((await readTaskFile(dir, 'TASK_AUTO_0001')).body)
        expect(entries[0].done).toBe(false)
        expect(entries[1]).toEqual({
            index: 1,
            key: 'P02',
            title: 'Task B',
            done: true,
            producedId: 'TASK_0042'
        })
    })
})

test('checkOffTask: empty producedId writes a plain checked line that round-trips', async () => {
    await withTmpTaskDir(async dir => {
        const body = buildAutoBody('feat', '(none)', ['Only one'])
        await writeTaskFile(dir, fm('TASK_AUTO_0001', 'in_progress'), body)
        await checkOffTask(dir, 'TASK_AUTO_0001', 0, '', 'Only one')
        const entries = parseTaskList((await readTaskFile(dir, 'TASK_AUTO_0001')).body)
        expect(entries[0]).toEqual({index: 0, key: 'P01', title: 'Only one', done: true})
    })
})

// The key is the ownership join, so it must survive the one rewrite that touches
// the line after the plan is written: a title the check-off supplies afresh.
test('checkOffTask: a rewritten title leaves the plan key and the attempt count alone', async () => {
    await withTmpTaskDir(async dir => {
        const body = buildAutoBody('feat', '(none)', ['Task A'])
        await writeTaskFile(dir, fm('TASK_AUTO_0001', 'in_progress'), body)
        await beginTaskAttempt(dir, 'TASK_AUTO_0001', 0)
        await stampTaskInProgress(dir, 'TASK_AUTO_0001', 0, 'TASK_0042', 'Task A')
        await checkOffTask(dir, 'TASK_AUTO_0001', 0, 'TASK_0042', 'Task A — reworded by refine')
        expect(parseTaskList((await readTaskFile(dir, 'TASK_AUTO_0001')).body)[0]).toEqual({
            index: 0,
            key: 'P01',
            title: 'Task A — reworded by refine',
            done: true,
            producedId: 'TASK_0042',
            attempts: 1
        })
    })
})

test('checkOffTask: throws on out-of-range index', async () => {
    await withTmpTaskDir(async dir => {
        const body = buildAutoBody('feat', '(none)', ['Only one'])
        await writeTaskFile(dir, fm('TASK_AUTO_0001', 'in_progress'), body)
        await expect(
            checkOffTask(dir, 'TASK_AUTO_0001', 5, 'TASK_0001', 'Only one')
        ).rejects.toThrow(/out of range/)
    })
})

// insertTaskAfter is the one mid-run plan mutation, used by
// schedulePendingRepairs (auto-orchestrator.ts) to splice a root-cause repair
// step into a plan that is already executing. MONOTONIC: it splices only — no
// existing entry is rewritten, reordered or dropped — because entries already
// checked off are the record of what ran.
test('insertTaskAfter: splices a new entry directly after the given index', async () => {
    await withTmpTaskDir(async dir => {
        const body = buildAutoBody('feat', '(none)', ['Task A', 'Task B', 'Task C'])
        await writeTaskFile(dir, fm('TASK_AUTO_0001', 'in_progress'), body)
        await checkOffTask(dir, 'TASK_AUTO_0001', 0, 'TASK_0001', 'Task A')
        expect(
            await insertTaskAfter(dir, 'TASK_AUTO_0001', 0, 'repair test/teardown.ts: TRUNCATE bug')
        ).toBe(true)
        const entries = parseTaskList((await readTaskFile(dir, 'TASK_AUTO_0001')).body)
        // Inserted BEFORE the next dependent task, not appended at the end.
        expect(entries.map(e => e.title)).toEqual([
            'Task A',
            'repair test/teardown.ts: TRUNCATE bug',
            'Task B',
            'Task C'
        ])
        // Existing state is untouched: the finished entry keeps its check + id.
        expect(entries[0]).toEqual({
            index: 0,
            key: 'P01',
            title: 'Task A',
            done: true,
            producedId: 'TASK_0001'
        })
        expect(entries[1].done).toBe(false)
        // The spliced step gets the next FREE key, never one the plan already
        // spent — the entries it pushed down keep theirs.
        expect(entries.map(e => e.key)).toEqual(['P01', 'P04', 'P02', 'P03'])
    })
})

test('insertTaskAfter: a splice into a legacy (unkeyed) plan mints a non-colliding key', async () => {
    await withTmpTaskDir(async dir => {
        const body = '## tasks\n\n- [x] TASK_0001  Task A\n- [ ] Task B\n'
        await writeTaskFile(dir, fm('TASK_AUTO_0001', 'in_progress'), body)
        expect(await insertTaskAfter(dir, 'TASK_AUTO_0001', 0, 'repair a/b.ts: bug')).toBe(true)
        const entries = parseTaskList((await readTaskFile(dir, 'TASK_AUTO_0001')).body)
        expect(entries.map(e => e.key)).toEqual([undefined, 'P03', undefined])
    })
})

test('insertTaskAfter: an already-present title is a no-op (no duplicate on retry)', async () => {
    await withTmpTaskDir(async dir => {
        const body = buildAutoBody('feat', '(none)', ['Task A', 'repair x/y.ts: bug'])
        await writeTaskFile(dir, fm('TASK_AUTO_0001', 'in_progress'), body)
        expect(await insertTaskAfter(dir, 'TASK_AUTO_0001', 0, 'repair x/y.ts: bug')).toBe(false)
        expect(
            parseTaskList((await readTaskFile(dir, 'TASK_AUTO_0001')).body).map(e => e.title)
        ).toEqual(['Task A', 'repair x/y.ts: bug'])
    })
})

test('insertTaskAfter: an out-of-range index appends after the last entry, never throws', async () => {
    await withTmpTaskDir(async dir => {
        const body = buildAutoBody('feat', '(none)', ['Task A'])
        await writeTaskFile(dir, fm('TASK_AUTO_0001', 'in_progress'), body)
        expect(await insertTaskAfter(dir, 'TASK_AUTO_0001', 9, 'repair a/b.ts: bug')).toBe(true)
        expect(
            parseTaskList((await readTaskFile(dir, 'TASK_AUTO_0001')).body).map(e => e.title)
        ).toEqual(['Task A', 'repair a/b.ts: bug'])
    })
})

test('insertTaskAfter: an empty title is rejected', async () => {
    await withTmpTaskDir(async dir => {
        const body = buildAutoBody('feat', '(none)', ['Task A'])
        await writeTaskFile(dir, fm('TASK_AUTO_0001', 'in_progress'), body)
        expect(await insertTaskAfter(dir, 'TASK_AUTO_0001', 0, '   ')).toBe(false)
    })
})

test('findResumableAuto: none -> null', async () => {
    await withTmpTaskDir(async dir => {
        expect(await findResumableAuto(dir)).toBeNull()
    })
})

test('findResumableAuto: ignores completed, picks most-recently-updated resumable', async () => {
    await withTmpTaskDir(async dir => {
        await writeTaskFile(dir, fm('TASK_AUTO_0001', 'completed'), '\n## tasks\n')
        await writeTaskFile(dir, fm('TASK_AUTO_0002', 'in_progress'), '\n## tasks\n')
        await new Promise(r => setTimeout(r, 10))
        await writeTaskFile(dir, fm('TASK_AUTO_0003', 'failed'), '\n## tasks\n')
        expect(await findResumableAuto(dir)).toBe('TASK_AUTO_0003')
    })
})

test('parseCoverageVerdict: COMPLETE, INCOMPLETE+missing, caps at 8, null on prose', () => {
    expect(parseCoverageVerdict('COVERAGE: COMPLETE')).toEqual({kind: 'complete', missing: []})
    expect(parseCoverageVerdict('  coverage: complete  ')).toEqual({kind: 'complete', missing: []})
    const listed = parseCoverageVerdict(
        'COVERAGE: INCOMPLETE\nMISSING: auth routes\nMISSING: admin page'
    )
    expect(listed).toEqual({kind: 'incomplete', missing: ['auth routes', 'admin page']})
    const many = ['COVERAGE: INCOMPLETE', ...Array.from({length: 12}, (_, i) => `MISSING: a${i}`)]
    const capped = parseCoverageVerdict(many.join('\n'))
    expect(capped?.kind === 'incomplete' && capped.missing.length).toBe(8)
    expect(parseCoverageVerdict('The list looks fine to me.')).toBeNull()
})

// THE SHIPPED-AS-COMPLETE REGRESSION. Prose and "INCOMPLETE naming nothing" both
// used to parse as null, and the caller reads null as an empty missing-list — so
// a plan the judge had just ruled INCOMPLETE shipped, logged as COMPLETE. They
// are different answers and must parse to different values.
test('parseCoverageVerdict: an INCOMPLETE that names nothing is unparseable, not null', () => {
    expect(parseCoverageVerdict('COVERAGE: INCOMPLETE')).toEqual({kind: 'unparseable'})
    expect(parseCoverageVerdict('COVERAGE: INCOMPLETE\nMISSING:')).toEqual({kind: 'unparseable'})
    expect(parseCoverageVerdict('I think the plan is fine.')).toBeNull()
})
