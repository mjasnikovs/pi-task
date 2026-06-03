import {expect, test} from 'bun:test'
import {withTmpTaskDir} from '../test-utils/tmp-task-dir.js'
import {
    allocateAutoId,
    findResumableAuto,
    parseTaskList,
    parseDecomposeList,
    buildAutoBody,
    checkOffTask
} from './auto-io.js'
import {writeTaskFile, readTaskFile} from './task-file.js'
import type {TaskFrontMatter} from './task-types.js'

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

test('parseDecomposeList: parses checkbox / dash / numbered lines, caps, ignores junk', () => {
    const raw = ['- [ ] First task', '- Second task', '3. Third task', 'not a task line', ''].join(
        '\n'
    )
    expect(parseDecomposeList(raw)).toEqual(['First task', 'Second task', 'Third task'])
})

test('parseDecomposeList: empty -> []', () => {
    expect(parseDecomposeList('nothing here\n')).toEqual([])
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
