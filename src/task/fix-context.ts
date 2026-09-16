/**
 * fix-context — what an AUTOFIX re-run is told about the failure it exists to fix.
 *
 * It used to be one prose string: the FAIL reason, plus a diagnosis paragraph if
 * a judge happened to produce one. Everything the gate had already computed
 * stayed behind — which CLASS of failure it was, how many attempts had already
 * been spent on it, what the deterministic probes found, and whether the spec
 * contradicts itself. So the re-run re-derived what the gate knew, and in 0034 it
 * re-derived it wrong: told only "lint fails", it widened suppressions until the
 * check went quiet.
 *
 * A value, then, and one renderer. The banner keeps its RE-ATTEMPT opening — it
 * is the sentence the implementer reads first and the one thing about the old
 * string worth keeping.
 */
import type {Disposition, SpecContradiction} from './gate-resolution.js'
import type {ProbeFindings, VerifyOutcome} from './verify-work.js'
import {VERIFY_FAIL_PREFIX} from './verify-work.js'

export interface FixContext {
    outcome: VerifyOutcome
    disposition: Disposition
    /** The deterministic findings the verify pass computed for this verdict. */
    probes: ProbeFindings
    /** Which unattended re-run this is, 1-based. */
    attempt: number
    contradiction?: SpecContradiction | null
    /** The resolution judge's located cause, when it found one beyond the FAIL text. */
    diagnosis?: string
    /** What the user typed instead of picking a card. */
    guidance?: string
}

const PROBE_LABELS: Partial<Record<keyof ProbeFindings, string>> = {
    repoHealth: 'inherited repo health (NOT yours to fix)',
    substitution: 'tests this task itself wrote',
    prohibition: 'spec-forbidden paths this task modified',
    crossTaskDeletion: "another task's deliverables this task deletes",
    probeGaming: 'lines written to quiet a check',
    skipEscape: 'VERIFY commands that skip themselves',
    foreignPath: 'absolute paths that resolve nowhere here',
    scriptEscape: 'check scripts that cannot fail',
    runnerGlob: 'test runners claiming the same files',
    testAssembly: 'tests that rebuild production wiring',
    suppressionWidening: 'suppressions this task added'
}

function probeBlock(probes: ProbeFindings): string[] {
    const out: string[] = []
    for (const [key, findings] of Object.entries(probes) as Array<
        [keyof ProbeFindings, string[] | undefined]
    >) {
        if (!findings || findings.length === 0) continue
        out.push(`- ${PROBE_LABELS[key] ?? key}:`)
        for (const f of findings) out.push(`    ${f}`)
    }
    return out.length === 0 ? [] : ['', 'WHAT THE DETERMINISTIC PROBES ALREADY FOUND:', ...out]
}

/**
 * The RE-ATTEMPT banner prepended to the delivered spec.
 *
 * The fail CLASS leads because it decides what a fix may even look like: a
 * `repo-health` failure is about the project's own statics, a `model-verdict` one
 * is about behavior the spec demanded, and confusing the two is how a re-run
 * "fixes" a verdict by silencing a linter.
 */
export function formatFixBanner(ctx: FixContext): string {
    const failClass = ctx.outcome.failClass
    const lines = [
        'RE-ATTEMPT — your previous implementation of this task FAILED verification.',
        "Fix the cause below, then make the spec's VERIFY block pass. Do NOT start over;",
        'change only what is needed to resolve the failure.',
        '',
        `ATTEMPT ${ctx.attempt} of this task's fix budget.`
    ]
    if (failClass) {
        lines.push(
            `FAILURE CLASS: ${failClass} — ${VERIFY_FAIL_PREFIX[failClass]}. A fix that does not`,
            'move THIS class has not fixed anything; suppressing, disabling, deleting or',
            'skipping the check that reported it is a defect, not a fix.'
        )
    }
    lines.push('', `VERIFICATION FAILURE:\n${(ctx.outcome.reason ?? '').trim()}`)
    if (ctx.diagnosis && ctx.diagnosis.trim().length > 0) {
        lines.push(
            '',
            `DIAGNOSIS (a read-only investigation of this failure found):\n${ctx.diagnosis.trim()}`
        )
    }
    lines.push(...probeBlock(ctx.probes))
    if (ctx.contradiction) {
        lines.push(
            '',
            `SPEC CONTRADICTION: \`${ctx.contradiction.frozenPath}\` is frozen by this task's own`,
            `spec, and ${ctx.contradiction.criterion || 'the failing check'} cannot be satisfied`,
            'without editing it. Do NOT edit the frozen path. Report the contradiction in your',
            'summary and fix whatever else you can reach.'
        )
    }
    if (ctx.guidance && ctx.guidance.trim().length > 0) {
        lines.push('', `User guidance: ${ctx.guidance.trim()}`)
    }
    return lines.join('\n')
}
