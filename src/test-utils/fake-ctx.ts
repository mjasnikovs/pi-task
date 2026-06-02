/**
 * Minimal fake ExtensionCommandContext for orchestrator tests.
 *
 * Captures notify/input/widget/editor/sendUserMessage calls into arrays so
 * tests can assert on them. Queue ui.input / ui.editor responses with
 * `queueInput(s)` / `queueEditor(s)`.
 */

import type {ExtensionCommandContext} from '@earendil-works/pi-coding-agent'

export interface CapturedNotify {
    msg: string
    level: 'info' | 'warning' | 'error'
}

export interface CapturedWidget {
    key: string
    state: unknown
}

export interface FakeCtxHandle {
    ctx: ExtensionCommandContext
    cwd: string
    captured: {
        notifies: CapturedNotify[]
        inputs: Array<{title: string; default?: string}>
        widgets: CapturedWidget[]
        editorTexts: string[]
        editors: Array<{title: string; content: string}>
        sentMessages: Array<{spec: string; opts?: unknown}>
    }
    queueInput(value: string | undefined): void
    queueEditor(value: string | undefined): void
}

export function makeFakeCtx(cwd: string): FakeCtxHandle {
    const inputQueue: Array<string | undefined> = []
    const editorQueue: Array<string | undefined> = []
    const captured: FakeCtxHandle['captured'] = {
        notifies: [],
        inputs: [],
        widgets: [],
        editorTexts: [],
        editors: [],
        sentMessages: []
    }

    const ctx = {
        cwd,
        ui: {
            theme: {
                fg: (_role: string, text: string) => text
            },
            notify: (msg: string, level: 'info' | 'warning' | 'error') => {
                captured.notifies.push({msg, level})
            },
            input: async (title: string, defaultValue?: string) => {
                captured.inputs.push({title, default: defaultValue})
                if (inputQueue.length === 0) return undefined
                return inputQueue.shift()
            },
            setWidget: (key: string, state: unknown) => {
                captured.widgets.push({key, state})
            },
            setEditorText: (s: string) => {
                captured.editorTexts.push(s)
            },
            editor: async (title: string, content: string) => {
                captured.editors.push({title, content})
                if (editorQueue.length === 0) return undefined
                return editorQueue.shift()
            }
        },
        waitForIdle: async () => undefined,
        isIdle: () => true,
        newSession: async <T>({
            withSession
        }: {
            withSession: (ctx: ExtensionCommandContext) => Promise<T>
        }) => {
            await withSession(ctx as unknown as ExtensionCommandContext)
            return {cancelled: false}
        },
        sendUserMessage: async (spec: string, opts?: unknown) => {
            captured.sentMessages.push({spec, opts})
        }
    } as unknown as ExtensionCommandContext

    return {
        ctx,
        cwd,
        captured,
        queueInput(value: string | undefined) {
            inputQueue.push(value)
        },
        queueEditor(value: string | undefined) {
            editorQueue.push(value)
        }
    }
}
