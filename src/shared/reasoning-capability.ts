/**
 * What pi will ACTUALLY send, given a model and a requested thinking level.
 *
 * WHY A LOCAL COPY OF PI'S CLAMP
 * ------------------------------
 * pi never reports that it ignored or downgraded a level. Measured live against
 * this machine's llama-server, with a proxy capturing the request body:
 *
 *   1. a model with `reasoning: false` + `--thinking medium`
 *        → the body carries NO reasoning field at all. No error, no warning.
 *   2. `thinkingLevelMap: {off: null, ...}` + `--thinking off`
 *        → silently clamped UP to `medium`. Thinking stays on.
 *   3. `--thinking low` where `low: null`
 *        → silently clamped to `medium`.
 *
 * All three are the same arithmetic, and it is pure: `getSupportedThinkingLevels`
 * / `clampThinkingLevel` in @earendil-works/pi-ai's models module. Reproducing it
 * lets one predicate — `clampToModel(m, wanted) !== wanted` — catch all three
 * host-side, before a single request is sent.
 *
 * Reimplemented rather than imported because `@earendil-works/pi-ai` is neither a
 * dependency nor a peerDependency of pi-task: it is present only because
 * pi-coding-agent hoists it, so importing it would take a hard dependency on a
 * transitive package to get twenty lines of arithmetic. SOURCE OF TRUTH is that
 * module; `reasoning-capability.test.ts` is where a change upstream shows up.
 */
import {REASONING_GROUPS, type ReasoningGroup, type GroupSetting} from '../config/reasoning.js'

/**
 * pi's own level ladder, in order. The order is the whole algorithm: an
 * unsupported level is resolved by walking UP first, then down.
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
 *    This is why config/reasoning.ts does not offer those two: a model with no
 *    map at all would receive the raw string, and Qwen3.8's chat template
 *    answers an unknown effort with HTTP 500 rather than a clamp.
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

/** One group whose configured setting the connected model will not honour. */
export interface ReasoningMismatch {
    group: ReasoningGroup
    /** What /task-config says. Never `inherit` — an inherited group asks for nothing. */
    wanted: LadderLevel
    /** What pi will send instead. */
    actual: LadderLevel
}

/**
 * Every group whose setting the model will silently change.
 *
 * `inherit` groups are skipped entirely, and that is what keeps a default
 * install permanently quiet: with the shipped all-`inherit` table this returns
 * an empty array for every model, including one with no reasoning at all.
 *
 * It reports mismatches in BOTH directions, which is wider than "warn when
 * reasoning is on but unsupported". The failure actually captured on this
 * machine is the mirror of that — `off` clamped UP to `medium`, so a user who
 * turned thinking off still pays for it — and it is the same comparison. Warning
 * about one direction while staying silent about the other would ship this
 * feature with its own measured failure mode unreported.
 */
export function reasoningMismatches(
    model: ReasoningModelFacts | undefined,
    levels: Readonly<Record<ReasoningGroup, GroupSetting>>
): ReasoningMismatch[] {
    // No model resolved yet (session still starting, or none selected): say
    // nothing. A warning naming no model is noise, not information.
    if (!model) return []
    const out: ReasoningMismatch[] = []
    for (const group of REASONING_GROUPS) {
        const wanted = levels[group]
        if (wanted === 'inherit') continue
        const actual = clampToModel(model, wanted)
        if (actual !== wanted) out.push({group, wanted, actual})
    }
    return out
}
