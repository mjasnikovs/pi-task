/**
 * What pi will ACTUALLY send, given a model and a requested thinking level.
 *
 * WHY A LOCAL COPY OF PI'S CLAMP
 * ------------------------------
 * pi does not report that it ignored or downgraded a level. Captured on the wire,
 * with a logging proxy between pi and the model server. All three runs completed
 * normally and printed no warning of any kind:
 *
 *   1. a model with `reasoning: false` + `--thinking medium`
 *        → the request body carries NO reasoning field and no
 *          `chat_template_kwargs`. The level is erased, not refused.
 *   2. `thinkingLevelMap: {off: null, …}` + `--thinking off`
 *        → thinking STAYS ON: the body arrives with
 *          `chat_template_kwargs.enable_thinking: true`. The clamp walks UP one
 *          rung at a time, so `off` lands on `minimal` — not on `medium`.
 *   3. `--thinking low` where `low: null`
 *        → `medium` on the wire.
 *
 * All three are the same arithmetic, and it is pure: `getSupportedThinkingLevels`
 * / `clampThinkingLevel` in @earendil-works/pi-ai's `models.js`. Reproducing it
 * lets one predicate — `clampToModel(m, wanted) !== wanted` — catch all three
 * host-side, before a single request is sent.
 *
 * Reimplemented rather than imported because `@earendil-works/pi-ai` is neither a
 * dependency, a devDependency nor a peerDependency of pi-task — it is in none of
 * the three, and sits in node_modules only because pi-coding-agent depends on it.
 * Importing it would take a hard dependency on a transitive package for twenty
 * lines of arithmetic. SOURCE OF TRUTH is that module, and what follows is
 * line-for-line identical to it, ladder included. Nothing here imports pi-ai, so
 * an upstream change will not fail a test — the two have to be re-compared.
 */
import {
    CHILD_GROUPS,
    REASONING_SETTINGS,
    type ChildGroup,
    type GroupSetting
} from '../config/reasoning.js'

/**
 * pi's own level ladder, in order — the same seven names, in the same sequence,
 * as `EXTENDED_THINKING_LEVELS` in pi-ai's models.js. The order IS the algorithm:
 * an unsupported level is resolved by walking UP first, then down.
 */
export const THINKING_LADDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export type LadderLevel = (typeof THINKING_LADDER)[number]

/**
 * The two fields of pi's `Model` that decide reasoning behaviour. Named
 * separately so the pure functions below can be tested with object literals
 * instead of a whole model registry.
 */
export interface ReasoningModelFacts {
    reasoning: boolean
    thinkingLevelMap?: Partial<Record<string, string | null>>
}

/**
 * The levels this model will actually honour.
 *
 * Two rules that are easy to get backwards:
 *  - `reasoning: false` collapses everything to `['off']`. That is failure mode
 *    1: the knob is not rejected, it is erased.
 *  - a MISSING map entry means "supported" for the standard levels but
 *    "unsupported" for `xhigh` / `max`, which are opt-in and must be declared.
 *    This is why config/reasoning.ts offers neither: without a map the raw
 *    string reaches the server, and a chat template that does not know the level
 *    fails rather than clamping. Confirmed against a live server — an effort
 *    string its template does not handle comes back HTTP 500, raised from inside
 *    the template itself, while one it does handle returns 200.
 */
export function supportedThinkingLevels(model: ReasoningModelFacts): LadderLevel[] {
    if (!model.reasoning) return ['off']
    return THINKING_LADDER.filter(level => {
        const mapped = model.thinkingLevelMap?.[level]
        if (mapped === null) return false
        if (level === 'xhigh' || level === 'max') return mapped !== undefined
        return true
    })
}

/**
 * The level pi will use in place of the one asked for. Equal to the input when
 * the model supports it — which is what makes the inequality a mismatch test.
 */
export function clampToModel(model: ReasoningModelFacts, level: LadderLevel): LadderLevel {
    const available = supportedThinkingLevels(model)
    if (available.includes(level)) return level
    const requested = THINKING_LADDER.indexOf(level)
    if (requested === -1) return available[0] ?? 'off'
    for (let i = requested; i < THINKING_LADDER.length; i++) {
        const candidate = THINKING_LADDER[i]!
        if (available.includes(candidate)) return candidate
    }
    for (let i = requested - 1; i >= 0; i--) {
        const candidate = THINKING_LADDER[i]!
        if (available.includes(candidate)) return candidate
    }
    return available[0] ?? 'off'
}

/**
 * The settings a /task-config row may offer, given the model its group runs on.
 *
 * The INTERSECTION with `REASONING_SETTINGS`, not `supportedThinkingLevels`
 * directly: that returns the whole ladder including `xhigh` and `max`, which
 * the menu excludes on purpose (see config/reasoning.ts) because pi's own UI
 * may not offer them. A model declaring `xhigh` must not smuggle it in.
 */
export function offeredLevels(facts: ReasoningModelFacts | undefined): GroupSetting[] {
    if (facts === undefined) return [...REASONING_SETTINGS]
    const supported = supportedThinkingLevels(facts)
    return REASONING_SETTINGS.filter(s => s === 'inherit' || supported.includes(s as LadderLevel))
}

/**
 * The setting a row will really run at, inside the menu's own vocabulary.
 *
 * ONE function for the picker's preselect and the writer, because they used to
 * be two copies of the same clamp and only one re-projected into
 * {@link offeredLevels}. `clampToModel` walks UP first and knows the whole
 * ladder, so a model declaring `xhigh` can land on a level the menu excludes;
 * a writer that stored it would put a value in the table that no row can show.
 * The highest OFFERED level is the honest neighbour of an excluded one.
 */
export function effectiveSetting(
    facts: ReasoningModelFacts | undefined,
    wanted: GroupSetting
): GroupSetting {
    if (facts === undefined || wanted === 'inherit') return wanted
    const offered = offeredLevels(facts)
    const clamped = clampToModel(facts, wanted) as GroupSetting
    return offered.includes(clamped) ? clamped : (offered.at(-1) ?? 'inherit')
}

/** One group whose configured setting the model it runs on will not honour. */
export interface ReasoningMismatch {
    group: ChildGroup
    /**
     * The model THIS GROUP runs on. Per-item, not per-warning, because groups no
     * longer share one model: a line that opens `model "X" will not run …` while
     * listing groups that run on Y is itself a lie about what it checked.
     */
    modelName: string
    /** What /task-config says. Never `inherit` — an inherited group asks for nothing. */
    wanted: LadderLevel
    /** What pi will send instead. */
    actual: LadderLevel
}

/** What a group runs on, as much of it as this check needs. */
export interface GroupModelFacts extends ReasoningModelFacts {
    /** What to call it in the warning. */
    name: string
    /** Where it is served from, for the `/props` probe. Absent ⇒ not probeable. */
    baseUrl?: string
}

/**
 * Every group whose setting the model IT RUNS ON will silently change.
 *
 * `modelFor` is a FUNCTION rather than a `Record`, for two reasons: a record
 * would build eleven identical entries for the overwhelmingly common
 * all-`inherit` case, and a function is drivable from a test with two literals.
 * It answers `undefined` for a group whose model cannot be resolved — nothing is
 * reported for those, because the run degrades to the session default and the
 * separate model hint is what names them.
 *
 * `inherit` groups are skipped entirely, because an inherited group asks for
 * nothing. That is not the same as a quiet default: the shipped table is mostly
 * DECIDED, with a single cell left on `inherit`, so a default install is not
 * silent. Run against a `reasoning: false` model it reports a mismatch for every
 * group whose level that model cannot honour.
 *
 * It reports mismatches in BOTH directions, which is wider than "warn when
 * reasoning is on but unsupported". The mirror case is the one captured on the
 * wire — `off` clamped UP with `enable_thinking: true` still going out, so a
 * user who turned thinking off still pays for it — and it is the same
 * comparison. Warning about one direction while staying silent about the other
 * would ship this feature unable to see its own failure mode.
 */
export function reasoningMismatches(
    modelFor: (group: ChildGroup) => GroupModelFacts | undefined,
    levels: Readonly<Record<ChildGroup, GroupSetting>>
): ReasoningMismatch[] {
    const out: ReasoningMismatch[] = []
    for (const group of CHILD_GROUPS) {
        const wanted = levels[group]
        if (wanted === 'inherit') continue
        // No model resolved for this group (session still starting, none
        // selected, or a spec this machine cannot resolve): say nothing. A
        // warning naming no model is noise, not information.
        const model = modelFor(group)
        if (!model) continue
        const actual = clampToModel(model, wanted)
        if (actual !== wanted) out.push({group, modelName: model.name, wanted, actual})
    }
    return out
}
