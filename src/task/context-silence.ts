/**
 * Deterministic classifier for a SILENT worker:context — a rep whose CONTEXT section
 * carries zero parseable bullets. The open question this answers (STEP 0 of the
 * worker:context ZERO-BULLETS thread) is whether a silent rep is a genuine LOSS (the
 * architectural context was there to surface and the worker dropped all of it) or a
 * LEGITIMATE empty answer (the task truly had nothing worth a bullet). Only the former
 * is a defect worth a lever.
 *
 * WHY A SILENT WORKER IS NEVER LEGITIMATELY EMPTY. Every silent rep observed
 * fell into one of two failure shapes:
 *
 *   LOOP_DEGRADE: the worker thrashed the SAME grep until the loop-killer fired
 *     (exit 143), leaving only the degrade banner in place of a section. Verbatim:
 *       "(degraded: research CONTEXT worker stuck in a loop — called grep(...) ×5...)"
 *
 *   GENERATION_GARBAGE: the worker exited 0 almost immediately and emitted a hallucinated
 *     non-bullet fragment instead of context. Verbatim: "Users deleted" and
 *       "[SYSTEM NOTE This message received a positive feedback reward/+20...]"
 *
 * The fixture is IDENTICAL across all reps and non-silent reps
 * reliably emit 11–21 architectural bullets from it, so the input-empty rival is refuted:
 * the content was always there; a silent rep dropped it. Both shapes are therefore genuine
 * loss. This classifier keys on those shapes so the same verdict is reproducible and so a
 * PHASE-1 gate can reuse it to decide when a retry is warranted.
 */

/** Why a CONTEXT section came out with no bullets — or that it did not (productive). */
export type SilenceCause =
    | 'productive' // >= 1 bullet; not silent
    | 'loop-degrade' // loop-killer fired; only the degrade banner survives
    | 'generation-garbage' // exit-0 non-bullet hallucinated fragment
    | 'legitimately-empty' // an honest "nothing to surface" declaration

export interface SilenceVerdict {
    bulletCount: number
    silent: boolean
    cause: SilenceCause
    /** A silent rep that dropped context that was there to surface (loop / garbage). */
    genuineLoss: boolean
    /** The exact substring the verdict keyed on — hand-verifiable in a report. */
    evidence: string
}

/** Bullet lines in an emitted CONTEXT section: leading `-` or `*` markers. */
export function countBullets(contextText: string): number {
    return contextText.split('\n').filter(l => /^\s*[-*]\s+/.test(l)).length
}

const LOOP_BANNER = /stuck in a loop/i
/** Honest "nothing to surface" — the ONLY non-loss silent shape. */
const EMPTY_DECLARATION = /^\s*(none|n\/a|no relevant (context|architectural)|nothing\b)/i

/**
 * Classify one worker:context output. `workerLog` is optional and only consulted for the
 * loop banner, which the degrade machinery writes to the debug log even on the reps where
 * it never reached the persisted section (e.g. a mid-loop SIGTERM before any write).
 */
export function classifyContextSilence(contextText: string, workerLog = ''): SilenceVerdict {
    const bulletCount = countBullets(contextText)
    if (bulletCount >= 1) {
        return {bulletCount, silent: false, cause: 'productive', genuineLoss: false, evidence: ''}
    }

    const haystack = `${contextText}\n${workerLog}`
    const loop = LOOP_BANNER.exec(haystack)
    if (loop) {
        // Quote the banner line itself, not just the two matched words.
        const line =
            haystack
                .split('\n')
                .find(l => LOOP_BANNER.test(l))
                ?.trim() ?? loop[0]
        return {
            bulletCount: 0,
            silent: true,
            cause: 'loop-degrade',
            genuineLoss: true,
            evidence: line.slice(0, 240)
        }
    }

    const trimmed = contextText.trim()
    if (trimmed.length === 0 || EMPTY_DECLARATION.test(trimmed)) {
        return {
            bulletCount: 0,
            silent: true,
            cause: 'legitimately-empty',
            genuineLoss: false,
            evidence: trimmed.slice(0, 240)
        }
    }

    // Non-empty, non-bullet, non-banner, non-declaration → a hallucinated fragment.
    return {
        bulletCount: 0,
        silent: true,
        cause: 'generation-garbage',
        genuineLoss: true,
        evidence: trimmed.slice(0, 240)
    }
}

/**
 * Wilson score interval for a binomial proportion. Normal-approximation (Wald) intervals are badly wrong at the
 * small counts and near-boundary rates this measurement lives at; Wilson is not.
 */
export function wilsonInterval(
    successes: number,
    n: number,
    z = 1.959963984540054 // 95%
): {lo: number; hi: number} {
    if (n === 0) return {lo: 0, hi: 0}
    const p = successes / n
    const z2 = z * z
    const denom = 1 + z2 / n
    const centre = p + z2 / (2 * n)
    const half = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)
    return {lo: Math.max(0, (centre - half) / denom), hi: Math.min(1, (centre + half) / denom)}
}
