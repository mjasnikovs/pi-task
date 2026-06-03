import {expect, test} from 'bun:test'
import {withTmpTaskDir} from '../test-utils/tmp-task-dir.js'
import {makeFakeCtx} from '../test-utils/fake-ctx.js'
import {planAuto, runAutoLoop, requestAutoCancel, type AutoDeps} from './auto-orchestrator.js'
import {readTaskFile, writeTaskFile} from './task-file.js'
import {parseTaskList, buildAutoBody} from './auto-io.js'

function deps(over: Partial<AutoDeps> = {}): AutoDeps {
    return {
        runChild: (name, _tools, _prompt) =>
            Promise.resolve(
                name === 'auto-clarify' ? '1. Which store?' : '- [ ] Task A\n- [ ] Task B'
            ),
        runTask: () => Promise.resolve({taskId: 'TASK_0001', ok: true, sessionCancelled: false}),
        ...over
    }
}

test('planAuto: asks clarify questions, records answers, writes AUTO file with tasks', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured, queueInput} = makeFakeCtx(dir)
        queueInput('Redis')
        const id = await planAuto(ctx, dir, 'add billing', deps())
        expect(id).toBe('TASK_AUTO_0001')
        expect(captured.inputs.length).toBe(1)
        const {body, frontMatter} = await readTaskFile(dir, id!)
        expect(frontMatter.state).toBe('in_progress')
        expect(body).toContain('A1: Redis')
        expect(parseTaskList(body).map(e => e.title)).toEqual(['Task A', 'Task B'])
    })
})

test('planAuto: NONE clarify -> no input prompts, still writes tasks', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured} = makeFakeCtx(dir)
        const d = deps({
            runChild: name => Promise.resolve(name === 'auto-clarify' ? 'NONE' : '- [ ] Only task')
        })
        const id = await planAuto(ctx, dir, 'tiny feature', d)
        expect(captured.inputs.length).toBe(0)
        expect(parseTaskList((await readTaskFile(dir, id!)).body).map(e => e.title)).toEqual([
            'Only task'
        ])
    })
})

test('planAuto: dismissing a clarify question cancels planning, writes nothing', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured} = makeFakeCtx(dir) // no queued input -> input() returns undefined
        const id = await planAuto(ctx, dir, 'add billing', deps())
        expect(id).toBeNull()
        expect(captured.notifies.some(n => /cancel/i.test(n.msg))).toBe(true)
    })
})

test('planAuto: empty decompose -> notify, no file', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured} = makeFakeCtx(dir)
        const d = deps({
            runChild: name => Promise.resolve(name === 'auto-clarify' ? 'NONE' : 'no tasks here')
        })
        const id = await planAuto(ctx, dir, 'x', d)
        expect(id).toBeNull()
        expect(captured.notifies.some(n => /no tasks/i.test(n.msg))).toBe(true)
    })
})

function autoFm(id: string, state = 'in_progress') {
    return {
        id,
        state,
        phase: 'done',
        created_at: 'T',
        updated_at: 'T',
        title: 'feat'
    } as unknown as import('./task-types.js').TaskFrontMatter
}

test('runAutoLoop: runs each title in order, checks boxes, completes', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        await writeTaskFile(
            dir,
            autoFm('TASK_AUTO_0001'),
            buildAutoBody('feat', '(none)', ['A', 'B'])
        )
        const ran: string[] = []
        let n = 6
        const d: AutoDeps = {
            runChild: () => Promise.resolve(''),
            runTask: (_c, _cwd, title) => {
                ran.push(title)
                return Promise.resolve({
                    taskId: `TASK_000${n++}`,
                    ok: true,
                    sessionCancelled: false
                })
            }
        }
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        expect(ran).toEqual(['A', 'B'])
        const {frontMatter, body} = await readTaskFile(dir, 'TASK_AUTO_0001')
        expect(frontMatter.state).toBe('completed')
        expect(parseTaskList(body).every(e => e.done)).toBe(true)
    })
})

test('runAutoLoop: stops and marks failed on first failing task', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured} = makeFakeCtx(dir)
        await writeTaskFile(
            dir,
            autoFm('TASK_AUTO_0001'),
            buildAutoBody('feat', '(none)', ['A', 'B'])
        )
        const ran: string[] = []
        const d: AutoDeps = {
            runChild: () => Promise.resolve(''),
            runTask: (_c, _cwd, title) => {
                ran.push(title)
                return Promise.resolve({taskId: 'TASK_0006', ok: false, sessionCancelled: false})
            }
        }
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        expect(ran).toEqual(['A'])
        expect((await readTaskFile(dir, 'TASK_AUTO_0001')).frontMatter.state).toBe('failed')
        expect(captured.notifies.some(n => /resume/i.test(n.msg))).toBe(true)
    })
})

test('runAutoLoop: cancel after current task leaves state in_progress', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured} = makeFakeCtx(dir)
        await writeTaskFile(
            dir,
            autoFm('TASK_AUTO_0001'),
            buildAutoBody('feat', '(none)', ['A', 'B'])
        )
        const ran: string[] = []
        const d: AutoDeps = {
            runChild: () => Promise.resolve(''),
            runTask: (_c, _cwd, title) => {
                ran.push(title)
                requestAutoCancel()
                return Promise.resolve({taskId: 'TASK_0006', ok: true, sessionCancelled: false})
            }
        }
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        expect(ran).toEqual(['A'])
        const {frontMatter, body} = await readTaskFile(dir, 'TASK_AUTO_0001')
        expect(frontMatter.state).toBe('in_progress')
        const entries = parseTaskList(body)
        expect(entries[0].done).toBe(true)
        expect(entries[1].done).toBe(false)
        expect(captured.notifies.some(n => /cancel/i.test(n.msg))).toBe(true)
    })
})

test('runAutoLoop: sessionCancelled pauses without marking failed', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured} = makeFakeCtx(dir)
        await writeTaskFile(
            dir,
            autoFm('TASK_AUTO_0001'),
            buildAutoBody('feat', '(none)', ['A', 'B'])
        )
        const d: AutoDeps = {
            runChild: () => Promise.resolve(''),
            runTask: () => Promise.resolve({taskId: '', ok: false, sessionCancelled: true})
        }
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        expect((await readTaskFile(dir, 'TASK_AUTO_0001')).frontMatter.state).toBe('in_progress')
        expect(captured.notifies.some(n => /could not start a session/i.test(n.msg))).toBe(true)
    })
})

test('runAutoLoop: resume skips already-checked tasks', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        const body =
            '## feature prompt\n\nfeat\n\n## clarifications\n\n(none)\n\n## tasks\n\n- [x] TASK_0005  A\n- [ ] B\n'
        await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), body)
        const ran: string[] = []
        const d: AutoDeps = {
            runChild: () => Promise.resolve(''),
            runTask: (_c, _cwd, title) => {
                ran.push(title)
                return Promise.resolve({taskId: 'TASK_0006', ok: true, sessionCancelled: false})
            }
        }
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        expect(ran).toEqual(['B'])
    })
})
