/**
 * The live-config bridge for per-group child settings: group in, argv fragment out.
 *
 * Separate from reasoning.ts and group-models.ts because those must take no
 * import with a runtime side effect — see their headers. The `getConfig()` read
 * lives here instead: this file imports them and nothing in config/ imports it
 * back, so the graph stays a tree.
 *
 * Read PER CALL, never cached at module scope, so a /task-config change lands on
 * the next child without a restart. Same contract `childBaseArgs` keeps.
 */
import {getConfig, type PiTaskConfig} from './config.js'
import {MODEL_INHERIT, modelArgs} from './group-models.js'
import {resolveReasoning, thinkingArgs} from './reasoning.js'
import type {ChildGroup} from './groups.js'

/**
 * Specs this session has proven a child cannot resolve.
 *
 * WHY A SESSION-SCOPED SET AND NOT A LOOKUP
 * -----------------------------------------
 * The honest question is "can a `--no-extensions` child resolve this spec?", and
 * only `ctx.modelRegistry` can answer it. Five of the six argv producers have no
 * `ctx` — `pi-worker`, `pi-worker-docs`, `docs-core`, `fetch-core` and
 * `child-runner` — so the answer cannot be fetched where it is needed. It also
 * cannot be read from disk: models.json and models-store.json are only part of
 * the catalogue, since pi-ai ships built-in model lists for 39 providers, and
 * this project does not depend on pi-ai.
 *
 * So it is answered ONCE, at session_start, where ctx exists and every task is
 * still in the future, and the verdict is left here.
 *
 * EMPTY MEANS EMIT. A host that never fires session_start therefore behaves
 * exactly as it does today — the failure direction is "pi decides", never "we
 * silently dropped a flag nobody checked".
 */
let unusableSpecs: ReadonlySet<string> = new Set()

export function setUnusableSpecs(specs: Iterable<string>): void {
    unusableSpecs = new Set(specs)
}

export function isSpecUsable(spec: string): boolean {
    return !unusableSpecs.has(spec)
}

/**
 * The context window of each group's model, resolved in the SAME session pass
 * that filled {@link setUnusableSpecs}.
 *
 * It lives here for the same reason that set does — `child-runner` and the
 * workers have no `ctx`, so they cannot ask a registry — and it is filled by the
 * same walk, so the two can never disagree about which model a group runs on.
 *
 * The number drives `StallDetector`'s churn rule, where the two error directions
 * are NOT symmetric: too large fires late (degraded, and the no-new-ground rule
 * still covers it), too small fires early and KILLS A HEALTHY CHILD. So an
 * absent answer means "use the parent's", never a guess.
 */
let groupWindows: Readonly<Partial<Record<ChildGroup, number>>> = {}

export function setGroupWindows(windows: Readonly<Partial<Record<ChildGroup, number>>>): void {
    groupWindows = {...windows}
}

/** The group's own window, or `undefined` for "caller keeps its fallback". */
export function groupWindow(group: ChildGroup): number | undefined {
    const w = groupWindows[group]
    return w !== undefined && w > 0 ? w : undefined
}

/**
 * The `['--model', spec]` fragment for a group, or `[]` for `inherit` and for a
 * spec this session proved unresolvable.
 *
 * Dropping the flag is not the same failure class as passing it. A spec naming a
 * model that is gone, whose PROVIDER still has other models, does not make pi
 * exit — `buildFallbackModel` invents a synthetic model id, forces
 * `reasoning: true` onto it, inherits the provider's default baseUrl and answers
 * at exit 0. Dropping the flag runs the same child the user got last week and
 * says so out loud; passing it runs a model nobody chose and says nothing.
 */
export function groupModelArgs(group: ChildGroup, cfg?: PiTaskConfig): string[] {
    const spec = (cfg ?? getConfig()).groupModels[group]
    if (spec === undefined || spec === MODEL_INHERIT) return []
    return isSpecUsable(spec) ? modelArgs(spec) : []
}

/**
 * The `['--thinking', level]` fragment for a group, or `[]` when the group is
 * `inherit` and the child should keep falling back to settings.json.
 *
 * Still exported on its own: the host-session turn (implementation-hold.ts) and
 * the settings UI (register.ts) need the level rather than a whole fragment.
 */
export function groupThinkingArgs(group: ChildGroup, cfg?: PiTaskConfig): string[] {
    // The default is evaluated HERE, per call. Hoisting the read to module scope
    // would leave every test green, so the optional parameter is what makes the
    // per-call contract assertable.
    return thinkingArgs(resolveReasoning(group, cfg ?? getConfig()))
}

/**
 * Everything one group contributes to a child's argv, in one fragment.
 *
 * Every argv builder calls THIS rather than composing the two halves itself.
 * That is why there is one carried field (`groupArgs`) rather than a `model`
 * beside a `thinking`: a second required field would double the obligation on
 * every future wiring, and a fragment assembled by hand is a doubled
 * `--thinking` waiting to happen.
 *
 * ORDER: `--model` then `--thinking`. pi's parser is a flat loop, so it does not
 * care. A human diffing two runs does — the identity of the child first, then
 * the dial on it.
 */
export function groupChildArgs(group: ChildGroup, cfg?: PiTaskConfig): string[] {
    const live = cfg ?? getConfig()
    return [...groupModelArgs(group, live), ...groupThinkingArgs(group, live)]
}
