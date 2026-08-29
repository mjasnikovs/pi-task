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
 * lives one hop away in `reasoning-args.ts` for exactly this reason: importing
 * it here would make config.ts ⇄ reasoning.ts a real cycle, and whichever module
 * a caller reached first would decide whether `DEFAULT_REASONING_TABLE` was
 * initialised before `DEFAULT_CONFIG` read it.
 */
import type {PiTaskConfig} from './config.js'

/**
 * The child roles that share one reasoning setting.
 *
 * Grouped by JOB, not by spawn mechanism — two children that both go through
 * `runWorker` (a research worker and a verify gate) want different amounts of
 * thinking, while two that reach the model by different code paths (`refine` via
 * runPhaseChild, `compress-label` via the same) want the same.
 *
 * - `research`     the ad-hoc `pi-worker` subagent tool, and the fallback the four
 *                  research workers use when their own cell is unset
 * - `research:files` / `research:apis` / `research:context` / `research:tooling`
 *                  one cell per research worker, so a level can be paid for in
 *                  one worker without paying for it in the other three
 * - `phase`        refine, verify-tooling, grill, compose, critique, compress-label
 * - `planning`     /task-auto's clarify / decompose / extract children
 * - `plan`         /task-plan's question and answer children
 * - `gate`         enforce, verify, lint-fix, final-fix, recommend
 * - `extraction`   the --no-tools focused docs/fetch extractors
 * - `implementation` the host-session turn that writes the code (not a child)
 */
export type ReasoningGroup =
    | 'research'
    | 'research:files'
    | 'research:apis'
    | 'research:context'
    | 'research:tooling'
    | 'phase'
    | 'planning'
    | 'plan'
    | 'gate'
    | 'extraction'
    | 'implementation'

export const REASONING_GROUPS: readonly ReasoningGroup[] = [
    'research',
    'research:files',
    'research:apis',
    'research:context',
    'research:tooling',
    'phase',
    'planning',
    'plan',
    'gate',
    'extraction',
    'implementation'
] as const

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
export const DEFAULT_REASONING_TABLE: Readonly<Record<ReasoningGroup, GroupSetting>> = {
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
 * Child NAME → reasoning group, for every child that goes through
 * `runPhaseChild` / `runPlanningChild`.
 *
 * WHY KEYED ON THE NAME
 * ---------------------
 * The name is the only identifier in scope at all three spawn paths (phases,
 * /task-auto planning, /task-plan), it is what the loader and the debug trail
 * already print, and it is the one thing a reader can check against the phase
 * list without following the call graph. Threading a group parameter through
 * `PhaseDeps` / `AutoDeps` instead would touch both orchestrators' dep bags to
 * express something the call site already says out loud.
 *
 * AN UNMAPPED NAME IS A BUILD FAILURE, not a silent `inherit`.
 * `reasoning-groups.test.ts` scans every literal child name under `src/task`
 * and fails if it is missing here. A defaulting lookup would let a phase added
 * later opt itself out of the table without anyone deciding to.
 *
 * The gate and extraction groups are NOT here: those children reach the model
 * through `groupThinkingArgs('gate' | 'extraction')` at call sites with no name
 * in scope (gate-deps.ts, fetch-core.ts, docs-core.ts, pi-worker-docs.ts). The
 * four research workers do have a name — their `spec.label` — so they are here.
 */
export const REASONING_GROUP_BY_CHILD: Readonly<Record<string, ReasoningGroup>> = {
    // ── phase: task/phases.ts + task/title-label.ts ──────────────────────────
    refine: 'phase',
    'verify-tooling': 'phase',
    'grill-auto': 'phase',
    'grill-gen': 'phase',
    compose: 'phase',
    critique: 'phase',
    'critique-triage': 'phase',
    'compress-label': 'phase',

    // ── planning: task/auto-orchestrator.ts ──────────────────────────────────
    'clarify-triage': 'planning',
    'auto-clarify': 'planning',
    'auto-decompose': 'planning',
    'requirement-extract': 'planning',
    'decompose-coverage': 'planning',
    'coverage-map': 'planning',
    'contract-extract': 'planning',
    'launch-extract': 'planning',

    // ── plan: task/plan-orchestrator.ts ──────────────────────────────────────
    'plan-question': 'plan',
    'plan-answer': 'plan',

    // ── research: task/phases.ts `workerSpecs`, keyed on the spec's LABEL ─────
    'worker:files': 'research:files',
    'worker:apis': 'research:apis',
    'worker:context': 'research:context',
    'worker:tooling': 'research:tooling'
}

/**
 * The group a named child belongs to.
 *
 * Returns `undefined` for a name the table does not know, and the CALLER decides
 * what that means. `runPhaseChild` treats it as `inherit` — a child that reaches
 * the model with today's argv is always safe — while the test treats it as a
 * failure. That split is deliberate: the guard belongs at build time, where
 * someone can fix it, not at run time, where it would abort a user's task over a
 * missing table row.
 */
export function reasoningGroupForChild(name: string): ReasoningGroup | undefined {
    return REASONING_GROUP_BY_CHILD[name]
}

/**
 * For a `research:*` group, the group a stored config falls back to when its own
 * key is missing. Every other group maps to `undefined`.
 */
const RESEARCH_SUBGROUP_PARENT: Readonly<Partial<Record<ReasoningGroup, ReasoningGroup>>> = {
    'research:files': 'research',
    'research:apis': 'research',
    'research:context': 'research',
    'research:tooling': 'research'
}

/**
 * Always returns a COMPLETE record, never a partial one.
 *
 * A hand-edited file missing a group, or one carrying a group from a future
 * version, must not reach `resolveReasoning` as a hole: `levels[group]` would be
 * `undefined`, and every call site would need its own fallback. Filling the gaps
 * here means the type is true at the only place that constructs the value.
 */
export function sanitizeReasoningLevels(value: unknown): Record<ReasoningGroup, GroupSetting> {
    const stored =
        typeof value === 'object' && value !== null && !Array.isArray(value) ?
            (value as Record<string, unknown>)
        :   {}
    const valid = (v: unknown): v is GroupSetting => REASONING_SETTINGS.includes(v as GroupSetting)
    const out = {} as Record<ReasoningGroup, GroupSetting>
    for (const group of REASONING_GROUPS) {
        const stored_ = stored[group]
        if (valid(stored_)) {
            out[group] = stored_
            continue
        }
        // A `research:*` key the stored config never had falls back to its
        // parent `research` value, so a config written before the split keeps
        // meaning what it meant.
        const parent = RESEARCH_SUBGROUP_PARENT[group]
        out[group] =
            parent && valid(stored[parent]) ? stored[parent] : DEFAULT_REASONING_TABLE[group]
    }
    return out
}

/**
 * What one group is actually set to, given a config. The ONLY place the four
 * modes are interpreted.
 *
 * `cfg` is required rather than defaulted to `getConfig()` so this module stays
 * import-free (see the header). Callers that want the live config use
 * `groupThinkingArgs` from reasoning-args.ts.
 */
export function resolveReasoning(group: ReasoningGroup, cfg: PiTaskConfig): GroupSetting {
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
 * The question the settings menu, the mismatch scan and the custom-mode seeder
 * all ask. One accessor, so they cannot each invent their own shape for it.
 * `resolveReasoning` stays for the single-group question, and is the only place
 * the four modes are interpreted.
 */
export function effectiveReasoning(cfg: PiTaskConfig): Record<ReasoningGroup, GroupSetting> {
    const out = {} as Record<ReasoningGroup, GroupSetting>
    for (const group of REASONING_GROUPS) out[group] = resolveReasoning(group, cfg)
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
export const REASONING_GROUP_HELP: Readonly<Record<ReasoningGroup, string>> = {
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
