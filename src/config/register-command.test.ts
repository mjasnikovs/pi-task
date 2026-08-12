/**
 * /task-config outside a TUI.
 *
 * pi runs headless too (`--print`, the boot hook, the remote bridge), where
 * there is no overlay to open. The command must still ANSWER there — and answer
 * with the same rendering the panel uses, which is the point of the assertions
 * below: the flat listing is built from each item's own `format`, so a setting
 * cannot read one way in the panel and another way here.
 *
 * The TUI branch is the settings overlay itself; its per-item behaviour is
 * covered by register.test.ts against ITEMS directly.
 */
import {afterEach, beforeEach, describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type {ExtensionAPI, ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import {ITEMS, registerConfig} from './register.js'
import {getConfig} from './config.js'

type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<void>

/** The /task-config handler pi would dispatch to. `tools` is what the live pi
 *  would report from getAllTools(); throwing stands for an uninitialised runtime. */
function taskConfig(tools: unknown[] | 'throws' = []): Handler {
    let handler: Handler | undefined
    const pi = {
        on: () => {},
        registerTool: () => {},
        registerCommand: (name: string, opts: {handler: Handler}) => {
            if (name === 'task-config') handler = opts.handler
        },
        getAllTools: () => {
            if (tools === 'throws') throw new Error('runtime not initialised')
            return tools
        }
    }
    registerConfig(pi as unknown as ExtensionAPI)
    return handler!
}

const notified: Array<{msg: string; level: string}> = []
let cwd: string

function headlessCtx(): ExtensionCommandContext {
    return {
        cwd,
        mode: 'print',
        ui: {
            notify: (msg: string, level: string) => notified.push({msg, level})
        }
    } as unknown as ExtensionCommandContext
}

let savedVerify: boolean
let savedExempt: string[]

beforeEach(() => {
    notified.length = 0
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'task-config-'))
    savedVerify = getConfig().verifyWork
    savedExempt = [...getConfig().commandTimeoutExemptTools]
})
afterEach(() => {
    getConfig().verifyWork = savedVerify
    getConfig().commandTimeoutExemptTools = savedExempt
    fs.rmSync(cwd, {recursive: true, force: true})
})

describe('/task-config with no TUI', () => {
    test('reports every setting on one line, by label', async () => {
        await taskConfig()('', headlessCtx())

        expect(notified.length).toBe(1)
        expect(notified[0].level).toBe('info')
        for (const {label} of ITEMS) expect(notified[0].msg).toContain(label)
    })

    test('reports the CURRENT value, not a default', async () => {
        const label = ITEMS.find(i => i.id === 'verifyWork')!.label

        getConfig().verifyWork = true
        await taskConfig()('', headlessCtx())
        const on = notified[0].msg

        notified.length = 0
        getConfig().verifyWork = false
        await taskConfig()('', headlessCtx())
        const off = notified[0].msg

        expect(on).toContain(label)
        expect(on).not.toBe(off)
    })

    test('lists each guardable tool as watched unless it is exempt', async () => {
        getConfig().commandTimeoutExemptTools = ['bash']

        await taskConfig([
            {name: 'bash', sourceInfo: {source: 'builtin', path: ''}},
            {name: 'read', sourceInfo: {source: 'builtin', path: ''}}
        ])('', headlessCtx())

        expect(notified[0].msg).toContain('watch: bash')
        expect(notified[0].msg).toContain('watch: read')
        // The exempt one is the only 'off'; both rows exist either way.
        const rows = notified[0].msg.split('  |  ')
        expect(rows.find(r => r.startsWith('watch: bash'))).toContain('off')
        expect(rows.find(r => r.startsWith('watch: read'))).toContain('on')
    })

    test('a tool enumeration that throws costs the tool rows, never the menu', async () => {
        await taskConfig('throws')('', headlessCtx())

        expect(notified.length).toBe(1)
        expect(notified[0].msg).not.toContain('watch: ')
        for (const {label} of ITEMS) expect(notified[0].msg).toContain(label)
    })
})
