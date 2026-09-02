/**
 * The one seam between a stored `provider/id` spec and pi's live model registry.
 *
 * Every question of the form "which pi Model does X run on" comes through here:
 * the session hints, the context-window table, the settings panel's catalogue
 * and the implementation hold. They used to each carry their own split-then-
 * `find`, and each re-decided what `inherit` means. One of them getting it
 * wrong is a warning naming the wrong model or a hold restoring the wrong one.
 *
 * `ctx` is the STRUCTURAL minimum, not one of pi's context interfaces: a tool
 * context, a command context and a test literal all satisfy it. `ctx.model` and
 * `ctx.modelRegistry` are GETTERS on the real thing that call `assertActive()`
 * and throw on a stale context, so every reader here answers `undefined`
 * instead of throwing — a session hint must not take the session down.
 */
import type {ExtensionContext} from '@earendil-works/pi-coding-agent'
import {MODEL_INHERIT, splitSpec} from '../config/group-models.js'
import {CHILD_GROUPS, type ChildGroup} from '../config/groups.js'

/**
 * pi's own `Model`, named without importing `@earendil-works/pi-ai` — which is
 * neither a dependency, a devDependency nor a peerDependency of this package.
 * The context already carries the type, so deriving it adds no edge to the graph.
 */
export type PiModel = NonNullable<ExtensionContext['model']>

/** The two registry questions this asks. `getAvailable` only feeds the endpoint map. */
export interface ModelRegistryView {
    find(provider: string, id: string): PiModel | undefined
    getRegisteredProviderIds?(): readonly string[]
    getAvailable?(): readonly PiModel[]
}

export interface ModelContext {
    model?: PiModel
    modelRegistry?: ModelRegistryView
}

/** A spec, resolved. Structurally a `GroupModelFacts`, so it feeds the reasoning check as-is. */
export interface ResolvedModel {
    /** Canonical `provider/id` — for `inherit`, the session model's own. */
    spec: string
    name: string
    reasoning: boolean
    thinkingLevelMap?: PiModel['thinkingLevelMap']
    /** Absent when the model declares none; a probe cannot be aimed at it. */
    baseUrl?: string
    /** 0 when the model declares none, so `||` falls through to the parent's. */
    contextWindow: number
    /**
     * Its provider was registered by a host extension. Children run
     * `--no-extensions`, so the model works in a child exactly when that
     * extension is in the child whitelist — a warning, never a drop.
     */
    fromExtension: boolean
    handle: PiModel
}

/** The `provider/id` inverse of {@link splitSpec}. */
export function specOf(model: {provider: string; id: string}): string {
    return `${model.provider}/${model.id}`
}

/**
 * `inherit` is the session's model. That is decision 3 of the model table —
 * children are NOT switched to follow the host — and the honest value is
 * settings.json's default, which need not be the session's. Naming the
 * session's model is still the better of the two: it is the one the user can
 * see, and on every machine with one provider the two agree.
 *
 * `find` is EXACT, deliberately stricter than pi's own CLI, which also
 * substring-matches. We store a canonical `provider/id`, so exact is the only
 * match that should ever count.
 */
export function resolveModel(ctx: ModelContext, spec: string): ResolvedModel | undefined {
    try {
        const parts = spec === MODEL_INHERIT ? undefined : splitSpec(spec)
        const handle =
            spec === MODEL_INHERIT ?
                ctx.model
            :   parts && ctx.modelRegistry?.find(parts.provider, parts.id)
        if (!handle) return undefined
        const provider = parts?.provider ?? handle.provider
        const extensionProviders = ctx.modelRegistry?.getRegisteredProviderIds?.() ?? []
        return {
            spec: parts ? spec : specOf(handle),
            name: handle.name || handle.id,
            reasoning: handle.reasoning,
            ...(handle.thinkingLevelMap === undefined ?
                {}
            :   {thinkingLevelMap: handle.thinkingLevelMap}),
            ...(handle.baseUrl ? {baseUrl: handle.baseUrl} : {}),
            contextWindow: handle.contextWindow ?? 0,
            fromExtension: extensionProviders.includes(provider),
            handle
        }
    } catch {
        return undefined
    }
}

/**
 * One group's cell, as the code with no `ctx` needs it (see config/group-args.ts).
 *
 * `unresolved` — no such model here, so the `--model` flag is dropped.
 * `extension` — see {@link ResolvedModel.fromExtension}; a warning, not a drop.
 */
export interface GroupModelSnapshot {
    spec: string
    /** false ⇒ emit no `--model` for this group. Only `unresolved` clears it. */
    usable: boolean
    /** Absent for `inherit` and for an unresolved spec: the caller keeps its live parent value. */
    contextWindow?: number
    problem?: 'unresolved' | 'extension'
}

/**
 * Every group's cell in ONE registry walk, so the argv drop, the churn window
 * and the hint can never disagree about which model a group runs on.
 *
 * An `inherit` cell gets NO window. Storing the parent's would freeze a
 * session_start snapshot in front of the live per-run value: a user who
 * switches the session model with Ctrl+P to a bigger one would have every
 * child judged against the old window, and the churn rule then fires early and
 * kills a healthy child. An unresolved cell gets none for the same reason —
 * such a child runs on the live default, whichever that is by then.
 *
 * A registry that cannot answer condemns NOTHING: every cell stays usable and
 * carries no window. Claiming every spec unresolved would drop every `--model`
 * on a session whose runtime merely was not ready.
 */
export function resolveGroupModels(
    ctx: ModelContext,
    specs: Readonly<Record<ChildGroup, string>>
): Record<ChildGroup, GroupModelSnapshot> {
    const registry = readRegistry(ctx)
    const cell = (spec: string): GroupModelSnapshot => {
        if (spec === MODEL_INHERIT || registry === undefined) return {spec, usable: true}
        const found = resolveModel({modelRegistry: registry}, spec)
        if (!found) return {spec, usable: false, problem: 'unresolved'}
        return {
            spec,
            usable: true,
            ...(found.contextWindow > 0 ? {contextWindow: found.contextWindow} : {}),
            ...(found.fromExtension ? {problem: 'extension'} : {})
        }
    }
    return Object.fromEntries(CHILD_GROUPS.map(g => [g, cell(specs[g])])) as Record<
        ChildGroup,
        GroupModelSnapshot
    >
}

/**
 * `spec → baseUrl` for every model this session can use, for the dead-backend
 * probe (shared/model-endpoint.ts). Empty when the registry cannot answer,
 * which the probe reads as "cannot see, so never kill".
 */
export function resolveModelEndpoints(ctx: ModelContext): Map<string, string> {
    const out = new Map<string, string>()
    for (const m of readRegistry(ctx)?.getAvailable?.() ?? []) {
        if (m.baseUrl) out.set(specOf(m), m.baseUrl)
    }
    return out
}

function readRegistry(ctx: ModelContext): ModelRegistryView | undefined {
    try {
        return ctx.modelRegistry
    } catch {
        return undefined
    }
}
