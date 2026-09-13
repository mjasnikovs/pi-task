/**
 * pi-worker — minimal subagent tool.
 *
 * Spawns one child pi per call and returns its assistant text. `childBaseArgs`
 * gives the child `--print --no-skills --no-extensions --no-prompt-templates
 * --no-context-files --no-session`, and runWorker adds `--mode json` plus its
 * default `--tools read,grep,find,ls`.
 *
 * That tool string is what makes the child read-only and non-recursive: no bash,
 * write or edit, and no `pi-worker` of its own to dispatch. `--no-extensions`
 * disables DISCOVERY, so the user's whitelisted `-e` extensions are still loaded
 * — the tool whitelist, not the extension flag, is the bound that holds.
 */

import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import {Text} from '@earendil-works/pi-tui'
import {Type} from '@sinclair/typebox'
import {getConfig} from '../config/config.js'
import {groupChildArgs} from '../config/group-args.js'
import type {SpawnFn} from '../shared/child-process.js'
import {runWorker, type RunWorkerResult} from './pi-worker-core.js'
import {contextWindowForGroup} from '../task/context-usage.js'
import {
    childFailureReason,
    formatChildFailure,
    makeWorkerTool,
    workerAnswer,
    workerUnavailable
} from './shared.js'

const RENDER_PROMPT_MAX = 120

/**
 * What the caller can read back after the fact. `exitCode` alone described only
 * the FINAL attempt, so a child that burned two spawns on a dead provider and a
 * child that ran once and said nothing were the same record (issue #19).
 */
interface WorkerDetails {
    exitCode: number
    attempts: number
    restarts: string[]
    modelError?: string
    stderr?: string
}

const STDERR_TAIL = 500

function workerDetails(r: RunWorkerResult): WorkerDetails {
    return {
        exitCode: r.exitCode,
        attempts: r.attempts,
        restarts: r.restarts.map(x => x.reason),
        ...(r.modelError !== undefined ? {modelError: r.modelError} : {}),
        ...(r.stderr ? {stderr: r.stderr.slice(-STDERR_TAIL)} : {})
    }
}

/** An empty final answer, with the spawns it cost, so the model can tell a
 *  retried failure from a child that simply had nothing to say. */
function describeEmptyAnswer(r: RunWorkerResult): string {
    if (r.restarts.length === 0) return '(no output)'
    const reasons = r.restarts.map(x => x.reason).join(', ')
    return `(no output after ${r.attempts} attempts; discarded: ${reasons})`
}

const WorkerParams = Type.Object({
    prompt: Type.String({description: 'Task for the worker to perform.'})
})

/** Test seams: a fake child, and no real backoff sleep between its attempts. */
export interface PiWorkerInternals {
    spawn?: SpawnFn
    sleepFor?: (ms: number) => Promise<void>
}

export function registerPiWorker(pi: ExtensionAPI, internals: PiWorkerInternals = {}): void {
    makeWorkerTool<typeof WorkerParams, WorkerDetails>(pi, {
        name: 'pi-worker',
        label: 'Pi Worker',
        description:
            'Dispatch an isolated child Pi to investigate and return its CONCLUSION — '
            + 'not the raw evidence. USE THIS FIRST, instead of running your own '
            + 'ls/grep/find/read, whenever a question spans MULTIPLE files or means '
            + 'searching/scanning code you have not already located. Doing it yourself '
            + 'floods your context with raw file output; the worker reads in isolation '
            + 'and returns only the answer. You can dispatch several in one turn for '
            + 'independent questions.\n'
            + '\n'
            + 'Good fits:\n'
            + '- "Where/how is X handled in this repo?" across unfamiliar code\n'
            + '- Audits and pattern scans across many files ("every place we log PII")\n'
            + '- Tracing a flow across layers (router → service → database)\n'
            + '- Summarising long test output, logs, or shell output you do not need verbatim\n'
            + '\n'
            + 'Skip when:\n'
            + '- You already know the exact file — call `read` directly\n'
            + '- The task needs writes/edits (worker is read-only)\n'
            + '- The task needs the web — use `pi-worker-search` / `pi-worker-fetch`',
        parameters: WorkerParams,

        async run(params, signal, ctx) {
            // `adhoc` guards, `research` thinking — deliberately not the same word.
            // Guards answer "how may this child die"; the reasoning group answers
            // "how hard may it think", and this is the same read-only exploration
            // loop the research workers run, just dispatched by a model rather than
            // by the pipeline. See the header of worker-profiles.ts.
            const result = await runWorker({
                prompt: params.prompt,
                cwd: ctx.cwd,
                signal,
                profile: 'adhoc',
                // The `adhoc` profile carries NO wall clock (`timeoutMs: 0`); what
                // bounds this worker is the user's own `stuck reply retry` setting,
                // which kills on SILENCE and never on slowness. It is an INPUT and
                // not policy for the same reason the gate's two ceilings are: the
                // number is the user's, the decision to arm it is the profile's.
                policyInputs: {streamInactivityMs: getConfig().streamInactivityMs},
                // The session's own window, handed down. No child argv anywhere in
                // this codebase passes `-m`, so the parent's model IS the child's
                // model and its window is the honest one. Without this the churn
                // rule cannot fire — see RunWorkerInput.contextWindow.
                contextWindow: contextWindowForGroup(ctx, 'research') || 'unknown',
                groupArgs: groupChildArgs('research'),
                ...(internals.spawn ? {spawn: internals.spawn} : {}),
                ...(internals.sleepFor ? {sleepFor: internals.sleepFor} : {})
            })
            const details = workerDetails(result)

            const failure = formatChildFailure(result, 'Worker aborted.')
            if (failure !== null) {
                return workerUnavailable(failure, details, childFailureReason(result))
            }

            // Not a kill, so the ladder leaves it to us: pi reports a failed turn
            // as exit 0, empty text, and the cause in `modelError`.
            if (result.modelError && result.text.trim().length === 0) {
                return workerUnavailable(
                    `Worker failed: model error — ${result.modelError.slice(0, 200)}`,
                    details,
                    'model-error'
                )
            }

            const text = result.text.trim()
            if (text.length === 0) {
                return workerUnavailable(describeEmptyAnswer(result), details, 'no-answer')
            }
            return workerAnswer(result.text, details)
        },

        renderCall(args, theme) {
            const prompt = args.prompt.replace(/\s+/g, ' ').trim()
            const truncated =
                prompt.length > RENDER_PROMPT_MAX ?
                    `${prompt.slice(0, RENDER_PROMPT_MAX - 1)}…`
                :   prompt
            const head = theme.fg('toolTitle', theme.bold('pi-worker '))
            const body = theme.fg('accent', truncated)
            return new Text(head + body, 0, 0)
        }
    })
}
