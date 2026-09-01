/**
 * One-line startup hint shown when /task-config asks for a thinking level the
 * connected model will not honour.
 *
 * WHY IT HAS TO EXIST. pi silently rewrites the level and says nothing. Its own
 * `clampThinkingLevel` (pi-ai models.js) shows both halves: a model with
 * `reasoning: false` supports only `["off"]`, so every requested level collapses
 * there; and a level the model's `thinkingLevelMap` nulls is filtered out, after
 * which the clamp scans UPWARD before downward — so asking for `off` on a model
 * that nulls `off` gets the next level that IS available, and thinking stays on.
 * A reasoning profile the user set and the model erased is worse than no profile
 * feature, because it looks like it worked.
 *
 * ANTI-NAG. This warns once per session and clears on the first keystroke, and
 * that is the whole mechanism — deliberately no "already warned about model X"
 * file. Such a record goes stale the moment models.json is edited, and would
 * suppress the warning at exactly the moment a `/model` switch made it true.
 * brave-warning.ts nags every session for a standing misconfiguration and that is
 * correct; this is the same class. Setting a group back to `inherit` is what
 * silences it: an all-`inherit` table yields no mismatches for any model.
 */

import type {ExtensionAPI, ExtensionContext} from '@earendil-works/pi-coding-agent'
import {getConfig} from '../config/config.js'
import {effectiveReasoning, type GroupSetting, type ChildGroup} from '../config/reasoning.js'
import {
    reasoningMismatches,
    type GroupModelFacts,
    type ReasoningMismatch
} from '../shared/reasoning-capability.js'
import {MODEL_INHERIT, splitSpec} from '../config/group-models.js'
import {probeChatTemplateCaps, type ChatTemplateCaps} from '../shared/model-endpoint.js'
import {registerSessionHint} from './session-hint.js'

const WIDGET_KEY = 'pi-task-reasoning-warning'

/**
 * The warning line for a set of mismatches.
 *
 * Each item names its OWN model — `phase@acme/small medium→off` — because groups
 * can now run on different ones. A single leading `model "X" will not run …`
 * would be a lie about what was checked the moment two groups differ, and a
 * warning that misdescribes its own subject cannot be acted on.
 *
 * Names at most two groups and appends `(+N more)` only when there are more than
 * two, since a line long enough to list every group is a line nobody reads. Null
 * when nothing mismatched.
 */
export function formatReasoningWarning(mismatches: readonly ReasoningMismatch[]): string | null {
    if (mismatches.length === 0) return null
    const shown = mismatches
        .slice(0, 2)
        .map(m => `${m.group}@${m.modelName} ${m.wanted}→${m.actual}`)
        .join(', ')
    const rest = mismatches.length > 2 ? ` (+${mismatches.length - 2} more)` : ''
    return (
        '⚠ pi-task: some steps will not run the reasoning levels /task-config asks '
        + `for — ${shown}${rest}. pi clamps to what the model declares. Fix "reasoning" / `
        + '"thinkingLevelMap" for it in ~/.pi/agent/models.json, or set those steps back to '
        + '"inherit" in /task-config'
    )
}

/**
 * The extra cause line, when the SERVER disagrees with models.json.
 *
 * This is the `/login llama.cpp` case and the only thing the host-side clamp
 * cannot see: pi ships llama.cpp as a built-in extension whose provider entry
 * hardcodes `reasoning: false`, so a perfectly capable server is described to pi
 * as having no reasoning at all. Returns null whenever the two agree, and null
 * when the probe answered nothing, so an unreachable server adds no cause line.
 */
export function formatCapabilityConflict(
    serverSupportsEffort: boolean | null,
    modelDeclaresReasoning: boolean
): string | null {
    if (serverSupportsEffort === null) return null
    if (serverSupportsEffort && !modelDeclaresReasoning) {
        return (
            " — the server's chat template DOES support reasoning; it is the model entry pi is "
            + 'using that says reasoning:false. `/login llama.cpp` hardcodes that, so a '
            + 'hand-written models.json provider entry is the fix'
        )
    }
    if (!serverSupportsEffort && modelDeclaresReasoning) {
        return " — the server's chat template does not read reasoning_effort, so only on/off takes effect"
    }
    return null
}

export function registerReasoningWarning(
    pi: ExtensionAPI,
    /**
     * Where the group settings come from. Defaults to the live config, read at
     * `session_start` so a /task-config change since the last session counts.
     * Injected by tests, which must not depend on the developer's saved config.
     */
    readSettings: () => Readonly<Record<ChildGroup, GroupSetting>> = () =>
        effectiveReasoning(getConfig()),
    /**
     * The server-side chat-template probe. Injected so the REFINE path — the
     * only half of this hint that talks to a network — is drivable at all; with
     * the real probe it is reachable only from a model entry carrying a
     * `baseUrl`, which no test model has.
     */
    probe: (baseUrl: string) => Promise<ChatTemplateCaps | null> = probeChatTemplateCaps,
    /**
     * Which model each group runs on. Injected for the same reason `readSettings`
     * is: a test must not depend on the developer's saved config.
     */
    readSpecs: () => Readonly<Record<ChildGroup, string>> = () => getConfig().groupModels
): void {
    registerSessionHint(pi, WIDGET_KEY, ctx => {
        const facts = (g: ChildGroup): GroupModelFacts | undefined =>
            groupModelFacts(ctx, readSpecs()[g])
        const mismatches = reasoningMismatches(facts, readSettings())
        const base = formatReasoningWarning(mismatches)
        if (base === null) return null

        // Fire-and-forget: the server probe only ever REFINES the cause line, so it
        // must not delay the warning or be able to prevent it. `probeChatTemplateCaps`
        // carries its own short timeout and returns null on any failure, so a
        // backend that does not answer `/props` costs nothing.
        //
        // One probe per DISTINCT baseUrl among the mismatching groups, not one
        // per group: eleven groups usually collapse to one or two servers, and
        // four research workers on one server would otherwise print the same
        // sentence four times. `allSettled`, so one dead endpoint cannot blank
        // the line for the others.
        const probes = distinctBackends(mismatches, facts)
        if (probes.length === 0) return {text: base}
        return {
            text: base,
            refine: Promise.allSettled(
                probes.map(async b => {
                    const caps = await probe(b.baseUrl)
                    return caps === null ? null : (
                            formatCapabilityConflict(caps.supportsReasoningEffort, b.declares)
                        )
                })
            ).then(results => {
                const causes = new Set(
                    results.flatMap(r =>
                        r.status === 'fulfilled' && r.value !== null ? [r.value] : []
                    )
                )
                return causes.size === 0 ? null : base + [...causes].join('')
            })
        }
    })
}

/** What one group runs on, as {@link reasoningMismatches} wants it. */
function groupModelFacts(ctx: ExtensionContext, spec: string): GroupModelFacts | undefined {
    // `inherit` is the session's model. That is decision 3 of the model table —
    // children are NOT switched to follow the host — and the honest value is
    // settings.json's default, which need not be the session's. Naming the
    // session's model is still the better of the two: it is the one the user can
    // see, and on every machine with one provider the two agree.
    const model =
        spec === MODEL_INHERIT ?
            ctx.model
        :   (() => {
                const parts = splitSpec(spec)
                return parts ? ctx.modelRegistry.find(parts.provider, parts.id) : undefined
            })()
    if (!model) return undefined
    return {
        name: model.name || model.id,
        reasoning: model.reasoning,
        ...(model.thinkingLevelMap === undefined ? {} : {thinkingLevelMap: model.thinkingLevelMap}),
        ...(model.baseUrl ? {baseUrl: model.baseUrl} : {})
    }
}

/** The distinct servers behind a set of mismatches, deduped by URL. */
function distinctBackends(
    mismatches: readonly ReasoningMismatch[],
    facts: (group: ChildGroup) => GroupModelFacts | undefined
): Array<{baseUrl: string; declares: boolean}> {
    const byUrl = new Map<string, {baseUrl: string; declares: boolean}>()
    for (const m of mismatches) {
        const f = facts(m.group)
        if (!f?.baseUrl) continue
        if (!byUrl.has(f.baseUrl)) byUrl.set(f.baseUrl, {baseUrl: f.baseUrl, declares: f.reasoning})
    }
    return [...byUrl.values()]
}
