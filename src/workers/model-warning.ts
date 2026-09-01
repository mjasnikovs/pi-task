/**
 * Resolve every model cell ONCE per session, and say what does not work.
 *
 * WHY HERE AND NOT AT ARGV TIME
 * -----------------------------
 * The honest question is "can a `--no-extensions` child resolve this spec?", and
 * only `ctx.modelRegistry` can answer it. Five of the six argv producers have no
 * `ctx` at all, and the answer cannot be read from disk either: models.json plus
 * models-store.json are only part of the catalogue, since pi-ai ships built-in
 * lists for 39 providers and this project does not depend on pi-ai. So it is
 * asked at `session_start`, where ctx exists and every task is still in the
 * future, and the verdict is left in group-args.ts for the producers to consult.
 *
 * WHY DROPPING THE FLAG IS THE RIGHT DEGRADE
 * ------------------------------------------
 * A spec whose model is gone but whose PROVIDER still has other models does not
 * make pi exit. `buildFallbackModel` invents a synthetic model id, forces
 * `reasoning: true` onto it, inherits the provider's default baseUrl, and
 * answers at exit 0 — so the child silently runs a model nobody chose. Dropping
 * the flag runs the child exactly as it ran last week and names the cell.
 *
 * A SEPARATE hint from the reasoning one, with its own widget key: the two have
 * different fixes (`models.json` vs `/task-config`) and that line is already at
 * its length budget.
 */
import type {ExtensionAPI, ExtensionContext} from '@earendil-works/pi-coding-agent'
import {getConfig} from '../config/config.js'
import {setGroupWindows, setUnusableSpecs} from '../config/group-args.js'
import {MODEL_INHERIT, splitSpec} from '../config/group-models.js'
import {CHILD_GROUPS, type ChildGroup} from '../config/groups.js'
import {contextWindowForSpec} from '../task/context-usage.js'
import {registerSessionHint} from './session-hint.js'

const WIDGET_KEY = 'pi-task-model-warning'

/** One cell that will not do what it says. */
export interface ModelProblem {
    group: ChildGroup
    spec: string
    /**
     * `unresolved` — no such model here, so the flag is dropped.
     * `extension` — resolvable only because a host extension registered its
     * provider. Children run `--no-extensions`, which disables DISCOVERY only,
     * so it works exactly when that extension is in the child whitelist. We
     * cannot tell which extension registered it: `getRegisteredProviderIds()`
     * gives ids, and the `{name, config, extensionPath}` triples live in the
     * runner's internal state. So this is a warning, not a drop — and getting it
     * wrong fails loudly anyway, since the child's resolver reports "not found"
     * and exits 1.
     */
    why: 'unresolved' | 'extension'
}

/** The registry questions this needs, so a test can answer them with a literal. */
export interface ModelLookup {
    find: (provider: string, id: string) => unknown
    extensionProviders: ReadonlySet<string>
}

export function findModelProblems(
    lookup: ModelLookup,
    specs: Readonly<Record<ChildGroup, string>>
): ModelProblem[] {
    const out: ModelProblem[] = []
    for (const group of CHILD_GROUPS) {
        const spec = specs[group]
        if (spec === MODEL_INHERIT) continue
        const parts = splitSpec(spec)
        if (!parts || lookup.find(parts.provider, parts.id) === undefined) {
            out.push({group, spec, why: 'unresolved'})
            continue
        }
        if (lookup.extensionProviders.has(parts.provider)) {
            out.push({group, spec, why: 'extension'})
        }
    }
    return out
}

/**
 * The hint line, or null when every cell is fine.
 *
 * Names at most two cells per cause and appends `(+N more)`, the same budget the
 * reasoning line keeps and for the same reason.
 */
export function formatModelWarning(problems: readonly ModelProblem[]): string | null {
    if (problems.length === 0) return null
    const list = (why: ModelProblem['why']): string => {
        const hits = problems.filter(p => p.why === why)
        const shown = hits.slice(0, 2).map(p => `${p.group}→${p.spec}`)
        return shown.join(', ') + (hits.length > 2 ? ` (+${hits.length - 2} more)` : '')
    }
    const parts: string[] = []
    if (problems.some(p => p.why === 'unresolved')) {
        parts.push(
            `no such model here — ${list('unresolved')}. Those steps run on pi's default `
                + 'instead; fix the entry in ~/.pi/agent/models.json or pick another model in '
                + '/task-config'
        )
    }
    if (problems.some(p => p.why === 'extension')) {
        parts.push(
            `provider comes from an extension — ${list('extension')}. Children run `
                + '--no-extensions, so add that extension under "child extensions" in '
                + '/task-config or those steps exit 1'
        )
    }
    return `⚠ pi-task models: ${parts.join('. Also: ')}`
}

export function registerModelWarning(
    pi: ExtensionAPI,
    /** Injected by tests, which must not depend on the developer's saved config. */
    readSpecs: () => Readonly<Record<ChildGroup, string>> = () => getConfig().groupModels
): void {
    // TWO handlers, deliberately. The resolution pass must run in EVERY mode:
    // `registerSessionHint` returns early when `ctx.mode !== 'tui'`, so folding
    // this into it would leave the argv drop and the churn windows disarmed for
    // every headless and `--print` run — a guard that only works when someone is
    // watching is not a guard.
    pi.on('session_start', (_event, ctx) => {
        resolveModelCells(ctx, readSpecs())
    })
    registerSessionHint(pi, WIDGET_KEY, ctx =>
        // Re-resolved rather than carried over from the handler above: the two
        // fire in registration order today, and a hint that depended on that
        // would break silently the day it changed. It is a registry read.
        {
            const text = formatModelWarning(findModelProblems(lookupFor(ctx), readSpecs()))
            return text === null ? null : {text}
        }
    )
}

/**
 * Answer, once, what every model cell resolves to — and leave both answers where
 * the code that has no `ctx` can read them.
 *
 * `unresolved` only feeds the argv drop: an extension-provided model may well
 * work, since children load explicitly whitelisted extensions, and dropping its
 * flag would break a config that is merely fragile.
 */
export function resolveModelCells(
    ctx: ExtensionContext,
    specs: Readonly<Record<ChildGroup, string>>
): ModelProblem[] {
    const problems = findModelProblems(lookupFor(ctx), specs)
    setUnusableSpecs(problems.filter(p => p.why === 'unresolved').map(p => p.spec))
    // The SAME walk fills the window table, so the argv and the churn rule can
    // never disagree about which model a group runs on.
    //
    // An `inherit` cell gets NO entry, not the parent's window. Storing one
    // would freeze a session_start snapshot in front of the live per-run value,
    // so a user who switches the session model with Ctrl+P to a bigger one would
    // have every child judged against the old window — the churn rule then fires
    // early and kills a healthy child.
    //
    // The whole walk is guarded because `ctx.model` and `ctx.modelRegistry` are
    // GETTERS that call `assertActive()` and throw on a stale context. Losing the
    // windows must not also lose the `setUnusableSpecs` above it, nor the hint.
    try {
        setGroupWindows(
            Object.fromEntries(
                CHILD_GROUPS.filter(g => specs[g] !== MODEL_INHERIT).map(
                    g => [g, contextWindowForSpec(ctx, specs[g])] as const
                )
            )
        )
    } catch {
        setGroupWindows({})
    }
    return problems
}

function lookupFor(ctx: ExtensionContext): ModelLookup {
    try {
        const registry = ctx.modelRegistry
        return {
            find: (provider, id) => registry.find(provider, id),
            extensionProviders: new Set(registry.getRegisteredProviderIds())
        }
    } catch {
        // A registry that cannot answer must not condemn every cell. Claiming
        // every spec is unresolved would drop every --model flag on a session
        // whose runtime simply was not ready.
        return {find: () => ({}), extensionProviders: new Set()}
    }
}
