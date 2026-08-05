import {describe, expect, test} from 'bun:test'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    allocatePlanId,
    buildHandoffPrompt,
    buildPlanBody,
    formatPlanDecisions,
    formatPlanTranscript,
    HANDOFF_DELIVERABLE_RULE,
    type PlanEntry
} from './plan-io.js'
import {ensureTasksDir, tasksDir} from './task-io.js'

async function tmpRepo(): Promise<string> {
    return await fsp.mkdtemp(path.join(os.tmpdir(), 'pi-plan-io-'))
}

describe('allocatePlanId', () => {
    test('starts at 0001 and skips TASK_ / TASK_AUTO_ files', async () => {
        const cwd = await tmpRepo()
        await ensureTasksDir(cwd)
        await fsp.writeFile(path.join(tasksDir(cwd), 'TASK_0007.md'), 'x')
        await fsp.writeFile(path.join(tasksDir(cwd), 'TASK_AUTO_0009.md'), 'x')
        expect(await allocatePlanId(cwd)).toBe('TASK_PLAN_0001')
    })

    test('takes the max existing plan number + 1', async () => {
        const cwd = await tmpRepo()
        await ensureTasksDir(cwd)
        await fsp.writeFile(path.join(tasksDir(cwd), 'TASK_PLAN_0002.md'), 'x')
        await fsp.writeFile(path.join(tasksDir(cwd), 'TASK_PLAN_0011.md'), 'x')
        expect(await allocatePlanId(cwd)).toBe('TASK_PLAN_0012')
    })
})

const ENTRIES: PlanEntry[] = [
    {
        kind: 'decision',
        question: 'Global or per-provider?',
        answer: 'per-provider',
        source: 'chosen'
    },
    {kind: 'note', question: 'Which file registers the workers?', answer: 'src/workers/index.ts'},
    {kind: 'stated', text: 'do not touch the brave provider'},
    {
        kind: 'decision',
        question: 'Cap the retries?',
        answer: 'cap at 3',
        source: 'accepted'
    }
]

describe('formatPlanTranscript', () => {
    test('numbers only the model questions and labels who said what', () => {
        const t = formatPlanTranscript(ENTRIES)
        expect(t).toContain('Q1: Global or per-provider?')
        expect(t).toContain('A1: per-provider')
        expect(t).toContain('THE USER ASKED: Which file registers the workers?')
        expect(t).toContain('YOU ANSWERED: src/workers/index.ts')
        expect(t).toContain('DECIDED BY USER: do not touch the brave provider')
        // The note does not consume a question number.
        expect(t).toContain('Q2: Cap the retries?')
        expect(t).toContain('A2: cap at 3 (accepted recommendation)')
    })

    test('is empty for an empty transcript', () => {
        expect(formatPlanTranscript([])).toBe('')
    })
})

describe('formatPlanDecisions', () => {
    test('renders a placeholder rather than an empty section', () => {
        expect(formatPlanDecisions([])).toBe('(none yet)')
    })
})

describe('buildPlanBody', () => {
    test('carries the task prompt and an empty decisions section', () => {
        const body = buildPlanBody('add rate limiting')
        expect(body).toContain('## task prompt')
        expect(body).toContain('add rate limiting')
        expect(body).toContain('## decisions')
    })
})

describe('buildHandoffPrompt', () => {
    test('leads with the task prompt so /task sees a normal description first', () => {
        const p = buildHandoffPrompt('add rate limiting', ENTRIES)
        expect(p.startsWith('add rate limiting')).toBe(true)
    })

    test('carries the decisions as authoritative and DROPS the advisory notes', () => {
        const p = buildHandoffPrompt('add rate limiting', ENTRIES)
        expect(p).toContain('PLANNING DECISIONS')
        expect(p).toContain('per-provider')
        expect(p).toContain('DECIDED BY USER: do not touch the brave provider')
        // A model answer the user merely read is not a decision — it must not
        // reach the implementer dressed as one.
        expect(p).not.toContain('src/workers/index.ts')
        expect(p).not.toContain('THE USER ASKED')
    })

    test('is the prompt plus the deliverable rule when nothing was decided', () => {
        const bare = buildHandoffPrompt('  add rate limiting  ', [])
        expect(bare.startsWith('add rate limiting')).toBe(true)
        expect(bare).toContain(HANDOFF_DELIVERABLE_RULE)
        expect(bare).not.toContain('PLANNING DECISIONS')
        const notesOnly: PlanEntry[] = [{kind: 'note', question: 'q', answer: 'a'}]
        expect(buildHandoffPrompt('add rate limiting', notesOnly)).toBe(bare)
    })

    // The live failure: "Lets plan new tab and report" led the handoff, /task's
    // refine took the verb as the deliverable, and the task it built accepted a
    // document and verified that no source file had changed.
    test('pins the deliverable so a "plan X" request is not re-planned by /task', () => {
        const p = buildHandoffPrompt('Lets plan new tab and report @src/app/reports/', ENTRIES)
        expect(p).toContain('PLANNING IS ALREADY DONE')
        expect(p).toContain('Build the thing')
        expect(p).toContain('no user is available')
        // It sits above the decisions, not buried under them.
        expect(p.indexOf(HANDOFF_DELIVERABLE_RULE)).toBeLessThan(p.indexOf('PLANNING DECISIONS'))
    })

    test('drops a skipped question — a non-answer is not an authoritative decision', () => {
        const withSkip: PlanEntry[] = [
            ...ENTRIES,
            {
                kind: 'decision',
                question: 'Which cache backend?',
                answer: '(skipped)',
                source: 'skipped'
            },
            {
                kind: 'decision',
                question: 'Which queue?',
                answer: '(skipped — no recommended option)',
                source: 'yolo'
            }
        ]
        const p = buildHandoffPrompt('add rate limiting', withSkip)
        expect(p).not.toContain('Which cache backend?')
        expect(p).not.toContain('Which queue?')
        expect(p).toContain('Cap the retries?')
    })
})
