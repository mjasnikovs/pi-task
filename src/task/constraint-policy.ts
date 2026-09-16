/**
 * constraint-policy — how much a constraint's PROVENANCE is worth, as one table
 * both gate children render from.
 *
 * The verify child was told a spec constraint is unwaivable, full stop. The
 * resolution judge was told to judge by function and treat over-literal wording
 * as a false alarm. Neither was wrong on its own; together they made the gate's
 * answer depend on which child happened to speak. 0043 is what that costs: a
 * constraint a grill AUTO-ANSWER invented ("do NOT touch `test/ct/template/
 * index.html`") was held as unwaivable as one the user typed, and the task failed
 * on it.
 *
 * A constraint a human stated, or one the refined task carried in, BINDS. A
 * constraint some automation produced — an auto-answer, a YOLO pick, an untagged
 * line the composer wrote itself — is ADVISORY: it sharpens the work, and it
 * fails a gate only when an ACCEPTANCE bullet also fails. Acceptance is the bar;
 * an advisory constraint is a hint about how to clear it.
 *
 * One table, one renderer, two call sites (verify rule 4b, the judge's rules).
 */
import type {Constraint, ConstraintProvenance} from './spec-model.js'

export type ConstraintWeight = 'binding' | 'advisory'

/**
 * What each provenance is worth. A new `ConstraintProvenance` member is a compile
 * error until it declares its weight — which is the point, since the cheapest way
 * back to 0043 is a new automated kind quietly defaulting to `binding`.
 *
 * `accepted` binds because a human read the recommendation and took it; `typed`
 * and `host-set` for the same reason at either end (a person's own words, and a
 * decision the host makes deterministically rather than leaving to a model).
 * Everything else was produced by automation reasoning about the task, and
 * automation may not mint an unwaivable rule.
 */
export const CONSTRAINT_WEIGHTS: Record<ConstraintProvenance, ConstraintWeight> = {
    typed: 'binding',
    'host-set': 'binding',
    spec: 'binding',
    accepted: 'binding',
    auto: 'advisory',
    yolo: 'advisory',
    'yolo-skip': 'advisory',
    'auto-resolved': 'advisory',
    derived: 'advisory'
}

export function constraintWeight(provenance: ConstraintProvenance): ConstraintWeight {
    return CONSTRAINT_WEIGHTS[provenance]
}

/** The weight marker a child sees on a constraint line, and probes match on. */
export function weightTag(provenance: ConstraintProvenance): string {
    return `[${constraintWeight(provenance)}: ${provenance}]`
}

/** Does this collection of findings name at least one BINDING constraint? */
export function anyBinding(findings: readonly string[]): boolean {
    return findings.some(f => f.includes('[binding:'))
}

/**
 * The spec's CONSTRAINTS, annotated with each line's weight, for a child that
 * must judge them. Returns null when the spec states none — the caller then emits
 * no block rather than an empty heading.
 */
export function annotateConstraints(constraints: readonly Constraint[]): string | null {
    if (constraints.length === 0) return null
    return constraints.map(c => `- ${c.text} ${weightTag(c.provenance)}`).join('\n')
}

/**
 * The policy, as prompt lines. ONE renderer: the verify pass and the resolution
 * judge cite the same paragraph, so the two children cannot hold opposite
 * policies again. `heading` differs because the two prompts number their rules
 * differently — that is the only thing a call site may vary.
 */
export function renderConstraintPolicy(heading: string): string[] {
    return [
        `${heading} A CONSTRAINT IS WORTH ITS PROVENANCE. Each CONSTRAINTS line is tagged with`,
        '   its weight and where it came from:',
        `   - ${weightTag('typed')} / ${weightTag('spec')} — BINDING. A person stated it, or the`,
        '     task itself carried it in. Shipped work that violates one is a FAIL naming the',
        '     constraint; you have no waiver authority over it, and "it works anyway" is exactly',
        '     the waiver you do not have.',
        `   - ${weightTag('auto')} / ${weightTag('derived')} — ADVISORY. Automation produced it`,
        '     (an auto-answered question, an unattended pick, a line the composer wrote itself),',
        '     so it records intent, not a contract. A violated advisory constraint is a FAIL only',
        '     when an ACCEPTANCE bullet ALSO fails; on its own it is a note in your report and',
        '     the verdict stands on the acceptance criteria.',
        '   ACCEPTANCE is the bar in both cases. Never soften a binding constraint, and never',
        '   fail work solely for an advisory one.'
    ]
}
