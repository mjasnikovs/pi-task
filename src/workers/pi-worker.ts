/**
 * pi-worker — minimal subagent tool.
 *
 * Spawns a sandboxed child `pi --print` for each call, returns its stdout.
 * Child has read+grep+find+ls only (no bash, write, or edit) — no skills,
 * extensions, prompt templates, context files, or session storage. Cannot
 * recurse into another worker.
 */

import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import {Text} from '@earendil-works/pi-tui'
import {Type} from '@sinclair/typebox'
import {getConfig} from '../config/config.js'
import {groupThinkingArgs} from '../config/reasoning-args.js'
import {runWorker} from './pi-worker-core.js'
import {
    childFailureReason,
    formatChildFailure,
    makeWorkerTool,
    workerAnswer,
    workerUnavailable
} from './shared.js'

const RENDER_PROMPT_MAX = 120

interface WorkerDetails {
    exitCode: number
}

const WorkerParams = Type.Object({
    prompt: Type.String({description: 'Task for the worker to perform.'})
})

export function registerPiWorker(pi: ExtensionAPI): void {
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
            // Grouped with `research`: this is the same read-only exploration
            // loop the four research workers run, just dispatched by a model
            // rather than by the pipeline. Left ungrouped it would be the one
            // child that never honoured a profile.
            const result = await runWorker({
                prompt: params.prompt,
                cwd: ctx.cwd,
                signal,
                profile: 'adhoc',
                // The user's own `stuck reply retry` is what bounds this worker
                // now — it kills on SILENCE, never on slowness. It is an INPUT and
                // not policy for the same reason the gate's two ceilings are: the
                // number is the user's, the decision to arm it is the profile's.
                policyInputs: {streamInactivityMs: getConfig().streamInactivityMs},
                thinking: groupThinkingArgs('research')
            })
            const details: WorkerDetails = {exitCode: result.exitCode}

            const failure = formatChildFailure(result, 'Worker aborted.')
            if (failure !== null) {
                return workerUnavailable(failure, details, childFailureReason(result))
            }

            return workerAnswer(result.text || '(no output)', details)
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
