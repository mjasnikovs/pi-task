/**
 * The critique phase's deterministic Probes, as a table.
 *
 * Each row is a defect a model does not self-discover reliably, found by a pure
 * scanner over the composed spec, and forced into the rewrite. Together they are
 * the deterministic half of critique: the triage child judges taste, these decide
 * facts.
 *
 * Why a table. Longhand, a probe has to appear three times in `phaseCritique`:
 * once as a detect/format/log ritual, once as a term in the conjunction that lets
 * a CLEAN triage short-circuit, and once in the array merged into the rewrite.
 * Adding one then means three coordinated edits, and forgetting the SECOND is
 * silent and severe — a CLEAN triage ships a spec carrying a defect the scanner
 * already found, which is precisely what each probe exists to prevent. Wiring like
 * that is also the part tests rarely cover, because the scanners are the
 * interesting half.
 *
 * As a table the override and the merge are DERIVED from the rows:
 * `collectCritiqueDefects` returns `forced: blocks.length > 0`, so "every probe
 * blocks a CLEAN short-circuit" is structurally true rather than something a
 * reviewer must check. Same move as `PROBE_ADAPTERS` (verify-work.ts) and
 * `CLOSURE_SCANS` (final-gate.ts).
 */

import {existsSync} from 'node:fs'
import {resolve} from 'node:path'
import {findSkipEscapes, skipEscapeDefectText} from './skip-escape.js'
import {findSynthesizedWiring, wiringProbeText, readReferencedDocs} from './wiring-claims.js'
import {
    findAbsenceConflicts,
    absenceProbeText,
    siblingTitlesFromPlanContext
} from './verify-reconcile.js'
import {findFrozenPathConflicts, frozenConflictProbeText} from './frozen-conflict.js'
import {findGrepOnlyVerify, grepOnlyVerifyDefectText} from './verify-quality.js'
import {findScriptEscapesInText, scriptEscapeDefectText} from './script-escape.js'

/** Everything the probes read. Assembled once by the critique phase. */
export interface CritiqueProbeContext {
    /** The composed draft under critique. */
    spec: string
    /** The refined feature description the draft was composed from. */
    refined: string
    /** The task's RESEARCH section, when it has one. */
    research?: string
    cwd: string
    /** The cross-slice contract registry, verbatim. Empty for a single /task. */
    registryRaw: string
    planContext?: string
}

interface CritiqueProbe<F> {
    id: string
    /** Findings, or empty when the probe does not fire. Pure and total. */
    detect: (ctx: CritiqueProbeContext) => F[]
    /** The defect block fed to the rewrite as a forced FOCUS item. */
    text: (findings: F[], ctx: CritiqueProbeContext) => string
    /** One debug line naming what was flagged. */
    log: (findings: F[]) => string
    /**
     * A rewrite that was HANDED this defect and shipped it anyway is a failed
     * rewrite, not a finished one. Rows that can check their own closure name the
     * retry problem here; the emphasis retry then gets a targeted hint.
     */
    unresolvedProblem?: {name: string; stillPresent: (rewritten: string) => boolean}
}

/** Narrow helper so each row keeps its own finding type without a cast. */
function probe<F>(row: CritiqueProbe<F>): CritiqueProbe<unknown> {
    return row as CritiqueProbe<unknown>
}

/**
 * The probes, in the order their defects reach the rewrite. Order is presentation
 * only — every row that fires blocks the CLEAN short-circuit equally.
 */
export const CRITIQUE_PROBES: ReadonlyArray<CritiqueProbe<unknown>> = [
    probe({
        // A required VERIFY check wrapped in a skip-announcing `||` fallback
        // (`… || echo "skipping (tool absent)"`) lets the check pass while never
        // running. Confirmed: that exact line makes the collector force a rewrite.
        id: 'skip-escape',
        detect: ctx => findSkipEscapes(ctx.spec),
        text: f => skipEscapeDefectText(f),
        log: f => `skip-escape flagged in VERIFY: ${f.length} line(s)`
    }),
    probe({
        // The generation-side complement of the verify-side boundary check: a spec
        // that INFERS a wiring specific (a tidy mount table) the design never
        // pinned.
        //
        // Handing the registry to the model alone is a weak catcher, because its
        // attention goes to the obvious VERIFY weakness rather than to
        // path-composition reasoning. So this scanner NAMES the inferred mount
        // mappings and juxtaposes the verbatim pinned facts, forcing a focused
        // reconciliation.
        //
        // Grounding is the registry plus any design doc the spec or refined text
        // @-references. No registry means nothing to contradict, and the row
        // returns no findings at all.
        id: 'synthesized-wiring',
        detect: ctx =>
            ctx.registryRaw.trim().length > 0 ?
                findSynthesizedWiring(
                    ctx.spec,
                    ctx.registryRaw + '\n' + readReferencedDocs(ctx.cwd, ctx.refined, ctx.spec),
                    ctx.registryRaw
                )
            :   [],
        text: (f, ctx) => wiringProbeText(f, ctx.registryRaw),
        log: f => `synthesized wiring flagged in spec: ${f.map(w => w.line).join(' | ')}`
    }),
    probe({
        // A VERIFY line asserting the ABSENCE of an artifact
        // the plan pins elsewhere — a path a prior task already shipped, a sibling
        // title's deliverable, a contract-pinned boundary. A scope fence can
        // leak into a sibling's verify as "the admin page must NOT exist"
        //; the guaranteed FAIL became an accepted debt
        // that the final-gate autofix then "fixed" by deleting the sibling's work.
        // It must die here, at spec time. Delete-tasks keep their check by
        // declaring the delete.
        id: 'plan-contradiction',
        detect: ctx =>
            findAbsenceConflicts(ctx.spec, {
                fileExists: p => existsSync(resolve(ctx.cwd, p)),
                siblingTitles: siblingTitlesFromPlanContext(ctx.planContext),
                contracts: ctx.registryRaw
            }),
        text: f => absenceProbeText(f),
        log: f =>
            'plan-contradiction flagged in VERIFY: '
            + f.map(c => `${c.assertion.target} (${c.against})`).join(' | ')
    }),
    probe({
        // An unsatisfiable pair: the spec FREEZES a path outright ("Do NOT modify
        // `tsconfig.json` — handled in steps 1-2") while something also says the
        // deliverable requires editing that same path. The freeze always comes from
        // the spec; the requirement may come from the spec's own body OR from the
        // RESEARCH it was composed from, since compose can drop the nuance while
        // keeping both the freeze and the file creation.
        //
        // Shipped as-is, the created files turn the repo-wide static check
        // permanently red and no task is allowed to fix it — every later task burns
        // its AUTOFIX rounds on it. The rewrite must grant scoped ownership or drop
        // the creation.
        //
        // Confirmed: a freeze alone yields nothing; a freeze plus a
        // requires-edit statement in the same spec yields one conflict.
        id: 'frozen-conflict',
        detect: ctx => findFrozenPathConflicts(ctx.spec, ctx.research),
        text: f => frozenConflictProbeText(f),
        log: f =>
            'unsatisfiable freeze/requires-edit pair flagged in spec: '
            + f.map(c => c.path).join(' | ')
    }),
    probe({
        // A VERIFY block that grep-asserts the SOURCE of a
        // runnable deliverable while every command in the block is static
        // inspection — the build script "verified" by three greps that was never
        // run, shipping broken for 14 tasks. VERIFY must EXECUTE the artifact and
        // assert an observable outcome of that run.
        id: 'grep-theater',
        detect: ctx => findGrepOnlyVerify(ctx.spec),
        text: f => grepOnlyVerifyDefectText(f),
        log: f => `grep-theater VERIFY flagged in spec: ${f.map(x => x.target).join(' | ')}`,
        // Detector-backed closure: a rewrite can ignore the injected
        // defect and re-shipped the grep-only block.
        unresolvedProblem: {
            name: 'verify_grep_theater',
            stillPresent: rewritten => findGrepOnlyVerify(rewritten).length > 0
        }
    }),
    probe({
        // A spec that DICTATES a check script which
        // cannot fail — `"lint": "… || true"`, or a checker laundered through an
        // inverted grep. Whatever task implements that spec writes the disarmed
        // script into package.json, and from then on every gate that runs it
        // reads a constant. Cheapest to kill here, before it is authored.
        id: 'script-escape',
        detect: ctx => findScriptEscapesInText(ctx.spec),
        text: f => scriptEscapeDefectText(f),
        log: f => `neutered check script dictated by spec: ${f.map(x => x.name).join(' | ')}`
    })
]

/** What the deterministic half of critique found. */
export interface CritiqueDefects {
    /** One defect block per probe that fired, in table order. */
    blocks: string[]
    /**
     * True when any probe fired. A CLEAN triage verdict may NOT short-circuit the
     * rewrite while this holds — the whole reason the override exists.
     */
    forced: boolean
    /**
     * The retry problem for a rewrite that shipped a flagged defect anyway, or
     * null. Only probes that were actually FIRED are re-checked: a defect the
     * draft never had is not the rewrite's to resolve.
     */
    unresolvedIn: (rewritten: string) => string | null
}

/**
 * Run every probe over one draft. The loop owns the ritual — skip-when-empty,
 * log, order — so a row cannot be added that silently skips any of it.
 */
export function collectCritiqueDefects(
    ctx: CritiqueProbeContext,
    logDebug?: (line: string) => void
): CritiqueDefects {
    const blocks: string[] = []
    const fired: Array<CritiqueProbe<unknown>> = []
    for (const row of CRITIQUE_PROBES) {
        const findings = row.detect(ctx)
        if (findings.length === 0) continue
        fired.push(row)
        blocks.push(row.text(findings, ctx))
        logDebug?.(row.log(findings))
    }
    return {
        blocks,
        forced: blocks.length > 0,
        unresolvedIn: rewritten => {
            for (const row of fired) {
                if (row.unresolvedProblem?.stillPresent(rewritten) === true) {
                    return row.unresolvedProblem.name
                }
            }
            return null
        }
    }
}
