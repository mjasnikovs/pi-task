/**
 * Which model each child group runs on — the second table keyed on ChildGroup.
 *
 * PURE MODULE, like reasoning.ts and groups.ts: config.ts imports this during
 * its own evaluation, so nothing here may have a runtime side effect.
 *
 * WHY THERE IS NO MODE ENUM
 * -------------------------
 * reasoningMode has four modes because there is a measured, shipped table worth
 * a one-word "use the project's numbers", plus meaningful global on/off. Neither
 * exists here. A model id is machine-local, so there can be no shipped table,
 * and "all models on" is not a sentence. A mode enum would be four states of
 * which three are unreachable.
 *
 * WHY THE CELL IS A STRING AND NOT A STRUCT
 * -----------------------------------------
 * `provider/id` is exactly what pi's `--model` takes, so the stored value goes
 * to argv untouched. The round-trip property in config-items.test.ts needs the
 * stored value recoverable verbatim from the offered label; a struct forces a
 * format/parse pair that can drift.
 */
import {sanitizeGroupRecord, type ChildGroup} from './groups.js'

/**
 * The cell value meaning "emit no `--model`". Identical in spirit to `inherit`
 * in the reasoning table, and identical in effect: an all-`inherit` table makes
 * every child's argv byte-identical to a build without this feature.
 *
 * It is not a legal `provider/id` — pi rejects an unslashed pattern that matches
 * no model — so it cannot collide with a real spec.
 */
export const MODEL_INHERIT = 'inherit'

/** Every cell on `inherit`. The shipped default, and deliberately not a table. */
export const DEFAULT_GROUP_MODELS: Readonly<Record<ChildGroup, string>> = {
    research: MODEL_INHERIT,
    'research:files': MODEL_INHERIT,
    'research:apis': MODEL_INHERIT,
    'research:context': MODEL_INHERIT,
    'research:tooling': MODEL_INHERIT,
    phase: MODEL_INHERIT,
    planning: MODEL_INHERIT,
    plan: MODEL_INHERIT,
    gate: MODEL_INHERIT,
    extraction: MODEL_INHERIT,
    implementation: MODEL_INHERIT
}

/**
 * SHAPE ONLY, never existence.
 *
 * A config written on machine A must survive a session on machine B whose
 * provider extension failed to load, or whose models.json is a different file
 * entirely. Erasing a spec because this machine cannot resolve it would punish
 * the two-machine user and lose a setting they never changed. Whether a spec
 * resolves is asked once per session, where a warning can name it — not here,
 * where the only available answer is deletion.
 *
 * So this rejects exactly what could RESHAPE argv, and nothing else:
 *  - a non-string, which cannot be an argv token at all
 *  - empty or whitespace-only, which pi would read as a missing value and
 *    consume the following flag as the model pattern
 *  - a leading `-`, which pi's flat parser reads as the next FLAG
 *  - embedded whitespace, which is one token here and two on a shell round-trip
 */
export function isModelSpec(value: unknown): value is string {
    if (typeof value !== 'string') return false
    if (value.trim() !== value || value.length === 0) return false
    if (value.startsWith('-')) return false
    return !/\s/.test(value)
}

export function sanitizeGroupModels(value: unknown): Record<ChildGroup, string> {
    return sanitizeGroupRecord(value, isModelSpec, () => MODEL_INHERIT)
}

/**
 * The `['--model', spec]` fragment for a resolved cell, or `[]` for `inherit`.
 *
 * NEVER `--provider`. Adding it is what turns pi's loud "model not found, exit
 * 1" into `buildFallbackModel`'s silent synthetic model at exit 0 — the branch
 * is `if (provider)` in pi's model-resolver, and a canonical `provider/id`
 * reaches it through inference only when that provider already has a model the
 * child can see. One flag keeps the loud failure loud.
 *
 * No `:thinking` suffix either. We emit an explicit `--thinking`, which pi
 * prefers over the suffix, so a suffix would be a second dead source of truth
 * for the same dial.
 */
export function modelArgs(spec: string): string[] {
    return spec === MODEL_INHERIT ? [] : ['--model', spec]
}

/**
 * The spec a built argv fragment actually carries, or `undefined` for a child
 * that will resolve pi's saved default.
 *
 * Read BACK OUT of the argv rather than threaded alongside it, deliberately. The
 * argv is what the child runs; a second field carrying "the model we meant"
 * could disagree with it after any future edit, and the one consumer — the
 * dead-backend probe — must ask about the endpoint the child will really use.
 */
export function modelSpecFromArgs(args: readonly string[]): string | undefined {
    const i = args.indexOf('--model')
    return i === -1 ? undefined : args[i + 1]
}

/**
 * Split a stored spec on its FIRST slash.
 *
 * `openrouter/z-ai/glm-4.6` is provider `openrouter` and id `z-ai/glm-4.6`:
 * OpenRouter-style ids contain slashes of their own, and splitting on the last
 * one would invent the provider `openrouter/z-ai`. Returns `undefined` for a
 * spec with no slash, which `inherit` is and a canonical spec never is.
 */
export function splitSpec(spec: string): {provider: string; id: string} | undefined {
    const i = spec.indexOf('/')
    if (i <= 0 || i === spec.length - 1) return undefined
    return {provider: spec.slice(0, i), id: spec.slice(i + 1)}
}
