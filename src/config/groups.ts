/**
 * The child roster — which children exist, and which of them share one setting.
 *
 * Split out of reasoning.ts because the roster is not about reasoning. Two
 * tables are keyed on it now (thinking level, and model), and a third would be
 * no more surprising. A roster named after one of its consumers reads as though
 * adding a second consumer were a special case.
 *
 * PURE MODULE, for the same reason reasoning.ts is: config.ts imports both
 * during its own module evaluation, so neither may take an import with a runtime
 * side effect.
 *
 * Grouped by JOB, not by spawn mechanism — two children that both go through
 * `runWorker` (a research worker and a verify gate) want different amounts of
 * thinking, while `refine` in phases.ts and `compress-label` in title-label.ts
 * want the same amount and share the `phase` cell.
 *
 * - `research`     the ad-hoc `pi-worker` subagent tool, and the fallback the four
 *                  research workers use when their own cell is unset
 * - `research:files` / `research:apis` / `research:context` / `research:tooling`
 *                  one cell per research worker, so a level can be paid for in
 *                  one worker without paying for it in the other three
 * - `phase`        refine, verify-tooling, grill, compose, critique, compress-label
 * - `planning`     /task-auto's planning children — clarify, decompose, and the
 *                  extract/coverage passes around them
 * - `plan`         /task-plan's question and answer children
 * - `gate`         enforce, verify, lint-fix, final-fix, recommend
 * - `extraction`   the --no-tools focused docs/fetch extractors
 * - `implementation` the host-session turn that writes the code (not a child)
 */
export type ChildGroup =
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

export const CHILD_GROUPS: readonly ChildGroup[] = [
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
 * Which group each NAMED child belongs to.
 *
 * The name is the one `runChild` is called with, so this is exhaustive over the
 * children that carry one. `config/groups.test.ts` scans the source for those
 * call sites and fails if a name is missing here. A defaulting lookup would let a
 * phase added later opt itself out of the tables without anyone deciding to.
 *
 * The gate and extraction groups are NOT here: those children reach the model
 * through `groupChildArgs('gate' | 'extraction')` at call sites with no name in
 * scope (gate-deps.ts, fetch-core.ts, docs-core.ts, pi-worker-docs.ts). The four
 * research workers do have a name — their `spec.label` — so they are here.
 */
export const GROUP_BY_CHILD: Readonly<Record<string, ChildGroup>> = {
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
export function groupForChild(name: string): ChildGroup | undefined {
    return GROUP_BY_CHILD[name]
}

/**
 * For a `research:*` group, the group a stored config falls back to when its own
 * key is missing. Every other group maps to `undefined`.
 */
export const RESEARCH_SUBGROUP_PARENT: Readonly<Partial<Record<ChildGroup, ChildGroup>>> = {
    'research:files': 'research',
    'research:apis': 'research',
    'research:context': 'research',
    'research:tooling': 'research'
}

/**
 * Always returns a COMPLETE record, never a partial one, for any per-group table.
 *
 * A hand-edited file missing a group, or one carrying a group from a future
 * version, must not reach a resolver as a hole: `table[group]` would be
 * `undefined`, and every call site would need its own fallback. Filling the gaps
 * here means the type is true at the only place that constructs the value.
 *
 * `fallbackFor` is a function of the GROUP, not a value. The reasoning table
 * falls back per group to its measured default; the model table falls back to
 * the constant `inherit`. A scalar parameter cannot express the first, which is
 * the one that already ships.
 */
export function sanitizeGroupRecord<T>(
    value: unknown,
    valid: (v: unknown) => v is T,
    fallbackFor: (group: ChildGroup) => T
): Record<ChildGroup, T> {
    const stored =
        typeof value === 'object' && value !== null && !Array.isArray(value) ?
            (value as Record<string, unknown>)
        :   {}
    const out = {} as Record<ChildGroup, T>
    for (const group of CHILD_GROUPS) {
        const own = stored[group]
        if (valid(own)) {
            out[group] = own
            continue
        }
        // A `research:*` key the stored config never had falls back to its
        // parent `research` value, so a config written before the split keeps
        // meaning what it meant.
        const parent = RESEARCH_SUBGROUP_PARENT[group]
        const inherited = parent === undefined ? undefined : stored[parent]
        out[group] = valid(inherited) ? inherited : fallbackFor(group)
    }
    return out
}
