/**
 * /task-plan's CHILD wrapper and its handoff.
 *
 * Two things live here that the flow tests next door stub out:
 *
 *   • the read-only contract. /task-plan promises it will not touch the project,
 *     and the only thing that makes that a promise rather than a hope is the
 *     before/after tree comparison around every planning child. It must report,
 *     never roll back — a file we cannot account for is evidence.
 *   • the default handoff, which must be EXACTLY what `/task <prompt>` does, so
 *     a planned task is not a second kind of task.
 *
 * The child process and /task itself are faked at the module boundary; the
 * worktree is real, because the contract is about real files.
 */

import {afterEach, beforeEach, describe, expect, mock, test} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as realChildRunner from './child-runner.js'
import * as realOrchestrator from './orchestrator.js'
import type {RunEnd} from './run-end.js'
import * as realPlanSession from './plan-session.js'
import type {PhaseDeps} from './child-runner.js'
import type {PlanOutcome} from './plan-session.js'
import {getConfig} from '../config/config.js'
import {makeFakeCtx} from '../test-utils/fake-ctx.js'
import {readSection, writeTaskFile} from './task-io.js'
import {buildPlanBody} from './plan-io.js'

interface ChildCall {
    deps: PhaseDeps
    name: string
    tools: string
    prompt: string
}

const childCalls: ChildCall[] = []
/** Side effect the fake child performs while "running" — how a leak is staged. */
let childBody: (cwd: string) => void = () => {}
let childReply = 'NONE'
let childThrows: Error | null = null

void mock.module('./child-runner.js', () => ({
    ...realChildRunner,
    runPhaseChild: async (deps: PhaseDeps, name: string, tools: string, prompt: string) => {
        childCalls.push({deps, name, tools, prompt})
        childBody(deps.cwd)
        if (childThrows) throw childThrows
        return childReply
    }
}))

const gated: Array<{prompt: string}> = []
const single: Array<{prompt: string}> = []
let singleResult: {taskId: string; end: RunEnd} = {
    taskId: 'TASK_0007',
    end: {kind: 'completed'} as RunEnd
}

void mock.module('./orchestrator.js', () => ({
    ...realOrchestrator,
    runGatedTask: async (_ctx: unknown, _cwd: string, prompt: string) => {
        gated.push({prompt})
    },
    runSingleTask: async (_ctx: unknown, _cwd: string, prompt: string) => {
        single.push({prompt})
        return singleResult
    }
}))

let sessionOutcome: PlanOutcome = {kind: 'proceed', entries: []}
void mock.module('./plan-session.js', () => ({
    ...realPlanSession,
    runPlanSession: async () => sessionOutcome
}))

const {buildPlanDeps, handleTaskPlan} =
    (await import('./plan-orchestrator.js')) as typeof import('./plan-orchestrator.js')

const PLAN_ID = 'TASK_PLAN_0001'

const gitInit = (dir: string): void => {
    for (const args of [
        ['init', '-q'],
        ['config', 'user.email', 't@t'],
        ['config', 'user.name', 't']
    ]) {
        Bun.spawnSync(['git', ...args], {cwd: dir})
    }
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1\n')
    Bun.spawnSync(['git', 'add', '-A'], {cwd: dir})
    Bun.spawnSync(['git', 'commit', '-qm', 'init'], {cwd: dir})
}

function repo(withGit = true): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-child-'))
    if (withGit) gitInit(dir)
    return dir
}

let savedVerify: boolean
let savedEnforce: boolean

beforeEach(() => {
    childCalls.length = 0
    gated.length = 0
    single.length = 0
    childBody = () => {}
    childReply = 'NONE'
    childThrows = null
    singleResult = {taskId: 'TASK_0007', end: {kind: 'completed'}}
    sessionOutcome = {kind: 'proceed', entries: []}
    savedVerify = getConfig().verifyWork
    savedEnforce = getConfig().enforceGuidelines
})
afterEach(() => {
    getConfig().verifyWork = savedVerify
    getConfig().enforceGuidelines = savedEnforce
})

describe('the planning children', () => {
    const build = (cwd: string) => {
        const h = makeFakeCtx(cwd)
        return {
            h,
            deps: buildPlanDeps(
                h.ctx,
                cwd,
                PLAN_ID,
                'add rate limiting',
                new AbortController().signal
            )
        }
    }

    test('the question child gets the question prompt and the read-only tool set', async () => {
        const {deps} = build(repo())
        childReply = '1. **Which providers?**\nSUGGESTED: all three'

        expect(await deps.generateQuestion('', null)).toBe(childReply)

        expect(childCalls).toHaveLength(1)
        expect(childCalls[0].name).toBe('plan-question')
        expect(childCalls[0].prompt).toContain('add rate limiting')
        expect(childCalls[0].prompt).toContain('SUGGESTED')
        expect(childCalls[0].tools).not.toContain('write')
        expect(childCalls[0].tools).not.toContain('edit')
    })

    test('a retry hint is prepended to the question prompt', async () => {
        const {deps} = build(repo())
        await deps.generateQuestion('Q1: a?\nA1: b', 'you emitted no SUGGESTED line')
        expect(childCalls[0].prompt).toContain('you emitted no SUGGESTED line')
        expect(childCalls[0].prompt).toContain('A1: b')
    })

    test('the answer child gets the user’s question, not the question generator', async () => {
        const {deps} = build(repo())
        await deps.answerUserQuestion('', 'which providers exist?')
        expect(childCalls[0].name).toBe('plan-answer')
        expect(childCalls[0].prompt).toContain('which providers exist?')
        expect(childCalls[0].prompt).not.toContain('SUGGESTED')
    })

    test('the child’s stream feeds the status widget', async () => {
        const {h, deps} = build(repo())
        childBody = () => {
            childCalls[0].deps.onChildOutput?.('reading src/workers/index.ts')
            childCalls[0].deps.onContextUsage?.({used: 4_000, total: 128_000} as never)
        }
        await deps.generateQuestion('', null)
        expect(h.captured.widgets.length).toBeGreaterThan(0)
    })

    test('setStatus renames the step shown while the child runs', async () => {
        const {h, deps} = build(repo())
        deps.setStatus?.('answering you')
        await deps.generateQuestion('', null)
        const painted = JSON.stringify(h.captured.widgets)
        expect(painted).toContain('answering you')
    })

    test('a child failure still tears the loader down', async () => {
        const {h, deps} = build(repo())
        childThrows = new Error('model error — socket hang up')
        await expect(deps.generateQuestion('', null)).rejects.toThrow('socket hang up')
        // The last widget write clears the key.
        expect(h.captured.widgets.at(-1)?.state).toBeUndefined()
    })
})

describe('the read-only contract', () => {
    /** The plan file exists before the first child runs — handleTaskPlan
     *  allocates it up front so a crash mid-session still leaves the record. */
    async function seedPlanFile(cwd: string): Promise<void> {
        const now = new Date(0).toISOString()
        await writeTaskFile(
            cwd,
            {
                id: PLAN_ID,
                state: 'in_progress',
                phase: 'done',
                created_at: now,
                updated_at: now,
                title: 'rate limiting'
            },
            buildPlanBody('add rate limiting')
        )
    }

    const build = async (cwd: string) => {
        await seedPlanFile(cwd)
        const h = makeFakeCtx(cwd)
        return {
            h,
            deps: buildPlanDeps(
                h.ctx,
                cwd,
                PLAN_ID,
                'add rate limiting',
                new AbortController().signal
            )
        }
    }

    test('a planning step that writes into the project is REPORTED, not rolled back', async () => {
        const cwd = repo()
        const {h, deps} = await build(cwd)
        childBody = dir => fs.writeFileSync(path.join(dir, 'NOTES.md'), '# my notes\n')

        await deps.generateQuestion('', null)

        const errors = h.captured.notifies.filter(n => n.level === 'error').map(n => n.msg)
        expect(errors.join('\n')).toContain('NOTES.md')
        expect(await readSection(cwd, PLAN_ID, 'read-only violations')).toContain('NOTES.md')
        // NOT a rollback: the evidence stays on disk for the user to judge.
        expect(fs.existsSync(path.join(cwd, 'NOTES.md'))).toBe(true)
    })

    test('a second violation is appended, not overwritten', async () => {
        const cwd = repo()
        const {deps} = await build(cwd)
        childBody = dir => fs.writeFileSync(path.join(dir, 'NOTES.md'), '# one\n')
        await deps.generateQuestion('', null)
        childBody = dir => fs.writeFileSync(path.join(dir, 'SCRATCH.md'), '# two\n')
        await deps.answerUserQuestion('', 'why?')

        const section = (await readSection(cwd, PLAN_ID, 'read-only violations')) ?? ''
        expect(section).toContain('NOTES.md')
        expect(section).toContain('SCRATCH.md')
    })

    test('the plan file’s own .pi-tasks writes are not a violation', async () => {
        const cwd = repo()
        const {h, deps} = await build(cwd)
        childBody = dir => {
            fs.mkdirSync(path.join(dir, '.pi-tasks'), {recursive: true})
            fs.writeFileSync(path.join(dir, '.pi-tasks', 'scratch.md'), 'x\n')
        }

        await deps.generateQuestion('', null)

        expect(h.captured.notifies.filter(n => n.level === 'error')).toEqual([])
        expect(await readSection(cwd, PLAN_ID, 'read-only violations')).toBeNull()
    })

    test('a clean planning step reports nothing', async () => {
        const cwd = repo()
        const {h, deps} = await build(cwd)
        await deps.generateQuestion('', null)
        expect(h.captured.notifies.filter(n => n.level === 'error')).toEqual([])
    })

    test('outside a git repo there is nothing to compare, and no false report', async () => {
        const cwd = repo(false)
        const {h, deps} = await build(cwd)
        childBody = dir => fs.writeFileSync(path.join(dir, 'NOTES.md'), '# my notes\n')

        await deps.generateQuestion('', null)

        expect(h.captured.notifies.filter(n => n.level === 'error')).toEqual([])
    })
})

describe('the default handoff', () => {
    test('goes through the GATED path when verify work is on', async () => {
        getConfig().verifyWork = true
        getConfig().enforceGuidelines = false
        const cwd = repo(false)
        const h = makeFakeCtx(cwd)

        await handleTaskPlan('add rate limiting', h.ctx)

        expect(gated).toHaveLength(1)
        expect(gated[0].prompt).toContain('add rate limiting')
        expect(single).toEqual([])
        // runGatedTask never surfaces an inner task id, so nothing is linked.
        expect(await readSection(cwd, PLAN_ID, 'handoff')).not.toContain('task:')
    })

    test('goes through the ungated single-task path when both gates are off', async () => {
        getConfig().verifyWork = false
        getConfig().enforceGuidelines = false
        const cwd = repo(false)
        const h = makeFakeCtx(cwd)

        await handleTaskPlan('add rate limiting', h.ctx)

        expect(single).toHaveLength(1)
        expect(gated).toEqual([])
        expect(await readSection(cwd, PLAN_ID, 'handoff')).toContain('task: TASK_0007')
    })

    test('a session that could not be replaced is reported and links nothing', async () => {
        getConfig().verifyWork = false
        getConfig().enforceGuidelines = false
        singleResult = {taskId: '', end: {kind: 'no-session'}}
        const cwd = repo(false)
        const h = makeFakeCtx(cwd)

        await handleTaskPlan('add rate limiting', h.ctx)

        expect(
            h.captured.notifies.some(n => n.msg.includes('Could not start a fresh session'))
        ).toBe(true)
        expect(await readSection(cwd, PLAN_ID, 'handoff')).not.toContain('task:')
    })
})
