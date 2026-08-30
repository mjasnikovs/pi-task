/**
 * Firing-rate instrumentation for the TYPE-ONLY detector. Observability only; it
 * changes no behaviour.
 *
 * WHY THIS EXISTS. "How often does a type-only answer occur" cannot be answered by
 * counting the times the detector FIRED — a log of firings has no denominator. So
 * every pi-worker-docs answer is recorded, flagged or not, and the rate is
 * computable rather than inferable.
 *
 * WHAT IT DOES. When `PI_TASK_TYPEONLY_LOG` names a file, each answer appends one
 * JSON line there. Unset or blank and this is a no-op that writes nothing.
 *
 * MECHANICAL, NOT SELF-REPORT. The record is written at the TOOL layer from the
 * verdict the shipped detector just returned, next to the same `details` the caller
 * receives. No model is asked whether it thought the answer was a type signature.
 *
 * BEHAVIOUR-NEUTRAL BY CONSTRUCTION:
 *   - it is called for its side effect only; nothing reads its return value;
 *   - every failure is swallowed. A full disk or an unwritable path must not turn a
 *     working docs lookup into an error — instrumentation that can break the thing
 *     it measures is worse than none;
 *   - it appends SYNCHRONOUSLY, because the process that writes it is a pi child
 *     that can exit the moment the tool returns, and a queued async write would be
 *     lost.
 *
 * THE FULL ANSWER TEXT IS RETAINED, deliberately. Without it, an
 * `excerptVerified === false` cannot afterwards be attributed to fabrication rather
 * than to a normaliser gap, and "is this question type-only every time or does it
 * churn between identical runs" cannot be settled at all — both need the recorded
 * answers re-scored. Cheap to keep, impossible to reconstruct later.
 */
import * as fs from 'node:fs'
import type {ExcerptVerification} from '../shared/child-output.js'
import {isAbstention} from './abstention.js'

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
     * The other half of the retention above: the answer text says WHAT was claimed, and
     * this says what it was checked against — so a false verdict can be attributed to
     * fabrication (the excerpt is nowhere near the content) rather than to a normaliser
     * gap (a markdown-escape variant of text that IS present) without re-running the
     * lookup. focused-extractor.ts hands the struct to both of its call sites.
     * Optional — older records still parse.
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
 * Append one record to the JSONL sink named by `PI_TASK_TYPEONLY_LOG`, if set.
 *
 * @param rec everything but `at` (an ISO timestamp) and `unclear` (the abstention
 *            predicate over `answer`), which are derived here so both call sites in
 *            pi-worker-docs stamp them identically.
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
        unclear: isAbstention(rec.answer)
    }
    try {
        fs.appendFileSync(sink, `${JSON.stringify(full)}\n`, 'utf8')
    } catch {
        // Deliberately silent. This is a measurement side-channel; a docs lookup that
        // succeeded must not be reported as failed because the sink was unwritable.
    }
}

/** Parse a sink written by {@link logDocsAnswer}. Blank lines are skipped and a
 *  malformed one — including the truncated tail a killed process leaves — is dropped
 *  rather than thrown. */
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
