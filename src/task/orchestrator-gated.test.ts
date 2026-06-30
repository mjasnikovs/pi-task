import {expect, test} from 'bun:test'
import {withTmpTaskDir} from '../test-utils/tmp-task-dir.js'
import {makeFakeCtx} from '../test-utils/fake-ctx.js'
import {runGatedTask} from './orchestrator.js'
import {writeTaskFile, readTaskFile} from './task-io.js'
import type {GateDeps} from './task-gates.js'
import type {TaskFrontMatter} from './task-types.js'

/** A composed (done, completed-at-handoff) inner task file the gate reads its title
 *  from — mirrors what TaskRunner writes before the implementation turn. */
async function writeComposedTask(dir: string, id: string, title: string): Promise<void> {
    const now = new Date().toISOString()
    const fm: TaskFrontMatter = {
        id,
        state: 'completed',
        phase: 'done',
        created_at: now,
        updated_at: now,
        title
    }
    await writeTaskFile(dir, fm, `\n## spec\n\nGOAL: do it\n`)
}

function makeDeps(over: Partial<GateDeps> = {}): GateDeps {
    return {
        runTask: () => Promise.resolve({taskId: 'TASK_0006', ok: true, sessionCancelled: false}),
        commit: () => Promise.resolve({committed: true}),
        ...over
    }
}

test('runGatedTask: implementation could not start a session → warns, no gate', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured} = makeFakeCtx(dir)
        const commits: string[] = []
        const deps = makeDeps({
            runTask: () => Promise.resolve({taskId: '', ok: false, sessionCancelled: true}),
            commit: (_c, m) => {
                commits.push(m)
                return Promise.resolve({committed: true})
            }
        })
        await runGatedTask(ctx, dir, 'build a thing', {deps})
        expect(commits).toEqual([]) // gate never reached
        expect(captured.notifies.some(n => /could not start a fresh session/.test(n.msg))).toBe(
            true
        )
    })
})

test('runGatedTask: implementation failed → task left resumable, error announced', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured} = makeFakeCtx(dir)
        await writeComposedTask(dir, 'TASK_0006', 'My Feature')
        const deps = makeDeps({
            runTask: () =>
                Promise.resolve({
                    taskId: 'TASK_0006',
                    ok: false,
                    sessionCancelled: false,
                    reason: 'context overflow'
                })
        })
        await runGatedTask(ctx, dir, 'build a thing', {deps})
        // Demoted from 'completed' (handoff) to a resumable state so /task-resume works.
        expect((await readTaskFile(dir, 'TASK_0006')).frontMatter.state).toBe('failed')
        expect(
            captured.notifies.some(n => /stopped.*context overflow.*\/task-resume/.test(n.msg))
        ).toBe(true)
    })
})

test('runGatedTask: implementation interrupted → resumable, pause announced', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured} = makeFakeCtx(dir)
        await writeComposedTask(dir, 'TASK_0006', 'My Feature')
        const deps = makeDeps({
            runTask: () =>
                Promise.resolve({
                    taskId: 'TASK_0006',
                    ok: true,
                    sessionCancelled: false,
                    interrupted: true
                })
        })
        await runGatedTask(ctx, dir, 'build a thing', {deps})
        expect((await readTaskFile(dir, 'TASK_0006')).frontMatter.state).toBe('failed')
        expect(captured.notifies.some(n => /paused.*\/task-resume/.test(n.msg))).toBe(true)
    })
})

test('runGatedTask: clean run → gate commits with the task title, announces complete', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured} = makeFakeCtx(dir)
        await writeComposedTask(dir, 'TASK_0006', 'My Feature')
        const commits: string[] = []
        const deps = makeDeps({
            commit: (_c, m) => {
                commits.push(m)
                return Promise.resolve({committed: true})
            },
            verify: () => Promise.resolve({ok: true})
        })
        await runGatedTask(ctx, dir, 'build a thing', {deps})
        // Commit message uses the task's front-matter title, not the raw prompt.
        expect(commits).toContain('task: My Feature (TASK_0006)')
        expect(captured.notifies.some(n => /complete — verified/.test(n.msg))).toBe(true)
        // A clean done run is NOT demoted — it stays completed.
        expect((await readTaskFile(dir, 'TASK_0006')).frontMatter.state).toBe('completed')
    })
})

test('runGatedTask: verify FAIL + dismiss → task left resumable, dismissal announced', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured} = makeFakeCtx(dir)
        await writeComposedTask(dir, 'TASK_0006', 'My Feature')
        const commits: string[] = []
        const deps = makeDeps({
            commit: (_c, m) => {
                commits.push(m)
                return Promise.resolve({committed: true})
            },
            verify: () => Promise.resolve({ok: false, reason: 'build exited 1'}),
            recommend: () => Promise.resolve({recommend: 'autofix', rationale: 'broken'})
        })
        // No queueSelect → picker dismissed.
        await runGatedTask(ctx, dir, 'build a thing', {deps})
        expect(commits).toEqual([]) // work not blessed
        expect((await readTaskFile(dir, 'TASK_0006')).frontMatter.state).toBe('failed')
        expect(captured.notifies.some(n => /dismissed the choice.*\/task-resume/.test(n.msg))).toBe(
            true
        )
    })
})
