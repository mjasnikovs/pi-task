import type {AgentToolResult} from '@earendil-works/pi-agent-core'

/** Build a plain-text AgentToolResult. */
export function textResult<T>(text: string, details: T): AgentToolResult<T> {
    return {content: [{type: 'text', text}], details}
}
