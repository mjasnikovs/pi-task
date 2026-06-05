import {describe, expect, test} from 'bun:test'
import {TaskRunner, runSingleTask} from './orchestrator.js'
import {readTaskFile, readSection, writeTaskFile} from './task-io.js'
import {agentEndResponse, fakeSpawnByPrompt, type SpawnResponse} from '../test-utils/fake-spawn.js'
import {makeFakeCtx} from '../test-utils/fake-ctx.js'
import {withTmpTaskDir} from '../test-utils/tmp-task-dir.js'
import type {SpawnFn} from '../shared/child-process.js'

const PHASE_TAGS = {
    refine: 'Rewrite it to be unambiguous and actionable',
    researchFiles: 'FILES owns paths',
    researchApis: 'APIS owns symbols and commands BY NAME ONLY',
    researchContext: 'gather background knowledge',
    researchTooling: 'identify the verification tools',
    verifyTooling: 'YOU MAY ONLY READ. Do NOT execute',
    grillGen: 'preparing clarifying questions',
    grillAuto: 'pre-answering a clarifying question',
    compose: 'composing the final implementation spec',
    critique: 'reviewing the implementation spec'
}

function findTag(prompt: string): keyof typeof PHASE_TAGS | 'unknown' {
    for (const [k, v] of Object.entries(PHASE_TAGS)) {
        if (prompt.includes(v)) return k as keyof typeof PHASE_TAGS
    }
    return 'unknown'
}

function scriptedSpawn(
    scripts: Partial<Record<keyof typeof PHASE_TAGS, string | (() => string)>>
): SpawnFn {
    return fakeSpawnByPrompt(args => {
        const prompt = args[args.length - 1]
        const tag = findTag(prompt)
        const v = scripts[tag as keyof typeof PHASE_TAGS]
        const text = typeof v === 'function' ? v() : (v ?? '')
        return agentEndResponse(text) as SpawnResponse
    })
}

const REFINED_FIXTURE = `GOAL
Run the linter and report errors.

CONSTRAINTS
- Use bun.

KNOWN-UNKNOWNS
- (none)
`

const RESEARCH_FILES = 'package.json  build/lint scripts'
const RESEARCH_APIS = 'lint  bun run lint'
const RESEARCH_CONTEXT = '- TypeScript project using bun'
const RESEARCH_TOOLING = 'lint  bun run lint\ntest  bun test'

const VERIFY_TOOLING_OUT = `VERIFIED
  bun run lint  found in package.json scripts
  bun test  found in package.json scripts

REJECTED
`

/** grill-gen must return non-empty text even when there are no questions; this
 *  string parses to 0 questions (no numbered lines). */
const NO_QUESTIONS = '(no clarifying questions for this task)'

const COMPOSE_SPEC = `GOAL
Run lint.

CONSTRAINTS
- none

ACCEPTANCE
- exit 0

VERIFY:
\`\`\`sh
bun run lint
\`\`\`
`

describe('TaskRunner — happy path', () => {
    test('refine fills title and refined section', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx} = makeFakeCtx(cwd)
            const spawn = scriptedSpawn({
                refine: REFINED_FIXTURE,
                researchFiles: RESEARCH_FILES,
                researchApis: RESEARCH_APIS,
                researchContext: RESEARCH_CONTEXT,
                researchTooling: RESEARCH_TOOLING,
                verifyTooling: VERIFY_TOOLING_OUT,
                grillGen: NO_QUESTIONS,
                compose: COMPOSE_SPEC,
                critique: COMPOSE_SPEC
            })
            const sentSpecs: string[] = []
            const runner = new TaskRunner(
                ctx,
                cwd,
                'run lint',
                undefined,
                async spec => {
                    sentSpecs.push(spec)
                },
                spawn
            )
            await runner.run()
            const {frontMatter} = await readTaskFile(cwd, 'TASK_0001')
            expect(frontMatter.state).toBe('completed')
            expect(frontMatter.title).toContain('Run the linter')
            const refined = await readSection(cwd, 'TASK_0001', 'refined prompt')
            expect(refined).toContain('GOAL')
            expect(sentSpecs).toHaveLength(1)
            expect(sentSpecs[0]).toContain('VERIFY:')
        })
    })

    test('verify-tooling: research TOOLING is replaced with VERIFIED-TOOLING', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx} = makeFakeCtx(cwd)
            const spawn = scriptedSpawn({
                refine: REFINED_FIXTURE,
                researchFiles: RESEARCH_FILES,
                researchApis: RESEARCH_APIS,
                researchContext: RESEARCH_CONTEXT,
                researchTooling: RESEARCH_TOOLING,
                verifyTooling: VERIFY_TOOLING_OUT,
                grillGen: NO_QUESTIONS,
                compose: COMPOSE_SPEC,
                critique: COMPOSE_SPEC
            })
            await new TaskRunner(ctx, cwd, 'run lint', undefined, async () => {}, spawn).run()
            const research = await readSection(cwd, 'TASK_0001', 'research')
            expect(research).toContain('VERIFIED-TOOLING')
            expect(research).toContain('bun run lint')
            expect(research).not.toMatch(/^TOOLING$/m)
            const verifiedTooling = await readSection(cwd, 'TASK_0001', 'verified tooling')
            expect(verifiedTooling).toContain('bun run lint')
        })
    })

    test('grill auto-answer: ui.input never called when ANSWER: is returned', async () => {
        await withTmpTaskDir(async cwd => {
            const handle = makeFakeCtx(cwd)
            // grill-gen is re-called after every answer (open-ended interview);
            // the model signals "done" by emitting NONE. Emit one question per
            // call, then NONE — a constant non-NONE response would never let the
            // loop terminate.
            const grillQuestions = ['1. should we use bun?', '1. should we lint tests?']
            let genCall = 0
            const spawn = scriptedSpawn({
                refine: REFINED_FIXTURE,
                researchFiles: RESEARCH_FILES,
                researchApis: RESEARCH_APIS,
                researchContext: RESEARCH_CONTEXT,
                researchTooling: RESEARCH_TOOLING,
                verifyTooling: VERIFY_TOOLING_OUT,
                grillGen: () => grillQuestions[genCall++] ?? 'NONE',
                grillAuto: 'ANSWER: yes',
                compose: COMPOSE_SPEC,
                critique: COMPOSE_SPEC
            })
            await new TaskRunner(
                handle.ctx,
                cwd,
                'run lint',
                undefined,
                async () => {},
                spawn
            ).run()
            expect(handle.captured.inputs).toHaveLength(0)
            const qa = await readSection(cwd, 'TASK_0001', 'grill Q&A')
            expect(qa).toContain('(auto)')
        })
    })

    test('compose receives refined and research in its prompt', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx} = makeFakeCtx(cwd)
            let composePrompt = ''
            const spawn = fakeSpawnByPrompt(args => {
                const prompt = args[args.length - 1]
                const tag = findTag(prompt)
                if (tag === 'compose') composePrompt = prompt
                const map: Partial<Record<typeof tag, string>> = {
                    refine: REFINED_FIXTURE,
                    researchFiles: RESEARCH_FILES,
                    researchApis: RESEARCH_APIS,
                    researchContext: RESEARCH_CONTEXT,
                    researchTooling: RESEARCH_TOOLING,
                    verifyTooling: VERIFY_TOOLING_OUT,
                    grillGen: NO_QUESTIONS,
                    compose: COMPOSE_SPEC,
                    critique: COMPOSE_SPEC
                }
                const text = map[tag] ?? ''
                return agentEndResponse(text)
            })
            await new TaskRunner(ctx, cwd, 'run lint', undefined, async () => {}, spawn).run()
            expect(composePrompt).toContain('Run the linter')
            expect(composePrompt).toContain('package.json')
        })
    })

    test('critique receives the compose spec verbatim in its prompt', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx} = makeFakeCtx(cwd)
            let critiquePrompt = ''
            const spawn = fakeSpawnByPrompt(args => {
                const prompt = args[args.length - 1]
                const tag = findTag(prompt)
                if (tag === 'critique') critiquePrompt = prompt
                const map: Partial<Record<typeof tag, string>> = {
                    refine: REFINED_FIXTURE,
                    researchFiles: RESEARCH_FILES,
                    researchApis: RESEARCH_APIS,
                    researchContext: RESEARCH_CONTEXT,
                    researchTooling: RESEARCH_TOOLING,
                    verifyTooling: VERIFY_TOOLING_OUT,
                    grillGen: NO_QUESTIONS,
                    compose: COMPOSE_SPEC,
                    critique: COMPOSE_SPEC
                }
                const text = map[tag] ?? ''
                return agentEndResponse(text)
            })
            await new TaskRunner(ctx, cwd, 'run lint', undefined, async () => {}, spawn).run()
            expect(critiquePrompt).toContain(COMPOSE_SPEC.trim())
        })
    })

    test('phase timings section is written on success and lists every phase', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx} = makeFakeCtx(cwd)
            const spawn = scriptedSpawn({
                refine: REFINED_FIXTURE,
                researchFiles: RESEARCH_FILES,
                researchApis: RESEARCH_APIS,
                researchContext: RESEARCH_CONTEXT,
                researchTooling: RESEARCH_TOOLING,
                verifyTooling: VERIFY_TOOLING_OUT,
                grillGen: NO_QUESTIONS,
                compose: COMPOSE_SPEC,
                critique: COMPOSE_SPEC
            })
            await new TaskRunner(ctx, cwd, 'run lint', undefined, async () => {}, spawn).run()
            const timings = await readSection(cwd, 'TASK_0001', 'phase timings')
            expect(timings).not.toBeNull()
            const body = timings ?? ''
            for (const phase of ['refine', 'research', 'grill', 'compose', 'critique', 'total']) {
                expect(body).toContain(phase)
            }
            // Research sub-steps should be present (workers + verify-tooling).
            expect(body).toContain('workers')
            expect(body).toContain('verify-tooling')
        })
    })

    test('phase timings are persisted even when the pipeline fails mid-flight', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx} = makeFakeCtx(cwd)
            // refine succeeds, FILES research worker returns empty → research fails.
            const spawn = scriptedSpawn({
                refine: REFINED_FIXTURE,
                researchFiles: '',
                researchApis: RESEARCH_APIS,
                researchContext: RESEARCH_CONTEXT,
                researchTooling: RESEARCH_TOOLING
            })
            await new TaskRunner(ctx, cwd, 'run lint', undefined, async () => {}, spawn).run()
            const {frontMatter} = await readTaskFile(cwd, 'TASK_0001')
            expect(frontMatter.state).toBe('failed')
            const timings = await readSection(cwd, 'TASK_0001', 'phase timings')
            expect(timings).not.toBeNull()
            // Refine completed before the failure, so it should appear; research
            // also gets a partial entry (its try/finally captures the time spent
            // before throwing).
            expect(timings ?? '').toContain('refine')
            expect(timings ?? '').toContain('research')
        })
    })

    test('handoff: completed state and sendSpec receives final spec', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx} = makeFakeCtx(cwd)
            const spawn = scriptedSpawn({
                refine: REFINED_FIXTURE,
                researchFiles: RESEARCH_FILES,
                researchApis: RESEARCH_APIS,
                researchContext: RESEARCH_CONTEXT,
                researchTooling: RESEARCH_TOOLING,
                verifyTooling: VERIFY_TOOLING_OUT,
                grillGen: NO_QUESTIONS,
                compose: COMPOSE_SPEC,
                critique: COMPOSE_SPEC
            })
            const sent: string[] = []
            await new TaskRunner(
                ctx,
                cwd,
                'run lint',
                undefined,
                async s => {
                    sent.push(s)
                },
                spawn
            ).run()
            const {frontMatter} = await readTaskFile(cwd, 'TASK_0001')
            expect(frontMatter.state).toBe('completed')
            expect(frontMatter.phase).toBe('done')
            expect(sent).toHaveLength(1)
            expect(sent[0]).toContain('VERIFY:')
            expect(await readSection(cwd, 'TASK_0001', 'handoff')).toMatch(/handoff_at:/)
        })
    })
})

describe('TaskRunner — resume', () => {
    test('resume mid-pipeline skips completed phases', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx} = makeFakeCtx(cwd)
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'grill',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 'Run lint'
                },
                `
## raw prompt

run lint

## refined prompt

${REFINED_FIXTURE.trim()}

## research

FILES
${RESEARCH_FILES}

APIS
${RESEARCH_APIS}

CONTEXT
${RESEARCH_CONTEXT}

VERIFIED-TOOLING
  bun run lint
  bun test
`
            )
            let refineCalled = false
            const spawn = fakeSpawnByPrompt(args => {
                const prompt = args[args.length - 1]
                const tag = findTag(prompt)
                if (tag === 'refine') refineCalled = true
                const map: Partial<Record<typeof tag, string>> = {
                    grillGen: NO_QUESTIONS,
                    compose: COMPOSE_SPEC,
                    critique: COMPOSE_SPEC
                }
                const text = map[tag] ?? ''
                return agentEndResponse(text)
            })
            await new TaskRunner(ctx, cwd, '', 'TASK_0001', async () => {}, spawn).run()
            expect(refineCalled).toBe(false)
            const {frontMatter} = await readTaskFile(cwd, 'TASK_0001')
            expect(frontMatter.state).toBe('completed')
        })
    })
})

function happyScripts() {
    return {
        refine: REFINED_FIXTURE,
        researchFiles: RESEARCH_FILES,
        researchApis: RESEARCH_APIS,
        researchContext: RESEARCH_CONTEXT,
        researchTooling: RESEARCH_TOOLING,
        verifyTooling: VERIFY_TOOLING_OUT,
        grillGen: NO_QUESTIONS,
        compose: COMPOSE_SPEC,
        critique: COMPOSE_SPEC
    }
}

describe('runSingleTask', () => {
    test('runSingleTask: default delivers spec without an extra idle wait (parity with /task)', async () => {
        await withTmpTaskDir(async cwd => {
            // The spec is delivered through the *replacement* session, so assert
            // on the shared call log rather than patching the (soon-stale) ctx.
            const {ctx, captured} = makeFakeCtx(cwd)
            const {ok, taskId} = await runSingleTask(ctx, cwd, 'run lint', {
                spawnFn: scriptedSpawn(happyScripts())
            })
            expect(ok).toBe(true)
            expect(taskId).toBe('TASK_0001')
            expect(captured.calls).toEqual(['send'])
        })
    })

    test('runSingleTask: waitForImplementation awaits idle after delivering the spec', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx, captured} = makeFakeCtx(cwd)
            const {ok} = await runSingleTask(ctx, cwd, 'run lint', {
                waitForImplementation: true,
                spawnFn: scriptedSpawn(happyScripts())
            })
            expect(ok).toBe(true)
            expect(captured.calls).toEqual(['send', 'idle'])
        })
    })

    test('runSingleTask: returns the fresh replacement ctx; the original is stale', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx} = makeFakeCtx(cwd)
            const res = await runSingleTask(ctx, cwd, 'run lint', {
                spawnFn: scriptedSpawn(happyScripts())
            })
            // The run replaced the session, so the handed-back ctx is a new, live
            // object — not the original, which now throws on use.
            expect(res.ctx).toBeDefined()
            expect(res.ctx).not.toBe(ctx)
            expect(() => ctx.ui.notify('x', 'info')).toThrow(/stale/)
            // The replacement ctx is live.
            expect(() => res.ctx!.ui.notify('ok', 'info')).not.toThrow()
        })
    })
})

describe('TaskRunner — failure modes', () => {
    test('empty refine output → state failed, reason mentions refine (TASK_0004 regression)', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx} = makeFakeCtx(cwd)
            const spawn = scriptedSpawn({refine: ''})
            await new TaskRunner(ctx, cwd, 'run lint', undefined, async () => {}, spawn).run()
            const {frontMatter} = await readTaskFile(cwd, 'TASK_0001')
            expect(frontMatter.state).toBe('failed')
            expect(frontMatter.phase).toBe('refine')
            expect(frontMatter.reason).toMatch(/refine child produced no output/)
        })
    })

    test('empty FILES research worker → state failed, reason names the worker', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx} = makeFakeCtx(cwd)
            const spawn = scriptedSpawn({
                refine: REFINED_FIXTURE,
                researchFiles: '',
                researchApis: RESEARCH_APIS,
                researchContext: RESEARCH_CONTEXT,
                researchTooling: RESEARCH_TOOLING
            })
            await new TaskRunner(ctx, cwd, 'run lint', undefined, async () => {}, spawn).run()
            const {frontMatter} = await readTaskFile(cwd, 'TASK_0001')
            expect(frontMatter.state).toBe('failed')
            expect(frontMatter.reason).toMatch(/Research FILES worker produced no output/)
        })
    })

    test('compose retry with emphasis: first attempt fenced, second valid', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx} = makeFakeCtx(cwd)
            let composeAttempts = 0
            const composePrompts: string[] = []
            const spawn = fakeSpawnByPrompt(args => {
                const prompt = args[args.length - 1]
                const tag = findTag(prompt)
                if (tag === 'compose') {
                    composePrompts.push(prompt)
                    composeAttempts++
                    const text = composeAttempts === 1 ? '```sh\nGOAL\n…\n```' : COMPOSE_SPEC
                    return {
                        events: [
                            {
                                type: 'agent_end',
                                messages: [{role: 'assistant', content: [{type: 'text', text}]}]
                            }
                        ]
                    }
                }
                const map: Partial<Record<typeof tag, string>> = {
                    refine: REFINED_FIXTURE,
                    researchFiles: RESEARCH_FILES,
                    researchApis: RESEARCH_APIS,
                    researchContext: RESEARCH_CONTEXT,
                    researchTooling: RESEARCH_TOOLING,
                    verifyTooling: VERIFY_TOOLING_OUT,
                    grillGen: NO_QUESTIONS,
                    critique: COMPOSE_SPEC
                }
                const text = map[tag] ?? ''
                return agentEndResponse(text)
            })
            await new TaskRunner(ctx, cwd, 'run lint', undefined, async () => {}, spawn).run()
            expect(composeAttempts).toBe(2)
            expect(composePrompts[1]).toContain('PREVIOUS ATTEMPT VIOLATED')
            const {frontMatter} = await readTaskFile(cwd, 'TASK_0001')
            expect(frontMatter.state).toBe('completed')
        })
    })

    test('critique missing VERIFY twice → fallback to compose draft, task completed', async () => {
        await withTmpTaskDir(async cwd => {
            const handle = makeFakeCtx(cwd)
            const BAD_CRITIQUE = `GOAL
x
CONSTRAINTS
- y
ACCEPTANCE
- w
`
            const spawn = scriptedSpawn({
                refine: REFINED_FIXTURE,
                researchFiles: RESEARCH_FILES,
                researchApis: RESEARCH_APIS,
                researchContext: RESEARCH_CONTEXT,
                researchTooling: RESEARCH_TOOLING,
                verifyTooling: VERIFY_TOOLING_OUT,
                grillGen: NO_QUESTIONS,
                compose: COMPOSE_SPEC,
                critique: BAD_CRITIQUE
            })
            const sent: string[] = []
            await new TaskRunner(
                handle.ctx,
                cwd,
                'run lint',
                undefined,
                async s => {
                    sent.push(s)
                },
                spawn
            ).run()
            const {frontMatter} = await readTaskFile(cwd, 'TASK_0001')
            expect(frontMatter.state).toBe('completed')
            const fallbackNotify = handle.captured.notifies.find(
                n => n.level === 'warning' && n.msg.includes('Critique couldn')
            )
            expect(fallbackNotify).toBeDefined()
            expect(sent[0]).toContain('VERIFY:')
        })
    })

    test('loop exhaustion in refine → state failed with loop_detected reason', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx} = makeFakeCtx(cwd)
            const loopRefine = {
                events: Array.from({length: 5}, () => ({
                    type: 'tool_execution_start',
                    toolName: 'Read',
                    args: {path: '/foo'}
                }))
            }
            const spawn = fakeSpawnByPrompt(args => {
                const tag = findTag(args[args.length - 1])
                if (tag === 'refine') return loopRefine
                return agentEndResponse('noop')
            })
            await new TaskRunner(ctx, cwd, 'run lint', undefined, async () => {}, spawn).run()
            const {frontMatter} = await readTaskFile(cwd, 'TASK_0001')
            expect(frontMatter.state).toBe('failed')
            expect(frontMatter.reason).toMatch(/loop detected 3× in refine/)
            const events = await readSection(cwd, 'TASK_0001', 'loop events')
            expect(events).not.toBeNull()
            expect((events ?? '').split('\n').length).toBeGreaterThanOrEqual(3)
        })
    })

    test('user cancel during research → state cancelled, warning notify', async () => {
        await withTmpTaskDir(async cwd => {
            const handle = makeFakeCtx(cwd)
            const runnerHolder: {runner?: TaskRunner} = {}
            let cancelTriggered = false
            const spawn = fakeSpawnByPrompt(args => {
                const tag = findTag(args[args.length - 1])
                if (tag === 'researchFiles' && !cancelTriggered) {
                    cancelTriggered = true
                    queueMicrotask(() => runnerHolder.runner?.cancel())
                }
                const map: Partial<Record<typeof tag, string>> = {
                    refine: REFINED_FIXTURE,
                    researchFiles: RESEARCH_FILES,
                    researchApis: RESEARCH_APIS,
                    researchContext: RESEARCH_CONTEXT,
                    researchTooling: RESEARCH_TOOLING
                }
                const text = map[tag] ?? 'noop'
                return agentEndResponse(text)
            })
            runnerHolder.runner = new TaskRunner(
                handle.ctx,
                cwd,
                'run lint',
                undefined,
                async () => {},
                spawn
            )
            await runnerHolder.runner.run()
            const {frontMatter} = await readTaskFile(cwd, 'TASK_0001')
            expect(frontMatter.state).toBe('cancelled')
            const warn = handle.captured.notifies.find(n => n.level === 'warning')
            expect(warn).toBeDefined()
        })
    })
})
