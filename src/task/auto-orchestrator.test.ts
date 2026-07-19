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
import {ACCEPT_LABEL, AUTOFIX_LABEL} from './verify-resolution.js'
import {readAcceptDebts} from './accept-debt.js'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import {spawnSync} from 'node:child_process'

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

test('planAuto: clarify-triage auto-resolves a spec-settled question (never shown)', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured} = makeFakeCtx(dir)
        // The exact failure class: the gen model asks a question the spec already
        // settles (HTTP server adapter). The triage child answers it from the spec,
        // so it must be suppressed — the user is never prompted.
        let clarifyCall = 0
        const d: AutoDeps = {
            runChild: (name, _tools, _prompt) => {
                if (name === 'auto-clarify') {
                    const responses = [
                        "1. Should the server use Hono's Bun adapter or the Node adapter?\nSUGGESTED: Hono Bun adapter"
                    ]
                    return Promise.resolve(responses[clarifyCall++] ?? 'NONE')
                }
                if (name === 'clarify-triage') {
                    return Promise.resolve(
                        "ANSWER: use Hono's Bun adapter — the spec pins Bun.serve via it"
                    )
                }
                return Promise.resolve('- [ ] Task A')
            },
            runTask: () =>
                Promise.resolve({taskId: 'TASK_0001', ok: true, sessionCancelled: false}),
            commit: () => Promise.resolve({committed: true})
        }
        const id = await planAuto(ctx, dir, 'Implement server', d)
        // The user was NEVER asked — the settled question was auto-resolved.
        expect(captured.inputs.length).toBe(0)
        expect(captured.selects.length).toBe(0)
        // …but the resolved decision is recorded so decompose sees it.
        const {body} = await readTaskFile(dir, id!)
        expect(body).toContain('auto-resolved')
        expect(body).toContain("Hono's Bun adapter")
    })
})

test('planAuto: feeds the existing-files block into clarify-triage when a manifest is on disk', async () => {
    if (spawnSync('which', ['git']).status !== 0) return
    await withTmpTaskDir(async dir => {
        // A real git repo with a tracked package.json → refineExistingFilesBlock
        // emits the REFINE_PRESERVE_DIRECTIVE + manifest content, which must reach
        // the triage so a "scaffold from scratch" question resolves to preserve.
        await fsp.writeFile(
            path.join(dir, 'package.json'),
            JSON.stringify({name: 'x', devDependencies: {eslint: '9.0.0'}}, null, 2)
        )
        for (const args of [
            ['init', '-q'],
            ['config', 'user.email', 't@t'],
            ['config', 'user.name', 't'],
            ['add', '.'],
            ['commit', '-q', '-m', 'init']
        ]) {
            spawnSync('git', args, {cwd: dir})
        }
        const {ctx} = makeFakeCtx(dir)
        let triagePrompt = ''
        let clarifyCall = 0
        const d: AutoDeps = {
            runChild: (name, _tools, prompt) => {
                if (name === 'auto-clarify') {
                    const responses = [
                        '1. Should the setup task scaffold package.json from scratch?'
                    ]
                    return Promise.resolve(responses[clarifyCall++] ?? 'NONE')
                }
                if (name === 'clarify-triage') {
                    triagePrompt = prompt
                    return Promise.resolve(
                        'ANSWER: build on the existing package.json, preserving its deps'
                    )
                }
                return Promise.resolve('- [ ] Task A')
            },
            runTask: () =>
                Promise.resolve({taskId: 'TASK_0001', ok: true, sessionCancelled: false}),
            commit: () => Promise.resolve({committed: true})
        }
        await planAuto(ctx, dir, 'set up the project', d)
        // The preserve directive AND the real manifest content reached the triage.
        expect(triagePrompt).toContain('EXISTING FILES ON DISK')
        expect(triagePrompt).toContain('eslint')
    })
})

test('planAuto: clarify-triage surfaces a genuine open fork (UNKNOWN)', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured, queueSelect} = makeFakeCtx(dir)
        queueSelect('local disk') // accept the surfaced recommendation
        let clarifyCall = 0
        const d: AutoDeps = {
            runChild: (name, _tools, _prompt) => {
                if (name === 'auto-clarify') {
                    const responses = ['1. Where do photos live?\nSUGGESTED: local disk']
                    return Promise.resolve(responses[clarifyCall++] ?? 'NONE')
                }
                if (name === 'clarify-triage') {
                    // The spec leaves this open → triage tags it UNKNOWN → surfaced.
                    return Promise.resolve('UNKNOWN: local disk')
                }
                return Promise.resolve('- [ ] Task A')
            },
            runTask: () =>
                Promise.resolve({taskId: 'TASK_0001', ok: true, sessionCancelled: false}),
            commit: () => Promise.resolve({committed: true})
        }
        const id = await planAuto(ctx, dir, 'add photo uploads', d)
        // A genuine fork reaches the user exactly as before.
        expect(captured.selects.length).toBe(1)
        const {body} = await readTaskFile(dir, id!)
        expect(body).toContain('A1: local disk')
        expect(body).not.toContain('auto-resolved')
    })
})

test('planAuto: clarify-triage failure falls back to surfacing the question', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured, queueInput} = makeFakeCtx(dir)
        queueInput('Redis')
        let clarifyCall = 0
        const d: AutoDeps = {
            runChild: (name, _tools, _prompt) => {
                if (name === 'auto-clarify') {
                    const responses = ['1. Which store?']
                    return Promise.resolve(responses[clarifyCall++] ?? 'NONE')
                }
                if (name === 'clarify-triage') {
                    return Promise.reject(new Error('triage child crashed'))
                }
                return Promise.resolve('- [ ] Task A')
            },
            runTask: () =>
                Promise.resolve({taskId: 'TASK_0001', ok: true, sessionCancelled: false}),
            commit: () => Promise.resolve({committed: true})
        }
        const id = await planAuto(ctx, dir, 'add billing', d)
        // Triage threw → the question is still shown, never silently dropped.
        expect(captured.inputs.length).toBe(1)
        const {body} = await readTaskFile(dir, id!)
        expect(body).toContain('A1: Redis')
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
        const {ctx, captured} = makeFakeCtx(dir)
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
        // Each task announces its position so the user sees progress.
        expect(captured.notifies.some(nf => /task 1\/2 — A/.test(nf.msg))).toBe(true)
        expect(captured.notifies.some(nf => /task 2\/2 — B/.test(nf.msg))).toBe(true)
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
        const enforceModes: Array<'edit' | 'flag'> = []
        const d: AutoDeps = {
            runChild: () => Promise.resolve(''),
            runTask: () =>
                Promise.resolve({taskId: 'TASK_0006', ok: true, sessionCancelled: false}),
            commit: (_cwd, message) => {
                commits.push(message)
                return Promise.resolve({committed: true})
            },
            enforce: (_c, _cwd, _title, mode) => {
                enforceModes.push(mode)
                return Promise.resolve({ok: false, reason: 'guideline violation: used print()'})
            }
        }
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        const {frontMatter, body} = await readTaskFile(dir, 'TASK_AUTO_0001')
        // The task commit lands BEFORE enforcement, so an unfixable violation no
        // longer halts the run: both boxes check off and the file completes.
        expect(frontMatter.state).toBe('completed')
        expect(parseTaskList(body).every(e => e.done)).toBe(true)
        // The violation is surfaced as a warning, not a stop.
        expect(captured.notifies.some(n => /used print\(\)/.test(n.msg))).toBe(true)
        // No verify dep ⇒ no signal to guard a destructive edit ⇒ enforcement runs
        // in FLAG mode (read-only, report don't fix). It makes no edits, so there is
        // NO separate `ENFORCE GUIDELINES` commit — only the per-task commits.
        expect(enforceModes).toEqual(['flag', 'flag'])
        expect(commits).toEqual([
            'chore: checkpoint before "A"',
            'task: A (TASK_0006)',
            'chore: checkpoint before "B"',
            'task: B (TASK_0006)'
        ])
    })
})

test('runAutoLoop: clean verify ⇒ enforce runs in EDIT mode; fixes that re-verify clean are committed', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), buildAutoBody('feat', '(none)', ['A']))
        const commits: string[] = []
        const enforceModes: Array<'edit' | 'flag'> = []
        let reverted = false
        const d: AutoDeps = {
            runChild: () => Promise.resolve(''),
            runTask: () =>
                Promise.resolve({taskId: 'TASK_0006', ok: true, sessionCancelled: false}),
            commit: (_cwd, message) => {
                commits.push(message)
                return Promise.resolve({committed: true})
            },
            // Genuine clean pass (ok, no reason) BOTH times: the gate before
            // enforcement and the differential guard after it.
            verify: () => Promise.resolve({ok: true}),
            enforce: (_c, _cwd, _t, mode) => {
                enforceModes.push(mode)
                return Promise.resolve({ok: true})
            },
            revert: () => {
                reverted = true
                return Promise.resolve()
            }
        }
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        // A clean verify signal exists ⇒ enforce is licensed to edit.
        expect(enforceModes).toEqual(['edit'])
        // Re-verify stayed clean ⇒ the guideline fixes are kept and committed; the
        // verified work was never reverted.
        expect(reverted).toBe(false)
        expect(commits).toContain('ENFORCE GUIDELINES: A (TASK_0006)')
    })
})

test('runAutoLoop: enforce edits that REGRESS the verify signal are reverted, not kept', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured} = makeFakeCtx(dir)
        await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), buildAutoBody('feat', '(none)', ['A']))
        const commits: string[] = []
        let reverted = false
        let verifyCalls = 0
        const d: AutoDeps = {
            runChild: () => Promise.resolve(''),
            runTask: () =>
                Promise.resolve({taskId: 'TASK_0006', ok: true, sessionCancelled: false}),
            commit: (_cwd, message) => {
                commits.push(message)
                return Promise.resolve({committed: true})
            },
            // 1st call = the gate: clean pass (licenses edit mode). 2nd call = the
            // differential guard AFTER enforcement: now FAILS ⇒ enforce regressed it.
            verify: () => {
                verifyCalls += 1
                return Promise.resolve(
                    verifyCalls === 1 ?
                        {ok: true}
                    :   {ok: false, reason: 'work did not verify: tsc 3 errors'}
                )
            },
            enforce: () => Promise.resolve({ok: true}),
            revert: () => {
                reverted = true
                return Promise.resolve()
            }
        }
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        // The guard fired: the enforce commit was dropped and the verified work kept.
        expect(verifyCalls).toBe(2)
        expect(reverted).toBe(true)
        // The regression is surfaced as a warning, and the run still completes (the
        // verified task commit stands; only the bad guideline edits were dropped).
        expect(captured.notifies.some(n => /regressed verification/.test(n.msg))).toBe(true)
        expect((await readTaskFile(dir, 'TASK_AUTO_0001')).frontMatter.state).toBe('completed')
    })
})

test('runAutoLoop: verify FAIL + user dismisses the picker → run pauses, task unchecked', async () => {
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
                Promise.resolve({ok: false, reason: 'work did not verify: bun run build exited 1'}),
            recommend: () => Promise.resolve({recommend: 'autofix', rationale: 'build is broken'})
        }
        // No queueSelect → the picker is dismissed (cancel).
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        const {frontMatter, body} = await readTaskFile(dir, 'TASK_AUTO_0001')
        // Dismissing the choice pauses the run at A: file marked failed, NEITHER
        // box checked (resume re-runs A).
        expect(frontMatter.state).toBe('failed')
        expect(parseTaskList(body).some(e => e.done)).toBe(false)
        // Only the pre-task checkpoint ran — no `task:` commit (work not blessed).
        expect(commits).toEqual(['chore: checkpoint before "A"'])
        expect(captured.notifies.some(n => /dismissed the choice/.test(n.msg))).toBe(true)
    })
})

test('runAutoLoop: verify FAIL + user ACCEPTS → run proceeds, checks off and commits', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        const {ctx, captured} = handle
        await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), buildAutoBody('feat', '(none)', ['A']))
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
                Promise.resolve({ok: false, reason: 'work did not verify: over-strict check'}),
            recommend: () =>
                Promise.resolve({recommend: 'accept', rationale: 'gate misjudged a valid file'})
        }
        handle.queueSelect(ACCEPT_LABEL)
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        const {frontMatter, body} = await readTaskFile(dir, 'TASK_AUTO_0001')
        // Accept overrides the FAIL: the task checks off, commits, and completes.
        expect(frontMatter.state).toBe('completed')
        expect(parseTaskList(body).every(e => e.done)).toBe(true)
        expect(commits).toEqual(['chore: checkpoint before "A"', 'task: A (TASK_0006)'])
        expect(captured.notifies.some(n => /accepted .* despite verify FAIL/.test(n.msg))).toBe(
            true
        )
    })
})

test('runAutoLoop: AUTOFIX loops back to the gate uncapped until the work verifies', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        const {ctx} = handle
        await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), buildAutoBody('feat', '(none)', ['A']))
        const commits: string[] = []
        const fixInstructions: Array<string | undefined> = []
        let verifyCalls = 0
        const d: AutoDeps = {
            runChild: () => Promise.resolve(''),
            runTask: (_c, _cwd, _t, opts) => {
                fixInstructions.push(opts?.fixInstruction)
                return Promise.resolve({taskId: 'TASK_0006', ok: true, sessionCancelled: false})
            },
            commit: (_cwd, message) => {
                commits.push(message)
                return Promise.resolve({committed: true})
            },
            verify: () => {
                verifyCalls++
                // FAIL the first THREE times — past any 2-attempt cap — then PASS,
                // proving the autofix loop is uncapped (the user keeps picking it).
                return Promise.resolve(
                    verifyCalls <= 3 ?
                        {ok: false, reason: 'work did not verify: bun run build exited 1'}
                    :   {ok: true}
                )
            },
            recommend: () => Promise.resolve({recommend: 'autofix', rationale: 'real build defect'})
        }
        // The user picks AUTOFIX on every FAIL (more than a 2-attempt cap would allow).
        handle.queueSelect(AUTOFIX_LABEL)
        handle.queueSelect(AUTOFIX_LABEL)
        handle.queueSelect(AUTOFIX_LABEL)
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        const {frontMatter, body} = await readTaskFile(dir, 'TASK_AUTO_0001')
        // Initial impl (no fixInstruction) + three autofix re-runs, each carrying
        // the verify failure as its fixInstruction.
        expect(fixInstructions).toHaveLength(4)
        expect(fixInstructions[0]).toBeUndefined()
        expect(fixInstructions.slice(1).every(f => f?.includes('bun run build exited 1'))).toBe(
            true
        )
        // Verify ran four times (initial + three re-runs); the 4th PASS checks off.
        expect(verifyCalls).toBe(4)
        expect(frontMatter.state).toBe('completed')
        expect(parseTaskList(body).every(e => e.done)).toBe(true)
        expect(commits).toEqual(['chore: checkpoint before "A"', 'task: A (TASK_0006)'])
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

// ─── Decompose coverage gate ─────────────────────────────────────────────────

// Deps where decompose/coverage responses are scripted per call. Clarify always
// says NONE so planAuto goes straight to decompose.
function coverageDeps(
    decomposeResponses: string[],
    coverageResponses: Array<string | Error>
): AutoDeps & {calls: {decompose: number; coverage: number; hints: string[]}} {
    const calls = {decompose: 0, coverage: 0, hints: [] as string[]}
    return {
        calls,
        runChild: (name, _tools, prompt) => {
            if (name === 'auto-clarify') return Promise.resolve('NONE')
            if (name === 'auto-decompose') {
                calls.hints.push(prompt)
                return Promise.resolve(decomposeResponses[calls.decompose++] ?? '')
            }
            if (name === 'decompose-coverage') {
                const r = coverageResponses[calls.coverage++]
                if (r instanceof Error) return Promise.reject(r)
                return Promise.resolve(r ?? 'COVERAGE: COMPLETE')
            }
            return Promise.resolve('')
        },
        runTask: () => Promise.resolve({taskId: 'TASK_0001', ok: true, sessionCancelled: false}),
        commit: () => Promise.resolve({committed: true})
    }
}

test('coverage gate: INCOMPLETE verdict reprompts decompose with the missing areas', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        const d = coverageDeps(
            [
                '- [ ] Scaffold project',
                '- [ ] Scaffold project\n- [ ] Auth routes\n- [ ] Admin page'
            ],
            [
                'COVERAGE: INCOMPLETE\nMISSING: auth routes\nMISSING: admin page',
                'COVERAGE: COMPLETE'
            ]
        )
        const id = await planAuto(ctx, dir, 'build the app', d)
        expect(d.calls.decompose).toBe(2)
        // The retry prompt carries the judge's missing areas as a hint.
        expect(d.calls.hints[1]).toContain('INCOMPLETE')
        expect(d.calls.hints[1]).toContain('auth routes; admin page')
        const {body} = await readTaskFile(dir, id!)
        expect(parseTaskList(body).map(e => e.title)).toEqual([
            'Scaffold project',
            'Auth routes',
            'Admin page'
        ])
        const log = await fsp.readFile(path.join(dir, '.pi-tasks', 'plan-debug.log'), 'utf8')
        expect(log).toContain('decompose produced 1 title(s)')
        expect(log).toContain('INCOMPLETE — missing: auth routes; admin page')
    })
})

test('coverage gate: a flaky shorter retry never replaces the longer list', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        const d = coverageDeps(
            ['- [ ] Task A\n- [ ] Task B\n- [ ] Task C', '- [ ] Lone degenerate task'],
            [
                'COVERAGE: INCOMPLETE\nMISSING: something',
                'COVERAGE: COMPLETE' // judges the KEPT original list on round 2
            ]
        )
        const id = await planAuto(ctx, dir, 'build the app', d)
        const {body} = await readTaskFile(dir, id!)
        expect(parseTaskList(body).map(e => e.title)).toEqual(['Task A', 'Task B', 'Task C'])
        const log = await fsp.readFile(path.join(dir, '.pi-tasks', 'plan-debug.log'), 'utf8')
        expect(log).toContain('decompose retry REJECTED — collapse floor (1 vs 3 titles)')
    })
})

test('coverage gate: an equal-length retry that closes the gap IS adopted', async () => {
    // mx5 run 5 regression: the judge flagged the missing test-suite task, the hinted
    // retry ADDED it but came back 29 titles vs the original 30, and strictly-longer
    // retention discarded the better-informed list — round 2 then re-judged the same
    // unchanged plan. A non-degenerate retry must be adopted regardless of length;
    // the NEXT round's judge decides whether the gaps closed.
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        const d = coverageDeps(
            [
                '- [ ] Scaffold\n- [ ] Auth routes\n- [ ] Admin page',
                '- [ ] Scaffold\n- [ ] Auth routes\n- [ ] Test suite covering auth and admin'
            ],
            ['COVERAGE: INCOMPLETE\nMISSING: test suite', 'COVERAGE: COMPLETE']
        )
        const id = await planAuto(ctx, dir, 'build the app', d)
        const {body} = await readTaskFile(dir, id!)
        expect(parseTaskList(body).map(e => e.title)).toEqual([
            'Scaffold',
            'Auth routes',
            'Test suite covering auth and admin'
        ])
        // Round 2 judged the ADOPTED retry (COMPLETE), not the discarded original.
        expect(d.calls.coverage).toBe(2)
    })
})

test('coverage gate: rounds exhausted still INCOMPLETE → user is warned, not silent', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured} = makeFakeCtx(dir)
        const d = coverageDeps(
            [
                '- [ ] Task A\n- [ ] Task B',
                '- [ ] Task A\n- [ ] Task B',
                '- [ ] Task A\n- [ ] Task B'
            ],
            // One verdict per SCORED plan: the initial list plus each retry (the
            // retry is now judged before it can be adopted). All stay INCOMPLETE, so
            // the loop exhausts and the last-scored plan's gap is what surfaces.
            [
                'COVERAGE: INCOMPLETE\nMISSING: x',
                'COVERAGE: INCOMPLETE\nMISSING: y',
                'COVERAGE: INCOMPLETE\nMISSING: test suite for auth'
            ]
        )
        const id = await planAuto(ctx, dir, 'build the app', d)
        expect(id).not.toBeNull() // best-effort: the plan still ships
        const warn = captured.notifies.find(n => /no task fully owns/.test(n.msg))
        expect(warn).toBeDefined()
        expect(warn!.msg).toContain('test suite for auth')
        const log = await fsp.readFile(path.join(dir, '.pi-tasks', 'plan-debug.log'), 'utf8')
        expect(log).toContain(
            'exhausted 2 round(s) still INCOMPLETE — missing: test suite for auth'
        )
    })
})

test('coverage gate: COMPLETE on the second round leaves no exhaustion warning', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured} = makeFakeCtx(dir)
        const d = coverageDeps(
            ['- [ ] Task A\n- [ ] Task B', '- [ ] Task A\n- [ ] Task B\n- [ ] Tests'],
            ['COVERAGE: INCOMPLETE\nMISSING: tests', 'COVERAGE: COMPLETE']
        )
        await planAuto(ctx, dir, 'build the app', d)
        expect(captured.notifies.some(n => /no task fully owns/.test(n.msg))).toBe(false)
    })
})

test('coverage gate: COMPLETE verdict accepts the first list without a retry', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        const d = coverageDeps(['- [ ] Task A\n- [ ] Task B'], ['COVERAGE: COMPLETE'])
        await planAuto(ctx, dir, 'build the app', d)
        expect(d.calls.decompose).toBe(1)
        expect(d.calls.coverage).toBe(1)
    })
})

test('coverage gate: judge fault or prose verdict is best-effort — list accepted', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        // Throwing judge.
        const dThrow = coverageDeps(['- [ ] Task A'], [new Error('boom')])
        const id1 = await planAuto(ctx, dir, 'build the app', dThrow)
        expect(parseTaskList((await readTaskFile(dir, id1!)).body).length).toBe(1)
        // Prose (untagged) judge.
        const dProse = coverageDeps(['- [ ] Task A'], ['looks fine to me'])
        const id2 = await planAuto(ctx, dir, 'build the app', dProse)
        expect(parseTaskList((await readTaskFile(dir, id2!)).body).length).toBe(1)
        expect(dProse.calls.decompose).toBe(1)
    })
})

test('coverage gate: a judge that keeps flagging is bounded to MAX rounds', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        const d = coverageDeps(
            ['- [ ] Task A', '- [ ] Task A\n- [ ] Task B', '- [ ] Task A\n- [ ] Task B\n- [ ] C'],
            [
                'COVERAGE: INCOMPLETE\nMISSING: x',
                'COVERAGE: INCOMPLETE\nMISSING: y',
                'COVERAGE: INCOMPLETE\nMISSING: z'
            ]
        )
        const id = await planAuto(ctx, dir, 'build the app', d)
        // 2 reprompt rounds: initial decompose + 2 retries. The judge scores every
        // plan it might ship — the initial list AND each retry before adoption — so
        // it is consulted 3× (was 2× when the final retry shipped unscored).
        expect(d.calls.decompose).toBe(3)
        expect(d.calls.coverage).toBe(3)
        expect(parseTaskList((await readTaskFile(dir, id!)).body).length).toBe(3)
    })
})

// ─── Monotonic coverage replacement, end-to-end through planAuto (mx5 run 12) ──
//
// The wired proof for the A/B in coverage-loop.test.ts: a full-stack-shaped run
// whose initial plan covers an area (the --json output) that a later coverage
// regeneration DROPS while chasing an un-ownable NEGATIVE requirement. The loop
// must keep the good plan, not adopt the dropping one. Non-web archetype (a CLI)
// on purpose — the fix is the class, not a web-app special case.
const DEDUP_CLI_SPEC = [
    'Build a file-deduplication CLI.',
    '',
    'Behaviour:',
    '- the CLI scans a directory tree for duplicate files',
    '- a --json flag emits machine-readable output',
    '- a summary report lists reclaimed space',
    '',
    'Safety: the tool must never delete a file without an explicit --apply flag.'
].join('\n')

const DEDUP_REQS = [
    'REQUIREMENT: "the CLI scans a directory tree for duplicate files"',
    'REQUIREMENT: "a --json flag emits machine-readable output"',
    'REQUIREMENT: "a summary report lists reclaimed space"',
    'REQUIREMENT: "the tool must never delete a file without an explicit --apply flag"'
].join('\n')

const DEDUP_GOOD =
    '- [ ] Scan directory tree for duplicate files\n- [ ] Add a --json machine-readable output flag'
const DEDUP_DROP =
    '- [ ] Scan directory tree for duplicate files\n- [ ] Generate a summary report of reclaimed space'

// Deterministic stub: the initial decompose yields the GOOD plan (has --json), and
// every regeneration yields the DROPPING plan (has the summary report, no --json).
// The judge always says COMPLETE — the host-side per-requirement map is what drives
// the loop, mirroring the goal-A accounting.
function dedupCliDeps(): AutoDeps & {calls: {decompose: number}} {
    const calls = {decompose: 0}
    return {
        calls,
        runChild: (name, _tools, prompt) => {
            if (name === 'auto-clarify') return Promise.resolve('NONE')
            if (name === 'requirement-extract') return Promise.resolve(DEDUP_REQS)
            if (name === 'auto-decompose') {
                calls.decompose++
                return Promise.resolve(calls.decompose === 1 ? DEDUP_GOOD : DEDUP_DROP)
            }
            if (name === 'decompose-coverage') return Promise.resolve('COVERAGE: COMPLETE')
            if (name === 'coverage-map') {
                // Read the TASK LIST section only — the requirement quotes above it
                // also mention --json / summary report, so scan the plan, not the reqs.
                const tasks = prompt.split('TASK LIST:')[1] ?? ''
                const hasJson = tasks.includes('--json')
                const hasReport = /summary report/i.test(tasks)
                return Promise.resolve(
                    [
                        'MAP: 1 -> TASK 1',
                        `MAP: 2 -> ${hasJson ? 'TASK 2' : 'NONE'}`,
                        `MAP: 3 -> ${hasReport ? 'TASK 2' : 'NONE'}`,
                        'MAP: 4 -> NONE'
                    ].join('\n')
                )
            }
            return Promise.resolve('')
        },
        runTask: () => Promise.resolve({taskId: 'TASK_0001', ok: true, sessionCancelled: false}),
        commit: () => Promise.resolve({committed: true})
    }
}

test('coverage gate: a regeneration that DROPS a covered area is rejected, good plan ships', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured} = makeFakeCtx(dir)
        const d = dedupCliDeps()
        const id = await planAuto(ctx, dir, DEDUP_CLI_SPEC, d)
        const titles = parseTaskList((await readTaskFile(dir, id!)).body).map(e => e.title)
        // The good plan — with the --json task the regeneration dropped — ships…
        expect(titles).toEqual([
            'Scan directory tree for duplicate files',
            'Add a --json machine-readable output flag'
        ])
        // …and the loop did NOT collapse to the dropping plan (no summary-report task).
        expect(titles.some(t => /summary report/i.test(t))).toBe(false)
        // The dropping retry WAS generated (regen happened) and was rejected by the
        // monotonic guard — the fix is the guard firing, not regeneration never running.
        expect(d.calls.decompose).toBeGreaterThan(1)
        const log = await fsp.readFile(path.join(dir, '.pi-tasks', 'plan-debug.log'), 'utf8')
        expect(log).toContain('REJECTED — would drop 1 owned requirement(s)')
        // The un-ownable negative is CARRIED (cross-cutting), not chased forever…
        const reqsFile = await fsp.readFile(path.join(dir, '.pi-tasks', 'requirements.md'), 'utf8')
        expect(reqsFile).toContain('must never delete')
        // …and the still-uncovered report area is surfaced, never silently dropped.
        expect(captured.notifies.some(n => /no task fully owns/.test(n.msg))).toBe(true)
    })
})

// ─── #1/#2: judge-flagged carry + bonus round on late-exposed gap (mx5 2026-07-16)
//
// The mx5 failure this pair proves closed: the 55-title plan was ADOPTED on the
// final coverage round AND was the first plan whose holistic judge flagged §10's
// test-infra setup — an area requirement-extraction never captured as a tracked
// entry. The round cap fired the same instant, so (a) there was no round left to
// chase it and (b) it had no carrier, so it was warned-about then silently dropped.
//
// The spec carries three grounded requirements the plan covers incrementally, and
// a fourth area the judge names ONLY once the third requirement is covered — i.e.
// exposed by the adoption that lands on the last allowed round.
const PIPELINE_SPEC = [
    'Build a data pipeline tool.',
    '',
    'Behaviour:',
    '- the parser reads yaml manifests',
    '- the exporter writes csv reports',
    '- the scheduler triggers cron jobs'
].join('\n')

const PIPELINE_REQS = [
    'REQUIREMENT: "the parser reads yaml manifests"',
    'REQUIREMENT: "the exporter writes csv reports"',
    'REQUIREMENT: "the scheduler triggers cron jobs"'
].join('\n')

// Plans grow one covered requirement per round; the 3rd retry (the bonus) repeats
// the fully-covered plan. Judge names the next requirement each round, then the
// un-extracted "test harness" area only on the plan that covers all three — the
// adoption at the cap. `finalVerdict` is what the bonus round's judge returns.
function pipelineDeps(
    finalVerdict: string
): AutoDeps & {calls: {decompose: number; coverage: number}} {
    const calls = {decompose: 0, coverage: 0}
    const plans = [
        '- [ ] Build the yaml parser',
        '- [ ] Build the yaml parser\n- [ ] Add the csv exporter',
        '- [ ] Build the yaml parser\n- [ ] Add the csv exporter\n- [ ] Wire the cron scheduler',
        '- [ ] Build the yaml parser\n- [ ] Add the csv exporter\n- [ ] Wire the cron scheduler'
    ]
    const verdicts = [
        'COVERAGE: INCOMPLETE\nMISSING: csv exporter',
        'COVERAGE: INCOMPLETE\nMISSING: cron scheduler',
        'COVERAGE: INCOMPLETE\nMISSING: test harness for the pipeline',
        finalVerdict
    ]
    return {
        calls,
        runChild: (name, _tools, _prompt) => {
            if (name === 'auto-clarify') return Promise.resolve('NONE')
            if (name === 'requirement-extract') return Promise.resolve(PIPELINE_REQS)
            if (name === 'auto-decompose') return Promise.resolve(plans[calls.decompose++] ?? '')
            if (name === 'decompose-coverage')
                return Promise.resolve(verdicts[calls.coverage++] ?? 'COVERAGE: COMPLETE')
            // Every requirement is task-owned — keeps the grounded carry channels
            // empty so the judge-flagged channel is the only thing under test.
            if (name === 'coverage-map')
                return Promise.resolve('MAP: 1 -> TASK 1\nMAP: 2 -> TASK 1\nMAP: 3 -> TASK 1')
            return Promise.resolve('')
        },
        runTask: () => Promise.resolve({taskId: 'TASK_0001', ok: true, sessionCancelled: false}),
        commit: () => Promise.resolve({committed: true})
    }
}

test('#2: an adoption at the round cap that exposes a new area buys one bonus round', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured} = makeFakeCtx(dir)
        // The bonus round's judge finally reports COMPLETE — the extra round chased
        // the late-exposed gap to resolution, which MAX_COVERAGE_ROUNDS=2 alone
        // (breaking the instant the 3rd requirement was covered) would have missed.
        const d = pipelineDeps('COVERAGE: COMPLETE')
        await planAuto(ctx, dir, PIPELINE_SPEC, d)
        // initial + 2 base retries + 1 bonus retry.
        expect(d.calls.decompose).toBe(4)
        const log = await fsp.readFile(path.join(dir, '.pi-tasks', 'plan-debug.log'), 'utf8')
        expect(log).toContain('bonus round granted')
        // Resolved on the bonus round ⇒ no exhaustion warning.
        expect(captured.notifies.some(n => /no task fully owns/.test(n.msg))).toBe(false)
    })
})

test('#2: the bonus round is granted at most once (a persistent judge cannot loop)', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        // The judge keeps flagging the same area on the bonus round too — the bonus
        // is spent, and no second one is granted, so the loop still terminates.
        const d = pipelineDeps('COVERAGE: INCOMPLETE\nMISSING: test harness for the pipeline')
        await planAuto(ctx, dir, PIPELINE_SPEC, d)
        expect(d.calls.decompose).toBe(4) // never a 5th — bounded to exactly one bonus
        const log = await fsp.readFile(path.join(dir, '.pi-tasks', 'plan-debug.log'), 'utf8')
        expect((log.match(/bonus round granted/g) ?? []).length).toBe(1)
    })
})

test('#1: a judge-flagged area with no owning task is carried into requirements.md', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured} = makeFakeCtx(dir)
        // The bonus round still can't cover the un-extracted area — at exhaustion it
        // must be CARRIED (into every task) and marked, not merely warned then lost.
        const d = pipelineDeps('COVERAGE: INCOMPLETE\nMISSING: test harness for the pipeline')
        await planAuto(ctx, dir, PIPELINE_SPEC, d)
        const reqsFile = await fsp.readFile(path.join(dir, '.pi-tasks', 'requirements.md'), 'utf8')
        expect(reqsFile).toContain('test harness for the pipeline')
        expect(reqsFile).toContain('judge-flagged uncovered area')
        // And the user is told it is carried, not just that coverage is missing.
        expect(
            captured.notifies.some(n => /judge-flagged/.test(n.msg) && /requirement/.test(n.msg))
        ).toBe(true)
    })
})

// ─── Decompose distrust floor (suspect-plan regeneration) ───────────────────

// A feature long enough to trip the floor's spec-size condition (an inlined
// design doc), with no @mentions so featureForModel === feature in tests.
const BIG_FEATURE = 'Build the marketplace per this spec. ' + 'Spec detail line. '.repeat(300)

test('distrust floor: a 1-title plan for a big spec is regenerated BEFORE the judge', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        const d = coverageDeps(
            ['- [ ] Lone scaffold task', '- [ ] Scaffold\n- [ ] Auth\n- [ ] Listings\n- [ ] Tests'],
            ['COVERAGE: COMPLETE']
        )
        const id = await planAuto(ctx, dir, BIG_FEATURE, d)
        // Regeneration fired without consulting the judge; judge then saw the
        // healed list once.
        expect(d.calls.decompose).toBe(2)
        expect(d.calls.coverage).toBe(1)
        expect(d.calls.hints[1]).toContain('incomplete generation')
        expect(parseTaskList((await readTaskFile(dir, id!)).body).length).toBe(4)
        const log = await fsp.readFile(path.join(dir, '.pi-tasks', 'plan-debug.log'), 'utf8')
        expect(log).toContain('decompose suspect (1 title(s)')
        expect(log).toContain('raw output: - [ ] Lone scaffold task')
        expect(log).toContain('decompose suspect-retry produced 4 title(s)')
    })
})

test('distrust floor: a still-suspect plan ships with a warning, never silently', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured} = makeFakeCtx(dir)
        // Retry does not grow the list; judge (false-)passes it.
        const d = coverageDeps(
            ['- [ ] Lone scaffold task', '- [ ] Lone scaffold task'],
            ['COVERAGE: COMPLETE']
        )
        const id = await planAuto(ctx, dir, BIG_FEATURE, d)
        expect(id).not.toBeNull() // floor never rejects on count
        expect(parseTaskList((await readTaskFile(dir, id!)).body).length).toBe(1)
        const warn = captured.notifies.find(n => /review the plan before running/.test(n.msg))
        expect(warn).toBeDefined()
        expect(warn!.msg).toContain('only 1 task(s)')
    })
})

test('distrust floor: does not fire for a small feature prompt', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured} = makeFakeCtx(dir)
        const d = coverageDeps(['- [ ] Lone task'], ['COVERAGE: COMPLETE'])
        await planAuto(ctx, dir, 'add a --version flag', d)
        expect(d.calls.decompose).toBe(1) // no forced regeneration
        expect(captured.notifies.some(n => /review the plan before running/.test(n.msg))).toBe(
            false
        )
    })
})

test('distrust floor: does not fire for a healthy list on a big spec', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured} = makeFakeCtx(dir)
        const d = coverageDeps(['- [ ] Task A\n- [ ] Task B\n- [ ] Task C'], ['COVERAGE: COMPLETE'])
        await planAuto(ctx, dir, BIG_FEATURE, d)
        expect(d.calls.decompose).toBe(1)
        expect(captured.notifies.some(n => /review the plan before running/.test(n.msg))).toBe(
            false
        )
    })
})

test('distrust floor: a shorter-or-equal suspect retry keeps the original list', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        // Retry collapses to zero parseable titles → original 2-title list kept,
        // judge loop still runs on it.
        const d = coverageDeps(
            ['- [ ] Task A\n- [ ] Task B', 'no checkbox lines here'],
            ['COVERAGE: COMPLETE']
        )
        const id = await planAuto(ctx, dir, BIG_FEATURE, d)
        expect(parseTaskList((await readTaskFile(dir, id!)).body).map(e => e.title)).toEqual([
            'Task A',
            'Task B'
        ])
        expect(d.calls.coverage).toBe(1)
    })
})

// ─── Cross-slice contract extraction (F3) ───────────────────────────────────

test('contract extraction: grounded quotes stored, fabrications dropped', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        // A big feature that pins a real split contract; the extraction child emits
        // one grounded quote and one fabricated mount table (the exact F3 bug).
        const feature =
            'Photos API. Upload is POST /api/listings/:id/photos (nested under the listing). '
            + 'Detail line. '.repeat(300)
        const d: AutoDeps = {
            runChild: (name, _tools, _prompt) => {
                if (name === 'auto-clarify') return Promise.resolve('NONE')
                if (name === 'auto-decompose')
                    return Promise.resolve('- [ ] Photos API\n- [ ] App assembly\n- [ ] Tests')
                if (name === 'decompose-coverage') return Promise.resolve('COVERAGE: COMPLETE')
                if (name === 'contract-extract')
                    return Promise.resolve(
                        [
                            'CONTRACT: "POST /api/listings/:id/photos" [anchor: Photos API]',
                            'CONTRACT: "/api/photos → photosRoutes" [anchor: fabricated]'
                        ].join('\n')
                    )
                return Promise.resolve('')
            },
            runTask: () =>
                Promise.resolve({taskId: 'TASK_0001', ok: true, sessionCancelled: false}),
            commit: () => Promise.resolve({committed: true})
        }
        await planAuto(ctx, dir, feature, d)
        const stored = await fsp.readFile(path.join(dir, '.pi-tasks', 'contracts.md'), 'utf8')
        expect(stored).toContain('POST /api/listings/:id/photos')
        expect(stored).not.toContain('photosRoutes') // fabrication never grounded
    })
})

test('contract extraction: a child fault never blocks planning', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        const d: AutoDeps = {
            runChild: (name, _tools, _prompt) => {
                if (name === 'auto-clarify') return Promise.resolve('NONE')
                if (name === 'auto-decompose') return Promise.resolve('- [ ] A\n- [ ] B')
                if (name === 'decompose-coverage') return Promise.resolve('COVERAGE: COMPLETE')
                if (name === 'contract-extract') return Promise.reject(new Error('boom'))
                return Promise.resolve('')
            },
            runTask: () =>
                Promise.resolve({taskId: 'TASK_0001', ok: true, sessionCancelled: false}),
            commit: () => Promise.resolve({committed: true})
        }
        const id = await planAuto(ctx, dir, 'build the app', d)
        expect(id).not.toBeNull() // extraction fault is swallowed
    })
})

// ─── Repo integrity guards + final integration gate ─────────────────────────

test('runAutoLoop: unmerged index → stops LOUD before the task, nothing runs', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured} = makeFakeCtx(dir)
        await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), buildAutoBody('feat', '(none)', ['A']))
        let taskRan = false
        const d: AutoDeps = {
            runChild: () => Promise.resolve(''),
            runTask: () => {
                taskRan = true
                return Promise.resolve({taskId: 'TASK_0006', ok: true, sessionCancelled: false})
            },
            commit: () => Promise.resolve({committed: false, reason: 'nothing to commit'}),
            unmergedPaths: () =>
                Promise.resolve(['src/server/routes/photos.ts', '.pi-tasks/TASK_AUTO_0001.md'])
        }
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        expect(taskRan).toBe(false)
        const {frontMatter} = await readTaskFile(dir, 'TASK_AUTO_0001')
        expect(frontMatter.state).toBe('failed')
        expect(
            captured.notifies.some(
                n => n.level === 'error' && /unresolved merge conflicts/.test(n.msg)
            )
        ).toBe(true)
    })
})

test('runAutoLoop: gate failure demotes the INNER task file from its handoff "completed"', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), buildAutoBody('feat', '(none)', ['A']))
        // The inner task file as spec-handoff leaves it: state 'completed' before
        // any work is verified (the exact run 6 mismark).
        await writeTaskFile(dir, autoFm('TASK_0006', 'completed'), '## spec\nGOAL x\n')
        const d: AutoDeps = {
            runChild: () => Promise.resolve(''),
            runTask: () =>
                Promise.resolve({taskId: 'TASK_0006', ok: true, sessionCancelled: false}),
            commit: () => Promise.resolve({committed: true}),
            verify: () => Promise.resolve({ok: false, reason: 'work did not verify: broken'}),
            recommend: () => Promise.resolve({recommend: 'autofix', rationale: 'broken'})
        }
        // No queued select → picker dismissed → gate 'paused'.
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        const inner = await readTaskFile(dir, 'TASK_0006')
        expect(inner.frontMatter.state).toBe('failed')
    })
})

test('runAutoLoop: stash stack changed during a task → loud warning names the task', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured} = makeFakeCtx(dir)
        await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), buildAutoBody('feat', '(none)', ['A']))
        let stashCalls = 0
        const d: AutoDeps = {
            runChild: () => Promise.resolve(''),
            runTask: () =>
                Promise.resolve({taskId: 'TASK_0006', ok: true, sessionCancelled: false}),
            commit: () => Promise.resolve({committed: true}),
            stashRef: () => Promise.resolve(stashCalls++ === 0 ? null : 'abc123')
        }
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        expect(
            captured.notifies.some(
                n => n.level === 'warning' && /stash stack changed during "A"/.test(n.msg)
            )
        ).toBe(true)
        // The run itself still completes — the warning is a tripwire, not a gate.
        expect((await readTaskFile(dir, 'TASK_AUTO_0001')).frontMatter.state).toBe('completed')
    })
})

test('runAutoLoop: final gate FAIL + dismissed picker → run left failed, resume re-runs the gate', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured} = makeFakeCtx(dir)
        await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), buildAutoBody('feat', '(none)', ['A']))
        let gateRuns = 0
        const d: AutoDeps = {
            runChild: () => Promise.resolve(''),
            runTask: () =>
                Promise.resolve({taskId: 'TASK_0006', ok: true, sessionCancelled: false}),
            commit: () => Promise.resolve({committed: true}),
            finalGate: () => {
                gateRuns++
                return Promise.resolve({ok: false, reason: '`bun run test` exited 1 — 12 fail'})
            }
        }
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        expect(gateRuns).toBe(1)
        const {frontMatter, body} = await readTaskFile(dir, 'TASK_AUTO_0001')
        // All tasks stay checked (the work passed its own gates) but the RUN is
        // failed, so /task-auto-resume re-enters the all-done branch and re-gates.
        expect(parseTaskList(body).every(e => e.done)).toBe(true)
        expect(frontMatter.state).toBe('failed')
        expect(
            captured.notifies.some(n => n.level === 'error' && /final integration gate/.test(n.msg))
        ).toBe(true)
    })
})

test('runAutoLoop: final gate FAIL + user ACCEPTS → run completes with a warning', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        const {ctx, captured} = handle
        await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), buildAutoBody('feat', '(none)', ['A']))
        const d: AutoDeps = {
            runChild: () => Promise.resolve(''),
            runTask: () =>
                Promise.resolve({taskId: 'TASK_0006', ok: true, sessionCancelled: false}),
            commit: () => Promise.resolve({committed: true}),
            finalGate: () => Promise.resolve({ok: false, reason: '`bun run test` exited 1'})
        }
        handle.queueSelect('Accept — complete the run anyway')
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        expect((await readTaskFile(dir, 'TASK_AUTO_0001')).frontMatter.state).toBe('completed')
        expect(
            captured.notifies.some(
                n => n.level === 'warning' && /final integration gate FAIL accepted/.test(n.msg)
            )
        ).toBe(true)
    })
})

test('runAutoLoop: final gate PASS → run completes without a picker', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured} = makeFakeCtx(dir)
        await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), buildAutoBody('feat', '(none)', ['A']))
        let gateRuns = 0
        const trail: string[] = []
        const d: AutoDeps = {
            runChild: () => Promise.resolve(''),
            runTask: () =>
                Promise.resolve({taskId: 'TASK_0006', ok: true, sessionCancelled: false}),
            commit: () => Promise.resolve({committed: true}),
            record: (_c, _id, line) => {
                trail.push(line)
                return Promise.resolve()
            },
            finalGate: () => {
                gateRuns++
                return Promise.resolve({ok: true, reason: 'statics + `bun run test` passed'})
            }
        }
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        expect(gateRuns).toBe(1)
        expect((await readTaskFile(dir, 'TASK_AUTO_0001')).frontMatter.state).toBe('completed')
        expect(captured.notifies.some(n => /complete — all 1 tasks done/.test(n.msg))).toBe(true)
        // mx5 run 10 item 7: a PASS is trailed (distinct from a never-run gate) and
        // names the commands that ran.
        expect(trail).toContain('final-gate: PASS — statics + `bun run test` passed')
    })
})

// mx5 run 13: the gate aggregates every section failure, ranked boot/render first.
// The trail must carry EVERY entry and the picker question the full ranked list —
// the user accepted run 13's FAIL having seen only the 1 failing CT test while the
// shadowed boot + render probe would have shown the app 404ing on every GET.
test('runAutoLoop: aggregated final-gate FAIL → every entry trailed, full list in the picker', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        const {ctx, captured} = handle
        await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), buildAutoBody('feat', '(none)', ['A']))
        const failures = [
            'boot check: `bun run start` listens on :3000 but GET / responded 404',
            '`bun run test:ct` exited 1 — 1 EditListing test failed'
        ]
        const reason = `2 failures (ranked, most load-bearing first):\n1. ${failures[0]}\n2. ${failures[1]}`
        const trail: string[] = []
        const d: AutoDeps = {
            runChild: () => Promise.resolve(''),
            runTask: () =>
                Promise.resolve({taskId: 'TASK_0006', ok: true, sessionCancelled: false}),
            commit: () => Promise.resolve({committed: true}),
            record: (_c, _id, line) => {
                trail.push(line)
                return Promise.resolve()
            },
            finalGate: () => Promise.resolve({ok: false, reason, failures})
        }
        handle.queueSelect('Accept — complete the run anyway')
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        // Header + one trail line per ranked entry, boot first.
        expect(trail).toContain('final-gate: FAIL — 2 failures (ranked, most load-bearing first)')
        expect(trail.some(l => l.startsWith('final-gate FAIL 1/2: boot check'))).toBe(true)
        expect(trail.some(l => l.startsWith('final-gate FAIL 2/2: `bun run test:ct`'))).toBe(true)
        // The ACCEPT decision is made on the full defect list.
        const picker = captured.selects.find(s => /Final integration gate FAILED/.test(s.title))
        expect(picker).toBeDefined()
        expect(picker!.title).toContain(failures[0])
        expect(picker!.title).toContain(failures[1])
    })
})

test('runAutoLoop: final gate FAIL + user picks AUTOFIX → fix runs, gate green, run completes', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        const {ctx, captured} = handle
        await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), buildAutoBody('feat', '(none)', ['A']))
        const commits: string[] = []
        let fixSeed = ''
        const d: AutoDeps = {
            runChild: () => Promise.resolve(''),
            runTask: () =>
                Promise.resolve({taskId: 'TASK_0006', ok: true, sessionCancelled: false}),
            commit: (_cwd, message) => {
                commits.push(message)
                return Promise.resolve({committed: true})
            },
            finalGate: () => Promise.resolve({ok: false, reason: '`bun run test` exited 1'}),
            finalGateFix: (_ctx, _cwd, failReason) => {
                fixSeed = failReason
                return Promise.resolve({ok: true, reason: 'statics + `bun run test` passed'})
            }
        }
        handle.queueSelect('Autofix — run a bounded fix pass and re-run the gate')
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        expect(fixSeed).toContain('`bun run test` exited 1')
        expect((await readTaskFile(dir, 'TASK_AUTO_0001')).frontMatter.state).toBe('completed')
        expect(commits.some(m => /FINAL GATE AUTOFIX/.test(m))).toBe(true)
        expect(captured.notifies.some(n => /PASSES after autofix/.test(n.msg))).toBe(true)
        // The picker offered all three cards, Leave-failed first (recommended).
        const picker = captured.selects.find(s => /Final integration gate FAILED/.test(s.title))
        expect(picker).toBeDefined()
        expect(picker!.options[0]).toBe('Leave failed — I will fix and /task-auto-resume')
        expect(picker!.options).toContain('Autofix — run a bounded fix pass and re-run the gate')
    })
})

test('runAutoLoop: final-gate autofix is CAPPED — after 3 failed attempts the card is withdrawn', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        const {ctx, captured} = handle
        await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), buildAutoBody('feat', '(none)', ['A']))
        let fixRuns = 0
        const d: AutoDeps = {
            runChild: () => Promise.resolve(''),
            runTask: () =>
                Promise.resolve({taskId: 'TASK_0006', ok: true, sessionCancelled: false}),
            commit: () => Promise.resolve({committed: true}),
            finalGate: () => Promise.resolve({ok: false, reason: '`bun run test` exited 1'}),
            finalGateFix: () => {
                fixRuns++
                return Promise.resolve({
                    ok: false,
                    reason: 'did not converge: `bun run test` exited 1 — still',
                    gateReason: '`bun run test` exited 1 — still'
                })
            }
        }
        const autofixLabel = 'Autofix — run a bounded fix pass and re-run the gate'
        handle.queueSelect(autofixLabel)
        handle.queueSelect(autofixLabel)
        handle.queueSelect(autofixLabel)
        // Fourth picker: no autofix card queued answer left → dismissal → leave failed.
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        expect(fixRuns).toBe(3)
        const pickers = captured.selects.filter(s => /Final integration gate FAILED/.test(s.title))
        expect(pickers.length).toBe(4)
        expect(pickers[3].options).not.toContain(autofixLabel)
        expect((await readTaskFile(dir, 'TASK_AUTO_0001')).frontMatter.state).toBe('failed')
        // The later pickers carry the FRESH gate reason from the failed attempt.
        expect(captured.selects.some(s => /exited 1 — still/.test(s.title))).toBe(true)
    })
})

// ── Stranded sub-fixes (mx5 run 13 PROMPT 4 item 3) ──────────────────────────
// A non-converging fix attempt KEEPS its edits (only a guard trip discards) and
// deps.commit runs only on fix.ok — so run 13's bunfig.toml repair, which made
// `bun run test` pass 116/116, was still uncommitted when the user accepted the
// FAIL, leaving HEAD broken and the repair invisible.

/** Deps for a run whose single autofix attempt does not converge but edits the tree. */
function strandedDeps(
    commits: string[],
    pending: string[] = ['bunfig.toml'],
    trail: string[] = []
): AutoDeps {
    return {
        runChild: () => Promise.resolve(''),
        runTask: () => Promise.resolve({taskId: 'TASK_0006', ok: true, sessionCancelled: false}),
        commit: (_cwd, message) => {
            commits.push(message)
            return Promise.resolve({committed: true, sha: 'abc1234'})
        },
        record: (_c, _id, line) => {
            trail.push(line)
            return Promise.resolve()
        },
        finalGate: () => Promise.resolve({ok: false, reason: '`bun run test:ct` exited 1'}),
        finalGateFix: () =>
            Promise.resolve({
                ok: false,
                reason: 'did not converge: `bun run test:ct` exited 1',
                gateReason: '`bun run test:ct` exited 1'
            }),
        pendingChanges: () => Promise.resolve(pending)
    }
}

test('runAutoLoop: a non-converging fix pass surfaces its uncommitted changes in the next picker', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        const {ctx, captured} = handle
        await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), buildAutoBody('feat', '(none)', ['A']))
        const commits: string[] = []
        handle.queueSelect('Autofix — run a bounded fix pass and re-run the gate')
        handle.queueSelect('Accept — complete the run anyway')
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', strandedDeps(commits))
        const pickers = captured.selects.filter(s => /Final integration gate FAILED/.test(s.title))
        // First picker: nothing stranded yet. Second: the attempt's edits are named.
        expect(pickers[0].title).not.toMatch(/UNCOMMITTED/)
        expect(pickers[1].title).toMatch(/UNCOMMITTED: the fix pass left 1 change\(s\)/)
        expect(pickers[1].title).toContain('bunfig.toml')
    })
})

test('runAutoLoop: ACCEPT commits the stranded fix pass changes instead of dropping them', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        const {ctx} = handle
        await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), buildAutoBody('feat', '(none)', ['A']))
        const commits: string[] = []
        const trail: string[] = []
        handle.queueSelect('Autofix — run a bounded fix pass and re-run the gate')
        handle.queueSelect('Accept — complete the run anyway')
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', strandedDeps(commits, ['bunfig.toml'], trail))
        // Its OWN commit, distinct from the converged-autofix commit.
        expect(commits.some(m => /FINAL GATE PARTIAL FIX/.test(m))).toBe(true)
        expect(commits.some(m => /FINAL GATE AUTOFIX/.test(m))).toBe(false)
        expect(trail.some(l => /committed 1 stranded fix-pass change\(s\)/.test(l))).toBe(true)
        expect(trail.some(l => l.includes('bunfig.toml'))).toBe(true)
        expect((await readTaskFile(dir, 'TASK_AUTO_0001')).frontMatter.state).toBe('completed')
    })
})

test('runAutoLoop: LEAVE-failed COMMITS the stranded changes (mx5 run 14 item 2b)', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        const {ctx, captured} = handle
        await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), buildAutoBody('feat', '(none)', ['A']))
        const commits: string[] = []
        const trail: string[] = []
        handle.queueSelect('Autofix — run a bounded fix pass and re-run the gate')
        handle.queueSelect('Leave failed — I will fix and /task-auto-resume')
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', strandedDeps(commits, ['bunfig.toml'], trail))
        // Run 14 ended exactly here and left 13 real repairs dirty in the tree; the
        // terminal LEAVE now commits them under the partial-fix subject, named in
        // the trail, with the run still recorded as failed.
        expect(commits.some(m => /FINAL GATE PARTIAL FIX/.test(m))).toBe(true)
        expect(commits.some(m => /run left failed, repairs preserved/.test(m))).toBe(true)
        expect(commits.some(m => /FINAL GATE AUTOFIX/.test(m))).toBe(false)
        expect(trail.some(l => /committed 1 stranded fix-pass change\(s\)/.test(l))).toBe(true)
        expect(trail.some(l => l.includes('bunfig.toml'))).toBe(true)
        expect(captured.notifies.some(n => /fix-pass change/.test(n.msg))).toBe(true)
        expect((await readTaskFile(dir, 'TASK_AUTO_0001')).frontMatter.state).toBe('failed')
    })
})

test('runAutoLoop: a clean tree after a failed fix pass adds no stranded noise anywhere', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        const {ctx, captured} = handle
        await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), buildAutoBody('feat', '(none)', ['A']))
        const commits: string[] = []
        const trail: string[] = []
        handle.queueSelect('Autofix — run a bounded fix pass and re-run the gate')
        handle.queueSelect('Accept — complete the run anyway')
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', strandedDeps(commits, [], trail))
        expect(commits.some(m => /FINAL GATE PARTIAL FIX/.test(m))).toBe(false)
        expect(trail.some(l => /stranded fix-pass/.test(l))).toBe(false)
        expect(captured.selects.every(s => !/UNCOMMITTED/.test(s.title))).toBe(true)
    })
})

test('runAutoLoop: without the pendingChanges dep the stranded handling is skipped entirely', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        const {ctx} = handle
        await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), buildAutoBody('feat', '(none)', ['A']))
        const commits: string[] = []
        const d = {...strandedDeps(commits), pendingChanges: undefined}
        handle.queueSelect('Autofix — run a bounded fix pass and re-run the gate')
        handle.queueSelect('Accept — complete the run anyway')
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        expect(commits.some(m => /FINAL GATE PARTIAL FIX/.test(m))).toBe(false)
        expect((await readTaskFile(dir, 'TASK_AUTO_0001')).frontMatter.state).toBe('completed')
    })
})

test('runAutoLoop: a pendingChanges failure is inconclusive — nothing is claimed or committed', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        const {ctx, captured} = handle
        await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), buildAutoBody('feat', '(none)', ['A']))
        const commits: string[] = []
        const d: AutoDeps = {
            ...strandedDeps(commits),
            pendingChanges: () => Promise.reject(new Error('git exploded'))
        }
        handle.queueSelect('Autofix — run a bounded fix pass and re-run the gate')
        handle.queueSelect('Accept — complete the run anyway')
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        expect(commits.some(m => /FINAL GATE PARTIAL FIX/.test(m))).toBe(false)
        expect(captured.selects.every(s => !/UNCOMMITTED/.test(s.title))).toBe(true)
    })
})

// ── Non-progress / unfalsifiable check (mx5 run 14 item 2) ───────────────────
// Run 14 burned all three attempts on a boot check that could not be observed in
// that sandbox at ALL (no `ss`, no `lsof`), then left 13 real repairs uncommitted.
// The A/B below is built on a SYNTHETIC always-failing check, deliberately not
// coupled to the boot probe (whose own capability gap is fixed separately).

/** Deps whose gate fails with `first` forever, plus optional extra failures that
 *  clear after the first attempt. Every attempt edits the tree. */
function nonProgressDeps(opts: {
    first: string
    extra?: string[]
    commits: string[]
    trail: string[]
    attempts: {n: number}
}): AutoDeps {
    const firstOf = (n: number): string[] => [opts.first, ...(n === 0 ? (opts.extra ?? []) : [])]
    return {
        runChild: () => Promise.resolve(''),
        runTask: () => Promise.resolve({taskId: 'TASK_0006', ok: true, sessionCancelled: false}),
        commit: (_cwd, message) => {
            opts.commits.push(message)
            return Promise.resolve({committed: true, sha: 'abc1234'})
        },
        record: (_c, _id, line) => {
            opts.trail.push(line)
            return Promise.resolve()
        },
        finalGate: () =>
            Promise.resolve({ok: false, reason: firstOf(0).join(' | '), failures: firstOf(0)}),
        finalGateFix: () => {
            opts.attempts.n++
            const failures = firstOf(opts.attempts.n)
            return Promise.resolve({
                ok: false,
                reason: `did not converge: ${failures.join(' | ')}`,
                gateReason: failures.join(' | '),
                gateFailures: failures
            })
        },
        pendingChanges: () => Promise.resolve(['package.json', 'src/db/teardown.ts'])
    }
}

test('runAutoLoop: an identical failure across two tree-changing attempts is DEMOTED, not re-attempted', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        const {ctx} = handle
        await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), buildAutoBody('feat', '(none)', ['A']))
        const commits: string[] = []
        const trail: string[] = []
        const attempts = {n: 0}
        const autofixLabel = 'Autofix — run a bounded fix pass and re-run the gate'
        handle.queueSelect(autofixLabel)
        handle.queueSelect(autofixLabel)
        handle.queueSelect(autofixLabel)
        await runAutoLoop(
            ctx,
            dir,
            'TASK_AUTO_0001',
            nonProgressDeps({
                // Volatile substrings differ every run — the classifier must still
                // see "the same failure" after normalization, or it never fires.
                first: 'boot check: the app never opened a listening socket on port 3000 after 12000ms',
                commits,
                trail,
                attempts
            })
        )
        // BEFORE: 3 attempts, run failed, edits uncommitted. AFTER: stop at 2.
        expect(attempts.n).toBe(2)
        expect(trail.some(l => /check DEMOTED to UNOBSERVED/.test(l))).toBe(true)
        expect(trail.some(l => /converged on all remaining checks/.test(l))).toBe(true)
        expect(commits.some(m => /FINAL GATE AUTOFIX/.test(m))).toBe(true)
        expect((await readTaskFile(dir, 'TASK_AUTO_0001')).frontMatter.state).toBe('completed')
        // The demotion is durable, with its own origin, so the NEXT run re-checks it.
        const debts = await readAcceptDebts(dir)
        expect(debts.length).toBe(1)
        expect(debts[0].origin).toBe('final-gate')
        expect(debts[0].reason).toMatch(/UNOBSERVED/)
        expect(debts[0].reason).toMatch(/listening socket/)
    })
})

test('runAutoLoop: demotion honors the REMAINING checks — they still have to pass', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        const {ctx, captured} = handle
        await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), buildAutoBody('feat', '(none)', ['A']))
        const commits: string[] = []
        const trail: string[] = []
        const attempts = {n: 0}
        const autofixLabel = 'Autofix — run a bounded fix pass and re-run the gate'
        handle.queueSelect(autofixLabel)
        handle.queueSelect(autofixLabel)
        handle.queueSelect(autofixLabel)
        await runAutoLoop(
            ctx,
            dir,
            'TASK_AUTO_0001',
            nonProgressDeps({
                first: 'boot check: never opened a listening socket',
                // Cleared by attempt 1 — the run-14 shape (2 of 3 checks were fixable).
                extra: ['`bun run test` exited 1 — 2 failing'],
                commits,
                trail,
                attempts
            })
        )
        expect(attempts.n).toBe(2)
        expect((await readTaskFile(dir, 'TASK_AUTO_0001')).frontMatter.state).toBe('completed')
        // The still-failing check never re-entered a picker after the demotion.
        const pickers = captured.selects.filter(s => /Final integration gate FAILED/.test(s.title))
        expect(pickers.length).toBe(2)
    })
})

test('runAutoLoop: no demotion when the attempt changed nothing (no evidence about the check)', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        const {ctx} = handle
        await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), buildAutoBody('feat', '(none)', ['A']))
        const commits: string[] = []
        const trail: string[] = []
        const attempts = {n: 0}
        const d: AutoDeps = {
            ...nonProgressDeps({first: 'boot check: no listener', commits, trail, attempts}),
            pendingChanges: () => Promise.resolve([])
        }
        const autofixLabel = 'Autofix — run a bounded fix pass and re-run the gate'
        handle.queueSelect(autofixLabel)
        handle.queueSelect(autofixLabel)
        handle.queueSelect(autofixLabel)
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        expect(attempts.n).toBe(3)
        expect(trail.some(l => /DEMOTED/.test(l))).toBe(false)
        expect((await readTaskFile(dir, 'TASK_AUTO_0001')).frontMatter.state).toBe('failed')
        expect(await readAcceptDebts(dir)).toEqual([])
    })
})

test('runAutoLoop: a guard-REJECTED attempt whose edits survived is never committed', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        const {ctx} = handle
        await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), buildAutoBody('feat', '(none)', ['A']))
        const commits: string[] = []
        const trail: string[] = []
        const d: AutoDeps = {
            ...strandedDeps(commits, ['src/client/pages/admin.tsx'], trail),
            finalGateFix: () =>
                Promise.resolve({
                    ok: false,
                    reason: 'fix pass DELETED tracked file(s) — edits REJECTED but left in the tree',
                    guardTripped: true,
                    editsDiscarded: false
                })
        }
        handle.queueSelect('Autofix — run a bounded fix pass and re-run the gate')
        handle.queueSelect('Accept — complete the run anyway')
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        expect(commits.some(m => /FINAL GATE PARTIAL FIX/.test(m))).toBe(false)
        expect(trail.some(l => /NOT committing 1 working-tree change\(s\)/.test(l))).toBe(true)
    })
})

test('runAutoLoop: no finalGateFix dep → picker keeps only the two original cards', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        const {ctx, captured} = handle
        await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), buildAutoBody('feat', '(none)', ['A']))
        const d: AutoDeps = {
            runChild: () => Promise.resolve(''),
            runTask: () =>
                Promise.resolve({taskId: 'TASK_0006', ok: true, sessionCancelled: false}),
            commit: () => Promise.resolve({committed: true}),
            finalGate: () => Promise.resolve({ok: false, reason: '`bun run test` exited 1'})
        }
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        const picker = captured.selects.find(s => /Final integration gate FAILED/.test(s.title))
        expect(picker).toBeDefined()
        // Two cards + the built-in "type a different answer" fallback.
        expect(picker!.options.filter(o => /^(Leave|Accept|Autofix)/.test(o))).toEqual([
            'Leave failed — I will fix and /task-auto-resume',
            'Accept — complete the run anyway'
        ])
        expect((await readTaskFile(dir, 'TASK_AUTO_0001')).frontMatter.state).toBe('failed')
    })
})

test('runAutoLoop: free text typed at the final-gate picker becomes autofix guidance', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        const {ctx} = handle
        await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), buildAutoBody('feat', '(none)', ['A']))
        let fixSeed = ''
        const d: AutoDeps = {
            runChild: () => Promise.resolve(''),
            runTask: () =>
                Promise.resolve({taskId: 'TASK_0006', ok: true, sessionCancelled: false}),
            commit: () => Promise.resolve({committed: true}),
            finalGate: () => Promise.resolve({ok: false, reason: '`bun run test` exited 1'}),
            finalGateFix: (_ctx, _cwd, failReason) => {
                fixSeed = failReason
                return Promise.resolve({ok: true, reason: 'statics passed'})
            }
        }
        handle.queueSelect('✎ Type a different answer…')
        handle.queueInput('move the e2e spec out of the unit glob')
        await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
        expect(fixSeed).toContain('User guidance: move the e2e spec out of the unit glob')
        expect((await readTaskFile(dir, 'TASK_AUTO_0001')).frontMatter.state).toBe('completed')
    })
})
