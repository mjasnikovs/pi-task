import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import {setAgentIdle} from './state.js'
import {getBridge} from './bridge.js'
import type {ContextUsage} from './protocol.js'
import type {HistoryBuffer, ToolSummary} from './history.js'

export function setupEvents(
    pi: ExtensionAPI,
    history: HistoryBuffer,
    broadcastFn: (msg: unknown) => void
): void {
    let currentText = ''
    const currentTools: ToolSummary[] = []
    const pendingArgs = new Map<string, unknown>()

    pi.on('agent_start', (_event, _ctx) => {
        currentText = ''
        currentTools.length = 0
        pendingArgs.clear()
        setAgentIdle(false)
        broadcastFn({type: 'agent_start'})
    })

    pi.on('message_update', (event, _ctx) => {
        const ae = event.assistantMessageEvent
        if (ae.type === 'text_delta' && 'delta' in ae && typeof ae.delta === 'string') {
            currentText += ae.delta
            broadcastFn({type: 'text_delta', delta: ae.delta})
        } else if (ae.type === 'error') {
            const errorMessage =
                'error' in ae && ae.error && typeof ae.error.errorMessage === 'string' ?
                    ae.error.errorMessage
                :   ''
            // Skip silent user aborts (no message); only surface genuine failures.
            if (errorMessage || ae.reason === 'error') {
                const message = errorMessage || 'Request failed'
                history.addError(message)
                broadcastFn({type: 'agent_error', message})
            }
        }
    })

    pi.on('message_end', (_event, _ctx) => {
        broadcastFn({type: 'text_end'})
    })

    pi.on('tool_execution_start', (event, _ctx) => {
        pendingArgs.set(event.toolCallId, event.args)
        broadcastFn({
            type: 'tool_start',
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args
        })
    })

    pi.on('tool_execution_update', (event, _ctx) => {
        broadcastFn({
            type: 'tool_update',
            toolCallId: event.toolCallId,
            partialResult: event.partialResult
        })
    })

    pi.on('tool_execution_end', (event, _ctx) => {
        const args = pendingArgs.get(event.toolCallId)
        pendingArgs.delete(event.toolCallId)
        currentTools.push({
            toolName: event.toolName,
            args,
            result: event.result,
            isError: event.isError
        })
        broadcastFn({
            type: 'tool_end',
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            result: event.result,
            isError: event.isError
        })
    })

    pi.on('agent_end', (_event, ctx) => {
        const contextUsage = ctx.getContextUsage()
        setAgentIdle(true)
        // Remember it so a browser that connects mid-session gets its bar seeded.
        getBridge().lastContextUsage = contextUsage as ContextUsage
        history.addAssistantTurn(currentText, [...currentTools])
        broadcastFn({type: 'agent_end', contextUsage})
        currentText = ''
        currentTools.length = 0
    })

    pi.on('input', (event, _ctx) => {
        if (event.source === 'interactive' && typeof event.text === 'string') {
            history.addUserMessage(event.text)
            broadcastFn({type: 'user_message', text: event.text})
        }
    })
}
