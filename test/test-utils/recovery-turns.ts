import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import {registerRecoveryTurns} from '../../src/task/recovery-turn.js'

/** recovery-turn.ts registered on a fake pi: drive its events, read what it posts. */
export function recoveryTurns(): {
    sent: string[]
    settle: () => void
    start: () => void
    shutdown: () => void
} {
    const handlers = new Map<string, () => void>()
    const sent: string[] = []
    registerRecoveryTurns({
        on: (name: string, fn: () => void) => handlers.set(name, fn),
        sendUserMessage: (text: string) => sent.push(text)
    } as unknown as ExtensionAPI)
    return {
        sent,
        settle: () => handlers.get('agent_settled')!(),
        start: () => handlers.get('agent_start')!(),
        shutdown: () => handlers.get('session_shutdown')!()
    }
}
