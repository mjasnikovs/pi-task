/**
 * The live-config bridge for reasoning profiles: group in, argv fragment out.
 *
 * Separate from reasoning.ts because that module must take no import with a
 * runtime side effect — see its header. The `getConfig()` read lives here
 * instead: this file imports both, and nothing in config/ imports it back, so
 * the graph stays a tree.
 *
 * Read PER CALL, never cached at module scope, so a /task-config change lands on
 * the next child without a restart. Same contract `childBaseArgs` keeps.
 */
import {getConfig, type PiTaskConfig} from './config.js'
import {resolveReasoning, thinkingArgs, type ReasoningGroup} from './reasoning.js'

/**
 * The `['--thinking', level]` fragment for a group, or `[]` when the group is
 * `inherit` and the child should keep falling back to settings.json.
 *
 * Every argv builder calls this rather than reading config itself. The two
 * callers that skip it are not argv builders: the host-session turn
 * (implementation-thinking.ts) and the settings UI (register.ts) both need the
 * level itself, not a flag, so they call `resolveReasoning` directly.
 */
export function groupThinkingArgs(group: ReasoningGroup, cfg?: PiTaskConfig): string[] {
    // The default is evaluated HERE, per call. Hoisting the read to module scope
    // would leave every test green, so the optional parameter is what makes the
    // per-call contract assertable.
    return thinkingArgs(resolveReasoning(group, cfg ?? getConfig()))
}
