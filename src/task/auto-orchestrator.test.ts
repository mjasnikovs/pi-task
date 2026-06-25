import {expect, test} from 'bun:test'
import {withTmpTaskDir} from '../test-utils/tmp-task-dir.js'
import {makeFakeCtx} from '../test-utils/fake-ctx.js'
import {
    planAuto,
    runAutoLoop,
    requestAutoCancel,
    expandFeatureMentions,
    readableMentions,
    attachSpecRefs,
    buildScopeFence,
    type AutoDeps
} from './auto-orchestrator.js'
import {readTaskFile, writeTaskFile} from './task-io.js'
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

// Lay down a minimal resolvable `bun` types package so findPhantomImports can
// prove `bun:sql` is phantom (the base `bun` module declares `class SQL`, but
// there is no `declare module "bun:sql"`). Mirrors the real bun-types shape just
// enough for resolveRuntimeTypesRoot → classifyRuntimeImport.
async function stubBunTypes(dir: string): Promise<void> {
    const pkg = path.join(dir, 'node_modules', 'bun')
    await fsp.mkdir(pkg, {recursive: true})
    await fsp.writeFile(
        path.join(pkg, 'package.json'),
        JSON.stringify({name: 'bun', version: '1.0.0', types: 'index.d.ts'})
    )
    await fsp.writeFile(
        path.join(pkg, 'index.d.ts'),
        'export class SQL {}\nexport const sql: SQL\ndeclare module "bun:test" {}\n'
    )
}

test('planAuto: strips phantom bun:sql out of the spec before clarify sees it', async () => {
    await withTmpTaskDir(async dir => {
        await stubBunTypes(dir)
        await fsp.writeFile(
            path.join(dir, 'design.md'),
            'DB access via `bun:sql` built-in driver.\nConnect with bun:sql at startup.'
        )
        const {ctx} = makeFakeCtx(dir)
        let clarifyPrompt = ''
        const d: AutoDeps = {
            runChild: (name, _tools, prompt) => {
                if (name === 'auto-clarify') {
                    clarifyPrompt = prompt
                    return Promise.resolve('NONE')
                }
                return Promise.resolve('- [ ] Task A')
            },
            runTask: () =>
                Promise.resolve({taskId: 'TASK_0001', ok: true, sessionCancelled: false}),
            commit: () => Promise.resolve({committed: true})
        }
        await planAuto(ctx, dir, 'Implement @design.md', d)
        // The doc WAS inlined (clarify reasons over real content)…
        expect(clarifyPrompt).toContain('built-in driver')
        // …but every affirmative `bun:sql` is gone, rewritten to the real import.
        expect(clarifyPrompt).not.toContain('bun:sql')
        expect(clarifyPrompt).toContain('from "bun"')
        // And it left a grep-able plan-phase debug line.
        const log = await fsp.readFile(path.join(dir, '.pi-tasks', 'plan-debug.log'), 'utf8')
        expect(log).toContain('phantom specifiers rewritten in plan spec: bun:sql')
    })
})

test('planAuto: offers the recommendation as a green card in the boxed picker', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured, queueSelect} = makeFakeCtx(dir)
        queueSelect('local disk via Bun file APIs') // pick the recommended card
        const d = seqDeps(
            ['1. Where do photos live?\nSUGGESTED: local disk via Bun file APIs'],
            '- [ ] Task A'
        )
        const id = await planAuto(ctx, dir, 'add photo uploads', d)
        // The recommendation renders as its own card alongside the free-text
        // fallback — no bare text input is shown.
        expect(captured.inputs).toHaveLength(0)
        expect(captured.selects).toHaveLength(1)
        expect(captured.selects[0].options).toContain('local disk via Bun file APIs')
        expect(captured.selects[0].options).toContain('✎ Type a different answer…')
        // The question is the picker header; the recommendation is not crammed in.
        expect(captured.selects[0].title).toContain('Where do photos live?')
        // Picking the recommended card records it as accepted.
        const {body} = await readTaskFile(dir, id!)
        expect(body).toContain('A1: local disk via Bun file APIs (accepted recommendation)')
    })
})

test('planAuto: a binary fork offers two options (A/B) as a boxed picker', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured, queueSelect} = makeFakeCtx(dir)
        queueSelect('B: pnpm') // pick the alternative from the picker
        const d = seqDeps(['1. npm or pnpm?\nSUGGESTED: npm\nALT: pnpm'], '- [ ] Task A')
        const id = await planAuto(ctx, dir, 'set up tooling', d)
        // The fork renders as a boxed picker: both options are listed, labelled
        // A/B, with the free-text fallback appended. No bare text input is shown.
        expect(captured.inputs).toHaveLength(0)
        expect(captured.selects).toHaveLength(1)
        expect(captured.selects[0].options).toContain('A: npm')
        expect(captured.selects[0].options).toContain('B: pnpm')
        expect(captured.selects[0].options).toContain('✎ Type a different answer…')
        // The question is the picker header; the A/B options are not crammed into it.
        expect(captured.selects[0].title).toContain('npm or pnpm?')
        expect(captured.selects[0].title).not.toContain('A: npm')
        // Picking the B entry maps back to the alt option's full text.
        const {body} = await readTaskFile(dir, id!)
        expect(body).toContain('A1: pnpm')
    })
})

test('planAuto: renders markdown in the prompt but stores plain text', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured, queueSelect} = makeFakeCtx(dir)
        queueSelect('Native WebSockets via Bun.serve') // pick the recommended card
        const d = seqDeps(
            [
                '1. **What transport?** WebSockets or polling?\nSUGGESTED: **Native WebSockets** via `Bun.serve`'
            ],
            '- [ ] Task A'
        )
        const id = await planAuto(ctx, dir, 'messaging', d)
        // Header shows the question text (bold rendered; fake theme is identity, so
        // no literal ** markers leak through).
        expect(captured.selects[0].title).toContain('What transport?')
        expect(captured.selects[0].title).not.toContain('**')
        // The recommended card and the persisted answer are plain text.
        expect(captured.selects[0].options).toContain('Native WebSockets via Bun.serve')
        const {body} = await readTaskFile(dir, id!)
        expect(body).toContain('A1: Native WebSockets via Bun.serve (accepted recommendation)')
        expect(body).not.toContain('**')
    })
})

// Regression: on the real mx5 run the local model ignored "never re-ask" and
// barraged the user with the same "how to build/serve the SPA (Bun bundler vs
// Vite)" decision worded four ways (Q2/Q3/Q8/Q9 in TASK_AUTO_0001.md). The
// duplicate backstop must suppress the re-asks and stop the loop, so the user is
// only prompted for genuinely distinct decisions. Without the guard, all six
// generated questions would be surfaced (captured.inputs.length === 6).
test('planAuto: suppresses re-asked questions and stops after repeated dups', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured, queueInput} = makeFakeCtx(dir)
        queueInput('pg_trgm') // A1 (distinct: search)
        queueInput('single server, no vite') // A2 (distinct: SPA serve)
        queueInput('sharp resize') // A3 (distinct: image pipeline)
        // Verbatim-shaped questions from the failing run, in the order it asked.
        const d = seqDeps([
            "1. Should the search index use the PostgreSQL pg_trgm extension's similarity() function, or a simpler LIKE '%term%' approach to avoid the extension dependency?",
            "2. Should the Hono app's entry point (src/server/index.ts) serve the React SPA's index.html as a static catch-all, or should a separate frontend build step produce static assets served by an external tool like Vite dev server in development and nginx/Express in production?",
            "3. Should the React SPA's build and dev workflow use Bun's built-in bundler (esbuild), or should a separate Vite configuration be added?", // dup of Q2 → strike
            '4. Should the image upload pipeline process/resize images server-side before storing them in PostgreSQL, or store them as raw uploaded blobs?', // distinct → resets strikes
            '5. How should the React SPA be built and served by Bun without Vite — a single bun index.ts entry that compiles .tsx client files at runtime, or a separate build step (bun build src/client/main.tsx --outdir dist/client) serving static assets?', // dup → strike
            "6. Should the Hono entry point (src/server/index.ts) load .tsx pages at runtime via Bun's bundler in development with HMR, or should ALL .tsx page components be pre-compiled by bun build into dist/client even during development?" // dup → 2nd strike → break
        ])
        const id = await planAuto(ctx, dir, 'Implement marketplace', d)
        expect(id).toBe('TASK_AUTO_0001')
        // Only the three distinct questions reach the user; the three SPA-build
        // re-asks are suppressed.
        expect(captured.inputs.length).toBe(3)
        const {body} = await readTaskFile(dir, id!)
        expect(body).toContain('A1: pg_trgm')
        expect(body).toContain('A2: single server, no vite')
        expect(body).toContain('A3: sharp resize')
        // The loop terminated cleanly and produced a task list.
        expect(parseTaskList(body).length).toBeGreaterThan(0)
    })
})

test('planAuto: typed answer overrides the recommended card', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured, queueSelect, queueInput} = makeFakeCtx(dir)
        queueSelect('✎ Type a different answer…') // choose the free-text fallback card
        queueInput('object storage (S3)')
        const d = seqDeps(['1. Where do photos live?\nSUGGESTED: local disk'], '- [ ] Task A')
        const id = await planAuto(ctx, dir, 'add photo uploads', d)
        // The recommendation is offered as a card; choosing "type a different
        // answer" drops to the free-text input and stores the typed override.
        expect(captured.selects[0].options).toContain('local disk')
        const {body} = await readTaskFile(dir, id!)
        expect(body).toContain('A1: object storage (S3)')
        expect(body).not.toContain('accepted recommendation')
    })
})

test('planAuto: feeds each answer into the next clarify call (adaptive)', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, queueInput, queueSelect} = makeFakeCtx(dir)
        queueInput('React') // answer to Q1 (open question → text input)
        queueSelect('Bun bundler, no Vite') // accept Q2's recommended card
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
        // Each task is bracketed by a pre-start checkpoint commit and a post-task
        // commit (`task: <title> (<taskId>)`). On a clean tree the checkpoint is a
        // real no-op, but the fake commit always reports success, so both calls show.
        expect(commits).toEqual([
            'chore: checkpoint before "A"',
            'task: A (TASK_0006)',
            'chore: checkpoint before "B"',
            'task: B (TASK_0007)'
        ])
        const {frontMatter, body} = await readTaskFile(dir, 'TASK_AUTO_0001')
        expect(frontMatter.state).toBe('completed')
        expect(parseTaskList(body).every(e => e.done)).toBe(true)
    })
})

test("runAutoLoop: adopts each task's replacement ctx; never touches a stale one", async () => {
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

test('runAutoLoop: pre-task checkpoint announces only when it actually commits', async () => {
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
            runTask: () =>
                Promise.resolve({taskId: `TASK_000${n++}`, ok: true, sessionCancelled: false}),
            // Dirty tree before A (checkpoint commits), clean before B (no-op); the
            // post-task `task: ...` commits always land.
            commit: (_cwd, message) =>
                Promise.resolve(
                    message === 'chore: checkpoint before "B"' ?
                        {committed: false, reason: 'nothing to commit'}
                    :   {committed: true}
                )
        }
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        // Exactly one checkpoint announcement — the dirty one before A, not the
        // clean no-op before B.
        const checkpointed = captured.notifies.filter(nf => /checkpointed uncommitted/.test(nf.msg))
        expect(checkpointed.length).toBe(1)
        expect(checkpointed[0]?.msg).toContain('"A"')
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

test('runAutoLoop: a guideline violation only warns — task stays committed, run continues', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured} = makeFakeCtx(dir)
        await writeTaskFile(
            dir,
            autoFm('TASK_AUTO_0001'),
            buildAutoBody('feat', '(none)', ['A', 'B'])
        )
        const commits: string[] = []
        const d: AutoDeps = {
            runChild: () => Promise.resolve(''),
            runTask: () =>
                Promise.resolve({taskId: 'TASK_0006', ok: true, sessionCancelled: false}),
            commit: (_cwd, message) => {
                commits.push(message)
                return Promise.resolve({committed: true})
            },
            enforce: () => Promise.resolve({ok: false, reason: 'guideline violation: used print()'})
        }
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        const {frontMatter, body} = await readTaskFile(dir, 'TASK_AUTO_0001')
        // The task commit lands BEFORE enforcement, so an unfixable violation no
        // longer halts the run: both boxes check off and the file completes.
        expect(frontMatter.state).toBe('completed')
        expect(parseTaskList(body).every(e => e.done)).toBe(true)
        // The violation is surfaced as a warning, not a stop.
        expect(captured.notifies.some(n => /used print\(\)/.test(n.msg))).toBe(true)
        // Each task: checkpoint → `task: …` commit → separate `ENFORCE GUIDELINES`
        // commit (the enforce pass runs only because the task commit landed).
        expect(commits).toEqual([
            'chore: checkpoint before "A"',
            'task: A (TASK_0006)',
            'ENFORCE GUIDELINES: A (TASK_0006)',
            'chore: checkpoint before "B"',
            'task: B (TASK_0006)',
            'ENFORCE GUIDELINES: B (TASK_0006)'
        ])
    })
})

test('runAutoLoop: a failing verification STOPS the run and leaves the task unchecked', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured} = makeFakeCtx(dir)
        await writeTaskFile(
            dir,
            autoFm('TASK_AUTO_0001'),
            buildAutoBody('feat', '(none)', ['A', 'B'])
        )
        const commits: string[] = []
        const d: AutoDeps = {
            runChild: () => Promise.resolve(''),
            runTask: () =>
                Promise.resolve({taskId: 'TASK_0006', ok: true, sessionCancelled: false}),
            commit: (_cwd, message) => {
                commits.push(message)
                return Promise.resolve({committed: true})
            },
            verify: () =>
                Promise.resolve({ok: false, reason: 'work did not verify: bun run build exited 1'})
        }
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        const {frontMatter, body} = await readTaskFile(dir, 'TASK_AUTO_0001')
        // The gate runs BEFORE check-off/commit: the run halts at A, the file is
        // marked failed, and NEITHER box is checked (so resume re-runs A).
        expect(frontMatter.state).toBe('failed')
        expect(parseTaskList(body).some(e => e.done)).toBe(false)
        // Only the pre-task checkpoint ran — the task was never blessed with a
        // `task:` commit because verification failed first.
        expect(commits).toEqual(['chore: checkpoint before "A"'])
        // Second task is never reached.
        expect(
            captured.notifies.some(n => /verify exited 1|did not verify|build exited 1/.test(n.msg))
        ).toBe(true)
    })
})

test('runAutoLoop: a passing verification lets the run check off and complete', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), buildAutoBody('feat', '(none)', ['A']))
        let verified = 0
        const d: AutoDeps = {
            runChild: () => Promise.resolve(''),
            runTask: () =>
                Promise.resolve({taskId: 'TASK_0006', ok: true, sessionCancelled: false}),
            commit: () => Promise.resolve({committed: true}),
            verify: () => {
                verified++
                return Promise.resolve({ok: true})
            }
        }
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        const {frontMatter, body} = await readTaskFile(dir, 'TASK_AUTO_0001')
        expect(verified).toBe(1)
        expect(frontMatter.state).toBe('completed')
        expect(parseTaskList(body).every(e => e.done)).toBe(true)
    })
})

test('runAutoLoop: verification runs even when no commit lands (it gates the work, not the commit)', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), buildAutoBody('feat', '(none)', ['A']))
        let verified = 0
        const d: AutoDeps = {
            runChild: () => Promise.resolve(''),
            runTask: () =>
                Promise.resolve({taskId: 'TASK_0006', ok: true, sessionCancelled: false}),
            // Unlike enforce (which needs the last commit's diff), verification runs
            // against the working tree, so a no-commit round still verifies.
            commit: () => Promise.resolve({committed: false, reason: 'nothing to commit'}),
            verify: () => {
                verified++
                return Promise.resolve({ok: true})
            }
        }
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        expect(verified).toBe(1)
        expect((await readTaskFile(dir, 'TASK_AUTO_0001')).frontMatter.state).toBe('completed')
    })
})

test('runAutoLoop: enforce is skipped when the task commit did not land', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), buildAutoBody('feat', '(none)', ['A']))
        let enforced = 0
        const d: AutoDeps = {
            runChild: () => Promise.resolve(''),
            runTask: () =>
                Promise.resolve({taskId: 'TASK_0006', ok: true, sessionCancelled: false}),
            // No commit ever lands (e.g. autoCommit off / nothing to commit), so the
            // last commit isn't this task's work — there is nothing to enforce.
            commit: () => Promise.resolve({committed: false, reason: 'nothing to commit'}),
            enforce: () => {
                enforced++
                return Promise.resolve({ok: true})
            }
        }
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        expect(enforced).toBe(0)
        expect((await readTaskFile(dir, 'TASK_AUTO_0001')).frontMatter.state).toBe('completed')
    })
})

test('runAutoLoop: a clean guideline verdict lets the run complete normally', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        await writeTaskFile(
            dir,
            autoFm('TASK_AUTO_0001'),
            buildAutoBody('feat', '(none)', ['A', 'B'])
        )
        const enforced: string[] = []
        let n = 6
        const d: AutoDeps = {
            runChild: () => Promise.resolve(''),
            runTask: () =>
                Promise.resolve({taskId: `TASK_000${n++}`, ok: true, sessionCancelled: false}),
            commit: () => Promise.resolve({committed: true}),
            enforce: (_ctx, _cwd, title) => {
                enforced.push(title)
                return Promise.resolve({ok: true})
            }
        }
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        // Enforcement ran once per task, and the run completed with both boxes checked.
        expect(enforced).toEqual(['A', 'B'])
        const {frontMatter, body} = await readTaskFile(dir, 'TASK_AUTO_0001')
        expect(frontMatter.state).toBe('completed')
        expect(parseTaskList(body).every(e => e.done)).toBe(true)
    })
})

test('runAutoLoop: enforce gets the fresh post-task ctx, not the stale captured one', async () => {
    await withTmpTaskDir(async dir => {
        // Each task runs in a fresh session; runTask hands back the replacement
        // ctx. enforce must be invoked with THAT ctx — driving its loader widget
        // off the captured ctx throws "stale ctx" once a session was replaced.
        const {ctx} = makeFakeCtx(dir)
        const {ctx: freshCtx} = makeFakeCtx(dir)
        await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), buildAutoBody('feat', '(none)', ['A']))
        let seen: unknown
        const d: AutoDeps = {
            runChild: () => Promise.resolve(''),
            runTask: () =>
                Promise.resolve({
                    taskId: 'TASK_0006',
                    ok: true,
                    sessionCancelled: false,
                    ctx: freshCtx
                }),
            commit: () => Promise.resolve({committed: true}),
            enforce: enforceCtx => {
                seen = enforceCtx
                return Promise.resolve({ok: true})
            }
        }
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        expect(seen).toBe(freshCtx)
        expect(seen).not.toBe(ctx)
    })
})

test('runAutoLoop: surfaces a failed task reason in the stop message', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured} = makeFakeCtx(dir)
        await writeTaskFile(
            dir,
            autoFm('TASK_AUTO_0001'),
            buildAutoBody('feat', '(none)', ['A', 'B'])
        )
        const d: AutoDeps = {
            runChild: () => Promise.resolve(''),
            runTask: () =>
                Promise.resolve({
                    taskId: 'TASK_0006',
                    ok: false,
                    sessionCancelled: false,
                    reason: '400 request exceeds the available context size'
                }),
            commit: () => Promise.resolve({committed: true})
        }
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        // The first entry is never checked off, so resume re-runs it.
        const {body} = await readTaskFile(dir, 'TASK_AUTO_0001')
        expect(body).not.toContain('- [x]')
        expect(captured.notifies.some(n => /exceeds the available context size/.test(n.msg))).toBe(
            true
        )
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

test('runAutoLoop: a declined-steer interrupt pauses without checking off or advancing', async () => {
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
                // The inner task finished its pipeline (ok), but the user pressed
                // ESC and declined to steer — runSingleTask reports interrupted.
                return Promise.resolve({
                    taskId: 'TASK_0006',
                    ok: true,
                    sessionCancelled: false,
                    interrupted: true
                })
            },
            commit: () => Promise.resolve({committed: true})
        }
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        // Only the first task ran; the loop paused instead of advancing to B.
        expect(ran).toEqual(['A'])
        const {frontMatter, body} = await readTaskFile(dir, 'TASK_AUTO_0001')
        // Still in progress (resumable), and the task is NOT checked off — so a
        // /task-auto-resume re-delivers its spec to finish it.
        expect(frontMatter.state).toBe('in_progress')
        const entries = parseTaskList(body)
        expect(entries[0].done).toBe(false)
        expect(captured.notifies.some(n => /paused/i.test(n.msg))).toBe(true)
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

test('runAutoLoop: resumes an in-progress inner task instead of starting fresh', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        // Task A was started (inner TASK_0006 stamped) but interrupted before it
        // completed; B never started. Resume must continue TASK_0006, not spawn a
        // brand-new inner task for A.
        const body =
            '## feature prompt\n\nfeat\n\n## clarifications\n\n(none)\n\n## tasks\n\n- [ ] TASK_0006  A\n- [ ] B\n'
        await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), body)
        // The inner task's file must exist on disk for it to be resumable; the
        // loop only resumes a stamped id whose file is present.
        await writeTaskFile(dir, autoFm('TASK_0006'), '## prompt\n\nA\n')
        const resumeIds: Array<string | undefined> = []
        let fresh = 7
        const d: AutoDeps = {
            runChild: () => Promise.resolve(''),
            runTask: (_c, _cwd, _title, opts) => {
                resumeIds.push(opts?.resumeId)
                const taskId = opts?.resumeId ?? `TASK_000${fresh++}`
                return Promise.resolve({taskId, ok: true, sessionCancelled: false})
            },
            commit: () => Promise.resolve({committed: true})
        }
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        // A resumed via its stamped id; B (no stamp) starts fresh.
        expect(resumeIds).toEqual(['TASK_0006', undefined])
        expect((await readTaskFile(dir, 'TASK_AUTO_0001')).frontMatter.state).toBe('completed')
    })
})

test('runAutoLoop: stamps the inner task id at start so an interruption is resumable', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), buildAutoBody('feat', '(none)', ['A']))
        const d: AutoDeps = {
            runChild: () => Promise.resolve(''),
            // Allocate the inner id, stamp it via onStart, then simulate the session
            // dying mid-pipeline (sessionCancelled) before the task is checked off.
            runTask: async (_c, _cwd, _title, opts) => {
                await opts?.onStart?.('TASK_0009')
                return {taskId: '', ok: false, sessionCancelled: true}
            },
            commit: () => Promise.resolve({committed: true})
        }
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        // The entry is left undone but now carries the inner id, so a later
        // /task-auto-resume can continue TASK_0009 rather than start over.
        const entries = parseTaskList((await readTaskFile(dir, 'TASK_AUTO_0001')).body)
        expect(entries[0]).toEqual({index: 0, title: 'A', done: false, producedId: 'TASK_0009'})
    })
})

test('runAutoLoop: interrupt then resume continues the same inner task, never starts new', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        await writeTaskFile(
            dir,
            autoFm('TASK_AUTO_0001'),
            buildAutoBody('feat', '(none)', ['A', 'B'])
        )

        // ── Run 1: task A's inner pipeline starts (allocates TASK_0006, stamped)
        //    but the session dies before A completes. ──────────────────────────
        const seen1: Array<string | undefined> = []
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', {
            runChild: () => Promise.resolve(''),
            runTask: async (_c, _cwd, _title, opts) => {
                seen1.push(opts?.resumeId)
                await opts?.onStart?.('TASK_0006')
                // The runner writes the inner task file before the session dies;
                // run 2's resume relies on that file being present on disk.
                await writeTaskFile(dir, autoFm('TASK_0006'), '## prompt\n\nA\n')
                return {taskId: '', ok: false, sessionCancelled: true}
            },
            commit: () => Promise.resolve({committed: true})
        })
        expect(seen1).toEqual([undefined]) // A had no prior id -> fresh start, stamped

        // ── Run 2: /task-auto-resume picks up where it left off. A must resume
        //    TASK_0006 (not a new id); then B runs fresh. ──────────────────────
        const seen2: Array<string | undefined> = []
        let fresh = 7
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', {
            runChild: () => Promise.resolve(''),
            runTask: (_c, _cwd, _title, opts) => {
                seen2.push(opts?.resumeId)
                return Promise.resolve({
                    taskId: opts?.resumeId ?? `TASK_000${fresh++}`,
                    ok: true,
                    sessionCancelled: false
                })
            },
            commit: () => Promise.resolve({committed: true})
        })
        expect(seen2).toEqual(['TASK_0006', undefined])
        const {frontMatter, body} = await readTaskFile(dir, 'TASK_AUTO_0001')
        expect(frontMatter.state).toBe('completed')
        expect(parseTaskList(body)).toEqual([
            {index: 0, title: 'A', done: true, producedId: 'TASK_0006'},
            {index: 1, title: 'B', done: true, producedId: 'TASK_0007'}
        ])
    })
})

test('runAutoLoop: a stamped inner task with a missing file restarts fresh, never crashes', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        // A was stamped TASK_0006 but its inner file is gone (never written, or
        // deleted out-of-band). Resuming a missing file throws ENOENT in the
        // runner and used to crash pi; the loop must fall back to a fresh start.
        const body =
            '## feature prompt\n\nfeat\n\n## clarifications\n\n(none)\n\n## tasks\n\n- [ ] TASK_0006  A\n'
        await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), body)
        const resumeIds: Array<string | undefined> = []
        const d: AutoDeps = {
            runChild: () => Promise.resolve(''),
            runTask: (_c, _cwd, _title, opts) => {
                resumeIds.push(opts?.resumeId)
                return Promise.resolve({taskId: 'TASK_0009', ok: true, sessionCancelled: false})
            },
            commit: () => Promise.resolve({committed: true})
        }
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        // No resume attempted (file missing) -> fresh start, re-stamped + checked.
        expect(resumeIds).toEqual([undefined])
        const {frontMatter, body: out} = await readTaskFile(dir, 'TASK_AUTO_0001')
        expect(frontMatter.state).toBe('completed')
        expect(parseTaskList(out)).toEqual([
            {index: 0, title: 'A', done: true, producedId: 'TASK_0009'}
        ])
    })
})

test('runAutoLoop: an unexpected throw is caught, marks failed, and never propagates', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), buildAutoBody('feat', '(none)', ['A']))
        const d: AutoDeps = {
            runChild: () => Promise.resolve(''),
            runTask: () => Promise.reject(new Error('boom')),
            commit: () => Promise.resolve({committed: true})
        }
        // Must resolve, not reject — an escaping rejection used to take pi down.
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        expect((await readTaskFile(dir, 'TASK_AUTO_0001')).frontMatter.state).toBe('failed')
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

test('expandFeatureMentions: strips trailing prose punctuation off the @-mention', async () => {
    // A user typing the feature inline naturally writes "@spec.md, reuse…" or
    // "@spec.md." — the greedy [^\s]+ swallows the comma/period into the path, the
    // file fails to resolve, and the spec is silently NOT inlined (the model then
    // fabricates generic questions). Validated against a real 32KB design doc.
    await withTmpTaskDir(async dir => {
        await fsp.writeFile(path.join(dir, 'spec.md'), '# Spec\n\nBuild the thing.\n')
        for (const f of [
            'Implement @spec.md, reuse current directory',
            'see @spec.md.',
            'follow @spec.md; then build'
        ]) {
            const out = await expandFeatureMentions(dir, f)
            expect(out).toContain('--- contents of spec.md ---')
            expect(out).toContain('Build the thing.')
        }
    })
})

test('readableMentions: returns only @refs that resolve to a real file, deduped', async () => {
    await withTmpTaskDir(async dir => {
        await fsp.writeFile(path.join(dir, 'spec.md'), '# Spec')
        expect(await readableMentions(dir, 'Implement @spec.md and @spec.md')).toEqual(['spec.md'])
        expect(await readableMentions(dir, 'see @missing.md')).toEqual([])
        expect(await readableMentions(dir, 'no mentions here')).toEqual([])
        // trailing prose punctuation must not defeat resolution (mirrors expand)
        expect(await readableMentions(dir, 'Implement @spec.md, reuse it')).toEqual(['spec.md'])
    })
})

test('buildScopeFence: marks the current step and lists every sibling by number', () => {
    const titles = ['Scaffold project', 'Build database schema', 'Build auth routes']
    const fence = buildScopeFence(titles, 0)
    expect(fence).toContain('STEP 1 of 3')
    expect(fence).toContain('[1] (THIS STEP) Scaffold project')
    expect(fence).toContain('[2] Build database schema')
    expect(fence).toContain('[3] Build auth routes')
    // Only the current step is tagged.
    expect(fence.match(/\(THIS STEP\)/g)).toHaveLength(1)
    expect(fence).toContain('do NOT implement them here')
})

test('buildScopeFence: tags a middle step and keeps the count right', () => {
    const fence = buildScopeFence(['a', 'b', 'c', 'd'], 2)
    expect(fence).toContain('STEP 3 of 4')
    expect(fence).toContain('[3] (THIS STEP) c')
})

test('buildScopeFence: strips the threaded "| decisions | spec" tail from the plan listing', () => {
    const threaded = attachSpecRefs(['Scaffold project'], ['DESIGN/spec.md'])
    const fence = buildScopeFence([...threaded, 'Build auth routes'], 0)
    // The listing shows the clean head, not the authoritative-spec suffix.
    expect(fence).toContain('[1] (THIS STEP) Scaffold project')
    expect(fence).not.toContain('| spec:')
    expect(fence).not.toContain('authoritative')
})

test('attachSpecRefs: appends an authoritative spec suffix to every title', () => {
    const out = attachSpecRefs(['Scaffold project', 'Build auth routes'], ['DESIGN/spec.md'])
    expect(out).toHaveLength(2)
    for (const t of out) {
        expect(t).toContain('| spec: @DESIGN/spec.md')
        expect(t).toContain('authoritative')
    }
    expect(out[0].startsWith('Scaffold project')).toBe(true)
})

test('attachSpecRefs: no refs leaves titles unchanged (doc-less /task-auto)', () => {
    const titles = ['Task A', 'Task B']
    expect(attachSpecRefs(titles, [])).toEqual(titles)
})

test('attachSpecRefs: idempotent — does not double-append if a title already has the suffix', () => {
    const once = attachSpecRefs(['Task A'], ['spec.md'])
    expect(attachSpecRefs(once, ['spec.md'])).toEqual(once)
})

test('attachSpecRefs: multiple refs all appear in the suffix', () => {
    const [t] = attachSpecRefs(['Task A'], ['a.md', 'b.md'])
    expect(t).toContain('@a.md')
    expect(t).toContain('@b.md')
})

test('attachSpecRefs: a [decisions:] clause is lifted out and marked as overriding the doc', () => {
    const [t] = attachSpecRefs(
        ['Scaffold project [decisions: use Bun bundler, do not add vite]'],
        ['DESIGN/spec.md']
    )
    // base title preserved, decisions clause stripped from it
    expect(t.startsWith('Scaffold project |')).toBe(true)
    expect(t).not.toContain('[decisions:')
    // decisions are framed as overriding the doc, and the doc stays authoritative otherwise
    expect(t).toContain('decisions')
    expect(t).toContain('OVERRIDE the spec doc')
    expect(t).toContain('use Bun bundler, do not add vite')
    expect(t).toContain('| spec: @DESIGN/spec.md')
    // decisions precede the spec clause so the override reads before the doc ref
    expect(t.indexOf('decisions')).toBeLessThan(t.indexOf('| spec:'))
})

test('attachSpecRefs: decisions are honoured even with no spec doc (doc-less /task-auto)', () => {
    const [t] = attachSpecRefs(['Scaffold project [decisions: no vite]'], [])
    expect(t).toContain('decisions')
    expect(t).toContain('no vite')
    expect(t).not.toContain('| spec:')
    expect(t).not.toContain('[decisions:')
})

test('attachSpecRefs: a task without decisions is unaffected by the decisions logic', () => {
    const [withDec, plain] = attachSpecRefs(
        ['Build auth [decisions: argon2id only]', 'Build listings'],
        ['spec.md']
    )
    expect(withDec).toContain('argon2id only')
    expect(plain).toBe(
        'Build listings | spec: @spec.md — otherwise authoritative; read it and follow it over this title wherever they differ'
    )
})

test('attachSpecRefs: idempotent when a decisions clause was already threaded', () => {
    const once = attachSpecRefs(['Scaffold [decisions: no vite]'], [])
    expect(attachSpecRefs(once, [])).toEqual(once)
})
