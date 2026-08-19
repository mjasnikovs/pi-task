import {describe, expect, test} from 'bun:test'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    buildPlanDeps,
    discardEmptyPlanFile,
    handleTaskPlan,
    persistEntries,
    type PlanCommandDeps
} from './plan-orchestrator.js'
import {buildPlanBody} from './plan-io.js'
import type {PlanEntry} from './plan-io.js'
import {buildIdleSpec, type PlanOutcome} from './plan-session.js'
import {writeTaskFile, readSection, readTaskFile, setTaskSection} from './task-io.js'
import type {TaskFrontMatter} from './task-types.js'
import {makeFakeCtx} from '../test-utils/fake-ctx.js'
import {isRunActive} from './mid-run-input.js'

const PLAN_ID = 'TASK_PLAN_0001'

async function seededRepo(): Promise<string> {
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'pi-plan-orch-'))
    const now = new Date().toISOString()
    const fm: TaskFrontMatter = {
        id: PLAN_ID,
        state: 'in_progress',
        phase: 'done',
        created_at: now,
        updated_at: now,
        title: 'rate limiting'
    }
    await writeTaskFile(cwd, fm, buildPlanBody('add rate limiting'))
    return cwd
}

const ENTRIES: PlanEntry[] = [
    {
        kind: 'decision',
        question: 'Global or per-provider?',
        answer: 'per-provider',
        source: 'chosen'
    },
    {kind: 'note', question: 'Which file registers them?', answer: 'src/workers/index.ts'},
    {kind: 'stated', text: 'leave brave alone'}
]

describe('persistEntries', () => {
    test('keeps the advisory notes OUT of the authoritative decisions section', async () => {
        const cwd = await seededRepo()
        await persistEntries(cwd, PLAN_ID, ENTRIES)
        const decisions = await readSection(cwd, PLAN_ID, 'decisions')
        const notes = await readSection(cwd, PLAN_ID, 'notes')
        expect(decisions).toContain('A1: per-provider')
        expect(decisions).toContain('DECIDED BY USER: leave brave alone')
        expect(decisions).not.toContain('src/workers/index.ts')
        expect(notes).toContain('Q: Which file registers them?')
        expect(notes).toContain('A: src/workers/index.ts')
    })

    test('writes no notes section when the user never asked anything', async () => {
        const cwd = await seededRepo()
        await persistEntries(cwd, PLAN_ID, [ENTRIES[0]])
        expect(await readSection(cwd, PLAN_ID, 'notes')).toBeNull()
    })

    test('rewrites in place, so a later call is not an append', async () => {
        const cwd = await seededRepo()
        await persistEntries(cwd, PLAN_ID, [ENTRIES[0]])
        await persistEntries(cwd, PLAN_ID, ENTRIES)
        const decisions = (await readSection(cwd, PLAN_ID, 'decisions')) ?? ''
        expect(decisions.match(/A1: per-provider/g)).toHaveLength(1)
    })
})

describe('buildPlanDeps wiring', () => {
    test('the ask dialog for the user question is a plain text input, skippable', async () => {
        const cwd = await seededRepo()
        const h = makeFakeCtx(cwd)
        const deps = buildPlanDeps(
            h.ctx,
            cwd,
            PLAN_ID,
            'add rate limiting',
            new AbortController().signal
        )
        h.queueInput('which providers exist?')
        const typed = await deps.promptText('Ask the model', 'What do you want to ask?')
        expect(typed).toBe('which providers exist?')
        expect(h.captured.inputs).toHaveLength(1)
    })

    test("the model's answer is shown in the editor, not as a fleeting toast", async () => {
        const cwd = await seededRepo()
        const h = makeFakeCtx(cwd)
        const deps = buildPlanDeps(
            h.ctx,
            cwd,
            PLAN_ID,
            'add rate limiting',
            new AbortController().signal
        )
        h.queueEditor(undefined)
        await deps.showAnswer('which providers exist?', 'exa, ddg and brave')
        expect(h.captured.editors).toHaveLength(1)
        expect(h.captured.editors[0].content).toContain('which providers exist?')
        expect(h.captured.editors[0].content).toContain('exa, ddg and brave')
    })

    test('persisting through the deps lands in the plan file', async () => {
        const cwd = await seededRepo()
        const h = makeFakeCtx(cwd)
        const deps = buildPlanDeps(
            h.ctx,
            cwd,
            PLAN_ID,
            'add rate limiting',
            new AbortController().signal
        )
        await deps.onEntries?.(ENTRIES)
        expect(await readSection(cwd, PLAN_ID, 'decisions')).toContain('per-provider')
    })

    test('the idle picker reaches the local TUI as a boxed picker, not a bare input', async () => {
        const cwd = await seededRepo()
        const h = makeFakeCtx(cwd)
        const deps = buildPlanDeps(
            h.ctx,
            cwd,
            PLAN_ID,
            'add rate limiting',
            new AbortController().signal
        )
        // The fake ctx has no ui.custom, so the picker path rejects and ask()
        // resolves undefined — what matters here is that it did NOT fall back to
        // ui.input, which is how a picker-less prompt would present.
        await deps.ask(buildIdleSpec())
        expect(h.captured.inputs).toHaveLength(0)
    })
})

// ─── The command flow ────────────────────────────────────────────────────────

/** Command deps with the model and the /task handoff replaced by recorders. */
function commandHarness(outcome: PlanOutcome | Error) {
    const rec: {prompts: string[]; sessions: number} = {prompts: [], sessions: 0}
    const deps: PlanCommandDeps = {
        session: () => {
            rec.sessions++
            return {} as never
        },
        run: () => (outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome)),
        handoff: (_ctx, _cwd, prompt) => {
            rec.prompts.push(prompt)
            return Promise.resolve('TASK_0042')
        }
    }
    return {deps, rec}
}

const DECIDED: PlanOutcome = {
    kind: 'proceed',
    entries: [
        {
            kind: 'decision',
            question: 'Global or per-provider?',
            answer: 'per-provider',
            source: 'chosen'
        },
        {kind: 'note', question: 'Which file?', answer: 'src/workers/index.ts'}
    ]
}

describe('handleTaskPlan', () => {
    async function freshRepo(): Promise<string> {
        return await fsp.mkdtemp(path.join(os.tmpdir(), 'pi-plan-cmd-'))
    }

    test('an empty prompt primes the editor instead of starting a plan', async () => {
        const cwd = await freshRepo()
        const h = makeFakeCtx(cwd)
        const {deps, rec} = commandHarness(DECIDED)
        await handleTaskPlan('   ', h.ctx, deps)
        expect(rec.sessions).toBe(0)
        expect(h.captured.editorTexts).toEqual(['/task-plan '])
    })

    test('writes the plan file, then hands the decisions to /task and links them', async () => {
        const cwd = await freshRepo()
        const h = makeFakeCtx(cwd)
        const {deps, rec} = commandHarness(DECIDED)
        await handleTaskPlan('add rate limiting', h.ctx, deps)

        const {frontMatter} = await readTaskFile(cwd, PLAN_ID)
        expect(frontMatter.state).toBe('completed')
        expect(await readSection(cwd, PLAN_ID, 'task prompt')).toContain('add rate limiting')
        expect(await readSection(cwd, PLAN_ID, 'handoff')).toContain('task: TASK_0042')
        expect(await readSection(cwd, PLAN_ID, 'handoff')).toContain('decisions: 1')

        expect(rec.prompts).toHaveLength(1)
        expect(rec.prompts[0]).toContain('add rate limiting')
        expect(rec.prompts[0]).toContain('per-provider')
        // The advisory note is NOT handed to the implementer.
        expect(rec.prompts[0]).not.toContain('src/workers/index.ts')
    })

    // The plan session's children run with the host idle — the same window in
    // which /task and /task-auto hold mid-run input. Left unbracketed, a line
    // typed then went into pi's queue and fired after the plan.
    test('the plan session owns the session: mid-run input is held for its duration', async () => {
        const cwd = await freshRepo()
        const h = makeFakeCtx(cwd)
        const seen: boolean[] = []
        const {deps, rec} = commandHarness(DECIDED)
        deps.run = () => {
            seen.push(isRunActive())
            return Promise.resolve(DECIDED)
        }
        deps.handoff = (_ctx, _cwd, prompt) => {
            seen.push(isRunActive())
            rec.prompts.push(prompt)
            return Promise.resolve('TASK_0042')
        }
        expect(isRunActive()).toBe(false)
        await handleTaskPlan('add rate limiting', h.ctx, deps)
        expect(seen).toEqual([true, true])
        expect(isRunActive()).toBe(false)
    })

    test('cancelling keeps the file as a record and hands nothing to /task', async () => {
        const cwd = await freshRepo()
        const h = makeFakeCtx(cwd)
        const {deps, rec} = commandHarness({kind: 'cancelled', entries: DECIDED.entries})
        await handleTaskPlan('add rate limiting', h.ctx, deps)
        expect(rec.prompts).toHaveLength(0)
        const {frontMatter} = await readTaskFile(cwd, PLAN_ID)
        expect(frontMatter.state).toBe('cancelled')
        expect(h.captured.notifies.some(n => n.msg.includes('cancelled'))).toBe(true)
    })

    test('a failed child leaves the plan file failed with the cause, and no handoff', async () => {
        const cwd = await freshRepo()
        const h = makeFakeCtx(cwd)
        const {deps, rec} = commandHarness(
            new Error('plan-question child: model error — socket hang up')
        )
        await handleTaskPlan('add rate limiting', h.ctx, deps)
        expect(rec.prompts).toHaveLength(0)
        const {frontMatter} = await readTaskFile(cwd, PLAN_ID)
        expect(frontMatter.state).toBe('failed')
        expect(frontMatter.reason).toContain('socket hang up')
    })

    // A plan with no decisions still went THROUGH planning, and the request that
    // opened it is routinely phrased as one ("lets plan X") — so the deliverable
    // rule rides along even here; only the decisions block is absent.
    test('a plan with no decisions hands over the prompt plus the deliverable rule', async () => {
        const cwd = await freshRepo()
        const h = makeFakeCtx(cwd)
        const {deps, rec} = commandHarness({kind: 'proceed', entries: []})
        await handleTaskPlan('add rate limiting', h.ctx, deps)
        expect(rec.prompts[0].startsWith('add rate limiting')).toBe(true)
        expect(rec.prompts[0]).toContain('PLANNING IS ALREADY DONE')
        expect(rec.prompts[0]).not.toContain('PLANNING DECISIONS')
    })

    test('each run allocates its own plan file', async () => {
        const cwd = await freshRepo()
        const h = makeFakeCtx(cwd)
        const {deps} = commandHarness({kind: 'proceed', entries: []})
        await handleTaskPlan('one', h.ctx, deps)
        await handleTaskPlan('two', h.ctx, deps)
        expect((await readTaskFile(cwd, 'TASK_PLAN_0002')).frontMatter.title).toContain('two')
    })
})

describe('the read-only contract', () => {
    async function freshRepo2(): Promise<string> {
        return await fsp.mkdtemp(path.join(os.tmpdir(), 'pi-plan-ro-'))
    }

    test('an abandoned plan leaves no file behind', async () => {
        const cwd = await freshRepo2()
        const h = makeFakeCtx(cwd)
        const {deps} = commandHarness({kind: 'cancelled', entries: []})
        await handleTaskPlan('add rate limiting', h.ctx, deps)
        await expect(readTaskFile(cwd, PLAN_ID)).rejects.toThrow()
    })

    test('a cancelled plan that decided something IS kept', async () => {
        const cwd = await freshRepo2()
        const h = makeFakeCtx(cwd)
        const {deps} = commandHarness({kind: 'cancelled', entries: DECIDED.entries})
        await handleTaskPlan('add rate limiting', h.ctx, deps)
        expect((await readTaskFile(cwd, PLAN_ID)).frontMatter.state).toBe('cancelled')
    })

    test('a recorded violation is never discarded, even with nothing decided', async () => {
        const cwd = await freshRepo2()
        const h = makeFakeCtx(cwd)
        const {deps} = commandHarness({kind: 'cancelled', entries: []})
        // Record the violation from inside the session, as the child wrapper does.
        deps.run = async () => {
            await setTaskSection(
                cwd,
                PLAN_ID,
                'read-only violations',
                '- /task-plan is read-only, but the plan-question step created NOTES.md'
            )
            return {kind: 'cancelled', entries: []}
        }
        await handleTaskPlan('add rate limiting', h.ctx, deps)
        expect(await readSection(cwd, PLAN_ID, 'read-only violations')).toContain('NOTES.md')
    })

    test('discardEmptyPlanFile removes the debug log with the plan file', async () => {
        const cwd = await seededRepo()
        const log = path.join(cwd, '.pi-tasks', `${PLAN_ID}-debug.log`)
        await fsp.writeFile(log, 'x\n')
        await discardEmptyPlanFile(cwd, PLAN_ID)
        await expect(fsp.access(log)).rejects.toThrow()
    })
})
