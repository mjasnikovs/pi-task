/**
 * Three extension ENTRY POINTS whose whole job is wiring: `src/index.ts` and the
 * two standalone worker bundles. Nothing in src/ IMPORTS them — worker-channels
 * names the two bundles as `-e` path strings only — so no other test can reach
 * their bodies. (`single-read-extension` is the fourth of that shape and has its
 * own file.)
 *
 * What this proves is exactly what wiring gets wrong: a module that exists, is
 * tested, and is never registered. Every command and tool pi-task claims to ship
 * is asserted BY NAME here, so deleting a `register…(pi)` line fails a test
 * instead of silently shipping an extension missing half its surface.
 *
 * The registrars are called with a RECORDING fake `pi`. Registration is pure
 * bookkeeping — handlers are stored, never invoked — so this spawns nothing and
 * touches no project.
 */
import {describe, expect, test} from 'bun:test'
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import registerExtension from '../src/index.js'
import {registerWorkers} from '../src/workers/index.js'
import registerDocsExtension from '../src/workers/docs-extension.js'
import registerSearchExtension from '../src/workers/search-extension.js'

interface Recorder {
    pi: ExtensionAPI
    commands: string[]
    tools: string[]
    events: string[]
    /** name → the registered tool definition, for the pure bits (renderCall). */
    toolDefs: Map<string, RegisteredTool>
}

interface RegisteredTool {
    name: string
    renderCall?: (args: never, theme: never) => unknown
}

function recorder(): Recorder {
    const commands: string[] = []
    const tools: string[] = []
    const events: string[] = []
    const toolDefs = new Map<string, RegisteredTool>()
    const pi = {
        on: (event: string) => void events.push(event),
        registerCommand: (name: string) => void commands.push(name),
        registerTool: (tool: RegisteredTool) => {
            tools.push(tool.name)
            toolDefs.set(tool.name, tool)
        },
        sendUserMessage: () => {
            throw new Error('registration must not send a message')
        }
    }
    return {pi: pi as unknown as ExtensionAPI, commands, tools, events, toolDefs}
}

/** Every command a user can type. A rename here is a user-visible break. */
const COMMANDS = [
    'task-config',
    'task',
    'task-list',
    'task-resume',
    'task-cancel',
    'task-auto',
    'task-plan'
]

const WORKER_TOOLS = ['pi-worker', 'pi-worker-search', 'pi-worker-fetch', 'pi-worker-docs']

describe('the pi-task extension entry point', () => {
    test('registers every command it ships', () => {
        const r = recorder()
        registerExtension(r.pi)
        for (const name of COMMANDS) expect(r.commands).toContain(name)
    })

    test('registers every worker tool it ships', () => {
        const r = recorder()
        registerExtension(r.pi)
        expect(r.tools.sort()).toEqual([...WORKER_TOOLS].sort())
    })

    test('subscribes the watchdogs and the remote bridge', () => {
        const r = recorder()
        registerExtension(r.pi)
        // One representative event per registrar that has no command or tool of
        // its own — the only handle on whether it was wired at all.
        for (const event of [
            'session_start', // remote + brave-key warning
            'session_shutdown', // remote, command watchdog, stream watchdog
            'tool_execution_start', // command watchdog + impl widget
            'tool_call', // implementation guards
            'agent_settled', // implementation guards — the disarm boundary
            'before_provider_request', // stream watchdog
            'message_end' // stream watchdog + remote
        ]) {
            expect(r.events).toContain(event)
        }
    })

    test('registers nothing twice — no command or tool name collides', () => {
        const r = recorder()
        registerExtension(r.pi)
        expect(new Set(r.commands).size).toBe(r.commands.length)
        expect(new Set(r.tools).size).toBe(r.tools.length)
    })
})

describe('the standalone worker bundles', () => {
    test('registerWorkers is the whole worker surface', () => {
        const r = recorder()
        registerWorkers(r.pi)
        expect(r.tools.sort()).toEqual([...WORKER_TOOLS].sort())
    })

    test('the docs-only extension ships docs and nothing else', () => {
        const r = recorder()
        registerDocsExtension(r.pi)
        expect(r.tools).toEqual(['pi-worker-docs'])
    })

    test('the search-only extension ships search + fetch and nothing else', () => {
        const r = recorder()
        registerSearchExtension(r.pi)
        expect(r.tools.sort()).toEqual(['pi-worker-fetch', 'pi-worker-search'])
    })
})

describe('pi-worker renderCall', () => {
    /** A theme that tags rather than colours, so the assembly is readable. */
    const theme = {
        fg: (_slot: string, s: string) => s,
        bold: (s: string) => s
    } as never

    const render = (prompt: string): string => {
        const r = recorder()
        registerWorkers(r.pi)
        const call = r.toolDefs.get('pi-worker')?.renderCall as (
            a: unknown,
            t: unknown
        ) => {render: (w: number) => string[]}
        return call({prompt}, theme).render(200).join('\n')
    }

    test('collapses the prompt onto one line', () => {
        expect(render('find\n  the   thing')).toContain('pi-worker find the thing')
    })

    test('truncates a long prompt with an ellipsis', () => {
        const out = render('x'.repeat(300))
        expect(out).toContain('…')
        expect(out.length).toBeLessThan(300)
    })
})
