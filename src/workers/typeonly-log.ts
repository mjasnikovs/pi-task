/**
 * STAGE 1 INSTRUMENTATION for F-2 / PROMPT 2 — firing-rate observability, no behaviour.
 *
 * WHY THIS EXISTS. PROMPT 2's live A/B measured 82% baseline vs 91% treatment, p = 0.88,
 * and was written off as "the lever does not work". It was a broken EXPERIMENT, and it was
 * broken for a reason this module fixes: the metric counted ALL research terminations while
 * the lever touches only TYPE-ONLY answers, and nothing anywhere recorded how often a
 * type-only answer actually occurs. The causal claim "workers stop BECAUSE of type-only
 * answers" was asserted from one static corpus (1 flag in 150 recorded answers, 0.7%) and
 * never measured live. You cannot size an arm, pick a metric, or decide whether the lever is
 * a population fix or a single-case guard without that firing rate.
 *
 * WHAT IT DOES. When `PI_TASK_TYPEONLY_LOG` names a file, every pi-worker-docs answer — not
 * only the flagged ones — appends one JSON line there. Denominator and numerator both, from
 * the same channel, so a rate is computable rather than inferable. With the variable unset
 * this is a no-op and nothing is written.
 *
 * MECHANICAL, NOT SELF-REPORT. The record is written at the TOOL layer from the verdict the
 * shipped detector just returned, next to the same `details` the caller receives. No model is
 * asked whether it thought the answer was a type signature.
 *
 * BEHAVIOUR-NEUTRALITY IS THE WHOLE POINT — this lands in a stage that forbids src/ behaviour
 * change, so:
 *   - it is called for its side effect only; nothing reads its return value;
 *   - every failure is swallowed (a full disk or an unwritable path must not turn a working
 *     docs lookup into an error — instrumentation that can break the thing it measures is
 *     worse than no instrumentation);
 *   - it appends synchronously, because the process that writes it (a pi child running the
 *     docs extension) can exit immediately after the tool returns and a queued async write
 *     would be lost.
 *
 * THE FULL ANSWER TEXT IS RETAINED, deliberately. Run 15's audit could not decide F-3(f) —
 * whether an `excerptVerified === false` was fabrication or a normaliser gap — because the
 * text it judged was kept nowhere. The same hole would make every stability question here
 * unanswerable: whether a question is type-only in EVERY rep or churns between identical
 * reps can only be settled by re-scoring the recorded answers. Cheap to keep, impossible to
 * reconstruct later.
 */
import * as fs from 'node:fs'
import type {ExcerptVerification} from '../shared/child-output.js'

/** Env var naming the JSONL sink. Unset (or empty) ⇒ instrumentation is entirely off. */
export const TYPEONLY_LOG_ENV = 'PI_TASK_TYPEONLY_LOG'

/** One pi-worker-docs answer, as observed at the tool layer. */
export interface TypeOnlyLogRecord {
    /** ISO timestamp — lets records be attributed to a rep/phase window after the fact. */
    at: string
    /** The `module` param: a package specifier, or "." for project source. */
    module: string
    /** The query verbatim as the worker asked it (NOT the lowercased cache key). */
    query: string
    /** The child's `<answer>` prose — retained so every counter can be re-scored offline. */
    answer: string
    /** The shipped detector's verdict for (answer, query). */
    typeOnly: boolean
    /** The detector's reason string — names which gate decided, for auditing precision. */
    reason: string
    /** True when the answer is the explicit "unclear from this package" non-answer. */
    unclear: boolean
    /** child-output's excerpt check; undefined when the child cited no excerpt. */
    excerptVerified?: boolean
    /**
     * The FULL verification record behind `excerptVerified` — the normalised excerpt that was
     * searched for, plus a sha256 + length of the normalised content it was searched in.
     *
     * This is the other half of the F-3(f) hole described above: retaining the answer text
     * says WHAT was claimed, and this says what it was checked against, so a false verdict can
     * be attributed to fabrication (the excerpt is nowhere near the content) rather than a
     * normaliser gap (a markdown-escape variant of text that IS present) without re-running
     * the lookup. Only fetch's extractor used to keep it; all four focused-extractor call
     * sites now can (workers/focused-extractor.ts). Optional — records predating it parse.
     */
    excerptCheck?: ExcerptVerification
    /**
     * The tool's ENTIRE return text — version banner, npm header, the answer prose, the cited
     * excerpt, and (when it fires) the type-only banner. Optional so logs written before this
     * field existed still parse.
     *
     * WHY IT IS NOT REDUNDANT WITH `answer`. `answer` is the child's prose only. The worker
     * receives strictly more than that, and the extra part is where the SYMBOL NAMES live: the
     * cited `.d.ts` excerpt. Asking "did the worker write an APIS entry it had actually looked
     * up, or one it produced from memory" is a substring question against what the worker was
     * GIVEN, and answering it off `answer` alone would score a symbol that appeared verbatim in
     * the retrieved declaration as ungrounded. That would inflate the very counter it is meant
     * to measure. Recording the full text makes the grounding test conservative in the
     * direction that cannot manufacture a finding.
     */
    toolText?: string
}

/**
 * The honest non-answer, in BOTH wordings the tool can emit. A package lookup is told to
 * write "unclear from this package" (docs-core.ts:622); a project-source lookup is told
 * "unclear from this project" (docs-project.ts:310). Matching only the first silently scored
 * every project-source abstention as a valid answer — and project-source is the MAJORITY of
 * what worker:apis asks (13 of 17 calls in run 15's fatal task), so that one missing word
 * would have put the wrong denominator under the whole termination diagnostic.
 */
const UNCLEAR = /unclear from this (package|project)/i

/**
 * Append one record to the JSONL sink named by `PI_TASK_TYPEONLY_LOG`, if set.
 *
 * @param rec everything but `at` and `unclear`, which are derived here so every call site
 *            stamps them identically.
 */
export function logDocsAnswer(
    rec: Omit<TypeOnlyLogRecord, 'at' | 'unclear'>,
    getEnv: (k: string) => string | undefined = k => process.env[k]
): void {
    const sink = getEnv(TYPEONLY_LOG_ENV)
    if (!sink || sink.trim().length === 0) return
    const full: TypeOnlyLogRecord = {
        at: new Date().toISOString(),
        ...rec,
        unclear: UNCLEAR.test(rec.answer)
    }
    try {
        fs.appendFileSync(sink, `${JSON.stringify(full)}\n`, 'utf8')
    } catch {
        // Deliberately silent. This is a measurement side-channel; a docs lookup that
        // succeeded must not be reported as failed because the sink was unwritable.
    }
}

/** Parse a sink written by {@link logDocsAnswer}; malformed lines are skipped, not thrown. */
export function readTypeOnlyLog(text: string): TypeOnlyLogRecord[] {
    const out: TypeOnlyLogRecord[] = []
    for (const line of text.split('\n')) {
        if (line.trim().length === 0) continue
        try {
            out.push(JSON.parse(line) as TypeOnlyLogRecord)
        } catch {
            // A truncated final line is normal when a process is killed mid-append.
        }
    }
    return out
}
