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

test('buildAutoBody + parseTaskList round-trip', () => {
    const body = buildAutoBody('add rate limiting', 'Q1: ...\nA1: ...', ['Task A', 'Task B'])
    expect(parseTaskList(body)).toEqual([
        {index: 0, title: 'Task A', done: false},
        {index: 1, title: 'Task B', done: false}
    ])
})

test('parseTaskList: checked line marks done and captures producedId', () => {
    const body = '## tasks\n\n- [x] TASK_0007  Task A\n- [ ] Task B\n'
    const entries = parseTaskList(body)
    expect(entries[0]).toEqual({index: 0, title: 'Task A', done: true, producedId: 'TASK_0007'})
    expect(entries[1]).toEqual({index: 1, title: 'Task B', done: false})
})

test('parseTaskList: unchecked line with a stamped id captures producedId, stays undone', () => {
    // An in-progress entry: the inner task was allocated (id stamped) but not yet
    // completed. Resume must see this id so it continues the task instead of
    // starting a fresh one.
    const body = '## tasks\n\n- [ ] TASK_0006  Task A\n- [ ] Task B\n'
    const entries = parseTaskList(body)
    expect(entries[0]).toEqual({index: 0, title: 'Task A', done: false, producedId: 'TASK_0006'})
    expect(entries[1]).toEqual({index: 1, title: 'Task B', done: false})
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
        expect(entries[1]).toEqual({index: 1, title: 'Task B', done: true, producedId: 'TASK_0042'})
    })
})

test('checkOffTask: empty producedId writes a plain checked line that round-trips', async () => {
    await withTmpTaskDir(async dir => {
        const body = buildAutoBody('feat', '(none)', ['Only one'])
        await writeTaskFile(dir, fm('TASK_AUTO_0001', 'in_progress'), body)
        await checkOffTask(dir, 'TASK_AUTO_0001', 0, '', 'Only one')
        const entries = parseTaskList((await readTaskFile(dir, 'TASK_AUTO_0001')).body)
        expect(entries[0]).toEqual({index: 0, title: 'Only one', done: true})
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

// insertTaskAfter — the mid-run plan mutation the root-cause repair channel needs
// (mx5 run 14 item 5). MONOTONIC: splice only, never rewrite/reorder/drop.
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
            title: 'Task A',
            done: true,
            producedId: 'TASK_0001'
        })
        expect(entries[1].done).toBe(false)
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
    expect(
        parseCoverageVerdict('COVERAGE: INCOMPLETE\nMISSING: auth routes\nMISSING: admin page')
    ).toEqual({kind: 'incomplete', missing: ['auth routes', 'admin page']})
    const many = ['COVERAGE: INCOMPLETE', ...Array.from({length: 12}, (_, i) => `MISSING: a${i}`)]
    expect(parseCoverageVerdict(many.join('\n'))!.missing.length).toBe(8)
    // Prose without the tag, and INCOMPLETE with nothing actionable → null.
    expect(parseCoverageVerdict('The list looks fine to me.')).toBeNull()
    expect(parseCoverageVerdict('COVERAGE: INCOMPLETE')).toBeNull()
})
