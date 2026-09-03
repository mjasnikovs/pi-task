/**
 * The scripted phase children and research workers a full, uneventful spec run
 * needs — the fixtures a test writes when the phases themselves are not what it
 * is about.
 *
 * Shared because three test files wanted the same ~130 lines and two had already
 * copied them; a fourth copy is how the fixtures drift apart and stop describing
 * the same run.
 */
import type {PhaseDeps, PhaseSeams} from '../../src/task/child-runner.js'
import type {RunWorkerResult} from '../../src/workers/pi-worker-core.js'

// ─── Phase children: routed by NAME through the `runChild` seam ───────────────

/** The names phases.ts / title-label.ts hand to runPhaseChild. */
export type ChildName =
    | 'refine'
    | 'verify-tooling'
    | 'grill-gen'
    | 'grill-auto'
    | 'compose'
    | 'critique-triage'
    | 'critique'
    | 'compress-label'
export type ChildScript = string | ((prompt: string) => string)

/**
 * A `PhaseDeps.runChild` that answers each phase child by NAME. An unscripted
 * child throws the way the Error-triage ladder does when a child says nothing, so
 * a test only scripts the children it is about and the rest fail as before.
 */
export function scriptedChildren(
    scripts: Partial<Record<ChildName, ChildScript>>
): NonNullable<PhaseDeps['runChild']> {
    return (name, _tools, prompt) => {
        const v = scripts[name as ChildName]
        if (v === undefined) return Promise.reject(new Error(`${name} child produced no output`))
        // The real seam hands back the event sink's assistant text, which is
        // trimmed — a substitute must match that contract.
        return Promise.resolve((typeof v === 'function' ? v(prompt) : v).trim())
    }
}

// ─── Research workers: routed by LABEL through the `runWorker` seam ───────────
//
// `runWorker` is a `PhaseDeps` field, so a fake here recognises a worker by its
// LABEL. Matching on a sentence from prompts.ts instead would make prompt copy
// load-bearing test infrastructure, and returning a RunWorkerResult directly is
// what lets a test state what a gate reads rather than emit JSON events for it.

export type WorkerName = 'files' | 'apis' | 'context' | 'tooling'
/** What a scripted worker answers: its text, or the result fields directly. */
export type WorkerScript = string | (() => string | Partial<RunWorkerResult>)

export const WORKER_LABELS: Record<WorkerName, string> = {
    files: 'worker:files',
    apis: 'worker:apis',
    context: 'worker:context',
    tooling: 'worker:tooling'
}

export function workerResult(over: Partial<RunWorkerResult> = {}): RunWorkerResult {
    return {
        text: '',
        exitCode: 0,
        stderr: '',
        aborted: false,
        sawOutput: true,
        waitMs: 1,
        workMs: 1,
        attempts: 1,
        totalWallMs: 2,
        restarts: [],
        salvagedFromDiscardedAttempt: false,
        // research-worker.ts's zero-retrieval gate fires on
        // `groundingRetrievalCount === 0`, so a non-zero default keeps it out of
        // the way unless a test is about it.
        groundingRetrievalCount: 3,
        ...over
    }
}

/** A `PhaseDeps.runWorker` answering each research worker by name. */
export function researchWorkers(
    scripts: Partial<Record<WorkerName, WorkerScript>>,
    fallback = ''
): NonNullable<PhaseDeps['runWorker']> {
    const byLabel = new Map<string, WorkerScript>(
        (Object.keys(WORKER_LABELS) as WorkerName[])
            .filter(k => scripts[k] !== undefined)
            .map(k => [WORKER_LABELS[k], scripts[k]!])
    )
    return label => {
        const v = byLabel.get(label)
        if (v === undefined) return Promise.resolve(workerResult({text: fallback}))
        const out = typeof v === 'function' ? v() : v
        return Promise.resolve(workerResult(typeof out === 'string' ? {text: out} : out))
    }
}

export const REFINED_FIXTURE = `GOAL
Run the linter and report errors.

CONSTRAINTS
- Use bun.

KNOWN-UNKNOWNS
- (none)
`

export const RESEARCH_FILES = 'package.json  build/lint scripts'
export const RESEARCH_APIS = 'lint  bun run lint'
export const RESEARCH_CONTEXT = '- TypeScript project using bun'
export const RESEARCH_TOOLING = 'lint  bun run lint\ntest  bun test'

export const VERIFY_TOOLING_OUT = `VERIFIED
  bun run lint  found in package.json scripts
  bun test  found in package.json scripts

REJECTED
`

/** grill-gen must return non-empty text even when there are no questions; this
 *  string parses to 0 questions (no numbered lines). */
export const NO_QUESTIONS = '(no clarifying questions for this task)'

export const COMPOSE_SPEC = `GOAL
Run lint.

CONSTRAINTS
- none

ACCEPTANCE
- exit 0

VERIFY:
\`\`\`sh
bun run lint
\`\`\`
`

export function happyChildren(over: Partial<Record<ChildName, ChildScript>> = {}) {
    return scriptedChildren({
        refine: REFINED_FIXTURE,
        'verify-tooling': VERIFY_TOOLING_OUT,
        'grill-gen': NO_QUESTIONS,
        compose: COMPOSE_SPEC,
        critique: COMPOSE_SPEC,
        ...over
    })
}

export function happyWorkers(
    over: Partial<Record<WorkerName, WorkerScript>> = {},
    fallback = ''
): NonNullable<PhaseDeps['runWorker']> {
    return researchWorkers(
        {
            files: RESEARCH_FILES,
            apis: RESEARCH_APIS,
            context: RESEARCH_CONTEXT,
            tooling: RESEARCH_TOOLING,
            ...over
        },
        fallback
    )
}

/** Both fakes for a full happy run, as the one seam bag TaskRunner / runSingleTask take. */
export function happy(): PhaseSeams {
    return {runChild: happyChildren(), runWorker: happyWorkers()}
}
