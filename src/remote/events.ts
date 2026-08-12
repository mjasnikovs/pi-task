import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import {publishNotify} from './bridge.js'
import type {ContextUsage} from './protocol.js'
import {
    agentStart,
    appendText,
    textEnd,
    appendThinking,
    thinkingEnd,
    startTool,
    updateTool,
    endTool,
    agentEnd,
    addUserTurn,
    addError,
    addSystemNote
} from './session-state.js'

/** Mirror pi agent events into the authoritative SessionState. Each handler
 *  drives a mutator, which updates the snapshot AND broadcasts the live delta. */
export function setupEvents(pi: ExtensionAPI): void {
    pi.on('agent_start', (_event, ctx) => {
        agentStart(ctx.model?.name)
    })

    pi.on('message_update', (event, _ctx) => {
        const ae = event.assistantMessageEvent
        if (ae.type === 'text_delta' && 'delta' in ae && typeof ae.delta === 'string') {
            appendText(ae.delta)
        } else if (ae.type === 'thinking_delta' && 'delta' in ae && typeof ae.delta === 'string') {
            appendThinking(ae.delta)
        } else if (ae.type === 'thinking_end') {
            thinkingEnd()
        } else if (ae.type === 'error') {
            const errorMessage =
                'error' in ae && ae.error && typeof ae.error.errorMessage === 'string' ?
                    ae.error.errorMessage
                :   ''
            // Skip silent user aborts (no message); only surface genuine failures.
            if (errorMessage || ae.reason === 'error') {
                const message = errorMessage || 'Request failed'
                addError(message)
                // No push here: pi-task only notifies for the two cases the user
                // cares about — needing their input (the grill/clarify dialog, see
                // bridge.ask) and a top-level /task or /task-auto run finishing
                // (orchestrator/auto-orchestrator). A push on every host agent
                // error — most of them outside any task — is just noise.
            }
        }
    })

    pi.on('message_end', (_event, _ctx) => {
        textEnd()
    })

    pi.on('tool_execution_start', (event, _ctx) => {
        startTool(event.toolCallId, event.toolName, event.args)
    })

    pi.on('tool_execution_update', (event, _ctx) => {
        updateTool(event.toolCallId, event.partialResult)
    })

    pi.on('tool_execution_end', (event, _ctx) => {
        endTool(event.toolCallId, event.toolName, event.result, event.isError)
    })

    pi.on('agent_end', (_event, ctx) => {
        agentEnd(ctx.getContextUsage() as ContextUsage, ctx.model?.name)
        // Deliberately no push: agent_end fires on EVERY host turn — every chat
        // reply, every internal phase turn inside /task, and every internal /task
        // run inside /task-auto — so a "Task finished" push here floods the device.
        // The real "a run finished" push is fired from the top-level command
        // handlers instead (orchestrator handleTask/handleTaskResume, and
        // auto-orchestrator's runAutoLoop), which never fire for internal runs.
    })

    pi.on('input', (event, _ctx) => {
        if (event.source === 'interactive' && typeof event.text === 'string') {
            addUserTurn(event.text)
        }
    })

    // Context-window compaction (incl. the auto-compaction triggered by a context
    // overflow) is invisible to a remote viewer otherwise — mirror it as a toast so
    // they see the same "compacting…" status the terminal shows.
    pi.on('session_before_compact', (_event, _ctx) => {
        publishNotify('Context full — compacting…', 'warning')
    })
    pi.on('session_compact', (_event, _ctx) => {
        // Persistent inline note so it's still visible after a reconnect, not just a
        // transient toast.
        addSystemNote('Context compacted')
    })
}
