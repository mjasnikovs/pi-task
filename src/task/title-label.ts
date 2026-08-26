/**
 * Display-label compression.
 *
 * A refined GOAL paragraph becomes the stored `title`, which the pipeline reads
 * in full — but it can run to 1000+ characters, which makes the widget head and
 * `/task list` unreadable. `compressTitle` spawns a tool-less local-model child
 * to distill that title into a short, identifying label that we store ALONGSIDE
 * (never replacing) the full title, purely for display. Every failure mode —
 * model error, empty output, leaked tool call, abort, an over-long answer —
 * degrades to the deterministic `truncateLabel`, so a label always comes back
 * and the pipeline never blocks on this best-effort step.
 */

import type {PhaseDeps} from './child-runner.js'
import {runPhaseChild} from './child-runner.js'
import {LABEL_MAX, truncateLabel} from './parsers.js'
import {COMPRESS_LABEL_PROMPT} from './prompts.js'

/**
 * Reduce a raw model completion to a single clean label line: first non-empty
 * line, stripped of surrounding quotes/backticks and a leading "label:" echo,
 * whitespace collapsed. Returns '' when nothing usable remains.
 */
export function sanitizeLabel(raw: string): string {
    const firstLine = raw.split('\n').find(l => l.trim().length > 0) ?? ''
    return firstLine
        .replace(/^\s*label\s*:\s*/i, '')
        .replace(/^["'`]+|["'`]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim()
}

/**
 * Compress `title` into a short display label via a local-model child. Always
 * resolves (never throws): on any failure it returns `truncateLabel(title)`.
 * The returned label is guaranteed to be at most LABEL_MAX characters.
 */
export async function compressTitle(deps: PhaseDeps, title: string): Promise<string> {
    const fallback = truncateLabel(title)
    // Already short enough — no point paying for a model call.
    if (title.replace(/\s+/g, ' ').trim().length <= LABEL_MAX) return fallback
    try {
        const raw = await runPhaseChild(
            deps,
            'compress-label',
            '',
            COMPRESS_LABEL_PROMPT(title, LABEL_MAX)
        )
        const cleaned = sanitizeLabel(raw)
        if (cleaned.length === 0) return fallback
        // Clamp regardless of what the model returned; truncateLabel is a no-op
        // when it already fits.
        return truncateLabel(cleaned)
    } catch {
        return fallback
    }
}
