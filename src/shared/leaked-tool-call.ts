/**
 * Detect tool calls that leaked into a child's assistant *text* instead of
 * being executed.
 *
 * Background: every child pi runs under `--mode json`; pi-task only ever treats
 * a structured `tool_execution_start` event as a tool call (see
 * shared/child-process.ts). When a local model emits a call in a markup dialect
 * pi's harness doesn't recognise — e.g.
 *
 *     <tool_call>
 *     <function=bash>
 *     <parameter=command>grep …</parameter>
 *     </function>
 *     </tool_call>
 *
 * pi passes the raw markup through as ordinary assistant text. The command never
 * runs, no event fires, and pi-task's guards (loop detector, widget) never see
 * it. The phase then "passes" on its only gates (non-empty text + exit 0) and
 * the unexecuted call flows downstream — a silently skipped beat.
 *
 * This is fundamentally an upstream mismatch (model output format ↔ pi's parser)
 * that pi-task cannot fix. What it CAN do is notice the leaked markup and refuse
 * to accept the turn, so the skip becomes visible instead of silent.
 */

// A child that wrote a tool call as plain text (wrong dialect, never executed)
// gets re-prompted with a correction hint up to this many times before the
// caller gives up. Mirrors MAX_LOOP_RESTARTS: 3 attempts total.
export const MAX_LEAK_RETRIES = 2

// The Hermes-style wrapper a leaked call is most often wrapped in. pi-task never
// legitimately emits this tag, so its presence alone is a confident signal.
const TOOL_CALL_WRAPPER = /<tool_call\b[^>]*>/i

// The "XML function call" dialect: <function=name> … <parameter=key>. Either tag
// alone is too weak (a stray "<function=x>" can appear in prose or source), so we
// require the structural pair before flagging it.
const FUNCTION_TAG = /<function=[\w.-]+\s*>/i
const PARAMETER_TAG = /<parameter=[\w.-]+\s*>/i

/**
 * Return the offending marker string if `text` contains a leaked tool call, or
 * null if it looks clean. The marker is suitable for logging and for naming the
 * problem back to the model in a re-prompt hint.
 */
export function detectLeakedToolCall(text: string): string | null {
    const wrapper = TOOL_CALL_WRAPPER.exec(text)
    if (wrapper) return wrapper[0]
    const fn = FUNCTION_TAG.exec(text)
    if (fn && PARAMETER_TAG.test(text)) return fn[0]
    return null
}

/**
 * A correction hint to prepend to a re-spawn after a leak, naming the offending
 * markup so the model stops repeating that exact mistake.
 */
export function leakedToolCallHint(marker: string): string {
    return (
        `[SYSTEM NOTE: Your previous turn wrote a tool call as plain text (\`${marker}\`) `
        + `instead of invoking the tool — so it never ran and you proceeded without its result. `
        + `Invoke tools through the native tool-calling mechanism; never type `
        + `<tool_call>/<function=…>/<parameter=…> markup into your answer.]`
    )
}
