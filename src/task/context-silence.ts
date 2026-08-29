/**
 * Deterministic classifier for a SILENT worker:context — a run whose CONTEXT
 * section carries zero parseable bullets. The question it answers is whether that
 * silence is a genuine LOSS (architectural context was there to surface and the
 * worker dropped all of it) or a LEGITIMATE empty answer (there was nothing worth
 * a bullet). Only the first is worth re-running for.
 *
 * TWO SILENT SHAPES ARE LOSSES, and both are recognisable from the output alone:
 *
 *   LOOP_DEGRADE: the worker thrashed the same call until the loop-killer fired,
 *     leaving the degrade banner in place of a section. research-worker.ts writes
 *     that banner as "stuck in a loop — called <tool>(<args>) ×<n> in the last <m>
 *     calls…", which is the substring this keys on.
 *
 *   GENERATION_GARBAGE: the worker exited 0 and emitted a non-bullet fragment
 *     instead of context — a stray sentence, or a hallucinated system note.
 *
 * The third silent shape, an honest "nothing to surface" declaration, is NOT a
 * loss and must not trigger a retry. Separating the three is the whole job.
 *
 * This is wired: research-worker gates its silent-retry on
 * `verdict.silent && verdict.genuineLoss`, and keeps the retry only if
 * `countBullets` says it produced any.
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
 * Classify one worker:context output.
 *
 * `workerLog` is optional and only consulted for the loop banner, which the degrade
 * machinery writes to the debug log even when it never reached the persisted
 * section — a mid-loop SIGTERM before any write. Confirmed by running it: a
 * garbage-looking section plus a log carrying the banner classifies as
 * `loop-degrade`, not `generation-garbage`. The production call site passes no
 * log, so that path is currently reachable only by a caller that supplies one.
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
 * Wilson score interval for a binomial proportion.
 *
 * A normal-approximation (Wald) interval is useless exactly where this kind of
 * measurement lives — at small counts and rates near 0 or 1. At 0 successes of 12,
 * Wald collapses to the zero-width [0, 0], claiming certainty from no evidence,
 * while Wilson gives roughly [0, 0.24]. Checked both ways, including 12 of 12,
 * which Wilson bounds below 1 rather than pinning at it.
 *
 * No production caller: this is a reporting helper, exercised by its own tests.
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
