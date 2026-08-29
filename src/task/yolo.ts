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
 * "index 0" inside it would be one tiny patch, and it would be wrong. The
 * verify-FAIL picker is reached ONLY AFTER MAX_AUTO_AUTOFIX unattended autofix
 * attempts have already failed, yet it STILL tints AUTOFIX as recommended: a
 * central hook would pick AUTOFIX forever and defeat the exact cap that exists to
 * break a non-converging loop. So every site decides for itself, BEFORE ask() is
 * called — which also means the prompt notification (the lone pushNotify in
 * ask()) is suppressed structurally, with zero suppression code.
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
 * Visible provenance marker on EVERY artifact an auto-pick writes (gate trails,
 * task-file Q&A, the debt ledger's reason text). A later audit reading only the
 * artifacts must never mistake an auto-pick for a human decision — that is the
 * same confusion the accept-debt origins were introduced to prevent.
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
 * The clarify/grill policy: take the RECOMMENDED option — which is positional,
 * index 0 of the card list (question-box.ts tints it green), i.e. `suggested`,
 * falling back to the B-side `alt` when a fork offers only that.
 *
 * `unsafe` is the step-aside channel: a caller that KNOWS the recommendation must
 * not be auto-accepted passes why, and the question is skipped instead. Its one
 * producer today is the anti-synthesis demotion — an answer proven to name a
 * hallucinated API identifier. Auto-accepting that would re-promote exactly the
 * invention the demotion was built to stop (it reached requirements AND the VERIFY
 * block), so a machine may never take it; a human still can.
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
 * The same policy expressed over an {@link AutoAnswer}, for the grill site. Only
 * the ANTI-SYNTHESIS unknown is unsafe: the other two producers (an integration
 * unknown research could not ground, a child that threw) carry an ordinary
 * best-effort recommendation, which is precisely what a human would be shown as
 * the green card. The variants are told apart by the union's `reason` tag — never
 * by pattern-matching the answer text.
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
 * Not a preference — a bound. Every branch that REACHES this picker has already
 * spent its unattended budget: the loop auto-runs AUTOFIX while the research
 * recommends it, up to MAX_AUTO_AUTOFIX consecutive failures, and only then hands
 * over. Answering AUTOFIX here would restart that budget from a site whose whole
 * purpose is that the budget ran out. So YOLO takes the terminal option and
 * records the defect ('yolo-accepted' — an origin a human never produces).
 */
export function yoloVerifyResolution(enabled: boolean): ResolutionChoice | null {
    return enabled ? {action: 'accept'} : null
}

/**
 * The final-integration-gate policy: keep autofixing WHILE the picker still
 * offers that card (the loop withdraws it after MAX_FINAL_GATE_AUTOFIX attempts),
 * then leave the run FAILED.
 *
 * 'leave', not 'accept': an unattended run that cannot fix the whole-repo gate has
 * not produced a working project, and the honest terminal state is a failed run a
 * resume can re-enter — a ended "FAIL accepted by user" on an app that
 * 404'd at `/`, and that acceptance is what made the failure look like a success.
 */
export function yoloFinalGateChoice(enabled: boolean, canAutofix: boolean): FinalGateChoice | null {
    if (!enabled) return null
    return canAutofix ? {action: 'autofix'} : {action: 'leave'}
}
