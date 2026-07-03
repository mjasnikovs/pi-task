/**
 * Verify-FAIL resolution research for /task-auto.
 *
 * When the work-verification gate (verify-work.ts) returns a FAIL, the run no
 * longer dead-stops with "fix and run /task-auto-resume". Instead the user is
 * shown a boxed two-choice picker:
 *
 *   • Autofix   — re-run the task's implementation turn against the failure, then
 *                 re-enter the verify gate.
 *   • Accept    — treat the artifact as good, override the gate, and proceed
 *                 (check off + commit) exactly as a PASS would.
 *
 * The recommendation now also GATES whether the user is prompted at all: an
 * AUTOFIX recommendation is auto-applied unattended (bounded — see
 * task-gates.ts MAX_AUTO_AUTOFIX), and the picker is shown only when the
 * recommendation is ACCEPT (blessing the artifact is a human's call) or when the
 * unattended-autofix cap is reached. This module only computes which of the two
 * cards is tinted RECOMMENDED, by handing the FAIL reason + the task spec to
 * a fresh read+bash child of the SAME local model and letting it INVESTIGATE the
 * real workspace: is the FAIL a genuine defect in the work (→ recommend AUTOFIX),
 * or a false alarm / an acceptable artifact the gate misjudged (→ recommend
 * ACCEPT)? This is the same shape of judgement a human reviewer makes when a CI
 * check is red — sometimes the code is broken, sometimes the check is wrong.
 *
 * Tools: `read` + `bash` only — identical to the verify pass. The recommendation
 * observes; it never edits. (Autofix, when chosen, is what edits — and it goes
 * through the full implementation runner, not this pass.) A read-only research
 * step can never itself change the tree it is judging.
 *
 * The verdict defaults to AUTOFIX when missing/garbled — the conservative choice
 * (re-do the work rather than bless it), which is also the auto-applied path.
 */
import {USER_CANCELLED} from './child-runner.js'

/** Same read-only contract as the verify pass: observe, never edit. */
const RESOLUTION_TOOLS = 'read,bash'

/** Which card the picker tints RECOMMENDED. */
export type ResolutionRecommendation = 'autofix' | 'accept'

export interface ResolutionOutcome {
    /** The card to recommend. Defaults to 'autofix' (conservative: re-do, don't
     *  bless) when the research could not run or emitted no verdict. */
    recommend: ResolutionRecommendation
    /** Short, human-readable rationale shown under the picker. Always set. */
    rationale: string
}

/**
 * Build the resolution research child's prompt. Pure, so the wording is
 * unit-tested without spawning pi. The contract: investigate the real workspace
 * and end on exactly one RESOLUTION verdict line.
 */
export function buildResolutionPrompt(spec: string, failReason: string): string {
    return [
        "A strict verification gate just FAILED an AI coding agent's task and the",
        'run paused. You are the reviewer who decides what to recommend next. The',
        'agent will NOT act on your verdict automatically — a human picks the final',
        'action — but your recommendation sets the default, so be right.',
        '',
        'You have a `read` tool and a `bash` tool — nothing else. Investigate the',
        'REAL files in this workspace; you CANNOT edit or create anything.',
        '',
        'THE TASK SPEC (its ACCEPTANCE criteria and VERIFY block were the contract):',
        spec.trim(),
        '',
        "THE GATE'S FAILURE REASON:",
        failReason.trim(),
        '',
        'Your job: decide which of these two is the right next step.',
        '  AUTOFIX — the work is genuinely wrong: a real defect, a missing or broken',
        '            artifact, behaviour that truly contradicts an ACCEPTANCE criterion.',
        '            The task should be re-done to fix it.',
        '  ACCEPT  — the work is actually fine: the gate misjudged it (a false alarm,',
        '            an over-strict or factually-wrong check, an environment gap, a',
        '            difference in FORM that still satisfies the intent). The artifact',
        '            is good as-is and the FAIL should be overridden.',
        '',
        'CRITICAL — judge by FUNCTION, not by literal text. Verification gates (and',
        'even the spec wording above) are frequently OVER-LITERAL. A FAIL that',
        'complains that something is written in the wrong FORM, SHAPE, SYNTAX, SECTION',
        'or WORDING — rather than that it BEHAVES wrong — is very often a false alarm:',
        'the artifact reaches the same result through an equivalent form. The spec',
        'wording is intent, not a string to diff against. Example: a config value',
        'written as a nested table header vs. a dotted key are the same value to the',
        'tool that reads it; demanding one exact spelling is a false alarm if the tool',
        'accepts both and the intended setting is present.',
        '',
        'How to decide:',
        '1. Do NOT decide from the FAIL text alone. Read the actual file(s) it points',
        '   at. When the check is runnable, RUN the real tool/command that consumes',
        '   that artifact (the build, the parser, the test) with `bash` and observe',
        '   whether it actually works. Reality overrules both the gate and the spec',
        '   wording.',
        '2. If the failure is about HOW something is written and you confirm the',
        '   artifact still FUNCTIONALLY does what the ACCEPTANCE intends (the tool',
        '   accepts it, the value/element is present and effective, the build runs) —',
        "   that is ACCEPT, even though the text does not literally match the gate's or",
        "   the spec's phrasing.",
        '3. If an intended element is genuinely ABSENT or the artifact actually fails',
        '   when you run it — that is AUTOFIX. When you cannot positively confirm the',
        '   artifact works, recommend AUTOFIX: re-doing the work is the safe default;',
        '   blessing broken work is the failure mode this whole gate exists to stop.',
        '',
        'When done, output EXACTLY ONE of these as the final line:',
        '  VERIFY-RESOLUTION: AUTOFIX <one sentence why the work must be re-done>',
        '  VERIFY-RESOLUTION: ACCEPT <one sentence why the artifact is good as-is>',
        'Output the verdict line verbatim — it is parsed mechanically.'
    ].join('\n')
}

/**
 * Parse the child's recommendation. Scans for the LAST
 * `VERIFY-RESOLUTION: AUTOFIX|ACCEPT` marker (the model reasons before
 * concluding, and bash output may echo these words, so a distinct token and
 * last-match-wins both matter).
 *
 * No marker → recommend AUTOFIX (conservative: re-do rather than bless), with a
 * rationale that says the research was inconclusive.
 */
export function parseResolutionVerdict(text: string): ResolutionOutcome {
    const re = /VERIFY-RESOLUTION:\s*(AUTOFIX|ACCEPT)\b[ \t]*(.*)/gi
    let last: RegExpExecArray | null = null
    for (let m = re.exec(text); m !== null; m = re.exec(text)) last = m
    if (!last) {
        return {
            recommend: 'autofix',
            rationale: 'research inconclusive — defaulting to re-doing the work'
        }
    }
    const recommend: ResolutionRecommendation =
        last[1].toUpperCase() === 'ACCEPT' ? 'accept' : 'autofix'
    const rationale =
        last[2].trim()
        || (recommend === 'accept' ? 'artifact judged acceptable' : 'work judged to need fixing')
    return {recommend, rationale}
}

// ─── Picker plumbing ─────────────────────────────────────────────────────────
//
// The user ALWAYS makes the final call on a verify FAIL. These pure helpers shape
// the boxed two-choice picker (verify-resolution → SessionUI.ask in the loop) and
// classify whatever comes back — a card value, a remote button label, or free
// text typed via the "type a different answer" fallback — so the orchestration
// stays mechanical and unit-tested.

export const ACCEPT_VALUE = 'accept'
export const AUTOFIX_VALUE = 'autofix'
export const ACCEPT_LABEL = 'Accept — keep the artifact as-is and continue'
export const AUTOFIX_LABEL = 'Autofix — re-run the task to fix it, then verify again'

export interface ResolutionChoice {
    /** What the user decided. 'cancel' = dismissed the picker (pause, resumable). */
    action: 'accept' | 'autofix' | 'cancel'
    /** Free-text guidance the user typed instead of picking a card. Folded into
     *  the autofix instruction so a re-run can act on it. Only set with 'autofix'. */
    guidance?: string
}

/**
 * The two cards for the picker, with the model-recommended one FIRST so the boxed
 * renderer tints it green (it marks index 0 as recommended). Values are the bare
 * tokens; remote buttons use the labels — {@link classifyResolutionAnswer}
 * accepts both.
 */
export function resolutionOptions(
    recommend: ResolutionRecommendation
): {label: string; value: string; recommended: boolean}[] {
    const accept = {label: ACCEPT_LABEL, value: ACCEPT_VALUE}
    const autofix = {label: AUTOFIX_LABEL, value: AUTOFIX_VALUE}
    return recommend === 'accept' ?
            [
                {...accept, recommended: true},
                {...autofix, recommended: false}
            ]
        :   [
                {...autofix, recommended: true},
                {...accept, recommended: false}
            ]
}

/**
 * Map a picker answer to an action. Handles the card value tokens, the remote
 * button labels, an empty/undefined dismissal (cancel), and arbitrary free text
 * typed via the fallback — which becomes an AUTOFIX with that text as guidance
 * (the user is steering the re-run rather than blessing the artifact).
 */
export function classifyResolutionAnswer(answer: string | undefined): ResolutionChoice {
    if (answer === undefined) return {action: 'cancel'}
    const t = answer.trim()
    if (t.length === 0) return {action: 'cancel'}
    if (t === ACCEPT_VALUE || /^accept\b/i.test(t)) return {action: 'accept'}
    if (t === AUTOFIX_VALUE || /^autofix\b/i.test(t)) return {action: 'autofix'}
    // Free-text override → re-run the task with the typed text as fix guidance.
    return {action: 'autofix', guidance: t}
}

export interface ResolutionDeps {
    cwd: string
    signal?: AbortSignal
    /** The composed spec the task was verified against. */
    spec: string
    /** The verify gate's FAIL reason (VerifyOutcome.reason). */
    failReason: string
    /** Runs the research child and returns its assistant text. Injected so the
     *  orchestrator wires the real worker and tests use a fake. */
    runChild: (tools: string, prompt: string, signal?: AbortSignal) => Promise<string>
}

/**
 * Research a verify FAIL and return which action to recommend. Never throws
 * (except a user cancel, which propagates so the loop's USER_CANCELLED handler
 * reports a clean "cancelled — resume"). A child crash defaults to recommending
 * AUTOFIX — the picker is still shown, only the default tint changes.
 */
export async function researchResolution(deps: ResolutionDeps): Promise<ResolutionOutcome> {
    let text: string
    try {
        text = await deps.runChild(
            RESOLUTION_TOOLS,
            buildResolutionPrompt(deps.spec, deps.failReason),
            deps.signal
        )
    } catch (err) {
        if (err instanceof Error && err.message === USER_CANCELLED) throw err
        return {
            recommend: 'autofix',
            rationale: 'resolution research could not run — defaulting to re-doing the work'
        }
    }
    return parseResolutionVerdict(text)
}

export {RESOLUTION_TOOLS}
