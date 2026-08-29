/**
 * Resume gating & the honest resume banner.
 *
 * a lost ~10 hours to dead air that looked like a stall: the host was
 * powered off overnight, both containers stopped at 20:00Z, and the run picked
 * up cleanly the moment they were restarted at 06:01Z. Nothing was wrong with
 * the run — the only defect was that nobody could tell. Two things follow.
 *
 * (1) A restart-time resume can be automated (`restart: unless-stopped` on the
 * containers plus a boot hook that runs `/task-auto-resume --unattended`), which
 * turns that 10h of nothing into minutes.
 *
 * (2) An automated resume must not resume everything. `RESUMABLE_STATES`
 * deliberately includes `failed` and `cancelled` because a HUMAN typing
 * /task-auto-resume has decided to continue; a boot hook has decided nothing. A
 * failed run stopped for a reason a power cycle does not clear, and re-entering
 * it unattended burns the whole loop against the same wall. Unattended resume
 * therefore covers in-flight states only (see UNATTENDED_STATES), and refuses
 * the rest by name rather than silently doing nothing.
 *
 * The banner follows the honest-restart-hint rule (70a8497): say exactly what
 * was observed and exactly what it does not tell you. All this process knows is
 * when the AUTO file was last written — it cannot distinguish a stopped host
 * from a hung child from a slow task, so it reports the gap and attributes no
 * cause. It is equally careful about the tree: nothing is rolled back between
 * the interruption and the resume.
 */
import type {TaskState} from './task-types.js'

/** States an UNATTENDED resume may continue. In-flight only — see file header. */
export const UNATTENDED_STATES: TaskState[] = ['in_progress']

/** The most recent resumable AUTO run, with the two facts the banner needs. */
export interface AutoResumeCandidate {
    id: string
    state: TaskState
    /** AUTO-file mtime: the last moment the run demonstrably wrote progress. */
    lastWriteMs: number
}

export interface ResumeDecision {
    /** Whether the caller should proceed with the resume. */
    resume: boolean
    /** The line to show the user (and publish to the remote view). */
    banner: string
    level: 'info' | 'warning'
}

/**
 * Below this the gap is ordinary hand-driven latency (you looked at the failure,
 * then typed the command) and the unaccounted-time paragraph would be noise.
 */
const GAP_NARRATION_MS = 5 * 60_000

/** Human gap, coarsest-two-units ("10h 1m", "45s", "2d 4h"). */
export function formatGap(ms: number): string {
    const s = Math.floor(ms / 1000)
    if (s < 60) return `${s}s`
    const m = Math.floor(s / 60)
    if (m < 60) return s % 60 === 0 ? `${m}m` : `${m}m ${s % 60}s`
    const h = Math.floor(m / 60)
    if (h < 24) return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`
    const d = Math.floor(h / 24)
    return h % 24 === 0 ? `${d}d` : `${d}d ${h % 24}h`
}

/**
 * What the resume says about the time it was away. Attributes no cause: a gap
 * is wall-clock silence, and this process cannot see which of the several very
 * different explanations produced it.
 */
function gapClause(lastWriteMs: number, nowMs: number): string {
    const gap = nowMs - lastWriteMs
    const at = new Date(lastWriteMs).toISOString()
    // A future mtime means the clock moved, not that the run wrote ahead of
    // time; saying "0s ago" there would be the one thing this banner must not do.
    if (gap < -60_000) {
        return `its file is timestamped ${at}, which is in the future — the clock moved under it, so no gap can be measured`
    }
    const shown = formatGap(Math.max(0, gap))
    if (gap < GAP_NARRATION_MS) return `last written ${shown} ago (${at})`
    return (
        `last written ${shown} ago (${at}). That gap is unaccounted-for wall time, not work: `
        + `this process cannot tell a stopped host from a hung child from a slow task. `
        + `Nothing was rolled back — the working tree is exactly as the interrupted run left it`
    )
}

/**
 * Gate an incoming resume and phrase it. Pure: the caller supplies the candidate
 * and the clock. `unattended` is the boot-hook path (`--unattended`), which is
 * the only one that refuses on state.
 */
export function decideResume(
    candidate: AutoResumeCandidate | null,
    nowMs: number,
    unattended: boolean
): ResumeDecision {
    if (!candidate) {
        return {resume: false, banner: 'No resumable /task-auto run.', level: 'info'}
    }
    const {id, state, lastWriteMs} = candidate
    if (unattended && !UNATTENDED_STATES.includes(state)) {
        return {
            resume: false,
            banner:
                `Not auto-resuming ${id}: state=${state}. Unattended resume continues `
                + `in-flight runs (${UNATTENDED_STATES.join(', ')}) only — a ${state} run stopped `
                + `for a reason a restart does not clear. Look at it, then resume by hand with `
                + `/task-auto-resume.`,
            level: 'warning'
        }
    }
    return {
        resume: true,
        banner: `Resuming ${id} (state=${state}) — ${gapClause(lastWriteMs, nowMs)}.`,
        level: 'info'
    }
}
