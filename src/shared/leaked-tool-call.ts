/**
 * Detect tool calls that leaked into a child's assistant *text* instead of
 * being executed.
 *
 * A call only counts when a structured `tool_execution_start` event fires —
 * shared/child-process.ts recognises nothing else. Model-side tool-call markup
 * like
 *
 *     <tool_call>
 *     <function=bash>
 *     <parameter=command>grep …</parameter>
 *     </function>
 *     </tool_call>
 *
 * is not a format pi itself parses: those tags appear nowhere in any installed
 * pi package. So whether such a turn RUNS is decided entirely by the inference
 * server in front of it, and both outcomes are real.
 *
 * Checked against a live endpoint, the server parsed the dialect itself and
 * handed pi structured tool calls — the markup EXECUTED rather than leaking, and
 * the parse was sloppy enough to fold the closing tags and the surrounding prose
 * into the command argument. A server that does not parse it produces the case
 * this module exists for: pi receives the markup as ordinary assistant text, the
 * command never runs, no event fires, and pi-task's guards never see it. The
 * turn then clears its only acceptance gates — non-empty assistant text and exit
 * 0 — and the unexecuted call flows downstream as a silently skipped beat.
 *
 * pi-task cannot fix the mismatch. What it CAN do is notice the markup in the
 * answer and refuse the turn, so the skip becomes visible instead of silent.
 */

// A child that wrote a tool call as plain text (wrong dialect, never executed)
// gets re-prompted with a correction hint up to this many times before the
// caller gives up. Mirrors MAX_LOOP_RESTARTS: 3 attempts total.
export const MAX_LEAK_RETRIES = 2

// The Hermes-style wrapper. Nothing else in this codebase emits the tag — its
// only other appearance is the correction hint below, which names it back to the
// model — so seeing it in an answer is signal enough on its own.
const TOOL_CALL_WRAPPER = /<tool_call\b[^>]*>/i

// The "XML function call" dialect: <function=name> … <parameter=key>. Either tag
// alone is too weak — one can appear in prose or in source — so the structural
// PAIR is required. Confirmed: a lone <function=bash> and a lone
// <parameter=command> each return null, and only the two together flag.
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
