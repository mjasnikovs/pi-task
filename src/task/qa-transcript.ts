/**
 * The Q&A TRANSCRIPT of one adaptive dialog — grill (`/task`) or clarify
 * (`/task-auto`) — and the one place its numbering, its formatting and its
 * provenance policy live.
 *
 * `question-dialog.ts` unified the ANSWER side of these loops: the picker cards
 * and the reply mapping. It did not unify what the loop RECORDS, and that was
 * eight retyped push sites across two files, each choosing a suffix by hand
 * according to which branch of an `if/else` it stood in.
 *
 * The cost is written into the code. `phases.ts` states the invariant in a
 * comment — *"No provenance stamp here, unlike clarify's transcript: this string
 * is fed back VERBATIM into the next grill-gen prompt, so a `(accepted
 * recommendation)` suffix would become model input"* — and TWELVE LINES ABOVE it,
 * the YOLO branch pushes `${answer} ${YOLO_STAMP}` into that very array. The rule
 * was violated inside the loop body that declares it, because the rule lived in
 * prose and the decision lived at each push.
 *
 * Here it is a property of a value: an entry states its KIND, and the policy says
 * where that kind's provenance is allowed to appear.
 *
 * NOT unified here: `plan-session.ts`'s `PlanEntry` transcript. It is a different
 * shape — decisions vs advisory notes, persisted to its own task file, with no
 * `Qn:`/`An:` numbering — and folding it in would be a rename, not a deepening.
 */

import {YOLO_STAMP} from './yolo.js'

/** How one answer was arrived at. */
export type QaKind =
    /** grill: the research-backed auto-answer resolved it without asking. */
    | 'auto'
    /** clarify: answer-side triage found the spec already settles it. */
    | 'auto-resolved'
    /** clarify: the host answers this fork deterministically (plan shape). */
    | 'host-set'
    /** unattended: took the recommended option. */
    | 'yolo'
    /** unattended: nothing safe to take, so the fork is left open. */
    | 'yolo-skip'
    /** the human took the recommendation — green card, or an empty submit. */
    | 'accepted'
    /** the human wrote their own answer. */
    | 'typed'

/**
 * The provenance suffix each kind carries. A new kind is a compile error until it
 * declares one; `typed` declares the empty string, which is a statement, not a
 * gap — a human's own words are the baseline everything else is marked against.
 */
export const QA_PROVENANCE: Record<QaKind, string> = {
    auto: '(auto)',
    'auto-resolved': '(auto-resolved — already settled by the spec)',
    'host-set': '(host-set — plan granularity is not left to chance)',
    yolo: YOLO_STAMP,
    'yolo-skip': YOLO_STAMP,
    accepted: '(accepted recommendation)',
    typed: ''
}

export interface QaPolicy {
    /** Kinds whose provenance appears in the RECORD — persisted, and handed on. */
    record: ReadonlySet<QaKind>
    /**
     * Does the text fed back to the QUESTION GENERATOR carry provenance?
     *
     * The two dialogs genuinely disagree, and both say so in their own comments.
     * Grill's is fed VERBATIM into the next grill-gen prompt, so a suffix there
     * becomes model input describing how the answer was obtained rather than what
     * it was. Clarify deliberately shows its generator the provenance, so a
     * question the triage already settled reads as settled and is not re-asked.
     * An option, not a unification — it is observable either way.
     */
    generatorSeesProvenance: boolean
}

/**
 * GRILL: stamps `auto` and both YOLO kinds in the record, and shows the generator
 * nothing.
 *
 * `accepted` is deliberately NOT in the record set. Grill's record reaches
 * `COMPOSE_PROMPT` and `CRITIQUE_PROMPT`, where it is named GROUND TRUTH; clarify's
 * reaches a decompose prompt. Whether those two should agree is a prompt question
 * with its own A/B, so today's answer is preserved rather than harmonised here.
 */
export const GRILL_QA_POLICY: QaPolicy = {
    record: new Set<QaKind>(['auto', 'yolo', 'yolo-skip']),
    generatorSeesProvenance: false
}

/** CLARIFY: stamps every non-typed kind, in the record and to the generator alike. */
export const CLARIFY_QA_POLICY: QaPolicy = {
    record: new Set<QaKind>(['auto-resolved', 'host-set', 'yolo', 'yolo-skip', 'accepted']),
    generatorSeesProvenance: true
}

export interface QaEntry {
    kind: QaKind
    question: string
    answer: string
}

/**
 * One dialog's transcript. Owns the numbering and both renderings; performs no
 * I/O and knows nothing about children, pickers or sessions — which is what makes
 * it drivable by a test that only wants to know what a model would have been
 * shown.
 */
export class QaTranscript {
    private readonly _entries: QaEntry[] = []

    constructor(private readonly _policy: QaPolicy) {}

    /** How many questions have been answered. Also the next question's number − 1. */
    get length(): number {
        return this._entries.length
    }

    get entries(): ReadonlyArray<QaEntry> {
        return this._entries
    }

    /** Record one answered question. The number is assigned here, not by the caller. */
    add(kind: QaKind, question: string, answer: string): void {
        this._entries.push({kind, question, answer})
    }

    /** The persisted / handed-on transcript, with provenance per the policy. */
    forRecord(): string {
        return this._render(e => this._policy.record.has(e.kind))
    }

    /** The text fed back into the next question-generation prompt. */
    forGenerator(): string {
        return this._render(
            e => this._policy.generatorSeesProvenance && this._policy.record.has(e.kind)
        )
    }

    private _render(stamped: (e: QaEntry) => boolean): string {
        return this._entries
            .map((e, i) => {
                const suffix = stamped(e) ? QA_PROVENANCE[e.kind] : ''
                const answer = suffix ? `${e.answer} ${suffix}` : e.answer
                return `Q${i + 1}: ${e.question}\nA${i + 1}: ${answer}`
            })
            .join('\n')
    }
}
