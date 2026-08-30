/**
 * yolo — unattended auto-pick of the option pi-task already marks RECOMMENDED.
 *
 * GOAL: let a local model take a throwaway/test project end to end with nobody
 * watching. Wherever pi-task would stop and ask, it takes the recommended option,
 * STAMPS the artifact so a later audit can see a machine decided, and never
 * notifies. OFF by default; never the behaviour of a normal run.
 *
 * WHY PER-SITE, NOT ONE HOOK (the trap this module exists to avoid): the single
 * interactive choke point is SessionUI.ask() (remote/bridge.ts) — auto-picking
 * "index 0" inside it would be one tiny patch, and it would be wrong. One way the
 * verify-FAIL picker is reached is after MAX_AUTO_AUTOFIX unattended autofix
 * attempts have all failed, and it STILL tints AUTOFIX as recommended, because the
 * research still recommends it. A central hook would pick AUTOFIX forever and
 * defeat the exact cap that exists to break a non-converging loop. So every site
 * decides for itself, BEFORE ask() is called — which also means the prompt
 * notification (bridge.ts holds exactly one pushNotify, inside ask()) is
 * suppressed structurally, with zero suppression code.
 *
 * Guard direction (repo constraint): an auto-pick may cost time, never work.
 * Anything this module cannot stand behind — no recommendation to take, an answer
 * the anti-synthesis guard proved unverifiable — steps ASIDE ('skip') rather than
 * inventing a decision.
 *
 * The policy functions are PURE and take `enabled` explicitly, so each site's
 * behaviour is unit-tested with the flag both ways; only {@link isYoloMode} reads
 * the config.
 */
import {getConfig} from '../config/config.js'
import type {AutoAnswer} from './parsers.js'
import type {ResolutionChoice} from './verify-resolution.js'
import type {FinalGateChoice} from './final-gate-fix.js'

/**
 * Visible provenance marker on the artifacts an auto-pick writes: gate trail lines
 * and the task file's Q&A record (qa-transcript.ts `QA_PROVENANCE`). A later audit
 * reading only the artifacts must never mistake an auto-pick for a human decision.
 * The debt ledger does not use this stamp — it carries the `'yolo-accepted'` ORIGIN
 * instead, which is stronger: a typed field rather than text.
 */
export const YOLO_STAMP = '(YOLO)'

/** Is unattended auto-pick on for this run? The ONLY config read in this module. */
export function isYoloMode(): boolean {
    return getConfig().yoloMode
}

/**
 * What YOLO does at a question site:
 *   - 'answer' — take this (the recommended option).
 *   - 'skip'   — YOLO is on but there is nothing safe to take; leave the question
 *                unanswered and move on, with `note` recorded as the reason.
 *   - null     — YOLO is off: ask the human exactly as before.
 */
export type YoloPick = {kind: 'answer'; answer: string} | {kind: 'skip'; note: string} | null

/**
 * The clarify/grill policy: take the RECOMMENDED option — `suggested`, falling
 * back to the B-side `alt` when a fork offers only that. Recommended is positional
 * for a human too: bridge.ts marks card index 0, and question-box.ts tints the
 * marked card green.
 *
 * `unsafe` is the step-aside channel: a caller that KNOWS the recommendation must
 * not be auto-accepted passes why, and the question is skipped instead. The only
 * thing that supplies it is `yoloPickAutoAnswer` below, on the anti-synthesis
 * demotion — an answer proven to name an unverified API identifier. Auto-accepting
 * that would re-promote exactly the invention the demotion exists to stop, so a
 * machine may never take it; a human still can.
 */
export function yoloPickAnswer(
    enabled: boolean,
    opts: {suggested?: string; alt?: string; unsafe?: string}
): YoloPick {
    if (!enabled) return null
    if (opts.unsafe !== undefined && opts.unsafe.length > 0) {
        return {kind: 'skip', note: opts.unsafe}
    }
    const pick = opts.suggested ?? opts.alt
    if (pick === undefined || pick.trim().length === 0) {
        return {kind: 'skip', note: 'no recommended option to take'}
    }
    return {kind: 'answer', answer: pick}
}

/**
 * The same policy expressed over an {@link AutoAnswer}, for the grill site. Of the
 * four `reason` tags an unknown can carry — `api-synthesis`, `integration`,
 * `threw`, `model-unknown` — only ANTI-SYNTHESIS is unsafe. The other three carry
 * an ordinary best-effort recommendation, which is precisely what a human would be
 * shown as the green card. The variants are told apart by that tag, never by
 * pattern-matching the answer text.
 */
export function yoloPickAutoAnswer(enabled: boolean, auto: AutoAnswer): YoloPick {
    if (!enabled) return null
    if (auto.kind === 'answered') return {kind: 'answer', answer: auto.text}
    return yoloPickAnswer(enabled, {
        ...(auto.suggested !== undefined && {suggested: auto.suggested}),
        ...(auto.alt !== undefined && {alt: auto.alt}),
        ...(auto.reason === 'api-synthesis' && {
            unsafe: 'the suggested answer names an unverified API identifier — needs a human'
        })
    })
}

/**
 * The verify-FAIL picker policy: ACCEPT (and write a debt), never AUTOFIX.
 *
 * Not a preference — a bound. task-gates.ts consults this only after its own
 * unattended paths are exhausted: `autoFixNow` has run AUTOFIX up to
 * MAX_AUTO_AUTOFIX times while the research recommended it, and the YOLO rescue has
 * spent its one attempt on an ACCEPT recommendation with an untouched budget.
 * Answering AUTOFIX here would restart that budget from the very site that proves
 * it ran out. So YOLO takes the terminal option and records the defect under the
 * `'yolo-accepted'` debt origin, which a human decision never produces.
 */
export function yoloVerifyResolution(enabled: boolean): ResolutionChoice | null {
    return enabled ? {action: 'accept'} : null
}

/**
 * The final-integration-gate policy: keep autofixing WHILE the picker still offers
 * that card — run-final-gate.ts withdraws it from `options` after
 * MAX_FINAL_GATE_AUTOFIX attempts, and passes that as `canAutofix` — then leave the
 * run FAILED.
 *
 * 'leave', not 'accept': an unattended run that cannot fix the whole-repo gate has
 * not produced a working project. The honest terminal state is a failed run a
 * resume can re-enter. Accepting instead would make the failure read as a success
 * in every artifact that survives the run.
 */
export function yoloFinalGateChoice(enabled: boolean, canAutofix: boolean): FinalGateChoice | null {
    if (!enabled) return null
    return canAutofix ? {action: 'autofix'} : {action: 'leave'}
}
