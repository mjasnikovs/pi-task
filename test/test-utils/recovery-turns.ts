import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import {registerRecoveryTurns} from '../../src/task/recovery-turn.js'

type Handler = (event: unknown, ctx: unknown) => unknown

/** recovery-turn.ts registered on a fake pi: drive its events, read what it posts. */
export function recoveryTurns(): {
    sent: string[]
    notices: string[]
    settle: () => Promise<unknown>
    start: () => void
    input: (text: string) => Promise<unknown>
    toolEnd: (isError: boolean) => void
    shutdown: () => void
} {
    const handlers = new Map<string, Handler>()
    const sent: string[] = []
    const notices: string[] = []
    const ctx = {ui: {notify: (message: string) => notices.push(message)}}
    registerRecoveryTurns({
        on: (name: string, fn: Handler) => handlers.set(name, fn),
        sendUserMessage: (text: string) => sent.push(text)
    } as unknown as ExtensionAPI)
    const emit = (name: string, event: unknown = {}): unknown => handlers.get(name)!(event, ctx)
    return {
        sent,
        notices,
        settle: async () => emit('agent_settled'),
        start: () => emit('agent_start'),
        input: async text => emit('input', {text}),
        toolEnd: isError => emit('tool_execution_end', {isError}),
        shutdown: () => emit('session_shutdown')
    }
}
