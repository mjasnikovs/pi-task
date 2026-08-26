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
 * `reasoning-groups.test.ts` scans every literal child name in src/ and fails if
 * it is missing here. A defaulting lookup would let a phase added next year opt
 * itself out of a measured setting without anyone deciding to — which is exactly
 * how `/no_think` ended up applied to eight prompts and read by none of them.
 *
 * The gate, research and extraction groups are NOT here: those children reach the
 * model through `runWorker` / `focusedChildArgs`, where the group is a property
 * of the call site rather than of a name, and is passed directly.
 */
import type {ReasoningGroup} from '../config/reasoning.js'

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
    'plan-answer': 'plan'
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
