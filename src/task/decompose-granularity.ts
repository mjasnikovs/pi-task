/**
 * decompose-granularity — the deterministic FLOOR on how finely /task-auto cuts
 * a feature into tasks.
 *
 * The failure this closes: the SAME design doc, from the SAME base commit, with a
 * byte-identical planning path, plans several times coarser or finer depending on
 * ONE line of clarify text. /task-auto's clarify head asks a plan-shape question
 * first ("one task per milestone, or split smaller?"), the answer-side triage
 * auto-resolves it and stamps it "already settled by the spec", so the user never
 * sees the fork — and that answer decides the whole plan.
 *
 * The spec does NOT settle it. A section titled "Build order (milestones)" is an
 * ORDER, not a task breakdown. So the plan's granularity, the single
 * highest-leverage decision in a run (each title is handed to its own pipeline
 * that researches and specs it alone), was being decided by a coin flip nobody
 * could see, review, or reproduce.
 *
 * Surfacing the question does not fix it: under YOLO/unattended `yoloPickAnswer`
 * takes the recommendation, which is the same stochastic line. The fix has to be
 * host-side and deterministic, so this module derives the floor from integers the
 * run already has — the count of grounded requirements that a task can OWN.
 *
 *   floor = ceil(ownable requirements / MAX_REQUIREMENTS_PER_TASK)
 *
 * MAX_REQUIREMENTS_PER_TASK = 2 sits deliberately between the two shapes: a plan
 * cut fine enough to work carries roughly one ownable requirement per task, and a
 * collapsed one bundles several. A ceiling of 2 rejects the collapse without
 * demanding the finest possible plan.
 *
 * Spec-shape-agnostic: the only inputs are two integers. A CLI, a library, a
 * refactor, a docs job all flow through the same arithmetic, and a feature with
 * no extracted requirements (a one-liner, a doc-less request) yields floor 0 —
 * the whole channel degrades to exactly the previous behaviour.
 */

/**
 * The most distinct grounded requirements one task may carry before the plan is
 * judged too coarse. See the module docstring for where the number comes from.
 */
export const MAX_REQUIREMENTS_PER_TASK = 2

/**
 * Fewest task titles a plan may have for `ownable` requirements. Zero when the
 * requirement channel produced nothing, which disables every check below.
 *
 * Also zero below MIN_REQUIREMENTS_FOR_PLAN_SHAPE, for the reason that constant
 * already documents: under a handful of requirements the plan is one or two tasks
 * either way, and the requirement COUNT at that scale is an artifact of extraction
 * granularity rather than real breadth. A one-line feature request — "add a
 * --version flag that prints the version and exits 0" — extracts three ownable
 * requirements (the flag, the print, the exit code) for what is unambiguously one
 * task, and an ungated floor would demand two. The same cut governs both checks
 * because it is the same judgement.
 *
 * Run: the floor is 0 for 0-4 ownable requirements, then ceil(n/2) — 5 gives 3,
 * 10 gives 5, 21 gives 11.
 */
export function granularityFloor(ownable: number): number {
    if (ownable < MIN_REQUIREMENTS_FOR_PLAN_SHAPE) return 0
    return Math.ceil(ownable / MAX_REQUIREMENTS_PER_TASK)
}

/** Is this plan too coarse for the requirements it has to carry? */
export function isTooCoarse(titles: number, floor: number): boolean {
    return floor > 0 && titles < floor
}

/**
 * Fewest ownable requirements a feature needs before the host takes the
 * plan-shape fork away from the triage.
 *
 * Below this the fork is not load-bearing — the whole plan is one or two tasks
 * either way — and seizing it does harm: live smoke over 24 prompts, the host
 * directive turned "rename the `foo()` helper across the repo" (1 requirement)
 * into a 6-task plan and "add a .editorconfig" (4) into 4. Every case at or above
 * this cut planned inside its expected range. So: a feature with real breadth
 * gets the deterministic answer, a chore keeps the old triage path untouched.
 */
export const MIN_REQUIREMENTS_FOR_PLAN_SHAPE = 5

/** Does this feature have enough distinct deliverables for granularity to matter? */
export function planShapeIsHostsToAnswer(ownable: number): boolean {
    return ownable >= MIN_REQUIREMENTS_FOR_PLAN_SHAPE
}

/**
 * Does this clarify question decide how finely the feature is CUT into tasks?
 *
 * Deterministic and narrow on purpose: it must fire on the fork the triage keeps
 * answering for itself and stay off ordinary scope questions, because an
 * over-eager classifier would replace a real user decision with the host's.
 * Matched against the plain-text question.
 *
 * BOTH halves must hold — a breakdown phrase AND a plan-unit noun — and the unit
 * list is SINGULAR except for tasks. Measured across the units it names:
 *   milestone / section / step / phase / task / tasks   fire
 *   milestones / sections / steps / phases              do NOT
 * So "one task per milestone, or split smaller?" fires, while the same fork
 * phrased "follow the milestones as-is, or split more granularly?" does not —
 * the breakdown half matches, the plural unit does not.
 */
export function isPlanShapeQuestion(question: string): boolean {
    const q = question.toLowerCase()
    // The fork has to be about the BREAKDOWN itself…
    const aboutBreakdown =
        /\b(task breakdown|break(ing)? (it|this|the \w+) down|decompos\w*|split\w*|subdivid\w*|granular\w*|fine[- ]grained|one task per|task per (milestone|section|step|phase|feature)|per[- ](milestone|route|component|page|module)\b|(own|separate|standalone|dedicated|self[- ]contained|single)\s+(\w+\s+)?tasks?\b)/.test(
            q
        )
    if (!aboutBreakdown) return false
    // …and offer a coarse/fine choice over the plan's own units.
    return /\b(milestone|section|step|phase|task|tasks)\b/.test(q)
}

/**
 * BELT — the host's own answer to that fork, recorded in the clarify transcript in
 * place of the triage's.
 *
 * WHY A CLARIFICATION AND NOT A DECOMPOSE RULE. The identical directive behaves
 * very differently depending on where it lands. As a RULES line REPLACING "prefer
 * a handful of substantial tasks", it removes the collapse but takes the
 * counterweight with it, and plan size runs away — far enough that a decompose
 * child can exhaust its context window and kill the planning phase outright. In
 * the CLARIFICATIONS block, with that counterweight left intact, the same words
 * land as one input among several. The channel is part of the lever, not a detail.
 *
 * Deliberately count-free: the spec-derived floor stays host-side, where it is
 * enforced silently and cannot be chased.
 */
export const PLAN_SHAPE_QUESTION = 'How finely should this feature be split into tasks?'
export const PLAN_SHAPE_ANSWER =
    'subdivide into smaller per-deliverable tasks — one task per route, page, screen,'
    + ' module, schema, or pipeline stage — rather than one task per milestone or spec'
    + ' section. A milestone or section that spans several deliverables becomes several'
    + ' tasks. (host-set: the spec fixes the build ORDER, not the task breakdown, so'
    + ' pi-task settles granularity deterministically instead of guessing per run)'

/**
 * BRACES — the reprompt when the returned plan lands under the floor. Also
 * countless, for the reason above: it asks for a SPLIT of the plan in hand rather
 * than a fresh roll (a regeneration is a new stochastic draw over the whole plan
 * and can drop an area the current one covers).
 */
export function granularitySplitHint(titles: number, ownable: number): string {
    return (
        `[SYSTEM NOTE: your plan of ${titles} task(s) is too coarse for the`
        + ` ${ownable} required contents this spec lists — several tasks each bundle work`
        + ' that belongs in separate ones. Emit the SAME plan with those tasks SPLIT: keep'
        + ' every task that is already one deliverable, and break each one that bundles'
        + ' several routes, pages, modules, or pipeline stages into one task per piece.'
        + ' Do not drop anything, do not merge, do not pad with trivia — split what is'
        + ' already there.]'
    )
}
