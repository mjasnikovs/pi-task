/**
 * decompose-granularity — the deterministic FLOOR on how finely /task-auto cuts
 * a feature into tasks.
 *
 * The failure this closes (mx5, Jul 25 vs Jul 27): the SAME design doc, from the
 * SAME base commit, with a byte-identical planning path, planned once into 41
 * tasks and once into 11. The whole 4x difference is one line of clarify text.
 * /task-auto's clarify head asks a plan-shape question first ("one task per
 * milestone, or split smaller?" — 8/8 live reps), the answer-side triage
 * auto-resolves it 8/8 and stamps it "already settled by the spec", so the user
 * never sees the fork; and the answer decides the whole plan. Live A/B, run 18's
 * transcript with ONLY that line swapped (n=8/arm): coarse mean 11.4 titles vs
 * fine mean 28.6, 63.5/64 pairwise wins, p<0.001.
 *
 * The spec does NOT settle it. mx5's §12 is titled "Build order (milestones)" —
 * an ORDER, 9 items, not a task breakdown. So the plan's granularity, the single
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
 * MAX_REQUIREMENTS_PER_TASK = 2 is anchored on the two real mx5 plans, not on
 * taste: the 41-task plan carried 0.8 ownable requirements per task, the collapsed
 * 11-task plan carried 2.8. A ceiling of 2 sits between them — it rejects the
 * collapse without demanding the finest plan ever observed.
 *
 * Spec-shape-agnostic: the only inputs are two integers. A CLI, a library, a
 * refactor, a docs job all flow through the same arithmetic, and a feature with
 * no extracted requirements (a one-liner, a doc-less request) yields floor 0 —
 * the whole channel degrades to exactly the previous behaviour.
 */

/**
 * The most distinct grounded requirements one task may carry before the plan is
 * judged too coarse. See the module docstring for the mx5 anchoring.
 */
export const MAX_REQUIREMENTS_PER_TASK = 2

/**
 * Fewest task titles a plan may have for `ownable` requirements. Zero when the
 * requirement channel produced nothing, which disables every check below.
 */
export function granularityFloor(ownable: number): number {
    return ownable <= 0 ? 0 : Math.ceil(ownable / MAX_REQUIREMENTS_PER_TASK)
}

/** Is this plan too coarse for the requirements it has to carry? */
export function isTooCoarse(titles: number, floor: number): boolean {
    return floor > 0 && titles < floor
}

/**
 * Does this clarify question decide how finely the feature is CUT into tasks?
 *
 * Deterministic and narrow on purpose. It must fire on the fork the triage keeps
 * answering for itself ("follow the milestones as-is, or split more granularly?")
 * and stay off ordinary scope questions — an over-eager classifier would replace
 * a real user decision with the host's. Matched against the plain-text question.
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
 * WHY A CLARIFICATION AND NOT A DECOMPOSE RULE. Both were measured live. As a
 * RULES line replacing "prefer a handful of substantial tasks", the same directive
 * removed the collapse but destroyed plan-size control: 66, then 81 and 85 titles
 * for a spec whose healthy plan is ~30, plus one decompose child that blew the
 * model's 120k context window and killed the planning phase (the baseline produced
 * no such failure in 27 reps). Naming a target count made it worse, not better.
 * In the CLARIFICATIONS block, with the "prefer a handful" counterweight left
 * intact, the identical directive held 20–39 titles across 16 reps. The channel is
 * part of the lever, not a detail.
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
 * and can drop an area the current one covers — mx5 run 12).
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
