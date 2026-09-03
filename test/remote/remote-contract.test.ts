/**
 * The remote contract: a command a browser can reach must be answerable FROM the
 * browser, and what it puts on screen must survive a reconnect.
 *
 * Issue #1 was one instance — /task-plan's answer viewer. These cover the rest of
 * the class. Every ctx here has a local dialog that never resolves, which is what
 * the real TUI does until someone acts on the host terminal; anything proven here
 * therefore holds with the local half wide open.
 */
import {afterEach, describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type {ExtensionAPI, ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import {
    answerPrompt,
    getBridge,
    SessionUI,
    dispatchRemoteLine,
    cancelPendingPrompts
} from '../../src/remote/bridge.js'
import {broadcast as wsBroadcast} from '../../src/remote/broadcast.js'
import {
    _setSink,
    getState,
    clearPrompt,
    setPrompt,
    reset,
    snapshot
} from '../../src/remote/session-state.js'
import {registerTask} from '../../src/task/orchestrator.js'
import {registerConfig} from '../../src/config/register.js'

type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<void> | void

function commandTable(register: (pi: ExtensionAPI) => void): Map<string, Handler> {
    const table = new Map<string, Handler>()
    const pi = {
        on: () => {},
        registerCommand: (name: string, opts: {handler: Handler}) => table.set(name, opts.handler),
        registerTool: () => {},
        sendUserMessage: () => {},
        getAllTools: () => []
    }
    register(pi as unknown as ExtensionAPI)
    return table
}

const dirs: string[] = []
function tmpRepo(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-remote-contract-'))
    dirs.push(d)
    return d
}

/** Every local dialog blocks forever — the state a host terminal is really in.
 *  `opened` records which of them the handler reached. */
function blockingCtx(cwd: string): {ctx: ExtensionCommandContext; opened: string[]} {
    const opened: string[] = []
    const never = (what: string) => () => {
        opened.push(what)
        return new Promise<never>(() => {})
    }
    const ctx = {
        cwd,
        hasUI: true,
        mode: 'tui',
        ui: {
            theme: {
                fg: (_c: string, s: string) => s,
                bold: (s: string) => s,
                dim: (s: string) => s
            },
            input: never('input'),
            custom: never('custom'),
            editor: never('editor'),
            select: never('select'),
            notify: () => {},
            setWidget: () => {},
            setEditorText: () => {}
        },
        waitForIdle: async () => {},
        isIdle: () => true
    } as unknown as ExtensionCommandContext
    return {ctx, opened}
}

afterEach(() => {
    const b = getBridge()
    b.pending.clear()
    b.sent.length = 0
    b.nextId = 0
    b.broadcast = msg => wsBroadcast(msg)
    b.commands.clear()
    b.currentCtx = null
    reset()
    _setSink(wsBroadcast)
    for (const d of dirs.splice(0)) fs.rmSync(d, {recursive: true, force: true})
})

/** Capture every frame AND route the session-state sink through the same array. */
function captureFrames(): {type: string}[] {
    const b = getBridge()
    b.broadcast = msg => b.sent.push(msg as never)
    _setSink(msg => b.sent.push(msg as never))
    return b.sent as unknown as {type: string}[]
}

describe('/task-list is answerable from the browser', () => {
    test('a remote dismissal releases it while the local editor is still open', async () => {
        const cwd = tmpRepo()
        captureFrames()
        const handler = commandTable(registerTask).get('task-list')!

        let released = false
        const run = Promise.resolve(handler('', blockingCtx(cwd).ctx)).then(() => {
            released = true
        })
        await new Promise(r => setTimeout(r, 20))

        expect(released).toBe(false)
        const open = getState().prompt
        expect(open).not.toBeNull()
        answerPrompt(open!.id, '')

        await run
        expect(released).toBe(true)
    })

    test('the listing survives a reconnect', async () => {
        const cwd = tmpRepo()
        captureFrames()
        const handler = commandTable(registerTask).get('task-list')!
        void Promise.resolve(handler('', blockingCtx(cwd).ctx))
        await new Promise(r => setTimeout(r, 20))

        expect(JSON.stringify(snapshot())).toContain('no tasks in .pi-tasks/')
    })
})

describe('/task-config from the browser', () => {
    test('never opens the host-only settings overlay', async () => {
        const cwd = tmpRepo()
        captureFrames()
        const table = commandTable(registerConfig)
        const b = getBridge()
        const host = blockingCtx(cwd)
        b.commands.set('task-config', table.get('task-config')!)
        b.currentCtx = host.ctx

        // dispatchRemoteLine is what the WS server calls for a browser slash line.
        dispatchRemoteLine('/task-config', {onPlain: () => {}})
        await new Promise(r => setTimeout(r, 60))

        // The panel is a TUI component the browser cannot render, and awaiting it
        // strands the remote caller on someone else's terminal.
        expect(host.opened).not.toContain('custom')
    })

    test('sends the settings to the browser durably, not as a 4s toast', async () => {
        const cwd = tmpRepo()
        const frames = captureFrames()
        const table = commandTable(registerConfig)
        const b = getBridge()
        b.commands.set('task-config', table.get('task-config')!)
        b.currentCtx = blockingCtx(cwd).ctx

        dispatchRemoteLine('/task-config', {onPlain: () => {}})
        await new Promise(r => setTimeout(r, 60))

        // A `notify` is removed after 4s and is absent from the snapshot; a
        // system note is committed to the transcript.
        expect(frames.some(f => f.type === 'system_note')).toBe(true)
        expect(JSON.stringify(snapshot())).toContain('auto-commit')
    })
})

describe('the prompt slot is per-prompt', () => {
    test('resolving one prompt does not erase another from the snapshot', () => {
        captureFrames()
        setPrompt({type: 'prompt', id: 'A', question: 'first?', allowSkip: false})
        setPrompt({type: 'prompt', id: 'B', question: 'second?', allowSkip: false})

        clearPrompt('A')

        expect(getState().prompt?.id).toBe('B')
    })
})

describe('a new session releases parked prompts', () => {
    test('cancelPendingPrompts settles a caller the reset left with no surface', async () => {
        const b = getBridge()
        captureFrames()
        const ui = new SessionUI(blockingCtx(tmpRepo()).ctx, b)

        let settled = false
        const asked = ui.ask({localTitle: 't', question: 'q?', allowSkip: false}).then(v => {
            settled = true
            return v
        })
        await new Promise(r => setTimeout(r, 20))
        expect(b.pending.size).toBe(1)

        reset()
        cancelPendingPrompts()

        expect(await asked).toBeUndefined()
        expect(settled).toBe(true)
        expect(b.pending.size).toBe(0)
    })
})
