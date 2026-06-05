import {expect, test} from 'bun:test'
import {withTmpTaskDir} from '../test-utils/tmp-task-dir.js'
import {makeFakeCtx} from '../test-utils/fake-ctx.js'
import {
    planAuto,
    runAutoLoop,
    requestAutoCancel,
    expandFeatureMentions,
    type AutoDeps
} from './auto-orchestrator.js'
import {readTaskFile, writeTaskFile} from './task-file.js'
import {parseTaskList, buildAutoBody} from './auto-io.js'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'

// Sequential clarify is adaptive: planAuto re-calls 'auto-clarify' after every
// answer until it returns NONE. This helper feeds the given clarify responses in
// order (one question per call), then NONE — so the loop terminates.
function seqDeps(
    clarifyResponses: string[],
    decompose = '- [ ] Task A\n- [ ] Task B',
    over: Partial<AutoDeps> = {}
): AutoDeps {
    let clarifyCall = 0
    return {
        runChild: (name, _tools, _prompt) => {
            if (name === 'auto-clarify') {
                const r = clarifyResponses[clarifyCall] ?? 'NONE'
                clarifyCall++
                return Promise.resolve(r)
            }
            return Promise.resolve(decompose)
        },
        runTask: () => Promise.resolve({taskId: 'TASK_0001', ok: true, sessionCancelled: false}),
        commit: () => Promise.resolve({committed: true}),
        ...over
    }
}

test('planAuto: asks clarify questions, records answers, writes AUTO file with tasks', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured, queueInput} = makeFakeCtx(dir)
        queueInput('Redis')
        const id = await planAuto(ctx, dir, 'add billing', seqDeps(['1. Which store?']))
        expect(id).toBe('TASK_AUTO_0001')
        expect(captured.inputs.length).toBe(1)
        const {body, frontMatter} = await readTaskFile(dir, id!)
        expect(frontMatter.state).toBe('in_progress')
        expect(body).toContain('A1: Redis')
        expect(parseTaskList(body).map(e => e.title)).toEqual(['Task A', 'Task B'])
    })
})

test('planAuto: pre-fills the recommended default and shows it in the prompt', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured, queueInput} = makeFakeCtx(dir)
        queueInput('') // empty -> accept the recommendation
        const d = seqDeps(
            ['1. Where do photos live?\nSUGGESTED: local disk via Bun file APIs'],
            '- [ ] Task A'
        )
        const id = await planAuto(ctx, dir, 'add photo uploads', d)
        // The suggestion is offered as the input default and surfaced in the title.
        expect(captured.inputs).toHaveLength(1)
        expect(captured.inputs[0].default).toBe('local disk via Bun file APIs')
        expect(captured.inputs[0].title).toContain('Recommended:')
        // Empty input records the recommendation as accepted.
        const {body} = await readTaskFile(dir, id!)
        expect(body).toContain('A1: local disk via Bun file APIs (accepted recommendation)')
    })
})

test('planAuto: renders markdown in the prompt but stores/defaults plain text', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured, queueInput} = makeFakeCtx(dir)
        queueInput('') // accept the recommendation
        const d = seqDeps(
            [
                '1. **What transport?** WebSockets or polling?\nSUGGESTED: **Native WebSockets** via `Bun.serve`'
            ],
            '- [ ] Task A'
        )
        const id = await planAuto(ctx, dir, 'messaging', d)
        // Title shows the question text (bold rendered; fake theme is identity, so
        // no literal ** markers leak through).
        expect(captured.inputs[0].title).toContain('What transport?')
        expect(captured.inputs[0].title).not.toContain('**')
        // The editable default and the persisted answer are plain text.
        expect(captured.inputs[0].default).toBe('Native WebSockets via Bun.serve')
        const {body} = await readTaskFile(dir, id!)
        expect(body).toContain('A1: Native WebSockets via Bun.serve (accepted recommendation)')
        expect(body).not.toContain('**')
    })
})

test('planAuto: typed answer overrides the recommended default', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured, queueInput} = makeFakeCtx(dir)
        queueInput('object storage (S3)')
        const d = seqDeps(['1. Where do photos live?\nSUGGESTED: local disk'], '- [ ] Task A')
        const id = await planAuto(ctx, dir, 'add photo uploads', d)
        expect(captured.inputs[0].default).toBe('local disk')
        const {body} = await readTaskFile(dir, id!)
        expect(body).toContain('A1: object storage (S3)')
        expect(body).not.toContain('accepted recommendation')
    })
})

test('planAuto: feeds each answer into the next clarify call (adaptive)', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, queueInput} = makeFakeCtx(dir)
        queueInput('React') // answer to Q1
        queueInput('') // accept Q2's recommendation
        const clarifyPrompts: string[] = []
        let clarifyCall = 0
        const d: AutoDeps = {
            runChild: (name, _tools, prompt) => {
                if (name === 'auto-clarify') {
                    clarifyPrompts.push(prompt)
                    const responses = [
                        '1. Server-rendered or SPA?',
                        '1. How is JSX built?\nSUGGESTED: Bun bundler, no Vite'
                    ]
                    return Promise.resolve(responses[clarifyCall++] ?? 'NONE')
                }
                return Promise.resolve('- [ ] Task A')
            },
            runTask: () =>
                Promise.resolve({taskId: 'TASK_0001', ok: true, sessionCancelled: false}),
            commit: () => Promise.resolve({committed: true})
        }
        await planAuto(ctx, dir, 'build a frontend', d)
        // Three clarify calls: Q1, Q2 (sees Q1's answer), then the NONE call.
        expect(clarifyCall).toBe(3)
        // The second question was generated with the first answer in context.
        expect(clarifyPrompts[1]).toContain('React')
        // The third call (which returned NONE) saw both answers.
        expect(clarifyPrompts[2]).toContain('React')
        expect(clarifyPrompts[2]).toContain('Bun bundler, no Vite')
    })
})

test('planAuto: NONE clarify -> notifies that no questions are needed', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured} = makeFakeCtx(dir)
        const d = seqDeps([], '- [ ] Only task')
        await planAuto(ctx, dir, 'tiny feature', d)
        expect(captured.notifies.some(n => /no clarifying questions/i.test(n.msg))).toBe(true)
    })
})

test('planAuto: NONE clarify -> no input prompts, still writes tasks', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured} = makeFakeCtx(dir)
        const d = seqDeps([], '- [ ] Only task')
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
        const id = await planAuto(ctx, dir, 'add billing', seqDeps(['1. Which store?']))
        expect(id).toBeNull()
        expect(captured.notifies.some(n => /cancel/i.test(n.msg))).toBe(true)
    })
})

test('planAuto: empty decompose -> notify, no file', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured} = makeFakeCtx(dir)
        const d = seqDeps([], 'no tasks here')
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
        const commits: string[] = []
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
            },
            commit: (_cwd, message) => {
                commits.push(message)
                return Promise.resolve({committed: true})
            }
        }
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        expect(ran).toEqual(['A', 'B'])
        // One commit per passing task, message is `task: <title> (<taskId>)`.
        expect(commits).toEqual(['task: A (TASK_0006)', 'task: B (TASK_0007)'])
        const {frontMatter, body} = await readTaskFile(dir, 'TASK_AUTO_0001')
        expect(frontMatter.state).toBe('completed')
        expect(parseTaskList(body).every(e => e.done)).toBe(true)
    })
})

test('runAutoLoop: adopts each task\'s replacement ctx; never touches a stale one', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured} = makeFakeCtx(dir)
        await writeTaskFile(
            dir,
            autoFm('TASK_AUTO_0001'),
            buildAutoBody('feat', '(none)', ['A', 'B'])
        )
        let n = 6
        const d: AutoDeps = {
            runChild: () => Promise.resolve(''),
            // Faithfully model runSingleTask: replace the session (which marks the
            // passed-in ctx stale) and hand back the fresh replacement ctx.
            runTask: async (c, _cwd, title) => {
                let fresh = c
                await c.newSession({
                    withSession: async nc => {
                        fresh = nc
                    }
                })
                void title
                return {taskId: `TASK_000${n++}`, ok: true, sessionCancelled: false, ctx: fresh}
            },
            commit: () => Promise.resolve({committed: true})
        }
        // With the old loop (reusing the captured ctx) the second iteration's
        // notify would throw "stale ctx"; threading res.ctx keeps it live.
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        const {frontMatter, body} = await readTaskFile(dir, 'TASK_AUTO_0001')
        expect(frontMatter.state).toBe('completed')
        expect(parseTaskList(body).every(e => e.done)).toBe(true)
        expect(captured.notifies.some(nf => /complete/i.test(nf.msg))).toBe(true)
    })
})

test('runAutoLoop: a failed commit only warns; the run continues and completes', async () => {
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
                return Promise.resolve({taskId: 'TASK_0006', ok: true, sessionCancelled: false})
            },
            commit: () => Promise.resolve({committed: false, reason: 'not a git repository'})
        }
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        // Both tasks still ran and the run completed despite no commits.
        expect(ran).toEqual(['A', 'B'])
        expect((await readTaskFile(dir, 'TASK_AUTO_0001')).frontMatter.state).toBe('completed')
        const warned = captured.notifies.filter(
            n => n.level === 'warning' && /not committed \(not a git repository\)/.test(n.msg)
        )
        expect(warned.length).toBe(2)
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
            },
            commit: () => Promise.resolve({committed: true})
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
            },
            commit: () => Promise.resolve({committed: true})
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
            runTask: () => Promise.resolve({taskId: '', ok: false, sessionCancelled: true}),
            commit: () => Promise.resolve({committed: true})
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
            },
            commit: () => Promise.resolve({committed: true})
        }
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        expect(ran).toEqual(['B'])
    })
})

test('expandFeatureMentions: inlines a referenced @file, leaves the original text', async () => {
    await withTmpTaskDir(async dir => {
        await fsp.writeFile(path.join(dir, 'spec.md'), '# Spec\n\nBuild the thing.\n')
        const out = await expandFeatureMentions(dir, 'Implement @spec.md')
        expect(out).toContain('Implement @spec.md')
        expect(out).toContain('--- contents of spec.md ---')
        expect(out).toContain('Build the thing.')
    })
})

test('expandFeatureMentions: leaves unreadable @tokens and no-mention text untouched', async () => {
    await withTmpTaskDir(async dir => {
        expect(await expandFeatureMentions(dir, 'plain feature, no mentions')).toBe(
            'plain feature, no mentions'
        )
        expect(await expandFeatureMentions(dir, 'see @does-not-exist.md')).toBe(
            'see @does-not-exist.md'
        )
    })
})

test('expandFeatureMentions: dedupes repeated mentions, skips empty files', async () => {
    await withTmpTaskDir(async dir => {
        await fsp.writeFile(path.join(dir, 'a.md'), 'alpha')
        await fsp.writeFile(path.join(dir, 'empty.md'), '   \n')
        const out = await expandFeatureMentions(dir, '@a.md then @a.md and @empty.md')
        expect(out.match(/contents of a\.md/g)).toHaveLength(1)
        expect(out).not.toContain('contents of empty.md')
    })
})
