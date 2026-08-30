import {expect, test} from 'bun:test'
import {withTmpTaskDir} from '../test-utils/tmp-task-dir.js'
import {makeFakeCtx} from '../test-utils/fake-ctx.js'
import {runGatedTask} from '../../src/task/orchestrator.js'
import {writeTaskFile, readTaskFile} from '../../src/task/task-io.js'
import type {GateDeps} from '../../src/task/task-gates.js'
import type {TaskFrontMatter} from '../../src/task/task-types.js'

/** The task file as it stands when the gate reads its title: TaskRunner writes
 *  `{state: 'completed', phase: 'done'}` just before handing the spec off. */
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
        runTask: () => Promise.resolve({taskId: 'TASK_0006', end: {kind: 'completed'}}),
        commit: () => Promise.resolve({committed: true}),
        ...over
    }
}

test('runGatedTask: implementation could not start a session → warns, no gate', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured} = makeFakeCtx(dir)
        const commits: string[] = []
        const deps = makeDeps({
            runTask: () => Promise.resolve({taskId: '', end: {kind: 'no-session'}}),
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
                    end: {kind: 'failed', reason: 'context overflow'}
                })
        })
        await runGatedTask(ctx, dir, 'build a thing', {deps})
        // RUN_END_POLICY.failed is `resumable: true`, so the handoff's 'completed'
        // is demoted and /task-resume can pick the task up.
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
            runTask: () => Promise.resolve({taskId: 'TASK_0006', end: {kind: 'interrupted'}})
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
        // TERMINAL_OUTCOMES.done is `markResumable: false`.
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
        // The fake ctx's select returns undefined when nothing was queued, which is
        // what a dismissed picker looks like.
        await runGatedTask(ctx, dir, 'build a thing', {deps})
        expect(commits).toEqual([]) // work not blessed
        expect((await readTaskFile(dir, 'TASK_0006')).frontMatter.state).toBe('failed')
        expect(captured.notifies.some(n => /dismissed the choice.*\/task-resume/.test(n.msg))).toBe(
            true
        )
    })
})

/**
 * A cancel inside the GATE must not be overwritten either. Two separate tables
 * decide this: `RUN_END_POLICY` for the first implementation run, and
 * `TERMINAL_OUTCOMES` for the gate's autofix re-run. Both carry a `cancelled` row
 * that leaves the file alone; folding `cancelled` into `interrupted` would demote
 * it to `failed`, replacing a deliberate stop with a red fault.
 *
 * Asserted on the FILE, not on the returned kind: the overwrite is the harm.
 */
test('runGatedTask: a cancelled AUTOFIX re-run leaves the file cancelled', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured} = makeFakeCtx(dir)
        await writeComposedTask(dir, 'TASK_0006', 'My Feature')
        let turn = 0
        const deps = makeDeps({
            runTask: async () => {
                turn++
                if (turn === 1) return {taskId: 'TASK_0006', end: {kind: 'completed'}}
                // classifyFailure maps a USER_CANCELLED throw to state 'cancelled',
                // so the file already says so before the run end is handled.
                const {frontMatter, body} = await readTaskFile(dir, 'TASK_0006')
                await writeTaskFile(dir, {...frontMatter, state: 'cancelled'}, body)
                return {taskId: 'TASK_0006', end: {kind: 'cancelled'}}
            },
            verify: () => Promise.resolve({ok: false, reason: 'build exited 1'}),
            recommend: () => Promise.resolve({recommend: 'autofix', rationale: 'a real defect'})
        })
        await runGatedTask(ctx, dir, 'build a thing', {deps})
        expect(turn).toBe(2) // the re-run really happened
        expect((await readTaskFile(dir, 'TASK_0006')).frontMatter.state).toBe('cancelled')
        // And it is announced as a stop, not as a fault.
        expect(captured.notifies.some(n => /cancelled/.test(n.msg))).toBe(true)
        expect(captured.notifies.some(n => n.level === 'error')).toBe(false)
    })
})

test('runGatedTask: an INTERRUPTED autofix re-run is still demoted', async () => {
    // The control. `interrupted` and `cancelled` are different endings and only one
    // of them leaves the file alone — a fix that stopped demoting both would pass
    // the test above and be wrong.
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        await writeComposedTask(dir, 'TASK_0006', 'My Feature')
        let turn = 0
        const deps = makeDeps({
            runTask: () => {
                turn++
                return Promise.resolve({
                    taskId: 'TASK_0006',
                    end: {kind: turn === 1 ? 'completed' : 'interrupted'}
                })
            },
            verify: () => Promise.resolve({ok: false, reason: 'build exited 1'}),
            recommend: () => Promise.resolve({recommend: 'autofix', rationale: 'a real defect'})
        })
        await runGatedTask(ctx, dir, 'build a thing', {deps})
        expect((await readTaskFile(dir, 'TASK_0006')).frontMatter.state).toBe('failed')
    })
})
