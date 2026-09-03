/**
 * The /task and /task-auto COMMAND HANDLERS — the layer a user's keystroke
 * actually lands on, reached the way pi reaches it: through the registrar, off
 * the registered command table, with the real ExtensionCommandContext shape.
 *
 * What is covered here is every branch that answers WITHOUT running a task —
 * the empty invocation, the listing, the not-found and nothing-to-do refusals,
 * the cancel with no run. Those are the paths a user hits most often, and the
 * only ones that need no live model.
 *
 * The branches that go on to run work — runSingleTask, runGatedTask,
 * runAutoLoop — need a real pi child, so they are driven through injected deps
 * in the orchestrator suites rather than from the command table.
 */
import {afterEach, beforeEach, describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type {ExtensionAPI, ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import {registerTask} from '../../src/task/orchestrator.js'
import {registerTaskAuto} from '../../src/task/auto-orchestrator.js'
import {makeFakeCtx, type FakeCtxHandle} from '../test-utils/fake-ctx.js'
import {getConfig} from '../../src/config/config.js'
import {getBridge} from '../../src/remote/bridge.js'
import {broadcast as wsBroadcast} from '../../src/remote/broadcast.js'
import {_setSink, reset as resetSessionState, snapshot} from '../../src/remote/session-state.js'

type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<void> | void

/** The command table pi would end up with, keyed by the name a user types. */
function commandTable(register: (pi: ExtensionAPI) => void): Map<string, Handler> {
    const table = new Map<string, Handler>()
    const pi = {
        on: () => {},
        registerCommand: (name: string, opts: {handler: Handler}) => table.set(name, opts.handler),
        registerTool: () => {},
        sendUserMessage: () => {}
    }
    register(pi as unknown as ExtensionAPI)
    return table
}

const dirs: string[] = []
function projectDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-cmd-'))
    dirs.push(dir)
    return dir
}
afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, {recursive: true, force: true})
})

/** A task file as the pipeline writes it. */
function writeTask(cwd: string, id: string, fm: Record<string, string>): void {
    const dir = path.join(cwd, '.pi-tasks')
    fs.mkdirSync(dir, {recursive: true})
    const front = Object.entries(fm)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n')
    fs.writeFileSync(path.join(dir, `${id}.md`), `---\n${front}\n---\n\n## spec\ndo it\n`)
}

const TASK = (id: string, state: string, phase = 'compose'): Record<string, string> => ({
    id,
    state,
    phase,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T03:04:05.000Z',
    title: `the ${id} job`
})

let fake: FakeCtxHandle
let cwd: string
let savedVerify: boolean
let savedEnforce: boolean

beforeEach(() => {
    cwd = projectDir()
    fake = makeFakeCtx(cwd)
    savedVerify = getConfig().verifyWork
    savedEnforce = getConfig().enforceGuidelines
    // Both gates OFF: every branch below must answer before it could reach a
    // child either way, and this proves it rather than assuming it.
    getConfig().verifyWork = false
    getConfig().enforceGuidelines = false
})
afterEach(() => {
    getConfig().verifyWork = savedVerify
    getConfig().enforceGuidelines = savedEnforce
})

describe('/task', () => {
    const cmd = (name: string): Handler => commandTable(registerTask).get(name)!

    test('bare /task primes the editor instead of starting an empty task', async () => {
        await cmd('task')('   ', fake.ctx)

        expect(fake.captured.editorTexts).toEqual(['/task '])
        expect(fake.captured.notifies[0].msg).toContain('Type your prompt after /task')
        expect(fake.captured.sentMessages).toEqual([])
    })

    test('/task-cancel with nothing running says so', async () => {
        await cmd('task-cancel')('', fake.ctx)

        expect(fake.captured.notifies).toEqual([{msg: 'No task is running.', level: 'info'}])
    })
})

describe('/task-list', () => {
    const list = (): Handler => commandTable(registerTask).get('task-list')!

    test('lists tasks newest first, with state, phase and title', async () => {
        writeTask(cwd, 'TASK_0001', TASK('TASK_0001', 'completed', 'critique'))
        writeTask(cwd, 'TASK_0002', TASK('TASK_0002', 'in_progress', 'research'))
        // The listing sorts newest-first on mtime (orchestrator.ts:889), so
        // backdating this file must move it even though its id is lower.
        const older = path.join(cwd, '.pi-tasks', 'TASK_0002.md')
        fs.utimesSync(older, new Date(0), new Date(0))

        await list()('', fake.ctx)

        const shown = fake.captured.editors[0].content
        expect(shown.indexOf('TASK_0001')).toBeLessThan(shown.indexOf('TASK_0002'))
        expect(shown).toContain('in_progress')
        expect(shown).toContain('the TASK_0001 job')
        expect(shown).toContain('/task-resume')
    })

    test('an empty project says so rather than showing a blank sheet', async () => {
        await list()('', fake.ctx)
        expect(fake.captured.editors[0].content).toContain('(no tasks in .pi-tasks/)')
    })

    test('a task file that is not parseable is skipped, not fatal', async () => {
        fs.mkdirSync(path.join(cwd, '.pi-tasks'), {recursive: true})
        fs.writeFileSync(path.join(cwd, '.pi-tasks', 'TASK_0007.md'), 'no front matter here\n')
        writeTask(cwd, 'TASK_0008', TASK('TASK_0008', 'pending'))

        await list()('', fake.ctx)

        const shown = fake.captured.editors[0].content
        expect(shown).toContain('TASK_0008')
        expect(shown).not.toContain('TASK_0007')
    })
})

describe('/task-resume', () => {
    const resume = (): Handler => commandTable(registerTask).get('task-resume')!

    test('names the id it could not find', async () => {
        await resume()('TASK_0042', fake.ctx)

        expect(fake.captured.notifies).toEqual([
            {msg: 'TASK_0042 not found in .pi-tasks/', level: 'error'}
        ])
    })

    test('accepts a bare number as an id', async () => {
        await resume()('42', fake.ctx)
        expect(fake.captured.notifies[0].msg).toContain('TASK_0042')
    })

    test('with no resumable task, says there is none', async () => {
        writeTask(cwd, 'TASK_0001', TASK('TASK_0001', 'completed'))

        await resume()('', fake.ctx)

        expect(fake.captured.notifies).toEqual([{msg: 'No resumable tasks.', level: 'info'}])
    })
})

describe('/task-auto', () => {
    const cmd = (name: string): Handler => commandTable(registerTaskAuto).get(name)!

    test('bare /task-auto primes the editor instead of planning nothing', async () => {
        await cmd('task-auto')('  ', fake.ctx)

        expect(fake.captured.editorTexts).toEqual(['/task-auto '])
        expect(fake.captured.notifies[0].msg).toContain('Describe the feature after /task-auto')
    })

    test('/task-auto-cancel with no loop running says so', async () => {
        await cmd('task-auto-cancel')('', fake.ctx)

        expect(fake.captured.notifies).toEqual([
            {msg: 'No /task-auto loop is running.', level: 'info'}
        ])
    })

    test('/task-auto-resume with nothing to resume refuses and starts no loop', async () => {
        await cmd('task-auto-resume')('', fake.ctx)

        expect(fake.captured.notifies.length).toBe(1)
        expect(fake.captured.sentMessages).toEqual([])
    })

    test('--unattended refuses a run that only a human may continue', async () => {
        // A FAILED run is human-resumable and unattended-refusable: the boot hook
        // must not silently restart work a person stopped looking at.
        writeTask(cwd, 'TASK_0001', {...TASK('TASK_0001', 'failed'), kind: 'auto'})

        await cmd('task-auto-resume')('--unattended', fake.ctx)

        expect(fake.captured.sentMessages).toEqual([])
        expect(fake.captured.notifies.length).toBe(1)
    })

    test('an unattended refusal is still on the remote in the morning', async () => {
        const b = getBridge()
        _setSink(msg => b.sent.push(msg as never))
        try {
            writeTask(cwd, 'TASK_0001', {...TASK('TASK_0001', 'failed'), kind: 'auto'})

            await cmd('task-auto-resume')('--unattended', fake.ctx)

            // Nobody was watching the terminal. A toast is dropped after 4s and is
            // absent from the reconnect snapshot, which is the whole point of
            // mirroring this one.
            expect(JSON.stringify(snapshot())).toContain('TASK_0001')
        } finally {
            b.pending.clear()
            b.sent.length = 0
            resetSessionState()
            _setSink(wsBroadcast)
        }
    })
})
