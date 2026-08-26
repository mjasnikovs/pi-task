/**
 * One-line startup hint shown when /task-config asks for a thinking level the
 * connected model will not honour.
 *
 * WHY IT HAS TO EXIST. pi never says it ignored or downgraded a level. Measured
 * live with a proxy on the request body: a model with `reasoning: false` given
 * `--thinking medium` sends no reasoning field at all, and a model whose
 * `thinkingLevelMap` nulls `off` given `--thinking off` is clamped UP to
 * `medium` — thinking stays on. Both are silent. A reasoning profile the user
 * set and the model erased is worse than no profile feature, because it looks
 * like it worked.
 *
 * ANTI-NAG. This warns once per session and clears on the first keystroke, and
 * that is the whole mechanism — deliberately no "already warned about model X"
 * file. Such a record goes stale the moment models.json is edited, and would
 * suppress the warning at exactly the moment a `/model` switch made it true.
 * brave-warning.ts nags every session for a standing misconfiguration and that
 * is correct; this is the same class. The real anti-nag is `inherit`: with the
 * shipped all-`inherit` table, `reasoningMismatches` returns empty for every
 * model and nothing renders at all.
 */

import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import {getConfig, type PiTaskConfig} from '../config/config.js'
import {REASONING_GROUPS, resolveReasoning} from '../config/reasoning.js'
import {reasoningMismatches, type ReasoningMismatch} from '../shared/reasoning-capability.js'
import {probeChatTemplateCaps} from '../shared/model-endpoint.js'

const WIDGET_KEY = 'pi-task-reasoning-warning'

/** Every group's current setting, in the shape `reasoningMismatches` wants. */
export type GroupSettings = Array<{
    group: (typeof REASONING_GROUPS)[number]
    setting: ReturnType<typeof resolveReasoning>
}>

/**
 * Read every group's effective setting from a config.
 *
 * Takes the config rather than calling `getConfig()` so the caller decides where
 * it comes from. A test that has to mutate the live singleton to drive this is a
 * test whose result depends on whatever the developer had saved before it ran.
 */
export function settingsFrom(cfg: PiTaskConfig): GroupSettings {
    return REASONING_GROUPS.map(group => ({group, setting: resolveReasoning(group, cfg)}))
}

/**
 * The warning line for a set of mismatches.
 *
 * Names the MODEL it checked, because children carry no `-m` and resolve pi's
 * default model, which need not be the host session's — a warning that does not
 * say what it looked at cannot be acted on. Names at most two groups; the count
 * carries the rest, since a line long enough to list seven is a line nobody
 * reads.
 */
export function formatReasoningWarning(
    modelName: string,
    mismatches: readonly ReasoningMismatch[]
): string | null {
    if (mismatches.length === 0) return null
    const shown = mismatches
        .slice(0, 2)
        .map(m => `${m.group} ${m.wanted}→${m.actual}`)
        .join(', ')
    const rest = mismatches.length > 2 ? ` (+${mismatches.length - 2} more)` : ''
    return (
        `⚠ pi-task: model "${modelName}" will not run the reasoning levels /task-config asks `
        + `for — ${shown}${rest}. pi clamps to what the model declares. Fix "reasoning" / `
        + '"thinkingLevelMap" for it in ~/.pi/agent/models.json, or set those steps back to '
        + '"inherit" in /task-config'
    )
}

/**
 * The extra cause line, when the SERVER disagrees with models.json.
 *
 * This is the `/login llama.cpp` case and the only thing the host-side clamp
 * cannot see: pi's built-in llama.cpp provider hardcodes `reasoning: false`, so
 * a perfectly capable server is described to pi as having no reasoning at all.
 * Returns null whenever the two agree, or when there was nothing to compare.
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
    readSettings: () => GroupSettings = () => settingsFrom(getConfig())
): void {
    pi.on('session_start', (_event, ctx) => {
        // Terminal-only hint: needs an interactive TUI to render and to catch the
        // keystroke that dismisses it.
        if (ctx.mode !== 'tui') return
        const model = ctx.model
        const mismatches = reasoningMismatches(model, readSettings())
        if (mismatches.length === 0) return
        const base = formatReasoningWarning(model?.name ?? model?.id ?? 'unknown', mismatches)
        if (base === null) return

        let unsubscribe: (() => void) | null = null
        let cleared = false
        const clear = (): void => {
            cleared = true
            try {
                ctx.ui.setWidget(WIDGET_KEY, undefined)
            } catch {
                /* stale ctx after a session switch — nothing to clear */
            }
            unsubscribe?.()
            unsubscribe = null
        }
        const render = (text: string): boolean => {
            try {
                ctx.ui.setWidget(WIDGET_KEY, [ctx.ui.theme.fg('warning', text)])
                return true
            } catch {
                return false
            }
        }

        if (!render(base)) return

        unsubscribe = ctx.ui.onTerminalInput(() => {
            clear()
            return undefined
        })

        // Fire-and-forget: the server probe only ever REFINES the cause line, so
        // it must not delay the warning or be able to prevent it. A 2s budget and
        // a swallowed failure mean a non-llama.cpp backend costs nothing.
        if (model?.baseUrl) {
            void probeChatTemplateCaps(model.baseUrl)
                .then(caps => {
                    if (cleared || caps === null) return
                    const extra = formatCapabilityConflict(
                        caps.supportsReasoningEffort,
                        model.reasoning
                    )
                    if (extra) render(base + extra)
                })
                .catch(() => {})
        }
    })
}
