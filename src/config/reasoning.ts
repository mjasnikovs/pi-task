/**
 * Reasoning profiles — which thinking level each group of model children runs at.
 *
 * WHY THIS EXISTS
 * ---------------
 * `CHILD_BASE_ARGS` (shared/child-process.ts) passes no `--thinking`, so every
 * pi-task child inherits `defaultThinkingLevel` from the host's
 * `~/.pi/agent/settings.json`. That is one level for children whose jobs are
 * nothing alike: a planner that must reason to produce a plan at all, and a
 * label-compressor that emits four words.
 *
 * `--thinking <level>` is pi's own flag. For a Qwen model it reaches the server
 * as `enable_thinking` — either a top-level parameter or inside
 * `chat_template_kwargs`, depending on the model's declared thinking format
 * (pi-ai `api/openai-completions.js`). Prompt text cannot reach that kwarg, so
 * the flag is the only lever on it.
 *
 * PURE MODULE — no imports with runtime side effects, so `config.ts` can import
 * the table and the sanitizers during its own module evaluation. `getConfig()`
 * lives one hop away in `group-args.ts` for exactly this reason: importing
 * it here would make config.ts ⇄ reasoning.ts a real cycle, and whichever module
 * a caller reached first would decide whether `DEFAULT_REASONING_TABLE` was
 * initialised before `DEFAULT_CONFIG` read it.
 */
import type {PiTaskConfig} from './config.js'
import {CHILD_GROUPS, sanitizeGroupRecord, type ChildGroup} from './groups.js'

/**
 * Re-exported because this module's whole public surface — the default table,
 * `resolveReasoning`, `effectiveReasoning` — is typed on them, so an importer of
 * those already needs them. The roster itself lives in groups.ts; `GROUP_BY_CHILD`
 * and `groupForChild` are deliberately NOT re-exported, so a caller that wants
 * the roster reaches for the roster.
 */
export {CHILD_GROUPS, type ChildGroup}

/**
 * The four profiles offered by /task-config.
 * - `default` the per-group table below
 * - `on`      one level everywhere ({@link REASONING_ON_LEVEL})
 * - `off`     no thinking anywhere
 * - `custom`  the user's own per-group table
 */
export type ReasoningMode = 'default' | 'on' | 'off' | 'custom'

export const REASONING_MODES: readonly ReasoningMode[] = ['default', 'on', 'off', 'custom'] as const

/**
 * What one group is set to.
 *
 * `inherit` is NOT a pi thinking level — it means EMIT NO FLAG, so the child
 * falls back to `settings.json`. With every cell at `inherit` this whole table
 * is a no-op and every child's argv is byte-identical to a build without it.
 */
export type GroupSetting = 'inherit' | 'off' | 'minimal' | 'low' | 'medium' | 'high'

/**
 * The settings offered in /task-config: `inherit` plus the standard part of pi's
 * own thinking cycle.
 *
 * `xhigh` and `max` are DELIBERATELY ABSENT. pi-ai's `getSupportedThinkingLevels`
 * accepts the standard levels for any reasoning model, but offers `xhigh` and
 * `max` only when the model declares them in its `thinkingLevelMap`. Offering
 * them here would put a level in this UI that pi's own UI may not have.
 */
export const REASONING_SETTINGS: readonly GroupSetting[] = [
    'inherit',
    'off',
    'minimal',
    'low',
    'medium',
    'high'
] as const

/** The level mode `on` uses. */
export const REASONING_ON_LEVEL: GroupSetting = 'medium'

/**
 * The per-group table used by mode `default`.
 *
 * `inherit` says nothing was decided for that group and the child keeps the
 * host's level. Any other value is a decision this project made for that
 * group's job, and `/task-config` mode `custom` overrides all of it.
 */
export const DEFAULT_REASONING_TABLE: Readonly<Record<ChildGroup, GroupSetting>> = {
    research: 'medium',

    // The four research workers, one cell each.
    'research:files': 'off',
    'research:apis': 'medium',
    'research:context': 'medium',
    'research:tooling': 'medium',

    phase: 'off',
    planning: 'medium',
    plan: 'inherit',
    gate: 'off',
    extraction: 'off',
    implementation: 'off'
}

/** A stored mode, or `default` when the value is not one. */
export function sanitizeReasoningMode(value: unknown): ReasoningMode {
    return REASONING_MODES.includes(value as ReasoningMode) ? (value as ReasoningMode) : 'default'
}

/**
 * Always returns a COMPLETE record, never a partial one.
 *
 * A hand-edited file missing a group, or one carrying a group from a future
 * version, must not reach `resolveReasoning` as a hole: `levels[group]` would be
 * `undefined`, and every call site would need its own fallback. Filling the gaps
 * here means the type is true at the only place that constructs the value.
 */
export function sanitizeReasoningLevels(value: unknown): Record<ChildGroup, GroupSetting> {
    return sanitizeGroupRecord(
        value,
        (v): v is GroupSetting => REASONING_SETTINGS.includes(v as GroupSetting),
        group => DEFAULT_REASONING_TABLE[group]
    )
}

/**
 * What one group is actually set to, given a config. The ONLY place the four
 * modes are interpreted.
 *
 * `cfg` is required rather than defaulted to `getConfig()` so this module stays
 * import-free (see the header). Callers that want the live config use
 * `groupThinkingArgs` from group-args.ts.
 */
export function resolveReasoning(group: ChildGroup, cfg: PiTaskConfig): GroupSetting {
    switch (cfg.reasoningMode) {
        case 'off':
            return 'off'
        case 'on':
            return REASONING_ON_LEVEL
        case 'custom':
            return cfg.reasoningLevels[group]
        default:
            return DEFAULT_REASONING_TABLE[group]
    }
}

/**
 * The WHOLE table, as this config will actually run it.
 *
 * The question the mismatch scan and the custom-mode seeder both ask. One
 * accessor, so they cannot each invent their own shape for it. The settings menu
 * asks the single-group question instead, through `resolveReasoning` — which is
 * the only place the four modes are interpreted.
 */
export function effectiveReasoning(cfg: PiTaskConfig): Record<ChildGroup, GroupSetting> {
    const out = {} as Record<ChildGroup, GroupSetting>
    for (const group of CHILD_GROUPS) out[group] = resolveReasoning(group, cfg)
    return out
}

/**
 * The argv fragment for a setting. `inherit` is the empty fragment — no flag at
 * all — which is what makes an all-`inherit` config byte-identical to the
 * version before this feature existed.
 */
export function thinkingArgs(setting: GroupSetting): string[] {
    return setting === 'inherit' ? [] : ['--thinking', setting]
}

/** One honest sentence per group, for the /task-config rows. */
export const REASONING_GROUP_HELP: Readonly<Record<ChildGroup, string>> = {
    research:
        'The pi-worker subagent tool, and the fallback for any research worker below '
        + 'whose own level is unset. Read-only exploration loops.',
    'research:files':
        'Research worker 1 of 4: maps which files the task will touch. Read-heavy. '
        + 'Measured: the two arms tie, so it runs without thinking.',
    'research:apis':
        'Research worker 2 of 4: the symbols and signatures the task must call. '
        + 'Read-heavy, docs- and search-capable.',
    'research:context':
        'Research worker 3 of 4: how the project is put together. One of the two that '
        + 'burned wall-clock on restarts in the last full run.',
    'research:tooling':
        'Research worker 4 of 4: the commands that build, test and run the project. '
        + 'Measured: thinking wins on both quality and speed.',
    phase:
        'Refining your request, generating and answering the clarifying questions, '
        + 'writing the spec, and critiquing it.',
    planning:
        "/task-auto's planners: splitting a design document into tasks and extracting "
        + 'its requirements. The most reasoning-hungry step measured so far.',
    plan: "/task-plan's interactive question-and-answer children.",
    gate: 'The checks that run after code is written: verify, enforce, lint-fix, autofix.',
    extraction:
        'The small no-tools children that pull one answer out of a fetched page or '
        + 'a docs chunk.',
    implementation:
        'The main session turn that actually writes the code. Changing this briefly '
        + "changes pi's own thinking level, and puts it back afterwards."
}

/**
 * One honest sentence per model row.
 *
 * They are NOT the reasoning help reworded. A model cell answers a different
 * question — which machine does this work — and one of them costs money every
 * turn rather than once per change, which is a thing the row has to say.
 */
export const MODEL_GROUP_HELP: Readonly<Record<ChildGroup, string>> = {
    research:
        'The pi-worker subagent tool, and the fallback for any research worker below. '
        + 'Long read-only loops: a cheap fast model pays off here.',
    'research:files': 'Research worker 1 of 4: maps which files the task will touch.',
    'research:apis': 'Research worker 2 of 4: the symbols and signatures the task must call.',
    'research:context': 'Research worker 3 of 4: how the project is put together.',
    'research:tooling': 'Research worker 4 of 4: the commands that build, test and run it.',
    phase:
        'Refining your request, generating and answering the clarifying questions, '
        + 'writing the spec, and critiquing it.',
    planning: "/task-auto's planners: splitting a design document into tasks.",
    plan: "/task-plan's interactive question-and-answer children.",
    gate: 'The checks that run after code is written: verify, enforce, lint-fix, autofix.',
    extraction: 'The small no-tools children that pull one answer out of a page or a docs chunk.',
    implementation:
        'The main session turn that writes the code — YOUR session, switched for the turn and '
        + 'switched back. Unlike every row above, this one is not free: a model switch re-bills '
        + 'the whole prompt as a cache miss, twice per task. Leave it on inherit unless you '
        + 'want a different model than the one you are reading this in.'
}
