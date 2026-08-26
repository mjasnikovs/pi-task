/**
 * The live-config bridge for reasoning profiles: group in, argv fragment out.
 *
 * Separate from reasoning.ts because that module must stay import-free — see its
 * header. This file is the one hop that reads `getConfig()`, so it imports both
 * and neither imports it back: a tree, not a cycle.
 *
 * Read PER CALL, never cached at module scope, so a /task-config change lands on
 * the next child without a restart — the same contract childBaseArgs states.
 */
import {getConfig} from './config.js'
import {resolveReasoning, thinkingArgs, type ReasoningGroup} from './reasoning.js'

/**
 * The `['--thinking', level]` fragment for a group, or `[]` when the group is
 * `inherit` and the child should keep falling back to settings.json.
 *
 * This is the ONLY function the argv builders call. They never read config
 * themselves — an argv builder that resolves its own policy is one that cannot
 * be told to do something else, which is how childBaseArgs became universal.
 */
export function groupThinkingArgs(group: ReasoningGroup): string[] {
    return thinkingArgs(resolveReasoning(group, getConfig()))
}
