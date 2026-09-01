/**
 * The **Focused extractor** — the one place a no-tools child pi is run to answer ONE question
 * over content already in hand, cite a verbatim `<excerpt>`, and have that citation checked.
 *
 * Its two callers are `fetchFocused` (fetch-core) and `docsLookup` (docs-lookup), and
 * everything they do around the child is the same: the `--no-tools` argv,
 * `getPiInvocation`, `runChild`, `parseChildOutput`, and no retry. What genuinely differs is
 * DATA, and each difference has a name here:
 *
 *   1. the prompt body — {@link FocusedRequest.prompt} is a string the caller assembles;
 *   2. WHAT the excerpt is verified against — see {@link FocusedRequest.verifyAgainst};
 *   3. what the answer MEANS (fetch's coverage-miss sentinel) — left to the caller, because
 *      classifying an answer is the caller's domain, not the child runner's.
 *
 * Two invariants the result type enforces rather than documents:
 *   - **Failure.** A child that aborted or exited non-zero has no `answer` field at all. It
 *     cannot be read as one, which matters because `parseChildOutput` returns the whole
 *     trimmed stdout when there is no `<answer>` tag — a crashed child's error dump.
 *   - **Evidence.** Every caller gets the full {@link ExcerptVerification}, not a bare
 *     boolean, so a false verdict can afterwards be attributed to fabrication rather than a
 *     normaliser gap.
 */
import {spawn as defaultSpawn} from 'node:child_process'
import {getPiInvocation} from '../shared/pi-invocation.js'
import {runChild, type SpawnFn} from '../shared/child-process.js'
import {childBaseArgs} from '../shared/child-extensions.js'
import {parseChildOutput, verifyExcerpt, type ExcerptVerification} from '../shared/child-output.js'
import {formatChildFailure} from './shared.js'

/**
 * The argv every focused extraction child runs with: the shared child base — any whitelisted
 * extensions, then `--print --no-skills --no-extensions --no-prompt-templates
 * --no-context-files --no-session` — then the caller's group fragment (its model and its
 * thinking level), then `--no-tools`.
 *
 * `--no-tools` is the contract, not a default: the child is given all the content it may use
 * inside its prompt, so a tool call could only reach for something unsourced.
 */
export const focusedChildArgs = (groupArgs: readonly string[] = []): string[] => [
    ...childBaseArgs(),
    ...groupArgs,
    '--no-tools'
]

export interface FocusedRequest {
    /** The fully assembled prompt, including the content block. Delivered on stdin. */
    prompt: string
    /**
     * The text the cited excerpt is checked against — a NAMED knob, because the two call
     * sites deliberately disagree, and unnamed the disagreement is invisible.
     *
     * `docsLookup` passes exactly the concatenated chunks that went into the prompt.
     * `fetchFocused` passes the FULL cleaned page while prompting with only the
     * anchored `#fragment` section: the slice is a substring of the page, so a genuine excerpt
     * still verifies, and an excerpt pulled from the model's memory still fails — fragment
     * anchoring therefore cannot change the hallucination detector's discrimination.
     *
     * Passing the prompt's own content is the safe default; passing a SUPERSET (as fetch does)
     * loosens the check deliberately. Passing anything narrower would manufacture false
     * fabrication verdicts.
     */
    verifyAgainst: string
    cwd: string
    signal?: AbortSignal
    /** Defaults to node's spawn; injected by tests and by the worker `internals` hooks. */
    spawn?: SpawnFn
    /** The message reported when the child was aborted, e.g. `'Docs lookup aborted.'`. */
    abortedMessage: string
    /**
     * An already-resolved `['--thinking', level]` fragment, or `[]`/omitted to
     * inherit the session default.
     *
     * Supplied by the CALLER even though both call sites resolve the same
     * `extraction` group. Resolving it inside this module would make
     * `focusedChildArgs` read ambient config, and a function that reads config
     * internally cannot be tested without the developer's own machine state.
     */
    groupArgs?: readonly string[]
}

/** What every outcome carries, success or failure — the raw child evidence. */
interface FocusedChildEvidence {
    exitCode: number
    aborted: boolean
    stderr: string
    /** The child's raw stdout, retained so a failure is diagnosable from the result alone —
     *  it is the only place a crashed child's output survives. */
    stdout: string
}

/** The child aborted or exited non-zero. There is deliberately no `answer` here. */
export interface FocusedFailure extends FocusedChildEvidence {
    ok: false
    /** `formatChildFailure`'s message — the abort message, or `Worker exited N` + stderr tail. */
    failure: string
}

/** The child exited 0; its output has been parsed and its citation checked. */
export interface FocusedAnswer extends FocusedChildEvidence {
    ok: true
    aborted: false
    /** The `<answer>` body, or the whole trimmed stdout when the child emitted no tags. */
    answer: string
    /** The `<excerpt>` body; absent when the child cited nothing (or cited only whitespace). */
    excerpt?: string
    /** The full verification record — absent exactly when `excerpt` is. */
    excerptCheck?: ExcerptVerification
    /** `excerptCheck?.verified`, for the many callers that only report the verdict. */
    excerptVerified?: boolean
}

export type FocusedResult = FocusedFailure | FocusedAnswer

/**
 * Run one focused extraction: spawn the no-tools child on `prompt`, and on success parse its
 * `<answer>`/`<excerpt>` and verify the excerpt against `verifyAgainst`.
 *
 * Never retries — a re-ask of a deterministic extraction over unchanged content is a second
 * bill for the same answer. Exactly one child is spawned per call, on every path including
 * the empty-output failure below.
 */
export async function runFocusedExtraction(req: FocusedRequest): Promise<FocusedResult> {
    const spawn = req.spawn ?? (defaultSpawn as unknown as SpawnFn)
    const invocation = getPiInvocation(focusedChildArgs(req.groupArgs), req.prompt)
    const child = await runChild(spawn, invocation, req.cwd, req.signal)

    const evidence: FocusedChildEvidence = {
        exitCode: child.exitCode,
        aborted: child.aborted,
        stderr: child.stderr,
        stdout: child.stdout
    }

    const failure = formatChildFailure(child, req.abortedMessage)
    if (failure !== null) return {ok: false, failure, ...evidence}

    // A dropped provider exits 0 with empty text, and TEXT mode never populates
    // `modelError`. Returned as an empty answer it is MEMOISED: both caches keep
    // it and re-serve a dead socket as a real answer for the rest of the run.
    if (child.stdout.trim().length === 0) {
        return {
            ok: false,
            failure: 'Worker exited 0 without writing anything — no answer to parse',
            ...evidence
        }
    }

    const parsed = parseChildOutput(child.stdout)
    const excerptCheck =
        parsed.excerpt ? verifyExcerpt(parsed.excerpt, req.verifyAgainst) : undefined

    return {
        ok: true,
        ...evidence,
        aborted: false,
        answer: parsed.answer,
        excerpt: parsed.excerpt,
        excerptCheck,
        excerptVerified: excerptCheck?.verified
    }
}
